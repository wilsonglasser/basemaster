//! SQL Import — runs a `.sql` (or `.zip` with multiple `.sql`s) on the target.
//! Respects strings, comments, and the `DELIMITER` directive common in dumps
//! with triggers/procedures.
//!
//! The file is **streamed** in chunks (never fully loaded), so multi-gigabyte
//! dumps import with bounded memory. For BaseMaster dumps (detected via the
//! `@BM:DUMP` signature) the data phase runs across N parallel workers: a
//! single bounded queue fed by the streaming parser spreads every table's
//! INSERTs across the pool (FK checks are off, so order is irrelevant).
//! Foreign `.sql`/`.zip` stream sequentially.
//!
//! Events:
//!   `sql_import:progress` — { statements_done, errors, current_source }
//!   `sql_import:stmt_error` — { index, sql, message }
//!   `sql_import:done` — { statements_done, errors, elapsed_ms }

use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use basemaster_core::Driver;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::data_transfer::TransferControl;
use crate::sql_translate::{detect_dialect, normalize_for, Dialect};

/// Bytes read per chunk while streaming the source.
const READ_CHUNK: usize = 64 * 1024;
/// Head bytes sampled up-front for signature + dialect detection.
const SAMPLE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportOptions {
    pub target_connection_id: Uuid,
    pub path: String,
    /// Runs `USE schema;` before everything, for scripts that don't
    /// qualify names (`CREATE TABLE t` instead of `db.t`).
    #[serde(default)]
    pub schema: Option<String>,
    /// Keep running after an error — useful with dumps that have statements
    /// already applied (e.g., existing CREATE TABLE with DROP omitted).
    #[serde(default)]
    pub continue_on_error: bool,
    /// Emits `progress` every N statements (so we don't flood the event bus).
    #[serde(default = "default_emit_every")]
    pub emit_every: u32,
    /// Prepend FK_CHECKS=0 on each statement. Critical for dumps with FKs
    /// because the sqlx pool may hand out different conns between statements,
    /// which invalidates the global `SET SESSION` from the header.
    #[serde(default = "default_true")]
    pub disable_fk_checks: bool,
    /// Prepend UNIQUE_CHECKS=0.
    #[serde(default = "default_true")]
    pub disable_unique_checks: bool,
    /// Prepend NO_AUTO_VALUE_ON_ZERO — preserves PK=0 on tables with
    /// AUTO_INCREMENT (same default as mysqldump).
    #[serde(default = "default_true")]
    pub preserve_zero_auto_increment: bool,
    /// Parallel workers for the data phase. Only engages on BaseMaster dumps
    /// (detected via the `@BM:DUMP` signature) — foreign `.sql`/`.zip` always
    /// import sequentially. Limited by the target pool's max_connections (= 8).
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
}

fn default_true() -> bool {
    true
}

fn default_emit_every() -> u32 {
    50
}

