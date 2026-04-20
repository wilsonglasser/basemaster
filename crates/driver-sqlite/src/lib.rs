//! basemaster-driver-sqlite
//!
//! Implementação SQLite da trait [`basemaster_core::Driver`].
//! SQLite tem UMA database por conexão — tratamos como schema "main".
//! `ConnectionConfig.host` é usado como file path (user/port ignorados).

use std::time::Instant;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::query::Query;
use sqlx::sqlite::{Sqlite, SqliteArguments, SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column as SqlxColumn, ConnectOptions, Row, TypeInfo, ValueRef};
use tokio::sync::RwLock;

use basemaster_core::{
    Column as BmColumn, ColumnType, ConnectionConfig, Driver, Error, ExecuteResult,
    ForeignKeyInfo, IndexInfo, QueryResult, Result, SchemaInfo, TableInfo, TableKind,
    Value,
};

pub struct SqliteDriver {
    pool: RwLock<Option<SqlitePool>>,
    path: RwLock<Option<String>>,
}

impl SqliteDriver {
    pub fn new() -> Self {
        Self {
            pool: RwLock::new(None),
            path: RwLock::new(None),
        }
    }

    async fn pool(&self) -> Result<SqlitePool> {
        self.pool
            .read()
            .await
            .clone()
            .ok_or_else(|| Error::Connection("driver não conectado".into()))
    }
}

