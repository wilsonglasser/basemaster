//! Tabular data export (CSV / JSON / XLSX) — runs entirely in the backend.
//!
//! Replaces the old front-side JS export, which built the whole file as a
//! string on the WebView main thread and shipped it back through the IPC
//! bridge as a JSON array of bytes. That froze the UI and overflowed the
//! WebView2 renderer on large tables. Here the backend queries the source
//! directly, streams rows straight to disk in bounded chunks, and only
//! emits small progress events.
//!
//! Pagination mirrors `sql_dump`/`data_transfer`: keyset (`WHERE pk > last
//! ORDER BY pk LIMIT n`) when the table has a single orderable PK, OFFSET
//! fallback otherwise. Keyset avoids the O(n²) re-scan the old OFFSET-only
//! loop suffered.
//!
//! Output shapes:
//!   - XLSX            → one workbook, one worksheet per table, at `path`.
//!   - CSV/JSON, 1 tbl → a single file at `path`.
//!   - CSV/JSON, N tbl → a ZIP at `path`, one entry per table.
//!
//! Events:
//!   `data_export:plan`       — { tables: [{schema, table}] }
//!   `data_export:progress`   — { schema, table, done, total, elapsed_ms }
//!   `data_export:table_done` — { schema, table, rows, elapsed_ms, error }
//!   `data_export:done`       — { total_rows, elapsed_ms, tables_done, failed }

use std::io::Write;
use std::time::Instant;

use basemaster_core::{Driver, Value};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::data_transfer::{find_keyset_column, TransferControl};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportDataFormat {
    CsvComma,
    CsvSemicolon,
    Json,
    Xlsx,
}

