//! SQL Import V1 — runs a `.sql` (or `.zip` with multiple `.sql`s) on
//! the target. Respects strings, comments, and the `DELIMITER` directive
//! common in dumps with triggers/procedures.
//!
//! Events:
//!   `sql_import:progress` — { statements_done, errors, current_source }
//!   `sql_import:stmt_error` — { index, sql, message }
//!   `sql_import:done` — { statements_done, errors, elapsed_ms }

use std::io::Read;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use basemaster_core::Driver;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::data_transfer::TransferControl;
use crate::sql_translate::{detect_dialect, normalize_for, Dialect};

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
    /// Name of the file being processed (useful for multi-entry ZIPs).
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
    let mut total_stmts: u64 = 0;
    let mut total_errs: u32 = 0;

    if is_zip {
        let entries = read_zip_entries(&path)?;
        // Parallel only for our own dumps (signature in 00_header.sql).
        let is_ours = entries
            .iter()
            .any(|(n, c)| n.ends_with("00_header.sql") && sql_has_signature(c));
        if concurrency > 1 && is_ours {
            let (s, e) =
                run_zip_parallel(&app, &opts, target, &control, &entries, &session_prelude, concurrency)
                    .await?;
            total_stmts = s;
            total_errs = e;
        } else {
            for (name, content) in &entries {
                if !control.check().await {
                    break;
                }
                process_sql(
                    &app, &opts, &*target, &control, content, name, &session_prelude,
                    &mut total_stmts, &mut total_errs,
                )
                .await?;
            }
        }
    } else {
        let buf = std::fs::read_to_string(&path)
            .map_err(|e| format!("abrir arquivo: {}", e))?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("dump.sql")
            .to_string();
        if concurrency > 1 && sql_has_signature(&buf) {
            let (s, e) =
                run_sql_parallel(&app, &opts, target, &control, &buf, &name, &session_prelude, concurrency)
                    .await?;
            total_stmts = s;
            total_errs = e;
        } else {
            process_sql(
                &app, &opts, &*target, &control, &buf, &name, &session_prelude,
                &mut total_stmts, &mut total_errs,
            )
            .await?;
        }
    }

    let done = ImportDone {
        statements_done: total_stmts,
        errors: total_errs,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let _ = app.emit("sql_import:done", &done);
    Ok(done)
}

/// Reads every `.sql` entry of a ZIP into memory, sorted by name. Done before
/// any await because `ZipFile` isn't `Send`. (V2: stream per-entry to temp.)
fn read_zip_entries(path: &std::path::Path) -> Result<Vec<(String, String)>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("abrir zip: {}", e))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("ler zip: {}", e))?;
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .filter(|n| n.to_lowercase().ends_with(".sql"))
        .collect();
    names.sort();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let mut entry = zip
            .by_name(&name)
            .map_err(|e| format!("ler entry {}: {}", name, e))?;
        let mut buf = String::new();
        entry
            .read_to_string(&mut buf)
            .map_err(|e| format!("ler entry {}: {}", name, e))?;
        out.push((name, buf));
    }
    Ok(out)
}

/// True if the text carries the BaseMaster dump signature on its first lines.
fn sql_has_signature(sql: &str) -> bool {
    sql.lines()
        .take(3)
        .any(|l| l.trim_start().starts_with(crate::sql_dump::DUMP_SIGNATURE))
}

