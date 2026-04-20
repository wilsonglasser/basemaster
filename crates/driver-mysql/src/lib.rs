//! basemaster-driver-mysql
//!
//! Implementação MySQL/MariaDB da trait [`basemaster_core::Driver`].
//! Cada [`MysqlDriver`] encapsula UMA conexão lógica (pool sqlx::MySql).

use std::time::Instant;

use async_trait::async_trait;
use sqlx::mysql::{
    MySql, MySqlArguments, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow,
    MySqlSslMode,
};
use sqlx::query::Query;
use sqlx::{Column, ConnectOptions, Row};
use tokio::sync::RwLock;

/// Lê uma coluna como `String`, com fallback para `Vec<u8>` decodificado
/// como UTF-8. Necessário porque o MySQL às vezes retorna colunas do
/// `information_schema` como `VARBINARY` (depende de charset/collation
/// da sessão vs. do schema).
fn get_str(row: &MySqlRow, idx: usize) -> Option<String> {
    if let Ok(opt) = row.try_get::<Option<String>, _>(idx) {
        return opt;
    }
    if let Ok(opt) = row.try_get::<Option<Vec<u8>>, _>(idx) {
        return opt.and_then(|b| String::from_utf8(b).ok());
    }
    None
}

use basemaster_core::{
    Column as BmColumn, ColumnType, ConnectionConfig, Driver, Error, ExecuteResult, Filter,
    FilterNode, FilterOp, ForeignKeyInfo, GroupOp, IndexInfo, PageOptions, QueryResult, Result,
    SchemaInfo, SchemaSnapshot, SortDir, TableInfo, TableKind, TableOptions, TlsMode, Value,
};

mod value_decode;
use value_decode::decode_row;

pub struct MysqlDriver {
    pool: RwLock<Option<MySqlPool>>,
    default_database: RwLock<Option<String>>,
}

impl MysqlDriver {
    pub fn new() -> Self {
        Self {
            pool: RwLock::new(None),
            default_database: RwLock::new(None),
        }
    }

    async fn pool(&self) -> Result<MySqlPool> {
        self.pool
            .read()
            .await
            .clone()
            .ok_or_else(|| Error::Connection("driver não conectado".into()))
    }
}

impl Default for MysqlDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn map_ssl(tls: &TlsMode) -> MySqlSslMode {
    match tls {
        TlsMode::Disabled => MySqlSslMode::Disabled,
        TlsMode::Preferred => MySqlSslMode::Preferred,
        TlsMode::Required => MySqlSslMode::Required,
    }
}

