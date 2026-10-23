//! BaseMaster CLI. Two halves:
//!
//! - Scripting commands (`query`, `tables`, `export`, `transfer`, ...) talk to
//!   the MCP server of the running GUI, so they reuse its open connections,
//!   tunnels and guardrails. See `remote.rs` and `basemaster-cli guide`.
//! - Backup / restore / schedule run standalone on `basemaster-backup` + the
//!   driver crates (no Tauri), e.g. on a bare server. Connection source is a
//!   stored profile (`--conn NAME`, local SQLite + OS keyring) or a DSN.
//!   SSH tunnels aren't supported standalone; use a DSN to a reachable host.

mod remote;

use std::io::{Cursor, Write};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use basemaster_backup::container::BmbakReader;
use basemaster_backup::dump::{dump_tables_to_bmbak, DumpToBmbakOptions, Progress};
use basemaster_backup::checksum::verify_tables;
use basemaster_backup::restore::{describe_mismatch, restore_from_bmbak, RestoreOptions};
use basemaster_backup::sql_export::{export_to_sql, Dialect, SqlExportOptions};
use basemaster_core::connection::{ConnectionConfig, TlsMode};
use basemaster_core::schema::TableKind;
use basemaster_core::Driver;
use basemaster_store::{AppPaths, Store};
use clap::{Parser, Subcommand, ValueEnum};

use basemaster_driver_mysql::MysqlDriver;
use basemaster_driver_postgres::PostgresDriver;
use basemaster_driver_sqlite::SqliteDriver;

use basemaster_backup::os_schedule::{self, Cadence, TaskSpec};
use basemaster_backup::schedule::run_and_record;

#[derive(Parser)]
#[command(
    name = "basemaster-cli",
    version,
    about = "BaseMaster from the shell: query, explore and transfer through the running app, plus standalone backups.",
    after_help = "Run `basemaster-cli guide` for script/agent-oriented examples."
)]
struct Cli {
    #[command(flatten)]
    global: remote::Global,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(flatten)]
    Remote(remote::Remote),
    /// Dump a database to a .bmbak (or .sql) file (standalone, no app needed).
    Backup(BackupArgs),
    /// Restore a .bmbak into a database (standalone).
    Restore(RestoreArgs),
    /// Compare a database with a .bmbak: row count and content checksum per
    /// table, recomputed by the server (standalone, read-only).
    Verify(VerifyArgs),
    /// Scheduled backups (standalone).
    Schedule {
        #[command(subcommand)]
        action: ScheduleAction,
    },
}

#[derive(Subcommand)]
enum ScheduleAction {
    /// Print all configured backup routines.
    List,
    /// Create a routine + register it with the OS scheduler.
    Add(ScheduleAddArgs),
    /// Execute a routine now (what the OS scheduler invokes): backup +
    /// retention + record the run.
    Run { id: String },
    /// Delete a routine and unregister its OS task.
    Rm { id: String },
}

