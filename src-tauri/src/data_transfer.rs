//! Data Transfer V1.0 — moves data between two connections.
//!
//! For each table:
//!   1. (optional) DROP TABLE target
//!   2. (optional) CREATE TABLE target via SHOW CREATE TABLE (source)
//!   3. (optional) DELETE FROM target (if not dropped)
//!   4. SELECT * in chunks + extended INSERT into the target
//!
//! Parallelism, FKs, triggers, fine-grained options (ignore/replace/hex BLOB) come in V1.1.
//!
//! Emits Tauri events:
//!   `transfer:progress` — { table, done, total, rows_transferred }
//!   `transfer:table_done` — { table, rows, elapsed_ms, error }
//!   `transfer:done` — { total_rows, elapsed_ms }

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use basemaster_core::Driver;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use uuid::Uuid;

/// Pause/stop control shared by the running transfer.
/// Workers call `wait_if_paused_or_stopped` between batches to cooperate.
pub struct TransferControl {
    stop: AtomicBool,
    paused: AtomicBool,
    notify: Notify,
}

impl TransferControl {
    pub fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
    /// Called before each transfer to reset flags.
    pub fn reset(&self) {
        self.stop.store(false, Ordering::Relaxed);
        self.paused.store(false, Ordering::Relaxed);
    }
    pub fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
        self.notify.notify_waiters();
    }
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }
    /// Returns `true` to continue, `false` if stop was requested.
    /// While paused, sleeps waiting for notify.
    pub async fn check(&self) -> bool {
        while self.paused.load(Ordering::Relaxed) && !self.stop.load(Ordering::Relaxed) {
            self.notify.notified().await;
        }
        !self.stop.load(Ordering::Relaxed)
    }
}

