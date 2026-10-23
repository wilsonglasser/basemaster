//! Dump a live connection straight into a `.bmbak`, talking only to the
//! `core::Driver` trait. No Tauri, no webkit — so the headless CLI and the GUI
//! share one code path. Progress is reported through a trait the caller
//! implements (the GUI emits Tauri events; the CLI prints to stdout).
//!
//! Every table is read inside one [`Snapshot`](basemaster_core::Snapshot), so
//! the file is a single point in time even while the database takes writes,
//! and each table is one streamed `SELECT` (no OFFSET pages, which skip or
//! repeat rows under writes and slow down the deeper they go). Metadata (DDL,
//! row counts for progress) still goes through the pool.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Context, Result};
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
    /// Rows per block.
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

fn type_hint(c: &basemaster_core::Column) -> String {
    format!("{:?}", c.column_type)
}

/// Parents before children, so a restore that can't switch FK checks off
/// (Postgres without superuser) creates and fills tables in file order.
/// Tables caught in a cycle keep their relative order at the end.
async fn fk_order(driver: &dyn Driver, schema: &str, tables: &[String]) -> Result<Vec<String>> {
    let mut parents: Vec<Vec<usize>> = Vec::with_capacity(tables.len());
    for (i, t) in tables.iter().enumerate() {
        let fks = driver
            .list_foreign_keys(schema, t)
            .await
            .map_err(|e| anyhow!("foreign keys of {schema}.{t}: {e}"))?;
        parents.push(
            fks.iter()
                .filter(|fk| fk.ref_schema.as_deref().is_none_or(|s| s == schema))
                .filter_map(|fk| tables.iter().position(|x| *x == fk.ref_table))
                .filter(|&p| p != i)
                .collect(),
        );
    }
    let mut done = vec![false; tables.len()];
    let mut out = Vec::with_capacity(tables.len());
    while out.len() < tables.len() {
        let before = out.len();
        for i in 0..tables.len() {
            if !done[i] && parents[i].iter().all(|&p| done[p]) {
                done[i] = true;
                out.push(tables[i].clone());
            }
        }
        if out.len() == before {
            out.extend((0..tables.len()).filter(|&i| !done[i]).map(|i| tables[i].clone()));
            break;
        }
    }
    Ok(out)
}

