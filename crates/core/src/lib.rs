//! basemaster-core
//!
//! Shared models and the `Driver` trait — the contract each DBMS
//! (MySQL, PostgreSQL, SQLite, ...) implements. All of the app's
//! database interaction flows through here.

pub mod connection;
pub mod driver;
pub mod error;
pub mod schema;
pub mod value;

pub use connection::{ConnectionConfig, HttpProxyConfig, SshTunnelConfig, TlsMode};
pub use driver::{
    Driver, ExecuteResult, Filter, FilterNode, FilterOp, GroupOp, OrderBy, PageOptions,
    QueryResult, SchemaSnapshot, SortDir, Txn, TxnFuture,
};
pub use error::{Error, Result};
pub use schema::{
    Column, ColumnType, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo, TableKind, TableOptions,
};
pub use value::Value;
