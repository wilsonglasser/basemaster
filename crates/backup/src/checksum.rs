//! Per-table fingerprint computed by the database itself: row count plus the
//! sum of a per-row hash over the server's own rendering of every column.
//! Because our decoder never touches it, a value the driver reads wrong (the
//! TINYINT(1)-as-bool bug) shows up as a mismatch between the backup and the
//! restored copy. Taken inside the dump snapshot; recomputed on the target by
//! restore and `verify`.

use anyhow::{anyhow, Result};
use basemaster_core::{Driver, Value};

use crate::container::TableEntry;
use crate::sql_export::Dialect;

/// `SELECT count, sum` over `from` for the given columns.
pub fn checksum_sql(driver: &dyn Driver, from: &str, columns: &[String]) -> String {
    let q = |c: &String| driver.quote_ident(c);
    match Dialect::parse(driver.dialect()) {
        Some(Dialect::Mysql) if !columns.is_empty() => {
            // CRC32 per column keeps each argument small (one CONCAT over a
            // wide row with BLOBs can pass max_allowed_packet and turn NULL,
            // dropping the row); CONCAT_WS skips NULLs, so the ISNULL flags
            // tell NULL from ''. SUM, unlike BIT_XOR, doesn't cancel duplicates.
            let crcs: Vec<String> = columns.iter().map(|c| format!("CRC32({})", q(c))).collect();
            let nulls: Vec<String> = columns.iter().map(|c| format!("ISNULL({})", q(c))).collect();
            format!(
                "SELECT COUNT(*), COALESCE(SUM(CRC32(CONCAT_WS('|', {}, CONCAT({})))), 0) FROM {from}",
                crcs.join(", "),
                nulls.join(", ")
            )
        }
        Some(Dialect::Postgres) if !columns.is_empty() => {
            let cols: Vec<String> = columns.iter().map(q).collect();
            format!(
                "SELECT count(*), COALESCE(sum(('x' || substr(md5(ROW({})::text), 1, 8))::bit(32)::int::bigint), 0) FROM {from}",
                cols.join(", ")
            )
        }
        // SQLite has no hash function: count only.
        _ => format!("SELECT COUNT(*), NULL FROM {from}"),
    }
}

fn text(v: Option<&Value>) -> Option<String> {
    Some(match v? {
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Decimal(d) => d.normalize().to_string(),
        Value::Float(f) => f.to_string(),
        Value::String(s) => s.clone(),
        Value::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        _ => return None,
    })
}

/// (row count, hash sum) from the first row of a [`checksum_sql`] result.
pub fn parse_checksum(row: &[Value]) -> Result<(u64, Option<String>)> {
    let count = text(row.first())
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("checksum query returned no row count"))?;
    Ok((count, text(row.get(1))))
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableCheck {
    pub table: String,
    pub expected_rows: u64,
    pub actual_rows: u64,
    pub expected_sum: Option<String>,
    pub actual_sum: Option<String>,
}

impl TableCheck {
    pub fn ok(&self) -> bool {
        self.expected_rows == self.actual_rows
            && (self.expected_sum.is_none() || self.expected_sum == self.actual_sum)
    }
}

/// Recompute every table's fingerprint on `driver` (in `target_schema`, else
/// the schema recorded in the backup) and pair it with the backup's.
pub async fn verify_tables(
    driver: &dyn Driver,
    tables: &[TableEntry],
    target_schema: Option<&str>,
) -> Result<Vec<TableCheck>> {
    let mut out = Vec::with_capacity(tables.len());
    for t in tables {
        let schema = target_schema.or(t.schema.as_deref()).filter(|s| !s.is_empty());
        let from = match schema {
            Some(s) => format!("{}.{}", driver.quote_ident(s), driver.quote_ident(&t.name)),
            None => driver.quote_ident(&t.name),
        };
        let cols: Vec<String> = t.columns.iter().map(|c| c.name.clone()).collect();
        let q = driver
            .query(schema, &checksum_sql(driver, &from, &cols))
            .await
            .map_err(|e| anyhow!("checksum of {}: {e}", t.name))?;
        let row = q.rows.first().ok_or_else(|| anyhow!("checksum of {}: no row", t.name))?;
        let (actual_rows, actual_sum) = parse_checksum(row)?;
        out.push(TableCheck {
            table: t.name.clone(),
            expected_rows: t.row_count,
            actual_rows,
            expected_sum: t.checksum.clone(),
            actual_sum,
        });
    }
    Ok(out)
}
