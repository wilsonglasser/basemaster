//! Commands that talk to the running GUI's MCP server. One process per
//! command, so a shell script (or an agent driving one) can chain them
//! with pipes and `jq` instead of issuing one MCP tool call at a time.

use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;

use anyhow::{anyhow, Context};
use basemaster_cli::client::{Client, CliError, ConnInfo, Endpoint, MAX_WAIT_SECS};
use basemaster_cli::output::{self, Format, Table};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value as JsonValue};

#[derive(Args, Debug, Clone)]
pub struct Global {
    /// Saved connection: name (case-insensitive) or UUID. Most commands need it.
    #[arg(short = 'c', long, global = true, env = "BASEMASTER_CONN")]
    pub conn: Option<String>,
    /// Output format. Default: `table` on a terminal, `json` when piped.
    #[arg(short = 'o', long, global = true, value_enum)]
    pub output: Option<Format>,
    /// MCP server port (default: what the app persisted, else 7424).
    #[arg(long, global = true, env = "BASEMASTER_MCP_PORT", hide_env = true)]
    pub port: Option<u16>,
    /// MCP bearer token (default: read from the OS keyring).
    #[arg(long, global = true, env = "BASEMASTER_MCP_TOKEN", hide_env = true)]
    pub token: Option<String>,
}

impl Global {
    pub fn format(&self) -> Format {
        self.output.unwrap_or_else(|| {
            if std::io::stdout().is_terminal() {
                Format::Table
            } else {
                Format::Json
            }
        })
    }
}

#[derive(Subcommand, Debug)]
pub enum Remote {
    /// Check the MCP server is reachable; prints version and port.
    Status,
    /// Saved connections.
    Conn {
        #[command(subcommand)]
        action: ConnAction,
    },
    /// List schemas / databases of a connection.
    Schemas,
    /// List tables and views of a schema.
    Tables {
        /// Defaults to the connection's default database.
        #[arg(long, short = 's')]
        schema: Option<String>,
    },
    /// Columns of a table.
    Describe {
        table: String,
        #[arg(long, short = 's')]
        schema: Option<String>,
    },
    /// CREATE TABLE statement of a table (raw SQL unless -o json).
    Ddl {
        table: String,
        #[arg(long, short = 's')]
        schema: Option<String>,
    },
    /// Run SQL and print the rows. SQL from the argument, --file, or stdin.
    ///
    /// Blocks until the statement finishes (polling the server job if it
    /// outlives one request). Write statements are subject to the guardrails
    /// configured in Settings > MCP server.
    Query(QueryArgs),
    /// Run SQL and stream the whole result to a file (jsonl or csv).
    ///
    /// Use this for big results: nothing round-trips through stdout except
    /// a summary (path, rows, bytes, sha256) plus a small sample.
    Export(ExportArgs),
    /// Copy tables between two connections (the Data Transfer engine).
    Transfer(TransferArgs),
    /// Background jobs started by query/export/transfer.
    Job {
        #[command(subcommand)]
        action: JobAction,
    },
    /// Print a short usage guide aimed at scripts and AI agents.
    Guide,
}

#[derive(Subcommand, Debug)]
pub enum ConnAction {
    /// List saved connections (no passwords).
    Ls,
    /// Open a connection now (tunnels, credentials). Other commands open on demand.
    Open { name: String },
    /// Close an open connection.
    Close { name: String },
}

#[derive(Subcommand, Debug)]
pub enum JobAction {
    /// Show a job; waits up to --wait seconds for it to finish.
    Status {
        id: String,
        #[arg(long, default_value_t = 0)]
        wait: u64,
    },
    /// List known jobs.
    Ls,
    /// Stop a running job.
    Cancel { id: String },
}