impl ExportDataFormat {
    fn csv_separator(self) -> u8 {
        match self {
            ExportDataFormat::CsvSemicolon => b';',
            _ => b',',
        }
    }
    fn is_csv(self) -> bool {
        matches!(self, ExportDataFormat::CsvComma | ExportDataFormat::CsvSemicolon)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataExportTable {
    pub schema: String,
    pub table: String,
    /// Columns to export, in order. Empty = all columns (resolved via
    /// `describe_table`).
    #[serde(default)]
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataExportOptions {
    pub source_connection_id: uuid::Uuid,
    pub tables: Vec<DataExportTable>,
    pub format: ExportDataFormat,
    pub path: String,
    /// When true and format is CSV/JSON, every table becomes a ZIP entry.
    /// Ignored for XLSX (always a single multi-sheet workbook).
    #[serde(default)]
    pub bundle_zip: bool,
    #[serde(default = "default_chunk")]
    pub chunk_size: u64,
}

fn default_chunk() -> u64 { 5000 }

#[derive(Clone, Debug, Serialize)]
pub struct DataExportPlan {
    pub tables: Vec<DataExportPlanTable>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DataExportPlanTable {
    pub schema: String,
    pub table: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DataExportProgress {
    pub schema: String,
    pub table: String,
    pub done: u64,
    pub total: u64,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DataExportTableDone {
    pub schema: String,
    pub table: String,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DataExportDone {
    pub total_rows: u64,
    pub elapsed_ms: u64,
    pub tables_done: u32,
    pub failed: u32,
}

// ------------------------------------------------------------- entry point

pub async fn run_export(
    app: AppHandle,
    opts: DataExportOptions,
    source: std::sync::Arc<dyn Driver>,
    control: std::sync::Arc<TransferControl>,
) -> Result<DataExportDone, String> {
    let started = Instant::now();

    let _ = app.emit(
        "data_export:plan",
        &DataExportPlan {
            tables: opts
                .tables
                .iter()
                .map(|t| DataExportPlanTable {
                    schema: t.schema.clone(),
                    table: t.table.clone(),
                })
                .collect(),
        },
    );

    let (total_rows, tables_done, failed) = if opts.format == ExportDataFormat::Xlsx {
        export_xlsx(&app, &opts, &*source, &control).await?
    } else if opts.bundle_zip && opts.tables.len() > 1 {
        export_zip(&app, &opts, &*source, &control).await?
    } else {
        export_single_file(&app, &opts, &*source, &control).await?
    };

    let done = DataExportDone {
        total_rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        tables_done,
        failed,
    };
    let _ = app.emit("data_export:done", &done);
    Ok(done)
}

// ------------------------------------------------------------- CSV / JSON

/// Single CSV/JSON file (one table only — the front sends exactly one when
/// `bundle_zip` is false).
async fn export_single_file(
    app: &AppHandle,
    opts: &DataExportOptions,
    source: &dyn Driver,
    control: &TransferControl,
) -> Result<(u64, u32, u32), String> {
    let f = std::fs::File::create(&opts.path)
        .map_err(|e| format!("criar arquivo: {}", e))?;
    let mut w = std::io::BufWriter::new(f);

    let Some(t) = opts.tables.first() else {
        return Ok((0, 0, 0));
    };
    let t_start = Instant::now();
    let res = stream_table_text(app, opts, source, t, &mut w, control).await;
    w.flush().map_err(|e| e.to_string())?;
    finish_table_event(app, t, t_start, &res);
    match res {
        Ok(rows) => Ok((rows, 1, 0)),
        Err(_) => Ok((0, 1, 1)),
    }
}

/// One ZIP, one entry per table (CSV/JSON).
async fn export_zip(
    app: &AppHandle,
    opts: &DataExportOptions,
    source: &dyn Driver,
    control: &TransferControl,
) -> Result<(u64, u32, u32), String> {
    let f = std::fs::File::create(&opts.path)
        .map_err(|e| format!("criar arquivo: {}", e))?;
    let mut zip = zip::ZipWriter::new(f);
    // Stored: the per-table files are already text; skip deflate cost. The
    // front offers compression separately only for SQL dumps.
    let zopts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let (mut total_rows, mut tables_done, mut failed) = (0u64, 0u32, 0u32);
    for t in &opts.tables {
        if !control.check().await {
            break;
        }
        let entry = format!("{}.{}", safe_name(&t.table), text_ext(opts.format));
        zip.start_file(entry, zopts)
            .map_err(|e| format!("zip start_file: {}", e))?;
        let t_start = Instant::now();
        let res = stream_table_text(app, opts, source, t, &mut zip, control).await;
        finish_table_event(app, t, t_start, &res);
        match res {
            Ok(rows) => {
                total_rows += rows;
                tables_done += 1;
            }
            Err(_) => {
                tables_done += 1;
                failed += 1;
            }
        }
    }
    zip.finish().map_err(|e| format!("zip finish: {}", e))?;
    Ok((total_rows, tables_done, failed))
}

/// Streams one table's rows to `out` as CSV or JSON. Returns the row count.
async fn stream_table_text(
    app: &AppHandle,
    opts: &DataExportOptions,
    source: &dyn Driver,
    t: &DataExportTable,
    out: &mut (dyn Write + Send),
    control: &TransferControl,
) -> Result<u64, String> {
    let columns = resolve_columns(source, t).await?;
    let total = source
        .count_table_rows(&t.schema, &t.table, None)
        .await
        .unwrap_or(0);

    // Header / opening bracket.
    match opts.format {
        ExportDataFormat::Json => out.write_all(b"[").map_err(|e| e.to_string())?,
        _ => {
            // UTF-8 BOM + header row — matches the previous front behavior so
            // Excel opens CSVs as UTF-8.
            out.write_all(b"\xEF\xBB\xBF").map_err(|e| e.to_string())?;
            write_csv_header(out, &columns, opts.format.csv_separator())?;
        }
    }

    let started = Instant::now();
    let sep = opts.format.csv_separator();
    let mut written: u64 = 0;
    let mut first_json = true;
    let mut last_key: Option<Value> = None;
    let mut offset: u64 = 0;
    let keyset_col = find_keyset_column(source, &t.schema, &t.table).await;
    let chunk = opts.chunk_size.max(1);
    let qi = |s: &str| source.quote_ident(s);
    let col_list = columns.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");

    loop {
        if !control.check().await {
            break;
        }
        let sql = build_select(
            source,
            &t.schema,
            &t.table,
            &col_list,
            keyset_col.as_deref(),
            last_key.as_ref(),
            chunk,
            offset,
        );
        let batch = source
            .query(Some(&t.schema), &sql)
            .await
            .map_err(|e| format!("select {}.{}: {}", t.schema, t.table, e))?;
        if batch.rows.is_empty() {
            break;
        }

        for row in &batch.rows {
            match opts.format {
                ExportDataFormat::Json => {
                    if !first_json {
                        out.write_all(b",").map_err(|e| e.to_string())?;
                    }
                    first_json = false;
                    out.write_all(b"\n  ").map_err(|e| e.to_string())?;
                    write_json_object(out, &batch.columns, &columns, row)?;
                }
                _ => write_csv_row(out, &batch.columns, &columns, row, sep)?,
            }
        }

        let n = batch.rows.len() as u64;
        written += n;
        offset += n;
        if let Some(col) = keyset_col.as_deref() {
            if let Some(idx) = batch.columns.iter().position(|c| c == col) {
                if let Some(v) = batch.rows.last().and_then(|r| r.get(idx)) {
                    last_key = Some(v.clone());
                }
            }
        }
        let _ = app.emit(
            "data_export:progress",
            &DataExportProgress {
                schema: t.schema.clone(),
                table: t.table.clone(),
                done: written,
                total,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );
        if n < chunk {
            break;
        }
    }

    if opts.format == ExportDataFormat::Json {
        out.write_all(b"\n]\n").map_err(|e| e.to_string())?;
    }
    Ok(written)
}

// ------------------------------------------------------------- XLSX

/// One workbook, one worksheet per table. `rust_xlsxwriter` buffers the
/// sheet in memory until `save`, so this trades the WebView's memory ceiling
/// for the backend's — far higher, and never crosses the IPC bridge. For
/// truly huge tables CSV/JSON stay the streaming choice.
async fn export_xlsx(
    app: &AppHandle,
    opts: &DataExportOptions,
    source: &dyn Driver,
    control: &TransferControl,
) -> Result<(u64, u32, u32), String> {
    use rust_xlsxwriter::Workbook;

    let mut wb = Workbook::new();
    let (mut total_rows, mut tables_done, mut failed) = (0u64, 0u32, 0u32);

    for t in &opts.tables {
        if !control.check().await {
            break;
        }
        let t_start = Instant::now();
        let res = stream_table_xlsx(app, opts, source, t, &mut wb, control).await;
        finish_table_event(app, t, t_start, &res);
        match res {
            Ok(rows) => {
                total_rows += rows;
                tables_done += 1;
            }
            Err(_) => {
                tables_done += 1;
                failed += 1;
            }
        }
    }

    wb.save(&opts.path)
        .map_err(|e| format!("salvar xlsx: {}", e))?;
    Ok((total_rows, tables_done, failed))
}

async fn stream_table_xlsx(
    app: &AppHandle,
    opts: &DataExportOptions,
    source: &dyn Driver,
    t: &DataExportTable,
    wb: &mut rust_xlsxwriter::Workbook,
    control: &TransferControl,
) -> Result<u64, String> {
    let columns = resolve_columns(source, t).await?;
    let total = source
        .count_table_rows(&t.schema, &t.table, None)
        .await
        .unwrap_or(0);

    let ws = wb.add_worksheet();
    // Excel sheet names: <=31 chars, no []:*?/\.
    let _ = ws.set_name(sheet_name(&t.table));

    for (c, name) in columns.iter().enumerate() {
        ws.write_string(0, c as u16, name)
            .map_err(|e| e.to_string())?;
    }

    let started = Instant::now();
    let mut written: u64 = 0;
    let mut last_key: Option<Value> = None;
    let mut offset: u64 = 0;
    let keyset_col = find_keyset_column(source, &t.schema, &t.table).await;
    let chunk = opts.chunk_size.max(1);
    let qi = |s: &str| source.quote_ident(s);
    let col_list = columns.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");

    loop {
        if !control.check().await {
            break;
        }
        let sql = build_select(
            source,
            &t.schema,
            &t.table,
            &col_list,
            keyset_col.as_deref(),
            last_key.as_ref(),
            chunk,
            offset,
        );
        let batch = source
            .query(Some(&t.schema), &sql)
            .await
            .map_err(|e| format!("select {}.{}: {}", t.schema, t.table, e))?;
        if batch.rows.is_empty() {
            break;
        }

        // Map this batch's source column order onto the requested column
        // order once per chunk.
        let idx_map: Vec<Option<usize>> = columns
            .iter()
            .map(|c| batch.columns.iter().position(|bc| bc == c))
            .collect();

        for row in &batch.rows {
            let xl_row = (written + 1) as u32; // +1: header occupies row 0.
            for (c, src_idx) in idx_map.iter().enumerate() {
                let v = src_idx.and_then(|i| row.get(i)).unwrap_or(&Value::Null);
                write_xlsx_cell(ws, xl_row, c as u16, v)?;
            }
            written += 1;
        }

        let n = batch.rows.len() as u64;
        offset += n;
        if let Some(col) = keyset_col.as_deref() {
            if let Some(idx) = batch.columns.iter().position(|c| c == col) {
                if let Some(v) = batch.rows.last().and_then(|r| r.get(idx)) {
                    last_key = Some(v.clone());
                }
            }
        }
        let _ = app.emit(
            "data_export:progress",
            &DataExportProgress {
                schema: t.schema.clone(),
                table: t.table.clone(),
                done: written,
                total,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );
        if n < chunk {
            break;
        }
    }
    Ok(written)
}

fn write_xlsx_cell(
    ws: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    v: &Value,
) -> Result<(), String> {
    match v {
        Value::Null => {
            ws.write_blank(row, col, &rust_xlsxwriter::Format::default())
                .map_err(|e| e.to_string())?;
        }
        Value::Bool(b) => {
            ws.write_boolean(row, col, *b).map_err(|e| e.to_string())?;
        }
        Value::Int(i) => {
            ws.write_number(row, col, *i as f64).map_err(|e| e.to_string())?;
        }
        Value::UInt(u) => {
            ws.write_number(row, col, *u as f64).map_err(|e| e.to_string())?;
        }
        Value::Float(f) => {
            ws.write_number(row, col, *f).map_err(|e| e.to_string())?;
        }
        // Decimal / dates / json / bytes: keep textual fidelity rather than
        // risk f64 precision loss or timezone reinterpretation.
        other => {
            ws.write_string(row, col, value_to_text(other))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------- shared

async fn resolve_columns(
    source: &dyn Driver,
    t: &DataExportTable,
) -> Result<Vec<String>, String> {
    if !t.columns.is_empty() {
        return Ok(t.columns.clone());
    }
    let cols = source
        .describe_table(&t.schema, &t.table)
        .await
        .map_err(|e| format!("describe {}.{}: {}", t.schema, t.table, e))?;
    Ok(cols.into_iter().map(|c| c.name).collect())
}

#[allow(clippy::too_many_arguments)]
fn build_select(
    source: &dyn Driver,
    schema: &str,
    table: &str,
    col_list: &str,
    keyset_col: Option<&str>,
    last_key: Option<&Value>,
    chunk: u64,
    offset: u64,
) -> String {
    let qi = |s: &str| source.quote_ident(s);
    match keyset_col {
        Some(col) => match last_key {
            Some(key) => format!(
                "SELECT {} FROM {}.{} WHERE {} > {} ORDER BY {} LIMIT {}",
                col_list,
                qi(schema),
                qi(table),
                qi(col),
                value_to_sql_literal(key),
                qi(col),
                chunk
            ),
            None => format!(
                "SELECT {} FROM {}.{} ORDER BY {} LIMIT {}",
                col_list,
                qi(schema),
                qi(table),
                qi(col),
                chunk
            ),
        },
        None => format!(
            "SELECT {} FROM {}.{} LIMIT {} OFFSET {}",
            col_list,
            qi(schema),
            qi(table),
            chunk,
            offset
        ),
    }
}

fn finish_table_event(
    app: &AppHandle,
    t: &DataExportTable,
    t_start: Instant,
    res: &Result<u64, String>,
) {
    let _ = app.emit(
        "data_export:table_done",
        &DataExportTableDone {
            schema: t.schema.clone(),
            table: t.table.clone(),
            rows: *res.as_ref().unwrap_or(&0),
            elapsed_ms: t_start.elapsed().as_millis() as u64,
            error: res.as_ref().err().cloned(),
        },
    );
}

fn write_csv_header(
    out: &mut dyn Write,
    columns: &[String],
    sep: u8,
) -> Result<(), String> {
    let mut first = true;
    for c in columns {
        if !first {
            out.write_all(&[sep]).map_err(|e| e.to_string())?;
        }
        first = false;
        write_csv_field(out, c, sep)?;
    }
    out.write_all(b"\r\n").map_err(|e| e.to_string())
}

fn write_csv_row(
    out: &mut dyn Write,
    src_columns: &[String],
    want: &[String],
    row: &[Value],
    sep: u8,
) -> Result<(), String> {
    let mut first = true;
    for c in want {
        if !first {
            out.write_all(&[sep]).map_err(|e| e.to_string())?;
        }
        first = false;
        let cell = src_columns
            .iter()
            .position(|sc| sc == c)
            .and_then(|i| row.get(i))
            .map(value_to_text)
            .unwrap_or_default();
        write_csv_field(out, &cell, sep)?;
    }
    out.write_all(b"\r\n").map_err(|e| e.to_string())
}

fn write_csv_field(out: &mut dyn Write, s: &str, sep: u8) -> Result<(), String> {
    let needs_quote = s.as_bytes().contains(&sep)
        || s.contains('"')
        || s.contains('\n')
        || s.contains('\r');
    if needs_quote {
        out.write_all(b"\"").map_err(|e| e.to_string())?;
        out.write_all(s.replace('"', "\"\"").as_bytes())
            .map_err(|e| e.to_string())?;
        out.write_all(b"\"").map_err(|e| e.to_string())?;
    } else {
        out.write_all(s.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One `{ "col": value }` object. Plain values (numbers, strings, null) so
/// the JSON is human-usable, not the internal type-tagged `Value` form.
fn write_json_object(
    out: &mut dyn Write,
    src_columns: &[String],
    want: &[String],
    row: &[Value],
) -> Result<(), String> {
    let mut obj = serde_json::Map::with_capacity(want.len());
    for c in want {
        let v = src_columns
            .iter()
            .position(|sc| sc == c)
            .and_then(|i| row.get(i))
            .unwrap_or(&Value::Null);
        obj.insert(c.clone(), value_to_json_plain(v));
    }
    let s = serde_json::to_string(&obj).map_err(|e| e.to_string())?;
    out.write_all(s.as_bytes()).map_err(|e| e.to_string())
}

/// Plain JSON value matching the old front `valueToPlain`.
fn value_to_json_plain(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Int(i) => J::Number((*i).into()),
        Value::UInt(u) => J::Number((*u).into()),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(J::Number)
            .unwrap_or(J::Null),
        Value::Json(j) => j.clone(),
        // Decimal / temporal / bytes → string, same as the CSV cell.
        other => J::String(value_to_text(other)),
    }
}

/// SQL literal for keyset comparison. Only ever applied to PK values
/// (integers, strings, dates) — never blobs.
fn value_to_sql_literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Decimal(d) => d.to_string(),
        other => format!("'{}'", value_to_text(other).replace('\'', "''")),
    }
}

/// Textual rendering shared by CSV cells, XLSX text cells, and string-typed
/// JSON values. Mirrors the old front `valueToPlain` conventions.
fn value_to_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Decimal(d) => d.to_string(),
        Value::String(s) => s.clone(),
        Value::Bytes(b) => {
            let mut out = String::with_capacity(b.len() * 2 + 2);
            out.push_str("0x");
            for byte in b {
                out.push_str(&format!("{:02X}", byte));
            }
            out
        }
        Value::Json(j) => j.to_string(),
        Value::Date(d) => d.to_string(),
        Value::Time(t) => t.to_string(),
        Value::DateTime(dt) => dt.to_string(),
        Value::Timestamp(ts) => ts.to_rfc3339(),
    }
}

fn text_ext(format: ExportDataFormat) -> &'static str {
    if format.is_csv() {
        "csv"
    } else {
        "json"
    }
}

/// File-system-safe per-table name for ZIP entries.
fn safe_name(table: &str) -> String {
    table
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Excel worksheet name: <=31 chars, none of `[]:*?/\`.
fn sheet_name(table: &str) -> String {
    let cleaned: String = table
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            _ => c,
        })
        .collect();
    cleaned.chars().take(31).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_field_quotes_separator_and_quotes() {
        let mut buf = Vec::new();
        write_csv_field(&mut buf, "a,b", b',').unwrap();
        assert_eq!(buf, b"\"a,b\"");

        // Semicolon separator: a comma no longer forces quoting.
        let mut buf = Vec::new();
        write_csv_field(&mut buf, "a,b", b';').unwrap();
        assert_eq!(buf, b"a,b");

        let mut buf = Vec::new();
        write_csv_field(&mut buf, "he\"llo", b',').unwrap();
        assert_eq!(buf, b"\"he\"\"llo\"");
    }

    #[test]
    fn json_plain_values() {
        assert_eq!(value_to_json_plain(&Value::Int(7)), serde_json::json!(7));
        assert_eq!(value_to_json_plain(&Value::Null), serde_json::Value::Null);
        assert_eq!(
            value_to_json_plain(&Value::Bytes(vec![0xAB])),
            serde_json::json!("0xAB")
        );
    }

    #[test]
    fn sheet_name_truncates_and_sanitizes() {
        assert_eq!(sheet_name("a/b:c"), "a_b_c");
        assert_eq!(sheet_name(&"x".repeat(40)).len(), 31);
    }

    #[test]
    fn safe_name_strips_path_chars() {
        assert_eq!(safe_name("sales/2026"), "sales_2026");
        assert_eq!(safe_name("ok.table-1_v"), "ok.table-1_v");
    }
}