fn default_concurrency() -> u32 {
    4
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportProgress {
    pub statements_done: u64,
    pub errors: u32,
    /// Phase being processed: "header" | "structure" | "data" | "footer" |
    /// "done", or a file name for foreign single-file imports.
    pub current_source: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportStmtError {
    pub index: u64,
    pub sql: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportDone {
    pub statements_done: u64,
    pub errors: u32,
    pub elapsed_ms: u64,
}

pub async fn run_import(
    app: AppHandle,
    opts: ImportOptions,
    target: Arc<dyn Driver>,
    control: Arc<TransferControl>,
) -> Result<ImportDone, String> {
    let started = Instant::now();

    let path = std::path::PathBuf::from(&opts.path);
    let is_zip = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    // Session prelude — prepended to EVERY statement so the SETs apply on the
    // SAME connection that runs the DDL/DML. The sqlx pool may hand out
    // different conns between execute()s (and parallel workers definitely use
    // different conns), so a lone initial `SET FOREIGN_KEY_CHECKS=0` isn't
    // enough.
    let mut session_prelude = String::new();
    if opts.disable_fk_checks {
        session_prelude.push_str("SET FOREIGN_KEY_CHECKS=0; ");
    }
    if opts.disable_unique_checks {
        session_prelude.push_str("SET UNIQUE_CHECKS=0; ");
    }
    if opts.preserve_zero_auto_increment {
        session_prelude
            .push_str("SET sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO'); ");
    }
    if let Some(ref schema) = opts.schema {
        if !schema.is_empty() {
            session_prelude.push_str(&format!("USE {}; ", target.quote_ident(schema)));
        }
    }

    let concurrency = opts.concurrency.clamp(1, 8) as usize;

    // Peek the head for the signature + a dialect-detection sample. Cheap:
    // reads a single small entry (zip) or the first chunk (sql).
    let (has_signature, sample) = if is_zip {
        peek_zip(&path)?
    } else {
        let head = peek_head(&path)?;
        (sql_has_signature(&head), head)
    };
    let parallel_data = has_signature && concurrency > 1;

    let (total_stmts, total_errs) = run_streaming_import(
        &app, &opts, target, &control, &session_prelude, parallel_data, concurrency, &sample,
    )
    .await?;

    let done = ImportDone {
        statements_done: total_stmts,
        errors: total_errs,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let _ = app.emit("sql_import:done", &done);
    Ok(done)
}

// ============================================================ detection / peek

/// True if the text carries the BaseMaster dump signature on its first lines.
fn sql_has_signature(sql: &str) -> bool {
    sql.lines()
        .take(3)
        .any(|l| l.trim_start().starts_with(crate::sql_dump::DUMP_SIGNATURE))
}

/// Reads the first `SAMPLE_BYTES` of a file as lossy UTF-8 (signature + dialect).
fn peek_head(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("abrir arquivo: {}", e))?;
    let mut buf = vec![0u8; SAMPLE_BYTES];
    let n = f.read(&mut buf).map_err(|e| format!("ler arquivo: {}", e))?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// Peeks a ZIP: reads `00_header.sql` (for the signature) and the head of the
/// first table entry (for dialect detection — structure DDL disambiguates).
fn peek_zip(path: &Path) -> Result<(bool, String), String> {
    let f = std::fs::File::open(path).map_err(|e| format!("abrir zip: {}", e))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("ler zip: {}", e))?;
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .filter(|n| n.to_lowercase().ends_with(".sql"))
        .collect();
    names.sort();

    let mut header = String::new();
    if let Ok(mut e) = zip.by_name(
        names
            .iter()
            .find(|n| n.ends_with("00_header.sql"))
            .map(|s| s.as_str())
            .unwrap_or("00_header.sql"),
    ) {
        let _ = e.read_to_string(&mut header);
    }
    let has_sig = sql_has_signature(&header);

    // Dialect sample: header + head of the first table entry.
    let mut sample = header.clone();
    if let Some(first_table) = names.iter().find(|n| {
        !n.ends_with("00_header.sql")
            && !n.ends_with("zz_footer.sql")
    }) {
        if let Ok(mut e) = zip.by_name(first_table) {
            let mut buf = vec![0u8; SAMPLE_BYTES];
            if let Ok(n) = e.read(&mut buf) {
                sample.push('\n');
                sample.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
    }
    Ok((has_sig, sample))
}

// ============================================================ streaming engine

/// One item produced by the streaming parser.
enum ParseItem {
    /// A complete statement (comments stripped, delimiter removed).
    Stmt(String),
    /// A `@BM:` region marker — switches the importer's phase.
    Marker(Marker),
}

#[derive(Clone, Copy, PartialEq)]
enum Marker {
    Dump,
    Table,
    Data,
    Indexes,
    Footer,
}

fn classify_marker(line: &str) -> Option<Marker> {
    let rest = line.trim_start().strip_prefix("-- @BM:")?;
    if rest.starts_with("DUMP") {
        Some(Marker::Dump)
    } else if rest.starts_with("T ") || rest.starts_with("T\t") {
        Some(Marker::Table)
    } else if rest.starts_with("D ") || rest.starts_with("D\t") || rest.trim_end() == "D" {
        Some(Marker::Data)
    } else if rest.trim_end() == "I" || rest.starts_with("I ") {
        Some(Marker::Indexes)
    } else if rest.trim_end() == "F" || rest.starts_with("F ") {
        Some(Marker::Footer)
    } else {
        None
    }
}

/// Lookahead reserved at a non-final chunk's tail so multi-byte tokens
/// (`--`, `/*`, `*/`, the `DELIMITER` word, any delimiter) are never split
/// across a chunk boundary. 16 covers any realistic delimiter.
const SAFE_TAIL: usize = 16;

#[derive(Clone, Copy)]
enum SMode {
    Normal,
    Quote(u8),
    Line,
    Block,
    Delim,
}

/// Incremental, quote/comment/`DELIMITER`-aware statement splitter. State
/// persists across `feed` calls so a statement (or string literal) may span
/// any number of chunks. Recognizes `-- @BM:` line comments as region markers.
struct StreamSplitter {
    delim: Vec<u8>,
    buf: Vec<u8>,
    comment: Vec<u8>,
    delim_acc: Vec<u8>,
    carry: Vec<u8>,
    mode: SMode,
}

impl StreamSplitter {
    fn new() -> Self {
        Self {
            delim: b";".to_vec(),
            buf: Vec::with_capacity(4096),
            comment: Vec::new(),
            delim_acc: Vec::new(),
            carry: Vec::new(),
            mode: SMode::Normal,
        }
    }

    fn flush(&mut self, emit: &mut impl FnMut(ParseItem)) {
        let s = String::from_utf8_lossy(&self.buf);
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            emit(ParseItem::Stmt(trimmed.to_string()));
        }
        self.buf.clear();
    }

    fn finish_comment(&mut self, emit: &mut impl FnMut(ParseItem)) {
        let line = String::from_utf8_lossy(&self.comment);
        if let Some(m) = classify_marker(&line) {
            emit(ParseItem::Marker(m));
        }
        self.comment.clear();
    }

    /// Feeds a chunk. `final_chunk` flushes the trailing statement. The
    /// `emit` callback receives statements and markers in source order.
    fn feed(&mut self, chunk: &[u8], final_chunk: bool, emit: &mut impl FnMut(ParseItem)) {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let len = data.len();
        let limit = if final_chunk {
            len
        } else {
            len.saturating_sub(SAFE_TAIL)
        };

        let mut i = 0;
        while i < limit {
            match self.mode {
                SMode::Normal => {
                    let b = data[i];
                    // DELIMITER directive (line start only).
                    if (self.buf.is_empty() || self.buf.last() == Some(&b'\n'))
                        && at_word_ci(&data, i, b"DELIMITER")
                    {
                        i += 9;
                        self.delim_acc.clear();
                        self.mode = SMode::Delim;
                        continue;
                    }
                    if b == b'-' && data.get(i + 1) == Some(&b'-') {
                        self.comment.clear();
                        self.comment.extend_from_slice(b"--");
                        i += 2;
                        self.mode = SMode::Line;
                        continue;
                    }
                    if b == b'#' {
                        self.comment.clear();
                        self.comment.push(b'#');
                        i += 1;
                        self.mode = SMode::Line;
                        continue;
                    }
                    if b == b'/' && data.get(i + 1) == Some(&b'*') {
                        i += 2;
                        self.mode = SMode::Block;
                        continue;
                    }
                    if b == b'\'' || b == b'"' || b == b'`' {
                        self.buf.push(b);
                        i += 1;
                        self.mode = SMode::Quote(b);
                        continue;
                    }
                    if at_str(&data, i, &self.delim) {
                        self.flush(emit);
                        i += self.delim.len();
                        continue;
                    }
                    self.buf.push(b);
                    i += 1;
                }
                SMode::Quote(q) => {
                    let c = data[i];
                    if c == b'\\' && i + 1 < len {
                        // Backslash-escape (\' \" \\ etc) — keep both bytes.
                        self.buf.push(c);
                        self.buf.push(data[i + 1]);
                        i += 2;
                        continue;
                    }
                    if c == q {
                        if data.get(i + 1) == Some(&q) {
                            // Doubled quote = escape (ANSI). Keep both.
                            self.buf.push(c);
                            self.buf.push(c);
                            i += 2;
                            continue;
                        }
                        self.buf.push(c);
                        i += 1;
                        self.mode = SMode::Normal;
                        continue;
                    }
                    self.buf.push(c);
                    i += 1;
                }
                SMode::Line => {
                    // Comment runs until EOL. The `\n` is left for Normal mode
                    // to push (preserves line-start tracking for DELIMITER).
                    if data[i] == b'\n' {
                        self.finish_comment(emit);
                        self.mode = SMode::Normal;
                        continue;
                    }
                    self.comment.push(data[i]);
                    i += 1;
                }
                SMode::Block => {
                    if data[i] == b'*' && data.get(i + 1) == Some(&b'/') {
                        i += 2;
                        self.mode = SMode::Normal;
                        continue;
                    }
                    i += 1;
                }
                SMode::Delim => {
                    let c = data[i];
                    if c == b'\n' || c == b'\r' {
                        let nd = String::from_utf8_lossy(&self.delim_acc).trim().to_string();
                        if !nd.is_empty() {
                            self.delim = nd.into_bytes();
                        }
                        self.delim_acc.clear();
                        self.mode = SMode::Normal;
                        i += 1;
                        continue;
                    }
                    if self.delim_acc.is_empty() && (c == b' ' || c == b'\t') {
                        i += 1;
                        continue;
                    }
                    self.delim_acc.push(c);
                    i += 1;
                }
            }
        }

        self.carry = data[i..].to_vec();

        if final_chunk {
            if matches!(self.mode, SMode::Line) {
                self.finish_comment(emit);
                self.mode = SMode::Normal;
            }
            if matches!(self.mode, SMode::Delim) {
                let nd = String::from_utf8_lossy(&self.delim_acc).trim().to_string();
                if !nd.is_empty() {
                    self.delim = nd.into_bytes();
                }
                self.mode = SMode::Normal;
            }
            self.flush(emit);
        }
    }
}

/// Convenience wrapper used by tests (and as the reference for chunked
/// equivalence): runs the whole string through the splitter in one feed.
#[cfg(test)]
fn split_statements(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut sp = StreamSplitter::new();
    sp.feed(src.as_bytes(), true, &mut |item| {
        if let ParseItem::Stmt(s) = item {
            out.push(s);
        }
    });
    out
}

// ============================================================ blocking parser

/// Streams the source (file or every `.sql` zip entry) through the splitter,
/// sending each item to `tx`. Runs on a blocking thread (`ZipFile`/file IO).
/// Sets `abort` and returns if the receiver is gone (downstream stopped).
fn parse_source_blocking(
    path: &str,
    tx: tokio::sync::mpsc::Sender<ParseItem>,
    abort: &AtomicBool,
) -> Result<(), String> {
    let p = Path::new(path);
    let is_zip = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    let mut emit = |item: ParseItem| {
        if tx.blocking_send(item).is_err() {
            abort.store(true, Ordering::Relaxed);
        }
    };

    if is_zip {
        let f = std::fs::File::open(p).map_err(|e| format!("abrir zip: {}", e))?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("ler zip: {}", e))?;
        let mut names: Vec<String> = (0..zip.len())
            .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
            .filter(|n| n.to_lowercase().ends_with(".sql"))
            .collect();
        names.sort();
        for name in names {
            if abort.load(Ordering::Relaxed) {
                return Ok(());
            }
            // Synthetic marker sets the entry's base region; inner @BM markers
            // (table entries carry @BM:T/@BM:D) refine it.
            let base = if name.ends_with("00_header.sql") {
                Marker::Dump
            } else if name.ends_with("zz_footer.sql") {
                Marker::Footer
            } else if name.ends_with("zz_indexes.sql") {
                // Deferred secondary indexes — run after the data barrier.
                Marker::Indexes
            } else {
                // 00_schema.sql and table entries start in the DDL region.
                Marker::Table
            };
            emit(ParseItem::Marker(base));

            let mut entry = zip
                .by_name(&name)
                .map_err(|e| format!("ler entry {}: {}", name, e))?;
            let mut sp = StreamSplitter::new();
            let mut rbuf = [0u8; READ_CHUNK];
            loop {
                if abort.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let n = entry
                    .read(&mut rbuf)
                    .map_err(|e| format!("ler entry {}: {}", name, e))?;
                if n == 0 {
                    break;
                }
                sp.feed(&rbuf[..n], false, &mut emit);
            }
            sp.feed(&[], true, &mut emit);
        }
    } else {
        let f = std::fs::File::open(p).map_err(|e| format!("abrir arquivo: {}", e))?;
        let mut reader = BufReader::new(f);
        let mut sp = StreamSplitter::new();
        let mut rbuf = [0u8; READ_CHUNK];
        loop {
            if abort.load(Ordering::Relaxed) {
                return Ok(());
            }
            let n = reader
                .read(&mut rbuf)
                .map_err(|e| format!("ler arquivo: {}", e))?;
            if n == 0 {
                break;
            }
            sp.feed(&rbuf[..n], false, &mut emit);
        }
        sp.feed(&[], true, &mut emit);
    }
    Ok(())
}

// ============================================================ execution

/// Per-statement execution context, cloned into each parallel worker.
#[derive(Clone)]
struct ExecCtx {
    schema: Option<String>,
    target_is_pg: bool,
    needs_translate: bool,
    source_dialect: Dialect,
    target_dialect: Dialect,
    session_prelude: String,
    /// Session SETs run ONCE at the start of a batched transaction (so the
    /// per-statement `session_prelude` isn't paid per INSERT). MySQL-only —
    /// empty for other targets, since the SETs are MySQL syntax.
    batch_pre: Vec<String>,
}

/// Flush the pending insert batch once it reaches this many statements...
const BATCH_MAX_STMTS: usize = 500;
/// ...or this many bytes of accumulated SQL (whichever comes first).
const BATCH_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Cap for a single coalesced INSERT — kept well under MySQL's default
/// `max_allowed_packet` (4-64 MB) so a merged multi-row insert never overflows.
const COALESCE_MAX_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct Prog {
    done: AtomicU64,
    errs: AtomicU32,
}

#[derive(Clone, Copy, PartialEq)]
enum Region {
    Header,
    Ddl,
    Data,
    Indexes,
    Footer,
}

impl Region {
    fn label(self) -> &'static str {
        match self {
            Region::Header => "header",
            Region::Ddl => "structure",
            Region::Data => "data",
            Region::Indexes => "indexes",
            Region::Footer => "footer",
        }
    }
}

fn build_exec_ctx(
    opts: &ImportOptions,
    target: &dyn Driver,
    sample: &str,
    session_prelude: &str,
) -> ExecCtx {
    let target_dialect = Dialect::from_driver_name(target.dialect());
    let source_dialect = detect_dialect(sample);
    let needs_translate = source_dialect != Dialect::Unknown
        && target_dialect != Dialect::Unknown
        && source_dialect != target_dialect;
    // The batched-tx prelude mirrors `session_prelude`'s SETs, but as discrete
    // statements (run once on the pinned conn) and only for MySQL targets.
    let mut batch_pre = Vec::new();
    if target_dialect == Dialect::Mysql {
        if opts.disable_fk_checks {
            batch_pre.push("SET FOREIGN_KEY_CHECKS=0".to_string());
        }
        if opts.disable_unique_checks {
            batch_pre.push("SET UNIQUE_CHECKS=0".to_string());
        }
        if opts.preserve_zero_auto_increment {
            batch_pre.push("SET sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO')".to_string());
        }
    }
    ExecCtx {
        schema: opts.schema.clone(),
        target_is_pg: target_dialect == Dialect::Postgres,
        needs_translate,
        source_dialect,
        target_dialect,
        session_prelude: session_prelude.to_string(),
        batch_pre,
    }
}

/// Normalizes a raw statement to the final SQL to run: drops empties and
/// already-applied session SETs, translates dialects, and skips statements with
/// no analog on the target. `None` means "skip" (not counted, not an error).
fn prepare_stmt(ctx: &ExecCtx, stmt: &str) -> Option<String> {
    let trimmed = stmt.trim();
    if trimmed.is_empty() || is_duplicate_session_set(trimmed) {
        return None;
    }
    let translated = if ctx.needs_translate {
        normalize_for(trimmed, ctx.source_dialect, ctx.target_dialect)
    } else {
        trimmed.to_string()
    };
    let final_sql = translated.trim();
    if final_sql.is_empty() || should_skip_for_target(final_sql, ctx.target_dialect) {
        return None;
    }
    Some(final_sql.to_string())
}

/// Executes an already-prepared statement (autocommit), prepending the
/// per-statement session prelude for non-PG targets.
async fn run_prepared(target: &dyn Driver, ctx: &ExecCtx, final_sql: &str) -> Result<(), String> {
    let wrapped = if ctx.target_is_pg {
        final_sql.to_string()
    } else {
        format!("{}{}", ctx.session_prelude, final_sql)
    };
    target
        .execute(ctx.schema.as_deref(), &wrapped)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Max transient-error retries before giving up on a statement/batch.
const TRANSIENT_MAX_RETRIES: u32 = 8;
/// Base backoff, doubled each attempt and capped. Gives Windows TIME_WAIT
/// slots time to drain and a dropped server time to come back.
const TRANSIENT_BACKOFF_BASE_MS: u64 = 500;
const TRANSIENT_BACKOFF_MAX_MS: u64 = 15_000;

/// Transport-level failures — the link broke, the statement itself is fine.
/// Distinct from a SQL error on a bad row: worth a backoff+retry rather than
/// being skipped (silent data loss) or aborting the whole import. Covers the
/// Windows socket errors (incl. 10048 = local ephemeral port exhausted, the
/// cascade symptom of a reconnect storm after the server drops) plus the
/// generic sqlx "communicating" / pool messages.
fn is_transient(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("error communicating with database")
        || m.contains("os error 10048") // address in use — local ports exhausted
        || m.contains("os error 10053") // connection aborted by host
        || m.contains("os error 10054") // connection reset by peer
        || m.contains("os error 10060") // connect timed out
        || m.contains("os error 10061") // connection refused
        || m.contains("broken pipe")
        || m.contains("connection reset")
        || m.contains("connection refused")
        || m.contains("pool timed out")
}

/// Sleeps an exponential backoff for retry `attempt` (0-based).
async fn transient_backoff(attempt: u32) {
    let ms = (TRANSIENT_BACKOFF_BASE_MS << attempt.min(5)).min(TRANSIENT_BACKOFF_MAX_MS);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// Runs an already-prepared statement, retrying transport failures with
/// backoff. SQL errors (bad row) return immediately. Bails between retries if
/// the transfer was cancelled/aborted so a dead server doesn't pin the import.
async fn run_prepared_resilient(
    target: &dyn Driver,
    ctx: &ExecCtx,
    final_sql: &str,
    control: &TransferControl,
    abort: &AtomicBool,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        match run_prepared(target, ctx, final_sql).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if !is_transient(&e)
                    || attempt >= TRANSIENT_MAX_RETRIES
                    || abort.load(Ordering::Relaxed)
                    || !control.check().await
                {
                    return Err(e);
                }
                transient_backoff(attempt).await;
                attempt += 1;
            }
        }
    }
}

/// `exec_one` with transport-failure retry (see [`run_prepared_resilient`]).
async fn exec_one_resilient(
    target: &dyn Driver,
    ctx: &ExecCtx,
    stmt: &str,
    control: &TransferControl,
    abort: &AtomicBool,
) -> Result<bool, String> {
    match prepare_stmt(ctx, stmt) {
        None => Ok(false),
        Some(final_sql) => run_prepared_resilient(target, ctx, &final_sql, control, abort)
            .await
            .map(|_| true),
    }
}

/// True for data statements worth batching into a transaction: `INSERT`/
/// `REPLACE ... `. Other statements (DDL, SET, LOCK…) run inline.
fn is_batchable_insert(sql: &str) -> bool {
    let b = sql.trim_start().as_bytes();
    at_word_ci(b, 0, b"INSERT") || at_word_ci(b, 0, b"REPLACE")
}

/// Splits `INSERT/REPLACE ... VALUES (..)(,(..))*` into `(prefix, tuples)` where
/// `prefix` ends at the `VALUES` keyword and `tuples` is the comma-separated
/// row groups. Returns `None` for anything that isn't a clean multi-tuple VALUES
/// insert (e.g. `INSERT ... SELECT`, `ON DUPLICATE KEY UPDATE`, `SET` form) so
/// the caller skips coalescing it.
fn split_insert(stmt: &str) -> Option<(&str, &str)> {
    let bytes = stmt.as_bytes();
    let n = bytes.len();
    if !(at_word_ci(bytes, 0, b"INSERT") || at_word_ci(bytes, 0, b"REPLACE")) {
        return None;
    }
    // Scan to the `VALUES` keyword at paren depth 0, outside quotes.
    let mut i = 0usize;
    let mut depth = 0i32;
    let mut values_end = None;
    while i < n {
        let b = bytes[i];
        match b {
            b'\'' | b'"' | b'`' => i = skip_quoted(bytes, i),
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
            }
            _ => {
                if depth == 0
                    && (b == b'V' || b == b'v')
                    && at_word_ci(bytes, i, b"VALUES")
                    && (i == 0 || !is_ident_byte(bytes[i - 1]))
                {
                    values_end = Some(i + 6);
                    break;
                }
                i += 1;
            }
        }
    }
    let ve = values_end?;
    let prefix = stmt[..ve].trim_end();
    let tuples = stmt[ve..].trim_start();
    if !tuples.starts_with('(') || !tuples_are_clean(tuples) {
        return None;
    }
    Some((prefix, tuples))
}

