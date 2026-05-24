//! SQL Dump V1 — exports schema(s) or a single table to `.sql` or `.zip`.
//!
//! Reuses `data_transfer`'s INSERT-formatting functions
//! (`sql_literal_opts`, extended inserts). Writes directly to the file
//! (or ZIP entry) in chunks — bounded memory.
//!
//! Two-phase parallel pipeline:
//!   Phase A — fan out across tables (and, for big integer-PK tables, across
//!     PK ranges). Each worker writes DDL/data to its own temp file, so there
//!     is no write contention. Mirrors `data_transfer`'s two parallelism
//!     levels (per-table + intra-table PK range).
//!   Phase B — merge the temp files into the final `.sql`/`.zip` in a
//!     deterministic order. The final file is only created here, so a cancel
//!     during phase A leaves no half-written output.
//!
//! Events:
//!   `sql_dump:progress` — { schema, table, done, total, elapsed_ms }
//!   `sql_dump:worker_progress` — per PK-range worker (intra-table drill-down)
//!   `sql_dump:table_note` — diagnostic (e.g. intra-parallel not engaged)
//!   `sql_dump:table_done` — { schema, table, rows, elapsed_ms, error }
//!   `sql_dump:done` — { total_rows, elapsed_ms, tables_done, failed }

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use basemaster_core::{Driver, QueryResult};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::data_transfer::TransferControl;

/// Formats `Value` as an SQL literal. `pg_mode` emits BLOB as
/// `'\xAABB'::bytea` (PG hex-escape syntax) instead of `0xAABB`
/// (MySQL). `bool` on PG becomes `TRUE/FALSE` literal.
fn sql_literal_opts_dialect(
    v: &basemaster_core::Value,
    hex_blob: bool,
    pg_mode: bool,
) -> String {
    if pg_mode {
        if let basemaster_core::Value::Bytes(b) = v {
            let hex: String =
                b.iter().map(|byte| format!("{:02x}", byte)).collect();
            return format!("'\\x{}'::bytea", hex);
        }
        if let basemaster_core::Value::Bool(bl) = v {
            return if *bl { "TRUE".into() } else { "FALSE".into() };
        }
    }
    sql_literal_opts(v, hex_blob)
}

/// MySQL-flavored version — kept for compat and reuse in data_transfer.
fn sql_literal_opts(v: &basemaster_core::Value, hex_blob: bool) -> String {
    use basemaster_core::Value;
    fn quote(s: &str) -> String {
        // ANSI SQL escape: '→'', \→\\, \n→\n (literal), \r→\r, \0→\0.
        let mut out = String::with_capacity(s.len() + 2);
        out.push('\'');
        for c in s.chars() {
            match c {
                '\'' => out.push_str("''"),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\0' => out.push_str("\\0"),
                _ => out.push(c),
            }
        }
        out.push('\'');
        out
    }
    if !hex_blob {
        if let Value::Bytes(b) = v {
            let s = b.iter().map(|c| *c as char).collect::<String>();
            return quote(&s);
        }
    }
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => {
            if f.is_finite() {
                format!("{}", f)
            } else {
                "NULL".into()
            }
        }
        Value::Decimal(d) => d.to_string(),
        Value::String(s) => quote(s),
        Value::Date(d) => quote(&d.format("%Y-%m-%d").to_string()),
        Value::Time(t) => quote(&t.format("%H:%M:%S").to_string()),
        Value::DateTime(dt) => quote(&dt.format("%Y-%m-%d %H:%M:%S").to_string()),
        Value::Timestamp(ts) => quote(&ts.format("%Y-%m-%d %H:%M:%S").to_string()),
        Value::Json(j) => quote(&j.to_string()),
        Value::Bytes(b) => {
            let hex: String = b.iter().map(|byte| format!("{:02X}", byte)).collect();
            format!("0x{}", hex)
        }
    }
}

