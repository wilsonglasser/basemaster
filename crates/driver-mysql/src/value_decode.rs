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
        // Temporal types never use `tg!`: a `None` here is ambiguous. sqlx maps
        // zero dates to NULL (`MySqlValueRef::is_null` treats a zero-date
        // payload as null), so both the real NULL and `0000-00-00` arrive as
        // `Ok(None)`. `decode_broken_temporal` re-reads the raw payload to tell
        // them apart.
        "DATE" => match row.try_get::<Option<NaiveDate>, _>(i) {
            Ok(Some(v)) => Value::Date(v),
            _ => decode_broken_temporal(row, i, Temporal::Date),
        },
        "TIME" => match row.try_get::<Option<NaiveTime>, _>(i) {
            Ok(Some(v)) => Value::Time(v),
            _ => decode_broken_temporal(row, i, Temporal::Time),
        },
        "DATETIME" => match row.try_get::<Option<NaiveDateTime>, _>(i) {
            Ok(Some(v)) => Value::DateTime(v),
            _ => decode_broken_temporal(row, i, Temporal::DateTime),
        },
        "TIMESTAMP" => match row.try_get::<Option<DateTime<Utc>>, _>(i) {
            Ok(Some(v)) => Value::Timestamp(v),
            _ => decode_broken_temporal(row, i, Temporal::DateTime),
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

#[derive(Clone, Copy, PartialEq, Debug)]
enum Temporal {
    Date,
    Time,
    DateTime,
}

/// Legacy MySQL data holds temporal values no calendar accepts: `0000-00-00`,
/// `2021-00-00`, `2021-05-00`, or a TIME beyond the 24h clock (`838:59:59`).
/// chrono can't build any of those, and sqlx reports zero dates as NULL, which
/// erases the difference from a real NULL — a copy into a NOT NULL column then
/// dies with error 1048. Rebuild the literal from the wire payload and hand it
/// over as a String so the value survives the round trip.
fn decode_broken_temporal(row: &MySqlRow, i: usize, kind: Temporal) -> Value {
    // Bypasses the type-compat check (`try_get` would reject `&[u8]` on a DATE
    // column) and, unlike `Option<T>`, has no null shortcut: an Err here means
    // the column really is NULL.
    let buf: &[u8] = match row.try_get_unchecked(i) {
        Ok(b) => b,
        Err(_) => return Value::Null,
    };
    Value::String(temporal_literal(buf, kind))
}

/// Wire payload → MySQL literal. Text protocol sends the literal as-is; the
/// binary protocol sends a length-prefixed struct (`0` = all zeros).
fn temporal_literal(buf: &[u8], kind: Temporal) -> String {
    // Binary length prefixes are 0..=12; a text literal always starts with an
    // ASCII digit (or `-` for a negative TIME).
    let is_text = matches!(buf.first(), Some(b) if *b >= b'-');
    if is_text {
        if let Ok(s) = std::str::from_utf8(buf) {
            return s.to_string();
        }
    }
    let at = |n: usize| buf.get(n).copied().unwrap_or(0);
    let len = at(0) as usize;
    if kind == Temporal::Time {
        // [len][neg][days u32][h][m][s][micros u32]
        let sign = if len >= 8 && at(1) == 1 { "-" } else { "" };
        let days = if len >= 8 {
            u32::from_le_bytes([at(2), at(3), at(4), at(5)])
        } else {
            0
        };
        let (h, m, s) = if len >= 8 {
            (at(6) as u32, at(7), at(8))
        } else {
            (0, 0, 0)
        };
        return format!("{sign}{:02}:{m:02}:{s:02}", days * 24 + h);
    }
    // [len][year u16][month][day][h][m][s][micros u32]
    let (y, mo, d) = if len >= 4 {
        (u16::from_le_bytes([at(1), at(2)]), at(3), at(4))
    } else {
        (0, 0, 0)
    };
    let date = format!("{y:04}-{mo:02}-{d:02}");
    if kind == Temporal::Date {
        return date;
    }
    let (h, mi, s) = if len >= 7 {
        (at(5), at(6), at(7))
    } else {
        (0, 0, 0)
    };
    let micros = if len >= 11 {
        u32::from_le_bytes([at(8), at(9), at(10), at(11)])
    } else {
        0
    };
    let frac = if micros > 0 {
        format!(".{micros:06}")
    } else {
        String::new()
    };
    format!("{date} {h:02}:{mi:02}:{s:02}{frac}")
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

#[cfg(test)]
mod tests {
    use super::{temporal_literal, Temporal};

    #[test]
    fn zero_date_binary() {
        assert_eq!(temporal_literal(&[0], Temporal::Date), "0000-00-00");
        assert_eq!(
            temporal_literal(&[0], Temporal::DateTime),
            "0000-00-00 00:00:00"
        );
    }

    #[test]
    fn zero_in_date_binary() {
        // 2021-00-00 : month/day zeroed, year intact.
        let d = [4u8, 0xE5, 0x07, 0, 0];
        assert_eq!(temporal_literal(&d, Temporal::Date), "2021-00-00");
        // 2021-05-00 12:30:45
        let dt = [7u8, 0xE5, 0x07, 5, 0, 12, 30, 45];
        assert_eq!(
            temporal_literal(&dt, Temporal::DateTime),
            "2021-05-00 12:30:45"
        );
    }

    #[test]
    fn datetime_with_micros() {
        let dt = [11u8, 0xE5, 0x07, 5, 0, 12, 30, 45, 0x40, 0x0D, 0x03, 0x00];
        assert_eq!(
            temporal_literal(&dt, Temporal::DateTime),
            "2021-05-00 12:30:45.200000"
        );
    }

    #[test]
    fn out_of_range_time_binary() {
        // 838:59:59 = 34 days + 22h
        let t = [8u8, 0, 34, 0, 0, 0, 22, 59, 59];
        assert_eq!(temporal_literal(&t, Temporal::Time), "838:59:59");
        let neg = [8u8, 1, 34, 0, 0, 0, 22, 59, 59];
        assert_eq!(temporal_literal(&neg, Temporal::Time), "-838:59:59");
        assert_eq!(temporal_literal(&[0], Temporal::Time), "00:00:00");
    }

    #[test]
    fn text_protocol_passes_through() {
        assert_eq!(
            temporal_literal(b"0000-00-00 00:00:00", Temporal::DateTime),
            "0000-00-00 00:00:00"
        );
        assert_eq!(temporal_literal(b"-838:59:59", Temporal::Time), "-838:59:59");
    }
}
