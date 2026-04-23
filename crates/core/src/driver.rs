use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{
    connection::ConnectionConfig,
    error::Result,
    schema::{Column, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo, TableOptions},
    value::Value,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub source_table: Option<SourceTable>,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

/// Marks a result as coming from a single SELECT over a known table —
/// enables in-grid editing with safe UPDATE/DELETE.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceTable {
    pub schema: String,
    pub table: String,
    pub pk_columns: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecuteResult {
    pub rows_affected: u64,
    pub last_insert_id: Option<u64>,
    pub elapsed_ms: u64,
}

/// Full snapshot of a schema — tables + columns of each — used to feed
/// autocomplete without N round-trips.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub tables: Vec<TableInfo>,
    /// `table_name -> columns` (original declaration order).
    pub columns: HashMap<String, Vec<Column>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OrderBy {
    pub column: String,
    pub direction: SortDir,
}

/// Operators supported in `select_table_page` filters.
/// Parametrized via sqlx — each backend binds the `Value` safely.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    NotEq,
    Gt,
    Lt,
    Gte,
    Lte,
    /// `col LIKE '%value%'`
    Contains,
    NotContains,
    /// `col LIKE 'value%'`
    BeginsWith,
    NotBeginsWith,
    /// `col LIKE '%value'`
    EndsWith,
    NotEndsWith,
    IsNull,
    IsNotNull,
    /// `col = ''`
    IsEmpty,
    /// `col <> ''`
    IsNotEmpty,
    /// `col BETWEEN ? AND ?` — uses value + value2
    Between,
    NotBetween,
    /// `col IN (?, ?, ?)` — value is CSV
    In,
    NotIn,
    /// Raw fragment after the column ident, e.g., `> 10 AND < 20`.
    /// NOT parametrized — intended as an advanced escape hatch.
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    /// Main value. Ignored for IsNull/IsNotNull/IsEmpty/IsNotEmpty.
    /// For Custom: string with the SQL fragment to concatenate after the column.
    #[serde(default)]
    pub value: Option<Value>,
    /// Second value (used only in Between/NotBetween).
    #[serde(default)]
    pub value2: Option<Value>,
}

/// Combining operator for filter groups.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupOp {
    And,
    Or,
}

/// Filter tree — leaves are `Filter`, groups combine children via
/// AND/OR. Groups can nest indefinitely.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterNode {
    Leaf { filter: Filter },
    Group { op: GroupOp, children: Vec<FilterNode> },
}

/// Pagination + ordering + filter options for `select_table_page`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageOptions {
    pub limit: u64,
    pub offset: u64,
    #[serde(default)]
    pub order_by: Option<OrderBy>,
    /// Filter tree (nested AND/OR groups). None = no WHERE.
    #[serde(default)]
    pub filter_tree: Option<FilterNode>,
}

impl Default for PageOptions {
    fn default() -> Self {
        Self {
            limit: 200,
            offset: 0,
            order_by: None,
            filter_tree: None,
        }
    }
}

/// Contract each DBMS implements. Every database operation in
/// BaseMaster goes through this trait.
#[async_trait]
pub trait Driver: Send + Sync {
    /// Dialect identifier ("mysql", "postgres", "sqlite").
    fn dialect(&self) -> &'static str;

    async fn connect(&self, config: &ConnectionConfig) -> Result<()>;
    async fn disconnect(&self) -> Result<()>;
    async fn ping(&self) -> Result<()>;

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>>;
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>>;
    async fn describe_table(&self, schema: &str, table: &str) -> Result<Vec<Column>>;
    async fn list_indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>>;

    /// Lists foreign keys of the table. Default: empty (DBMSs that
    /// don't support it can simply not override).
    async fn list_foreign_keys(
        &self,
        _schema: &str,
        _table: &str,
    ) -> Result<Vec<ForeignKeyInfo>> {
        Ok(Vec::new())
    }

    /// Storage-level options of the table (engine, charset, AUTO_INCREMENT…).
    /// Default: everything None.
    async fn table_options(&self, _schema: &str, _table: &str) -> Result<TableOptions> {
        Ok(TableOptions::default())
    }

    async fn query(&self, schema: Option<&str>, sql: &str) -> Result<QueryResult>;
    async fn execute(&self, schema: Option<&str>, sql: &str) -> Result<ExecuteResult>;

    /// Optimized prefetch: tables + columns for all of them. Default
    /// implementation is N+1 (list_tables + describe N); each driver
    /// can override with a single bulk query.
    async fn snapshot_schema(&self, schema: &str) -> Result<SchemaSnapshot> {
        let tables = self.list_tables(schema).await?;
        let mut columns = HashMap::new();
        for t in &tables {
            columns.insert(t.name.clone(), self.describe_table(schema, &t.name).await?);
        }
        Ok(SchemaSnapshot { tables, columns })
    }

    /// Identifier quoting for the driver's dialect.
    /// MySQL = backticks, PostgreSQL = double quotes, etc.
    fn quote_ident(&self, ident: &str) -> String;

    /// Generates the `CREATE TABLE` DDL for this table. Each DBMS decides how:
    ///  - MySQL: `SHOW CREATE TABLE schema.table`, uses the output directly.
    ///  - Postgres: rebuilds from `describe_table` + `list_indexes` +
    ///    `list_foreign_keys` (PG has no direct equivalent).
    /// Default implementation empty — driver with support overrides.
    async fn get_table_ddl(&self, _schema: &str, _table: &str) -> Result<String> {
        Err(crate::Error::Unsupported(
            "get_table_ddl não implementado pelo driver".into(),
        ))
    }

