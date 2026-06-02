//! Dump a live connection straight into a `.bmbak`, talking only to the
//! `core::Driver` trait. No Tauri, no webkit — so the headless CLI and the GUI
//! share one code path. Progress is reported through a trait the caller
//! implements (the GUI emits Tauri events; the CLI prints to stdout).
//!
//! v1 uses OFFSET pagination ordered by the primary key, one zstd block per
//! page. The parallel/keyset/deferred-index machinery in the GUI transfer
//! engine is a later optimization, not a prerequisite for a correct backup.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};
use basemaster_core::driver::{OrderBy, PageOptions, SortDir};
use basemaster_core::schema::Column;
use basemaster_core::Driver;

use crate::container::{BmbakWriter, ColumnMeta};

/// Caller-supplied progress sink. All methods default to no-ops so a caller can
/// override only what it needs.
pub trait Progress: Send + Sync {
    fn table_started(&self, _table: &str, _total_rows: u64) {}
    fn rows_written(&self, _table: &str, _done: u64, _total: u64) {}
    fn table_done(&self, _table: &str, _rows: u64) {}
}

/// Progress sink that ignores everything.
pub struct NoProgress;
impl Progress for NoProgress {}

#[derive(Clone, Debug)]
pub struct DumpToBmbakOptions {
    /// RFC3339; the caller stamps it (this layer has no clock).
    pub created_at: String,
    pub app_version: String,
    /// zstd level for blocks + manifest.
    pub level: i32,
    /// Rows fetched per page = rows per block.
    pub chunk_size: u64,
}

impl Default for DumpToBmbakOptions {
    fn default() -> Self {
        DumpToBmbakOptions {
            created_at: String::new(),
            app_version: String::new(),
            level: 5,
            chunk_size: 1000,
        }
    }
}

fn type_hint(c: &Column) -> String {
    format!("{:?}", c.column_type)
}

/// Pick a deterministic ORDER BY so OFFSET pagination is stable: primary key if
/// present, else the first column.
fn order_column(cols: &[Column]) -> Option<String> {
    cols.iter()
        .find(|c| c.is_primary_key)
        .or_else(|| cols.first())
        .map(|c| c.name.clone())
}

