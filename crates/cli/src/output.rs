//! Rendering of tool payloads for scripts (json / ndjson / csv) and humans
//! (table). Query cells arrive as the IPC `Value` enum, externally tagged
//! `{ "type": "int", "value": 5 }`; everything here flattens that to plain
//! JSON scalars so `jq` and friends see `5`, not an envelope.

use std::io::Write;

use base64::Engine;
use serde_json::{json, Map, Value as JsonValue};

#[derive(Copy, Clone, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Format {
    /// One JSON document (rows as objects keyed by column).
    Json,
    /// One JSON object per row, no envelope.
    Ndjson,
    Csv,
    /// Aligned text, for humans.
    Table,
}

/// Flatten a tagged `Value` into a plain JSON scalar. Non-tagged input
/// passes through so the same function works on any payload.
pub fn flatten_cell(v: &JsonValue) -> JsonValue {
    let Some(obj) = v.as_object() else {
        return v.clone();
    };
    let (Some(tag), value) = (obj.get("type").and_then(|t| t.as_str()), obj.get("value")) else {
        return v.clone();
    };
    let value = value.cloned().unwrap_or(JsonValue::Null);
    match tag {
        "null" => JsonValue::Null,
        "bytes" => {
            let bytes: Vec<u8> = value
                .as_array()
                .map(|a| a.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect())
                .unwrap_or_default();
            json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes) })
        }
        "float" => match value.as_f64() {
            Some(f) if f.is_finite() => value,
            _ => JsonValue::Null,
        },
        // bool, int, u_int, decimal (string), string, json, date, time,
        // date_time, timestamp: the inner value is already the right scalar.
        _ => value,
    }
}

/// Column names made unique so rows can become objects: `id, id` ->
/// `id, id_2`.
pub fn unique_columns(columns: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(columns.len());
    for c in columns {
        let mut name = c.clone();
        let mut n = 2;
        while out.contains(&name) {
            name = format!("{c}_{n}");
            n += 1;
        }
        out.push(name);
    }
    out
}

/// A tabular result: what `run_query` returns, or any list of objects.
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
}

impl Table {
    /// From a `{columns, rows}` payload where cells are tagged Values.
    pub fn from_query(payload: &JsonValue) -> Option<Self> {
        let columns: Vec<String> = payload
            .get("columns")?
            .as_array()?
            .iter()
            .map(|c| c.as_str().unwrap_or("").to_string())
            .collect();
        let rows = payload
            .get("rows")?
            .as_array()?
            .iter()
            .map(|r| {
                r.as_array()
                    .map(|cells| cells.iter().map(flatten_cell).collect())
                    .unwrap_or_default()
            })
            .collect();
        Some(Self { columns, rows })
    }

    /// From a list of objects; columns are the union of keys in first-seen
    /// order.
    pub fn from_records(records: &[JsonValue]) -> Self {
        let mut columns: Vec<String> = Vec::new();
        for r in records {
            if let Some(obj) = r.as_object() {
                for k in obj.keys() {
                    if !columns.contains(k) {
                        columns.push(k.clone());
                    }
                }
            }
        }
        if columns.is_empty() {
            // Scalars (list of names): single column.
            return Self {
                columns: vec!["value".into()],
                rows: records.iter().map(|r| vec![flatten_cell(r)]).collect(),
            };
        }
        let rows = records
            .iter()
            .map(|r| {
                columns
                    .iter()
                    .map(|c| r.get(c).map(flatten_cell).unwrap_or(JsonValue::Null))
                    .collect()
            })
            .collect();
        Self { columns, rows }
    }

    pub fn row_objects(&self) -> Vec<JsonValue> {
        let names = unique_columns(&self.columns);
        self.rows
            .iter()
            .map(|r| {
                let mut m = Map::with_capacity(names.len());
                for (i, name) in names.iter().enumerate() {
                    m.insert(name.clone(), r.get(i).cloned().unwrap_or(JsonValue::Null));
                }
                JsonValue::Object(m)
            })
            .collect()
    }
}