/// Runs against the global -c/--conn stored connection.
#[derive(clap::Args)]
struct ScheduleAddArgs {
    /// Human label for the routine.
    #[arg(long)]
    name: String,
    /// Schema / database to back up.
    #[arg(long)]
    schema: String,
    /// Directory where each run drops a timestamped file.
    #[arg(long)]
    out_dir: String,
    #[arg(long, value_enum, default_value_t = OutFormat::Bmbak)]
    format: OutFormat,
    /// Run every N minutes (mutually exclusive with --daily-at).
    #[arg(long, conflicts_with = "daily_at")]
    every_minutes: Option<u32>,
    /// Run daily at HH:MM (24h).
    #[arg(long, conflicts_with = "every_minutes")]
    daily_at: Option<String>,
    /// Keep only the newest N backups in out_dir.
    #[arg(long)]
    keep_n: Option<u32>,
    /// Delete backups older than this many days.
    #[arg(long)]
    max_age_days: Option<u32>,
    #[arg(long, default_value_t = 5)]
    level: i32,
    /// Auto-accept an unknown SSH host key on scheduled runs (TOFU). Only the
    /// GUI binary opens SSH tunnels; the standalone CLI still can't.
    #[arg(long)]
    accept_ssh_hosts: bool,
    /// Print the OS commands instead of executing them.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Copy, Clone, Debug, ValueEnum, PartialEq, Eq)]
enum OutFormat {
    Bmbak,
    Sql,
}

#[derive(clap::Args)]
struct ConnArgs {
    /// Connection string, e.g. mysql://user:pass@host:3306/db or
    /// postgres://... or sqlite:///abs/path.db. Without it the global
    /// -c/--conn stored profile is used (local SQLite + keyring).
    #[arg(long)]
    dsn: Option<String>,
}

#[derive(clap::Args)]
struct BackupArgs {
    #[command(flatten)]
    conn: ConnArgs,
    /// Schema / database to dump. Defaults to the connection's default database.
    #[arg(long)]
    schema: Option<String>,
    /// Comma-separated table list. Omit to dump every table in the schema.
    #[arg(long, value_delimiter = ',')]
    tables: Vec<String>,
    /// Output file. Long form only: `-o` is the global output format.
    #[arg(long)]
    out: String,
    #[arg(long, value_enum, default_value_t = OutFormat::Bmbak)]
    format: OutFormat,
    /// Target SQL dialect when --format sql (defaults to the source dialect).
    #[arg(long)]
    sql_dialect: Option<String>,
    /// Skip the per-table checksum (saves one extra read of every table, but
    /// restore/verify can then only compare row counts).
    #[arg(long)]
    no_checksum: bool,
    /// MySQL: read-lock MyISAM and other non-transactional tables from the
    /// snapshot start until they are read, so they match the rest. Writes to
    /// them wait meanwhile; without it a warning lists them.
    #[arg(long)]
    lock_non_transactional: bool,
    /// zstd level for .bmbak blocks.
    #[arg(long, default_value_t = 5)]
    level: i32,
    /// Rows fetched per page / block.
    #[arg(long, default_value_t = 1000)]
    chunk: u64,
}

#[derive(clap::Args)]
struct RestoreArgs {
    #[command(flatten)]
    conn: ConnArgs,
    /// Input .bmbak file.
    #[arg(long, short)]
    in_file: String,
    /// Schema / database to restore into. Defaults to the DSN / connection
    /// database on MySQL, otherwise to the schema recorded in the backup.
    #[arg(long, short)]
    schema: Option<String>,
    /// Don't run the CREATE TABLE DDL; insert into existing tables.
    #[arg(long)]
    no_create: bool,
    /// Don't DROP TABLE before create.
    #[arg(long)]
    no_drop: bool,
    /// MySQL: drop DEFINER= from views, routines and triggers so they belong
    /// to the restoring user (needed when it lacks SET_USER_ID / SUPER).
    #[arg(long)]
    strip_definer: bool,
    /// Skip the row count / checksum comparison at the end.
    #[arg(long)]
    no_verify: bool,
}

#[derive(clap::Args)]
struct VerifyArgs {
    #[command(flatten)]
    conn: ConnArgs,
    /// The .bmbak the database should match.
    #[arg(long, short)]
    in_file: String,
    /// Schema / database to check. Same default as restore.
    #[arg(long, short)]
    schema: Option<String>,
}

/// Prints one line per table to stderr.
/// Progress on stderr. On a terminal the current table's line updates in
/// place; otherwise (cron, log files) a line every 10 s, so a big table
/// doesn't look stuck and the log stays short.
struct StderrProgress {
    tty: bool,
    /// Last update time and the width of the in-place line to blank out.
    state: std::sync::Mutex<(std::time::Instant, usize)>,
}

impl StderrProgress {
    fn new() -> Self {
        use std::io::IsTerminal;
        StderrProgress {
            tty: std::io::stderr().is_terminal(),
            state: std::sync::Mutex::new((std::time::Instant::now(), 0)),
        }
    }

    fn start(&self, table: &str, total: u64) {
        let mut st = self.state.lock().unwrap();
        st.0 = std::time::Instant::now();
        if self.tty {
            let line = format!("  {table}: 0/{total} rows");
            eprint!("{line}");
            st.1 = line.len();
        } else {
            eprintln!("  {table}: {total} rows…");
        }
    }