    /// GENERATED columns (STORED/VIRTUAL) of the table. Data-transfer needs
    /// to exclude them from INSERT (MySQL rejects with "The value specified for
    /// generated column is not allowed"). Default: empty list — driver
    /// overrides if the dialect supports generated columns.
    async fn list_generated_columns(
        &self,
        _schema: &str,
        _table: &str,
    ) -> Result<Vec<String>> {
        Ok(Vec::new())
    }

    /// Opens a transaction pinned to a single connection from the pool. Every
    /// operation done via the returned `Txn` uses the SAME conn — resolves the
    /// bug where `execute()` via pool would pick different connections between
    /// START/INSERT/COMMIT, leaving orphan txs. Caller is responsible for
    /// calling `commit()` or `rollback()` — both consume the handle. If the
    /// handle is dropped without finishing, the connection returns to the pool
    /// with the tx pending (use with care — prefer explicit `rollback()` on
    /// the error path).
    ///
    /// Default: `Error::Unsupported` — drivers that support tx override.
    /// Caller should have a fallback to autocommit mode.
    ///
    /// Note: this method does NOT use `async_trait` — see comment in `Txn`
    /// trait about the HRTB bounds sqlx requires.
    fn begin_txn<'a>(
        &'a self,
        _schema: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Box<dyn Txn>>> + Send + 'a>> {
        Box::pin(async {
            Err(crate::Error::Unsupported(
                "begin_txn não implementado pelo driver".into(),
            ))
        })
    }

    /// Total COUNT(*) of table rows. Default uses `query()`.
    async fn count_table_rows(&self, schema: &str, table: &str) -> Result<u64> {
        let sql = format!("SELECT COUNT(*) FROM {}", self.quote_ident(table));
        let q = self.query(Some(schema), &sql).await?;
        let total = q
            .rows
            .first()
            .and_then(|r| r.first())
            .map(|v| match v {
                Value::Int(n) => *n as u64,
                Value::UInt(n) => *n,
                Value::Decimal(d) => d.to_string().parse().unwrap_or(0),
                _ => 0,
            })
            .unwrap_or(0);
        Ok(total)
    }

    /// Updates ONE cell via parameterized query.
    /// `where_cols` is the (column, original_value) list identifying the row
    /// — usually the PK, but for tables without PK it can be all original
    /// columns (delegated to the caller).
    async fn update_cell(
        &self,
        schema: &str,
        table: &str,
        set_column: &str,
        set_value: &Value,
        where_cols: &[(String, Value)],
    ) -> Result<u64>;

    /// Deletes ONE row identified by `where_cols` (PK or all columns).
    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        where_cols: &[(String, Value)],
    ) -> Result<u64>;

    /// Inserts ONE row with only the given columns (the rest use schema defaults).
    /// Returns last_insert_id (0 if the table has no AUTO_INCREMENT).
    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[(String, Value)],
    ) -> Result<u64>;

    /// SELECT * FROM table [ORDER BY col DIR] [LIMIT N OFFSET M].
    /// `limit = 0` means "no LIMIT" (fetches everything).
    /// If the table has 0 rows, falls back to `describe_table` to
    /// populate `columns` — otherwise the front doesn't know the headers.
    async fn select_table_page(
        &self,
        schema: &str,
        table: &str,
        opts: &PageOptions,
    ) -> Result<QueryResult> {
        let mut sql = format!("SELECT * FROM {}", self.quote_ident(table));
        if let Some(ob) = &opts.order_by {
            let dir = match ob.direction {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            sql.push_str(&format!(
                " ORDER BY {} {}",
                self.quote_ident(&ob.column),
                dir
            ));
        }
        if opts.limit > 0 {
            sql.push_str(&format!(" LIMIT {} OFFSET {}", opts.limit, opts.offset));
        }
        let mut q = self.query(Some(schema), &sql).await?;
        if q.columns.is_empty() {
            let cols = self.describe_table(schema, table).await?;
            q.columns = cols.into_iter().map(|c| c.name).collect();
        }
        Ok(q)
    }
}

/// Transaction handle pinned to a single connection. `execute`/`query` run
/// in the tx context (SAME conn). `commit`/`rollback` finalize.
///
/// Thread-safety: `Send` only — atomic use per worker. Don't share
/// between tasks; if concurrency is needed, each worker opens its own.
///
/// Note: this trait does NOT use `async_trait` due to a technical detail — the
/// `async_trait` macro boxes the returned future and the conversion loses the
/// HRTB bounds (`for<'a>`) that sqlx::Executor requires on
/// `&'a mut Connection`. The compiler fails with "Executor is not general
/// enough". Defining the methods as `fn(...) -> Pin<Box<dyn Future>>` manually,
/// the lifetime becomes explicit and sqlx resolves it. See:
/// <https://github.com/launchbadge/sqlx/issues/1170>
pub trait Txn: Send {
    /// Executes SQL on the pinned connection. Results reflect the tx in progress.
    fn execute<'a>(
        &'a mut self,
        sql: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecuteResult>> + Send + 'a>>;

    /// Queries SQL on the pinned connection.
    fn query<'a>(
        &'a mut self,
        sql: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult>> + Send + 'a>>;

    /// Commits the transaction and releases the connection.
    fn commit(
        self: Box<Self>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send>>;

    /// Rollback + releases the connection. Use on the error path.
    fn rollback(
        self: Box<Self>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send>>;
}