#[derive(Args, Debug)]
pub struct QueryArgs {
    /// SQL text. Omit to read from --file or stdin.
    sql: Option<String>,
    /// Read the SQL from a file ("-" = stdin).
    #[arg(long, short = 'f')]
    file: Option<PathBuf>,
    #[arg(long, short = 's')]
    schema: Option<String>,
    /// Rows to return at most (the server caps the payload).
    #[arg(long, default_value_t = 500)]
    max_rows: u64,
    /// Return the job id right away instead of waiting for the result.
    #[arg(long = "async")]
    r#async: bool,
    /// Keep cells as the tagged {type, value} form the server sends.
    #[arg(long)]
    raw: bool,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum FileFormat {
    Jsonl,
    Csv,
}

#[derive(Args, Debug)]
pub struct ExportArgs {
    sql: Option<String>,
    #[arg(long, short = 'f')]
    file: Option<PathBuf>,
    #[arg(long, short = 's')]
    schema: Option<String>,
    /// Output file. Relative paths resolve against the current directory.
    #[arg(long, short = 'p')]
    path: PathBuf,
    /// File format; inferred from the extension when omitted (.csv -> csv, else jsonl).
    #[arg(long = "as", value_enum)]
    format: Option<FileFormat>,
    /// Rows echoed back in the summary.
    #[arg(long, default_value_t = 20)]
    sample: u64,
    #[arg(long = "async")]
    r#async: bool,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum InsertMode {
    Insert,
    InsertIgnore,
    Replace,
}

#[derive(Args, Debug)]
pub struct TransferArgs {
    /// Source connection (name or UUID).
    #[arg(long)]
    from: String,
    /// Source schema; defaults to the source connection's default database.
    #[arg(long)]
    from_schema: Option<String>,
    /// Target connection (name or UUID).
    #[arg(long)]
    to: String,
    /// Target schema; defaults to the target connection's default database.
    #[arg(long)]
    to_schema: Option<String>,
    /// Tables to copy (comma-separated). Omit for every base table of the source schema.
    #[arg(long, value_delimiter = ',')]
    tables: Vec<String>,
    /// Skip CREATE TABLE on the target (tables must exist).
    #[arg(long)]
    no_create: bool,
    /// DROP the target tables first. Destructive.
    #[arg(long)]
    drop_target: bool,
    /// DELETE FROM the target tables before inserting. Destructive.
    #[arg(long)]
    empty_target: bool,
    /// Copy structure only, no rows.
    #[arg(long)]
    structure_only: bool,
    #[arg(long, value_enum, default_value_t = InsertMode::Insert)]
    insert_mode: InsertMode,
    #[arg(long)]
    continue_on_error: bool,
    /// Tables copied in parallel (1-16).
    #[arg(long, default_value_t = 1)]
    concurrency: u32,
    #[arg(long, default_value_t = 1000)]
    chunk_size: u64,
    #[arg(long = "async")]
    r#async: bool,
}

pub type Result<T> = std::result::Result<T, CliError>;

pub async fn run(global: &Global, cmd: Remote) -> Result<()> {
    if let Remote::Guide = cmd {
        print!("{}", GUIDE);
        return Ok(());
    }
    let ep = Endpoint::resolve(global.port, global.token.clone()).await?;
    let client = Client::new(&ep);
    let fmt = global.format();
    let mut out = std::io::stdout().lock();

    match cmd {
        Remote::Guide => unreachable!(),
        Remote::Status => {
            let info = client.server_info()?;
            let conns = client.connections()?;
            let payload = json!({
                "running": true,
                "port": ep.port,
                "url": ep.url(),
                "version": info.pointer("/serverInfo/version"),
                "connections": conns.len(),
            });
            output::emit_value(&mut out, fmt, &payload)?;
        }
        Remote::Conn { action } => match action {
            ConnAction::Ls => {
                let v = client.call("list_connections", json!({}))?;
                let list = v.get("connections").cloned().unwrap_or(json!([]));
                output::emit_value(&mut out, fmt, &list)?;
            }
            ConnAction::Open { name } => {
                let c = client.resolve_connection(&name)?;
                let v = client.call("open_connection", json!({ "connection_id": c.id }))?;
                output::emit_value(&mut out, fmt, &with_conn(v, &c))?;
            }
            ConnAction::Close { name } => {
                let c = client.resolve_connection(&name)?;
                let v = client.call("close_connection", json!({ "connection_id": c.id }))?;
                output::emit_value(&mut out, fmt, &with_conn(v, &c))?;
            }
        },
        Remote::Schemas => {
            let c = need_conn(&client, global)?;
            let v = client.call("list_schemas", json!({ "connection_id": c.id }))?;
            let list = v.get("schemas").cloned().unwrap_or(json!([]));
            output::emit_value(&mut out, fmt, &list)?;
        }
        Remote::Tables { schema } => {
            let c = need_conn(&client, global)?;
            let schema = need_schema(schema, &c)?;
            let v = client.call(
                "list_tables",
                json!({ "connection_id": c.id, "schema": schema }),
            )?;
            let list = v.get("tables").cloned().unwrap_or(json!([]));
            output::emit_value(&mut out, fmt, &list)?;
        }
        Remote::Describe { table, schema } => {
            let c = need_conn(&client, global)?;
            let schema = need_schema(schema, &c)?;
            let v = client.call(
                "describe_table",
                json!({ "connection_id": c.id, "schema": schema, "table": table }),
            )?;
            let list = v.get("columns").cloned().unwrap_or(v);
            output::emit_value(&mut out, fmt, &list)?;
        }
        Remote::Ddl { table, schema } => {
            let c = need_conn(&client, global)?;
            let schema = need_schema(schema, &c)?;
            let v = client.call(
                "get_table_ddl",
                json!({ "connection_id": c.id, "schema": schema, "table": table }),
            )?;
            match fmt {
                Format::Json | Format::Ndjson => output::emit_value(&mut out, fmt, &v)?,
                _ => {
                    let ddl = v.get("ddl").and_then(|d| d.as_str()).unwrap_or("");
                    writeln!(out, "{ddl}")?;
                }
            }
        }
        Remote::Query(a) => {
            let c = need_conn(&client, global)?;
            let sql = read_sql(a.sql, a.file.as_deref())?;
            let mut args = json!({
                "connection_id": c.id,
                "sql": sql,
                "max_rows": a.max_rows,
                "wait_seconds": if a.r#async { 0 } else { MAX_WAIT_SECS },
            });
            if let Some(s) = a.schema.or(c.default_database.clone()) {
                args["schema"] = json!(s);
            }
            let first = client.call("run_query", args)?;
            if a.r#async {
                output::emit_value(&mut out, fmt, &first)?;
                return Ok(());
            }
            let payload = client.wait_job(first, MAX_WAIT_SECS, &mut |_| {})?;
            if a.raw {
                output::emit_value(&mut out, fmt, &payload)?;
            } else if let Some(t) = Table::from_query(&payload) {
                output::emit_table(&mut out, fmt, &t, &output::query_meta(&payload))?;
            } else {
                output::emit_value(&mut out, fmt, &payload)?;
            }
        }
        Remote::Export(a) => {
            let c = need_conn(&client, global)?;
            let sql = read_sql(a.sql, a.file.as_deref())?;
            let path = absolute(&a.path)?;
            let format = a.format.unwrap_or_else(|| {
                match path.extension().and_then(|e| e.to_str()) {
                    Some(e) if e.eq_ignore_ascii_case("csv") => FileFormat::Csv,
                    _ => FileFormat::Jsonl,
                }
            });
            let mut args = json!({
                "connection_id": c.id,
                "sql": sql,
                "path": path.to_string_lossy(),
                "format": match format { FileFormat::Csv => "csv", FileFormat::Jsonl => "jsonl" },
                "sample_rows": a.sample,
                "wait_seconds": if a.r#async { 0 } else { MAX_WAIT_SECS },
            });
            if let Some(s) = a.schema.or(c.default_database.clone()) {
                args["schema"] = json!(s);
            }
            let first = client.call("run_query_to_file", args)?;
            let payload = if a.r#async {
                first
            } else {
                client.wait_job(first, MAX_WAIT_SECS, &mut |_| {})?
            };
            output::emit_value(&mut out, fmt, &flatten_sample(payload))?;
        }
        Remote::Transfer(a) => {
            let src = client.resolve_connection(&a.from)?;
            let dst = client.resolve_connection(&a.to)?;
            let src_schema = a
                .from_schema
                .or(src.default_database.clone())
                .ok_or_else(|| usage("--from-schema is required (source has no default database)"))?;
            let dst_schema = a
                .to_schema
                .or(dst.default_database.clone())
                .ok_or_else(|| usage("--to-schema is required (target has no default database)"))?;
            let mut args = json!({
                "source_connection_id": src.id,
                "source_schema": src_schema,
                "target_connection_id": dst.id,
                "target_schema": dst_schema,
                "create_tables": !a.no_create,
                "drop_target": a.drop_target,
                "empty_target": a.empty_target,
                "create_records": !a.structure_only,
                "insert_mode": match a.insert_mode {
                    InsertMode::Insert => "insert",
                    InsertMode::InsertIgnore => "insert_ignore",
                    InsertMode::Replace => "replace",
                },
                "continue_on_error": a.continue_on_error,
                "concurrency": a.concurrency,
                "chunk_size": a.chunk_size,
                "wait_seconds": if a.r#async { 0 } else { 5 },
            });
            if !a.tables.is_empty() {
                args["tables"] = json!(a.tables);
            }
            let first = client.call("transfer_tables", args)?;
            if a.r#async {
                output::emit_value(&mut out, fmt, &first)?;
                return Ok(());
            }
            let mut last = String::new();
            let payload = client.wait_job(first, 5, &mut |p| {
                let table = p.get("table").and_then(|t| t.as_str()).unwrap_or("?");
                let done = p.get("done").and_then(|d| d.as_u64()).unwrap_or(0);
                let total = p.get("total").and_then(|d| d.as_u64()).unwrap_or(0);
                let line = format!("{table}: {done}/{total}");
                if line != last {
                    eprintln!("  {line}");
                    last = line;
                }
            })?;
            output::emit_value(&mut out, fmt, &payload)?;
        }
        Remote::Job { action } => match action {
            JobAction::Status { id, wait } => {
                let mut v = client.call(
                    "job_status",
                    json!({ "job_id": id, "wait_seconds": wait.min(MAX_WAIT_SECS) }),
                )?;
                if let Some(rows) = v
                    .get("result")
                    .and_then(Table::from_query)
                    .map(|t| JsonValue::Array(t.row_objects()))
                {
                    v["result"]["rows"] = rows;
                }
                output::emit_value(&mut out, fmt, &v)?;
            }
            JobAction::Ls => {
                let v = client.call("job_list", json!({}))?;
                let list = v.get("jobs").cloned().unwrap_or(json!([]));
                output::emit_value(&mut out, fmt, &list)?;
            }
            JobAction::Cancel { id } => {
                let v = client.call("job_cancel", json!({ "job_id": id }))?;
                output::emit_value(&mut out, fmt, &v)?;
            }
        },
    }
    out.flush()?;
    Ok(())
}