    fn rows(&self, table: &str, done: u64, total: u64) {
        let mut st = self.state.lock().unwrap();
        let every = std::time::Duration::from_millis(if self.tty { 250 } else { 10_000 });
        if st.0.elapsed() < every {
            return;
        }
        st.0 = std::time::Instant::now();
        let pct = if total > 0 { format!(" ({}%)", done.min(total) * 100 / total) } else { String::new() };
        let line = format!("  {table}: {done}/{total} rows{pct}");
        if self.tty {
            eprint!("\r{line:<width$}", width = st.1);
            st.1 = line.len();
        } else {
            eprintln!("{line}");
        }
    }

    /// Ends the in-place line, then prints `line` on its own.
    fn line(&self, line: &str) {
        let mut st = self.state.lock().unwrap();
        if self.tty && st.1 > 0 {
            eprint!("\r{:width$}\r", "", width = st.1);
            st.1 = 0;
        }
        eprintln!("{line}");
    }
}

impl Progress for StderrProgress {
    fn table_started(&self, table: &str, total: u64) {
        self.start(table, total);
    }
    fn rows_written(&self, table: &str, done: u64, total: u64) {
        self.rows(table, done, total);
    }
    fn table_done(&self, table: &str, rows: u64) {
        self.line(&format!("  {table}: done ({rows} rows)"));
    }
    fn objects_done(&self, count: usize) {
        self.line(&format!("  {count} view(s) / routine(s) / trigger(s)"));
    }
    fn warning(&self, message: &str) {
        self.line(&format!("  warning: {message}"));
    }
}

impl basemaster_backup::restore::Progress for StderrProgress {
    fn table_started(&self, table: &str, total: u64) {
        self.start(table, total);
    }
    fn rows_restored(&self, table: &str, done: u64, total: u64) {
        self.rows(table, done, total);
    }
    fn table_done(&self, table: &str, rows: u64) {
        self.line(&format!("  {table}: restored {rows} rows"));
    }
}

fn make_driver(kind: &str) -> Option<Arc<dyn Driver>> {
    match kind {
        "mysql" | "mariadb" => Some(Arc::new(MysqlDriver::new())),
        "postgres" | "postgresql" => Some(Arc::new(PostgresDriver::new())),
        "sqlite" => Some(Arc::new(SqliteDriver::new())),
        _ => None,
    }
}

/// Resolve a `(driver, config)` from either a stored profile or a DSN.
async fn resolve_connection(
    args: &ConnArgs,
    conn: Option<&str>,
) -> Result<(Arc<dyn Driver>, ConnectionConfig)> {
    if let Some(dsn) = &args.dsn {
        return config_from_dsn(dsn);
    }
    let name = conn.ok_or_else(|| anyhow!("provide -c/--conn NAME or --dsn URL"))?;

    let paths = AppPaths::resolve().context("resolve app paths")?;
    let store = Store::open(&paths.db_path())
        .await
        .context("open local store")?;
    let profiles = store.connections().list().await?;
    let profile = profiles
        .into_iter()
        .find(|p| p.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| anyhow!("no stored connection named '{name}'"))?;

    if profile.ssh_tunnel.is_some() {
        bail!("connection '{name}' uses an SSH tunnel, unsupported in the CLI; use --dsn to the reachable host");
    }
    let driver = make_driver(&profile.driver)
        .ok_or_else(|| anyhow!("unknown driver '{}'", profile.driver))?;
    let password = basemaster_store::secrets::get_password(profile.id).ok().flatten();
    let config = profile.into_config(password);
    Ok((driver, config))
}

fn config_from_dsn(dsn: &str) -> Result<(Arc<dyn Driver>, ConnectionConfig)> {
    // sqlite:///path or sqlite:path — url crate treats the rest as path.
    let scheme = dsn.split(':').next().unwrap_or("");
    let kind = match scheme {
        "mysql" | "mariadb" => "mysql",
        "postgres" | "postgresql" => "postgres",
        "sqlite" => "sqlite",
        other => bail!("unsupported DSN scheme '{other}'"),
    };
    let driver = make_driver(kind).ok_or_else(|| anyhow!("unknown driver '{kind}'"))?;

    if kind == "sqlite" {
        let path = dsn
            .trim_start_matches("sqlite://")
            .trim_start_matches("sqlite:");
        let cfg = ConnectionConfig {
            id: uuid_nil(),
            name: "cli-sqlite".into(),
            color: None,
            host: path.to_string(),
            port: 0,
            user: String::new(),
            password: None,
            default_database: Some(path.to_string()),
            tls: TlsMode::Preferred,
            ssh_tunnel: None,
            ssh_jump_hosts: vec![],
            http_proxy: None,
            ssm_tunnel: None,
        };
        return Ok((driver, cfg));
    }

    let url = url::Url::parse(dsn).with_context(|| format!("parse DSN '{dsn}'"))?;
    let host = url.host_str().unwrap_or("localhost").to_string();
    let port = url
        .port()
        .unwrap_or(if kind == "mysql" { 3306 } else { 5432 });
    let user = url.username().to_string();
    let password = url.password().map(|p| p.to_string());
    let db = url.path().trim_start_matches('/');
    let cfg = ConnectionConfig {
        id: uuid_nil(),
        name: "cli-dsn".into(),
        color: None,
        host,
        port,
        user,
        password,
        default_database: if db.is_empty() {
            None
        } else {
            Some(db.to_string())
        },
        tls: TlsMode::Preferred,
        ssh_tunnel: None,
        ssh_jump_hosts: vec![],
        http_proxy: None,
        ssm_tunnel: None,
    };
    Ok((driver, cfg))
}

fn uuid_nil() -> uuid::Uuid {
    uuid::Uuid::nil()
}

async fn run_backup(args: BackupArgs, conn: Option<&str>) -> Result<()> {
    let (driver, config) = resolve_connection(&args.conn, conn).await?;
    driver
        .connect(&config)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;

    let schema = args
        .schema
        .clone()
        .or_else(|| config.default_database.clone())
        .ok_or_else(|| anyhow!("specify --schema (no default database on the connection)"))?;

    let tables: Vec<String> = if args.tables.is_empty() {
        driver
            .list_tables(&schema)
            .await
            .map_err(|e| anyhow!("list tables: {e}"))?
            .into_iter()
            .filter(|t| t.kind == TableKind::Table)
            .map(|t| t.name)
            .collect()
    } else {
        args.tables.clone()
    };
    eprintln!("Backing up {} table(s) from '{schema}'…", tables.len());

    let opts = DumpToBmbakOptions {
        created_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        level: args.level,
        chunk_size: args.chunk,
        include_objects: args.tables.is_empty(),
        checksum: !args.no_checksum,
        lock_non_transactional: args.lock_non_transactional,
    };

    match args.format {
        OutFormat::Bmbak => {
            let file = std::fs::File::create(&args.out)
                .with_context(|| format!("create {}", args.out))?;
            dump_tables_to_bmbak(driver.as_ref(), &schema, &tables, &opts, file, &StderrProgress::new(), None)
                .await?;
        }
        OutFormat::Sql => {
            // Dump to an in-memory .bmbak, then render SQL for the target dialect.
            let buf = dump_tables_to_bmbak(
                driver.as_ref(),
                &schema,
                &tables,
                &opts,
                Cursor::new(Vec::new()),
                &StderrProgress::new(),
                None,
            )
            .await?
            .into_inner();
            let dialect = match &args.sql_dialect {
                Some(d) => Dialect::parse(d)
                    .ok_or_else(|| anyhow!("unknown --sql-dialect '{d}'"))?,
                None => Dialect::parse(driver.dialect()).unwrap_or(Dialect::Mysql),
            };
            let mut reader = BmbakReader::open(Cursor::new(buf))?;
            let mut out = std::fs::File::create(&args.out)
                .with_context(|| format!("create {}", args.out))?;
            export_to_sql(
                &mut reader,
                &SqlExportOptions { dialect, ..Default::default() },
                &mut out,
            )?;
        }
    }
    let _ = driver.disconnect().await;
    println!("Backup written to {}", args.out);
    Ok(())
}

async fn run_restore(args: RestoreArgs, conn: Option<&str>) -> Result<()> {
    let (driver, config) = resolve_connection(&args.conn, conn).await?;
    driver
        .connect(&config)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;

    let file = std::fs::File::open(&args.in_file)
        .with_context(|| format!("open {}", args.in_file))?;
    let mut reader = BmbakReader::open(file)?;

    let target_schema = target_schema(driver.as_ref(), args.schema, &config)?;
    let mut recorded: Vec<&str> = reader
        .manifest
        .tables
        .iter()
        .filter_map(|t| t.schema.as_deref())
        .collect();
    recorded.dedup();
    let into = target_schema
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| recorded.join(", "));
    if !into.is_empty() {
        eprintln!(
            "Restoring {} table(s) into '{into}' (backup taken from '{}')",
            reader.manifest.tables.len(),
            recorded.join(", ")
        );
    }

