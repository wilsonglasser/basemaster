//! Render a `.bmbak` backup as a portable `.sql` script for a chosen target
//! engine. The binary backup is the canonical intermediate: from the same file
//! you get a fast binary restore OR a cross-engine `.sql` dump.
//!
//! This layer owns value→SQL-literal formatting per dialect (ported from the
//! GUI dump). DDL in the manifest (`pre_sql`/`post_sql`) is emitted verbatim;
//! cross-engine DDL rewriting is layered on top by the caller when needed.

use std::io::{Read, Seek, Write};

use anyhow::Result;
use basemaster_core::Value;

use crate::container::{BmbakReader, TableEntry};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Mysql,
    Postgres,
    Sqlite,
}

impl Dialect {
    pub fn parse(s: &str) -> Option<Dialect> {
        match s.to_ascii_lowercase().as_str() {
            "mysql" | "mariadb" => Some(Dialect::Mysql),
            "postgres" | "postgresql" | "pg" => Some(Dialect::Postgres),
            "sqlite" => Some(Dialect::Sqlite),
            _ => None,
        }
    }

    fn quote_ident(self, name: &str) -> String {
        match self {
            // double the closing quote char to escape it
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
            Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SqlExportOptions {
    pub dialect: Dialect,
    pub drop_before_create: bool,
    pub extended_inserts: bool,
    pub complete_inserts: bool,
    /// MySQL only: emit BLOB as `0xABCD`. PG/SQLite always use their own blob
    /// literal regardless.
    pub hex_blob: bool,
    /// Soft cap per extended INSERT before starting a new statement.
    pub max_statement_bytes: usize,
}

impl Default for SqlExportOptions {
    fn default() -> Self {
        SqlExportOptions {
            dialect: Dialect::Mysql,
            drop_before_create: true,
            extended_inserts: true,
            complete_inserts: true,
            hex_blob: true,
            max_statement_bytes: 1024 * 1024,
        }
    }
}

/// ANSI-style string literal with backslash escapes (matches the GUI dump).
fn quote_str(s: &str) -> String {
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

/// One cell as a SQL literal for `dialect`.
pub fn value_to_sql(v: &Value, hex_blob: bool, dialect: Dialect) -> String {
    // dialect-specific overrides first
    match (dialect, v) {
        (Dialect::Postgres, Value::Bytes(b)) => {
            let hex: String = b.iter().map(|x| format!("{:02x}", x)).collect();
            return format!("'\\x{}'::bytea", hex);
        }
        (Dialect::Postgres, Value::Bool(b)) => {
            return if *b { "TRUE".into() } else { "FALSE".into() };
        }
        (Dialect::Sqlite, Value::Bytes(b)) => {
            let hex: String = b.iter().map(|x| format!("{:02X}", x)).collect();
            return format!("X'{}'", hex);
        }
        // MySQL: optional latin1-string form when hex_blob is off
        (Dialect::Mysql, Value::Bytes(b)) if !hex_blob => {
            let s: String = b.iter().map(|c| *c as char).collect();
            return quote_str(&s);
        }
        _ => {}
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
        Value::String(s) => quote_str(s),
        Value::Json(j) => quote_str(&j.to_string()),
        Value::Date(d) => quote_str(&d.format("%Y-%m-%d").to_string()),
        Value::Time(t) => quote_str(&t.format("%H:%M:%S").to_string()),
        Value::DateTime(dt) => quote_str(&dt.format("%Y-%m-%d %H:%M:%S").to_string()),
        Value::Timestamp(ts) => quote_str(&ts.format("%Y-%m-%d %H:%M:%S").to_string()),
        // Bytes for the default (MySQL hex) path; PG/SQLite handled above.
        Value::Bytes(b) => {
            let hex: String = b.iter().map(|x| format!("{:02X}", x)).collect();
            format!("0x{}", hex)
        }
    }
}

fn table_ref(t: &TableEntry, dialect: Dialect) -> String {
    match &t.schema {
        Some(s) if !s.is_empty() => {
            format!("{}.{}", dialect.quote_ident(s), dialect.quote_ident(&t.name))
        }
        _ => dialect.quote_ident(&t.name),
    }
}

/// Stream the whole backup to `out` as SQL.
pub fn export_to_sql<R: Read + Seek, W: Write>(
    reader: &mut BmbakReader<R>,
    opts: &SqlExportOptions,
    out: &mut W,
) -> Result<()> {
    let tables = reader.manifest.tables.clone();
    writeln!(
        out,
        "-- BaseMaster backup export\n-- source engine: {}\n-- created: {}\n",
        reader.manifest.source_engine, reader.manifest.created_at
    )?;

    for table in &tables {
        let tref = table_ref(table, opts.dialect);

        if !table.pre_sql.trim().is_empty() {
            if opts.drop_before_create {
                writeln!(out, "DROP TABLE IF EXISTS {};", tref)?;
            }
            writeln!(out, "{}", table.pre_sql.trim_end())?;
            writeln!(out)?;
        }

        write_table_data(reader, table, &tref, opts, out)?;

        if !table.post_sql.trim().is_empty() {
            writeln!(out, "{}", table.post_sql.trim_end())?;
            writeln!(out)?;
        }
    }
    out.flush()?;
    Ok(())
}

fn write_table_data<R: Read + Seek, W: Write>(
    reader: &mut BmbakReader<R>,
    table: &TableEntry,
    tref: &str,
    opts: &SqlExportOptions,
    out: &mut W,
) -> Result<()> {
    if table.row_count == 0 {
        return Ok(());
    }
    let cols: String = table
        .columns
        .iter()
        .map(|c| opts.dialect.quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let prefix = if opts.complete_inserts {
        format!("INSERT INTO {} ({}) VALUES ", tref, cols)
    } else {
        format!("INSERT INTO {} VALUES ", tref)
    };

    let ncols = table.columns.len();
    // Open statement state for extended-insert batching across blocks.
    let mut stmt = String::new();
    let mut stmt_rows = 0usize;

    let blocks = table.data_blocks.clone();
    for block in &blocks {
        let rows = reader.read_block(block, ncols)?;
        for row in &rows {
            let mut tuple = String::with_capacity(ncols * 6);
            tuple.push('(');
            for (i, v) in row.iter().enumerate() {
                if i > 0 {
                    tuple.push_str(", ");
                }
                tuple.push_str(&value_to_sql(v, opts.hex_blob, opts.dialect));
            }
            tuple.push(')');

            if !opts.extended_inserts {
                writeln!(out, "{}{};", prefix, tuple)?;
                continue;
            }

            if stmt_rows == 0 {
                stmt.push_str(&prefix);
                stmt.push_str(&tuple);
            } else {
                stmt.push_str(", ");
                stmt.push_str(&tuple);
            }
            stmt_rows += 1;

            if stmt.len() >= opts.max_statement_bytes {
                stmt.push(';');
                writeln!(out, "{}", stmt)?;
                stmt.clear();
                stmt_rows = 0;
            }
        }
    }
    if stmt_rows > 0 {
        stmt.push(';');
        writeln!(out, "{}", stmt)?;
    }
    writeln!(out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container::{BmbakWriter, ColumnMeta};
    use std::io::Cursor;

    fn dialect_lit(v: Value, d: Dialect) -> String {
        value_to_sql(&v, true, d)
    }

    #[test]
    fn literals_per_dialect() {
        assert_eq!(dialect_lit(Value::Null, Dialect::Mysql), "NULL");
        assert_eq!(dialect_lit(Value::Int(-5), Dialect::Mysql), "-5");
        assert_eq!(
            dialect_lit(Value::String("a'b\\c".into()), Dialect::Mysql),
            "'a''b\\\\c'"
        );
        // bool
        assert_eq!(dialect_lit(Value::Bool(true), Dialect::Mysql), "1");
        assert_eq!(dialect_lit(Value::Bool(true), Dialect::Postgres), "TRUE");
        assert_eq!(dialect_lit(Value::Bool(false), Dialect::Sqlite), "0");
        // bytes
        let b = Value::Bytes(vec![0xab, 0xcd]);
        assert_eq!(dialect_lit(b.clone(), Dialect::Mysql), "0xABCD");
        assert_eq!(dialect_lit(b.clone(), Dialect::Postgres), "'\\xabcd'::bytea");
        assert_eq!(dialect_lit(b, Dialect::Sqlite), "X'ABCD'");
        // non-finite float -> NULL
        assert_eq!(dialect_lit(Value::Float(f64::NAN), Dialect::Mysql), "NULL");
    }

    fn sample() -> Vec<u8> {
        let mut w = BmbakWriter::new(
            Cursor::new(Vec::new()),
            "mysql",
            "2026-06-01T00:00:00Z",
            "0.6.7",
            5,
        )
        .unwrap();
        let cols = vec![
            ColumnMeta { name: "id".into(), type_hint: "int".into() },
            ColumnMeta { name: "name".into(), type_hint: "text".into() },
        ];
        let t = w.begin_table(
            None,
            "users",
            cols,
            "CREATE TABLE `users` (`id` INT PRIMARY KEY, `name` TEXT);",
            "CREATE INDEX idx_name ON `users` (`name`);",
        );
        w.write_block(
            t,
            &[
                vec![Value::Int(1), Value::String("alice".into())],
                vec![Value::Int(2), Value::Null],
            ],
        )
        .unwrap();
        w.finish().unwrap().into_inner()
    }

    fn export(opts: SqlExportOptions) -> String {
        let mut r = BmbakReader::open(Cursor::new(sample())).unwrap();
        let mut out = Vec::new();
        export_to_sql(&mut r, &opts, &mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn extended_insert_mysql() {
        let sql = export(SqlExportOptions {
            dialect: Dialect::Mysql,
            ..Default::default()
        });
        assert!(sql.contains("DROP TABLE IF EXISTS `users`;"), "{sql}");
        assert!(sql.contains("CREATE TABLE `users`"), "{sql}");
        // both rows in one extended INSERT
        assert!(
            sql.contains("INSERT INTO `users` (`id`, `name`) VALUES (1, 'alice'), (2, NULL);"),
            "{sql}"
        );
        // deferred index after data
        let idx = sql.find("CREATE INDEX").unwrap();
        let ins = sql.find("INSERT INTO").unwrap();
        assert!(idx > ins, "index must come after data");
    }

    #[test]
    fn per_row_inserts_postgres_quoting() {
        let sql = export(SqlExportOptions {
            dialect: Dialect::Postgres,
            extended_inserts: false,
            ..Default::default()
        });
        assert!(sql.contains("INSERT INTO \"users\" (\"id\", \"name\") VALUES (1, 'alice');"), "{sql}");
        assert!(sql.contains("VALUES (2, NULL);"), "{sql}");
    }

    #[test]
    fn no_complete_inserts_omits_columns() {
        let sql = export(SqlExportOptions {
            dialect: Dialect::Mysql,
            complete_inserts: false,
            ..Default::default()
        });
        assert!(sql.contains("INSERT INTO `users` VALUES "), "{sql}");
        assert!(!sql.contains("(`id`, `name`)"), "{sql}");
    }
}