fn usage(msg: &str) -> CliError {
    CliError::Other(anyhow!("{msg}"))
}

fn need_conn(client: &Client, global: &Global) -> Result<ConnInfo> {
    let name = global.conn.as_deref().ok_or_else(|| {
        usage("no connection given: pass -c/--conn NAME or set BASEMASTER_CONN (see `conn ls`)")
    })?;
    client.resolve_connection(name)
}

fn need_schema(explicit: Option<String>, c: &ConnInfo) -> Result<String> {
    explicit
        .or_else(|| c.default_database.clone())
        .ok_or_else(|| {
            usage(&format!(
                "connection '{}' has no default database: pass --schema (see `schemas`)",
                c.name
            ))
        })
}

fn with_conn(mut v: JsonValue, c: &ConnInfo) -> JsonValue {
    if let Some(o) = v.as_object_mut() {
        o.insert("connection".into(), json!(c.name));
        o.insert("connection_id".into(), json!(c.id));
    }
    v
}

fn read_sql(arg: Option<String>, file: Option<&std::path::Path>) -> Result<String> {
    let sql = match (arg, file) {
        (Some(s), None) => s,
        (None, Some(p)) if p.as_os_str() == "-" => read_stdin()?,
        (None, Some(p)) => std::fs::read_to_string(p)
            .with_context(|| format!("read {}", p.display()))
            .map_err(CliError::Other)?,
        (Some(_), Some(_)) => return Err(usage("give the SQL as an argument or via --file, not both")),
        (None, None) => {
            if std::io::stdin().is_terminal() {
                return Err(usage("no SQL given: pass it as an argument, with --file, or on stdin"));
            }
            read_stdin()?
        }
    };
    if sql.trim().is_empty() {
        return Err(usage("SQL is empty"));
    }
    Ok(sql)
}