impl Default for SqliteDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Driver for SqliteDriver {
    fn dialect(&self) -> &'static str {
        "sqlite"
    }

    fn quote_ident(&self, ident: &str) -> String {
        format!("\"{}\"", ident.replace('"', "\"\""))
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<()> {
        // host carrega o file path.
        let path = config.host.trim();
        if path.is_empty() {
            return Err(Error::Connection("SQLite: file path vazio".into()));
        }
        let mut opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .foreign_keys(true)
            .disable_statement_logging();

        // SQLCipher: PRAGMA key tem que ser o PRIMEIRO comando na conexão.
        // Com sqlx vanilla (sem feature sqlcipher), PRAGMA key é no-op e
        // o DB criptografado não abrirá. Futuro: enable `bundled-sqlcipher`.
        if let Some(pw) = config.password.as_ref().filter(|s| !s.is_empty()) {
            let escaped = pw.replace('\'', "''");
            opts = opts.pragma("key", format!("'{escaped}'"));
        }

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await
            .map_err(|e| Error::Connection(e.to_string()))?;

        *self.pool.write().await = Some(pool);
        *self.path.write().await = Some(path.to_string());
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        if let Some(p) = self.pool.write().await.take() {
            p.close().await;
        }
        Ok(())
    }

    async fn ping(&self) -> Result<()> {
        let pool = self.pool().await?;
        sqlx::query("SELECT 1")
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>> {
        Ok(vec![SchemaInfo {
            name: "main".to_string(),
            charset: None,
            collation: None,
        }])
    }

    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') \
             AND name NOT LIKE 'sqlite_%' \
             ORDER BY type, name",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let name: String = row.try_get("name").unwrap_or_default();
            let type_: String = row.try_get("type").unwrap_or_default();
            let kind = match type_.as_str() {
                "view" => TableKind::View,
                _ => TableKind::Table,
            };
            // row_estimate via COUNT(*) é caro — deixa None; UI pede sob demanda.
            out.push(TableInfo {
                schema: "main".to_string(),
                name,
                kind,
                engine: None,
                row_estimate: None,
                size_bytes: None,
                comment: None,
            });
        }
        Ok(out)
    }

    async fn describe_table(&self, _schema: &str, table: &str) -> Result<Vec<BmColumn>> {
        let pool = self.pool().await?;
        let pragma = format!("PRAGMA table_info({})", self.quote_ident(table));
        let rows = sqlx::query(&pragma)
            .fetch_all(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;

        let mut cols = Vec::with_capacity(rows.len());
        for row in rows {
            let name: String = row.try_get("name").unwrap_or_default();
            let type_: String = row.try_get("type").unwrap_or_default();
            let notnull: i64 = row.try_get("notnull").unwrap_or(0);
            let dflt: Option<String> = row.try_get("dflt_value").ok().flatten();
            let pk: i64 = row.try_get("pk").unwrap_or(0);
            cols.push(BmColumn {
                name,
                column_type: parse_column_type(&type_),
                nullable: notnull == 0,
                default: dflt,
                is_primary_key: pk > 0,
                is_auto_increment: false, // SQLite: INTEGER PRIMARY KEY é implícito
                comment: None,
            });
        }
        Ok(cols)
    }

    async fn list_indexes(&self, _schema: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let pool = self.pool().await?;
        let list_sql = format!("PRAGMA index_list({})", self.quote_ident(table));
        let idx_rows = sqlx::query(&list_sql)
            .fetch_all(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;

        let mut out = Vec::with_capacity(idx_rows.len());
        for idx in idx_rows {
            let name: String = idx.try_get("name").unwrap_or_default();
            let unique: i64 = idx.try_get("unique").unwrap_or(0);
            let origin: String = idx.try_get("origin").ok().unwrap_or_default();

            let info_sql = format!("PRAGMA index_info({})", self.quote_ident(&name));
            let col_rows = sqlx::query(&info_sql)
                .fetch_all(&pool)
                .await
                .map_err(|e| Error::Sql(e.to_string()))?;
            let mut columns: Vec<String> = col_rows
                .iter()
                .map(|r| r.try_get::<String, _>("name").unwrap_or_default())
                .collect();
            columns.retain(|c| !c.is_empty());

            out.push(IndexInfo {
                name,
                columns,
                unique: unique != 0,
                is_primary: origin == "pk",
                index_type: None,
            });
        }
        Ok(out)
    }

    async fn list_foreign_keys(
        &self,
        _schema: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>> {
        let pool = self.pool().await?;
        let pragma = format!("PRAGMA foreign_key_list({})", self.quote_ident(table));
        let rows = sqlx::query(&pragma)
            .fetch_all(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;

        // Agrupa por `id` (cada FK pode ter múltiplas colunas).
        use std::collections::BTreeMap;
        let mut by_id: BTreeMap<i64, ForeignKeyInfo> = BTreeMap::new();
        for row in rows {
            let id: i64 = row.try_get("id").unwrap_or(0);
            let from: String = row.try_get("from").unwrap_or_default();
            let to: String = row.try_get("to").unwrap_or_default();
            let ref_table: String = row.try_get("table").unwrap_or_default();
            let on_update: Option<String> = row.try_get("on_update").ok();
            let on_delete: Option<String> = row.try_get("on_delete").ok();

            let entry = by_id.entry(id).or_insert_with(|| ForeignKeyInfo {
                name: format!("fk_{}_{}", table, id),
                columns: Vec::new(),
                ref_schema: None,
                ref_table: ref_table.clone(),
                ref_columns: Vec::new(),
                on_update: on_update.clone(),
                on_delete: on_delete.clone(),
            });
            entry.columns.push(from);
            entry.ref_columns.push(to);
        }
        Ok(by_id.into_values().collect())
    }

    async fn query(&self, _schema: Option<&str>, sql: &str) -> Result<QueryResult> {
        let pool = self.pool().await?;
        let started = Instant::now();
        let rows = sqlx::raw_sql(sql)
            .fetch_all(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let columns: Vec<String> = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        let decoded_rows: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();
        Ok(QueryResult {
            columns,
            rows: decoded_rows,
            source_table: None,
            elapsed_ms,
            truncated: false,
        })
    }

    async fn execute(&self, _schema: Option<&str>, sql: &str) -> Result<ExecuteResult> {
        let pool = self.pool().await?;
        let started = Instant::now();
        let res = sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(ExecuteResult {
            rows_affected: res.rows_affected(),
            last_insert_id: Some(res.last_insert_rowid() as u64),
            elapsed_ms,
        })
    }

    async fn update_cell(
        &self,
        _schema: &str,
        table: &str,
        set_column: &str,
        set_value: &Value,
        where_cols: &[(String, Value)],
    ) -> Result<u64> {
        if where_cols.is_empty() {
            return Err(Error::Unsupported(
                "update_cell precisa de pelo menos uma coluna no WHERE".into(),
            ));
        }
        let pool = self.pool().await?;
        let where_sql = build_where_clause(self, where_cols);
        let sql = format!(
            "UPDATE {} SET {} = ? WHERE {}",
            self.quote_ident(table),
            self.quote_ident(set_column),
            where_sql,
        );
        let mut q = sqlx::query(&sql);
        q = bind_value(q, set_value);
        for (_, v) in where_cols {
            if !matches!(v, Value::Null) {
                q = bind_value(q, v);
            }
        }
        let res = q
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(res.rows_affected())
    }

    async fn delete_row(
        &self,
        _schema: &str,
        table: &str,
        where_cols: &[(String, Value)],
    ) -> Result<u64> {
        if where_cols.is_empty() {
            return Err(Error::Unsupported(
                "delete_row precisa de pelo menos uma coluna no WHERE".into(),
            ));
        }
        let pool = self.pool().await?;
        let where_sql = build_where_clause(self, where_cols);
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            self.quote_ident(table),
            where_sql,
        );
        let mut q = sqlx::query(&sql);
        for (_, v) in where_cols {
            if !matches!(v, Value::Null) {
                q = bind_value(q, v);
            }
        }
        let res = q
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(res.rows_affected())
    }

    async fn insert_row(
        &self,
        _schema: &str,
        table: &str,
        values: &[(String, Value)],
    ) -> Result<u64> {
        let pool = self.pool().await?;
        if values.is_empty() {
            let sql = format!(
                "INSERT INTO {} DEFAULT VALUES",
                self.quote_ident(table),
            );
            let res = sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| Error::Sql(e.to_string()))?;
            return Ok(res.last_insert_rowid() as u64);
        }
        let cols_sql = values
            .iter()
            .map(|(c, _)| self.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = std::iter::repeat("?")
            .take(values.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            self.quote_ident(table),
            cols_sql,
            placeholders,
        );
        let mut q = sqlx::query(&sql);
        for (_, v) in values {
            q = bind_value(q, v);
        }
        let res = q
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(res.last_insert_rowid() as u64)
    }

    async fn get_table_ddl(&self, _schema: &str, table: &str) -> Result<String> {
        let pool = self.pool().await?;
        let row = sqlx::query("SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1")
            .bind(table)
            .fetch_optional(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        let sql: Option<String> = row.and_then(|r| r.try_get("sql").ok());
        Ok(sql.unwrap_or_default())
    }
}

fn build_where_clause<D: Driver + ?Sized>(
    driver: &D,
    where_cols: &[(String, Value)],
) -> String {
    where_cols
        .iter()
        .map(|(c, v)| {
            if matches!(v, Value::Null) {
                format!("{} IS NULL", driver.quote_ident(c))
            } else {
                format!("{} = ?", driver.quote_ident(c))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn bind_value<'q>(
    q: Query<'q, Sqlite, SqliteArguments<'q>>,
    v: &'q Value,
) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b),
        Value::Int(i) => q.bind(*i),
        Value::UInt(u) => q.bind(*u as i64),
        Value::Float(f) => q.bind(*f),
        Value::Decimal(d) => q.bind(d.to_string()),
        Value::String(s) => q.bind(s.as_str()),
        Value::Json(j) => q.bind(j.to_string()),
        Value::Date(d) => q.bind(*d),
        Value::Time(t) => q.bind(*t),
        Value::DateTime(dt) => q.bind(*dt),
        Value::Timestamp(t) => q.bind(*t),
        Value::Bytes(b) => q.bind(b.clone()),
    }
}

/// Classifica o declared type do SQLite em `ColumnType`. SQLite usa
/// "type affinity" — o tipo declarado é só uma dica.
fn parse_column_type(raw: &str) -> ColumnType {
    let lower = raw.trim().to_lowercase();
    if lower.is_empty() {
        return ColumnType::Other { raw: "".into() };
    }
    // INTEGER/INT → affinity INTEGER
    if lower.contains("int") {
        return ColumnType::Integer {
            bits: 64,
            unsigned: false,
        };
    }
    if lower.contains("char") || lower.contains("clob") || lower.contains("text") {
        return ColumnType::Text { max_len: None };
    }
    if lower.contains("blob") {
        return ColumnType::Blob { max_len: None };
    }
    if lower.contains("real") || lower.contains("floa") || lower.contains("doub") {
        return ColumnType::Double;
    }
    if lower.contains("bool") {
        return ColumnType::Boolean;
    }
    if lower.contains("date") && lower.contains("time") {
        return ColumnType::DateTime;
    }
    if lower.contains("date") {
        return ColumnType::Date;
    }
    if lower.contains("time") {
        return ColumnType::Time;
    }
    if lower.contains("json") {
        return ColumnType::Json;
    }
    if lower.contains("numeric") || lower.contains("decimal") {
        return ColumnType::Decimal {
            precision: 0,
            scale: 0,
        };
    }
    ColumnType::Other { raw: raw.to_string() }
}

fn decode_row(row: &SqliteRow) -> Vec<Value> {
    let cols = row.columns();
    let mut out = Vec::with_capacity(cols.len());
    for (i, col) in cols.iter().enumerate() {
        out.push(decode_one(row, i, col.type_info().name()));
    }
    out
}

fn decode_one(row: &SqliteRow, i: usize, type_name: &str) -> Value {
    // Null check primeiro.
    if let Ok(raw) = row.try_get_raw(i) {
        if raw.is_null() {
            return Value::Null;
        }
    }

    let lower = type_name.to_lowercase();
    // Tipos SQLite: "INTEGER", "TEXT", "REAL", "BLOB", "NULL" ou o declared type.
    if lower.contains("int") {
        if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
            return Value::Int(v);
        }
    }
    if lower.contains("real") || lower.contains("floa") || lower.contains("doub") {
        if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
            return Value::Float(v);
        }
    }
    if lower.contains("blob") {
        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(i) {
            return Value::Bytes(v);
        }
    }
    if lower.contains("bool") {
        if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(i) {
            return Value::Bool(v);
        }
    }
    // Date/Time: sqlite armazena como TEXT. Tenta parse; senão, string.
    if lower.contains("datetime") || lower.contains("timestamp") {
        if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
            if let Ok(dt) = s.parse::<DateTime<Utc>>() {
                return Value::Timestamp(dt);
            }
            if let Ok(naive) = NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S") {
                return Value::DateTime(naive);
            }
            if let Ok(naive) = NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S") {
                return Value::DateTime(naive);
            }
            return Value::String(s);
        }
    }
    if lower.contains("date") {
        if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
            if let Ok(d) = NaiveDate::parse_from_str(&s, "%Y-%m-%d") {
                return Value::Date(d);
            }
            return Value::String(s);
        }
    }
    if lower.contains("time") {
        if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
            if let Ok(t) = NaiveTime::parse_from_str(&s, "%H:%M:%S") {
                return Value::Time(t);
            }
            return Value::String(s);
        }
    }

    // Fallback geral: tenta String → Int → Float → Bytes → Null.
    if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
        return Value::String(s);
    }
    if let Ok(Some(n)) = row.try_get::<Option<i64>, _>(i) {
        return Value::Int(n);
    }
    if let Ok(Some(f)) = row.try_get::<Option<f64>, _>(i) {
        return Value::Float(f);
    }
    if let Ok(Some(b)) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return Value::Bytes(b);
    }
    Value::Null
}