#[allow(clippy::too_many_arguments)]
async fn process_sql(
    app: &AppHandle,
    opts: &ImportOptions,
    target: &dyn Driver,
    control: &Arc<TransferControl>,
    sql: &str,
    source_name: &str,
    session_prelude: &str,
    total_stmts: &mut u64,
    total_errs: &mut u32,
) -> Result<(), String> {
    let stmts = split_statements(sql);
    let target_dialect = Dialect::from_driver_name(target.dialect());
    // Detect the file's dialect once (cheaper than per-stmt).
    let source_dialect = detect_dialect(sql);
    let needs_translate = source_dialect != Dialect::Unknown
        && target_dialect != Dialect::Unknown
        && source_dialect != target_dialect;
    let target_is_pg = target_dialect == Dialect::Postgres;
    for stmt in stmts {
        if !control.check().await {
            break;
        }
        let trimmed = stmt.trim();
        if trimmed.is_empty() {
            continue;
        }
        if is_duplicate_session_set(trimmed) {
            continue;
        }
        // Translate if source != target. If the dialect is undetectable, pass-through.
        let translated: String = if needs_translate {
            normalize_for(trimmed, source_dialect, target_dialect)
        } else {
            trimmed.to_string()
        };
        let final_sql = translated.trim();
        if final_sql.is_empty() {
            continue;
        }
        // Skip statements known to be incompatible with the target
        // and that have no analog (e.g., LOCK TABLES on PG). Not counted as an error.
        if should_skip_for_target(final_sql, target_dialect) {
            continue;
        }
        *total_stmts += 1;
        // Prepend the prelude only if the target is MySQL — the SETs are MySQL-only.
        let wrapped = if target_is_pg {
            final_sql.to_string()
        } else {
            format!("{}{}", session_prelude, final_sql)
        };
        match target.execute(opts.schema.as_deref(), &wrapped).await {
            Ok(_) => {}
            Err(e) => {
                *total_errs += 1;
                let _ = app.emit(
                    "sql_import:stmt_error",
                    &ImportStmtError {
                        index: *total_stmts,
                        sql: trimmed.chars().take(500).collect(),
                        message: e.to_string(),
                    },
                );
                if !opts.continue_on_error {
                    return Err(format!("stmt #{}: {}", *total_stmts, e));
                }
            }
        }
        if (*total_stmts).is_multiple_of(opts.emit_every as u64) {
            let _ = app.emit(
                "sql_import:progress",
                &ImportProgress {
                    statements_done: *total_stmts,
                    errors: *total_errs,
                    current_source: source_name.to_string(),
                },
            );
        }
    }
    // Final emit for this source.
    let _ = app.emit(
        "sql_import:progress",
        &ImportProgress {
            statements_done: *total_stmts,
            errors: *total_errs,
            current_source: source_name.to_string(),
        },
    );
    Ok(())
}

// ============================================================ parallel import

/// Regions of a BaseMaster `.sql` (or a single ZIP entry), carved by the
/// `@BM:` markers. Each `ddls[i]` is one table's structure block, each
/// `datas[i]` one table's INSERT block.
#[derive(Default)]
struct Regions {
    header: String,
    ddls: Vec<String>,
    datas: Vec<String>,
    footer: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Marker {
    Dump,
    Table,
    Data,
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
    } else if rest.trim_end() == "F" || rest.starts_with("F ") {
        Some(Marker::Footer)
    } else {
        None
    }
}

/// Splits a marked dump into regions. The body of each marker (bytes until the
/// next marker) is routed by the marker's kind. Text before the first marker
/// is ignored (none in practice). With no `T`/`D` markers, callers fall back
/// to sequential import.
fn parse_sql_regions(sql: &str) -> Regions {
    // (marker kind, byte offset of the line, byte offset after the line).
    let mut marks: Vec<(Marker, usize, usize)> = Vec::new();
    let mut pos = 0usize;
    for line in sql.split_inclusive('\n') {
        let line_end = pos + line.len();
        if let Some(m) = classify_marker(line) {
            marks.push((m, pos, line_end));
        }
        pos = line_end;
    }

    let mut r = Regions::default();
    for i in 0..marks.len() {
        let (kind, _, body_start) = marks[i];
        let body_end = marks.get(i + 1).map(|n| n.1).unwrap_or(sql.len());
        let body = &sql[body_start..body_end];
        match kind {
            Marker::Dump => r.header.push_str(body),
            Marker::Table => r.ddls.push(body.to_string()),
            Marker::Data => r.datas.push(body.to_string()),
            Marker::Footer => r.footer.push_str(body),
        }
    }
    r
}

/// Per-statement execution context, cloned into each parallel worker.
#[derive(Clone)]
struct ExecCtx {
    schema: Option<String>,
    target_is_pg: bool,
    needs_translate: bool,
    source_dialect: Dialect,
    target_dialect: Dialect,
    continue_on_error: bool,
    session_prelude: String,
}

/// Shared progress counters across phases/workers.
#[derive(Default)]
struct Prog {
    done: AtomicU64,
    errs: AtomicU32,
}