fn read_stdin() -> Result<String> {
    let mut s = String::new();
    std::io::stdin()
        .read_to_string(&mut s)
        .context("read stdin")
        .map_err(CliError::Other)?;
    Ok(s)
}

fn absolute(p: &std::path::Path) -> Result<PathBuf> {
    if p.is_absolute() {
        return Ok(p.to_path_buf());
    }
    let cwd = std::env::current_dir()
        .context("current dir")
        .map_err(CliError::Other)?;
    Ok(cwd.join(p))
}

/// The export summary carries a `sample` of tagged rows; flatten it like a
/// query result so scripts see plain objects.
fn flatten_sample(mut payload: JsonValue) -> JsonValue {
    let sample = payload
        .get("columns")
        .zip(payload.get("sample"))
        .map(|(cols, rows)| json!({ "columns": cols, "rows": rows }))
        .and_then(|q| Table::from_query(&q))
        .map(|t| JsonValue::Array(t.row_objects()));
    if let (Some(obj), Some(rows)) = (payload.as_object_mut(), sample) {
        obj.insert("sample".into(), rows);
    }
    payload
}

const GUIDE: &str = r#"# basemaster-cli: scripting BaseMaster from a shell

Talks to the MCP server of the running BaseMaster app (Settings > MCP server
must be started). Connections, SSH/SSM tunnels, credentials and guardrails all
live in the app; the CLI just issues commands, so running fifty of them in a
script costs nothing extra.