// ---------------------------------------------------------------- types

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DumpContent {
    /// Only CREATE TABLE/VIEW — no INSERTs.
    Structure,
    /// Only INSERTs — assumes the structure already exists on the target.
    Data,
    /// Structure + data.
    #[default]
    Both,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DumpFormat {
    /// A single `.sql` file with everything concatenated.
    Sql,
    /// A `.zip` with one `.sql` per table (+ a `schema.sql` with initial DDL).
    Zip,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DumpCompression {
    /// No compression — just packages. Faster.
    #[default]
    Stored,
    /// Standard deflate (zlib).
    Deflate,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DumpScope {
    pub schema: String,
    /// If empty, dumps ALL tables/views of the schema.
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DumpOptions {
    pub source_connection_id: Uuid,
    pub scopes: Vec<DumpScope>,
    pub path: String,
    pub format: DumpFormat,
    #[serde(default)]
    pub compression: DumpCompression,
    #[serde(default)]
    pub content: DumpContent,
    /// DROP TABLE IF EXISTS before CREATE (if content includes structure).
    #[serde(default = "default_true")]
    pub drop_before_create: bool,
    /// Multi-row extended INSERT.
    #[serde(default = "default_true")]
    pub extended_inserts: bool,
    /// List of columns in the INSERT (recommended).
    #[serde(default = "default_true")]
    pub complete_inserts: bool,
    /// BLOB as 0xABCD — recommended.
    #[serde(default = "default_true")]
    pub hex_blob: bool,
    /// Include `CREATE DATABASE IF NOT EXISTS schema` in the header.
    #[serde(default)]
    pub create_schema: bool,
    /// Chunk used to paginate SELECT on the source.
    #[serde(default = "default_chunk")]
    pub chunk_size: u64,
    /// Max bytes per INSERT before breaking into another statement.
    #[serde(default = "default_max_stmt_kb")]
    pub max_statement_size_kb: u64,
    /// How many tables to dump in parallel (phase A). Each writes its own
    /// temp file, so there is no contention. Throttled by the source pool's
    /// max_connections (= 8).
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    /// Intra-table parallelism: split a single integer-PK table's range into
    /// N shards dumped in parallel. Default 1 (off). Only engages when the
    /// table has a single integer-column PK and total >= intra_table_min_rows.
    #[serde(default = "default_intra_workers")]
    pub intra_table_workers: u32,
    /// Minimum rows before intra-table sharding pays off (2x MIN/MAX + N
    /// connections overhead).
    #[serde(default = "default_intra_min_rows")]
    pub intra_table_min_rows: u64,
}

fn default_true() -> bool { true }
fn default_chunk() -> u64 { 1000 }
fn default_max_stmt_kb() -> u64 { 1024 }
fn default_concurrency() -> u32 { 4 }
fn default_intra_workers() -> u32 { 1 }
fn default_intra_min_rows() -> u64 { 100_000 }

#[derive(Clone, Debug, Serialize)]
pub struct DumpTableProgress {
    pub schema: String,
    pub table: String,
    pub done: u64,
    pub total: u64,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DumpTableDone {
    pub schema: String,
    pub table: String,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DumpDone {
    pub total_rows: u64,
    pub elapsed_ms: u64,
    pub tables_done: u32,
    pub failed: u32,
}

/// Progress of one intra-table PK-range worker. Lets the UI draw a
/// drill-down identical to data-transfer's. `low_pk`/`high_pk` are strings
/// because i128 doesn't serialize cleanly without `arbitrary_precision`.
#[derive(Clone, Debug, Serialize)]
pub struct DumpWorkerProgress {
    pub schema: String,
    pub table: String,
    pub worker_id: u32,
    pub low_pk: String,
    pub high_pk: String,
    pub done: u64,
    pub elapsed_ms: u64,
    pub finished: bool,
    pub error: Option<String>,
}

/// Informational message about a table (e.g. "intra-parallel requested but
/// not engaged because …"). Mirrors data_transfer's `TableNote`.
#[derive(Clone, Debug, Serialize)]
pub struct DumpTableNote {
    pub schema: String,
    pub table: String,
    pub message: String,
    /// "info" | "warn"
    pub level: String,
}

// ---------------------------------------------------------------- writer

/// Write abstraction — hides whether it's a single SQL or a ZIP. The caller
/// invokes `begin_file`/`write`/`end_file` and the writer routes to the target.
// A single instance per dump; doesn't go into a Vec or hot loop — the
// 377-byte overhead doesn't justify Box (clippy::large_enum_variant).
#[allow(clippy::large_enum_variant)]
enum DumpSink {
    /// Everything in a single file.
    Sql(std::fs::File),
    /// ZIP with multiple entries.
    Zip {
        zip: zip::ZipWriter<std::fs::File>,
        options: SimpleFileOptions,
        /// True when an entry is open — prevents corrupting the archive.
        entry_open: bool,
    },
}

impl DumpSink {
    fn open(opts: &DumpOptions) -> Result<Self, String> {
        let f = std::fs::File::create(&opts.path)
            .map_err(|e| format!("criar arquivo: {}", e))?;
        match opts.format {
            DumpFormat::Sql => Ok(DumpSink::Sql(f)),
            DumpFormat::Zip => {
                let method = match opts.compression {
                    DumpCompression::Stored => CompressionMethod::Stored,
                    DumpCompression::Deflate => CompressionMethod::Deflated,
                };
                let options = SimpleFileOptions::default().compression_method(method);
                Ok(DumpSink::Zip {
                    zip: zip::ZipWriter::new(f),
                    options,
                    entry_open: false,
                })
            }
        }
    }

    /// Starts a new "logical file" (entry in the ZIP, or just a separator
    /// in SQL). The entry name is only used in the ZIP.
    fn begin_file(&mut self, entry_name: &str) -> Result<(), String> {
        match self {
            DumpSink::Sql(_) => Ok(()),
            DumpSink::Zip { zip, options, entry_open } => {
                zip.start_file(entry_name, *options)
                    .map_err(|e| format!("zip start_file: {}", e))?;
                *entry_open = true;
                Ok(())
            }
        }
    }

    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            DumpSink::Sql(f) => f.write_all(data).map_err(|e| e.to_string()),
            DumpSink::Zip { zip, .. } => {
                zip.write_all(data).map_err(|e| e.to_string())
            }
        }
    }

    /// The current write target as a plain `Write`. Lets the data writers
    /// stream INSERTs straight into the sink (serial mode) with the same code
    /// path used for temp files.
    fn writer(&mut self) -> &mut (dyn Write + Send) {
        match self {
            DumpSink::Sql(f) => f,
            DumpSink::Zip { zip, .. } => zip,
        }
    }

    /// Streams a temp file's bytes into the current sink target. Buffered
    /// copy : bounded memory regardless of the shard size.
    fn write_from_file(&mut self, path: &Path) -> Result<(), String> {
        let mut src = std::fs::File::open(path)
            .map_err(|e| format!("abrir temp {}: {}", path.display(), e))?;
        match self {
            DumpSink::Sql(f) => {
                std::io::copy(&mut src, f).map_err(|e| e.to_string())?;
            }
            DumpSink::Zip { zip, .. } => {
                std::io::copy(&mut src, zip).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn end_file(&mut self) -> Result<(), String> {
        match self {
            DumpSink::Sql(_) => Ok(()),
            DumpSink::Zip { entry_open, .. } => {
                *entry_open = false;
                Ok(())
            }
        }
    }

    fn finish(self) -> Result<(), String> {
        match self {
            DumpSink::Sql(f) => {
                drop(f);
                Ok(())
            }
            DumpSink::Zip { zip, .. } => {
                zip.finish().map_err(|e| format!("zip finish: {}", e))?;
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------- driver

/// One table's on-disk artifacts, produced in phase A and assembled in
/// phase B (in ascending `idx` order, so output is deterministic).
struct TableArtifact {
    idx: usize,
    schema: String,
    table: String,
    rows: u64,
    error: Option<String>,
    /// Temp file with the raw CREATE statement (no section header / DROP —
    /// the merge adds those). `None` when content is data-only or DDL failed.
    ddl_path: Option<PathBuf>,
    /// Data shard temp files in PK-ascending order. Empty when no data.
    data_paths: Vec<PathBuf>,
}

pub async fn run_dump(
    app: AppHandle,
    opts: DumpOptions,
    source: Arc<dyn Driver>,
    conn_label: String,
    control: Arc<TransferControl>,
) -> Result<DumpDone, String> {
    let started = Instant::now();
    let source_is_pg = source.dialect() == "postgres";

    // Resolve the full ordered (idx, schema, table) work list. Schema-level
    // dumps (empty `tables`) expand here so the parallel path can fan out.
    let mut work: Vec<(usize, String, String)> = Vec::new();
    for scope in &opts.scopes {
        let selected: Vec<String> = if scope.tables.is_empty() {
            source
                .list_tables(&scope.schema)
                .await
                .map_err(|e| format!("list_tables {}: {}", scope.schema, e))?
                .into_iter()
                .map(|t| t.name)
                .collect()
        } else {
            scope.tables.clone()
        };
        for t in selected {
            work.push((work.len(), scope.schema.clone(), t));
        }
    }

    // Serial mode (1 table at a time, no intra sharding) streams straight to
    // the output: no temp files, no extra disk. Parallel mode stages tables in
    // temp files and merges them, deleting each temp as it is consumed so peak
    // temp usage tracks the in-flight set, not the whole dump.
    let serial = opts.concurrency.max(1) == 1 && opts.intra_table_workers.max(1) <= 1;
    let (total_rows, tables_done, failed) = if serial {
        run_serial_dump(&app, &opts, &conn_label, source_is_pg, &*source, &work, &control).await?
    } else {
        run_parallel_dump(
            &app, opts.clone(), &conn_label, source_is_pg, source.clone(), &work, &control,
        )
        .await?
    };

    let done = DumpDone {
        total_rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        tables_done,
        failed,
    };
    let _ = app.emit("sql_dump:done", &done);
    Ok(done)
}

/// Creates a unique scratch dir beside the output file.
fn make_temp_dir(output_path: &str) -> Result<PathBuf, String> {
    let parent = Path::new(output_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);
    let dir = parent.join(format!(".bmdump-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar temp dir: {}", e))?;
    Ok(dir)
}

// -------------------------------------------------- shared sink scaffolding

fn open_sink_with_preamble(
    opts: &DumpOptions,
    conn_label: &str,
    source_is_pg: bool,
) -> Result<DumpSink, String> {
    let mut sink = DumpSink::open(opts)?;
    let preamble = build_preamble(opts, conn_label, source_is_pg);
    if matches!(opts.format, DumpFormat::Sql) {
        sink.begin_file("dump.sql")?;
        sink.write(preamble.as_bytes())?;
    } else {
        sink.begin_file("00_header.sql")?;
        sink.write(preamble.as_bytes())?;
        sink.end_file()?;
    }
    Ok(sink)
}

fn write_footer_and_finish(
    mut sink: DumpSink,
    opts: &DumpOptions,
    source_is_pg: bool,
) -> Result<(), String> {
    // Footer — restores checks on import.
    let footer: &[u8] = if source_is_pg {
        b"\n"
    } else {
        b"\nSET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n"
    };
    if matches!(opts.format, DumpFormat::Sql) {
        sink.write(footer)?;
    } else {
        sink.begin_file("zz_footer.sql")?;
        sink.write(footer)?;
        sink.end_file()?;
    }
    sink.finish()
}

fn write_create_schema(
    sink: &mut DumpSink,
    opts: &DumpOptions,
    source: &dyn Driver,
    source_is_pg: bool,
    schema: &str,
) -> Result<(), String> {
    let qi = |s: &str| source.quote_ident(s);
    // MySQL uses DATABASE + USE; PG uses SCHEMA + search_path.
    let sql = if source_is_pg {
        format!(
            "CREATE SCHEMA IF NOT EXISTS {};\nSET search_path TO {};\n\n",
            qi(schema),
            qi(schema),
        )
    } else {
        format!(
            "CREATE DATABASE IF NOT EXISTS {};\nUSE {};\n\n",
            qi(schema),
            qi(schema),
        )
    };
    if matches!(opts.format, DumpFormat::Sql) {
        sink.write(sql.as_bytes())
    } else {
        sink.begin_file(&format!("{}/00_schema.sql", schema))?;
        sink.write(sql.as_bytes())?;
        sink.end_file()
    }
}

/// Section header + optional `DROP TABLE` before the CREATE body.
fn write_structure_header(
    sink: &mut DumpSink,
    opts: &DumpOptions,
    source: &dyn Driver,
    source_is_pg: bool,
    table: &str,
) -> Result<(), String> {
    sink.write(section_header("Table structure for", table).as_bytes())?;
    if opts.drop_before_create {
        // PG: CASCADE drops blocking FKs. MySQL relies on FOREIGN_KEY_CHECKS=0
        // from the preamble.
        let cascade = if source_is_pg { " CASCADE" } else { "" };
        sink.write(
            format!("DROP TABLE IF EXISTS {}{};\n", source.quote_ident(table), cascade)
                .as_bytes(),
        )?;
    }
    Ok(())
}

// -------------------------------------------------- serial (no temp files)

/// Streams every table straight into the output, in order, one at a time.
/// No temp files, so the dump uses no disk beyond the output itself.
#[allow(clippy::too_many_arguments)]
async fn run_serial_dump(
    app: &AppHandle,
    opts: &DumpOptions,
    conn_label: &str,
    source_is_pg: bool,
    source: &dyn Driver,
    work: &[(usize, String, String)],
    control: &Arc<TransferControl>,
) -> Result<(u64, u32, u32), String> {
    let mut sink = open_sink_with_preamble(opts, conn_label, source_is_pg)?;
    let mut last_schema: Option<String> = None;
    let (mut total_rows, mut tables_done, mut failed) = (0u64, 0u32, 0u32);

    for (_idx, schema, table) in work {
        if !control.check().await {
            break;
        }
        if opts.create_schema && last_schema.as_deref() != Some(schema.as_str()) {
            write_create_schema(&mut sink, opts, source, source_is_pg, schema)?;
        }
        last_schema = Some(schema.clone());

        if matches!(opts.format, DumpFormat::Zip) {
            sink.begin_file(&format!("{}/{}.sql", schema, table))?;
        }
        let t_start = Instant::now();
        let res =
            dump_table_direct(app, opts, source, schema, table, &mut sink, source_is_pg, control)
                .await;
        if matches!(opts.format, DumpFormat::Zip) {
            sink.end_file()?;
        }
        let (rows, error) = match res {
            Ok(r) => (r, None),
            Err(e) => (0, Some(e)),
        };
        if error.is_some() {
            failed += 1;
        }
        let _ = app.emit(
            "sql_dump:table_done",
            &DumpTableDone {
                schema: schema.clone(),
                table: table.clone(),
                rows,
                elapsed_ms: t_start.elapsed().as_millis() as u64,
                error,
            },
        );
        total_rows += rows;
        tables_done += 1;
    }

    write_footer_and_finish(sink, opts, source_is_pg)?;
    Ok((total_rows, tables_done, failed))
}

/// Serial per-table writer: structure (live DDL) + data (live query loop)
/// straight into the sink.
#[allow(clippy::too_many_arguments)]
async fn dump_table_direct(
    app: &AppHandle,
    opts: &DumpOptions,
    source: &dyn Driver,
    schema: &str,
    table: &str,
    sink: &mut DumpSink,
    source_is_pg: bool,
    control: &Arc<TransferControl>,
) -> Result<u64, String> {
    if matches!(opts.content, DumpContent::Structure | DumpContent::Both) {
        let ddl = source
            .get_table_ddl(schema, table)
            .await
            .map_err(|e| format!("ddl {}.{}: {}", schema, table, e))?;
        write_structure_header(sink, opts, source, source_is_pg, table)?;
        sink.write(format!("{};\n\n", ddl.trim().trim_end_matches(';')).as_bytes())?;
    }

    if !matches!(opts.content, DumpContent::Data | DumpContent::Both) {
        return Ok(0);
    }
    let total = source
        .count_table_rows(schema, table, None)
        .await
        .map_err(|e| format!("count {}.{}: {}", schema, table, e))?;
    if total == 0 {
        return Ok(0);
    }
    let generated_cols: HashSet<String> = source
        .list_generated_columns(schema, table)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let keyset_col = crate::data_transfer::find_keyset_column(source, schema, table).await;

    sink.write(section_header("Records of", table).as_bytes())?;
    let started = Instant::now();
    write_table_data(
        sink.writer(),
        app,
        opts,
        source,
        schema,
        table,
        keyset_col.as_deref(),
        total,
        started,
        source_is_pg,
        &generated_cols,
        control,
    )
    .await
}

// -------------------------------------------------- parallel (temp + merge)

/// Parallel path: a table-level worker pool stages each table into temp files
/// while a streaming merger consumes completed tables in idx order, deleting
/// each temp as it is written so peak temp disk tracks the in-flight set.
#[allow(clippy::too_many_arguments)]
async fn run_parallel_dump(
    app: &AppHandle,
    opts: DumpOptions,
    conn_label: &str,
    source_is_pg: bool,
    source: Arc<dyn Driver>,
    work: &[(usize, String, String)],
    control: &Arc<TransferControl>,
) -> Result<(u64, u32, u32), String> {
    let tmp_dir = make_temp_dir(&opts.path)?;
    let concurrency = opts.concurrency.clamp(1, 8) as usize;

    let (work_tx, work_rx) = async_channel::unbounded::<(usize, String, String)>();
    for w in work {
        let _ = work_tx.send(w.clone()).await;
    }
    drop(work_tx); // workers exit when the queue drains.

    let (art_tx, mut art_rx) = tokio::sync::mpsc::unbounded_channel::<TableArtifact>();
    let opts_arc = Arc::new(opts.clone());
    let mut handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let work_rx = work_rx.clone();
        let art_tx = art_tx.clone();
        let app = app.clone();
        let opts = opts_arc.clone();
        let source = source.clone();
        let tmp_dir = tmp_dir.clone();
        let control = control.clone();
        handles.push(tokio::spawn(async move {
            while let Ok((idx, schema, table)) = work_rx.recv().await {
                if !control.check().await {
                    work_rx.close();
                    break;
                }
                let t_start = Instant::now();
                let artifact = dump_table_to_temp(
                    &app, &opts, &source, idx, &schema, &table, &tmp_dir, source_is_pg, &control,
                )
                .await;
                let _ = app.emit(
                    "sql_dump:table_done",
                    &DumpTableDone {
                        schema: schema.clone(),
                        table: table.clone(),
                        rows: artifact.rows,
                        elapsed_ms: t_start.elapsed().as_millis() as u64,
                        error: artifact.error.clone(),
                    },
                );
                if art_tx.send(artifact).is_err() {
                    break; // merger gone (it errored) : stop producing.
                }
            }
        }));
    }
    drop(art_tx); // only worker clones remain : rx closes when all finish.

    // Streaming merge runs concurrently with production.
    let merge_res = merge_stream(&opts, conn_label, source_is_pg, &*source, &mut art_rx).await;

    for h in handles {
        let _ = h.await;
    }
    let _ = std::fs::remove_dir_all(&tmp_dir);
    merge_res
}

/// Consumes table artifacts in ascending idx order (reorder buffer), writing
/// each to the sink and deleting its temp files immediately after.
async fn merge_stream(
    opts: &DumpOptions,
    conn_label: &str,
    source_is_pg: bool,
    source: &dyn Driver,
    art_rx: &mut tokio::sync::mpsc::UnboundedReceiver<TableArtifact>,
) -> Result<(u64, u32, u32), String> {
    let mut sink = open_sink_with_preamble(opts, conn_label, source_is_pg)?;
    let mut buffer: std::collections::BTreeMap<usize, TableArtifact> =
        std::collections::BTreeMap::new();
    let mut next = 0usize;
    let mut last_schema: Option<String> = None;
    let (mut total_rows, mut tables_done, mut failed) = (0u64, 0u32, 0u32);

    while let Some(art) = art_rx.recv().await {
        buffer.insert(art.idx, art);
        // Drain every contiguous artifact from `next` upward.
        while let Some(a) = buffer.remove(&next) {
            total_rows += a.rows;
            tables_done += 1;
            if a.error.is_some() {
                failed += 1;
            }
            merge_table(&mut sink, opts, source, source_is_pg, &mut last_schema, &a)?;
            next += 1;
        }
    }
    // Drain any leftovers (idx gaps from cancelled tables) in sorted order.
    for (_idx, a) in std::mem::take(&mut buffer) {
        total_rows += a.rows;
        tables_done += 1;
        if a.error.is_some() {
            failed += 1;
        }
        merge_table(&mut sink, opts, source, source_is_pg, &mut last_schema, &a)?;
    }

    write_footer_and_finish(sink, opts, source_is_pg)?;
    Ok((total_rows, tables_done, failed))
}

/// Writes one staged table to the sink and deletes its temp files as they are
/// consumed (incremental disk release for both `.sql` and `.zip`).
fn merge_table(
    sink: &mut DumpSink,
    opts: &DumpOptions,
    source: &dyn Driver,
    source_is_pg: bool,
    last_schema: &mut Option<String>,
    a: &TableArtifact,
) -> Result<(), String> {
    if opts.create_schema && last_schema.as_deref() != Some(a.schema.as_str()) {
        write_create_schema(sink, opts, source, source_is_pg, &a.schema)?;
    }
    *last_schema = Some(a.schema.clone());

    if matches!(opts.format, DumpFormat::Zip) {
        sink.begin_file(&format!("{}/{}.sql", a.schema, a.table))?;
    }
    if let Some(ddl_path) = &a.ddl_path {
        write_structure_header(sink, opts, source, source_is_pg, &a.table)?;
        // The DDL temp file already ends with `;\n\n`.
        sink.write_from_file(ddl_path)?;
        let _ = std::fs::remove_file(ddl_path);
    }
    if !a.data_paths.is_empty() {
        sink.write(section_header("Records of", &a.table).as_bytes())?;
        for p in &a.data_paths {
            sink.write_from_file(p)?;
            let _ = std::fs::remove_file(p);
        }
    }
    if matches!(opts.format, DumpFormat::Zip) {
        sink.end_file()?;
    }
    Ok(())
}

fn build_preamble(
    opts: &DumpOptions,
    conn_label: &str,
    source_is_pg: bool,
) -> String {
    let now = chrono::Utc::now().format("%d/%m/%Y %H:%M:%S");
    let content = match opts.content {
        DumpContent::Structure => "Only structure",
        DumpContent::Data => "Only data",
        DumpContent::Both => "Structure + data",
    };
    let schemas = opts
        .scopes
        .iter()
        .map(|s| s.schema.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let server_type = if source_is_pg { "PostgreSQL" } else { "MySQL" };
    // Session flags only make sense on MySQL.
    let session_flags = if source_is_pg {
        ""
    } else {
        "SET NAMES utf8mb4;\n\
         SET FOREIGN_KEY_CHECKS = 0;\n\
         SET UNIQUE_CHECKS = 0;\n\
         SET SQL_MODE = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO');\n\n"
    };
    format!(
        "/*\n\
         BaseMaster SQL Dump\n\n\
         Source Server         : {conn}\n\
         Source Server Type    : {srv}\n\
         Source Schema(s)      : {schemas}\n\n\
         Target Server Type    : {srv}\n\
         File Encoding         : utf8mb4\n\
         Content               : {content}\n\n\
         Date: {now}\n\
         */\n\n\
         {session_flags}",
        conn = conn_label,
        srv = server_type,
    )
}

fn section_header(kind: &str, table: &str) -> String {
    format!(
        "-- ----------------------------\n-- {} of `{}`\n-- ----------------------------\n",
        kind, table
    )
}

/// Phase-A worker for one table: writes the DDL temp file (if structure is
/// requested) and the data shard temp file(s), splitting big integer-PK
/// tables across `intra_table_workers` parallel PK ranges.
#[allow(clippy::too_many_arguments)]
async fn dump_table_to_temp(
    app: &AppHandle,
    opts: &DumpOptions,
    source: &Arc<dyn Driver>,
    idx: usize,
    schema: &str,
    table: &str,
    tmp_dir: &Path,
    pg_mode: bool,
    control: &Arc<TransferControl>,
) -> TableArtifact {
    let mut artifact = TableArtifact {
        idx,
        schema: schema.to_string(),
        table: table.to_string(),
        rows: 0,
        error: None,
        ddl_path: None,
        data_paths: Vec::new(),
    };

    // 1. Structure (DDL) → temp file. Raw CREATE only; the merge adds the
    // section header + DROP. MySQL uses SHOW CREATE, PG reconstructs.
    if matches!(opts.content, DumpContent::Structure | DumpContent::Both) {
        match source.get_table_ddl(schema, table).await {
            Ok(ddl) => {
                let path = tmp_dir.join(format!("{:05}.ddl", idx));
                // Normalize: driver may or may not terminate with `;`.
                let body = format!("{};\n\n", ddl.trim().trim_end_matches(';'));
                if let Err(e) = std::fs::write(&path, body.as_bytes()) {
                    artifact.error = Some(format!("ddl write {}.{}: {}", schema, table, e));
                    return artifact;
                }
                artifact.ddl_path = Some(path);
            }
            Err(e) => {
                artifact.error = Some(format!("ddl {}.{}: {}", schema, table, e));
                return artifact;
            }
        }
    }

    // 2. Data.
    if !matches!(opts.content, DumpContent::Data | DumpContent::Both) {
        return artifact;
    }
    let total = match source.count_table_rows(schema, table, None).await {
        Ok(n) => n,
        Err(e) => {
            artifact.error = Some(format!("count {}.{}: {}", schema, table, e));
            return artifact;
        }
    };
    if total == 0 {
        return artifact;
    }

    // Generated columns (STORED/VIRTUAL) are excluded from the data — re-
    // importing a value into one fails. The DDL keeps their definition.
    let generated_cols: HashSet<String> = source
        .list_generated_columns(schema, table)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let generated_cols = Arc::new(generated_cols);

    // Decide intra-table sharding: needs a single integer PK + size threshold.
    let intra_workers = opts.intra_table_workers.clamp(1, 8) as usize;
    let keyset_col = crate::data_transfer::find_keyset_column(&**source, schema, table).await;
    let keyset_is_integer = match keyset_col.as_deref() {
        Some(c) => {
            crate::data_transfer::keyset_column_is_integer(&**source, schema, table, c).await
        }
        None => false,
    };
    let use_intra =
        intra_workers > 1 && keyset_is_integer && total >= opts.intra_table_min_rows.max(1);

    if opts.intra_table_workers > 1 && !use_intra {
        let msg = if !keyset_is_integer {
            format!(
                "Intra-table paralelo desativado pra '{}': sem PK inteira de coluna única",
                table
            )
        } else {
            format!(
                "Intra-table paralelo desativado pra '{}': {} linhas (mínimo {})",
                table, total, opts.intra_table_min_rows
            )
        };
        let _ = app.emit(
            "sql_dump:table_note",
            &DumpTableNote {
                schema: schema.to_string(),
                table: table.to_string(),
                message: msg,
                level: "warn".to_string(),
            },
        );
    }

    let started = Instant::now();
    let counter = Arc::new(AtomicU64::new(0));

    if use_intra {
        let col = keyset_col.clone().unwrap();
        let bounds = pk_bounds(&**source, schema, table, &col).await;
        if let Some((min_i, max_i)) = bounds {
            if min_i < max_i {
                let _ = app.emit(
                    "sql_dump:table_note",
                    &DumpTableNote {
                        schema: schema.to_string(),
                        table: table.to_string(),
                        message: format!(
                            "Intra-table paralelo ativo: {} shards sobre {} linhas (PK: {})",
                            intra_workers, total, col
                        ),
                        level: "info".to_string(),
                    },
                );
                let ranges =
                    crate::data_transfer::split_pk_ranges(min_i, max_i, intra_workers);
                let mut handles: Vec<(PathBuf, tokio::task::JoinHandle<Result<u64, String>>)> =
                    Vec::with_capacity(ranges.len());
                for (wid, (low, high)) in ranges.into_iter().enumerate() {
                    let path = tmp_dir.join(format!("{:05}.{:03}.data", idx, wid));
                    let app = app.clone();
                    let opts = opts.clone();
                    let source = source.clone();
                    let schema = schema.to_string();
                    let table = table.to_string();
                    let col = col.clone();
                    let generated = generated_cols.clone();
                    let counter = counter.clone();
                    let control = control.clone();
                    let path_c = path.clone();
                    handles.push((
                        path,
                        tokio::spawn(async move {
                            dump_pk_range_to_temp(
                                &app, &opts, &*source, &schema, &table, wid as u32, &col,
                                low, high, total, &path_c, started, pg_mode, &counter,
                                &generated, &control,
                            )
                            .await
                        }),
                    ));
                }
                let mut rows_sum = 0u64;
                let mut first_err: Option<String> = None;
                let mut paths = Vec::new();
                for (path, h) in handles {
                    match h.await {
                        Ok(Ok(n)) => {
                            rows_sum += n;
                            paths.push(path);
                        }
                        Ok(Err(e)) => {
                            if first_err.is_none() {
                                first_err = Some(e);
                            }
                        }
                        Err(e) => {
                            if first_err.is_none() {
                                first_err = Some(format!("shard join {}.{}: {}", schema, table, e));
                            }
                        }
                    }
                }
                artifact.rows = rows_sum;
                artifact.data_paths = paths;
                artifact.error = first_err;
                return artifact;
            }
        }
        // Bounds missing or single-valued : fall through to single shard.
    }

    // Single-shard path : one data temp file. Keyset pagination when the table
    // has an orderable single PK, OFFSET fallback otherwise.
    let path = tmp_dir.join(format!("{:05}.000.data", idx));
    match dump_single_shard_to_temp(
        app,
        opts,
        &**source,
        schema,
        table,
        keyset_col.as_deref(),
        &path,
        total,
        started,
        pg_mode,
        &generated_cols,
        control,
    )
    .await
    {
        Ok(n) => {
            artifact.rows = n;
            if n > 0 {
                artifact.data_paths.push(path);
            }
        }
        Err(e) => artifact.error = Some(e),
    }
    artifact
}

/// MIN/MAX of the PK column as an i128 pair, for range splitting.
async fn pk_bounds(
    source: &dyn Driver,
    schema: &str,
    table: &str,
    col: &str,
) -> Option<(i128, i128)> {
    let sql = format!(
        "SELECT MIN({c}), MAX({c}) FROM {s}.{t}",
        c = source.quote_ident(col),
        s = source.quote_ident(schema),
        t = source.quote_ident(table),
    );
    let mm = source.query(Some(schema), &sql).await.ok()?;
    let r = mm.rows.first()?;
    Some((
        crate::data_transfer::value_to_i128(r.first()?)?,
        crate::data_transfer::value_to_i128(r.get(1)?)?,
    ))
}

/// Builds the INSERT prefix + bytes for one batch and appends them to `buf`,
/// flushing to `out` whenever the statement would exceed `max_bytes`.
/// Shared by the single-shard and PK-range writers.
#[allow(clippy::too_many_arguments)]
fn write_batch(
    out: &mut (dyn Write + Send),
    opts: &DumpOptions,
    source: &dyn Driver,
    schema: &str,
    table: &str,
    batch: &QueryResult,
    generated_cols: &HashSet<String>,
    pg_mode: bool,
    max_bytes: usize,
) -> Result<(), String> {
    let qi = |s: &str| source.quote_ident(s);
    // `keep[i] = false` → column i is generated; drop it from the column list
    // and from every row's VALUES.
    let keep: Vec<bool> = batch
        .columns
        .iter()
        .map(|c| !generated_cols.contains(c))
        .collect();
    let cols: Vec<String> = batch
        .columns
        .iter()
        .zip(keep.iter())
        .filter(|(_, &k)| k)
        .map(|(c, _)| qi(c))
        .collect();
    // Generated columns force the column list even when complete_inserts is
    // off: a bare VALUES misaligns once a generated value is dropped.
    let emit_col_list = opts.complete_inserts || !generated_cols.is_empty();
    let prefix = if emit_col_list {
        format!("INSERT INTO {}.{} ({}) VALUES\n", qi(schema), qi(table), cols.join(", "))
    } else {
        format!("INSERT INTO {}.{} VALUES\n", qi(schema), qi(table))
    };

    if opts.extended_inserts {
        let mut sql = String::with_capacity(max_bytes.min(4 * 1024 * 1024));
        sql.push_str(&prefix);
        let mut rows_in_buf = 0u64;
        for row in &batch.rows {
            let parts: Vec<String> = row
                .iter()
                .zip(keep.iter())
                .filter(|(_, &k)| k)
                .map(|(v, _)| sql_literal_opts_dialect(v, opts.hex_blob, pg_mode))
                .collect();
            let row_sql = format!("  ({})", parts.join(", "));
            if rows_in_buf > 0 && sql.len() + 2 + row_sql.len() > max_bytes {
                sql.push_str(";\n\n");
                out.write_all(sql.as_bytes()).map_err(|e| e.to_string())?;
                sql.clear();
                sql.push_str(&prefix);
                rows_in_buf = 0;
            }
            if rows_in_buf > 0 {
                sql.push_str(",\n");
            }
            sql.push_str(&row_sql);
            rows_in_buf += 1;
        }
        if rows_in_buf > 0 {
            sql.push_str(";\n\n");
            out.write_all(sql.as_bytes()).map_err(|e| e.to_string())?;
        }
    } else {
        for row in &batch.rows {
            let parts: Vec<String> = row
                .iter()
                .zip(keep.iter())
                .filter(|(_, &k)| k)
                .map(|(v, _)| sql_literal_opts_dialect(v, opts.hex_blob, pg_mode))
                .collect();
            let sql = format!("{}  ({});\n", prefix, parts.join(", "));
            out.write_all(sql.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Single-shard data writer. Keyset pagination (`WHERE col > last`) when a
/// keyset column is available; OFFSET fallback otherwise.
#[allow(clippy::too_many_arguments)]
async fn dump_single_shard_to_temp(
    app: &AppHandle,
    opts: &DumpOptions,
    source: &dyn Driver,
    schema: &str,
    table: &str,
    keyset_col: Option<&str>,
    path: &Path,
    total: u64,
    started: Instant,
    pg_mode: bool,
    generated_cols: &HashSet<String>,
    control: &Arc<TransferControl>,
) -> Result<u64, String> {
    let mut out = std::fs::File::create(path)
        .map_err(|e| format!("criar shard {}: {}", path.display(), e))?;
    write_table_data(
        &mut out, app, opts, source, schema, table, keyset_col, total, started, pg_mode,
        generated_cols, control,
    )
    .await
}

/// Writes a table's full data (single, unbounded shard) to `out`. Keyset
/// pagination (`WHERE col > last`) when a keyset column is available, OFFSET
/// fallback otherwise. Shared by the temp-file single shard and the serial
/// direct-to-sink path.
#[allow(clippy::too_many_arguments)]
async fn write_table_data(
    out: &mut (dyn Write + Send),
    app: &AppHandle,
    opts: &DumpOptions,
    source: &dyn Driver,
    schema: &str,
    table: &str,
    keyset_col: Option<&str>,
    total: u64,
    started: Instant,
    pg_mode: bool,
    generated_cols: &HashSet<String>,
    control: &Arc<TransferControl>,
) -> Result<u64, String> {
    let qi = |s: &str| source.quote_ident(s);
    let chunk = opts.chunk_size.max(1);
    let max_bytes = (opts.max_statement_size_kb as usize)
        .saturating_mul(1024)
        .max(1024);

    let mut transferred: u64 = 0;
    let mut offset: u64 = 0;
    let mut last_key: Option<basemaster_core::Value> = None;
    loop {
        if !control.check().await {
            break;
        }
        let select_sql = match keyset_col {
            Some(col) => match &last_key {
                Some(key) => format!(
                    "SELECT * FROM {}.{} WHERE {} > {} ORDER BY {} LIMIT {}",
                    qi(schema),
                    qi(table),
                    qi(col),
                    sql_literal_opts(key, true),
                    qi(col),
                    chunk
                ),
                None => format!(
                    "SELECT * FROM {}.{} ORDER BY {} LIMIT {}",
                    qi(schema),
                    qi(table),
                    qi(col),
                    chunk
                ),
            },
            None => format!(
                "SELECT * FROM {}.{} LIMIT {} OFFSET {}",
                qi(schema),
                qi(table),
                chunk,
                offset
            ),
        };
        let batch = source
            .query(Some(schema), &select_sql)
            .await
            .map_err(|e| format!("select {}.{}: {}", schema, table, e))?;
        if batch.rows.is_empty() {
            break;
        }

        write_batch(out, opts, source, schema, table, &batch, generated_cols, pg_mode, max_bytes)?;

        let n = batch.rows.len() as u64;
        transferred += n;
        offset += n;
        if let Some(col) = keyset_col {
            if let Some(idx) = batch.columns.iter().position(|c| c == col) {
                if let Some(v) = batch.rows.last().and_then(|r| r.get(idx)) {
                    last_key = Some(v.clone());
                }
            }
        }
        let _ = app.emit(
            "sql_dump:progress",
            &DumpTableProgress {
                schema: schema.to_string(),
                table: table.to_string(),
                done: transferred,
                total,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );
        if n < chunk {
            break;
        }
    }
    Ok(transferred)
}

/// One PK-range shard: bounded keyset pagination `WHERE col >= low AND col <
/// high`, writing to its own temp file. Emits per-worker progress (drill-down)
/// and feeds the shared per-table counter for the aggregate `sql_dump:progress`.
#[allow(clippy::too_many_arguments)]
async fn dump_pk_range_to_temp(
    app: &AppHandle,
    opts: &DumpOptions,
    source: &dyn Driver,
    schema: &str,
    table: &str,
    worker_id: u32,
    keyset_col: &str,
    low: i128,
    high: i128,
    total: u64,
    path: &Path,
    started: Instant,
    pg_mode: bool,
    counter: &AtomicU64,
    generated_cols: &HashSet<String>,
    control: &Arc<TransferControl>,
) -> Result<u64, String> {
    let qi = |s: &str| source.quote_ident(s);
    let chunk = opts.chunk_size.max(1);
    let max_bytes = (opts.max_statement_size_kb as usize)
        .saturating_mul(1024)
        .max(1024);
    let mut out = std::fs::File::create(path)
        .map_err(|e| format!("criar shard {}: {}", path.display(), e))?;

    // Initial emit : the front paints the worker slot immediately.
    let _ = app.emit(
        "sql_dump:worker_progress",
        &DumpWorkerProgress {
            schema: schema.to_string(),
            table: table.to_string(),
            worker_id,
            low_pk: low.to_string(),
            high_pk: high.to_string(),
            done: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            finished: false,
            error: None,
        },
    );

    let mut transferred: u64 = 0;
    let mut last_key: Option<basemaster_core::Value> = None;
    let run = async {
        loop {
            if !control.check().await {
                break Ok(());
            }
            let select_sql = match &last_key {
                Some(key) => format!(
                    "SELECT * FROM {}.{} WHERE {} > {} AND {} < {} ORDER BY {} LIMIT {}",
                    qi(schema),
                    qi(table),
                    qi(keyset_col),
                    sql_literal_opts(key, true),
                    qi(keyset_col),
                    high,
                    qi(keyset_col),
                    chunk
                ),
                None => format!(
                    "SELECT * FROM {}.{} WHERE {} >= {} AND {} < {} ORDER BY {} LIMIT {}",
                    qi(schema),
                    qi(table),
                    qi(keyset_col),
                    low,
                    qi(keyset_col),
                    high,
                    qi(keyset_col),
                    chunk
                ),
            };
            let batch = source
                .query(Some(schema), &select_sql)
                .await
                .map_err(|e| format!("select {}.{} [{}..{}): {}", schema, table, low, high, e))?;
            if batch.rows.is_empty() {
                break Ok(());
            }

            write_batch(
                &mut out, opts, source, schema, table, &batch, generated_cols, pg_mode, max_bytes,
            )?;

            let n = batch.rows.len() as u64;
            transferred += n;
            if let Some(idx) = batch.columns.iter().position(|c| c == keyset_col) {
                if let Some(v) = batch.rows.last().and_then(|r| r.get(idx)) {
                    last_key = Some(v.clone());
                }
            }

            // Aggregate per-table progress + per-worker drill-down.
            let global = counter.fetch_add(n, Ordering::Relaxed) + n;
            let _ = app.emit(
                "sql_dump:progress",
                &DumpTableProgress {
                    schema: schema.to_string(),
                    table: table.to_string(),
                    done: global,
                    total,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                },
            );
            let _ = app.emit(
                "sql_dump:worker_progress",
                &DumpWorkerProgress {
                    schema: schema.to_string(),
                    table: table.to_string(),
                    worker_id,
                    low_pk: low.to_string(),
                    high_pk: high.to_string(),
                    done: transferred,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    finished: false,
                    error: None,
                },
            );

            if n < chunk {
                break Ok(());
            }
        }
    };

    let res: Result<(), String> = run.await;
    let _ = app.emit(
        "sql_dump:worker_progress",
        &DumpWorkerProgress {
            schema: schema.to_string(),
            table: table.to_string(),
            worker_id,
            low_pk: low.to_string(),
            high_pk: high.to_string(),
            done: transferred,
            elapsed_ms: started.elapsed().as_millis() as u64,
            finished: true,
            error: res.as_ref().err().cloned(),
        },
    );
    res.map(|_| transferred)
}