/// Runs one statement: skip-checks, translate, prelude, execute.
/// `Ok(true)` executed, `Ok(false)` skipped (not counted), `Err` db error.
async fn exec_one(target: &dyn Driver, ctx: &ExecCtx, stmt: &str) -> Result<bool, String> {
    let trimmed = stmt.trim();
    if trimmed.is_empty() || is_duplicate_session_set(trimmed) {
        return Ok(false);
    }
    let translated = if ctx.needs_translate {
        normalize_for(trimmed, ctx.source_dialect, ctx.target_dialect)
    } else {
        trimmed.to_string()
    };
    let final_sql = translated.trim();
    if final_sql.is_empty() || should_skip_for_target(final_sql, ctx.target_dialect) {
        return Ok(false);
    }
    let wrapped = if ctx.target_is_pg {
        final_sql.to_string()
    } else {
        format!("{}{}", ctx.session_prelude, final_sql)
    };
    target
        .execute(ctx.schema.as_deref(), &wrapped)
        .await
        .map(|_| true)
        .map_err(|e| e.to_string())
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

/// Runs a list of statements sequentially (header / DDL / footer phases).
#[allow(clippy::too_many_arguments)]
async fn run_phase_seq(
    app: &AppHandle,
    target: &dyn Driver,
    ctx: &ExecCtx,
    control: &Arc<TransferControl>,
    prog: &Prog,
    emit_every: u32,
    source: &str,
    stmts: &[String],
) -> Result<(), String> {
    for stmt in stmts {
        if !control.check().await {
            break;
        }
        match exec_one(target, ctx, stmt).await {
            Ok(false) => {}
            Ok(true) => {
                let n = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                if emit_every > 0 && n.is_multiple_of(emit_every as u64) {
                    emit_progress(app, prog, source);
                }
            }
            Err(e) => {
                let idx = prog.done.fetch_add(1, Ordering::Relaxed) + 1;
                prog.errs.fetch_add(1, Ordering::Relaxed);
                emit_stmt_error(app, idx, stmt, &e);
                if !ctx.continue_on_error {
                    return Err(format!("stmt #{}: {}", idx, e));
                }
            }
        }
    }
    emit_progress(app, prog, source);
    Ok(())
}

/// Runs all data statements across N workers. Order is irrelevant (FK checks
/// disabled, INSERTs independent), so a single queue + worker pool spreads a
/// huge table's INSERTs and many small tables alike.
#[allow(clippy::too_many_arguments)]
async fn run_data_parallel(
    app: &AppHandle,
    target: Arc<dyn Driver>,
    ctx: ExecCtx,
    control: &Arc<TransferControl>,
    prog: Arc<Prog>,
    emit_every: u32,
    stmts: Vec<String>,
    concurrency: usize,
) -> Result<(), String> {
    let (tx, rx) = async_channel::unbounded::<String>();
    for s in stmts {
        let _ = tx.send(s).await;
    }
    drop(tx);

    let first_err: Arc<tokio::sync::Mutex<Option<String>>> =
        Arc::new(tokio::sync::Mutex::new(None));
    let mut handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let rx = rx.clone();
        let app = app.clone();
        let target = target.clone();
        let ctx = ctx.clone();
        let control = control.clone();
        let prog = prog.clone();
        let first_err = first_err.clone();
        handles.push(tokio::spawn(async move {
            while let Ok(stmt) = rx.recv().await {
                if !control.check().await {
                    rx.close();
                    break;
                }
                match exec_one(&*target, &ctx, &stmt).await {
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
                        if !ctx.continue_on_error {
                            let mut g = first_err.lock().await;
                            if g.is_none() {
                                *g = Some(format!("stmt #{}: {}", idx, e));
                            }
                            rx.close();
                            break;
                        }
                    }
                }
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    emit_progress(app, &prog, "data");
    if let Some(e) = first_err.lock().await.take() {
        return Err(e);
    }
    Ok(())
}

/// Builds the ExecCtx + dialect detection for a marked import.
fn build_exec_ctx(opts: &ImportOptions, target: &dyn Driver, sample: &str, session_prelude: &str) -> ExecCtx {
    let target_dialect = Dialect::from_driver_name(target.dialect());
    let source_dialect = detect_dialect(sample);
    let needs_translate = source_dialect != Dialect::Unknown
        && target_dialect != Dialect::Unknown
        && source_dialect != target_dialect;
    ExecCtx {
        schema: opts.schema.clone(),
        target_is_pg: target_dialect == Dialect::Postgres,
        needs_translate,
        source_dialect,
        target_dialect,
        continue_on_error: opts.continue_on_error,
        session_prelude: session_prelude.to_string(),
    }
}

/// Runs the 4-phase parallel pipeline on pre-carved regions.
async fn run_regions_parallel(
    app: &AppHandle,
    opts: &ImportOptions,
    target: Arc<dyn Driver>,
    control: &Arc<TransferControl>,
    ctx: ExecCtx,
    regions: Regions,
    concurrency: usize,
) -> Result<(u64, u32), String> {
    let prog = Arc::new(Prog::default());

    // Phase 1 : header (session SETs — mostly skipped, prelude handles them).
    let header_stmts = split_statements(&regions.header);
    run_phase_seq(app, &*target, &ctx, control, &prog, opts.emit_every, "header", &header_stmts).await?;

    // Phase 2 : all DDL, in order, so every table exists before any INSERT.
    for ddl in &regions.ddls {
        if !control.check().await {
            break;
        }
        let stmts = split_statements(ddl);
        run_phase_seq(app, &*target, &ctx, control, &prog, opts.emit_every, "structure", &stmts)
            .await?;
    }

    // Phase 3 : all data, parallel.
    let mut data_stmts: Vec<String> = Vec::new();
    for d in &regions.datas {
        data_stmts.extend(split_statements(d));
    }
    run_data_parallel(
        app, target.clone(), ctx.clone(), control, prog.clone(), opts.emit_every, data_stmts,
        concurrency,
    )
    .await?;

    // Phase 4 : footer (restore SETs).
    let footer_stmts = split_statements(&regions.footer);
    run_phase_seq(app, &*target, &ctx, control, &prog, opts.emit_every, "footer", &footer_stmts)
        .await?;

    Ok((prog.done.load(Ordering::Relaxed), prog.errs.load(Ordering::Relaxed)))
}

/// Parallel import of a single marked `.sql`.
#[allow(clippy::too_many_arguments)]
async fn run_sql_parallel(
    app: &AppHandle,
    opts: &ImportOptions,
    target: Arc<dyn Driver>,
    control: &Arc<TransferControl>,
    sql: &str,
    source_name: &str,
    session_prelude: &str,
    concurrency: usize,
) -> Result<(u64, u32), String> {
    let regions = parse_sql_regions(sql);
    // Signature present but no table markers : not a structured dump we can
    // carve : import sequentially.
    if regions.ddls.is_empty() && regions.datas.is_empty() {
        let (mut s, mut e) = (0u64, 0u32);
        process_sql(app, opts, &*target, control, sql, source_name, session_prelude, &mut s, &mut e)
            .await?;
        return Ok((s, e));
    }
    let ctx = build_exec_ctx(opts, &*target, sql, session_prelude);
    run_regions_parallel(app, opts, target, control, ctx, regions, concurrency).await
}

/// Parallel import of a marked `.zip`. Entries are classified by name
/// (header/schema/footer) and table entries are carved by their inner markers.
async fn run_zip_parallel(
    app: &AppHandle,
    opts: &ImportOptions,
    target: Arc<dyn Driver>,
    control: &Arc<TransferControl>,
    entries: &[(String, String)],
    session_prelude: &str,
    concurrency: usize,
) -> Result<(u64, u32), String> {
    let mut regions = Regions::default();
    for (name, content) in entries {
        if name.ends_with("00_header.sql") {
            regions.header.push_str(content);
        } else if name.ends_with("zz_footer.sql") {
            regions.footer.push_str(content);
        } else if name.ends_with("00_schema.sql") {
            regions.ddls.push(content.clone());
        } else {
            // Table entry : carve DDL/data from its inner @BM:T / @BM:D markers.
            let r = parse_sql_regions(content);
            if r.ddls.is_empty() && r.datas.is_empty() {
                // No markers (older/foreign entry) : run whole as DDL phase.
                if !content.trim().is_empty() {
                    regions.ddls.push(content.clone());
                }
            } else {
                regions.ddls.extend(r.ddls);
                regions.datas.extend(r.datas);
            }
        }
    }
    // Detect dialect from header + structure (data alone is ambiguous).
    let sample = format!("{}\n{}", regions.header, regions.ddls.join("\n"));
    let ctx = build_exec_ctx(opts, &*target, &sample, session_prelude);
    run_regions_parallel(app, opts, target, control, ctx, regions, concurrency).await
}

/// Naive but reasonable splitter: respects single/double quotes,
/// backticks, line comments `-- ...` and block `/* ... */`, and the
/// `DELIMITER xxx` directive that mysqldump uses on triggers/procedures.
fn split_statements(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Accumulate raw bytes, not `b as char`: casting each byte to a char
    // mangles multibyte UTF-8 (an 'á' would become two Latin-1 chars and
    // re-encode as garbage), corrupting non-ASCII data on import. All the
    // boundary markers below (delimiter, comment, quote) are ASCII, so a
    // multibyte sequence is always copied whole — the buffer stays valid UTF-8.
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut delim: String = ";".to_string();
    let bytes = src.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();

    let flush = |buf: &mut Vec<u8>, out: &mut Vec<String>| {
        let s = String::from_utf8_lossy(buf);
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
        buf.clear();
    };

    while i < len {
        let b = bytes[i];

        // DELIMITER directive — case-insensitive, at the start of the line
        // (allowing whitespace before).
        if (buf.is_empty() || buf.last() == Some(&b'\n'))
            && at_word_ci(bytes, i, b"DELIMITER")
        {
            // Advance past DELIMITER.
            i += 9;
            // Skip whitespace.
            while i < len && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            // Read until EOL.
            let mut new_delim: Vec<u8> = Vec::new();
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                new_delim.push(bytes[i]);
                i += 1;
            }
            let new_delim = String::from_utf8_lossy(&new_delim).trim().to_string();
            if !new_delim.is_empty() {
                delim = new_delim;
            }
            // Consume newline.
            while i < len && (bytes[i] == b'\n' || bytes[i] == b'\r') {
                i += 1;
            }
            continue;
        }

        // Line comment.
        if b == b'-' && i + 1 < len && bytes[i + 1] == b'-' {
            // Skip until EOL.
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'#' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        // Block comment.
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < len {
                i += 2;
            }
            continue;
        }

        // String / quoted identifier — consume until closing.
        if b == b'\'' || b == b'"' || b == b'`' {
            let quote = b;
            buf.push(b);
            i += 1;
            while i < len {
                let c = bytes[i];
                if c == b'\\' && i + 1 < len {
                    // Backslash-escape (\' \" \\ etc).
                    buf.push(c);
                    buf.push(bytes[i + 1]);
                    i += 2;
                    continue;
                }
                if c == quote {
                    // Doubled = escape (MySQL ANSI). Keep.
                    if i + 1 < len && bytes[i + 1] == quote {
                        buf.push(c);
                        buf.push(c);
                        i += 2;
                        continue;
                    }
                    buf.push(c);
                    i += 1;
                    break;
                }
                buf.push(c);
                i += 1;
            }
            continue;
        }

        // Delimiter match — end of statement.
        if at_str(bytes, i, delim.as_bytes()) {
            flush(&mut buf, &mut out);
            i += delim.len();
            continue;
        }

        buf.push(b);
        i += 1;
    }

    // Leftovers.
    flush(&mut buf, &mut out);
    out
}

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
        assert!(matches!(classify_marker("-- @BM:F"), Some(Marker::Footer)));
        assert!(classify_marker("-- regular comment").is_none());
        assert!(classify_marker("INSERT INTO t VALUES (1);").is_none());
    }

    #[test]
    fn parse_regions_splits_by_marker() {
        let sql = "-- @BM:DUMP v1\n\
                   SET NAMES utf8mb4;\n\
                   -- @BM:T idx=0 schema=s table=a\n\
                   CREATE TABLE a (id INT);\n\
                   -- @BM:D idx=0\n\
                   INSERT INTO s.a VALUES (1);\n\
                   -- @BM:T idx=1 schema=s table=b\n\
                   CREATE TABLE b (id INT);\n\
                   -- @BM:D idx=1\n\
                   INSERT INTO s.b VALUES (2);\n\
                   -- @BM:F\n\
                   SET FOREIGN_KEY_CHECKS = 1;\n";
        let r = parse_sql_regions(sql);
        assert!(r.header.contains("SET NAMES"));
        assert_eq!(r.ddls.len(), 2);
        assert!(r.ddls[0].contains("CREATE TABLE a"));
        assert!(r.ddls[1].contains("CREATE TABLE b"));
        assert_eq!(r.datas.len(), 2);
        assert!(r.datas[0].contains("INSERT INTO s.a"));
        assert!(r.datas[1].contains("INSERT INTO s.b"));
        assert!(r.footer.contains("FOREIGN_KEY_CHECKS = 1"));
        // DDL must not leak into data and vice-versa.
        assert!(!r.ddls[0].contains("INSERT"));
        assert!(!r.datas[0].contains("CREATE TABLE"));
    }

    #[test]
    fn parse_regions_structure_only_table_has_no_data() {
        let sql = "-- @BM:DUMP v1\n\
                   -- @BM:T idx=0 schema=s table=a\n\
                   CREATE TABLE a (id INT);\n\
                   -- @BM:F\n";
        let r = parse_sql_regions(sql);
        assert_eq!(r.ddls.len(), 1);
        assert!(r.datas.is_empty());
    }

    #[test]
    fn parse_regions_no_markers_is_empty() {
        let r = parse_sql_regions("SELECT 1; SELECT 2;");
        assert!(r.ddls.is_empty() && r.datas.is_empty());
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
        // Bytes must survive verbatim — the old `b as char` path mangled
        // accented/CJK/emoji data into mojibake.
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
        // `\'` inside a MySQL string — splitter can't close there.
        let out = split_statements("INSERT INTO t VALUES ('it\\'s; a test'); SELECT 1;");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("it\\'s; a test"));
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
}