Output is JSON when stdout is a pipe (what scripts and agents see) and an
aligned table on a terminal. Force one with -o json|ndjson|csv|table.
Errors go to stderr; exit 0 ok, 1 error (including a guardrail block),
3 app not running, 4 bad token.

Pick the connection once:
    export BASEMASTER_CONN=prod        # or pass -c prod on each command
    basemaster-cli conn ls             # names, drivers, default database

Explore:
    basemaster-cli schemas
    basemaster-cli tables                      # default database
    basemaster-cli tables -s other_schema
    basemaster-cli describe users
    basemaster-cli ddl users                   # raw CREATE TABLE

Query (rows become objects keyed by column; jq-friendly):
    basemaster-cli query "select id, email from users limit 5"
    basemaster-cli query "select count(*) n from orders" | jq '.rows[0].n'
    basemaster-cli query -f report.sql -o csv > report.csv
    cat <<'SQL' | basemaster-cli query -o ndjson
    select * from orders where status = 'open'
    SQL
    Rows are capped at --max-rows (500). For big results use export.

Export a whole result set to disk (jsonl or csv), summary on stdout:
    basemaster-cli export "select * from events" --path events.jsonl
    basemaster-cli export -f q.sql --path out.csv --as csv

Loop over tables:
    for t in $(basemaster-cli tables | jq -r '.[].name'); do
      basemaster-cli query "select count(*) n from \"$t\"" | jq -r --arg t "$t" '"\($t)\t\(.rows[0].n)"'
    done

Copy tables between connections (progress on stderr):
    basemaster-cli transfer --from prod --to staging --tables users,orders
    basemaster-cli transfer --from prod --to local --from-schema app --to-schema app --drop-target

Long work: query/export/transfer block until done. Add --async to get a
job_id immediately, then `job status <id> --wait 60`, `job ls`, `job cancel <id>`.

Write statements (INSERT/UPDATE/DDL/...) are blocked unless the matching
guardrail is turned off in Settings > MCP server, or the connection has its
own agent policy. A blocked statement exits 1 with the reason on stderr.
"#;
