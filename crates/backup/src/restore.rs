//! Restore a `.bmbak` into a live connection through the `core::Driver` trait.
//!
//! v1 path: per table run `pre_sql` (CREATE, primary key only when the dump
//! deferred indexes), stream blocks as multi-row INSERTs, then `post_sql`
//! (secondary indexes / FKs / triggers). Session tuning disables FK/unique
//! checks during load. This is same-engine restore; for cross-engine, render
//! the backup to `.sql` (see [`crate::sql_export`]) which handles translation.
//!
//! NOTE: true bulk load (`COPY FROM` / `LOAD DATA`) needs driver APIs not on the
//! trait and is a later optimization. Batched multi-row INSERT through
//! `execute` already skips per-row round-trips and reuses every existing driver.

use std::io::{Read, Seek};

use anyhow::{Context, Result};
use basemaster_core::Driver;

use crate::container::{BmbakReader, TableEntry};
use crate::sql_export::{value_to_sql, Dialect};

pub trait Progress: Send + Sync {
    fn table_started(&self, _table: &str, _total_rows: u64) {}
    fn rows_restored(&self, _table: &str, _done: u64, _total: u64) {}
    fn table_done(&self, _table: &str, _rows: u64) {}
}

pub struct NoProgress;
impl Progress for NoProgress {}

#[derive(Clone, Debug)]
pub struct RestoreOptions {
    pub drop_before_create: bool,
    /// Run `pre_sql` (the CREATE TABLE). Off when restoring into an existing schema.
    pub create_tables: bool,
    pub hex_blob: bool,
    /// Soft cap per multi-row INSERT before flushing.
    pub max_statement_bytes: usize,
    /// SET FOREIGN_KEY_CHECKS=0 / session DEFER for the load (dialect aware).
    pub disable_fk_checks: bool,
    /// Restore into this schema instead of the one recorded in the backup.
    /// None keeps the recorded one.
    pub target_schema: Option<String>,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        RestoreOptions {
            drop_before_create: true,
            create_tables: true,
            hex_blob: true,
            max_statement_bytes: 1024 * 1024,
            disable_fk_checks: true,
            target_schema: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoreStats {
    pub tables: u64,
    pub rows: u64,
}

fn dialect_of(driver: &dyn Driver) -> Dialect {
    Dialect::parse(driver.dialect()).unwrap_or(Dialect::Mysql)
}

fn table_ref(schema: Option<&str>, t: &TableEntry, driver: &dyn Driver) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!("{}.{}", driver.quote_ident(s), driver.quote_ident(&t.name))
        }
        _ => driver.quote_ident(&t.name),
    }
}

/// The dumped DDL can qualify names with the source schema (Postgres always
/// does, MySQL for FK references), which would recreate tables in the source.
/// Plain text replace of the quoted `"src".` prefix: a string literal holding
/// that exact sequence would be rewritten too, acceptable for DDL.
fn retarget_ddl(sql: &str, from: Option<&str>, to: Option<&str>, driver: &dyn Driver) -> String {
    match (from, to) {
        (Some(f), Some(t)) if !f.is_empty() && f != t => sql.replace(
            &format!("{}.", driver.quote_ident(f)),
            &format!("{}.", driver.quote_ident(t)),
        ),
        _ => sql.to_string(),
    }
}

/// Runs one restore statement. The MySQL driver executes on a pool, so a
/// standalone `SET FOREIGN_KEY_CHECKS=0` lands on some other connection and
/// tables created before their FK parent fail; the toggle has to travel in the
/// same multi-statement batch, and is switched back so the pooled connection
/// isn't left with checks off.
async fn exec(
    driver: &dyn Driver,
    schema: Option<&str>,
    sql: &str,
    opts: &RestoreOptions,
) -> basemaster_core::error::Result<()> {
    let sql = sql.trim_end().trim_end_matches(';');
    if opts.disable_fk_checks && dialect_of(driver) == Dialect::Mysql {
        let wrapped = format!(
            "SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0; {sql}; SET FOREIGN_KEY_CHECKS=1, UNIQUE_CHECKS=1"
        );
        driver.execute(schema, &wrapped).await?;
    } else {
        driver.execute(schema, sql).await?;
    }
    Ok(())
}

async fn session_pre(driver: &dyn Driver, opts: &RestoreOptions) {
    if !opts.disable_fk_checks {
        return;
    }
    // best-effort; ignore errors (privilege / unsupported)
    let stmts: &[&str] = match dialect_of(driver) {
        Dialect::Mysql => &[],
        Dialect::Postgres => &["SET session_replication_role = replica"],
        Dialect::Sqlite => &["PRAGMA foreign_keys=OFF"],
    };
    for s in stmts {
        let _ = driver.execute(None, s).await;
    }
}

async fn session_post(driver: &dyn Driver, opts: &RestoreOptions) {
    if !opts.disable_fk_checks {
        return;
    }
    let stmts: &[&str] = match dialect_of(driver) {
        Dialect::Mysql => &[],
        Dialect::Postgres => &["SET session_replication_role = DEFAULT"],
        Dialect::Sqlite => &["PRAGMA foreign_keys=ON"],
    };
    for s in stmts {
        let _ = driver.execute(None, s).await;
    }
}