    let opts = RestoreOptions {
        create_tables: !args.no_create,
        drop_before_create: !args.no_drop,
        strip_definer: args.strip_definer,
        target_schema,
        verify: !args.no_verify,
        ..Default::default()
    };

    let progress = StderrProgress::new();
    let stats = restore_from_bmbak(driver.as_ref(), &mut reader, &opts, &progress, None).await?;
    let _ = driver.disconnect().await;
    println!(
        "Restored {} table(s), {} rows, {} view(s) / routine(s) / trigger(s)",
        stats.tables, stats.rows, stats.objects
    );
    if !args.no_verify {
        println!("Verified {} table(s) against the backup", stats.verified);
    }
    Ok(())
}

/// MySQL "database" is the schema, so the one in the DSN wins over the one
/// recorded in the backup; on Postgres the DSN names the database and the
/// recorded schema (e.g. `public`) still applies inside it.
fn target_schema(
    driver: &dyn Driver,
    explicit: Option<String>,
    config: &ConnectionConfig,
) -> Result<Option<String>> {
    Ok(match driver.dialect() {
        "sqlite" if explicit.is_some() => bail!("--schema doesn't apply to SQLite"),
        "mysql" => explicit.or(config.default_database.clone()),
        _ => explicit,
    })
}

async fn run_verify(args: VerifyArgs, conn: Option<&str>) -> Result<()> {
    let (driver, config) = resolve_connection(&args.conn, conn).await?;
    driver
        .connect(&config)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;
    let file = std::fs::File::open(&args.in_file)
        .with_context(|| format!("open {}", args.in_file))?;
    let reader = BmbakReader::open(file)?;
    let schema = target_schema(driver.as_ref(), args.schema, &config)?;

    let checks = verify_tables(driver.as_ref(), &reader.manifest.tables, schema.as_deref()).await?;
    let _ = driver.disconnect().await;
    let mut bad = 0;
    for c in &checks {
        if c.ok() {
            let how = if c.expected_sum.is_some() { "rows + checksum" } else { "rows only" };
            println!("  ok    {} ({} rows, {how})", c.table, c.actual_rows);
        } else {
            bad += 1;
            println!("  DIFF  {}", describe_mismatch(c));
        }
    }
    if bad > 0 {
        bail!("{bad} of {} table(s) differ from the backup", checks.len());
    }
    println!("All {} table(s) match the backup", checks.len());
    Ok(())
}

