//! BaseMaster headless CLI: backup / restore / list schedules without a GUI.
//!
//! Built on `basemaster-backup` + the driver crates only — no Tauri, no webkit
//! — so it runs on a bare Linux server. Connection source is either a stored
//! profile (`--conn NAME`, reads the local SQLite + OS keyring) or a DSN
//! (`--dsn mysql://user:pass@host/db`) which needs nothing installed.
//!
//! SSH-tunnel connections aren't supported here yet; use a DSN to the
//! already-reachable host (e.g. run the CLI on the box behind the tunnel).

use std::io::{Cursor, Write};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use basemaster_backup::container::BmbakReader;
use basemaster_backup::dump::{dump_tables_to_bmbak, DumpToBmbakOptions, Progress};
use basemaster_backup::restore::{restore_from_bmbak, RestoreOptions};
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
#[command(name = "basemaster-cli", version, about = "BaseMaster backup CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Dump a database to a .bmbak (or .sql) file.
    Backup(BackupArgs),
    /// Restore a .bmbak into a database.
    Restore(RestoreArgs),
    /// List scheduled backups stored locally.
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

#[derive(clap::Args)]
struct ScheduleAddArgs {
    /// Stored connection name the backup runs against.
    #[arg(long)]
    conn: String,
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
    /// Stored connection name (reads local SQLite + keyring).
    #[arg(long, conflicts_with = "dsn")]
    conn: Option<String>,
    /// Connection string, e.g. mysql://user:pass@host:3306/db or
    /// postgres://... or sqlite:///abs/path.db
    #[arg(long, conflicts_with = "conn")]
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
    /// Output file.
    #[arg(long, short)]
    out: String,
    #[arg(long, value_enum, default_value_t = OutFormat::Bmbak)]
    format: OutFormat,
    /// Target SQL dialect when --format sql (defaults to the source dialect).
    #[arg(long)]
    sql_dialect: Option<String>,
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
    /// Don't run the CREATE TABLE DDL; insert into existing tables.
    #[arg(long)]
    no_create: bool,
    /// Don't DROP TABLE before create.
    #[arg(long)]
    no_drop: bool,
}

/// Prints one line per table to stderr.
struct StderrProgress;
impl Progress for StderrProgress {
    fn table_started(&self, table: &str, total: u64) {
        eprintln!("  {table}: {total} rows…");
    }
    fn table_done(&self, table: &str, rows: u64) {
        eprintln!("  {table}: done ({rows} rows)");
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
async fn resolve_connection(args: &ConnArgs) -> Result<(Arc<dyn Driver>, ConnectionConfig)> {
    if let Some(dsn) = &args.dsn {
        return config_from_dsn(dsn);
    }
    let name = args
        .conn
        .as_ref()
        .ok_or_else(|| anyhow!("provide --conn NAME or --dsn URL"))?;

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

async fn run_backup(args: BackupArgs) -> Result<()> {
    let (driver, config) = resolve_connection(&args.conn).await?;
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
    };

    match args.format {
        OutFormat::Bmbak => {
            let file = std::fs::File::create(&args.out)
                .with_context(|| format!("create {}", args.out))?;
            dump_tables_to_bmbak(driver.as_ref(), &schema, &tables, &opts, file, &StderrProgress, None)
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
                &StderrProgress,
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

async fn run_restore(args: RestoreArgs) -> Result<()> {
    let (driver, config) = resolve_connection(&args.conn).await?;
    driver
        .connect(&config)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;

    let file = std::fs::File::open(&args.in_file)
        .with_context(|| format!("open {}", args.in_file))?;
    let mut reader = BmbakReader::open(file)?;
    let opts = RestoreOptions {
        create_tables: !args.no_create,
        drop_before_create: !args.no_drop,
        ..Default::default()
    };

    struct P;
    impl basemaster_backup::restore::Progress for P {
        fn table_done(&self, table: &str, rows: u64) {
            eprintln!("  {table}: restored {rows} rows");
        }
    }
    let stats = restore_from_bmbak(driver.as_ref(), &mut reader, &opts, &P, None).await?;
    let _ = driver.disconnect().await;
    println!("Restored {} table(s), {} rows", stats.tables, stats.rows);
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

async fn run_schedule_add(a: ScheduleAddArgs) -> Result<()> {
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
        .find(|p| p.name.eq_ignore_ascii_case(&a.conn))
        .ok_or_else(|| anyhow!("no stored connection named '{}'", a.conn))?;

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
    let file = run_and_record(&store, uuid, &|k| make_driver(k), &StderrProgress).await?;
    println!("Backup done: {file}");
    Ok(())
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Backup(a) => run_backup(a).await,
        Command::Restore(a) => run_restore(a).await,
        Command::Schedule { action } => match action {
            ScheduleAction::List => run_schedule_list().await,
            ScheduleAction::Add(a) => run_schedule_add(a).await,
            ScheduleAction::Run { id } => run_schedule_run(&id).await,
            ScheduleAction::Rm { id } => run_schedule_rm(&id).await,
        },
    };
    if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
