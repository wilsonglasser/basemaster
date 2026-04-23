use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    #[serde(default)]
    pub kind: TableKind,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub row_estimate: Option<u64>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableKind {
    #[default]
    Table,
    View,
    MaterializedView,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub column_type: ColumnType,
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColumnType {
    Integer { bits: u8, unsigned: bool },
    Decimal { precision: u8, scale: u8 },
    Float,
    Double,
    Boolean,
    Text { max_len: Option<u32> },
    Blob { max_len: Option<u32> },
    Json,
    Date,
    Time,
    DateTime,
    Timestamp,
    Enum { values: Vec<String> },
    Set { values: Vec<String> },
    /// Catch-all for DBMS-specific types not yet mapped.
    Other { raw: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub index_type: Option<String>,
}

/// Foreign key. `ref_schema` is None when the FK references
/// another table in the SAME schema (the common case).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(default)]
    pub on_update: Option<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
}

/// "Table-level" (storage-level) options: engine, charset, collation, etc.
/// All optional to accommodate DBMSes that don't have certain fields.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TableOptions {
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    #[serde(default)]
    pub row_format: Option<String>,
    #[serde(default)]
    pub auto_increment: Option<u64>,
    #[serde(default)]
    pub comment: Option<String>,
}