/// Validates `tuples` is exactly balanced `(...)` groups separated by commas
/// with nothing trailing — rejects `ON DUPLICATE KEY UPDATE` and other tails.
fn tuples_are_clean(s: &str) -> bool {
    let b = s.as_bytes();
    let n = b.len();
    let mut i = 0;
    loop {
        while i < n && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= n || b[i] != b'(' {
            return false;
        }
        let mut depth = 0i32;
        while i < n {
            match b[i] {
                b'\'' | b'"' | b'`' => i = skip_quoted(b, i),
                b'(' => {
                    depth += 1;
                    i += 1;
                }
                b')' => {
                    depth -= 1;
                    i += 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => i += 1,
            }
        }
        if depth != 0 {
            return false;
        }
        while i < n && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= n {
            return true;
        }
        if b[i] == b',' {
            i += 1;
            continue;
        }
        return false;
    }
}

/// Merges consecutive INSERTs that share an identical `... VALUES` prefix into
/// one extended insert, capped at `max_bytes`. Non-coalescable statements pass
/// through unchanged. This is the lookahead "prepare the next inserts" step:
/// many single-row `INSERT INTO t VALUES (..)` become `INSERT INTO t VALUES
/// (..),(..),...`, cutting per-statement parse/execute overhead on the server.
fn coalesce_inserts(stmts: &[String], max_bytes: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // (prefix, accumulated full SQL) of the insert being extended.
    let mut cur: Option<(String, String)> = None;
    for s in stmts {
        match split_insert(s) {
            Some((prefix, tuples)) => {
                if let Some((cp, acc)) = &mut cur {
                    if cp == prefix && acc.len() + 1 + tuples.len() <= max_bytes {
                        acc.push(',');
                        acc.push_str(tuples);
                        continue;
                    }
                    out.push(cur.take().unwrap().1);
                }
                cur = Some((prefix.to_string(), format!("{} {}", prefix, tuples)));
            }
            None => {
                if let Some((_, acc)) = cur.take() {
                    out.push(acc);
                }
                out.push(s.clone());
            }
        }
    }
    if let Some((_, acc)) = cur {
        out.push(acc);
    }
    out
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Returns the index just past a quoted span starting at `i` (quote char
/// `'`/`"`/`` ` ``), honoring backslash and doubled-quote escapes.
fn skip_quoted(bytes: &[u8], i: usize) -> usize {
    let q = bytes[i];
    let n = bytes.len();
    let mut j = i + 1;
    while j < n {
        let c = bytes[j];
        if c == b'\\' && q != b'`' {
            j += 2;
            continue;
        }
        if c == q {
            if j + 1 < n && bytes[j + 1] == q {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j += 1;
    }
    n
}

fn emit_progress(app: &AppHandle, prog: &Prog, source: &str) {
    let _ = app.emit(
        "sql_import:progress",
        &ImportProgress {
            statements_done: prog.done.load(Ordering::Relaxed),
            errors: prog.errs.load(Ordering::Relaxed),
            current_source: source.to_string(),
        },
    );
}

fn emit_stmt_error(app: &AppHandle, index: u64, stmt: &str, message: &str) {
    let _ = app.emit(
        "sql_import:stmt_error",
        &ImportStmtError {
            index,
            sql: stmt.trim().chars().take(500).collect(),
            message: message.to_string(),
        },
    );
}

/// Commits the pending insert batch as ONE transaction (coalescing same-prefix
/// inserts first). On success the whole batch counts as `batch.len()` done
/// statements. On any DB error the batch is replayed statement-by-statement in
/// autocommit so the offending row is isolated, reported, and (with
/// `continue_on_error`) skipped while the rest still apply. Returns `false` when
/// the caller should stop (fatal error without `continue_on_error`).
#[allow(clippy::too_many_arguments)]
async fn flush_batch(
    app: &AppHandle,
    target: &dyn Driver,
    ctx: &ExecCtx,
    prog: &Prog,
    emit_every: u32,
    continue_on_error: bool,
    first_err: &tokio::sync::Mutex<Option<String>>,
    abort: &AtomicBool,
    control: &TransferControl,
    batch: &mut Vec<String>,
    batch_bytes: &mut usize,
) -> bool {
    if batch.is_empty() {
        return true;
    }
    let coalesced = coalesce_inserts(batch, COALESCE_MAX_BYTES);
    let mut keep_going = true;
    // Retry the whole batch tx on transport failures (server drop / port
    // exhaustion) before falling back to slow per-statement replay. The tx
    // rolls back fully on error, so a retry re-applies the batch cleanly.
    let mut attempt = 0u32;
    let batch_result = loop {
        match target
            .execute_batch_tx(ctx.schema.as_deref(), &ctx.batch_pre, &coalesced)
            .await
        {
            Ok(_) => break Ok(()),
            Err(e) => {
                if is_transient(&e.to_string())
                    && attempt < TRANSIENT_MAX_RETRIES
                    && !abort.load(Ordering::Relaxed)
                    && control.check().await
                {
                    transient_backoff(attempt).await;
                    attempt += 1;
                    continue;
                }
                break Err(e);
            }
        }
    };
    match batch_result {
        Ok(()) => {
            let n = batch.len() as u64;
            prog.done.fetch_add(n, Ordering::Relaxed);
            if emit_every > 0 {
                emit_progress(app, prog, "data");
            }
        }
        Err(_batch_err) => {
            // The tx rolled back (driver guarantees it) — nothing was applied.
            // Replay each statement on its own to apply the good rows and pin
            // the bad one.
            for s in batch.iter() {
                match run_prepared_resilient(target, ctx, s, control, abort).await {
                    Ok(()) => {
                        prog.done.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => {
                        let idx = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                        prog.errs.fetch_add(1, Ordering::Relaxed);
                        emit_stmt_error(app, idx, s, &e);
                        if !continue_on_error {
                            let mut g = first_err.lock().await;
                            if g.is_none() {
                                *g = Some(format!("stmt #{}: {}", idx, e));
                            }
                            abort.store(true, Ordering::Relaxed);
                            keep_going = false;
                            break;
                        }
                    }
                }
            }
        }
    }
    batch.clear();
    *batch_bytes = 0;
    keep_going
}

/// Drives the whole import: a blocking parser streams items, a coordinator
/// executes header/DDL/footer inline (in order) and forwards data statements
/// to a bounded worker pool. Memory is bounded by the channels, not the file.
#[allow(clippy::too_many_arguments)]
async fn run_streaming_import(
    app: &AppHandle,
    opts: &ImportOptions,
    target: Arc<dyn Driver>,
    control: &Arc<TransferControl>,
    session_prelude: &str,
    parallel_data: bool,
    concurrency: usize,
    sample: &str,
) -> Result<(u64, u32), String> {
    let ctx = build_exec_ctx(opts, &*target, sample, session_prelude);
    let prog = Arc::new(Prog::default());
    let abort = Arc::new(AtomicBool::new(false));
    let first_err: Arc<tokio::sync::Mutex<Option<String>>> =
        Arc::new(tokio::sync::Mutex::new(None));
    let emit_every = opts.emit_every;
    let continue_on_error = opts.continue_on_error;

    // Blocking parser → coordinator. Bounded for backpressure (caps memory).
    let (parse_tx, mut parse_rx) = tokio::sync::mpsc::channel::<ParseItem>(256);
    let parser = {
        let path = opts.path.clone();
        let abort = abort.clone();
        tokio::task::spawn_blocking(move || parse_source_blocking(&path, parse_tx, &abort))
    };

    // Data worker pool (parallel mode only).
    let (data_tx, data_rx) = async_channel::bounded::<String>(concurrency.max(1) * 4);
    let mut workers = Vec::new();
    if parallel_data {
        for _ in 0..concurrency {
            let data_rx = data_rx.clone();
            let app = app.clone();
            let target = target.clone();
            let ctx = ctx.clone();
            let control = control.clone();
            let prog = prog.clone();
            let abort = abort.clone();
            let first_err = first_err.clone();
            workers.push(tokio::spawn(async move {
                while let Ok(stmt) = data_rx.recv().await {
                    if abort.load(Ordering::Relaxed) || !control.check().await {
                        data_rx.close();
                        break;
                    }
                    match exec_one_resilient(&*target, &ctx, &stmt, &control, &abort).await {
                        Ok(false) => {}
                        Ok(true) => {
                            let n = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                            if emit_every > 0 && n.is_multiple_of(emit_every as u64) {
                                emit_progress(&app, &prog, "data");
                            }
                        }
                        Err(e) => {
                            let idx = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                            prog.errs.fetch_add(1, Ordering::Relaxed);
                            emit_stmt_error(&app, idx, &stmt, &e);
                            if !continue_on_error {
                                let mut g = first_err.lock().await;
                                if g.is_none() {
                                    *g = Some(format!("stmt #{}: {}", idx, e));
                                }
                                abort.store(true, Ordering::Relaxed);
                                data_rx.close();
                                break;
                            }
                        }
                    }
                }
            }));
        }
    }
    drop(data_rx); // workers hold their own clones.

    // Coordinator. `data_tx`/`workers` are Options so the post-data barrier can
    // drop the sender and join the pool mid-stream (see below).
    let mut data_tx = Some(data_tx);
    let mut workers = Some(workers);
    let mut region = Region::Header;
    // Inline-path insert batcher (foreign dumps + non-data regions). The
    // parallel BM-dump data path is untouched.
    let mut batch: Vec<String> = Vec::new();
    let mut batch_bytes = 0usize;
    while let Some(item) = parse_rx.recv().await {
        if abort.load(Ordering::Relaxed) || !control.check().await {
            break;
        }
        match item {
            ParseItem::Marker(m) => {
                // Commit pending inserts before any phase change so they land in
                // order (and before the parallel barrier drains the pool).
                if !flush_batch(
                    app, &*target, &ctx, &prog, emit_every, continue_on_error,
                    &first_err, &abort, control, &mut batch, &mut batch_bytes,
                )
                .await
                {
                    break;
                }
                let new_region = match m {
                    Marker::Dump => Region::Header,
                    Marker::Table => Region::Ddl,
                    Marker::Data => Region::Data,
                    Marker::Indexes => Region::Indexes,
                    Marker::Footer => Region::Footer,
                };
                // Barrier: the first marker that leaves the data region means
                // every INSERT has been forwarded. Drain the worker pool before
                // running post-data DDL (deferred `@BM:I` indexes, footer) so
                // indexes build over complete tables, not a partial load.
                if parallel_data
                    && region == Region::Data
                    && new_region != Region::Data
                {
                    if let Some(tx) = data_tx.take() {
                        drop(tx);
                    }
                    if let Some(ws) = workers.take() {
                        for w in ws {
                            let _ = w.await;
                        }
                    }
                }
                region = new_region;
            }
            ParseItem::Stmt(s) => {
                if parallel_data && region == Region::Data {
                    // Forward to workers (bounded send = backpressure).
                    match &data_tx {
                        Some(tx) if tx.send(s).await.is_ok() => {}
                        _ => break,
                    }
                } else if let Some(final_sql) = prepare_stmt(&ctx, &s) {
                    if is_batchable_insert(&final_sql) {
                        batch_bytes += final_sql.len();
                        batch.push(final_sql);
                        if (batch.len() >= BATCH_MAX_STMTS || batch_bytes >= BATCH_MAX_BYTES)
                            && !flush_batch(
                                app, &*target, &ctx, &prog, emit_every, continue_on_error,
                                &first_err, &abort, control, &mut batch, &mut batch_bytes,
                            )
                            .await
                        {
                            break;
                        }
                    } else {
                        // Non-insert (DDL/SET/…): commit pending inserts first so
                        // ordering against this statement is preserved.
                        if !flush_batch(
                            app, &*target, &ctx, &prog, emit_every, continue_on_error,
                            &first_err, &abort, control, &mut batch, &mut batch_bytes,
                        )
                        .await
                        {
                            break;
                        }
                        match run_prepared_resilient(&*target, &ctx, &final_sql, control, &abort).await {
                            Ok(()) => {
                                let n = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                                if emit_every > 0 && n.is_multiple_of(emit_every as u64) {
                                    emit_progress(app, &prog, region.label());
                                }
                            }
                            Err(e) => {
                                let idx = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                                prog.errs.fetch_add(1, Ordering::Relaxed);
                                emit_stmt_error(app, idx, &final_sql, &e);
                                if !continue_on_error {
                                    let mut g = first_err.lock().await;
                                    if g.is_none() {
                                        *g = Some(format!("stmt #{}: {}", idx, e));
                                    }
                                    abort.store(true, Ordering::Relaxed);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Commit the trailing batch (unless we stopped early — then leave it
    // uncommitted, matching the partial-import-on-cancel semantics).
    if !abort.load(Ordering::Relaxed) {
        let _ = flush_batch(
            app, &*target, &ctx, &prog, emit_every, continue_on_error,
            &first_err, &abort, control, &mut batch, &mut batch_bytes,
        )
        .await;
    }

    // Drop the receiver first : if we broke early (abort), this unblocks the
    // parser's next `blocking_send` (which then sees the closed channel and
    // returns) instead of letting it wait forever on a full queue.
    drop(parse_rx);
    if let Some(tx) = data_tx.take() {
        drop(tx); // no more data : workers drain and exit.
    }
    if let Some(ws) = workers.take() {
        for w in ws {
            let _ = w.await;
        }
    }
    let parse_result = parser
        .await
        .map_err(|e| format!("parser join: {}", e))?;

    emit_progress(app, &prog, "done");

    if let Some(e) = first_err.lock().await.take() {
        return Err(e);
    }
    // Surface read/open errors only if nothing else failed first.
    parse_result?;
    Ok((
        prog.done.load(Ordering::Relaxed),
        prog.errs.load(Ordering::Relaxed),
    ))
}

// ============================================================ skip/translate

/// Skips statements clearly incompatible with the target that have no
/// trivial analog — silent, doesn't count as an error. Prevents
/// "Unknown command" errors that only clutter the UI.
fn should_skip_for_target(stmt: &str, target: Dialect) -> bool {
    let upper = stmt.trim_start().to_uppercase();
    match target {
        Dialect::Postgres => {
            // MySQL statements left over without a PG analog.
            upper.starts_with("DELIMITER ")
                || upper.starts_with("LOCK TABLES")
                || upper.starts_with("UNLOCK TABLES")
                || upper.starts_with("ALTER DATABASE") // charset/collation MySQL
                || upper.starts_with("ANALYZE TABLE")
                || upper.starts_with("OPTIMIZE TABLE")
                || upper.starts_with("CHECK TABLE")
                || upper.starts_with("REPAIR TABLE")
                || upper.starts_with("FLUSH ")
                || upper.starts_with("USE ") // USE doesn't exist on PG (search_path already set)
                // MySQL deferred-index ALTER (`ADD KEY`/`INDEX`/`FULLTEXT`/
                // `SPATIAL`) has no PG analog — skip rather than error out.
                || (upper.starts_with("ALTER TABLE")
                    && (upper.contains(" ADD KEY")
                        || upper.contains(" ADD INDEX")
                        || upper.contains(" ADD FULLTEXT")
                        || upper.contains(" ADD SPATIAL")))
                || (upper.starts_with("SET ")
                    && (upper.contains("FOREIGN_KEY_CHECKS")
                        || upper.contains("UNIQUE_CHECKS")
                        || upper.contains("SQL_LOG_BIN")
                        || upper.contains("SQL_MODE")
                        || upper.contains("@@SESSION")
                        || upper.contains("SQL_NOTES")))
        }
        Dialect::Mysql => {
            // PG statements that don't run on MySQL.
            upper.starts_with("SET SEARCH_PATH")
                || upper.starts_with("CREATE EXTENSION")
                || upper.starts_with("ALTER EXTENSION")
                || upper.starts_with("REINDEX")
                || upper.starts_with("VACUUM")
                || upper.starts_with("CLUSTER")
                || upper.starts_with("COMMENT ON ") // PG-specific form
                || upper.contains("OWNER TO ")
        }
        Dialect::Unknown => false,
    }
}

/// Detects global SETs that our prelude will already apply per-statement,
/// to avoid running them twice (harmless, but noisy and slow). Heuristic
/// match via substring.
fn is_duplicate_session_set(stmt: &str) -> bool {
    let upper = stmt.to_uppercase();
    if !upper.starts_with("SET ") {
        return false;
    }
    upper.contains("FOREIGN_KEY_CHECKS")
        || upper.contains("UNIQUE_CHECKS")
        || upper.contains("NO_AUTO_VALUE_ON_ZERO")
        || upper.starts_with("SET NAMES")
}

fn at_str(bytes: &[u8], i: usize, needle: &[u8]) -> bool {
    if i + needle.len() > bytes.len() {
        return false;
    }
    &bytes[i..i + needle.len()] == needle
}

fn at_word_ci(bytes: &[u8], i: usize, needle: &[u8]) -> bool {
    if i + needle.len() > bytes.len() {
        return false;
    }
    for (k, &n) in needle.iter().enumerate() {
        if !bytes[i + k].eq_ignore_ascii_case(&n) {
            return false;
        }
    }
    // Delimiter after the word — next byte cannot be alphanumeric.
    if i + needle.len() < bytes.len() {
        let next = bytes[i + needle.len()];
        if next.is_ascii_alphanumeric() || next == b'_' {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds `src` through the splitter in `chunk` byte slices, collecting
    /// statements. Used to assert chunk-size independence.
    fn split_chunked(src: &str, chunk: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut sp = StreamSplitter::new();
        let bytes = src.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let end = (i + chunk).min(bytes.len());
            sp.feed(&bytes[i..end], false, &mut |item| {
                if let ParseItem::Stmt(s) = item {
                    out.push(s);
                }
            });
            i = end;
        }
        sp.feed(&[], true, &mut |item| {
            if let ParseItem::Stmt(s) = item {
                out.push(s);
            }
        });
        out
    }

    #[test]
    fn signature_detected_on_first_line() {
        assert!(sql_has_signature("-- @BM:DUMP v1\n/* ... */\nSET NAMES utf8mb4;"));
        assert!(!sql_has_signature("-- random dump from mysqldump\nSET NAMES;"));
    }

    #[test]
    fn classify_marker_kinds() {
        assert!(matches!(classify_marker("-- @BM:DUMP v1"), Some(Marker::Dump)));
        assert!(matches!(
            classify_marker("-- @BM:T idx=0 schema=s table=t"),
            Some(Marker::Table)
        ));
        assert!(matches!(classify_marker("-- @BM:D idx=0"), Some(Marker::Data)));
        assert!(matches!(classify_marker("-- @BM:I"), Some(Marker::Indexes)));
        assert!(matches!(classify_marker("-- @BM:F"), Some(Marker::Footer)));
        assert!(classify_marker("-- regular comment").is_none());
        assert!(classify_marker("INSERT INTO t VALUES (1);").is_none());
    }

    #[test]
    fn stream_emits_markers_in_order() {
        let sql = "-- @BM:DUMP v1\n\
                   SET NAMES utf8mb4;\n\
                   -- @BM:T idx=0 schema=s table=a\n\
                   CREATE TABLE a (id INT);\n\
                   -- @BM:D idx=0\n\
                   INSERT INTO s.a VALUES (1);\n\
                   -- @BM:F\n\
                   SET FOREIGN_KEY_CHECKS = 1;\n";
        let mut markers = Vec::new();
        let mut stmts = Vec::new();
        let mut sp = StreamSplitter::new();
        sp.feed(sql.as_bytes(), true, &mut |item| match item {
            ParseItem::Marker(m) => markers.push(m),
            ParseItem::Stmt(s) => stmts.push(s),
        });
        assert_eq!(markers.len(), 4); // DUMP, T, D, F
        assert!(matches!(markers[0], Marker::Dump));
        assert!(matches!(markers[1], Marker::Table));
        assert!(matches!(markers[2], Marker::Data));
        assert!(matches!(markers[3], Marker::Footer));
        // Statements: SET NAMES, CREATE, INSERT, SET FK=1.
        assert!(stmts.iter().any(|s| s.contains("CREATE TABLE a")));
        assert!(stmts.iter().any(|s| s.contains("INSERT INTO s.a")));
    }

    #[test]
    fn split_two_statements() {
        let out = split_statements("SELECT 1; SELECT 2;");
        assert_eq!(out, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn split_trailing_without_semicolon() {
        let out = split_statements("SELECT 1; SELECT 2");
        assert_eq!(out, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn split_ignores_semicolons_inside_single_quotes() {
        let out = split_statements("INSERT INTO t VALUES ('a;b'); SELECT 2;");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("'a;b'"));
    }

    #[test]
    fn split_ignores_semicolons_inside_backticks() {
        let out = split_statements("SELECT `col;with;semi` FROM t; SELECT 1;");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("`col;with;semi`"));
    }

    #[test]
    fn split_strips_line_comments() {
        let out = split_statements("-- comentário\nSELECT 1;\n-- outro\nSELECT 2;");
        assert_eq!(out.len(), 2);
        assert!(!out.iter().any(|s| s.contains("comentário")));
    }

    #[test]
    fn split_strips_hash_comments() {
        let out = split_statements("# mysql-style\nSELECT 1;");
        assert_eq!(out, vec!["SELECT 1"]);
    }

    #[test]
    fn split_strips_block_comments() {
        let out = split_statements("/* multiline\ncomment */ SELECT 1;");
        assert_eq!(out, vec!["SELECT 1"]);
    }

    #[test]
    fn split_handles_delimiter_directive() {
        let src = "DELIMITER $$\nCREATE TRIGGER foo BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;";
        let out = split_statements(src);
        // One entire trigger + one SELECT. The internal split by `;` does not
        // fragment the block inside the DELIMITER $$.
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("CREATE TRIGGER"));
        assert!(out[0].contains("END"));
        assert_eq!(out[1], "SELECT 2");
    }

    #[test]
    fn split_empty_input_returns_empty() {
        assert!(split_statements("").is_empty());
        assert!(split_statements("   \n\t  ").is_empty());
        assert!(split_statements(";;;").is_empty());
    }

    #[test]
    fn split_preserves_multibyte_utf8() {
        let out = split_statements(
            "INSERT INTO t VALUES ('café', 'açúcar', '日本語', '😀'); SELECT 1;",
        );
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("café"));
        assert!(out[0].contains("açúcar"));
        assert!(out[0].contains("日本語"));
        assert!(out[0].contains('😀'));
    }

    #[test]
    fn split_handles_escaped_quotes() {
        let out = split_statements("INSERT INTO t VALUES ('it\\'s; a test'); SELECT 1;");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("it\\'s; a test"));
    }

    #[test]
    fn chunked_matches_whole_for_tricky_input() {
        // Spans quotes, comments, DELIMITER, multibyte, escapes. The result
        // must be identical no matter the chunk boundary.
        let src = "-- @BM:DUMP v1\n\
                   SET NAMES utf8mb4;\n\
                   /* block; with; semis */\n\
                   INSERT INTO t VALUES ('a;b', 'esc\\'aped', 'café日本😀');\n\
                   DELIMITER $$\n\
                   CREATE TRIGGER x BEGIN SELECT 1; END$$\n\
                   DELIMITER ;\n\
                   -- @BM:D idx=0\n\
                   INSERT INTO t VALUES (1),(2);\n";
        let whole = split_statements(src);
        for chunk in [1usize, 2, 3, 5, 7, 13, 64] {
            assert_eq!(split_chunked(src, chunk), whole, "chunk size {}", chunk);
        }
    }

    #[test]
    fn chunked_emits_markers_regardless_of_boundary() {
        let src = "-- @BM:DUMP v1\nA;\n-- @BM:T idx=0 schema=s table=a\nB;\n-- @BM:D idx=0\nC;\n-- @BM:F\nD;\n";
        for chunk in [1usize, 2, 3, 4, 9, 32] {
            let mut markers = Vec::new();
            let mut sp = StreamSplitter::new();
            let bytes = src.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                let end = (i + chunk).min(bytes.len());
                sp.feed(&bytes[i..end], false, &mut |item| {
                    if let ParseItem::Marker(m) = item {
                        markers.push(m);
                    }
                });
                i = end;
            }
            sp.feed(&[], true, &mut |item| {
                if let ParseItem::Marker(m) = item {
                    markers.push(m);
                }
            });
            assert_eq!(markers.len(), 4, "chunk {}", chunk);
        }
    }

    #[test]
    fn at_str_matches_exact_slice() {
        assert!(at_str(b"hello world", 0, b"hello"));
        assert!(at_str(b"hello world", 6, b"world"));
        assert!(!at_str(b"hello", 0, b"hello!"));
    }

    #[test]
    fn at_word_ci_matches_case_insensitive() {
        assert!(at_word_ci(b"DELIMITER $$", 0, b"DELIMITER"));
        assert!(at_word_ci(b"delimiter $$", 0, b"DELIMITER"));
    }

    #[test]
    fn at_word_ci_rejects_prefix_of_longer_word() {
        assert!(!at_word_ci(b"DELIMITERED", 0, b"DELIMITER"));
        assert!(!at_word_ci(b"DELIMITER_FOO", 0, b"DELIMITER"));
    }

    #[test]
    fn batchable_recognizes_insert_and_replace() {
        assert!(is_batchable_insert("INSERT INTO t VALUES (1)"));
        assert!(is_batchable_insert("insert into t values (1)"));
        assert!(is_batchable_insert("REPLACE INTO t VALUES (1)"));
        assert!(!is_batchable_insert("CREATE TABLE t (id INT)"));
        assert!(!is_batchable_insert("SELECT 1"));
        assert!(!is_batchable_insert("INSERTED INTO t")); // word-boundary
    }

    #[test]
    fn split_insert_basic() {
        let (p, t) = split_insert("INSERT INTO `t` (`a`,`b`) VALUES (1,'x')").unwrap();
        assert_eq!(p, "INSERT INTO `t` (`a`,`b`) VALUES");
        assert_eq!(t, "(1,'x')");
    }

    #[test]
    fn split_insert_multi_tuple() {
        let (p, t) = split_insert("INSERT INTO t VALUES (1),(2),(3)").unwrap();
        assert_eq!(p, "INSERT INTO t VALUES");
        assert_eq!(t, "(1),(2),(3)");
    }

    #[test]
    fn split_insert_ignores_keyword_inside_strings_and_idents() {
        // `VALUES` as a column name and inside a string literal must not match.
        let s = "INSERT INTO t (`values`) VALUES ('a (VALUES) ;b')";
        let (p, t) = split_insert(s).unwrap();
        assert_eq!(p, "INSERT INTO t (`values`) VALUES");
        assert_eq!(t, "('a (VALUES) ;b')");
    }

    #[test]
    fn split_insert_rejects_non_values_forms() {
        // INSERT ... SELECT has no VALUES tuples.
        assert!(split_insert("INSERT INTO t SELECT * FROM u").is_none());
        // ON DUPLICATE KEY UPDATE leaves a trailing tail → not coalescable.
        assert!(
            split_insert("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a=1").is_none()
        );
        // SET form.
        assert!(split_insert("INSERT INTO t SET a=1").is_none());
        assert!(split_insert("CREATE TABLE t (id INT)").is_none());
    }

    #[test]
    fn coalesce_merges_same_prefix() {
        let stmts = vec![
            "INSERT INTO t VALUES (1)".to_string(),
            "INSERT INTO t VALUES (2)".to_string(),
            "INSERT INTO t VALUES (3)".to_string(),
        ];
        let out = coalesce_inserts(&stmts, COALESCE_MAX_BYTES);
        assert_eq!(out, vec!["INSERT INTO t VALUES (1),(2),(3)"]);
    }

    #[test]
    fn coalesce_breaks_on_different_prefix() {
        let stmts = vec![
            "INSERT INTO a VALUES (1)".to_string(),
            "INSERT INTO a VALUES (2)".to_string(),
            "INSERT INTO b VALUES (9)".to_string(),
        ];
        let out = coalesce_inserts(&stmts, COALESCE_MAX_BYTES);
        assert_eq!(
            out,
            vec!["INSERT INTO a VALUES (1),(2)", "INSERT INTO b VALUES (9)"]
        );
    }

    #[test]
    fn coalesce_respects_byte_cap() {
        let stmts = vec![
            "INSERT INTO t VALUES (1)".to_string(),
            "INSERT INTO t VALUES (2)".to_string(),
        ];
        // Cap below the merged size forces two separate statements.
        let out = coalesce_inserts(&stmts, 24);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn coalesce_passes_through_non_inserts() {
        let stmts = vec![
            "INSERT INTO t VALUES (1)".to_string(),
            "CREATE TABLE u (id INT)".to_string(),
            "INSERT INTO t VALUES (2)".to_string(),
        ];
        let out = coalesce_inserts(&stmts, COALESCE_MAX_BYTES);
        // The DDL breaks the run; the two inserts don't merge across it.
        assert_eq!(
            out,
            vec![
                "INSERT INTO t VALUES (1)",
                "CREATE TABLE u (id INT)",
                "INSERT INTO t VALUES (2)",
            ]
        );
    }
}
