//! Conversão de linha sqlx::MySql → Vec<basemaster_core::Value>.
//!
//! Estratégia: usar `Column::type_info().name()` e tentar o decode tipado
//! correto. Tipos não cobertos caem em fallback `String → Bytes → Null`.

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use sqlx::mysql::MySqlRow;
use sqlx::{Column, Row, TypeInfo};

use basemaster_core::Value;

pub fn decode_row(row: &MySqlRow) -> Vec<Value> {
    let cols = row.columns();
    let mut out = Vec::with_capacity(cols.len());
    for (i, col) in cols.iter().enumerate() {
        let type_name = col.type_info().name().to_uppercase();
        out.push(decode_one(row, i, &type_name));
    }
    out
}

fn decode_one(row: &MySqlRow, i: usize, type_name: &str) -> Value {
    macro_rules! tg {
        ($ty:ty) => {{
            match row.try_get::<Option<$ty>, _>(i) {
                Ok(Some(v)) => Some(v),
                Ok(None) => None,
                Err(_) => return decode_fallback(row, i),
            }
        }};
    }

    match type_name {
        "TINYINT" => match tg!(i8) {
            Some(v) => Value::Int(v as i64),
            None => Value::Null,
        },
        "TINYINT UNSIGNED" => match tg!(u8) {
            Some(v) => Value::UInt(v as u64),
            None => Value::Null,
        },
        "SMALLINT" => match tg!(i16) {
            Some(v) => Value::Int(v as i64),
            None => Value::Null,
        },
        "SMALLINT UNSIGNED" => match tg!(u16) {
            Some(v) => Value::UInt(v as u64),
            None => Value::Null,
        },
        "MEDIUMINT" | "INT" | "INTEGER" => match tg!(i32) {
            Some(v) => Value::Int(v as i64),
            None => Value::Null,
        },
        "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "INTEGER UNSIGNED" => match tg!(u32) {
            Some(v) => Value::UInt(v as u64),
            None => Value::Null,
        },
        "BIGINT" => match tg!(i64) {
            Some(v) => Value::Int(v),
            None => Value::Null,
        },
        "BIGINT UNSIGNED" => match tg!(u64) {
            Some(v) => Value::UInt(v),
            None => Value::Null,
        },
        "FLOAT" => match tg!(f32) {
            Some(v) => Value::Float(v as f64),
            None => Value::Null,
        },
        "DOUBLE" => match tg!(f64) {
            Some(v) => Value::Float(v),
            None => Value::Null,
        },
        "DECIMAL" | "NUMERIC" => match tg!(Decimal) {
            Some(v) => Value::Decimal(v),
            None => Value::Null,
        },
        "BOOLEAN" => match tg!(bool) {
            Some(v) => Value::Bool(v),
            None => Value::Null,
        },
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            match tg!(String) {
                Some(v) => Value::String(v),
                None => Value::Null,
            }
        }
        "JSON" => match tg!(serde_json::Value) {
            Some(v) => Value::Json(v),
            None => Value::Null,
        },
        "DATE" => match tg!(NaiveDate) {
            Some(v) => Value::Date(v),
            None => Value::Null,
        },
        "TIME" => match tg!(NaiveTime) {
            Some(v) => Value::Time(v),
            None => Value::Null,
        },
        "DATETIME" => match tg!(NaiveDateTime) {
            Some(v) => Value::DateTime(v),
            None => Value::Null,
        },
        "TIMESTAMP" => match tg!(DateTime<Utc>) {
            Some(v) => Value::Timestamp(v),
            None => Value::Null,
        },
        "YEAR" => match tg!(i16) {
            Some(v) => Value::Int(v as i64),
            None => Value::Null,
        },
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT" => {
            match tg!(Vec<u8>) {
                Some(v) => Value::Bytes(v),
                None => Value::Null,
            }
        }
        _ => decode_fallback(row, i),
    }
}

/// Quando o tipo é desconhecido ou o decode tipado falha, tenta String,
/// depois bytes brutos, e por fim devolve Null.
fn decode_fallback(row: &MySqlRow, i: usize) -> Value {
    if let Ok(opt) = row.try_get::<Option<String>, _>(i) {
        return opt.map(Value::String).unwrap_or(Value::Null);
    }
    if let Ok(opt) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return opt.map(Value::Bytes).unwrap_or(Value::Null);
    }
    Value::Null
}
