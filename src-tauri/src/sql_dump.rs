//! SQL Dump V1 — exports schema(s) or a single table to `.sql` or `.zip`.
//!
//! Reuses `data_transfer`'s INSERT-formatting functions
//! (`sql_literal_opts`, extended inserts). Writes directly to the file
//! (or ZIP entry) in chunks — bounded memory.
//!
//! Events:
//!   `sql_dump:progress` — { schema, table, done, total, elapsed_ms }
//!   `sql_dump:table_done` — { schema, table, rows, elapsed_ms, error }
//!   `sql_dump:done` — { total_rows, elapsed_ms, tables_done, failed }

use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

use basemaster_core::Driver;
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
}

fn default_true() -> bool { true }
fn default_chunk() -> u64 { 1000 }
fn default_max_stmt_kb() -> u64 { 1024 }

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

pub async fn run_dump(
    app: AppHandle,
    opts: DumpOptions,
    source: Arc<dyn Driver>,
    conn_label: String,
    control: Arc<TransferControl>,
) -> Result<DumpDone, String> {
    let started = Instant::now();
    let qi = |s: &str| source.quote_ident(s);
    let source_is_pg = source.dialect() == "postgres";

    let mut sink = DumpSink::open(&opts)?;

    // Overall header (single SQL) — disclaimer + session flags for the import.
    let preamble = build_preamble(&opts, &conn_label, source_is_pg);
    if matches!(opts.format, DumpFormat::Sql) {
        sink.begin_file("dump.sql")?;
        sink.write(preamble.as_bytes())?;
    } else {
        // A `00_header.sql` file in the ZIP with the preamble.
        sink.begin_file("00_header.sql")?;
        sink.write(preamble.as_bytes())?;
        sink.end_file()?;
    }

    let mut totals_rows: u64 = 0;
    let mut tables_done: u32 = 0;
    let mut failed: u32 = 0;

    for scope in &opts.scopes {
        if !control.check().await {
            break;
        }

        // Resolve the effective list of tables.
        let tables_all = source
            .list_tables(&scope.schema)
            .await
            .map_err(|e| format!("list_tables {}: {}", scope.schema, e))?;
        let selected: Vec<_> = if scope.tables.is_empty() {
            tables_all.iter().map(|t| t.name.clone()).collect()
        } else {
            scope.tables.clone()
        };

        // CREATE DATABASE/SCHEMA (optional). MySQL uses DATABASE + USE,
        // PG uses SCHEMA + search_path.
        if opts.create_schema {
            let sql = if source_is_pg {
                format!(
                    "CREATE SCHEMA IF NOT EXISTS {};\nSET search_path TO {};\n\n",
                    qi(&scope.schema),
                    qi(&scope.schema),
                )
            } else {
                format!(
                    "CREATE DATABASE IF NOT EXISTS {};\nUSE {};\n\n",
                    qi(&scope.schema),
                    qi(&scope.schema),
                )
            };
            if matches!(opts.format, DumpFormat::Sql) {
                sink.write(sql.as_bytes())?;
            } else {
                sink.begin_file(&format!("{}/00_schema.sql", scope.schema))?;
                sink.write(sql.as_bytes())?;
                sink.end_file()?;
            }
        }

        for table in &selected {
            if !control.check().await {
                break;
            }
            let t_start = Instant::now();
            let entry_name = format!("{}/{}.sql", scope.schema, table);
            if matches!(opts.format, DumpFormat::Zip) {
                sink.begin_file(&entry_name)?;
            }
            let res = dump_one_table(
                &app,
                &opts,
                &*source,
                &scope.schema,
                table,
                &mut sink,
                &control,
            )
            .await;
            if matches!(opts.format, DumpFormat::Zip) {
                sink.end_file()?;
            }
            let (rows, error) = match res {
                Ok(r) => (r, None),
                Err(e) => (0, Some(e)),
            };
            let elapsed = t_start.elapsed().as_millis() as u64;
            let _ = app.emit(
                "sql_dump:table_done",
                &DumpTableDone {
                    schema: scope.schema.clone(),
                    table: table.clone(),
                    rows,
                    elapsed_ms: elapsed,
                    error: error.clone(),
                },
            );
            totals_rows += rows;
            tables_done += 1;
            if error.is_some() {
                failed += 1;
            }
        }
    }

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

    // Finalize the file — ZIP closes the central directory, SQL just flushes.
    sink.finish()?;

    let done = DumpDone {
        total_rows: totals_rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        tables_done,
        failed,
    };
    let _ = app.emit("sql_dump:done", &done);
    Ok(done)
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

async fn dump_one_table(
    app: &AppHandle,
    opts: &DumpOptions,
    source: &dyn Driver,
    schema: &str,
    table: &str,
    sink: &mut DumpSink,
    control: &Arc<TransferControl>,
) -> Result<u64, String> {
    let qi = |s: &str| source.quote_ident(s);
    let pg_mode = source.dialect() == "postgres";

    // 1. Structure (DDL) — if content requests it.
    if matches!(opts.content, DumpContent::Structure | DumpContent::Both) {
        // `get_table_ddl` delegates to the driver — MySQL uses SHOW CREATE,
        // PG reconstructs via introspection.
        let ddl = source
            .get_table_ddl(schema, table)
            .await
            .map_err(|e| format!("ddl {}.{}: {}", schema, table, e))?;

        sink.write(section_header("Table structure for", table).as_bytes())?;
        if opts.drop_before_create {
            // PG: CASCADE removes FKs that would block the DROP. MySQL doesn't
            // accept CASCADE and uses FOREIGN_KEY_CHECKS=0 from the preamble.
            let cascade = if pg_mode { " CASCADE" } else { "" };
            sink.write(
                format!(
                    "DROP TABLE IF EXISTS {}{};\n",
                    qi(table),
                    cascade
                )
                .as_bytes(),
            )?;
        }
        // Normalize: the driver may or may not include `;` at the end. Trim + append.
        let trimmed = ddl.trim().trim_end_matches(';');
        sink.write(trimmed.as_bytes())?;
        sink.write(b";\n\n")?;
    }

    // 2. Data — if content requests it.
    if !matches!(opts.content, DumpContent::Data | DumpContent::Both) {
        return Ok(0);
    }

    // Count total for progress.
    let total = source
        .count_table_rows(schema, table)
        .await
        .map_err(|e| format!("count {}.{}: {}", schema, table, e))?;
    if total == 0 {
        return Ok(0);
    }

    sink.write(section_header("Records of", table).as_bytes())?;

    let chunk = opts.chunk_size.max(1);
    let max_bytes = (opts.max_statement_size_kb as usize)
        .saturating_mul(1024)
        .max(1024);
    let started = Instant::now();

    let mut offset: u64 = 0;
    let mut transferred: u64 = 0;
    loop {
        if !control.check().await {
            break;
        }
        let select_sql = format!(
            "SELECT * FROM {}.{} LIMIT {} OFFSET {}",
            qi(schema),
            qi(table),
            chunk,
            offset
        );
        let batch = source
            .query(Some(schema), &select_sql)
            .await
            .map_err(|e| format!("select {}.{}: {}", schema, table, e))?;
        if batch.rows.is_empty() {
            break;
        }

        let cols: Vec<String> = batch
            .columns
            .iter()
            .map(|c| source.quote_ident(c))
            .collect();
        let prefix = if opts.complete_inserts {
            format!(
                "INSERT INTO {}.{} ({}) VALUES\n",
                qi(schema),
                qi(table),
                cols.join(", ")
            )
        } else {
            format!("INSERT INTO {}.{} VALUES\n", qi(schema), qi(table))
        };

        if opts.extended_inserts {
            let mut buf = String::with_capacity(max_bytes.min(4 * 1024 * 1024));
            buf.push_str(&prefix);
            let mut rows_in_buf = 0u64;
            for row in &batch.rows {
                let parts: Vec<String> = row
                    .iter()
                    .map(|v| sql_literal_opts_dialect(v, opts.hex_blob, pg_mode))
                    .collect();
                let row_sql = format!("  ({})", parts.join(", "));
                if rows_in_buf > 0 && buf.len() + 2 + row_sql.len() > max_bytes {
                    buf.push_str(";\n\n");
                    sink.write(buf.as_bytes())?;
                    buf.clear();
                    buf.push_str(&prefix);
                    rows_in_buf = 0;
                }
                if rows_in_buf > 0 {
                    buf.push_str(",\n");
                }
                buf.push_str(&row_sql);
                rows_in_buf += 1;
            }
            if rows_in_buf > 0 {
                buf.push_str(";\n\n");
                sink.write(buf.as_bytes())?;
            }
        } else {
            for row in &batch.rows {
                let parts: Vec<String> = row
                    .iter()
                    .map(|v| sql_literal_opts_dialect(v, opts.hex_blob, pg_mode))
                    .collect();
                let sql = format!("{}  ({});\n", prefix, parts.join(", "));
                sink.write(sql.as_bytes())?;
            }
        }

        let n = batch.rows.len() as u64;
        transferred += n;
        offset += n;
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
