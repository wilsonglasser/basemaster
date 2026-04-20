use std::collections::HashMap;

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

/// Identifica que o resultado provem de um único SELECT sobre uma tabela
/// conhecida — habilita edição in-grid com UPDATE/DELETE seguros.
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

/// Snapshot completo de um schema — tabelas + colunas de cada uma —
/// usado para alimentar autocomplete sem N round-trips.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub tables: Vec<TableInfo>,
    /// `table_name -> columns` (ordem original de declaração).
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

/// Operadores suportados nos filtros de `select_table_page`.
/// Parametrizados via sqlx — cada backend binda o `Value` com segurança.
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
    /// `col BETWEEN ? AND ?` — usa value + value2
    Between,
    NotBetween,
    /// `col IN (?, ?, ?)` — value é CSV
    In,
    NotIn,
    /// Fragmento raw após o ident da coluna, ex: `> 10 AND < 20`.
    /// NÃO é parametrizado — destinado a escape hatch avançado.
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    /// Valor principal. Ignorado em IsNull/IsNotNull/IsEmpty/IsNotEmpty.
    /// Para Custom: string com o fragmento SQL a concatenar após a coluna.
    #[serde(default)]
    pub value: Option<Value>,
    /// Segundo valor (usado só em Between/NotBetween).
    #[serde(default)]
    pub value2: Option<Value>,
}

/// Operador de combinação em grupos de filtros.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupOp {
    And,
    Or,
}

/// Árvore de filtros — folhas são `Filter`, grupos combinam filhos via
/// AND/OR. Grupos podem aninhar indefinidamente.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterNode {
    Leaf { filter: Filter },
    Group { op: GroupOp, children: Vec<FilterNode> },
}

/// Opções de paginação + ordenação + filtros para `select_table_page`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageOptions {
    pub limit: u64,
    pub offset: u64,
    #[serde(default)]
    pub order_by: Option<OrderBy>,
    /// Árvore de filtros (grupos AND/OR aninhados). None = sem WHERE.
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

/// Contrato que cada SGBD implementa. Toda operação de banco
/// do BaseMaster passa por esta trait.
#[async_trait]
pub trait Driver: Send + Sync {
    /// Identificador do dialeto ("mysql", "postgres", "sqlite").
    fn dialect(&self) -> &'static str;

    async fn connect(&self, config: &ConnectionConfig) -> Result<()>;
    async fn disconnect(&self) -> Result<()>;
    async fn ping(&self) -> Result<()>;

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>>;
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>>;
    async fn describe_table(&self, schema: &str, table: &str) -> Result<Vec<Column>>;
    async fn list_indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>>;

    /// Lista chaves estrangeiras da tabela. Default: vazio (SGBDs que
    /// não suportam podem apenas não sobrescrever).
    async fn list_foreign_keys(
        &self,
        _schema: &str,
        _table: &str,
    ) -> Result<Vec<ForeignKeyInfo>> {
        Ok(Vec::new())
    }

    /// Opções "storage-level" da tabela (engine, charset, AUTO_INCREMENT…).
    /// Default: tudo None.
    async fn table_options(&self, _schema: &str, _table: &str) -> Result<TableOptions> {
        Ok(TableOptions::default())
    }

    async fn query(&self, schema: Option<&str>, sql: &str) -> Result<QueryResult>;
    async fn execute(&self, schema: Option<&str>, sql: &str) -> Result<ExecuteResult>;

    /// Prefetch otimizado: tabelas + colunas de todas elas. Default
    /// implementation faz N+1 (list_tables + describe N), cada driver
    /// pode sobrescrever com uma única query bulk.
    async fn snapshot_schema(&self, schema: &str) -> Result<SchemaSnapshot> {
        let tables = self.list_tables(schema).await?;
        let mut columns = HashMap::new();
        for t in &tables {
            columns.insert(t.name.clone(), self.describe_table(schema, &t.name).await?);
        }
        Ok(SchemaSnapshot { tables, columns })
    }

    /// Quoting de identificador para o dialeto do driver.
    /// MySQL = backticks, PostgreSQL = aspas duplas, etc.
    fn quote_ident(&self, ident: &str) -> String;

    /// Gera o DDL `CREATE TABLE` pra essa tabela. Cada SGBD decide como:
    ///  - MySQL: `SHOW CREATE TABLE schema.table`, usa o output direto.
    ///  - Postgres: reconstrói do `describe_table` + `list_indexes` +
    ///    `list_foreign_keys` (PG não tem equivalente direto).
    /// Default implementation vazia — driver que suporta override.
    async fn get_table_ddl(&self, _schema: &str, _table: &str) -> Result<String> {
        Err(crate::Error::Unsupported(
            "get_table_ddl não implementado pelo driver".into(),
        ))
    }

    /// COUNT(*) total de linhas da tabela. Default usa `query()`.
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

    /// Atualiza UMA célula via parameterized query.
    /// `where_cols` é a lista (column, original_value) que identifica a linha
    /// — costuma ser a PK, mas para tabelas sem PK pode ser todas as colunas
    /// originais (delegado ao caller).
    async fn update_cell(
        &self,
        schema: &str,
        table: &str,
        set_column: &str,
        set_value: &Value,
        where_cols: &[(String, Value)],
    ) -> Result<u64>;

    /// Deleta UMA linha identificada por `where_cols` (PK ou todas as colunas).
    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        where_cols: &[(String, Value)],
    ) -> Result<u64>;

    /// Insere UMA linha com apenas as colunas dadas (o resto usa default do schema).
    /// Retorna o last_insert_id (0 se a tabela não tem AUTO_INCREMENT).
    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[(String, Value)],
    ) -> Result<u64>;

    /// SELECT * FROM table [ORDER BY col DIR] [LIMIT N OFFSET M].
    /// `limit = 0` significa "sem LIMIT" (traz tudo).
    /// Se a tabela tiver 0 linhas, faz fallback para `describe_table` pra
    /// popular `columns` — senão o front não sabe os cabeçalhos.
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
