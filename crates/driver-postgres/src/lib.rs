//! basemaster-driver-postgres
//!
//! MVP V1 — covers connection, listing (schemas/tables/indexes/FKs),
//! describe_table, query/execute, simple pagination, per-row CRUD.
//! MySQL-specific features (dump, transfer with SHOW CREATE, triggers)
//! don't support PG yet.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::{Column, ConnectOptions, Row};
use tokio::sync::RwLock;

use basemaster_core::{
    Column as BmColumn, ColumnType, ConnectionConfig, Driver, Error, ExecuteResult,
    ForeignKeyInfo, IndexInfo, PageOptions, QueryResult, Result, SchemaInfo, SortDir,
    TableInfo, TableKind, TableOptions, TlsMode, Value,
};

mod value_decode;
use value_decode::decode_row;

pub struct PostgresDriver {
    pool: RwLock<Option<PgPool>>,
    default_database: RwLock<Option<String>>,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self {
            pool: RwLock::new(None),
            default_database: RwLock::new(None),
        }
    }

    async fn pool(&self) -> Result<PgPool> {
        self.pool
            .read()
            .await
            .clone()
            .ok_or_else(|| Error::Connection("driver não conectado".into()))
    }
}

impl Default for PostgresDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn map_ssl(tls: &TlsMode) -> PgSslMode {
    match tls {
        TlsMode::Disabled => PgSslMode::Disable,
        TlsMode::Preferred => PgSslMode::Prefer,
        TlsMode::Required => PgSslMode::Require,
    }
}

