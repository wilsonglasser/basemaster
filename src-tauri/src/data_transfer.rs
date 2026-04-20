//! Data Transfer V1.0 — move dados entre duas conexões.
//!
//! Para cada tabela:
//!   1. (opcional) DROP TABLE destino
//!   2. (opcional) CREATE TABLE destino via SHOW CREATE TABLE (origem)
//!   3. (opcional) DELETE FROM destino (se não dropou)
//!   4. SELECT * em chunks + INSERT extended no destino
//!
//! Paralelismo, FKs, triggers, options finas (ignore/replace/hex BLOB) entram na V1.1.
//!
//! Emite eventos Tauri:
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

/// Controle de pausa/stop compartilhado pela transferência em execução.
/// Workers chamam `wait_if_paused_or_stopped` entre batches pra cooperar.
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
    /// Chamado antes de cada transferência pra reiniciar flags.
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
    /// Retorna `true` se deve continuar, `false` se foi pedido stop.
    /// Enquanto estiver pausado, dorme aguardando notify.
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
    /// `INSERT INTO ... VALUES ...` — falha se PK duplicada.
    #[default]
    Insert,
    /// `INSERT IGNORE INTO ...` — pula linhas com PK duplicada.
    InsertIgnore,
    /// `REPLACE INTO ...` — substitui linhas com PK duplicada.
    Replace,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferOptions {
    pub source_connection_id: Uuid,
    pub source_schema: String,
    pub target_connection_id: Uuid,
    pub target_schema: String,
    pub tables: Vec<String>,
    /// Se true, DROP TABLE no destino antes de recriar.
    #[serde(default)]
    pub drop_target: bool,
    /// Se true, cria as tabelas (via SHOW CREATE TABLE). Se false, assume existentes.
    #[serde(default = "default_true")]
    pub create_tables: bool,
    /// Se true e não dropou, faz DELETE FROM antes de inserir.
    #[serde(default)]
    pub empty_target: bool,
    /// Linhas por batch no SELECT (e também base pro INSERT extended).
    #[serde(default = "default_chunk")]
    pub chunk_size: u64,
    /// Se true, continua na próxima tabela em caso de erro.
    #[serde(default)]
    pub continue_on_error: bool,
    /// Quantas tabelas transferir em paralelo. Default 1 (sequencial).
    /// Limitado pelo `max_connections` do pool (hoje = 8).
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    /// Modo de INSERT — permite ignorar/substituir duplicatas.
    #[serde(default)]
    pub insert_mode: InsertMode,
    // --- Otimizações ---
    /// SET FOREIGN_KEY_CHECKS=0 durante inserts. Essencial pra velocidade.
    #[serde(default = "default_true")]
    pub disable_fk_checks: bool,
    /// SET UNIQUE_CHECKS=0 — pula validação de UNIQUE.
    #[serde(default = "default_true")]
    pub disable_unique_checks: bool,
    /// SET SQL_LOG_BIN=0 — pula binlog. Opt-in (não usar em master com replicas).
    #[serde(default)]
    pub disable_binlog: bool,
    /// Envolve os INSERTs de cada tabela em BEGIN/COMMIT.
    #[serde(default = "default_true")]
    pub use_transaction: bool,
    /// LOCK TABLES <target> WRITE durante o load.
    #[serde(default)]
    pub lock_target: bool,
    /// Limite do tamanho de cada INSERT em KB (pra não estourar max_allowed_packet).
    #[serde(default = "default_stmt_kb")]
    pub max_statement_size_kb: u64,
    /// Usa keyset pagination (WHERE pk > last LIMIT N) quando a tabela
    /// tem PK de coluna única inteira. Muito mais rápido que OFFSET
    /// em tabelas grandes.
    #[serde(default = "default_true")]
    pub use_keyset_pagination: bool,
    // --- Opções no estilo Navicat ---
    /// Cria o schema/database de destino se não existir.
    #[serde(default = "default_true")]
    pub create_target_schema: bool,
    /// Se true, copia dados (INSERT). Se false, só estrutura.
    #[serde(default = "default_true")]
    pub create_records: bool,
    /// INSERT INTO t (col1, col2, ...) VALUES vs INSERT INTO t VALUES.
    /// Recomendado ON — mais seguro em caso de ordem de colunas diferente.
    #[serde(default = "default_true")]
    pub complete_inserts: bool,
    /// Multi-row INSERT. Se false, um INSERT por linha (mais lento mas
    /// pode ajudar em debug ou com triggers que esperam 1 row).
    #[serde(default = "default_true")]
    pub extended_inserts: bool,
    /// BLOB como 0xFF... (hex). Alternativa: escape string (problemático).
    /// Default = true, Navicat também.
    #[serde(default = "default_true")]
    pub hex_blob: bool,
    /// BEGIN/COMMIT envolvendo TODAS as tabelas (uma tx só).
    /// Se false e use_transaction=true → uma tx por tabela.
    #[serde(default)]
    pub single_transaction: bool,
    /// LOCK TABLES source.* READ durante o load — snapshot consistente.
    #[serde(default)]
    pub lock_source: bool,
    /// Adiciona NO_AUTO_VALUE_ON_ZERO ao sql_mode. Sem isso, inserir 0 em
    /// coluna AUTO_INCREMENT vira o próximo valor da sequência (default
    /// do MySQL). Precisa pra preservar registros com PK=0 originais.
    /// Mesmo comportamento do mysqldump.
    #[serde(default = "default_true")]
    pub preserve_zero_auto_increment: bool,
    /// Copia os triggers de cada tabela. SHOW TRIGGERS + SHOW CREATE
    /// TRIGGER na origem, DROP + CREATE no destino. Rodado DEPOIS dos
    /// inserts pra não disparar os triggers durante o load.
    #[serde(default = "default_true")]
    pub copy_triggers: bool,
    /// Paralelismo *intra*-tabela: divide o range da PK inteira em N
    /// intervalos e copia cada um em paralelo. Default 1 (desligado).
    /// Só ativa se a tabela tem PK inteira de coluna única (mesma
    /// condição do keyset) e total > intra_table_min_rows.
    #[serde(default = "default_intra_workers")]
    pub intra_table_workers: u32,
    /// Threshold mínimo de linhas pra acionar split intra-tabela. Em
    /// tabelas pequenas, o overhead de 2x MIN/MAX + N conexões não
    /// compensa. Default 50k.
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
    1024 // 1 MB — folga confortável antes do max_allowed_packet padrão (4 MB).
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

/// Mensagem informativa sobre uma tabela — ex: "intra-parallel solicitado
/// mas não ativado porque …". Permite ao front explicar decisões sem
/// ter que replicar a lógica do backend.
#[derive(Clone, Debug, Serialize)]
pub struct TableNote {
    pub table: String,
    pub message: String,
    /// "info" | "warn"
    pub level: String,
}

/// Progresso de um worker de intra-table parallelism. Emitido como
/// `transfer:worker_progress`. Além do agregado por tabela, o front
/// pode mostrar cada faixa individualmente (range, done, status).
#[derive(Clone, Debug, Serialize)]
pub struct TableWorkerProgress {
    pub table: String,
    pub worker_id: u32,
    /// Bounds do range de PK: `[low_pk, high_pk)`. String porque i128
    /// não serializa limpo em serde_json (sem `arbitrary_precision`).
    pub low_pk: String,
    pub high_pk: String,
    pub done: u64,
    pub elapsed_ms: u64,
    /// Tornou-se `true` quando o worker terminou (com ou sem erro).
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TransferDone {
    pub total_rows: u64,
    pub elapsed_ms: u64,
    pub failed: u32,
}

/// Executa a transferência no runtime Tokio do Tauri. Retorna o total
/// global. Eventos progressivos são emitidos via `AppHandle::emit`.
///
/// Paralelismo: se `concurrency > 1`, spawn N workers que consomem uma
/// fila (mpsc) de nomes de tabelas. Cada worker faz `transfer_one`
/// isoladamente. Sequencial se `concurrency == 1` (menos overhead).
pub async fn run_transfer(
    app: AppHandle,
    opts: TransferOptions,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    control: Arc<TransferControl>,
) -> Result<TransferDone, String> {
    let total_started = Instant::now();
    let concurrency = opts.concurrency.clamp(1, 16) as usize;

    // Cria o schema/database de destino. MySQL: CREATE DATABASE;
    // PostgreSQL: CREATE SCHEMA (schemas ≠ databases em PG).
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

    // single_transaction: wrap TODO o transfer numa tx única no target.
    // Usado pra atomicidade total mas pode prender conns/lock logs.
    if opts.single_transaction {
        let _ = target.execute(Some(&opts.target_schema), "START TRANSACTION").await;
    }

    // Se só 1 worker, caminho simples mantém a semântica de abort-on-error.
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

    if opts.single_transaction {
        let sql = if result.as_ref().map(|r| r.failed == 0).unwrap_or(false) {
            "COMMIT"
        } else {
            "ROLLBACK"
        };
        let _ = target.execute(Some(&opts.target_schema), sql).await;
    }

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

    // Parallel (continuação): canal de tarefas.
    let (tx, rx) = async_channel::unbounded::<String>();
    for t in &opts.tables {
        let _ = tx.send(t.clone()).await;
    }
    drop(tx); // fecha — workers saem quando a fila esvazia.

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
                // Pausa/stop cooperativo ANTES de pegar a próxima tabela.
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
                // `control` aqui é Arc<TransferControl>, transfer_one
                // aceita `&Arc<TransferControl>` — o `&control` faz a
                // coerção certa.
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
                        // Sinaliza abort — drena o canal.
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

    // 1. Conta total pra progresso.
    let total = source
        .count_table_rows(&opts.source_schema, table)
        .await
        .map_err(|e| format!("count {}: {}", table, e))?;

    // Os session-level SETs abaixo são MySQL-only. Em PG todos viram
    // no-op (o prelude fica vazio).
    let target_is_mysql = target.dialect() == "mysql";
    let mut session_prelude = String::new();
    let mut session_restore = String::new();
    if target_is_mysql {
        if opts.disable_fk_checks {
            session_prelude.push_str("SET FOREIGN_KEY_CHECKS=0; ");
            session_restore.push_str("SET FOREIGN_KEY_CHECKS=1; ");
        }
        if opts.disable_unique_checks {
            session_prelude.push_str("SET UNIQUE_CHECKS=0; ");
            session_restore.push_str("SET UNIQUE_CHECKS=1; ");
        }
        if opts.disable_binlog {
            session_prelude.push_str("SET SQL_LOG_BIN=0; ");
            session_restore.push_str("SET SQL_LOG_BIN=1; ");
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
    // Prelude alternativa p/ ser prepended em INSERTs dentro de uma tx.
    // MySQL recusa `SET SQL_LOG_BIN` dentro de transação (erro 1694),
    // então construímos uma variação sem isso para a fase DML. O SET
    // de binlog só roda em DDL (fora de tx) via `session_prelude`.
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

    // 3. Drop + Create (ou só Empty) conforme opts.
    // CRÍTICO: prepend session_prelude em CADA statement. SET SESSION só
    // vale na conexão atual, e sqlx pool pode devolver outra conn entre
    // chamadas. Multi-statement "SET FK=0; DROP..." numa execute só
    // garante mesma conn.
    if opts.drop_target {
        // PG: CASCADE remove FKs que bloqueariam o DROP (equivalente ao
        // SET FOREIGN_KEY_CHECKS=0 do MySQL).
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

        // Se source e target são dialetos diferentes, traduz o DDL.
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
        // Em target PG, pula o session_prelude (é MySQL-only).
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

    // Detecta keyset col AGORA (antes dos locks) pra decidir se vamos
    // usar intra-table parallelism. Motivo: LOCK TABLES WRITE na
    // orquestradora bloquearia os workers, e a BEGIN/COMMIT não faz
    // sentido num cenário multi-conn. Quando intra ativo, skipamos
    // lock_target e a tx por-tabela.
    let keyset_col = if opts.use_keyset_pagination {
        find_keyset_column(&*source, &opts.source_schema, table).await
    } else {
        None
    };
    let intra_workers = opts.intra_table_workers.clamp(1, 8) as usize;
    let use_intra = intra_workers > 1
        && keyset_col.is_some()
        && total >= opts.intra_table_min_rows.max(1);

    // Diagnóstico pro front: se usuário configurou intra > 1, explicita
    // se ativou e por quê. Elimina dúvida quando o drill-down não aparece.
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
    // Flags efetivas pra prelude/postlude: quando intra ativo, desliga
    // lock_target e a tx por-tabela orquestrada.
    let eff_lock_target = opts.lock_target && !use_intra;
    let eff_use_tx = opts.use_transaction && !opts.single_transaction && !use_intra;

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

    // Se não é pra criar registros, pula o loop de dados.
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
        // Fecha prelude mesmo com 0 linhas.
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
        )
        .await
    } else {
        // Pega estrutura + valor inicial com 1 SELECT, pra ter colunas.
        // Chunk #0: sempre LIMIT N (keyset precisa de lastPk, começa com nada).
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

    // Triggers — só se o transfer da tabela não falhou. Emitidos
    // DEPOIS do UNLOCK porque CREATE TRIGGER é DDL e LOCK TABLES
    // restringe; e DEPOIS do COMMIT pra não disparar durante o load.
    // Erros aqui são soft — logam mas não falham a tabela, já que os
    // dados já estão salvos.
    // Triggers são copiados apenas em MySQL→MySQL. PG usa plpgsql que
    // tem sintaxe e semântica diferentes; V1 não traduz corpos de trigger.
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

/// Copia triggers associados a uma tabela. Passos:
///  1. SHOW TRIGGERS FROM src_schema LIKE 'table' — lista nomes.
///  2. Pra cada: SHOW CREATE TRIGGER src_schema.trg_name — DDL completo.
///  3. DROP TRIGGER IF EXISTS tgt_schema.trg_name.
///  4. CREATE TRIGGER (com DEFINER stripado — o definer original pode
///     não existir no destino).
async fn copy_table_triggers(
    source: &dyn Driver,
    target: &dyn Driver,
    opts: &TransferOptions,
    table: &str,
) -> Result<(), String> {
    // `SHOW TRIGGERS` só existe em MySQL. PG usa `pg_trigger`/plpgsql.
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
    // Índice da coluna "Trigger" no resultado de SHOW TRIGGERS.
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
        // Coluna "SQL Original Statement".
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

        // Drop + create no destino.
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

/// Remove a cláusula `DEFINER=<user>@<host>` de um CREATE TRIGGER
/// (ou CREATE PROCEDURE/FUNCTION/VIEW/EVENT). Sem isso, o DDL falha
/// no destino se o usuário da origem não existir lá. Preserva backticks,
/// aspas simples e duplas no valor do DEFINER.
fn strip_definer(sql: &str) -> String {
    let Some(start) = sql.find("DEFINER") else {
        return sql.to_string();
    };
    // Sanity: DEFINER deve ser o modifier logo após CREATE.
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

    // Consome valor, respeitando ` " ' com escape duplicado.
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
    // Trim ws após o valor removido.
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

        let cols: Vec<String> = batch
            .columns
            .iter()
            .map(|c| target.quote_ident(c))
            .collect();
        // complete_inserts: inclui a lista de colunas no INSERT (recomendado).
        // !complete_inserts: omite. Posição-dependente, só funciona se
        // a ordem de colunas no destino for idêntica à origem.
        // Prepend session_prelude pra garantir FK_CHECKS=0 na MESMA conn.
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
            // Multi-row: monta INSERTs respeitando max_statement_size_kb.
            let mut buf = String::with_capacity(max_bytes.min(4 * 1024 * 1024));
            buf.push_str(&prefix);
            let mut rows_in_buf = 0u64;

            for row in &batch.rows {
                let parts: Vec<String> =
                    row.iter().map(|v| sql_literal_opts(v, opts.hex_blob)).collect();
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
            // One INSERT per row. Mais lento mas pode ajudar com triggers
            // que esperam 1 row por vez ou pra debug.
            for row in &batch.rows {
                let parts: Vec<String> =
                    row.iter().map(|v| sql_literal_opts(v, opts.hex_blob)).collect();
                let sql = format!("{}({})", prefix, parts.join(", "));
                target
                    .execute(Some(&opts.target_schema), &sql)
                    .await
                    .map_err(|e| format!("insert {}: {}", table, e))?;
            }
        }

        let n = batch.rows.len() as u64;
        transferred += n;
        // Próxima chave/offset.
        if let Some(col) = keyset_col {
            // Pega o valor do último PK nesse batch.
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

        // Monta próximo SELECT.
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

/// Split intra-tabela: divide o range [MIN(pk), MAX(pk)] em N faixas
/// e copia cada uma em paralelo. Exige PK inteira (mesma condição do
/// keyset). Cada worker tem sua própria conexão no pool; pra evitar
/// que a orquestradora segure lock/tx que bloqueariam os workers,
/// lock_target e use_transaction são desligados neste modo pelo
/// chamador (ver `eff_lock_target`, `eff_use_tx` em `transfer_one`).
///
/// Limitação: atomicidade por-tabela é perdida — cada worker faz
/// auto-commit dos seus INSERTs. Falha parcial é visível parcialmente
/// no destino. Esse trade-off é explicitamente o que o usuário escolhe
/// ao ligar `intra_table_workers > 1`.
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
) -> Result<u64, String> {
    // 1. MIN/MAX da PK pra saber o range total.
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
            // Fallback: run_table_copy não-particionado
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
            )
            .await;
        }
    };
    if min_i >= max_i {
        // Só 1 valor — não vale particionar.
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
        )
        .await;
    }

    // 2. Divide [min, max+1) em N faixas aproximadamente iguais por valor.
    // (não por distribuição — assume PK uniformemente distribuída)
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
            )
            .await;
            // Emit final — finished=true com done/erro do worker.
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

/// Converte Value::Int/UInt/Decimal pra i128 se possível. Usado pra
/// calcular range de PK. Decimal vem de MIN/MAX em colunas bigint
/// unsigned via sqlx em alguns casos.
fn value_to_i128(v: &basemaster_core::Value) -> Option<i128> {
    use basemaster_core::Value;
    match v {
        Value::Int(i) => Some(*i as i128),
        Value::UInt(u) => Some(*u as i128),
        Value::Decimal(d) => d.to_string().parse().ok(),
        _ => None,
    }
}

/// Worker de uma faixa de PK: replica o loop de run_table_copy mas com
/// `WHERE pk >= low AND pk < high` fixado. Emite progresso somando ao
/// contador global.
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
) -> Result<u64, String> {
    use std::sync::atomic::Ordering;
    let qi = |s: &str| source.quote_ident(s);
    let verb = match opts.insert_mode {
        InsertMode::Insert => "INSERT INTO",
        InsertMode::InsertIgnore => "INSERT IGNORE INTO",
        InsertMode::Replace => "REPLACE INTO",
    };

    // Emit inicial — front desenha o slot do worker imediatamente.
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

        let cols: Vec<String> = batch
            .columns
            .iter()
            .map(|c| target.quote_ident(c))
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
                let parts: Vec<String> =
                    row.iter().map(|v| sql_literal_opts(v, opts.hex_blob)).collect();
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
                let parts: Vec<String> =
                    row.iter().map(|v| sql_literal_opts(v, opts.hex_blob)).collect();
                let sql = format!("{}({})", prefix, parts.join(", "));
                target
                    .execute(Some(&opts.target_schema), &sql)
                    .await
                    .map_err(|e| format!("insert {}: {}", table, e))?;
            }
        }

        let n = batch.rows.len() as u64;
        transferred += n;

        // Atualiza contador global e emite progresso agregado.
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

        // Emit por-worker — permite drill-down no UI por faixa.
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

        // Próxima chave: último PK do batch.
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

/// Descobre uma coluna de PK inteira única pra keyset pagination.
/// Retorna None se tabela não tem PK, tem PK composta, ou PK não-inteira
/// (caímos em OFFSET pagination nesses casos).
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
    // Aceita tipos ordenáveis comuns. Strings também funcionam mas são
    // mais lentas — por enquanto só inteiros.
    match &pk.column_type {
        basemaster_core::ColumnType::Integer { .. } => Some(pk.name.clone()),
        _ => None,
    }
}

/// Versão com flag pra BLOB: true = hex (`0xFF...`, seguro e canônico),
/// false = string-escape (`'\x00...'`, pode corromper em certas encodings).
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

/// Formata um `Value` como literal SQL. V1 — deixa para V1.1 a versão
/// via bind parametrizado no driver (precisão de tipos, BLOBs corretos).
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
