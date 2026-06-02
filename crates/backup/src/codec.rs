//! Lossless binary codec for `core::Value`.
//!
//! Each cell is a 1-byte type tag followed by a native-bytes payload.
//! No text formatting, so restore skips SQL re-parsing and no float/decimal/
//! date value gets mangled on the way to text and back. Decimal goes through
//! `rust_decimal`'s exact 16-byte representation; bytes/blobs are stored raw.

use anyhow::{bail, Result};
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use basemaster_core::Value;
use rust_decimal::Decimal;

// Type tags. Stable on disk — never renumber, only append.
const T_NULL: u8 = 0;
const T_BOOL: u8 = 1;
const T_INT: u8 = 2;
const T_UINT: u8 = 3;
const T_FLOAT: u8 = 4;
const T_DECIMAL: u8 = 5;
const T_STRING: u8 = 6;
const T_BYTES: u8 = 7;
const T_JSON: u8 = 8;
const T_DATE: u8 = 9;
const T_TIME: u8 = 10;
const T_DATETIME: u8 = 11;
const T_TIMESTAMP: u8 = 12;

/// Append the encoding of `v` to `out`.
pub fn encode_value(v: &Value, out: &mut Vec<u8>) {
    match v {
        Value::Null => out.push(T_NULL),
        Value::Bool(b) => {
            out.push(T_BOOL);
            out.push(*b as u8);
        }
        Value::Int(i) => {
            out.push(T_INT);
            out.extend_from_slice(&i.to_le_bytes());
        }
        Value::UInt(u) => {
            out.push(T_UINT);
            out.extend_from_slice(&u.to_le_bytes());
        }
        Value::Float(f) => {
            out.push(T_FLOAT);
            // bit pattern, so NaN/inf and -0.0 survive exactly
            out.extend_from_slice(&f.to_bits().to_le_bytes());
        }
        Value::Decimal(d) => {
            out.push(T_DECIMAL);
            out.extend_from_slice(&d.serialize()); // exact, preserves scale
        }
        Value::String(s) => {
            out.push(T_STRING);
            put_bytes(s.as_bytes(), out);
        }
        Value::Bytes(b) => {
            out.push(T_BYTES);
            put_bytes(b, out);
        }
        Value::Json(j) => {
            out.push(T_JSON);
            // serde_json::to_vec never fails for a valid Value
            let buf = serde_json::to_vec(j).unwrap_or_default();
            put_bytes(&buf, out);
        }
        Value::Date(d) => {
            out.push(T_DATE);
            out.extend_from_slice(&d.num_days_from_ce().to_le_bytes());
        }
        Value::Time(t) => {
            out.push(T_TIME);
            put_time(t, out);
        }
        Value::DateTime(dt) => {
            out.push(T_DATETIME);
            out.extend_from_slice(&dt.date().num_days_from_ce().to_le_bytes());
            put_time(&dt.time(), out);
        }
        Value::Timestamp(ts) => {
            out.push(T_TIMESTAMP);
            out.extend_from_slice(&ts.timestamp().to_le_bytes());
            out.extend_from_slice(&ts.timestamp_subsec_nanos().to_le_bytes());
        }
    }
}

/// Cursor over an encoded buffer.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos + n;
        if end > self.buf.len() {
            bail!("bmbak codec: truncated buffer (need {n} at {})", self.pos);
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        self.take(n)
    }

    /// Decode one value at the cursor.
    pub fn decode_value(&mut self) -> Result<Value> {
        let tag = self.u8()?;
        Ok(match tag {
            T_NULL => Value::Null,
            T_BOOL => Value::Bool(self.u8()? != 0),
            T_INT => Value::Int(self.i64()?),
            T_UINT => Value::UInt(self.u64()?),
            T_FLOAT => Value::Float(f64::from_bits(self.u64()?)),
            T_DECIMAL => {
                let raw: [u8; 16] = self.take(16)?.try_into().unwrap();
                Value::Decimal(Decimal::deserialize(raw))
            }
            T_STRING => Value::String(String::from_utf8(self.bytes()?.to_vec())?),
            T_BYTES => Value::Bytes(self.bytes()?.to_vec()),
            T_JSON => Value::Json(serde_json::from_slice(self.bytes()?)?),
            T_DATE => Value::Date(decode_date(self.i32()?)?),
            T_TIME => Value::Time(self.read_time()?),
            T_DATETIME => {
                let date = decode_date(self.i32()?)?;
                let time = self.read_time()?;
                Value::DateTime(NaiveDateTime::new(date, time))
            }
            T_TIMESTAMP => {
                let secs = self.i64()?;
                let nanos = self.u32()?;
                let ts = DateTime::<Utc>::from_timestamp(secs, nanos)
                    .ok_or_else(|| anyhow::anyhow!("bmbak codec: bad timestamp {secs}.{nanos}"))?;
                Value::Timestamp(ts)
            }
            other => bail!("bmbak codec: unknown type tag {other}"),
        })
    }

    fn read_time(&mut self) -> Result<NaiveTime> {
        let secs = self.u32()?;
        let nanos = self.u32()?;
        NaiveTime::from_num_seconds_from_midnight_opt(secs, nanos)
            .ok_or_else(|| anyhow::anyhow!("bmbak codec: bad time {secs}s {nanos}ns"))
    }
}

fn put_bytes(b: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(b.len() as u32).to_le_bytes());
    out.extend_from_slice(b);
}