/// Runs `SET search_path TO schema, public` to scope queries without
/// qualification. Closest to MySQL's `USE schema`.
async fn set_search_path(pool: &PgPool, schema: &str) -> Result<()> {
    let quoted = quote_ident_raw(schema);
    let sql = format!("SET search_path TO {}, public", quoted);
    sqlx::query(&sql)
        .execute(pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;
    Ok(())
}

fn quote_ident_raw(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[async_trait]
impl Driver for PostgresDriver {
    fn dialect(&self) -> &'static str {
        "postgres"
    }

    fn quote_ident(&self, ident: &str) -> String {
        quote_ident_raw(ident)
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<()> {
        let mut opts = PgConnectOptions::new()
            .host(&config.host)
            .port(config.port)
            .username(&config.user)
            .ssl_mode(map_ssl(&config.tls));

        if let Some(pwd) = &config.password {
            opts = opts.password(pwd);
        }
        if let Some(db) = &config.default_database {
            if !db.is_empty() {
                opts = opts.database(db);
            }
        }
        opts = opts.log_slow_statements(
            tracing::log::LevelFilter::Off,
            Duration::ZERO,
        );

        let connect_fut = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(15))
            .idle_timeout(Some(Duration::from_secs(60 * 10)))
            .max_lifetime(Some(Duration::from_secs(60 * 60)))
            .test_before_acquire(true)
            .connect_with(opts);

        let pool = tokio::time::timeout(Duration::from_secs(20), connect_fut)
            .await
            .map_err(|_| {
                Error::Connection(format!(
                    "timeout ao conectar em {}:{}",
                    config.host, config.port
                ))
            })?
            .map_err(|e| Error::Connection(e.to_string()))?;

        *self.pool.write().await = Some(pool);
        *self.default_database.write().await = config.default_database.clone();
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        if let Some(pool) = self.pool.write().await.take() {
            pool.close().await;
        }
        Ok(())
    }

    async fn ping(&self) -> Result<()> {
        let pool = self.pool().await?;
        sqlx::query("SELECT 1")
            .fetch_one(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>> {
        let pool = self.pool().await?;
        // Filters system schemas. `pg_catalog`, `information_schema` and
        // `pg_toast*` aren't interesting to the user.
        let rows = sqlx::query(
            "SELECT schema_name
               FROM information_schema.schemata
              WHERE schema_name NOT IN ('pg_catalog','information_schema')
                AND schema_name NOT LIKE 'pg_toast%'
                AND schema_name NOT LIKE 'pg_temp%'
              ORDER BY schema_name",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| SchemaInfo {
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                charset: None,
                collation: None,
            })
            .collect())
    }

    async fn list_generated_columns(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<String>> {
        let pool = self.pool().await?;
        // PG 12+: pg_attribute.attgenerated = 's' (STORED) or '' (regular).
        // attidentity ('a'/'d') is IDENTITY, NOT GENERATED — it's insertable
        // (override via OVERRIDING SYSTEM VALUE), so we don't filter here.
        let rows = sqlx::query(
            "SELECT a.attname
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2
                AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attgenerated <> ''",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect())
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>> {
        let pool = self.pool().await?;
        // Tables + views via pg_catalog. `reltuples` is the planner's
        // estimate — good enough for the UI. `pg_total_relation_size`
        // includes indexes + TOAST (comparable to DATA+INDEX in MySQL).
        let rows = sqlx::query(
            "SELECT c.relname,
                    c.relkind,
                    c.reltuples::BIGINT AS row_estimate,
                    pg_total_relation_size(c.oid)::BIGINT AS size_bytes,
                    obj_description(c.oid, 'pg_class') AS comment
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1
                AND c.relkind IN ('r','v','m','p')
              ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let relkind: String = r.try_get(1).unwrap_or_else(|_| "r".to_string());
            let rows_est: Option<i64> = r.try_get(2).ok();
            let size_bytes: Option<i64> = r.try_get(3).ok();
            let comment: Option<String> = r.try_get(4).ok().flatten();
            let kind = match relkind.as_str() {
                "v" => TableKind::View,
                "m" => TableKind::MaterializedView,
                _ => TableKind::Table,
            };
            out.push(TableInfo {
                schema: schema.to_string(),
                name,
                kind,
                engine: None,
                row_estimate: rows_est.map(|n| n.max(0) as u64),
                size_bytes: size_bytes.map(|n| n.max(0) as u64),
                comment,
            });
        }
        Ok(out)
    }

    async fn describe_table(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<BmColumn>> {
        let pool = self.pool().await?;
        // Gets name, textual type, nullability, default, PK and whether it's
        // identity/serial (auto-increment). Comments via col_description.
        let rows = sqlx::query(
            "SELECT
               a.attname AS name,
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
               NOT a.attnotnull AS is_nullable,
               pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
               a.attidentity <> '' OR COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '') LIKE 'nextval(%'
                 AS is_auto,
               col_description(c.oid, a.attnum) AS comment,
               COALESCE((
                 SELECT true FROM pg_index i
                  WHERE i.indrelid = c.oid AND i.indisprimary
                    AND a.attnum = ANY(i.indkey)
                 LIMIT 1
               ), false) AS is_pk
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_attrdef ad
               ON ad.adrelid = c.oid AND ad.adnum = a.attnum
            WHERE n.nspname = $1
              AND c.relname = $2
              AND a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY a.attnum",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let mut cols = Vec::with_capacity(rows.len());
        for r in rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let data_type: String = r.try_get(1).unwrap_or_default();
            let nullable: bool = r.try_get(2).unwrap_or(true);
            let default: Option<String> = r.try_get(3).ok().flatten();
            let is_auto: bool = r.try_get(4).unwrap_or(false);
            let comment: Option<String> = r.try_get(5).ok().flatten();
            let is_pk: bool = r.try_get(6).unwrap_or(false);
            cols.push(BmColumn {
                name,
                column_type: parse_pg_type(&data_type),
                nullable,
                default,
                is_primary_key: is_pk,
                is_auto_increment: is_auto,
                comment,
            });
        }
        Ok(cols)
    }

    async fn list_indexes(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<IndexInfo>> {
        let pool = self.pool().await?;
        // pg_index + join with attributes — lists columns in order.
        let rows = sqlx::query(
            "SELECT i.relname AS index_name,
                    a.attname AS column_name,
                    ix.indisunique AS is_unique,
                    am.amname AS index_type,
                    ix.indisprimary AS is_primary
               FROM pg_class t
               JOIN pg_namespace n ON n.oid = t.relnamespace
               JOIN pg_index ix ON ix.indrelid = t.oid
               JOIN pg_class i ON i.oid = ix.indexrelid
               JOIN pg_am am ON am.oid = i.relam
               JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                    ON TRUE
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
              WHERE n.nspname = $1
                AND t.relname = $2
              ORDER BY i.relname, k.ord",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        // Group by index_name.
        let mut idx_map: std::collections::BTreeMap<String, IndexInfo> =
            std::collections::BTreeMap::new();
        for r in rows {
            let index_name: String = r.try_get(0).unwrap_or_default();
            let col: String = r.try_get(1).unwrap_or_default();
            let unique: bool = r.try_get(2).unwrap_or(false);
            let itype: String = r.try_get(3).unwrap_or_default();
            let is_pk: bool = r.try_get(4).unwrap_or(false);
            let entry = idx_map.entry(index_name.clone()).or_insert(IndexInfo {
                name: index_name.clone(),
                columns: Vec::new(),
                unique,
                is_primary: is_pk,
                index_type: Some(itype.to_uppercase()),
            });
            entry.columns.push(col);
        }
        Ok(idx_map.into_values().collect())
    }

    async fn list_foreign_keys(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>> {
        let pool = self.pool().await?;
        // Lists FKs via pg_constraint; `conkey`/`confkey` are arrays of
        // attnum — we need to expand them preserving order.
        let rows = sqlx::query(
            "SELECT c.conname,
                    fns.nspname,
                    fc.relname AS ref_table,
                    c.conupdtype,
                    c.confdeltype,
                    a.attname AS local_col,
                    af.attname AS ref_col,
                    k.ord
               FROM pg_constraint c
               JOIN pg_class tc ON tc.oid = c.conrelid
               JOIN pg_namespace tns ON tns.oid = tc.relnamespace
               JOIN pg_class fc ON fc.oid = c.confrelid
               JOIN pg_namespace fns ON fns.oid = fc.relnamespace
               JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                    ON TRUE
               JOIN unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord)
                    ON fk.ord = k.ord
               JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k.attnum
               JOIN pg_attribute af
                    ON af.attrelid = c.confrelid AND af.attnum = fk.attnum
              WHERE tns.nspname = $1
                AND tc.relname = $2
                AND c.contype = 'f'
              ORDER BY c.conname, k.ord",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let mut fk_map: std::collections::BTreeMap<String, ForeignKeyInfo> =
            std::collections::BTreeMap::new();
        for r in rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let ref_schema: String = r.try_get(1).unwrap_or_default();
            let ref_table: String = r.try_get(2).unwrap_or_default();
            let on_update: String = r.try_get::<String, _>(3).unwrap_or_default();
            let on_delete: String = r.try_get::<String, _>(4).unwrap_or_default();
            let col: String = r.try_get(5).unwrap_or_default();
            let ref_col: String = r.try_get(6).unwrap_or_default();
            let entry = fk_map.entry(name.clone()).or_insert(ForeignKeyInfo {
                name: name.clone(),
                columns: Vec::new(),
                ref_schema: Some(ref_schema.clone()),
                ref_table: ref_table.clone(),
                ref_columns: Vec::new(),
                on_update: Some(map_fk_action(&on_update)),
                on_delete: Some(map_fk_action(&on_delete)),
            });
            entry.columns.push(col);
            entry.ref_columns.push(ref_col);
        }
        Ok(fk_map.into_values().collect())
    }

    async fn table_options(
        &self,
        _schema: &str,
        _table: &str,
    ) -> Result<TableOptions> {
        // PG has no engine/row_format; we return defaults.
        Ok(TableOptions::default())
    }

    async fn query(
        &self,
        schema: Option<&str>,
        sql: &str,
    ) -> Result<QueryResult> {
        let pool = self.pool().await?;
        if let Some(sch) = schema {
            if !sch.is_empty() {
                set_search_path(&pool, sch).await?;
            }
        }
        let started = Instant::now();
        let rows = sqlx::query(sql)
            .fetch_all(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let columns: Vec<String> = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        let data: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();
        Ok(QueryResult {
            columns,
            rows: data,
            source_table: None,
            elapsed_ms,
            truncated: false,
        })
    }

    async fn execute(
        &self,
        schema: Option<&str>,
        sql: &str,
    ) -> Result<ExecuteResult> {
        let pool = self.pool().await?;
        if let Some(sch) = schema {
            if !sch.is_empty() {
                set_search_path(&pool, sch).await?;
            }
        }
        let started = Instant::now();
        let r = sqlx::query(sql)
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(ExecuteResult {
            rows_affected: r.rows_affected(),
            last_insert_id: None, // PG has no simple equivalent; RETURNING via query.
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn update_cell(
        &self,
        schema: &str,
        table: &str,
        set_column: &str,
        set_value: &Value,
        where_cols: &[(String, Value)],
    ) -> Result<u64> {
        let pool = self.pool().await?;
        let qi = |s: &str| quote_ident_raw(s);
        let where_parts: Vec<String> = where_cols
            .iter()
            .enumerate()
            .map(|(i, (c, _))| format!("{} = ${}", qi(c), i + 2))
            .collect();
        let sql = format!(
            "UPDATE {}.{} SET {} = $1 WHERE {}",
            qi(schema),
            qi(table),
            qi(set_column),
            where_parts.join(" AND "),
        );
        let mut q = sqlx::query(&sql);
        q = bind_value(q, set_value);
        for (_, v) in where_cols {
            q = bind_value(q, v);
        }
        let r = q
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(r.rows_affected())
    }

    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        where_cols: &[(String, Value)],
    ) -> Result<u64> {
        let pool = self.pool().await?;
        let qi = |s: &str| quote_ident_raw(s);
        let where_parts: Vec<String> = where_cols
            .iter()
            .enumerate()
            .map(|(i, (c, _))| format!("{} = ${}", qi(c), i + 1))
            .collect();
        let sql = format!(
            "DELETE FROM {}.{} WHERE {}",
            qi(schema),
            qi(table),
            where_parts.join(" AND "),
        );
        let mut q = sqlx::query(&sql);
        for (_, v) in where_cols {
            q = bind_value(q, v);
        }
        let r = q
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(r.rows_affected())
    }

    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[(String, Value)],
    ) -> Result<u64> {
        let pool = self.pool().await?;
        let qi = |s: &str| quote_ident_raw(s);
        if values.is_empty() {
            let sql = format!(
                "INSERT INTO {}.{} DEFAULT VALUES",
                qi(schema),
                qi(table)
            );
            sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| Error::Sql(e.to_string()))?;
            return Ok(0);
        }
        let cols: Vec<String> = values.iter().map(|(c, _)| qi(c)).collect();
        let placeholders: Vec<String> =
            (1..=values.len()).map(|i| format!("${}", i)).collect();
        let sql = format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            qi(schema),
            qi(table),
            cols.join(", "),
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (_, v) in values {
            q = bind_value(q, v);
        }
        let _r = q
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(0)
    }

    async fn get_table_ddl(&self, schema: &str, table: &str) -> Result<String> {
        let cols = self.describe_table(schema, table).await?;
        let indexes = self.list_indexes(schema, table).await?;
        let fks = self.list_foreign_keys(schema, table).await?;
        Ok(build_create_table(schema, table, &cols, &indexes, &fks))
    }

    async fn select_table_page(
        &self,
        schema: &str,
        table: &str,
        opts: &PageOptions,
    ) -> Result<QueryResult> {
        let qi = |s: &str| quote_ident_raw(s);
        let mut sql = format!("SELECT * FROM {}.{}", qi(schema), qi(table));
        if let Some(ob) = &opts.order_by {
            let dir = match ob.direction {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            sql.push_str(&format!(" ORDER BY {} {}", qi(&ob.column), dir));
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

fn bind_value<'a>(
    q: sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments>,
    v: &'a Value,
) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match v {
        Value::Null => q.bind::<Option<i64>>(None),
        Value::Bool(b) => q.bind(*b),
        Value::Int(i) => q.bind(*i),
        Value::UInt(u) => q.bind(*u as i64),
        Value::Float(f) => q.bind(*f),
        Value::Decimal(d) => q.bind(*d),
        Value::String(s) => q.bind(s.as_str()),
        Value::Bytes(b) => q.bind(b.as_slice()),
        Value::Json(j) => q.bind(j),
        Value::Date(d) => q.bind(*d),
        Value::Time(t) => q.bind(*t),
        Value::DateTime(dt) => q.bind(*dt),
        Value::Timestamp(ts) => q.bind(*ts),
    }
}

fn map_fk_action(code: &str) -> String {
    match code {
        "a" => "NO ACTION".into(),
        "r" => "RESTRICT".into(),
        "c" => "CASCADE".into(),
        "n" => "SET NULL".into(),
        "d" => "SET DEFAULT".into(),
        _ => "NO ACTION".into(),
    }
}

/// Best-effort conversion from `format_type` output to the ColumnType enum.
/// Covers the most common ones; the rest falls into `Other`.
fn parse_pg_type(raw: &str) -> ColumnType {
    let lower = raw.to_lowercase();
    let base = lower.split('(').next().unwrap_or(&lower).trim();
    match base {
        "smallint" | "int2" => ColumnType::Integer { bits: 16u8, unsigned: false },
        "integer" | "int" | "int4" => {
            ColumnType::Integer { bits: 32u8, unsigned: false }
        }
        "bigint" | "int8" => ColumnType::Integer { bits: 64u8, unsigned: false },
        "real" | "float4" => ColumnType::Float,
        "double precision" | "float8" => ColumnType::Double,
        "numeric" | "decimal" => {
            // format_type returns "numeric(10,2)".
            let (p, s) = parse_numeric_params(&lower).unwrap_or((0, 0));
            ColumnType::Decimal { precision: p, scale: s }
        }
        "boolean" | "bool" => ColumnType::Boolean,
        "text" => ColumnType::Text { max_len: None },
        "character varying" | "varchar" => {
            let max = parse_text_len(&lower);
            ColumnType::Text { max_len: max }
        }
        "character" | "char" | "bpchar" => {
            let max = parse_text_len(&lower);
            ColumnType::Text { max_len: max }
        }
        "bytea" => ColumnType::Blob { max_len: None },
        "date" => ColumnType::Date,
        "time" | "time without time zone" | "time with time zone" => ColumnType::Time,
        "timestamp" | "timestamp without time zone" => ColumnType::DateTime,
        "timestamp with time zone" | "timestamptz" => ColumnType::Timestamp,
        "json" | "jsonb" => ColumnType::Json,
        _ => ColumnType::Other { raw: raw.to_string() },
    }
}

fn parse_text_len(s: &str) -> Option<u32> {
    let lp = s.find('(')?;
    let rp = s.find(')')?;
    s[lp + 1..rp].parse::<u32>().ok()
}

fn parse_numeric_params(s: &str) -> Option<(u8, u8)> {
    let lp = s.find('(')?;
    let rp = s.find(')')?;
    let inside = &s[lp + 1..rp];
    let mut parts = inside.split(',');
    let p = parts.next()?.trim().parse::<u8>().ok()?;
    let sc = parts.next().map(|v| v.trim().parse::<u8>().unwrap_or(0)).unwrap_or(0);
    Some((p, sc))
}

/// Rebuilds `CREATE TABLE ... ;` from schema introspection.
/// PG has no `SHOW CREATE TABLE` — this is the substitute.
fn build_create_table(
    schema: &str,
    table: &str,
    cols: &[BmColumn],
    indexes: &[IndexInfo],
    fks: &[ForeignKeyInfo],
) -> String {
    let qi = quote_ident_raw;
    let mut out = String::new();
    out.push_str(&format!(
        "CREATE TABLE {}.{} (\n",
        qi(schema),
        qi(table)
    ));

    // 1. Columns.
    let mut parts: Vec<String> = Vec::new();
    for c in cols {
        let ty = pg_type_for(&c.column_type);
        let mut line = format!("  {} {}", qi(&c.name), ty);
        if !c.nullable {
            line.push_str(" NOT NULL");
        }
        if c.is_auto_increment {
            // Preference: IDENTITY over SERIAL (PG 10+). If already has a
            // nextval default, respect it — otherwise emit IDENTITY.
            let has_nextval_default = c
                .default
                .as_deref()
                .map(|d| d.to_lowercase().contains("nextval("))
                .unwrap_or(false);
            if !has_nextval_default {
                line.push_str(" GENERATED BY DEFAULT AS IDENTITY");
            } else if let Some(d) = &c.default {
                line.push_str(&format!(" DEFAULT {}", d));
            }
        } else if let Some(d) = &c.default {
            line.push_str(&format!(" DEFAULT {}", d));
        }
        parts.push(line);
    }

    // 2. PRIMARY KEY (via index with is_primary).
    for idx in indexes {
        if idx.is_primary {
            let pk_cols: Vec<String> =
                idx.columns.iter().map(|c| qi(c)).collect();
            parts.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
            break;
        }
    }

    // 3. UNIQUE constraints (unique non-PK indexes).
    for idx in indexes {
        if idx.unique && !idx.is_primary {
            let ucols: Vec<String> =
                idx.columns.iter().map(|c| qi(c)).collect();
            parts.push(format!(
                "  CONSTRAINT {} UNIQUE ({})",
                qi(&idx.name),
                ucols.join(", ")
            ));
        }
    }

    // 4. Foreign keys.
    for fk in fks {
        let local: Vec<String> = fk.columns.iter().map(|c| qi(c)).collect();
        let foreign: Vec<String> =
            fk.ref_columns.iter().map(|c| qi(c)).collect();
        let ref_sch = fk.ref_schema.as_deref().unwrap_or(schema);
        let mut line = format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
            qi(&fk.name),
            local.join(", "),
            qi(ref_sch),
            qi(&fk.ref_table),
            foreign.join(", ")
        );
        if let Some(act) = &fk.on_update {
            if !act.is_empty() && act != "NO ACTION" {
                line.push_str(&format!(" ON UPDATE {}", act));
            }
        }
        if let Some(act) = &fk.on_delete {
            if !act.is_empty() && act != "NO ACTION" {
                line.push_str(&format!(" ON DELETE {}", act));
            }
        }
        parts.push(line);
    }

    out.push_str(&parts.join(",\n"));
    out.push_str("\n);\n");

    // 5. Non-unique indexes — go outside the CREATE TABLE.
    for idx in indexes {
        if idx.is_primary || idx.unique {
            continue;
        }
        let icols: Vec<String> = idx.columns.iter().map(|c| qi(c)).collect();
        out.push_str(&format!(
            "CREATE INDEX {} ON {}.{} ({});\n",
            qi(&idx.name),
            qi(schema),
            qi(table),
            icols.join(", ")
        ));
    }

    out
}

/// Converts the `ColumnType` back to a PG SQL string.
fn pg_type_for(ct: &ColumnType) -> String {
    match ct {
        ColumnType::Integer { bits, .. } => match bits {
            16 => "SMALLINT".into(),
            64 => "BIGINT".into(),
            _ => "INTEGER".into(),
        },
        ColumnType::Decimal { precision, scale } => {
            if *precision == 0 {
                "NUMERIC".into()
            } else if *scale == 0 {
                format!("NUMERIC({})", precision)
            } else {
                format!("NUMERIC({},{})", precision, scale)
            }
        }
        ColumnType::Float => "REAL".into(),
        ColumnType::Double => "DOUBLE PRECISION".into(),
        ColumnType::Boolean => "BOOLEAN".into(),
        ColumnType::Text { max_len } => match max_len {
            Some(n) => format!("VARCHAR({})", n),
            None => "TEXT".into(),
        },
        ColumnType::Blob { .. } => "BYTEA".into(),
        ColumnType::Json => "JSONB".into(),
        ColumnType::Date => "DATE".into(),
        ColumnType::Time => "TIME".into(),
        ColumnType::DateTime => "TIMESTAMP".into(),
        ColumnType::Timestamp => "TIMESTAMPTZ".into(),
        ColumnType::Enum { .. } => "TEXT".into(),
        ColumnType::Set { .. } => "TEXT".into(),
        ColumnType::Other { raw } => raw.clone(),
    }
}
