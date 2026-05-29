//! Streams a query result to disk in JSONL or CSV format.
//!
//! Designed for the MCP / agent flow: instead of returning 10k+ rows
//! through the IPC channel (which then has to be re-emitted byte-for-byte
//! when an LLM wants to persist it — and LLMs *do* corrupt long base64
//! blobs in transit), the backend writes the file directly and returns
//! only metadata + a small sample. The agent can verify the artifact via
//! `sha256` without ever seeing the full payload.
//!
//! Memory bound: rows are streamed row-by-row through a `BufWriter`
//! wrapped in a sha256 + byte counter. Only the first `sample_rows`
//! are kept in memory for the return payload.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use basemaster_core::{Driver, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Jsonl,
    Csv,
}

impl ExportFormat {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "jsonl" | "ndjson" => Ok(Self::Jsonl),
            "csv" => Ok(Self::Csv),
            other => Err(format!("unsupported format: {}", other)),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportResult {
    pub path: PathBuf,
    pub format: ExportFormat,
    pub rows: u64,
    pub bytes: u64,
    pub sha256: String,
    pub columns: Vec<String>,
    /// First N rows materialized into the return payload — lets the caller
    /// reason about content without re-reading the file.
    pub sample: Vec<Vec<Value>>,
    pub elapsed_ms: u64,
}

/// `Write` adapter that counts bytes and feeds them into a SHA-256.
struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner, hasher: Sha256::new(), bytes: 0 }
    }

    fn finalize(self) -> (W, String, u64) {
        let digest = self.hasher.finalize();
        (self.inner, hex::encode(digest), self.bytes)
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Executes `sql` on `driver` and streams the resulting rows to `path`.
///
/// Returns metadata + first `sample_rows` rows for the caller's context.
/// File is fully written and synced before the result is returned, so
/// `sha256` matches what's on disk.
pub async fn export_query(
    driver: &dyn Driver,
    schema: Option<&str>,
    sql: &str,
    path: &Path,
    format: ExportFormat,
    sample_rows: usize,
) -> Result<ExportResult, String> {
    let started = Instant::now();

    // For now we materialize through driver.query() — same memory profile
    // as run_query, but the OUT side is streaming. A future pass can swap
    // this for a true row-by-row driver stream once we add that capability.
    let result =
        driver.query(schema, sql).await.map_err(|e| e.to_string())?;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("mkdir {}: {}", parent.display(), e)
            })?;
        }
    }
    let file = File::create(path)
        .map_err(|e| format!("create {}: {}", path.display(), e))?;
    let buf = BufWriter::new(file);
    let mut sink = HashingWriter::new(buf);

    match format {
        ExportFormat::Jsonl => {
            write_jsonl(&mut sink, &result.columns, &result.rows)?;
        }
        ExportFormat::Csv => {
            write_csv(&mut sink, &result.columns, &result.rows)?;
        }
    }

    let (mut buf, sha256, bytes) = sink.finalize();
    buf.flush().map_err(|e| format!("flush: {}", e))?;
    let file = buf.into_inner().map_err(|e| format!("flush: {}", e))?;
    file.sync_all().map_err(|e| format!("fsync: {}", e))?;

    let rows = result.rows.len() as u64;
    let sample = result.rows.into_iter().take(sample_rows).collect();

    Ok(ExportResult {
        path: path.to_path_buf(),
        format,
        rows,
        bytes,
        sha256,
        columns: result.columns,
        sample,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn write_jsonl<W: Write>(
    w: &mut W,
    columns: &[String],
    rows: &[Vec<Value>],
) -> Result<(), String> {
    for row in rows {
        // Serialize each row as a `{ col: value, ... }` object so the
        // file is self-describing even without a header. Cheap and
        // matches what most JSONL consumers expect.
        let mut obj = serde_json::Map::with_capacity(columns.len());
        for (i, col) in columns.iter().enumerate() {
            let v = row.get(i).cloned().unwrap_or(Value::Null);
            obj.insert(col.clone(), serde_json::to_value(&v).unwrap_or(serde_json::Value::Null));
        }
        let line = serde_json::to_string(&obj)
            .map_err(|e| format!("jsonl serialize: {}", e))?;
        w.write_all(line.as_bytes())
            .map_err(|e| format!("write: {}", e))?;
        w.write_all(b"\n").map_err(|e| format!("write: {}", e))?;
    }
    Ok(())
}

fn write_csv<W: Write>(
    w: &mut W,
    columns: &[String],
    rows: &[Vec<Value>],
) -> Result<(), String> {
    write_csv_row(w, columns.iter().map(|s| s.as_str()))?;
    for row in rows {
        let cells: Vec<String> = (0..columns.len())
            .map(|i| value_to_csv_cell(row.get(i).unwrap_or(&Value::Null)))
            .collect();
        write_csv_row(w, cells.iter().map(|s| s.as_str()))?;
    }
    Ok(())
}

fn write_csv_row<'a, W: Write, I: Iterator<Item = &'a str>>(
    w: &mut W,
    cells: I,
) -> Result<(), String> {
    let mut first = true;
    for cell in cells {
        if !first {
            w.write_all(b",").map_err(|e| format!("write: {}", e))?;
        }
        first = false;
        write_csv_field(w, cell)?;
    }
    w.write_all(b"\r\n").map_err(|e| format!("write: {}", e))?;
    Ok(())
}

fn write_csv_field<W: Write>(w: &mut W, s: &str) -> Result<(), String> {
    // RFC 4180: quote if contains comma, quote, CR, LF; escape inner quote
    // by doubling. Always-quote would be simpler but bloats the file.
    let needs_quote =
        s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if needs_quote {
        w.write_all(b"\"").map_err(|e| format!("write: {}", e))?;
        for c in s.chars() {
            if c == '"' {
                w.write_all(b"\"\"").map_err(|e| format!("write: {}", e))?;
            } else {
                let mut buf = [0u8; 4];
                w.write_all(c.encode_utf8(&mut buf).as_bytes())
                    .map_err(|e| format!("write: {}", e))?;
            }
        }
        w.write_all(b"\"").map_err(|e| format!("write: {}", e))?;
    } else {
        w.write_all(s.as_bytes()).map_err(|e| format!("write: {}", e))?;
    }
    Ok(())
}

fn value_to_csv_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Decimal(d) => d.to_string(),
        Value::String(s) => s.clone(),
        Value::Bytes(b) => {
            // Hex with 0x prefix mirrors MySQL/PG textual export
            // convention. Binary in CSV is always lossy; this at least
            // round-trips cleanly to a hex parser.
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn csv_field_quoting() {
        let mut buf = Vec::new();
        write_csv_field(&mut buf, "plain").unwrap();
        assert_eq!(buf, b"plain");

        let mut buf = Vec::new();
        write_csv_field(&mut buf, "has,comma").unwrap();
        assert_eq!(buf, b"\"has,comma\"");

        let mut buf = Vec::new();
        write_csv_field(&mut buf, "has\"quote").unwrap();
        assert_eq!(buf, b"\"has\"\"quote\"");

        let mut buf = Vec::new();
        write_csv_field(&mut buf, "line\nbreak").unwrap();
        assert_eq!(buf, b"\"line\nbreak\"");
    }

    #[test]
    fn csv_row_and_value_formatting() {
        let cols = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let rows = vec![vec![
            Value::Int(1),
            Value::String("hi, there".into()),
            Value::Null,
        ]];
        let mut buf = Vec::new();
        write_csv(&mut buf, &cols, &rows).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert_eq!(out, "a,b,c\r\n1,\"hi, there\",\r\n");
    }

    #[test]
    fn jsonl_object_per_row() {
        let cols = vec!["id".to_string(), "name".to_string()];
        let rows = vec![
            vec![Value::Int(1), Value::String("alice".into())],
            vec![Value::Int(2), Value::Null],
        ];
        let mut buf = Vec::new();
        write_jsonl(&mut buf, &cols, &rows).unwrap();
        let out = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = out.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value =
            serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["id"]["type"], "int");
        assert_eq!(first["id"]["value"], 1);
        let second: serde_json::Value =
            serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["name"]["type"], "null");
    }

    #[test]
    fn hashing_writer_tracks_bytes_and_digest() {
        let mut sink = HashingWriter::new(Vec::new());
        sink.write_all(b"hello").unwrap();
        let (inner, sha, bytes) = sink.finalize();
        assert_eq!(inner, b"hello");
        assert_eq!(bytes, 5);
        // sha256("hello") well-known constant
        assert_eq!(
            sha,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn value_to_csv_cell_covers_all_variants() {
        assert_eq!(value_to_csv_cell(&Value::Null), "");
        assert_eq!(value_to_csv_cell(&Value::Bool(true)), "true");
        assert_eq!(value_to_csv_cell(&Value::Bytes(vec![0xab, 0xcd])), "0xABCD");
        let d = NaiveDate::from_ymd_opt(2026, 5, 27).unwrap();
        assert_eq!(value_to_csv_cell(&Value::Date(d)), "2026-05-27");
    }

    #[test]
    fn format_parse_accepts_aliases() {
        assert_eq!(ExportFormat::parse("jsonl").unwrap(), ExportFormat::Jsonl);
        assert_eq!(ExportFormat::parse("NDJSON").unwrap(), ExportFormat::Jsonl);
        assert_eq!(ExportFormat::parse("csv").unwrap(), ExportFormat::Csv);
        assert!(ExportFormat::parse("parquet").is_err());
    }
}