impl Default for TransferControl {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InsertMode {
    /// `INSERT INTO ... VALUES ...` — fails on duplicate PK.
    #[default]
    Insert,
    /// `INSERT IGNORE INTO ...` — skips rows with duplicate PK.
    InsertIgnore,
    /// `REPLACE INTO ...` — replaces rows with duplicate PK.
    Replace,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferOptions {
    pub source_connection_id: Uuid,
    pub source_schema: String,
    pub target_connection_id: Uuid,
    pub target_schema: String,
    pub tables: Vec<String>,
    /// If true, DROP TABLE on target before recreating.
    #[serde(default)]
    pub drop_target: bool,
    /// If true, creates the tables (via SHOW CREATE TABLE). If false, assumes existing.
    #[serde(default = "default_true")]
    pub create_tables: bool,
    /// If true and not dropped, DELETE FROM before inserting.
    #[serde(default)]
    pub empty_target: bool,
    /// Rows per batch in the SELECT (also base for the extended INSERT).
    #[serde(default = "default_chunk")]
    pub chunk_size: u64,
    /// If true, continues to the next table on error.
    #[serde(default)]
    pub continue_on_error: bool,
    /// How many tables to transfer in parallel. Default 1 (sequential).
    /// Limited by the pool's `max_connections` (currently = 8).
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    /// INSERT mode — allows ignoring/replacing duplicates.
    #[serde(default)]
    pub insert_mode: InsertMode,
    // --- Optimizations ---
    /// SET FOREIGN_KEY_CHECKS=0 during inserts. Essential for speed.
    #[serde(default = "default_true")]
    pub disable_fk_checks: bool,
    /// SET UNIQUE_CHECKS=0 — skips UNIQUE validation.
    #[serde(default = "default_true")]
    pub disable_unique_checks: bool,
    /// SET SQL_LOG_BIN=0 — skips binlog. Opt-in (don't use on a master with replicas).
    #[serde(default)]
    pub disable_binlog: bool,
    /// Wraps each table's INSERTs in BEGIN/COMMIT.
    #[serde(default = "default_true")]
    pub use_transaction: bool,
    /// LOCK TABLES <target> WRITE during load.
    #[serde(default)]
    pub lock_target: bool,
    /// Size limit of each INSERT in KB (to avoid exceeding max_allowed_packet).
    #[serde(default = "default_stmt_kb")]
    pub max_statement_size_kb: u64,
    /// Uses keyset pagination (WHERE pk > last LIMIT N) when the table
    /// has a single integer-column PK. Much faster than OFFSET
    /// on large tables.
    #[serde(default = "default_true")]
    pub use_keyset_pagination: bool,
    // --- Navicat-style options ---
    /// Create the target schema/database if it doesn't exist.
    #[serde(default = "default_true")]
    pub create_target_schema: bool,
    /// If true, copies data (INSERT). If false, structure only.
    #[serde(default = "default_true")]
    pub create_records: bool,
    /// INSERT INTO t (col1, col2, ...) VALUES vs INSERT INTO t VALUES.
    /// Recommended ON — safer when column order differs.
    #[serde(default = "default_true")]
    pub complete_inserts: bool,
    /// Multi-row INSERT. If false, one INSERT per row (slower but may
    /// help for debugging or triggers that expect 1 row).
    #[serde(default = "default_true")]
    pub extended_inserts: bool,
    /// BLOB as 0xFF... (hex). Alternative: escape string (problematic).
    /// Default = true, same as Navicat.
    #[serde(default = "default_true")]
    pub hex_blob: bool,
    /// BEGIN/COMMIT wrapping ALL tables (a single tx).
    /// If false and use_transaction=true → one tx per table.
    #[serde(default)]
    pub single_transaction: bool,
    /// LOCK TABLES source.* READ during load — consistent snapshot.
    #[serde(default)]
    pub lock_source: bool,
    /// Adds NO_AUTO_VALUE_ON_ZERO to sql_mode. Without it, inserting 0 into
    /// an AUTO_INCREMENT column becomes the next sequence value (MySQL
    /// default). Needed to preserve original records with PK=0.
    /// Same behavior as mysqldump.
    #[serde(default = "default_true")]
    pub preserve_zero_auto_increment: bool,
    /// Copies the triggers of each table. SHOW TRIGGERS + SHOW CREATE
    /// TRIGGER on the source, DROP + CREATE on the target. Run AFTER the
    /// inserts so triggers don't fire during the load.
    #[serde(default = "default_true")]
    pub copy_triggers: bool,
    /// Intra-table parallelism: splits the integer PK range into N
    /// intervals and copies each in parallel. Default 1 (off).
    /// Only activated if the table has a single integer-column PK (same
    /// condition as keyset) and total > intra_table_min_rows.
    #[serde(default = "default_intra_workers")]
    pub intra_table_workers: u32,
    /// Minimum row threshold to trigger intra-table split. On small
    /// tables, the overhead of 2x MIN/MAX + N connections doesn't
    /// pay off. Default 50k.
    #[serde(default = "default_intra_min_rows")]
    pub intra_table_min_rows: u64,
}

fn default_true() -> bool {
    true
}
fn default_chunk() -> u64 {
    1000
}
fn default_concurrency() -> u32 {
    1
}
fn default_stmt_kb() -> u64 {
    1024 // 1 MB — comfortable margin below the default max_allowed_packet (4 MB).
}
fn default_intra_workers() -> u32 {
    1
}
fn default_intra_min_rows() -> u64 {
    10_000
}

#[derive(Clone, Debug, Serialize)]
pub struct TableProgress {
    pub table: String,
    pub done: u64,
    pub total: u64,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TableDone {
    pub table: String,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

/// Informational message about a table — e.g., "intra-parallel requested
/// but not activated because …". Lets the front explain decisions without
/// replicating backend logic.
#[derive(Clone, Debug, Serialize)]
pub struct TableNote {
    pub table: String,
    pub message: String,
    /// "info" | "warn"
    pub level: String,
}

/// Progress of an intra-table parallelism worker. Emitted as
/// `transfer:worker_progress`. Beyond the per-table aggregate, the front
/// can show each range individually (range, done, status).
#[derive(Clone, Debug, Serialize)]
pub struct TableWorkerProgress {
    pub table: String,
    pub worker_id: u32,
    /// Bounds of the PK range: `[low_pk, high_pk)`. String because i128
    /// doesn't serialize cleanly in serde_json (without `arbitrary_precision`).
    pub low_pk: String,
    pub high_pk: String,
    pub done: u64,
    pub elapsed_ms: u64,
    /// Becomes `true` when the worker has finished (with or without error).
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TransferDone {
    pub total_rows: u64,
    pub elapsed_ms: u64,
    pub failed: u32,
}

/// Runs the transfer on Tauri's Tokio runtime. Returns the global total.
/// Progressive events are emitted via `AppHandle::emit`.
///
/// Parallelism: if `concurrency > 1`, spawn N workers consuming a queue
/// (mpsc) of table names. Each worker runs `transfer_one` in isolation.
/// Sequential if `concurrency == 1` (less overhead).
pub async fn run_transfer(
    app: AppHandle,
    opts: TransferOptions,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    control: Arc<TransferControl>,
) -> Result<TransferDone, String> {
    let total_started = Instant::now();
    let concurrency = opts.concurrency.clamp(1, 16) as usize;

    // Create the target schema/database. MySQL: CREATE DATABASE;
    // PostgreSQL: CREATE SCHEMA (schemas ≠ databases in PG).
    if opts.create_target_schema {
        let keyword = if target.dialect() == "postgres" {
            "SCHEMA"
        } else {
            "DATABASE"
        };
        let sql = format!(
            "CREATE {} IF NOT EXISTS {}",
            keyword,
            target.quote_ident(&opts.target_schema)
        );
        target
            .execute(None, &sql)
            .await
            .map_err(|e| format!("create target schema: {}", e))?;
    }

    // single_transaction: wrap the WHOLE transfer in a single tx on the target.
    // Disabled — same problem as per-table tx (see eff_use_tx in
    // transfer_one): sqlx pool doesn't guarantee the same conn between START
    // and COMMIT, so the tx becomes orphan and pollutes the pool. To
    // reactivate, need to pin a connection via pool.acquire() for the whole
    // transfer.
    // if opts.single_transaction {
    //     let _ = target.execute(Some(&opts.target_schema), "START TRANSACTION").await;
    // }

    // If only 1 worker, simple path keeps the abort-on-error semantics.
    let result = if concurrency == 1 {
        run_sequential(
            app.clone(),
            opts.clone(),
            source,
            target.clone(),
            total_started,
            control.clone(),
        )
        .await
    } else {
        run_parallel(
            app.clone(),
            opts.clone(),
            source,
            target.clone(),
            total_started,
            concurrency,
            control.clone(),
        )
        .await
    };

    // single_transaction disabled — see comment above. COMMIT/ROLLBACK here
    // would go to a different conn from START, so it was a no-op most of
    // the time and polluted the pool when the START happened to stick.
    // if opts.single_transaction { ... }

    result
}

async fn run_parallel(
    app: AppHandle,
    opts: TransferOptions,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    total_started: Instant,
    concurrency: usize,
    control: Arc<TransferControl>,
) -> Result<TransferDone, String> {

    // Parallel (cont.): task channel.
    let (tx, rx) = async_channel::unbounded::<String>();
    for t in &opts.tables {
        let _ = tx.send(t.clone()).await;
    }
    drop(tx); // close — workers exit when the queue drains.

    let totals = Arc::new(tokio::sync::Mutex::new(RunTotals::default()));
    let opts = Arc::new(opts);
    let mut handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let rx = rx.clone();
        let app = app.clone();
        let source = source.clone();
        let target = target.clone();
        let opts = opts.clone();
        let totals = totals.clone();
        let control = control.clone();
        handles.push(tokio::spawn(async move {
            while let Ok(table) = rx.recv().await {
                // Cooperative pause/stop BEFORE picking the next table.
                if !control.check().await {
                    break;
                }
                let start = Instant::now();
                let result = transfer_one(
                    &app,
                    &opts,
                    source.clone(),
                    target.clone(),
                    &table,
                    &control,
                )
                .await;
                // `control` here is Arc<TransferControl>, transfer_one
                // takes `&Arc<TransferControl>` — `&control` performs the
                // right coercion.
                let (rows, error) = match result {
                    Ok(r) => (r, None),
                    Err(e) => (0, Some(e)),
                };
                let elapsed = start.elapsed().as_millis() as u64;
                let _ = app.emit(
                    "transfer:table_done",
                    &TableDone {
                        table: table.clone(),
                        rows,
                        elapsed_ms: elapsed,
                        error: error.clone(),
                    },
                );
                let mut t = totals.lock().await;
                t.rows += rows;
                if error.is_some() {
                    t.failed += 1;
                    if !opts.continue_on_error {
                        // Signal abort — drain the channel.
                        rx.close();
                    }
                }
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }

    let t = totals.lock().await;
    let done = TransferDone {
        total_rows: t.rows,
        elapsed_ms: total_started.elapsed().as_millis() as u64,
        failed: t.failed,
    };
    let _ = app.emit("transfer:done", &done);
    Ok(done)
}

#[derive(Default)]
struct RunTotals {
    rows: u64,
    failed: u32,
}

async fn run_sequential(
    app: AppHandle,
    opts: TransferOptions,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    total_started: Instant,
    control: Arc<TransferControl>,
) -> Result<TransferDone, String> {
    let mut total_rows: u64 = 0;
    let mut failed: u32 = 0;

    for table_name in &opts.tables {
        if !control.check().await {
            break;
        }
        let table_start = Instant::now();
        let result = transfer_one(
            &app,
            &opts,
            source.clone(),
            target.clone(),
            table_name,
            &control,
        )
        .await;

        let (rows, error) = match result {
            Ok(r) => (r, None),
            Err(e) => (0, Some(e)),
        };

        let elapsed_ms = table_start.elapsed().as_millis() as u64;
        let done_evt = TableDone {
            table: table_name.clone(),
            rows,
            elapsed_ms,
            error: error.clone(),
        };
        let _ = app.emit("transfer:table_done", &done_evt);
        total_rows += rows;

        if error.is_some() {
            failed += 1;
            if !opts.continue_on_error {
                let done = TransferDone {
                    total_rows,
                    elapsed_ms: total_started.elapsed().as_millis() as u64,
                    failed,
                };
                let _ = app.emit("transfer:done", &done);
                return Err(error.unwrap_or_else(|| "transfer abortado".into()));
            }
        }
    }

    let done = TransferDone {
        total_rows,
        elapsed_ms: total_started.elapsed().as_millis() as u64,
        failed,
    };
    let _ = app.emit("transfer:done", &done);
    Ok(done)
}

async fn transfer_one(
    app: &AppHandle,
    opts: &TransferOptions,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    table: &str,
    control: &Arc<TransferControl>,
) -> Result<u64, String> {
    let qi = |s: &str| source.quote_ident(s);

    // 1. Count total for progress.
    let total = source
        .count_table_rows(&opts.source_schema, table, None)
        .await
        .map_err(|e| format!("count {}: {}", table, e))?;

    // The session-level SETs below are MySQL-only. On PG they all become
    // no-ops (the prelude stays empty).
    let target_is_mysql = target.dialect() == "mysql";
    let mut session_prelude = String::new();
    let mut session_restore = String::new();
    if target_is_mysql {
        // COMMIT first — if the server has autocommit=0 by default (or the
        // connection is already in an implicit tx), SET SQL_LOG_BIN fails
        // with 1694. COMMIT without an active tx is a no-op in MySQL.
        if opts.disable_binlog
            || opts.disable_fk_checks
            || opts.disable_unique_checks
            || opts.preserve_zero_auto_increment
        {
            session_prelude.push_str("COMMIT; ");
        }
        if opts.disable_binlog {
            // Binlog first — if it errors with ER_WRONG_VALUE_FOR_VAR
            // (missing SUPER/REPLICATION CLIENT privilege), the query fails
            // before other SETs, making diagnosis easier.
            session_prelude.push_str("SET SQL_LOG_BIN=0; ");
            session_restore.push_str("SET SQL_LOG_BIN=1; ");
        }
        if opts.disable_fk_checks {
            session_prelude.push_str("SET FOREIGN_KEY_CHECKS=0; ");
            session_restore.push_str("SET FOREIGN_KEY_CHECKS=1; ");
        }
        if opts.disable_unique_checks {
            session_prelude.push_str("SET UNIQUE_CHECKS=0; ");
            session_restore.push_str("SET UNIQUE_CHECKS=1; ");
        }
        if opts.preserve_zero_auto_increment {
            session_prelude.push_str(
                "SET sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO'); ",
            );
        }
    }
    if !session_prelude.is_empty() {
        target
            .execute(Some(&opts.target_schema), &session_prelude)
            .await
            .map_err(|e| format!("session prelude {}: {}", table, e))?;
    }
    // Alternative prelude to be prepended to INSERTs inside a tx.
    // MySQL rejects `SET SQL_LOG_BIN` inside a transaction (error 1694),
    // so we build a variant without it for the DML phase. The binlog SET
    // only runs on DDL (outside tx) via `session_prelude`.
    let mut insert_prelude = String::new();
    if target_is_mysql {
        if opts.disable_fk_checks {
            insert_prelude.push_str("SET FOREIGN_KEY_CHECKS=0; ");
        }
        if opts.disable_unique_checks {
            insert_prelude.push_str("SET UNIQUE_CHECKS=0; ");
        }
        if opts.preserve_zero_auto_increment {
            insert_prelude.push_str(
                "SET sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO'); ",
            );
        }
    }

    // 3. Drop + Create (or just Empty) per opts.
    // CRITICAL: prepend session_prelude on EVERY statement. SET SESSION only
    // applies to the current connection, and the sqlx pool may hand out a
    // different conn between calls. Multi-statement "SET FK=0; DROP..." in a
    // single execute is the only way to guarantee the same conn.
    if opts.drop_target {
        // PG: CASCADE removes FKs that would block the DROP (equivalent to
        // MySQL's SET FOREIGN_KEY_CHECKS=0).
        let cascade = if !target_is_mysql { " CASCADE" } else { "" };
        let sql = format!(
            "{}DROP TABLE IF EXISTS {}.{}{}",
            session_prelude,
            target.quote_ident(&opts.target_schema),
            target.quote_ident(table),
            cascade,
        );
        target
            .execute(Some(&opts.target_schema), &sql)
            .await
            .map_err(|e| format!("drop {}: {}", table, e))?;
    }

    if opts.create_tables {
        let ddl = source
            .get_table_ddl(&opts.source_schema, table)
            .await
            .map_err(|e| format!("ddl {}: {}", table, e))?;

        // If source and target are different dialects, translate the DDL.
        let source_d = crate::sql_translate::Dialect::from_driver_name(
            source.dialect(),
        );
        let target_d = crate::sql_translate::Dialect::from_driver_name(
            target.dialect(),
        );
        let ddl = if source_d != target_d {
            crate::sql_translate::normalize_for(&ddl, source_d, target_d)
        } else {
            ddl
        };

        let create_body = if opts.drop_target {
            ddl
        } else {
            ddl.replacen("CREATE TABLE", "CREATE TABLE IF NOT EXISTS", 1)
        };
        // On PG target, skip session_prelude (it's MySQL-only).
        let create_sql = if matches!(
            target_d,
            crate::sql_translate::Dialect::Postgres
        ) {
            create_body
        } else {
            format!("{}{}", session_prelude, create_body)
        };
        target
            .execute(Some(&opts.target_schema), &create_sql)
            .await
            .map_err(|e| format!("create {}: {}", table, e))?;
    } else if opts.empty_target {
        let sql = format!(
            "{}DELETE FROM {}.{}",
            session_prelude,
            target.quote_ident(&opts.target_schema),
            target.quote_ident(table)
        );
        target
            .execute(Some(&opts.target_schema), &sql)
            .await
            .map_err(|e| format!("empty {}: {}", table, e))?;
    }

    // Detect keyset col NOW (before the locks) to decide whether to use
    // intra-table parallelism. Reason: LOCK TABLES WRITE on the
    // orchestrator would block the workers, and BEGIN/COMMIT doesn't make
    // sense in a multi-conn scenario. When intra is active, we skip
    // lock_target and the per-table tx.
    let keyset_col = if opts.use_keyset_pagination {
        find_keyset_column(&*source, &opts.source_schema, table).await
    } else {
        None
    };
    let intra_workers = opts.intra_table_workers.clamp(1, 8) as usize;
    let use_intra = intra_workers > 1
        && keyset_col.is_some()
        && total >= opts.intra_table_min_rows.max(1);

    // Diagnostic for the front: if the user configured intra > 1, make
    // explicit whether it was enabled and why. Removes ambiguity when the
    // drill-down doesn't show up.
    if opts.intra_table_workers > 1 {
        let (level, msg) = if use_intra {
            (
                "info",
                format!(
                    "Intra-table parallelism ativo: {} workers sobre {} linhas (PK: {})",
                    intra_workers,
                    total,
                    keyset_col.as_deref().unwrap_or("?"),
                ),
            )
        } else if keyset_col.is_none() {
            (
                "warn",
                format!(
                    "Intra-table parallelism desativado pra '{}': sem PK inteira de coluna única",
                    table
                ),
            )
        } else if total < opts.intra_table_min_rows.max(1) {
            (
                "warn",
                format!(
                    "Intra-table parallelism desativado pra '{}': {} linhas (mínimo configurado: {})",
                    table, total, opts.intra_table_min_rows
                ),
            )
        } else {
            (
                "warn",
                format!("Intra-table parallelism desativado pra '{}': razão desconhecida", table),
            )
        };
        let _ = app.emit(
            "transfer:table_note",
            &TableNote {
                table: table.to_string(),
                message: msg,
                level: level.to_string(),
            },
        );
    }
    // Effective flags for prelude/postlude: when intra is active, turn off
    // lock_target and the orchestrated per-table tx.
    let eff_lock_target = opts.lock_target && !use_intra;
    // `eff_use_tx` hard-disabled — the previous implementation wrapped
    // START/COMMIT via `Driver::execute()`, which goes through the sqlx pool
    // and may pick different connections for START, INSERTs, and COMMIT.
    // Without pinning, START left a pending tx on some pool conn (with no
    // atomic effect and potentially polluting the pool after errors, causing
    // hangs on subsequent operations). Until we refactor to pin via
    // `pool.acquire()`, transfers run in autocommit — traditional bulk-load
    // behavior.
    let _ = opts.use_transaction; // opt still in the UI, but has no effect for now
    let _ = opts.single_transaction;
    let eff_use_tx = false;

    if eff_lock_target {
        let lock_sql = format!(
            "LOCK TABLES {}.{} WRITE",
            target.quote_ident(&opts.target_schema),
            target.quote_ident(table)
        );
        let _ = target.execute(Some(&opts.target_schema), &lock_sql).await;
    }

    if opts.lock_source {
        let lock_sql = format!(
            "LOCK TABLES {}.{} READ",
            source.quote_ident(&opts.source_schema),
            source.quote_ident(table)
        );
        let _ = source.execute(Some(&opts.source_schema), &lock_sql).await;
    }

    if eff_use_tx {
        let _ = target.execute(Some(&opts.target_schema), "START TRANSACTION").await;
    }

    // If records shouldn't be created, skip the data loop.
    if !opts.create_records {
        let _ = app.emit(
            "transfer:progress",
            &TableProgress {
                table: table.to_string(),
                done: 0,
                total: 0,
                elapsed_ms: 0,
            },
        );
        if eff_use_tx {
            let _ = target.execute(Some(&opts.target_schema), "COMMIT").await;
        }
        if opts.lock_source {
            let _ = source.execute(Some(&opts.source_schema), "UNLOCK TABLES").await;
        }
        if eff_lock_target {
            let _ = target.execute(Some(&opts.target_schema), "UNLOCK TABLES").await;
        }
        if !session_restore.is_empty() {
            let _ = target.execute(Some(&opts.target_schema), &session_restore).await;
        }
        return Ok(0);
    }

    if total == 0 {
        let _ = app.emit(
            "transfer:progress",
            &TableProgress {
                table: table.to_string(),
                done: 0,
                total: 0,
                elapsed_ms: 0,
            },
        );
        // Close prelude even with 0 rows.
        if eff_use_tx {
            let _ = target.execute(Some(&opts.target_schema), "COMMIT").await;
        }
        if opts.lock_source {
            let _ = source.execute(Some(&opts.source_schema), "UNLOCK TABLES").await;
        }
        if eff_lock_target {
            let _ = target.execute(Some(&opts.target_schema), "UNLOCK TABLES").await;
        }
        if !session_restore.is_empty() {
            let _ = target.execute(Some(&opts.target_schema), &session_restore).await;
        }
        return Ok(0);
    }

    let chunk = opts.chunk_size.max(1);
    let max_bytes = (opts.max_statement_size_kb as usize).saturating_mul(1024).max(1024);
    let started = Instant::now();

    // Generated columns (STORED/VIRTUAL) can't appear in INSERT —
    // `SELECT *` from source includes them, so we build the set ONCE per
    // table and pass it to the copy loop to filter the column list.
    let generated_cols: std::collections::HashSet<String> = source
        .list_generated_columns(&opts.source_schema, table)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let generated_cols_arc = Arc::new(generated_cols);

    let transfer_result = if use_intra {
        let col = keyset_col.as_deref().unwrap();
        run_table_copy_ranges(
            app,
            opts,
            source.clone(),
            target.clone(),
            table,
            total,
            chunk,
            max_bytes,
            col,
            started,
            &insert_prelude,
            intra_workers,
            control,
            generated_cols_arc.clone(),
        )
        .await
    } else {
        // Gets structure + initial value with 1 SELECT, to obtain columns.
        // Chunk #0: always LIMIT N (keyset needs lastPk; starts with nothing).
        let first_select = if let Some(col) = &keyset_col {
            format!(
                "SELECT * FROM {}.{} ORDER BY {} LIMIT {}",
                qi(&opts.source_schema),
                qi(table),
                source.quote_ident(col),
                chunk
            )
        } else {
            format!(
                "SELECT * FROM {}.{} LIMIT {}",
                qi(&opts.source_schema),
                qi(table),
                chunk
            )
        };

        run_table_copy(
            app,
            opts,
            &*source,
            &*target,
            table,
            total,
            chunk,
            max_bytes,
            keyset_col.as_deref(),
            first_select,
            started,
            &insert_prelude,
            control,
            generated_cols_arc.as_ref(),
        )
        .await
    };

    // --- Postlude.
    let final_result = match transfer_result {
        Ok(n) => {
            if eff_use_tx {
                let _ = target.execute(Some(&opts.target_schema), "COMMIT").await;
            }
            Ok(n)
        }
        Err(e) => {
            if eff_use_tx {
                let _ = target.execute(Some(&opts.target_schema), "ROLLBACK").await;
            }
            Err(e)
        }
    };
    if opts.lock_source {
        let _ = source.execute(Some(&opts.source_schema), "UNLOCK TABLES").await;
    }
    if eff_lock_target {
        let _ = target.execute(Some(&opts.target_schema), "UNLOCK TABLES").await;
    }

    // Triggers — only if the table transfer didn't fail. Emitted AFTER the
    // UNLOCK because CREATE TRIGGER is DDL and LOCK TABLES restricts it;
    // and AFTER the COMMIT to avoid firing during the load. Errors here are
    // soft — they log but don't fail the table, since the data is already
    // saved.
    // Triggers are copied only in MySQL→MySQL. PG uses plpgsql, which has
    // different syntax and semantics; V1 doesn't translate trigger bodies.
    let triggers_cross_dialect = source.dialect() != target.dialect();
    if opts.copy_triggers && final_result.is_ok() && !triggers_cross_dialect {
        if let Err(e) = copy_table_triggers(&*source, &*target, opts, table).await {
            eprintln!("copy_triggers {}: {}", table, e);
        }
    }

    if !session_restore.is_empty() {
        let _ = target.execute(Some(&opts.target_schema), &session_restore).await;
    }
    final_result
}

/// Copies triggers associated with a table. Steps:
///  1. SHOW TRIGGERS FROM src_schema LIKE 'table' — lists names.
///  2. For each: SHOW CREATE TRIGGER src_schema.trg_name — full DDL.
///  3. DROP TRIGGER IF EXISTS tgt_schema.trg_name.
///  4. CREATE TRIGGER (with DEFINER stripped — the original definer may
///     not exist on the target).
async fn copy_table_triggers(
    source: &dyn Driver,
    target: &dyn Driver,
    opts: &TransferOptions,
    table: &str,
) -> Result<(), String> {
    // `SHOW TRIGGERS` only exists in MySQL. PG uses `pg_trigger`/plpgsql.
    if source.dialect() != "mysql" || target.dialect() != "mysql" {
        return Ok(());
    }
    let list_sql = format!(
        "SHOW TRIGGERS FROM {} LIKE '{}'",
        source.quote_ident(&opts.source_schema),
        table.replace('\'', "''"),
    );
    let list = source
        .query(Some(&opts.source_schema), &list_sql)
        .await
        .map_err(|e| format!("show triggers: {}", e))?;
    // Index of the "Trigger" column in SHOW TRIGGERS' result.
    let name_col = list
        .columns
        .iter()
        .position(|c| c.eq_ignore_ascii_case("Trigger"))
        .ok_or_else(|| "coluna Trigger não encontrada em SHOW TRIGGERS".to_string())?;

    for row in &list.rows {
        let Some(name_val) = row.get(name_col) else { continue };
        let name = match name_val {
            basemaster_core::Value::String(s) => s.clone(),
            _ => continue,
        };

        // SHOW CREATE TRIGGER <schema>.<trigger>
        let show_sql = format!(
            "SHOW CREATE TRIGGER {}.{}",
            source.quote_ident(&opts.source_schema),
            source.quote_ident(&name),
        );
        let show = source
            .query(Some(&opts.source_schema), &show_sql)
            .await
            .map_err(|e| format!("show create trigger {}: {}", name, e))?;
        // Column "SQL Original Statement".
        let stmt_col = show
            .columns
            .iter()
            .position(|c| {
                c.eq_ignore_ascii_case("SQL Original Statement")
                    || c.eq_ignore_ascii_case("Statement")
            })
            .ok_or_else(|| {
                format!("sem 'SQL Original Statement' em SHOW CREATE TRIGGER {}", name)
            })?;
        let Some(stmt_val) = show.rows.first().and_then(|r| r.get(stmt_col)) else {
            continue;
        };
        let ddl = match stmt_val {
            basemaster_core::Value::String(s) => s.clone(),
            _ => continue,
        };
        let ddl = strip_definer(&ddl);

        // Drop + create on the target.
        let drop_sql = format!(
            "DROP TRIGGER IF EXISTS {}.{}",
            target.quote_ident(&opts.target_schema),
            target.quote_ident(&name),
        );
        target
            .execute(Some(&opts.target_schema), &drop_sql)
            .await
            .map_err(|e| format!("drop trigger {}: {}", name, e))?;
        target
            .execute(Some(&opts.target_schema), &ddl)
            .await
            .map_err(|e| format!("create trigger {}: {}", name, e))?;
    }
    Ok(())
}

/// Removes the `DEFINER=<user>@<host>` clause from a CREATE TRIGGER
/// (or CREATE PROCEDURE/FUNCTION/VIEW/EVENT). Without this, the DDL fails
/// on the target if the source user doesn't exist there. Preserves
/// backticks, single quotes, and double quotes in the DEFINER's value.
fn strip_definer(sql: &str) -> String {
    let Some(start) = sql.find("DEFINER") else {
        return sql.to_string();
    };
    // Sanity: DEFINER should be the modifier right after CREATE.
    if !sql[..start].trim_start().to_ascii_uppercase().starts_with("CREATE") {
        return sql.to_string();
    }

    let bytes = sql.as_bytes();
    let mut i = start + "DEFINER".len();
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'=' {
        return sql.to_string();
    }
    i += 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }

    // Consume value, respecting ` " ' with doubled escape.
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) if b == q => {
                if i + 1 < bytes.len() && bytes[i + 1] == q {
                    i += 2;
                } else {
                    quote = None;
                    i += 1;
                }
            }
            Some(_) => i += 1,
            None => {
                if b == b'`' || b == b'"' || b == b'\'' {
                    quote = Some(b);
                    i += 1;
                } else if b.is_ascii_whitespace() {
                    break;
                } else {
                    i += 1;
                }
            }
        }
    }
    // Trim ws after the removed value.
    let tail = sql[i..].trim_start();
    format!("{}{}", &sql[..start], tail)
}

#[allow(clippy::too_many_arguments)]
async fn run_table_copy(
    app: &AppHandle,
    opts: &TransferOptions,
    source: &dyn Driver,
    target: &dyn Driver,
    table: &str,
    total: u64,
    chunk: u64,
    max_bytes: usize,
    keyset_col: Option<&str>,
    first_select: String,
    started: Instant,
    session_prelude: &str,
    control: &Arc<TransferControl>,
    generated_cols: &std::collections::HashSet<String>,
) -> Result<u64, String> {
    let qi = |s: &str| source.quote_ident(s);
    let verb = match opts.insert_mode {
        InsertMode::Insert => "INSERT INTO",
        InsertMode::InsertIgnore => "INSERT IGNORE INTO",
        InsertMode::Replace => "REPLACE INTO",
    };

    let mut transferred: u64 = 0;
    let mut last_key: Option<basemaster_core::Value> = None;
    let mut select_sql = first_select;
    let mut offset: u64 = 0;

    loop {
        if !control.check().await {
            break;
        }
        let batch = source
            .query(Some(&opts.source_schema), &select_sql)
            .await
            .map_err(|e| format!("select {}: {}", table, e))?;

        if batch.rows.is_empty() {
            break;
        }

        // Mask of insertable columns — GENERATED cols must be dropped from
        // the INSERT or MySQL rejects ("value specified for generated column
        // is not allowed"). `keep[i] = false` → skip index i in cols + rows.
        let keep: Vec<bool> = batch
            .columns
            .iter()
            .map(|c| !generated_cols.contains(c))
            .collect();
        let cols: Vec<String> = batch
            .columns
            .iter()
            .zip(keep.iter())
            .filter(|(_, &k)| k)
            .map(|(c, _)| target.quote_ident(c))
            .collect();
        // complete_inserts: includes the column list in the INSERT (recommended).
        // !complete_inserts: omits it. Position-dependent; only works if the
        // column order on the target is identical to the source.
        // Prepend session_prelude to ensure FK_CHECKS=0 on the SAME conn.
        let prefix = if opts.complete_inserts {
            format!(
                "{}{} {}.{} ({}) VALUES ",
                session_prelude,
                verb,
                target.quote_ident(&opts.target_schema),
                target.quote_ident(table),
                cols.join(", ")
            )
        } else {
            format!(
                "{}{} {}.{} VALUES ",
                session_prelude,
                verb,
                target.quote_ident(&opts.target_schema),
                target.quote_ident(table)
            )
        };

        if opts.extended_inserts {
            // Multi-row: builds INSERTs respecting max_statement_size_kb.
            let mut buf = String::with_capacity(max_bytes.min(4 * 1024 * 1024));
            buf.push_str(&prefix);
            let mut rows_in_buf = 0u64;

            for row in &batch.rows {
                let parts: Vec<String> = row
                    .iter()
                    .zip(keep.iter())
                    .filter(|(_, &k)| k)
                    .map(|(v, _)| sql_literal_opts(v, opts.hex_blob))
                    .collect();
                let row_sql = format!("({})", parts.join(", "));
                if rows_in_buf > 0 && buf.len() + 2 + row_sql.len() > max_bytes {
                    target
                        .execute(Some(&opts.target_schema), &buf)
                        .await
                        .map_err(|e| format!("insert {}: {}", table, e))?;
                    buf.clear();
                    buf.push_str(&prefix);
                    rows_in_buf = 0;
                }
                if rows_in_buf > 0 {
                    buf.push_str(", ");
                }
                buf.push_str(&row_sql);
                rows_in_buf += 1;
            }
            if rows_in_buf > 0 {
                target
                    .execute(Some(&opts.target_schema), &buf)
                    .await
                    .map_err(|e| format!("insert {}: {}", table, e))?;
            }
        } else {
            // One INSERT per row. Slower but may help with triggers expecting
            // 1 row at a time or for debugging.
            for row in &batch.rows {
                let parts: Vec<String> = row
                    .iter()
                    .zip(keep.iter())
                    .filter(|(_, &k)| k)
                    .map(|(v, _)| sql_literal_opts(v, opts.hex_blob))
                    .collect();
                let sql = format!("{}({})", prefix, parts.join(", "));
                target
                    .execute(Some(&opts.target_schema), &sql)
                    .await
                    .map_err(|e| format!("insert {}: {}", table, e))?;
            }
        }

        let n = batch.rows.len() as u64;
        transferred += n;
        // Next key/offset.
        if let Some(col) = keyset_col {
            // Grab the last PK value in this batch.
            let col_idx = batch.columns.iter().position(|c| c == col);
            if let Some(idx) = col_idx {
                if let Some(last_row) = batch.rows.last() {
                    if let Some(v) = last_row.get(idx) {
                        last_key = Some(v.clone());
                    }
                }
            }
        } else {
            offset += n;
        }

        let _ = app.emit(
            "transfer:progress",
            &TableProgress {
                table: table.to_string(),
                done: transferred,
                total,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );

        if n < chunk {
            break;
        }

        // Build next SELECT.
        if let (Some(col), Some(key)) = (keyset_col, &last_key) {
            select_sql = format!(
                "SELECT * FROM {}.{} WHERE {} > {} ORDER BY {} LIMIT {}",
                qi(&opts.source_schema),
                qi(table),
                source.quote_ident(col),
                sql_literal(key),
                source.quote_ident(col),
                chunk
            );
        } else {
            select_sql = format!(
                "SELECT * FROM {}.{} LIMIT {} OFFSET {}",
                qi(&opts.source_schema),
                qi(table),
                chunk,
                offset
            );
        }
    }
    Ok(transferred)
}

/// Intra-table split: divides the range [MIN(pk), MAX(pk)] into N ranges
/// and copies each in parallel. Requires integer PK (same condition as
/// keyset). Each worker has its own pool connection; to avoid the
/// orchestrator holding a lock/tx that would block the workers,
/// lock_target and use_transaction are disabled in this mode by the
/// caller (see `eff_lock_target`, `eff_use_tx` in `transfer_one`).
///
/// Limitation: per-table atomicity is lost — each worker auto-commits its
/// INSERTs. Partial failure is partially visible on the target. This
/// trade-off is explicitly what the user opts into when they set
/// `intra_table_workers > 1`.
#[allow(clippy::too_many_arguments)]
async fn run_table_copy_ranges(
    app: &AppHandle,
    opts: &TransferOptions,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    table: &str,
    total: u64,
    chunk: u64,
    max_bytes: usize,
    keyset_col: &str,
    started: Instant,
    session_prelude: &str,
    workers: usize,
    control: &Arc<TransferControl>,
    generated_cols: Arc<std::collections::HashSet<String>>,
) -> Result<u64, String> {
    // 1. PK MIN/MAX to know the total range.
    let minmax_sql = format!(
        "SELECT MIN({col}), MAX({col}) FROM {sch}.{tbl}",
        col = source.quote_ident(keyset_col),
        sch = source.quote_ident(&opts.source_schema),
        tbl = source.quote_ident(table),
    );
    let mm = source
        .query(Some(&opts.source_schema), &minmax_sql)
        .await
        .map_err(|e| format!("minmax {}: {}", table, e))?;
    let (min_v, max_v) = mm
        .rows
        .first()
        .and_then(|r| Some((r.first()?.clone(), r.get(1)?.clone())))
        .ok_or_else(|| format!("minmax {}: sem linhas", table))?;
    let (min_i, max_i) = match (value_to_i128(&min_v), value_to_i128(&max_v)) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            // Fallback: non-partitioned run_table_copy
            let first_select = format!(
                "SELECT * FROM {}.{} ORDER BY {} LIMIT {}",
                source.quote_ident(&opts.source_schema),
                source.quote_ident(table),
                source.quote_ident(keyset_col),
                chunk
            );
            return run_table_copy(
                app,
                opts,
                &*source,
                &*target,
                table,
                total,
                chunk,
                max_bytes,
                Some(keyset_col),
                first_select,
                started,
                session_prelude,
                control,
                generated_cols.as_ref(),
            )
            .await;
        }
    };
    if min_i >= max_i {
        // Only 1 value — not worth partitioning.
        let first_select = format!(
            "SELECT * FROM {}.{} ORDER BY {} LIMIT {}",
            source.quote_ident(&opts.source_schema),
            source.quote_ident(table),
            source.quote_ident(keyset_col),
            chunk
        );
        return run_table_copy(
            app,
            opts,
            &*source,
            &*target,
            table,
            total,
            chunk,
            max_bytes,
            Some(keyset_col),
            first_select,
            started,
            session_prelude,
            control,
            generated_cols.as_ref(),
        )
        .await;
    }

    // 2. Split [min, max+1) into N roughly equal ranges by value.
    // (not by distribution — assumes uniformly-distributed PK)
    let span = (max_i - min_i) + 1;
    let step = span.div_euclid(workers as i128).max(1);
    let mut ranges: Vec<(i128, i128)> = Vec::with_capacity(workers);
    let mut cur = min_i;
    for i in 0..workers {
        let hi = if i + 1 == workers {
            max_i + 1
        } else {
            (cur + step).min(max_i + 1)
        };
        if cur < hi {
            ranges.push((cur, hi));
        }
        cur = hi;
    }

    // 3. Spawn workers.
    use std::sync::atomic::AtomicU64;
    let counter = Arc::new(AtomicU64::new(0));
    let first_error: Arc<tokio::sync::Mutex<Option<String>>> =
        Arc::new(tokio::sync::Mutex::new(None));
    let mut handles = Vec::with_capacity(ranges.len());

    for (worker_id, (low, high)) in ranges.into_iter().enumerate() {
        let app = app.clone();
        let source = source.clone();
        let target = target.clone();
        let counter = counter.clone();
        let first_error = first_error.clone();
        let opts = opts.clone();
        let table = table.to_string();
        let keyset_col = keyset_col.to_string();
        let session_prelude = session_prelude.to_string();
        let control_w = control.clone();
        let generated_cols = generated_cols.clone();
        handles.push(tokio::spawn(async move {
            let res = copy_pk_range(
                &app,
                &opts,
                &*source,
                &*target,
                &table,
                worker_id as u32,
                chunk,
                max_bytes,
                &keyset_col,
                low,
                high,
                total,
                started,
                &session_prelude,
                &counter,
                &control_w,
                &generated_cols,
            )
            .await;
            // Final emit — finished=true with the worker's done/error.
            let (done_rows, err_str) = match &res {
                Ok(n) => (*n, None),
                Err(e) => (0, Some(e.clone())),
            };
            let _ = app.emit(
                "transfer:worker_progress",
                &TableWorkerProgress {
                    table: table.clone(),
                    worker_id: worker_id as u32,
                    low_pk: low.to_string(),
                    high_pk: high.to_string(),
                    done: done_rows,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    finished: true,
                    error: err_str,
                },
            );
            if let Err(e) = &res {
                let mut guard = first_error.lock().await;
                if guard.is_none() {
                    *guard = Some(e.clone());
                }
            }
            res.unwrap_or(0)
        }));
    }

    let mut total_transferred: u64 = 0;
    for h in handles {
        if let Ok(n) = h.await {
            total_transferred += n;
        }
    }

    let err = first_error.lock().await.clone();
    if let Some(e) = err {
        return Err(e);
    }
    Ok(total_transferred)
}

/// Converts Value::Int/UInt/Decimal to i128 if possible. Used to compute
/// PK range. Decimal comes from MIN/MAX on bigint unsigned columns via
/// sqlx in some cases.
fn value_to_i128(v: &basemaster_core::Value) -> Option<i128> {
    use basemaster_core::Value;
    match v {
        Value::Int(i) => Some(*i as i128),
        Value::UInt(u) => Some(*u as i128),
        Value::Decimal(d) => d.to_string().parse().ok(),
        _ => None,
    }
}

/// Worker for one PK range: replicates run_table_copy's loop but with
/// `WHERE pk >= low AND pk < high` pinned. Emits progress added to the
/// global counter.
#[allow(clippy::too_many_arguments)]
async fn copy_pk_range(
    app: &AppHandle,
    opts: &TransferOptions,
    source: &dyn Driver,
    target: &dyn Driver,
    table: &str,
    worker_id: u32,
    chunk: u64,
    max_bytes: usize,
    keyset_col: &str,
    low: i128,
    high: i128,
    total: u64,
    started: Instant,
    session_prelude: &str,
    counter: &std::sync::atomic::AtomicU64,
    control: &Arc<TransferControl>,
    generated_cols: &std::collections::HashSet<String>,
) -> Result<u64, String> {
    use std::sync::atomic::Ordering;
    let qi = |s: &str| source.quote_ident(s);
    let verb = match opts.insert_mode {
        InsertMode::Insert => "INSERT INTO",
        InsertMode::InsertIgnore => "INSERT IGNORE INTO",
        InsertMode::Replace => "REPLACE INTO",
    };

    // Initial emit — front paints the worker slot immediately.
    let _ = app.emit(
        "transfer:worker_progress",
        &TableWorkerProgress {
            table: table.to_string(),
            worker_id,
            low_pk: low.to_string(),
            high_pk: high.to_string(),
            done: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            finished: false,
            error: None,
        },
    );

    let mut transferred: u64 = 0;
    let mut last_key: Option<basemaster_core::Value> = None;

    loop {
        if !control.check().await {
            break;
        }
        let select_sql = if let Some(key) = &last_key {
            format!(
                "SELECT * FROM {}.{} WHERE {} > {} AND {} < {} ORDER BY {} LIMIT {}",
                qi(&opts.source_schema),
                qi(table),
                source.quote_ident(keyset_col),
                sql_literal(key),
                source.quote_ident(keyset_col),
                high,
                source.quote_ident(keyset_col),
                chunk
            )
        } else {
            format!(
                "SELECT * FROM {}.{} WHERE {} >= {} AND {} < {} ORDER BY {} LIMIT {}",
                qi(&opts.source_schema),
                qi(table),
                source.quote_ident(keyset_col),
                low,
                source.quote_ident(keyset_col),
                high,
                source.quote_ident(keyset_col),
                chunk
            )
        };

        let batch = source
            .query(Some(&opts.source_schema), &select_sql)
            .await
            .map_err(|e| format!("select {} [{}..{})]: {}", table, low, high, e))?;

        if batch.rows.is_empty() {
            break;
        }

        let keep: Vec<bool> = batch
            .columns
            .iter()
            .map(|c| !generated_cols.contains(c))
            .collect();
        let cols: Vec<String> = batch
            .columns
            .iter()
            .zip(keep.iter())
            .filter(|(_, &k)| k)
            .map(|(c, _)| target.quote_ident(c))
            .collect();
        let prefix = if opts.complete_inserts {
            format!(
                "{}{} {}.{} ({}) VALUES ",
                session_prelude,
                verb,
                target.quote_ident(&opts.target_schema),
                target.quote_ident(table),
                cols.join(", ")
            )
        } else {
            format!(
                "{}{} {}.{} VALUES ",
                session_prelude,
                verb,
                target.quote_ident(&opts.target_schema),
                target.quote_ident(table)
            )
        };

        if opts.extended_inserts {
            let mut buf = String::with_capacity(max_bytes.min(4 * 1024 * 1024));
            buf.push_str(&prefix);
            let mut rows_in_buf = 0u64;
            for row in &batch.rows {
                let parts: Vec<String> = row
                    .iter()
                    .zip(keep.iter())
                    .filter(|(_, &k)| k)
                    .map(|(v, _)| sql_literal_opts(v, opts.hex_blob))
                    .collect();
                let row_sql = format!("({})", parts.join(", "));
                if rows_in_buf > 0 && buf.len() + 2 + row_sql.len() > max_bytes {
                    target
                        .execute(Some(&opts.target_schema), &buf)
                        .await
                        .map_err(|e| format!("insert {}: {}", table, e))?;
                    buf.clear();
                    buf.push_str(&prefix);
                    rows_in_buf = 0;
                }
                if rows_in_buf > 0 {
                    buf.push_str(", ");
                }
                buf.push_str(&row_sql);
                rows_in_buf += 1;
            }
            if rows_in_buf > 0 {
                target
                    .execute(Some(&opts.target_schema), &buf)
                    .await
                    .map_err(|e| format!("insert {}: {}", table, e))?;
            }
        } else {
            for row in &batch.rows {
                let parts: Vec<String> = row
                    .iter()
                    .zip(keep.iter())
                    .filter(|(_, &k)| k)
                    .map(|(v, _)| sql_literal_opts(v, opts.hex_blob))
                    .collect();
                let sql = format!("{}({})", prefix, parts.join(", "));
                target
                    .execute(Some(&opts.target_schema), &sql)
                    .await
                    .map_err(|e| format!("insert {}: {}", table, e))?;
            }
        }

        let n = batch.rows.len() as u64;
        transferred += n;

        // Update global counter and emit aggregated progress.
        let global = counter.fetch_add(n, Ordering::Relaxed) + n;
        let _ = app.emit(
            "transfer:progress",
            &TableProgress {
                table: table.to_string(),
                done: global,
                total,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );

        // Per-worker emit — enables drill-down in the UI by range.
        let _ = app.emit(
            "transfer:worker_progress",
            &TableWorkerProgress {
                table: table.to_string(),
                worker_id,
                low_pk: low.to_string(),
                high_pk: high.to_string(),
                done: transferred,
                elapsed_ms: started.elapsed().as_millis() as u64,
                finished: false,
                error: None,
            },
        );

        // Next key: last PK in the batch.
        let col_idx = batch.columns.iter().position(|c| c == keyset_col);
        if let (Some(idx), Some(last_row)) = (col_idx, batch.rows.last()) {
            if let Some(v) = last_row.get(idx) {
                last_key = Some(v.clone());
            }
        }

        if n < chunk {
            break;
        }
    }

    Ok(transferred)
}

/// Finds a single integer PK column for keyset pagination.
/// Returns None if the table has no PK, a composite PK, or a non-integer PK
/// (we fall back to OFFSET pagination in those cases).
async fn find_keyset_column(
    source: &dyn Driver,
    schema: &str,
    table: &str,
) -> Option<String> {
    let cols = source.describe_table(schema, table).await.ok()?;
    let pks: Vec<_> = cols.iter().filter(|c| c.is_primary_key).collect();
    if pks.len() != 1 {
        return None;
    }
    let pk = pks[0];
    // Accepts common orderable types. Strings also work but are
    // slower — for now only integers.
    match &pk.column_type {
        basemaster_core::ColumnType::Integer { .. } => Some(pk.name.clone()),
        _ => None,
    }
}

/// Variant with a BLOB flag: true = hex (`0xFF...`, safe and canonical),
/// false = string-escape (`'\x00...'`, may corrupt in certain encodings).
/// Default hex.
fn sql_literal_opts(v: &basemaster_core::Value, hex_blob: bool) -> String {
    use basemaster_core::Value;
    if !hex_blob {
        if let Value::Bytes(b) = v {
            let s = b.iter().map(|c| *c as char).collect::<String>();
            return format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"));
        }
    }
    sql_literal(v)
}

/// Formats a `Value` as a SQL literal. V1 — defers to V1.1 a version
/// using parametrized driver bind (type precision, correct BLOBs).
fn sql_literal(v: &basemaster_core::Value) -> String {
    use basemaster_core::Value;
    fn quote(s: &str) -> String {
        format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
    }
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => {
            if f.is_finite() {
                format!("{}", f)
            } else {
                "NULL".into()
            }
        }
        Value::Decimal(d) => d.to_string(),
        Value::String(s) => quote(s),
        Value::Date(d) => quote(&d.format("%Y-%m-%d").to_string()),
        Value::Time(t) => quote(&t.format("%H:%M:%S").to_string()),
        Value::DateTime(dt) => quote(&dt.format("%Y-%m-%d %H:%M:%S").to_string()),
        Value::Timestamp(ts) => quote(&ts.format("%Y-%m-%d %H:%M:%S").to_string()),
        Value::Json(j) => quote(&j.to_string()),
        Value::Bytes(b) => {
            let hex: String = b.iter().map(|byte| format!("{:02X}", byte)).collect();
            format!("0x{}", hex)
        }
    }
}
