//! basemaster-core
//!
//! Modelos compartilhados e a trait `Driver` — contrato que cada SGBD
//! (MySQL, PostgreSQL, SQLite, ...) implementa. Toda a interação do app
//! com bancos passa por aqui.

pub mod connection;
pub mod driver;
pub mod error;
pub mod schema;
pub mod value;

pub use connection::{ConnectionConfig, SshTunnelConfig, TlsMode};
pub use driver::{
    Driver, ExecuteResult, Filter, FilterNode, FilterOp, GroupOp, OrderBy, PageOptions,
    QueryResult, SchemaSnapshot, SortDir,
};
pub use error::{Error, Result};
pub use schema::{
    Column, ColumnType, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo, TableKind, TableOptions,
};
pub use value::Value;