#[async_trait]
impl Driver for MysqlDriver {
    fn dialect(&self) -> &'static str {
        "mysql"
    }

    fn quote_ident(&self, ident: &str) -> String {
        format!("`{}`", ident.replace('`', "``"))
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<()> {
        let mut opts = MySqlConnectOptions::new()
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

        // Silencia o log "slow statement" do sqlx. Em transferência de
        // dados com BLOBs/embeddings, SELECTs de 1-3s são normais — o
        // warning só polui e consome CPU formatando a mensagem.
        opts = opts.log_slow_statements(tracing::log::LevelFilter::Off, std::time::Duration::ZERO);

        // Timeouts + keepalive:
        //  - acquire_timeout: quanto esperar por uma conexão livre do pool
        //  - idle_timeout: conexões ociosas mais velhas são descartadas
        //    (evita segurar uma conn que o server já matou por wait_timeout)
        //  - max_lifetime: reciclagem periódica pra pegar DNS novo, etc.
        //  - test_before_acquire: PING rápido antes de entregar uma conn
        //    usada — se o server cortou, reabre transparente
        //
        // O `connect_with` tenta estabelecer a primeira conexão. Em redes
        // lentas / hosts bloqueados o TCP connect pode travar por MUITO
        // tempo — envolvemos em timeout explícito pra nunca pendurar a UI.
        let connect_fut = MySqlPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .idle_timeout(Some(std::time::Duration::from_secs(60 * 10)))
            .max_lifetime(Some(std::time::Duration::from_secs(60 * 60)))
            .test_before_acquire(true)
            .connect_with(opts);

        let pool = tokio::time::timeout(std::time::Duration::from_secs(20), connect_fut)
            .await
            .map_err(|_| {
                Error::Connection(format!(
                    "timeout ao conectar em {}:{} (20s)",
                    config.host, config.port
                ))
            })?
            .map_err(|e| Error::Connection(e.to_string()))?;

        *self.pool.write().await = Some(pool.clone());
        *self.default_database.write().await = config.default_database.clone();

        // Keepalive: PING a cada 30s em todas as conns ociosas. Sem isso,
        // servidores com wait_timeout baixo derrubam conns inativas.
        tokio::spawn(keepalive_loop(pool));
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
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        Ok(())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
               FROM information_schema.SCHEMATA
              ORDER BY SCHEMA_NAME",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| SchemaInfo {
                name: get_str(&r, 0).unwrap_or_default(),
                charset: get_str(&r, 1),
                collation: get_str(&r, 2),
            })
            .collect())
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
                    TABLE_COMMENT
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME",
        )
        .bind(schema)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let kind = match get_str(&r, 1).as_deref() {
                    Some("VIEW") => TableKind::View,
                    _ => TableKind::Table,
                };
                let data: Option<i64> = r.try_get(4).ok().flatten();
                let index: Option<i64> = r.try_get(5).ok().flatten();
                let size_bytes = match (data, index) {
                    (Some(d), Some(i)) => Some((d + i).max(0) as u64),
                    (Some(d), None) => Some(d.max(0) as u64),
                    (None, Some(i)) => Some(i.max(0) as u64),
                    _ => None,
                };
                TableInfo {
                    schema: schema.to_string(),
                    name: get_str(&r, 0).unwrap_or_default(),
                    kind,
                    engine: get_str(&r, 2),
                    row_estimate: r
                        .try_get::<Option<i64>, _>(3)
                        .ok()
                        .flatten()
                        .map(|v| v.max(0) as u64),
                    size_bytes,
                    comment: get_str(&r, 6),
                }
            })
            .collect())
    }

    async fn describe_table(&self, schema: &str, table: &str) -> Result<Vec<BmColumn>> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                    COLUMN_KEY, EXTRA, COLUMN_COMMENT
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              ORDER BY ORDINAL_POSITION",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let raw_type = get_str(&r, 1).unwrap_or_default();
                let column_type = parse_column_type(&raw_type);
                let nullable = matches!(get_str(&r, 2).as_deref(), Some("YES"));
                let key = get_str(&r, 4).unwrap_or_default();
                let extra = get_str(&r, 5).unwrap_or_default();
                BmColumn {
                    name: get_str(&r, 0).unwrap_or_default(),
                    column_type,
                    nullable,
                    default: get_str(&r, 3),
                    is_primary_key: key == "PRI",
                    is_auto_increment: extra.to_lowercase().contains("auto_increment"),
                    comment: get_str(&r, 6),
                }
            })
            .collect())
    }

    async fn list_indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let mut by_name: std::collections::BTreeMap<String, IndexInfo> = Default::default();
        for r in rows {
            let name = get_str(&r, 0).unwrap_or_default();
            let column = get_str(&r, 1).unwrap_or_default();
            let non_unique: i64 = r.try_get(2).unwrap_or(1);
            let index_type = get_str(&r, 3);
            by_name
                .entry(name.clone())
                .or_insert_with(|| IndexInfo {
                    name: name.clone(),
                    columns: Vec::new(),
                    unique: non_unique == 0,
                    is_primary: name == "PRIMARY",
                    index_type,
                })
                .columns
                .push(column);
        }
        Ok(by_name.into_values().collect())
    }

    async fn list_foreign_keys(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>> {
        let pool = self.pool().await?;
        // Junta KEY_COLUMN_USAGE (cols) + REFERENTIAL_CONSTRAINTS (ON DELETE/UPDATE).
        let rows = sqlx::query(
            "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
                    k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
                    r.UPDATE_RULE, r.DELETE_RULE, k.ORDINAL_POSITION
               FROM information_schema.KEY_COLUMN_USAGE k
          LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                 ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
                AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
                AND k.REFERENCED_TABLE_NAME IS NOT NULL
           ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let mut by_name: std::collections::BTreeMap<String, ForeignKeyInfo> = Default::default();
        for r in rows {
            let name = get_str(&r, 0).unwrap_or_default();
            let col = get_str(&r, 1).unwrap_or_default();
            let ref_schema = get_str(&r, 2);
            let ref_table = get_str(&r, 3).unwrap_or_default();
            let ref_col = get_str(&r, 4).unwrap_or_default();
            let on_update = get_str(&r, 5);
            let on_delete = get_str(&r, 6);
            let entry = by_name.entry(name.clone()).or_insert_with(|| ForeignKeyInfo {
                name: name.clone(),
                columns: Vec::new(),
                ref_schema: ref_schema.filter(|s| s != schema),
                ref_table: ref_table.clone(),
                ref_columns: Vec::new(),
                on_update,
                on_delete,
            });
            entry.columns.push(col);
            entry.ref_columns.push(ref_col);
        }
        Ok(by_name.into_values().collect())
    }

    async fn table_options(&self, schema: &str, table: &str) -> Result<TableOptions> {
        let pool = self.pool().await?;
        let row = sqlx::query(
            "SELECT ENGINE, TABLE_COLLATION, ROW_FORMAT, AUTO_INCREMENT, TABLE_COMMENT
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              LIMIT 1",
        )
        .bind(schema)
        .bind(table)
        .fetch_optional(&pool)
        .await
        .map_err(|e| Error::Sql(e.to_string()))?;

        let Some(r) = row else {
            return Ok(TableOptions::default());
        };
        let collation = get_str(&r, 1);
        // Deriva charset do prefixo do collation ("utf8mb4_unicode_ci" → "utf8mb4").
        let charset = collation
            .as_ref()
            .and_then(|c| c.split_once('_').map(|(head, _)| head.to_string()));
        Ok(TableOptions {
            engine: get_str(&r, 0),
            charset,
            collation,
            row_format: get_str(&r, 2),
            auto_increment: r
                .try_get::<Option<u64>, _>(3)
                .ok()
                .flatten(),
            comment: get_str(&r, 4).filter(|s| !s.is_empty()),
        })
    }

    async fn query(&self, schema: Option<&str>, sql: &str) -> Result<QueryResult> {
        let pool = self.pool().await?;

        // raw_sql usa o text protocol — evita o ER_UNSUPPORTED_PS (1295)
        // que aparece em comandos não suportados pelo prepared statement
        // protocol. Multi-statement (USE; SELECT) roda na mesma conexão
        // que o pool aloca para a chamada.
        let combined = match schema {
            Some(s) => format!("USE `{}`; {}", escape_ident(s), sql),
            None => sql.to_string(),
        };

        let started = Instant::now();
        let rows = sqlx::raw_sql(&combined)
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

    /// Override com filtros + params bindados. O default da trait usaria
    /// `self.query()` (raw SQL) — aqui usamos `sqlx::query` parametrizado
    /// pra colar valores do usuário com segurança.
    async fn select_table_page(
        &self,
        schema: &str,
        table: &str,
        opts: &PageOptions,
    ) -> Result<QueryResult> {
        let pool = self.pool().await?;
        let mut sql = format!(
            "SELECT * FROM {}.{}",
            self.quote_ident(schema),
            self.quote_ident(table),
        );
        if let Some(tree) = &opts.filter_tree {
            if let Some(clause) = render_node(self, tree) {
                sql.push_str(" WHERE ");
                sql.push_str(&clause);
            }
        }
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

        let started = Instant::now();
        let mut q = sqlx::query(&sql);
        if let Some(tree) = &opts.filter_tree {
            q = bind_node(q, tree);
        }
        let rows = q
            .fetch_all(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let mut columns: Vec<String> = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        if columns.is_empty() {
            let cols = self.describe_table(schema, table).await?;
            columns = cols.into_iter().map(|c| c.name).collect();
        }
        let decoded_rows: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();
        Ok(QueryResult {
            columns,
            rows: decoded_rows,
            source_table: None,
            elapsed_ms,
            truncated: false,
        })
    }

    async fn execute(&self, schema: Option<&str>, sql: &str) -> Result<ExecuteResult> {
        let pool = self.pool().await?;

        let combined = match schema {
            Some(s) => format!("USE `{}`; {}", escape_ident(s), sql),
            None => sql.to_string(),
        };

        let started = Instant::now();
        let res = sqlx::raw_sql(&combined)
            .execute(&pool)
            .await
            .map_err(|e| Error::Sql(e.to_string()))?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        Ok(ExecuteResult {
            rows_affected: res.rows_affected(),
            last_insert_id: Some(res.last_insert_id()),
            elapsed_ms,
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
        if where_cols.is_empty() {
            return Err(Error::Unsupported(
                "update_cell precisa de pelo menos uma coluna no WHERE".into(),
            ));
        }
        let pool = self.pool().await?;
        let where_sql = build_where_clause(self, where_cols);
        let sql = format!(
            "UPDATE {}.{} SET {} = ? WHERE {} LIMIT 1",
            self.quote_ident(schema),
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
        schema: &str,
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
            "DELETE FROM {}.{} WHERE {} LIMIT 1",
            self.quote_ident(schema),
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
        schema: &str,
        table: &str,
        values: &[(String, Value)],
    ) -> Result<u64> {
        if values.is_empty() {
            // Linha totalmente vazia — usa `INSERT INTO x () VALUES ()` que
            // o MySQL aceita e preenche com defaults/AUTO_INCREMENT.
            let pool = self.pool().await?;
            let sql = format!(
                "INSERT INTO {}.{} () VALUES ()",
                self.quote_ident(schema),
                self.quote_ident(table),
            );
            let res = sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| Error::Sql(e.to_string()))?;
            return Ok(res.last_insert_id());
        }
        let pool = self.pool().await?;
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
            "INSERT INTO {}.{} ({}) VALUES ({})",
            self.quote_ident(schema),
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
        Ok(res.last_insert_id())
    }

    async fn get_table_ddl(&self, schema: &str, table: &str) -> Result<String> {
        let qi = |s: &str| format!("`{}`", s.replace('`', "``"));
        let sql = format!("SHOW CREATE TABLE {}.{}", qi(schema), qi(table));
        let q = self.query(Some(schema), &sql).await?;
        q.rows
            .first()
            .and_then(|r| r.get(1))
            .and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .ok_or_else(|| Error::Sql(format!("sem DDL pra {}.{}", schema, table)))
    }

    async fn snapshot_schema(&self, schema: &str) -> Result<SchemaSnapshot> {
        let pool = self.pool().await?;

        // Tabelas — query existente, mas inline pra rodar em paralelo com colunas.
        let tables_fut = self.list_tables(schema);

        // Bulk: TODAS as colunas de TODAS as tabelas do schema em UMA query.
        let cols_fut = sqlx::query(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                    COLUMN_KEY, EXTRA, COLUMN_COMMENT
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(schema)
        .fetch_all(&pool);

        let (tables, col_rows) = tokio::try_join!(
            async { tables_fut.await },
            async { cols_fut.await.map_err(|e| Error::Sql(e.to_string())) }
        )?;

        // Índices do SELECT acima:
        //   0 TABLE_NAME · 1 COLUMN_NAME · 2 COLUMN_TYPE · 3 IS_NULLABLE
        //   4 COLUMN_DEFAULT · 5 COLUMN_KEY · 6 EXTRA · 7 COLUMN_COMMENT
        let mut columns: std::collections::HashMap<String, Vec<BmColumn>> =
            std::collections::HashMap::new();
        for r in col_rows {
            let table = get_str(&r, 0).unwrap_or_default();
            let name = get_str(&r, 1).unwrap_or_default();
            let raw_type = get_str(&r, 2).unwrap_or_default();
            let nullable = matches!(get_str(&r, 3).as_deref(), Some("YES"));
            let default = get_str(&r, 4);
            let key = get_str(&r, 5).unwrap_or_default();
            let extra = get_str(&r, 6).unwrap_or_default();
            let comment = get_str(&r, 7);
            columns.entry(table).or_default().push(BmColumn {
                name,
                column_type: parse_column_type(&raw_type),
                nullable,
                default,
                is_primary_key: key == "PRI",
                is_auto_increment: extra.to_lowercase().contains("auto_increment"),
                comment,
            });
        }

        Ok(SchemaSnapshot { tables, columns })
    }
}

fn escape_ident(s: &str) -> String {
    s.replace('`', "``")
}

/// Loop de keepalive: a cada 30s manda SELECT 1 numa conexão do pool.
/// Para quando o pool é fechado (disconnect) — SELECT retorna erro e a gente sai.
async fn keepalive_loop(pool: MySqlPool) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        if pool.is_closed() {
            break;
        }
        // Ignora erros — test_before_acquire + idle_timeout cuidam da saúde
        // das conexões. Aqui é só pra evitar wait_timeout em servidores estritos.
        let _ = sqlx::query("SELECT 1").execute(&pool).await;
    }
}

/// Renderiza a árvore de filtros. Grupos com 1 filho não emitem parens
/// (evita `((col = ?))`). Grupos vazios retornam None (caller suprime o WHERE).
fn render_node(driver: &MysqlDriver, node: &FilterNode) -> Option<String> {
    match node {
        FilterNode::Leaf { filter } => Some(render_filter_clause(driver, filter)),
        FilterNode::Group { op, children } => {
            let parts: Vec<String> =
                children.iter().filter_map(|c| render_node(driver, c)).collect();
            if parts.is_empty() {
                return None;
            }
            if parts.len() == 1 {
                return parts.into_iter().next();
            }
            let joiner = match op {
                GroupOp::And => " AND ",
                GroupOp::Or => " OR ",
            };
            Some(format!("({})", parts.join(joiner)))
        }
    }
}

/// Binda valores na ordem que `render_node` emitiu os placeholders.
/// Grupos com filhos vazios devem ser pulados pra ordem bater (o filter
/// com 0 bindings em `render_node` retornou None e foi ignorado).
fn bind_node<'q>(
    mut q: Query<'q, MySql, MySqlArguments>,
    node: &'q FilterNode,
) -> Query<'q, MySql, MySqlArguments> {
    match node {
        FilterNode::Leaf { filter } => bind_filter(q, filter),
        FilterNode::Group { children, .. } => {
            // Filtra os que produziriam clause vazia — mesma lógica do render.
            for c in children {
                if produces_clause(c) {
                    q = bind_node(q, c);
                }
            }
            q
        }
    }
}

/// Verifica se um node emite alguma clause (não é grupo vazio).
fn produces_clause(node: &FilterNode) -> bool {
    match node {
        FilterNode::Leaf { .. } => true,
        FilterNode::Group { children, .. } => children.iter().any(produces_clause),
    }
}

/// Renderiza UMA expressão de filtro (coluna + op + placeholders `?`).
/// O caller é responsável por bindar os valores via `bind_filter`.
fn render_filter_clause(driver: &MysqlDriver, f: &Filter) -> String {
    let col = driver.quote_ident(&f.column);
    match f.op {
        FilterOp::Eq => format!("{} = ?", col),
        FilterOp::NotEq => format!("{} <> ?", col),
        FilterOp::Gt => format!("{} > ?", col),
        FilterOp::Lt => format!("{} < ?", col),
        FilterOp::Gte => format!("{} >= ?", col),
        FilterOp::Lte => format!("{} <= ?", col),
        FilterOp::Contains
        | FilterOp::BeginsWith
        | FilterOp::EndsWith => format!("{} LIKE ?", col),
        FilterOp::NotContains
        | FilterOp::NotBeginsWith
        | FilterOp::NotEndsWith => format!("{} NOT LIKE ?", col),
        FilterOp::IsNull => format!("{} IS NULL", col),
        FilterOp::IsNotNull => format!("{} IS NOT NULL", col),
        FilterOp::IsEmpty => format!("{} = ''", col),
        FilterOp::IsNotEmpty => format!("{} <> ''", col),
        FilterOp::Between => format!("{} BETWEEN ? AND ?", col),
        FilterOp::NotBetween => format!("{} NOT BETWEEN ? AND ?", col),
        FilterOp::In => in_list_clause(&col, f, false),
        FilterOp::NotIn => in_list_clause(&col, f, true),
        FilterOp::Custom => {
            // `value` carrega o fragmento raw. Sem binding.
            let frag = match &f.value {
                Some(Value::String(s)) => s.as_str(),
                _ => "",
            };
            format!("{} {}", col, frag)
        }
    }
}

/// Gera o padrão LIKE a partir do value bruto, aplicando os wildcards
/// conforme o operador (contains, begins_with, ends_with).
fn like_pattern(v: &Value, op: FilterOp) -> String {
    let raw = match v {
        Value::String(s) => s.clone(),
        _ => format!("{:?}", v),
    };
    // Escape de _ e % no user input pra não virarem wildcards
    // acidentais. O valor bindado vira um parâmetro LIKE — o '\' escapa
    // os wildcards default no MySQL.
    let escaped = raw.replace('\\', "\\\\").replace('_', "\\_").replace('%', "\\%");
    match op {
        FilterOp::Contains | FilterOp::NotContains => format!("%{}%", escaped),
        FilterOp::BeginsWith | FilterOp::NotBeginsWith => format!("{}%", escaped),
        FilterOp::EndsWith | FilterOp::NotEndsWith => format!("%{}", escaped),
        _ => escaped,
    }
}

/// Para IN/NOT IN: gera `col IN (?, ?, ?)` com N placeholders. N =
/// quantidade de items no value (CSV). Zero itens vira `1=0` (NOT IN → 1=1).
fn in_list_clause(col: &str, f: &Filter, not: bool) -> String {
    let items = split_in_csv(f.value.as_ref());
    let n = items.len();
    if n == 0 {
        return if not { "1=1".into() } else { "1=0".into() };
    }
    let placeholders = std::iter::repeat("?").take(n).collect::<Vec<_>>().join(", ");
    let kw = if not { "NOT IN" } else { "IN" };
    format!("{} {} ({})", col, kw, placeholders)
}

/// Quebra CSV do IN em items crus (sem quotes extras).
fn split_in_csv(v: Option<&Value>) -> Vec<String> {
    let Some(Value::String(s)) = v else {
        return Vec::new();
    };
    s.split(',')
        .map(|p| p.trim().trim_matches('\'').trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn bind_filter<'q>(
    mut q: Query<'q, MySql, MySqlArguments>,
    f: &'q Filter,
) -> Query<'q, MySql, MySqlArguments> {
    match f.op {
        FilterOp::IsNull
        | FilterOp::IsNotNull
        | FilterOp::IsEmpty
        | FilterOp::IsNotEmpty
        | FilterOp::Custom => q,
        FilterOp::In | FilterOp::NotIn => {
            for item in split_in_csv(f.value.as_ref()) {
                q = q.bind(item);
            }
            q
        }
        FilterOp::Contains
        | FilterOp::NotContains
        | FilterOp::BeginsWith
        | FilterOp::NotBeginsWith
        | FilterOp::EndsWith
        | FilterOp::NotEndsWith => {
            let pat = f
                .value
                .as_ref()
                .map(|v| like_pattern(v, f.op))
                .unwrap_or_default();
            q.bind(pat)
        }
        FilterOp::Between | FilterOp::NotBetween => {
            if let Some(v) = &f.value {
                q = bind_value(q, v);
            } else {
                q = q.bind(None::<String>);
            }
            if let Some(v2) = &f.value2 {
                q = bind_value(q, v2);
            } else {
                q = q.bind(None::<String>);
            }
            q
        }
        _ => {
            if let Some(v) = &f.value {
                q = bind_value(q, v);
            } else {
                q = q.bind(None::<String>);
            }
            q
        }
    }
}

/// Monta a WHERE clause, usando `IS NULL` para valores NULL (que não fecham
/// com `col = ?` — comparação com NULL sempre dá UNKNOWN no MySQL).
fn build_where_clause(driver: &MysqlDriver, where_cols: &[(String, Value)]) -> String {
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

/// Bind de um `Value` em uma query sqlx parametrizada do MySQL.
/// Cobre todos os variants. NULL é bindado com `Option::<String>::None`
/// (sqlx infere o tipo).
fn bind_value<'q>(
    q: Query<'q, MySql, MySqlArguments>,
    v: &'q Value,
) -> Query<'q, MySql, MySqlArguments> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b),
        Value::Int(i) => q.bind(*i),
        Value::UInt(u) => q.bind(*u),
        Value::Float(f) => q.bind(*f),
        Value::Decimal(d) => q.bind(*d),
        Value::String(s) => q.bind(s.as_str()),
        Value::Json(j) => q.bind(j.clone()),
        Value::Date(d) => q.bind(*d),
        Value::Time(t) => q.bind(*t),
        Value::DateTime(dt) => q.bind(*dt),
        Value::Timestamp(t) => q.bind(*t),
        Value::Bytes(b) => q.bind(b.clone()),
    }
}

