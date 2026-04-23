use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Generic cell value — DBMS-agnostic.
///
/// Each driver converts its native types into `Value`. The frontend
/// receives it via `serde_json` and formats it based on the type.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(v: &Value) -> Value {
        let json = serde_json::to_string(v).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn null_roundtrip() {
        assert_eq!(roundtrip(&Value::Null), Value::Null);
    }

    #[test]
    fn scalar_roundtrips() {
        assert_eq!(roundtrip(&Value::Bool(true)), Value::Bool(true));
        assert_eq!(roundtrip(&Value::Int(-42)), Value::Int(-42));
        assert_eq!(roundtrip(&Value::UInt(u64::MAX)), Value::UInt(u64::MAX));
        assert_eq!(roundtrip(&Value::Float(1.5)), Value::Float(1.5));
        assert_eq!(
            roundtrip(&Value::String("abc".into())),
            Value::String("abc".into())
        );
    }

    #[test]
    fn decimal_roundtrip() {
        let d: Decimal = "123.4500".parse().unwrap();
        assert_eq!(roundtrip(&Value::Decimal(d)), Value::Decimal(d));
    }

    #[test]
    fn bytes_roundtrip() {
        let v = Value::Bytes(vec![0x00, 0xff, 0x7f, 0x80]);
        assert_eq!(roundtrip(&v), v);
    }

    #[test]
    fn json_roundtrip() {
        let v = Value::Json(serde_json::json!({"a": 1, "b": [true, null]}));
        assert_eq!(roundtrip(&v), v);
    }

    #[test]
    fn date_time_roundtrips() {
        let d = NaiveDate::from_ymd_opt(2026, 4, 20).unwrap();
        assert_eq!(roundtrip(&Value::Date(d)), Value::Date(d));

        let t = NaiveTime::from_hms_opt(12, 34, 56).unwrap();
        assert_eq!(roundtrip(&Value::Time(t)), Value::Time(t));

        let dt = NaiveDateTime::new(d, t);
        assert_eq!(roundtrip(&Value::DateTime(dt)), Value::DateTime(dt));

        let ts = DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc);
        assert_eq!(roundtrip(&Value::Timestamp(ts)), Value::Timestamp(ts));
    }

    #[test]
    fn is_null_matches_only_null() {
        assert!(Value::Null.is_null());
        assert!(!Value::Bool(false).is_null());
        assert!(!Value::String(String::new()).is_null());
    }

    #[test]
    fn tag_uses_snake_case() {
        // Contract with the frontend: serializer uses tag "type" + "value" and snake_case.
        let s = serde_json::to_string(&Value::Int(1)).unwrap();
        assert!(s.contains("\"type\":\"int\""), "got {s}");
        assert!(s.contains("\"value\":1"), "got {s}");

        let s = serde_json::to_string(&Value::DateTime(NaiveDateTime::new(
            NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            NaiveTime::from_hms_opt(0, 0, 0).unwrap(),
        )))
        .unwrap();
        assert!(s.contains("\"type\":\"date_time\""), "got {s}");
    }
}
