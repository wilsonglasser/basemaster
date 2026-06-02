//! `.bmbak` container: a single portable file that is still parallel-restorable.
//!
//! Layout:
//! ```text
//!   [0..4]   magic            b"BMBK"
//!   [4..6]   format_version   u16 LE
//!   [6..8]   flags            u16 LE (reserved)
//!   [8..]    data blocks      concatenated, each an independent zstd frame
//!   ...
//!   [F..]    manifest         zstd(JSON), describes every table + block offset
//!   [tail-20..tail-12] manifest_offset   u64 LE
//!   [tail-12..tail-4]  manifest_comp_len u64 LE
//!   [tail-4..tail]     end magic         b"KBMB"
//! ```
//!
//! The manifest lives at the END and only references offsets of blocks already
//! written, so writing needs no seek — we just track a running byte count.
//! Each block is its own zstd frame, so a restore can decompress N blocks on N
//! threads independently.

use std::io::{Read, Seek, SeekFrom, Write};

use anyhow::{bail, Context, Result};
use basemaster_core::Value;
use serde::{Deserialize, Serialize};

use crate::codec::{encode_value, Reader};

const MAGIC: &[u8; 4] = b"BMBK";
const END_MAGIC: &[u8; 4] = b"KBMB";
const FORMAT_VERSION: u16 = 1;
const HEADER_LEN: u64 = 8;
const TRAILER_LEN: u64 = 20;