/// Dump `tables` of `schema` into `writer` as a `.bmbak`. Returns the finished
/// writer (e.g. the `File`/`Cursor`). Cancellation is cooperative: if `cancel`
/// flips to true between blocks, the dump stops and the partial file is
/// finished cleanly (still a valid container, just fewer rows).
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

    // SQLite has no schemas; the CLI passes the file path here.
    let sqlite = driver.dialect() == "sqlite";
    let schema_opt = if schema.is_empty() || sqlite {
        None
    } else {
        Some(schema.to_string())
    };
    let chunk = opts.chunk_size.max(1) as usize;

    let tables = fk_order(driver, schema, tables).await?;
    let snapshot = driver
        .open_snapshot()
        .await
        .map_err(|e| anyhow!("open snapshot: {e}"))?;

    'tables: for table in &tables {
        if cancelled() {
            break;
        }

        // Generated columns are recomputed by the server; inserting them back
        // is rejected, so they stay out of the backup.
        let generated = driver
            .list_generated_columns(schema, table)
            .await
            .map_err(|e| anyhow!("generated columns of {schema}.{table}: {e}"))?;
        let cols: Vec<_> = driver
            .describe_table(schema, table)
            .await
            .with_context(|| format!("describe {schema}.{table}"))?
            .into_iter()
            .filter(|c| !generated.contains(&c.name))
            .collect();
        let col_metas: Vec<ColumnMeta> = cols
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                type_hint: type_hint(c),
            })
            .collect();

        // Without DDL the backup only restores into existing tables, so a real
        // failure must stop the dump; only "driver has no DDL support" passes.
        let pre_sql = match driver.get_table_ddl(schema, table).await {
            Ok(ddl) => ddl,
            Err(basemaster_core::Error::Unsupported(_)) => String::new(),
            Err(e) => return Err(anyhow!("DDL of {schema}.{table}: {e}")),
        };
        let total = driver
            .count_table_rows(schema, table, None)
            .await
            .unwrap_or(0);

        progress.table_started(table, total);
        let ti = bw.begin_table(schema_opt.clone(), table.clone(), col_metas, pre_sql, String::new());

        let select_list = cols
            .iter()
            .map(|c| driver.quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let from = match &schema_opt {
            Some(s) => format!("{}.{}", driver.quote_ident(s), driver.quote_ident(table)),
            None => driver.quote_ident(table),
        };
        let mut rows = snapshot
            .scan(&format!("SELECT {select_list} FROM {from}"), chunk)
            .await
            .map_err(|e| anyhow!("read {schema}.{table}: {e}"))?;

        let mut written = 0u64;
        while let Some(block) = rows.recv().await {
            let block = block.map_err(|e| anyhow!("read {schema}.{table}: {e}"))?;
            bw.write_block(ti, &block)?;
            written += block.len() as u64;
            progress.rows_written(table, written, total);
            if cancelled() {
                // Dropping the receiver ends the snapshot.
                break 'tables;
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
    use basemaster_core::driver::{ExecuteResult, PageOptions, QueryResult, ScanRequest, Snapshot};
    use basemaster_core::error::Result as CoreResult;
    use basemaster_core::schema::{
        Column, ColumnType, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo,
    };
    use basemaster_core::value::Value;
    use basemaster_core::connection::ConnectionConfig;
    use std::io::Cursor;

    /// Minimal in-memory driver: every table has the same columns + rows.
    struct MockDriver {
        table: String,
        columns: Vec<Column>,
        rows: Vec<Vec<Value>>,
        /// (child, parent) foreign keys.
        fks: Vec<(&'static str, &'static str)>,
        generated: Vec<String>,
        /// Every SQL the snapshot was asked to scan.
        scans: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl MockDriver {
        fn new(table: &str, columns: Vec<Column>, rows: Vec<Vec<Value>>) -> Self {
            MockDriver {
                table: table.into(),
                columns,
                rows,
                fks: vec![],
                generated: vec![],
                scans: Default::default(),
            }
        }
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
        async fn list_foreign_keys(&self, _s: &str, t: &str) -> CoreResult<Vec<ForeignKeyInfo>> {
            Ok(self
                .fks
                .iter()
                .filter(|(child, _)| *child == t)
                .map(|(_, parent)| ForeignKeyInfo {
                    name: format!("fk_{t}"),
                    columns: vec!["id".into()],
                    ref_schema: None,
                    ref_table: parent.to_string(),
                    ref_columns: vec!["id".into()],
                    on_update: None,
                    on_delete: None,
                })
                .collect())
        }
        async fn list_generated_columns(&self, _s: &str, _t: &str) -> CoreResult<Vec<String>> {
            Ok(self.generated.clone())
        }
        async fn open_snapshot(&self) -> CoreResult<Snapshot> {
            let rows = self.rows.clone();
            let scans = self.scans.clone();
            let (tx, mut rx) = tokio::sync::mpsc::channel::<ScanRequest>(1);
            tokio::spawn(async move {
                while let Some(req) = rx.recv().await {
                    scans.lock().unwrap().push(req.sql.clone());
                    for c in rows.chunks(req.chunk) {
                        if req.rows.send(Ok(c.to_vec())).await.is_err() {
                            return;
                        }
                    }
                }
            });
            Ok(Snapshot::new(tx))
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
            _o: &PageOptions,
        ) -> CoreResult<QueryResult> {
            unimplemented!("the dump reads through the snapshot")
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
        let driver = MockDriver::new("users", vec![col("id", true), col("name", false)], rows);
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
        let driver = MockDriver::new("t", vec![col("id", true)], rows);
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

    #[tokio::test]
    async fn parents_are_dumped_before_children() {
        let mut driver = MockDriver::new("x", vec![col("id", true)], vec![vec![Value::Int(1)]]);
        // orders -> users, items -> orders, self-reference on users
        driver.fks = vec![("orders", "users"), ("items", "orders"), ("users", "users")];
        let tables: Vec<String> = ["items", "orders", "users", "logs"].map(String::from).into();
        let out = dump_tables_to_bmbak(
            &driver,
            "main",
            &tables,
            &DumpToBmbakOptions::default(),
            Cursor::new(Vec::new()),
            &NoProgress,
            None,
        )
        .await
        .unwrap()
        .into_inner();
        let r = BmbakReader::open(Cursor::new(out)).unwrap();
        let names: Vec<&str> = r.manifest.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["users", "logs", "orders", "items"]);
    }

    #[tokio::test]
    async fn generated_columns_are_left_out() {
        let mut driver = MockDriver::new(
            "t",
            vec![col("id", true), col("total", false)],
            vec![vec![Value::Int(1)]],
        );
        driver.generated = vec!["total".into()];
        let out = dump_tables_to_bmbak(
            &driver,
            "main",
            std::slice::from_ref(&driver.table),
            &DumpToBmbakOptions::default(),
            Cursor::new(Vec::new()),
            &NoProgress,
            None,
        )
        .await
        .unwrap()
        .into_inner();
        let r = BmbakReader::open(Cursor::new(out)).unwrap();
        let cols: Vec<&str> = r.manifest.tables[0].columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cols, ["id"]);
        assert_eq!(driver.scans.lock().unwrap().as_slice(), [r#"SELECT "id" FROM "t""#]);
    }
}