/// Dump `tables` of `schema` into `writer` as a `.bmbak`. Returns the finished
/// writer (e.g. the `File`/`Cursor`). Cancellation is cooperative: if `cancel`
/// flips to true between pages, the dump stops and the partial file is finished
/// cleanly (still a valid container, just fewer rows).
pub async fn dump_tables_to_bmbak<W: Write + Send>(
    driver: &dyn Driver,
    schema: &str,
    tables: &[String],
    opts: &DumpToBmbakOptions,
    writer: W,
    progress: &dyn Progress,
    cancel: Option<&AtomicBool>,
) -> Result<W> {
    let cancelled = || cancel.is_some_and(|c| c.load(Ordering::Relaxed));

    let mut bw = BmbakWriter::new(
        writer,
        driver.dialect(),
        opts.created_at.clone(),
        opts.app_version.clone(),
        opts.level,
    )?;

    let schema_opt = if schema.is_empty() {
        None
    } else {
        Some(schema.to_string())
    };
    let chunk = opts.chunk_size.max(1);

    for table in tables {
        if cancelled() {
            break;
        }

        let cols = driver
            .describe_table(schema, table)
            .await
            .with_context(|| format!("describe {schema}.{table}"))?;
        let col_metas: Vec<ColumnMeta> = cols
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                type_hint: type_hint(c),
            })
            .collect();

        // Best-effort DDL; drivers without support return Unsupported.
        let pre_sql = driver
            .get_table_ddl(schema, table)
            .await
            .unwrap_or_default();
        let total = driver
            .count_table_rows(schema, table, None)
            .await
            .unwrap_or(0);

        progress.table_started(table, total);

        let order_by = order_column(&cols).map(|column| OrderBy {
            column,
            direction: SortDir::Asc,
        });

        let ti = bw.begin_table(schema_opt.clone(), table.clone(), col_metas, pre_sql, String::new());

        let mut offset = 0u64;
        let mut written = 0u64;
        loop {
            if cancelled() {
                break;
            }
            let page = driver
                .select_table_page(
                    schema,
                    table,
                    &PageOptions {
                        limit: chunk,
                        offset,
                        order_by: order_by.clone(),
                        filter_tree: None,
                    },
                )
                .await
                .with_context(|| format!("select page {schema}.{table} @ {offset}"))?;

            let n = page.rows.len() as u64;
            if n == 0 {
                break;
            }
            bw.write_block(ti, &page.rows)?;
            written += n;
            offset += n;
            progress.rows_written(table, written, total);

            // Short page = last page.
            if n < chunk {
                break;
            }
        }

        progress.table_done(table, written);
    }

    bw.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container::BmbakReader;
    use async_trait::async_trait;
    use basemaster_core::driver::{ExecuteResult, QueryResult};
    use basemaster_core::error::Result as CoreResult;
    use basemaster_core::schema::{Column, ColumnType, IndexInfo, SchemaInfo, TableInfo};
    use basemaster_core::value::Value;
    use basemaster_core::connection::ConnectionConfig;
    use std::io::Cursor;

    /// Minimal in-memory driver: one table with fixed columns + rows.
    struct MockDriver {
        table: String,
        columns: Vec<Column>,
        rows: Vec<Vec<Value>>,
    }

    fn col(name: &str, pk: bool) -> Column {
        Column {
            name: name.into(),
            column_type: ColumnType::Other { raw: "x".into() },
            nullable: !pk,
            default: None,
            is_primary_key: pk,
            is_auto_increment: false,
            comment: None,
        }
    }

    #[async_trait]
    impl Driver for MockDriver {
        fn dialect(&self) -> &'static str {
            "sqlite"
        }
        fn quote_ident(&self, ident: &str) -> String {
            format!("\"{ident}\"")
        }
        async fn connect(&self, _c: &ConnectionConfig) -> CoreResult<()> {
            Ok(())
        }
        async fn disconnect(&self) -> CoreResult<()> {
            Ok(())
        }
        async fn ping(&self) -> CoreResult<()> {
            Ok(())
        }
        async fn list_schemas(&self) -> CoreResult<Vec<SchemaInfo>> {
            unimplemented!()
        }
        async fn list_tables(&self, _schema: &str) -> CoreResult<Vec<TableInfo>> {
            unimplemented!()
        }
        async fn describe_table(&self, _s: &str, _t: &str) -> CoreResult<Vec<Column>> {
            Ok(self.columns.clone())
        }
        async fn list_indexes(&self, _s: &str, _t: &str) -> CoreResult<Vec<IndexInfo>> {
            Ok(vec![])
        }
        async fn query(&self, _s: Option<&str>, _sql: &str) -> CoreResult<QueryResult> {
            unimplemented!()
        }
        async fn execute(&self, _s: Option<&str>, _sql: &str) -> CoreResult<ExecuteResult> {
            unimplemented!()
        }
        async fn get_table_ddl(&self, _s: &str, t: &str) -> CoreResult<String> {
            Ok(format!("CREATE TABLE \"{t}\" (id, name);"))
        }
        async fn count_table_rows(
            &self,
            _s: &str,
            _t: &str,
            _f: Option<&basemaster_core::driver::FilterNode>,
        ) -> CoreResult<u64> {
            Ok(self.rows.len() as u64)
        }
        async fn select_table_page(
            &self,
            _s: &str,
            _t: &str,
            opts: &PageOptions,
        ) -> CoreResult<QueryResult> {
            let start = opts.offset as usize;
            let end = (start + opts.limit as usize).min(self.rows.len());
            let rows = if start >= self.rows.len() {
                vec![]
            } else {
                self.rows[start..end].to_vec()
            };
            Ok(QueryResult {
                columns: self.columns.iter().map(|c| c.name.clone()).collect(),
                rows,
                source_table: None,
                elapsed_ms: 0,
                truncated: false,
            })
        }
        async fn update_cell(
            &self,
            _s: &str,
            _t: &str,
            _c: &str,
            _v: &Value,
            _w: &[(String, Value)],
        ) -> CoreResult<u64> {
            unimplemented!()
        }
        async fn delete_row(
            &self,
            _s: &str,
            _t: &str,
            _w: &[(String, Value)],
        ) -> CoreResult<u64> {
            unimplemented!()
        }
        async fn insert_row(
            &self,
            _s: &str,
            _t: &str,
            _v: &[(String, Value)],
        ) -> CoreResult<u64> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn dump_roundtrip_multi_page() {
        // 5 rows, chunk 2 => 3 blocks (2,2,1)
        let rows: Vec<Vec<Value>> = (1..=5)
            .map(|i| vec![Value::Int(i), Value::String(format!("n{i}"))])
            .collect();
        let driver = MockDriver {
            table: "users".into(),
            columns: vec![col("id", true), col("name", false)],
            rows,
        };
        let opts = DumpToBmbakOptions {
            created_at: "2026-06-01T00:00:00Z".into(),
            app_version: "0.6.7".into(),
            level: 3,
            chunk_size: 2,
        };
        let out = dump_tables_to_bmbak(
            &driver,
            "main",
            std::slice::from_ref(&driver.table),
            &opts,
            Cursor::new(Vec::new()),
            &NoProgress,
            None,
        )
        .await
        .unwrap()
        .into_inner();

        let mut r = BmbakReader::open(Cursor::new(out)).unwrap();
        assert_eq!(r.manifest.source_engine, "sqlite");
        assert_eq!(r.manifest.tables.len(), 1);
        let t = r.manifest.tables[0].clone();
        assert_eq!(t.name, "users");
        assert_eq!(t.row_count, 5);
        assert_eq!(t.data_blocks.len(), 3);
        assert!(t.pre_sql.contains("CREATE TABLE"));

        let all = r.read_table_rows(&t).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0], vec![Value::Int(1), Value::String("n1".into())]);
        assert_eq!(all[4], vec![Value::Int(5), Value::String("n5".into())]);
    }

    #[tokio::test]
    async fn cancel_stops_early() {
        let rows: Vec<Vec<Value>> = (1..=10).map(|i| vec![Value::Int(i)]).collect();
        let driver = MockDriver {
            table: "t".into(),
            columns: vec![col("id", true)],
            rows,
        };
        let flag = AtomicBool::new(true); // already cancelled
        let out = dump_tables_to_bmbak(
            &driver,
            "main",
            std::slice::from_ref(&driver.table),
            &DumpToBmbakOptions::default(),
            Cursor::new(Vec::new()),
            &NoProgress,
            Some(&flag),
        )
        .await
        .unwrap()
        .into_inner();
        // still a valid container, just no tables dumped
        let r = BmbakReader::open(Cursor::new(out)).unwrap();
        assert_eq!(r.manifest.tables.len(), 0);
    }
}