/// Text form of a flattened cell for csv/table.
pub fn cell_text(v: &JsonValue) -> String {
    match v {
        JsonValue::Null => String::new(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Object(o) if o.len() == 1 && o.contains_key("$bytes") => {
            format!("<bytes {}>", o["$bytes"].as_str().unwrap_or(""))
        }
        other => other.to_string(),
    }
}

pub fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn write_csv(out: &mut dyn Write, t: &Table) -> std::io::Result<()> {
    let header: Vec<String> = t.columns.iter().map(|c| csv_escape(c)).collect();
    writeln!(out, "{}", header.join(","))?;
    for r in &t.rows {
        let line: Vec<String> = r.iter().map(|c| csv_escape(&cell_text(c))).collect();
        writeln!(out, "{}", line.join(","))?;
    }
    Ok(())
}

const MAX_CELL_WIDTH: usize = 80;

fn clip(s: &str) -> String {
    let one_line: String = s.replace(['\n', '\r'], " ");
    if one_line.chars().count() > MAX_CELL_WIDTH {
        let cut: String = one_line.chars().take(MAX_CELL_WIDTH - 1).collect();
        format!("{cut}…")
    } else {
        one_line
    }
}

pub fn write_table(out: &mut dyn Write, t: &Table) -> std::io::Result<()> {
    let cells: Vec<Vec<String>> = t
        .rows
        .iter()
        .map(|r| r.iter().map(|c| clip(&cell_text(c))).collect())
        .collect();
    let headers: Vec<String> = t.columns.iter().map(|c| clip(c)).collect();
    let mut widths: Vec<usize> = headers.iter().map(|h| h.chars().count()).collect();
    for r in &cells {
        for (i, c) in r.iter().enumerate() {
            if i < widths.len() {
                widths[i] = widths[i].max(c.chars().count());
            }
        }
    }
    let line = |cols: &[String]| -> String {
        cols.iter()
            .enumerate()
            .map(|(i, c)| {
                let pad = widths.get(i).copied().unwrap_or(0) - c.chars().count();
                format!("{c}{}", " ".repeat(pad))
            })
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    writeln!(out, "{}", line(&headers))?;
    writeln!(
        out,
        "{}",
        widths
            .iter()
            .map(|w| "-".repeat(*w))
            .collect::<Vec<_>>()
            .join("  ")
    )?;
    for r in &cells {
        writeln!(out, "{}", line(r))?;
    }
    Ok(())
}

/// Print a tabular payload in the requested format. `meta` carries the
/// extra fields of the envelope (elapsed_ms, truncated, ...) for json.
pub fn emit_table(
    out: &mut dyn Write,
    fmt: Format,
    t: &Table,
    meta: &Map<String, JsonValue>,
) -> std::io::Result<()> {
    match fmt {
        Format::Json => {
            let mut env = meta.clone();
            env.insert("columns".into(), json!(t.columns));
            env.insert("rows".into(), JsonValue::Array(t.row_objects()));
            env.insert("row_count".into(), json!(t.rows.len()));
            writeln!(out, "{}", serde_json::to_string_pretty(&JsonValue::Object(env))?)
        }
        Format::Ndjson => {
            for r in t.row_objects() {
                writeln!(out, "{}", serde_json::to_string(&r)?)?;
            }
            Ok(())
        }
        Format::Csv => write_csv(out, t),
        Format::Table => {
            write_table(out, t)?;
            let n = t.rows.len();
            let mut tail = format!("({n} row{})", if n == 1 { "" } else { "s" });
            if let Some(ms) = meta.get("elapsed_ms").and_then(|v| v.as_u64()) {
                tail.push_str(&format!(" in {ms} ms"));
            }
            if meta.get("truncated").and_then(|v| v.as_bool()) == Some(true) {
                if let Some(total) = meta.get("total_rows").and_then(|v| v.as_u64()) {
                    tail.push_str(&format!(", truncated from {total}"));
                } else {
                    tail.push_str(", truncated");
                }
            }
            writeln!(out, "{tail}")
        }
    }
}

/// Print an arbitrary (non-tabular) payload.
pub fn emit_value(out: &mut dyn Write, fmt: Format, v: &JsonValue) -> std::io::Result<()> {
    match fmt {
        Format::Json => writeln!(out, "{}", serde_json::to_string_pretty(v)?),
        Format::Ndjson => writeln!(out, "{}", serde_json::to_string(v)?),
        Format::Csv | Format::Table => match v {
            JsonValue::Array(items) => {
                let t = Table::from_records(items);
                if fmt == Format::Csv {
                    write_csv(out, &t)
                } else {
                    write_table(out, &t)
                }
            }
            JsonValue::Object(obj) => {
                // key/value listing.
                let t = Table {
                    columns: vec!["key".into(), "value".into()],
                    rows: obj
                        .iter()
                        .map(|(k, v)| vec![json!(k), flatten_cell(v)])
                        .collect(),
                };
                if fmt == Format::Csv {
                    write_csv(out, &t)
                } else {
                    write_table(out, &t)
                }
            }
            scalar => writeln!(out, "{}", cell_text(scalar)),
        },
    }
}

/// Meta = every top-level key of a query payload except columns/rows and
/// the job bookkeeping (`job_id`/`status`), which only matter with --async.
pub fn query_meta(payload: &JsonValue) -> Map<String, JsonValue> {
    const SKIP: [&str; 4] = ["columns", "rows", "job_id", "status"];
    payload
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| !SKIP.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_tagged_values() {
        assert_eq!(flatten_cell(&json!({"type":"int","value":5})), json!(5));
        assert_eq!(flatten_cell(&json!({"type":"null"})), JsonValue::Null);
        assert_eq!(
            flatten_cell(&json!({"type":"string","value":"x"})),
            json!("x")
        );
        assert_eq!(
            flatten_cell(&json!({"type":"decimal","value":"1.50"})),
            json!("1.50")
        );
        assert_eq!(
            flatten_cell(&json!({"type":"bytes","value":[104,105]})),
            json!({"$bytes":"aGk="})
        );
        assert_eq!(
            flatten_cell(&json!({"type":"float","value":1.5})),
            json!(1.5)
        );
        // Untagged input is untouched.
        assert_eq!(flatten_cell(&json!({"a":1})), json!({"a":1}));
        assert_eq!(flatten_cell(&json!("plain")), json!("plain"));
    }

    #[test]
    fn unique_column_names() {
        let cols = vec!["id".to_string(), "id".to_string(), "id".to_string(), "x".into()];
        assert_eq!(unique_columns(&cols), vec!["id", "id_2", "id_3", "x"]);
    }

    #[test]
    fn query_rows_become_objects() {
        let payload = json!({
            "columns": ["id", "name"],
            "rows": [
                [{"type":"int","value":1}, {"type":"string","value":"a"}],
                [{"type":"int","value":2}, {"type":"null"}]
            ],
            "elapsed_ms": 3,
            "truncated": false,
            "job_id": "j1",
            "status": "done"
        });
        let t = Table::from_query(&payload).unwrap();
        assert_eq!(
            t.row_objects(),
            vec![json!({"id":1,"name":"a"}), json!({"id":2,"name":null})]
        );
        let meta = query_meta(&payload);
        assert_eq!(meta.get("elapsed_ms"), Some(&json!(3)));
        assert!(!meta.contains_key("rows"));
        assert!(!meta.contains_key("job_id"));
    }

    #[test]
    fn csv_quotes_when_needed() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("two\nlines"), "\"two\nlines\"");
    }

    #[test]
    fn csv_and_table_render() {
        let t = Table {
            columns: vec!["id".into(), "name".into()],
            rows: vec![vec![json!(1), json!("a,b")], vec![json!(22), JsonValue::Null]],
        };
        let mut buf = Vec::new();
        write_csv(&mut buf, &t).unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "id,name\n1,\"a,b\"\n22,\n");

        let mut buf = Vec::new();
        write_table(&mut buf, &t).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(s, "id  name\n--  ----\n1   a,b\n22\n");
    }

    #[test]
    fn records_union_columns() {
        let t = Table::from_records(&[json!({"a":1}), json!({"b":2,"a":3})]);
        assert_eq!(t.columns, vec!["a", "b"]);
        assert_eq!(t.rows, vec![vec![json!(1), JsonValue::Null], vec![json!(3), json!(2)]]);

        let t = Table::from_records(&[json!("x"), json!("y")]);
        assert_eq!(t.columns, vec!["value"]);
        assert_eq!(t.rows.len(), 2);
    }
}