async fn run_schedule_list() -> Result<()> {
    let paths = AppPaths::resolve()?;
    let store = Store::open(&paths.db_path()).await?;
    let rows = store.scheduled_backups().list_all().await?;
    if rows.is_empty() {
        println!("No scheduled backups.");
        return Ok(());
    }
    for r in rows {
        let enabled = if r.enabled { "on" } else { "off" };
        println!(
            "{}  [{}]  {} ({})  -> {}  fmt={}  next={:?}",
            r.id, enabled, r.name, r.schedule_expr, r.dest_dir, r.format, r.next_run_at
        );
    }
    std::io::stdout().flush().ok();
    Ok(())
}

fn parse_daily(s: &str) -> Result<(u32, u32)> {
    let (h, m) = s
        .split_once(':')
        .ok_or_else(|| anyhow!("--daily-at must be HH:MM"))?;
    Ok((h.parse()?, m.parse()?))
}

fn ext_of(f: OutFormat) -> &'static str {
    match f {
        OutFormat::Bmbak => "bmbak",
        OutFormat::Sql => "sql",
    }
}

async fn run_schedule_add(a: ScheduleAddArgs, conn: Option<&str>) -> Result<()> {
    let conn = conn.ok_or_else(|| anyhow!("provide -c/--conn NAME"))?;
    let cadence = match (a.every_minutes, &a.daily_at) {
        (Some(m), _) => Cadence::EveryMinutes(m),
        (_, Some(s)) => {
            let (hour, minute) = parse_daily(s)?;
            Cadence::DailyAt { hour, minute }
        }
        _ => bail!("provide --every-minutes N or --daily-at HH:MM"),
    };
    let (kind, expr) = match cadence {
        Cadence::EveryMinutes(m) => ("interval".to_string(), ((m as i64) * 60).to_string()),
        Cadence::DailyAt { hour, minute } => ("daily".to_string(), format!("{hour:02}:{minute:02}")),
    };

    let paths = AppPaths::resolve()?;
    let store = Store::open(&paths.db_path()).await?;
    let profile = store
        .connections()
        .list()
        .await?
        .into_iter()
        .find(|p| p.name.eq_ignore_ascii_case(conn))
        .ok_or_else(|| anyhow!("no stored connection named '{conn}'"))?;

    let scopes = serde_json::json!([{ "schema": a.schema, "tables": [] }]).to_string();
    let draft = basemaster_store::ScheduledBackupDraft {
        name: a.name.clone(),
        schedule_kind: kind,
        schedule_expr: expr,
        dest_dir: a.out_dir.clone(),
        format: ext_of(a.format).to_string(),
        compression: "zstd".into(),
        compression_level: a.level as i64,
        content: "both".into(),
        scopes_json: scopes,
        retention_keep_n: a.keep_n.map(|n| n as i64),
        retention_days: a.max_age_days.map(|n| n as i64),
        enabled: true,
        accept_ssh_hosts: a.accept_ssh_hosts,
        next_run_at: Some(chrono::Utc::now().timestamp()),
    };
    let saved = store.scheduled_backups().create(profile.id, draft).await?;

    let program = std::env::current_exe().context("locate own binary")?;
    let mut args = vec!["schedule".into(), "run".into(), saved.id.to_string()];
    if a.accept_ssh_hosts {
        args.push("--accept-ssh-hosts".into());
    }
    let spec = TaskSpec {
        id: saved.id.to_string(),
        program,
        args,
        cadence,
    };
    os_schedule::register(&spec, a.dry_run)?;
    println!("Scheduled '{}' (id {})", saved.name, saved.id);
    Ok(())
}