/// One row = its cells in column order.
pub type Row = Vec<Value>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ColumnMeta {
    pub name: String,
    /// Source-engine declared type, kept for bulk-load target mapping.
    pub type_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockRef {
    pub offset: u64,
    pub comp_len: u64,
    pub raw_len: u64,
    pub rows: u64,
    pub crc32: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableEntry {
    /// DB schema / namespace (Postgres `public`, etc). None for engines without one.
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<ColumnMeta>,
    /// DDL to run BEFORE data: CREATE TABLE with primary key only.
    pub pre_sql: String,
    /// DDL to run AFTER data: secondary indexes, FKs, triggers, constraints.
    /// Deferring these is the big restore-speed lever (optimize-keys).
    pub post_sql: String,
    pub row_count: u64,
    pub data_blocks: Vec<BlockRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub format_version: u16,
    /// "mysql" | "postgres" | "sqlite"
    pub source_engine: String,
    /// RFC3339; passed in by the caller (this layer has no clock).
    pub created_at: String,
    pub app_version: String,
    pub tables: Vec<TableEntry>,
}

/// Streaming writer. Header is emitted on construction; blocks append; the
/// manifest + trailer are written by [`BmbakWriter::finish`].
pub struct BmbakWriter<W: Write> {
    inner: W,
    pos: u64,
    level: i32,
    source_engine: String,
    created_at: String,
    app_version: String,
    tables: Vec<TableEntry>,
}

impl<W: Write> BmbakWriter<W> {
    pub fn new(
        mut inner: W,
        source_engine: impl Into<String>,
        created_at: impl Into<String>,
        app_version: impl Into<String>,
        level: i32,
    ) -> Result<Self> {
        inner.write_all(MAGIC)?;
        inner.write_all(&FORMAT_VERSION.to_le_bytes())?;
        inner.write_all(&0u16.to_le_bytes())?; // flags
        Ok(BmbakWriter {
            inner,
            pos: HEADER_LEN,
            level,
            source_engine: source_engine.into(),
            created_at: created_at.into(),
            app_version: app_version.into(),
            tables: Vec::new(),
        })
    }

    /// Register a table; returns its index for subsequent `write_block` calls.
    pub fn begin_table(
        &mut self,
        schema: Option<String>,
        name: impl Into<String>,
        columns: Vec<ColumnMeta>,
        pre_sql: impl Into<String>,
        post_sql: impl Into<String>,
    ) -> usize {
        self.tables.push(TableEntry {
            schema,
            name: name.into(),
            columns,
            pre_sql: pre_sql.into(),
            post_sql: post_sql.into(),
            row_count: 0,
            data_blocks: Vec::new(),
        });
        self.tables.len() - 1
    }

    /// Compress and append one block of rows to `table`. A block is the unit of
    /// parallel decompression on restore, so callers should chunk large tables.
    pub fn write_block(&mut self, table: usize, rows: &[Row]) -> Result<()> {
        let ncols = self.tables[table].columns.len();
        let mut raw = Vec::new();
        for row in rows {
            debug_assert_eq!(row.len(), ncols, "row width != column count");
            for v in row {
                encode_value(v, &mut raw);
            }
        }
        let comp = zstd::stream::encode_all(raw.as_slice(), self.level)
            .context("zstd encode block")?;
        let crc32 = crc32fast::hash(&comp);
        let offset = self.pos;
        self.inner.write_all(&comp)?;
        self.pos += comp.len() as u64;

        let entry = &mut self.tables[table];
        entry.data_blocks.push(BlockRef {
            offset,
            comp_len: comp.len() as u64,
            raw_len: raw.len() as u64,
            rows: rows.len() as u64,
            crc32,
        });
        entry.row_count += rows.len() as u64;
        Ok(())
    }

    /// Write the manifest + trailer and return the underlying writer.
    pub fn finish(mut self) -> Result<W> {
        let manifest = Manifest {
            format_version: FORMAT_VERSION,
            source_engine: self.source_engine,
            created_at: self.created_at,
            app_version: self.app_version,
            tables: self.tables,
        };
        let json = serde_json::to_vec(&manifest)?;
        let comp = zstd::stream::encode_all(json.as_slice(), self.level)
            .context("zstd encode manifest")?;
        let manifest_offset = self.pos;
        self.inner.write_all(&comp)?;

        self.inner.write_all(&manifest_offset.to_le_bytes())?;
        self.inner.write_all(&(comp.len() as u64).to_le_bytes())?;
        self.inner.write_all(END_MAGIC)?;
        self.inner.flush()?;
        Ok(self.inner)
    }
}

/// Random-access reader: parses the trailing manifest, then seeks to any block.
pub struct BmbakReader<R: Read + Seek> {
    inner: R,
    pub manifest: Manifest,
}

impl<R: Read + Seek> BmbakReader<R> {
    pub fn open(mut inner: R) -> Result<Self> {
        let total = inner.seek(SeekFrom::End(0))?;
        if total < HEADER_LEN + TRAILER_LEN {
            bail!("bmbak: file too small to be valid");
        }

        let mut head = [0u8; 8];
        inner.seek(SeekFrom::Start(0))?;
        inner.read_exact(&mut head)?;
        if &head[0..4] != MAGIC {
            bail!("bmbak: bad magic");
        }
        let ver = u16::from_le_bytes([head[4], head[5]]);
        if ver != FORMAT_VERSION {
            bail!("bmbak: unsupported format version {ver}");
        }

        let mut trailer = [0u8; TRAILER_LEN as usize];
        inner.seek(SeekFrom::End(-(TRAILER_LEN as i64)))?;
        inner.read_exact(&mut trailer)?;
        if &trailer[16..20] != END_MAGIC {
            bail!("bmbak: bad trailer magic (truncated or corrupt file)");
        }
        let manifest_offset = u64::from_le_bytes(trailer[0..8].try_into().unwrap());
        let manifest_comp_len = u64::from_le_bytes(trailer[8..16].try_into().unwrap());

        inner.seek(SeekFrom::Start(manifest_offset))?;
        let mut comp = vec![0u8; manifest_comp_len as usize];
        inner.read_exact(&mut comp)?;
        let json = zstd::stream::decode_all(comp.as_slice()).context("zstd decode manifest")?;
        let manifest: Manifest =
            serde_json::from_slice(&json).context("parse bmbak manifest")?;

        Ok(BmbakReader { inner, manifest })
    }

    /// Decompress, verify checksum, and decode every row in `block`.
    pub fn read_block(&mut self, block: &BlockRef, ncols: usize) -> Result<Vec<Row>> {
        self.inner.seek(SeekFrom::Start(block.offset))?;
        let mut comp = vec![0u8; block.comp_len as usize];
        self.inner.read_exact(&mut comp)?;
        if crc32fast::hash(&comp) != block.crc32 {
            bail!("bmbak: block checksum mismatch at offset {}", block.offset);
        }
        let raw = zstd::stream::decode_all(comp.as_slice()).context("zstd decode block")?;
        let mut reader = Reader::new(&raw);
        let mut rows = Vec::with_capacity(block.rows as usize);
        for _ in 0..block.rows {
            let mut row = Vec::with_capacity(ncols);
            for _ in 0..ncols {
                row.push(reader.decode_value()?);
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// Read all rows of a table (blocks in stored order). Convenience for
    /// serial paths; parallel restore should fan out over `data_blocks`.
    pub fn read_table_rows(&mut self, table: &TableEntry) -> Result<Vec<Row>> {
        let ncols = table.columns.len();
        let mut out = Vec::with_capacity(table.row_count as usize);
        for block in &table.data_blocks.clone() {
            out.extend(self.read_block(block, ncols)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn cols(names: &[&str]) -> Vec<ColumnMeta> {
        names
            .iter()
            .map(|n| ColumnMeta {
                name: (*n).into(),
                type_hint: "int".into(),
            })
            .collect()
    }

    fn sample_file() -> Vec<u8> {
        let mut w = BmbakWriter::new(Cursor::new(Vec::new()), "mysql", "2026-06-01T00:00:00Z", "0.6.7", 5)
            .unwrap();
        let users = w.begin_table(
            None,
            "users",
            cols(&["id", "name"]),
            "CREATE TABLE users(id INT PRIMARY KEY, name TEXT);",
            "CREATE INDEX idx_name ON users(name);",
        );
        w.write_block(
            users,
            &[
                vec![Value::Int(1), Value::String("alice".into())],
                vec![Value::Int(2), Value::String("bob".into())],
            ],
        )
        .unwrap();
        // second block, same table — exercises multi-block tables
        w.write_block(users, &[vec![Value::Int(3), Value::Null]]).unwrap();

        let empty = w.begin_table(Some("public".into()), "empty", cols(&["x"]), "CREATE TABLE empty(x INT);", "");
        let _ = empty;

        w.finish().unwrap().into_inner()
    }

    #[test]
    fn roundtrip_full_file() {
        let bytes = sample_file();
        let mut r = BmbakReader::open(Cursor::new(bytes)).unwrap();

        assert_eq!(r.manifest.source_engine, "mysql");
        assert_eq!(r.manifest.format_version, FORMAT_VERSION);
        assert_eq!(r.manifest.tables.len(), 2);

        let users = r.manifest.tables[0].clone();
        assert_eq!(users.name, "users");
        assert_eq!(users.row_count, 3);
        assert_eq!(users.data_blocks.len(), 2);
        assert_eq!(users.post_sql, "CREATE INDEX idx_name ON users(name);");

        let rows = r.read_table_rows(&users).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], vec![Value::Int(1), Value::String("alice".into())]);
        assert_eq!(rows[2], vec![Value::Int(3), Value::Null]);

        let empty = r.manifest.tables[1].clone();
        assert_eq!(empty.schema.as_deref(), Some("public"));
        assert_eq!(empty.row_count, 0);
        assert!(r.read_table_rows(&empty).unwrap().is_empty());
    }

    #[test]
    fn blocks_are_independent_frames() {
        // Reading block 2 without touching block 1 must work (parallel restore).
        let bytes = sample_file();
        let mut r = BmbakReader::open(Cursor::new(bytes)).unwrap();
        let users = r.manifest.tables[0].clone();
        let b2 = &users.data_blocks[1];
        let rows = r.read_block(b2, users.columns.len()).unwrap();
        assert_eq!(rows, vec![vec![Value::Int(3), Value::Null]]);
    }

    #[test]
    fn corrupt_block_detected() {
        let mut bytes = sample_file();
        // flip a byte inside the first data block (right after the 8-byte header)
        bytes[10] ^= 0xff;
        let mut r = BmbakReader::open(Cursor::new(bytes)).unwrap();
        let users = r.manifest.tables[0].clone();
        let err = r.read_block(&users.data_blocks[0], users.columns.len());
        assert!(err.is_err(), "checksum should have caught corruption");
    }

    #[test]
    fn bad_magic_rejected() {
        let mut bytes = sample_file();
        bytes[0] = b'X';
        assert!(BmbakReader::open(Cursor::new(bytes)).is_err());
    }

    #[test]
    fn truncated_trailer_rejected() {
        let mut bytes = sample_file();
        bytes.truncate(bytes.len() - 5);
        assert!(BmbakReader::open(Cursor::new(bytes)).is_err());
    }

    #[test]
    fn empty_backup_roundtrips() {
        let w = BmbakWriter::new(Cursor::new(Vec::new()), "sqlite", "2026-06-01T00:00:00Z", "0.6.7", 3)
            .unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let r = BmbakReader::open(Cursor::new(bytes)).unwrap();
        assert_eq!(r.manifest.tables.len(), 0);
        assert_eq!(r.manifest.source_engine, "sqlite");
    }
}