// nanosecond() can return >= 1e9 for a leap second; from_num_seconds_from_midnight_opt
// accepts that range, so leaps roundtrip too.
fn put_time(t: &NaiveTime, out: &mut Vec<u8>) {
    out.extend_from_slice(&t.num_seconds_from_midnight().to_le_bytes());
    out.extend_from_slice(&t.nanosecond().to_le_bytes());
}

fn decode_date(days: i32) -> Result<NaiveDate> {
    NaiveDate::from_num_days_from_ce_opt(days)
        .ok_or_else(|| anyhow::anyhow!("bmbak codec: bad date {days}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(v: &Value) -> Value {
        let mut buf = Vec::new();
        encode_value(v, &mut buf);
        let mut r = Reader::new(&buf);
        let out = r.decode_value().expect("decode");
        assert!(r.is_empty(), "leftover bytes after decoding {v:?}");
        out
    }

    fn assert_rt(v: Value) {
        assert_eq!(roundtrip(&v), v);
    }

    #[test]
    fn scalars() {
        assert_rt(Value::Null);
        assert_rt(Value::Bool(true));
        assert_rt(Value::Bool(false));
        assert_rt(Value::Int(0));
        assert_rt(Value::Int(i64::MIN));
        assert_rt(Value::Int(i64::MAX));
        assert_rt(Value::UInt(0));
        assert_rt(Value::UInt(u64::MAX));
    }

    #[test]
    fn floats_preserve_exact_bits() {
        assert_rt(Value::Float(0.0));
        assert_rt(Value::Float(-0.0));
        assert_rt(Value::Float(123.456789012345));
        assert_rt(Value::Float(f64::INFINITY));
        assert_rt(Value::Float(f64::NEG_INFINITY));
        // NaN != NaN, so compare bit patterns directly
        let mut buf = Vec::new();
        encode_value(&Value::Float(f64::NAN), &mut buf);
        let back = Reader::new(&buf).decode_value().unwrap();
        match back {
            Value::Float(f) => assert!(f.is_nan()),
            other => panic!("expected float, got {other:?}"),
        }
    }

    #[test]
    fn decimal_preserves_scale() {
        // trailing zeros are significant in SQL DECIMAL; must survive
        let d: Decimal = "123.4500".parse().unwrap();
        let back = roundtrip(&Value::Decimal(d));
        assert_eq!(back, Value::Decimal(d));
        if let Value::Decimal(bd) = back {
            assert_eq!(bd.scale(), 4, "scale lost");
        }
    }

    #[test]
    fn strings_and_unicode() {
        assert_rt(Value::String(String::new()));
        assert_rt(Value::String("plain".into()));
        assert_rt(Value::String("acentuação 日本語 🦴".into()));
    }

    #[test]
    fn bytes_raw_including_invalid_utf8() {
        assert_rt(Value::Bytes(vec![]));
        assert_rt(Value::Bytes(vec![0x00, 0xff, 0x7f, 0x80, 0xc3, 0x28]));
    }

    #[test]
    fn json_roundtrip() {
        assert_rt(Value::Json(serde_json::json!({
            "a": 1, "b": [true, null, "x"], "n": 3.5
        })));
    }

    #[test]
    fn dates_times_including_negative_and_leap() {
        let d = NaiveDate::from_ymd_opt(2026, 4, 20).unwrap();
        assert_rt(Value::Date(d));
        // pre-Common-Era / pre-1970 must survive (i32 days, signed)
        assert_rt(Value::Date(NaiveDate::from_ymd_opt(1, 1, 1).unwrap()));
        assert_rt(Value::Date(NaiveDate::from_ymd_opt(1850, 12, 31).unwrap()));

        let t = NaiveTime::from_hms_nano_opt(12, 34, 56, 123_456_789).unwrap();
        assert_rt(Value::Time(t));
        // leap second: nanosecond() >= 1e9
        let leap = NaiveTime::from_hms_nano_opt(23, 59, 59, 1_500_000_000).unwrap();
        assert_eq!(roundtrip(&Value::Time(leap)), Value::Time(leap));

        let dt = NaiveDateTime::new(d, t);
        assert_rt(Value::DateTime(dt));
        assert_rt(Value::Timestamp(DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc)));
        // pre-epoch timestamp
        let pre = NaiveDateTime::new(
            NaiveDate::from_ymd_opt(1960, 6, 15).unwrap(),
            NaiveTime::from_hms_opt(8, 0, 0).unwrap(),
        );
        assert_rt(Value::Timestamp(DateTime::<Utc>::from_naive_utc_and_offset(pre, Utc)));
    }

    #[test]
    fn multiple_values_in_one_buffer() {
        let row = [
            Value::Int(7),
            Value::Null,
            Value::String("hi".into()),
            Value::Bool(true),
        ];
        let mut buf = Vec::new();
        for v in &row {
            encode_value(v, &mut buf);
        }
        let mut r = Reader::new(&buf);
        for v in &row {
            assert_eq!(&r.decode_value().unwrap(), v);
        }
        assert!(r.is_empty());
    }

    #[test]
    fn truncated_buffer_errors() {
        let mut buf = Vec::new();
        encode_value(&Value::Int(123), &mut buf);
        buf.truncate(buf.len() - 1);
        assert!(Reader::new(&buf).decode_value().is_err());
    }
}
