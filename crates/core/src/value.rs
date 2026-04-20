use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Valor genérico de célula — agnóstico ao SGBD.
///
/// Cada driver converte seus tipos nativos para `Value`. O front recebe
/// via `serde_json` e formata conforme o tipo.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Decimal(Decimal),
    String(String),
    Bytes(Vec<u8>),
    Json(serde_json::Value),
    Date(NaiveDate),
    Time(NaiveTime),
    DateTime(NaiveDateTime),
    Timestamp(DateTime<Utc>),
}

impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}
