//! Conversion of sqlx::MySql row → Vec<basemaster_core::Value>.
//!
//! Strategy: use `Column::type_info().name()` and try the right typed
//! decode. Uncovered types fall back to `String → Bytes → Null`.

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
            // Columns with `_bin` collation set the BINARY flag, which makes
            // sqlx's `String` decode reject the column as incompatible. Fall
            // back to raw bytes and decode as UTF-8 before treating as binary.
            match row.try_get::<Option<String>, _>(i) {
                Ok(Some(v)) => Value::String(v),
                Ok(None) => Value::Null,
                Err(_) => match row.try_get::<Option<Vec<u8>>, _>(i) {
                    Ok(Some(b)) => match String::from_utf8(b) {
                        Ok(s) => Value::String(s),
                        Err(e) => Value::Bytes(e.into_bytes()),
                    },
                    Ok(None) => Value::Null,
                    Err(_) => Value::Null,
                },
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
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            // CHAR/VARCHAR/TEXT columns with `_bin` collation arrive here:
            // sqlx-mysql renames them to BINARY/VARBINARY/*BLOB whenever the
            // BINARY column flag is set (and `_bin` collations DO set that
            // flag). True binary columns (e.g. SHA256 BINARY(32), image
            // BLOBs) usually fail UTF-8 validation and stay as Bytes.
            match tg!(Vec<u8>) {
                Some(b) => match String::from_utf8(b) {
                    Ok(s) => Value::String(s),
                    Err(e) => Value::Bytes(e.into_bytes()),
                },
                None => Value::Null,
            }
        }
        "BIT" => match tg!(Vec<u8>) {
            Some(v) => Value::Bytes(v),
            None => Value::Null,
        },
        _ => decode_fallback(row, i),
    }
}

/// When the type is unknown or the typed decode fails, try String,
/// then raw bytes, and finally return Null.
fn decode_fallback(row: &MySqlRow, i: usize) -> Value {
    if let Ok(opt) = row.try_get::<Option<String>, _>(i) {
        return opt.map(Value::String).unwrap_or(Value::Null);
    }
    if let Ok(opt) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return opt.map(Value::Bytes).unwrap_or(Value::Null);
    }
    Value::Null
}
