//! sqlx::Postgres row → Vec<Value>. Mapeia os tipos do catálogo do PG
//! pro enum do core. Fallback: String → Bytes → Null.

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgRow;
use sqlx::{Column, Row, TypeInfo};

use basemaster_core::Value;

pub fn decode_row(row: &PgRow) -> Vec<Value> {
    let cols = row.columns();
    let mut out = Vec::with_capacity(cols.len());
    for (i, col) in cols.iter().enumerate() {
        let name = col.type_info().name().to_uppercase();
        out.push(decode_one(row, i, &name));
    }
    out
}

fn decode_one(row: &PgRow, i: usize, type_name: &str) -> Value {
    macro_rules! tg {
        ($ty:ty) => {{
            match row.try_get::<Option<$ty>, _>(i) {
                Ok(Some(v)) => Some(v),
                Ok(None) => None,
                Err(_) => return decode_fallback(row, i),
            }
        }};
    }

    // Nomes dos tipos do PG (via sqlx): INT2, INT4, INT8, FLOAT4, FLOAT8,
    // NUMERIC, BOOL, TEXT, VARCHAR, BPCHAR, BYTEA, DATE, TIME, TIMESTAMP,
    // TIMESTAMPTZ, JSON, JSONB, UUID, etc. Arrays aparecem como "_INT4" etc.
    match type_name {
        "INT2" => match tg!(i16) {
            Some(v) => Value::Int(v as i64),
            None => Value::Null,
        },
        "INT4" | "SERIAL" => match tg!(i32) {
            Some(v) => Value::Int(v as i64),
            None => Value::Null,
        },
        "INT8" | "BIGSERIAL" => match tg!(i64) {
            Some(v) => Value::Int(v),
            None => Value::Null,
        },
        "FLOAT4" => match tg!(f32) {
            Some(v) => Value::Float(v as f64),
            None => Value::Null,
        },
        "FLOAT8" => match tg!(f64) {
            Some(v) => Value::Float(v),
            None => Value::Null,
        },
        "NUMERIC" => match tg!(Decimal) {
            Some(v) => Value::Decimal(v),
            None => Value::Null,
        },
        "BOOL" => match tg!(bool) {
            Some(v) => Value::Bool(v),
            None => Value::Null,
        },
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CITEXT" => match tg!(String) {
            Some(v) => Value::String(v),
            None => Value::Null,
        },
        "UUID" => {
            // Postgres entrega UUID como binário — sqlx decoda via
            // sqlx::types::Uuid. Convertemos pra string representada
            // no formato hifenizado (8-4-4-4-12).
            match row.try_get::<Option<sqlx::types::Uuid>, _>(i) {
                Ok(Some(v)) => Value::String(v.to_string()),
                Ok(None) => Value::Null,
                Err(_) => decode_fallback(row, i),
            }
        }
        "BYTEA" => match tg!(Vec<u8>) {
            Some(v) => Value::Bytes(v),
            None => Value::Null,
        },
        "DATE" => match tg!(NaiveDate) {
            Some(v) => Value::Date(v),
            None => Value::Null,
        },
        "TIME" | "TIMETZ" => match tg!(NaiveTime) {
            Some(v) => Value::Time(v),
            None => Value::Null,
        },
        "TIMESTAMP" => match tg!(NaiveDateTime) {
            Some(v) => Value::DateTime(v),
            None => Value::Null,
        },
        "TIMESTAMPTZ" => match tg!(DateTime<Utc>) {
            Some(v) => Value::Timestamp(v),
            None => Value::Null,
        },
        "JSON" | "JSONB" => match tg!(serde_json::Value) {
            Some(v) => Value::Json(v),
            None => Value::Null,
        },
        _ => decode_fallback(row, i),
    }
}

fn decode_fallback(row: &PgRow, i: usize) -> Value {
    if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
        return Value::String(s);
    }
    if let Ok(Some(b)) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return Value::Bytes(b);
    }
    Value::Null
}