/// Restore the whole backup into `driver`.
pub async fn restore_from_bmbak<R: Read + Seek>(
    driver: &dyn Driver,
    reader: &mut BmbakReader<R>,
    opts: &RestoreOptions,
    progress: &dyn Progress,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<RestoreStats> {
    use std::sync::atomic::Ordering;
    let cancelled = || cancel.is_some_and(|c| c.load(Ordering::Relaxed));

    let dialect = dialect_of(driver);
    let tables = reader.manifest.tables.clone();
    let mut stats = RestoreStats::default();

    session_pre(driver, opts).await;

    for table in &tables {
        if cancelled() {
            break;
        }
        let schema = opts.target_schema.as_deref().or(table.schema.as_deref());
        let tref = table_ref(schema, table, driver);

        if opts.create_tables && !table.pre_sql.trim().is_empty() {
            if opts.drop_before_create {
                let _ = exec(driver, schema, &format!("DROP TABLE IF EXISTS {tref}"), opts).await;
            }
            let ddl = retarget_ddl(&table.pre_sql, table.schema.as_deref(), schema, driver);
            exec(driver, schema, &ddl, opts)
                .await
                .with_context(|| format!("create table {}", table.name))?;
        }

        progress.table_started(&table.name, table.row_count);
        let rows =
            restore_table_data(driver, reader, table, schema, &tref, opts, dialect, progress, &cancelled)
                .await?;
        stats.rows += rows;
        stats.tables += 1;

        if !table.post_sql.trim().is_empty() {
            let ddl = retarget_ddl(&table.post_sql, table.schema.as_deref(), schema, driver);
            exec(driver, schema, &ddl, opts)
                .await
                .with_context(|| format!("post-DDL {}", table.name))?;
        }
        progress.table_done(&table.name, rows);
    }

    session_post(driver, opts).await;
    Ok(stats)
}

#[allow(clippy::too_many_arguments)]
async fn restore_table_data<R: Read + Seek>(
    driver: &dyn Driver,
    reader: &mut BmbakReader<R>,
    table: &TableEntry,
    schema: Option<&str>,
    tref: &str,
    opts: &RestoreOptions,
    dialect: Dialect,
    progress: &dyn Progress,
    cancelled: &dyn Fn() -> bool,
) -> Result<u64> {
    if table.row_count == 0 {
        return Ok(0);
    }
    let cols: String = table
        .columns
        .iter()
        .map(|c| driver.quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let prefix = format!("INSERT INTO {tref} ({cols}) VALUES ");
    let ncols = table.columns.len();

    let mut stmt = String::new();
    let mut stmt_rows = 0usize;
    let mut done = 0u64;

    // collect blocks first to release the borrow on reader per-iteration
    let blocks = table.data_blocks.clone();
    for block in &blocks {
        if cancelled() {
            break;
        }
        let rows = reader.read_block(block, ncols)?;
        for row in &rows {
            let mut tuple = String::with_capacity(ncols * 6);
            tuple.push('(');
            for (i, v) in row.iter().enumerate() {
                if i > 0 {
                    tuple.push_str(", ");
                }
                tuple.push_str(&value_to_sql(v, opts.hex_blob, dialect));
            }
            tuple.push(')');

            if stmt_rows == 0 {
                stmt.push_str(&prefix);
                stmt.push_str(&tuple);
            } else {
                stmt.push_str(", ");
                stmt.push_str(&tuple);
            }
            stmt_rows += 1;

            if stmt.len() >= opts.max_statement_bytes {
                exec(driver, schema, &stmt, opts)
                    .await
                    .with_context(|| format!("insert into {}", table.name))?;
                done += stmt_rows as u64;
                progress.rows_restored(&table.name, done, table.row_count);
                stmt.clear();
                stmt_rows = 0;
            }
        }
    }
    if stmt_rows > 0 {
        exec(driver, schema, &stmt, opts)
            .await
            .with_context(|| format!("insert into {}", table.name))?;
        done += stmt_rows as u64;
        progress.rows_restored(&table.name, done, table.row_count);
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container::{BmbakWriter, ColumnMeta};
    use async_trait::async_trait;
    use basemaster_core::connection::ConnectionConfig;
    use basemaster_core::driver::{ExecuteResult, PageOptions, QueryResult};
    use basemaster_core::error::Result as CoreResult;
    use basemaster_core::schema::{Column, IndexInfo, SchemaInfo, TableInfo};
    use basemaster_core::value::Value;
    use std::io::Cursor;
    use std::sync::Mutex;

    /// Records every executed statement so we can assert what the restore emits.
    struct RecordingDriver {
        log: Mutex<Vec<String>>,
        /// Schema each statement ran under (MySQL turns it into `USE`).
        schemas: Mutex<Vec<Option<String>>>,
    }

    impl RecordingDriver {
        fn new() -> Self {
            RecordingDriver { log: Mutex::new(Vec::new()), schemas: Mutex::new(Vec::new()) }
        }
    }

    #[async_trait]
    impl Driver for RecordingDriver {
        fn dialect(&self) -> &'static str {
            "mysql"
        }
        fn quote_ident(&self, ident: &str) -> String {
            format!("`{ident}`")
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
        async fn list_tables(&self, _s: &str) -> CoreResult<Vec<TableInfo>> {
            unimplemented!()
        }
        async fn describe_table(&self, _s: &str, _t: &str) -> CoreResult<Vec<Column>> {
            unimplemented!()
        }
        async fn list_indexes(&self, _s: &str, _t: &str) -> CoreResult<Vec<IndexInfo>> {
            unimplemented!()
        }
        async fn query(&self, _s: Option<&str>, _sql: &str) -> CoreResult<QueryResult> {
            unimplemented!()
        }
        async fn execute(&self, s: Option<&str>, sql: &str) -> CoreResult<ExecuteResult> {
            self.log.lock().unwrap().push(sql.to_string());
            self.schemas.lock().unwrap().push(s.map(str::to_string));
            Ok(ExecuteResult {
                rows_affected: 0,
                last_insert_id: None,
                elapsed_ms: 0,
            })
        }
        async fn select_table_page(
            &self,
            _s: &str,
            _t: &str,
            _o: &PageOptions,
        ) -> CoreResult<QueryResult> {
            unimplemented!()
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

    fn sample() -> Vec<u8> {
        sample_in(None)
    }

    fn sample_in(schema: Option<&str>) -> Vec<u8> {
        let mut w = BmbakWriter::new(
            Cursor::new(Vec::new()),
            "mysql",
            "2026-06-01T00:00:00Z",
            "0.6.7",
            3,
        )
        .unwrap();
        let cols = vec![
            ColumnMeta { name: "id".into(), type_hint: "int".into() },
            ColumnMeta { name: "name".into(), type_hint: "text".into() },
        ];
        let q = schema.map(|s| format!("`{s}`.")).unwrap_or_default();
        let t = w.begin_table(
            schema.map(str::to_string),
            "users",
            cols,
            format!("CREATE TABLE {q}`users` (`id` INT PRIMARY KEY, `name` TEXT)"),
            format!("CREATE INDEX idx_name ON {q}`users` (`name`)"),
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

    #[tokio::test]
    async fn restore_emits_expected_sql_in_order() {
        let driver = RecordingDriver::new();
        let mut reader = BmbakReader::open(Cursor::new(sample())).unwrap();
        let stats = restore_from_bmbak(
            &driver,
            &mut reader,
            &RestoreOptions::default(),
            &NoProgress,
            None,
        )
        .await
        .unwrap();

        assert_eq!(stats.tables, 1);
        assert_eq!(stats.rows, 2);

        let log = driver.log.lock().unwrap().clone();
        let joined = log.join("\n");
        // drop + create before data
        let drop = log.iter().position(|s| s.contains("DROP TABLE")).unwrap();
        let create = log.iter().position(|s| s.contains("CREATE TABLE")).unwrap();
        let insert = log.iter().position(|s| s.contains("INSERT INTO")).unwrap();
        let index = log.iter().position(|s| s.contains("CREATE INDEX")).unwrap();
        assert!(drop < create && create < insert && insert < index, "wrong order: {joined}");
        // multi-row insert, NULL preserved
        assert!(
            log[insert].contains("VALUES (1, 'alice'), (2, NULL)"),
            "{}",
            log[insert]
        );
        // each statement switches FK checks off and back on in its own batch,
        // so it holds on whichever pooled connection runs it
        for s in &log {
            assert!(
                s.starts_with("SET FOREIGN_KEY_CHECKS=0") && s.ends_with("SET FOREIGN_KEY_CHECKS=1, UNIQUE_CHECKS=1"),
                "not wrapped: {s}"
            );
        }
    }

    #[tokio::test]
    async fn target_schema_overrides_the_recorded_one() {
        let driver = RecordingDriver::new();
        let mut reader = BmbakReader::open(Cursor::new(sample_in(Some("prod")))).unwrap();
        let opts = RestoreOptions {
            target_schema: Some("scratch".into()),
            ..Default::default()
        };
        restore_from_bmbak(&driver, &mut reader, &opts, &NoProgress, None)
            .await
            .unwrap();

        let log = driver.log.lock().unwrap().clone();
        let joined = log.join("
");
        assert!(!joined.contains("prod"), "source schema leaked: {joined}");
        for kw in ["DROP TABLE", "CREATE TABLE", "INSERT INTO", "CREATE INDEX"] {
            let stmt = log.iter().find(|s| s.contains(kw)).unwrap();
            assert!(stmt.contains("`scratch`.`users`"), "{kw} not retargeted: {stmt}");
        }
        let schemas = driver.schemas.lock().unwrap().clone();
        assert!(
            schemas.iter().flatten().all(|s| s == "scratch"),
            "statement ran under another schema: {schemas:?}"
        );
    }
}