async fn run_schedule_rm(id: &str) -> Result<()> {
    let uuid: uuid::Uuid = id.parse().context("invalid schedule id")?;
    os_schedule::unregister(id, false)?;
    let paths = AppPaths::resolve()?;
    let store = Store::open(&paths.db_path()).await?;
    store.scheduled_backups().delete(uuid).await?;
    println!("Removed schedule {id}");
    Ok(())
}

async fn run_schedule_run(id: &str) -> Result<()> {
    let uuid: uuid::Uuid = id.parse().context("invalid schedule id")?;
    let paths = AppPaths::resolve()?;
    let store = Store::open(&paths.db_path()).await?;
    let file = run_and_record(&store, uuid, &|k| make_driver(k), &StderrProgress::new()).await?;
    println!("Backup done: {file}");
    Ok(())
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let conn = cli.global.conn.as_deref();
    let result = match cli.command {
        Command::Remote(cmd) => match remote::run(&cli.global, cmd).await {
            Ok(()) => Ok(()),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(e.exit_code());
            }
        },
        Command::Backup(a) => run_backup(a, conn).await,
        Command::Restore(a) => run_restore(a, conn).await,
        Command::Verify(a) => run_verify(a, conn).await,
        Command::Schedule { action } => match action {
            ScheduleAction::List => run_schedule_list().await,
            ScheduleAction::Add(a) => run_schedule_add(a, conn).await,
            ScheduleAction::Run { id } => run_schedule_run(&id).await,
            ScheduleAction::Rm { id } => run_schedule_rm(&id).await,
        },
    };
    if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