/// Parser leve do `COLUMN_TYPE` do MySQL — só extrai o suficiente para
/// renderizar/categorizar. Tipos exóticos caem em `Other { raw }`.
fn parse_column_type(raw: &str) -> ColumnType {
    let lower = raw.to_lowercase();
    let unsigned = lower.contains("unsigned");

    // `raw` pode ser:
    //   "int(11) unsigned"   → MySQL 5.x
    //   "int unsigned"       → MySQL 8.x (sem display width)
    //   "int"
    //   "decimal(10,2)"
    // Extraímos a primeira palavra, antes de `(` ou espaço.
    let before_paren = lower
        .split_once('(')
        .map(|(h, _)| h)
        .unwrap_or(lower.as_str())
        .trim();
    let head = before_paren
        .split_whitespace()
        .next()
        .unwrap_or(before_paren);

    let inside_parens = lower
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')').map(|(in_p, _)| in_p));

    match head {
        "tinyint" => ColumnType::Integer { bits: 8, unsigned },
        "smallint" => ColumnType::Integer { bits: 16, unsigned },
        "mediumint" => ColumnType::Integer { bits: 24, unsigned },
        "int" | "integer" => ColumnType::Integer { bits: 32, unsigned },
        "bigint" => ColumnType::Integer { bits: 64, unsigned },
        "bool" | "boolean" => ColumnType::Boolean,
        "float" => ColumnType::Float,
        "double" | "real" => ColumnType::Double,
        "decimal" | "numeric" => {
            let (precision, scale) = inside_parens
                .and_then(|p| {
                    let mut parts = p.split(',');
                    let prec = parts.next()?.trim().parse().ok()?;
                    let sc = parts.next()?.trim().parse().ok()?;
                    Some((prec, sc))
                })
                .unwrap_or((10, 0));
            ColumnType::Decimal { precision, scale }
        }
        "char" | "varchar" => ColumnType::Text {
            max_len: inside_parens.and_then(|p| p.trim().parse().ok()),
        },
        "tinytext" | "text" | "mediumtext" | "longtext" => ColumnType::Text { max_len: None },
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            ColumnType::Blob {
                max_len: inside_parens.and_then(|p| p.trim().parse().ok()),
            }
        }
        "json" => ColumnType::Json,
        "date" => ColumnType::Date,
        "time" => ColumnType::Time,
        "datetime" => ColumnType::DateTime,
        "timestamp" => ColumnType::Timestamp,
        "enum" => ColumnType::Enum {
            values: parse_enum_values(inside_parens.unwrap_or("")),
        },
        "set" => ColumnType::Set {
            values: parse_enum_values(inside_parens.unwrap_or("")),
        },
        _ => ColumnType::Other { raw: raw.to_string() },
    }
}

fn parse_enum_values(inside: &str) -> Vec<String> {
    inside
        .split(',')
        .map(|s| s.trim().trim_matches('\'').trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
