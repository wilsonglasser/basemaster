//! SQL Import V1 — executa um `.sql` (ou `.zip` com vários `.sql`) no
//! destino. Respeita strings, comentários, e a diretiva `DELIMITER`
//! comum em dumps com triggers/procedures.
//!
//! Eventos:
//!   `sql_import:progress` — { statements_done, errors, current_source }
//!   `sql_import:stmt_error` — { index, sql, message }
//!   `sql_import:done` — { statements_done, errors, elapsed_ms }

use std::io::Read;
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
    /// Executa `USE schema;` antes de tudo, pra scripts que não
    /// qualificam names (`CREATE TABLE t` em vez de `db.t`).
    #[serde(default)]
    pub schema: Option<String>,
    /// Continua executando após erro — útil com dumps que têm statements
    /// já aplicados (ex: CREATE TABLE existente com DROP omitido).
    #[serde(default)]
    pub continue_on_error: bool,
    /// Emite `progress` a cada N statements (pra não afogar o event bus).
    #[serde(default = "default_emit_every")]
    pub emit_every: u32,
    /// Prepend FK_CHECKS=0 em cada statement. Crítico pra dumps com FKs
    /// porque sqlx pool pode devolver conns diferentes entre statements,
    /// o que invalida o `SET SESSION` global do header.
    #[serde(default = "default_true")]
    pub disable_fk_checks: bool,
    /// Prepend UNIQUE_CHECKS=0.
    #[serde(default = "default_true")]
    pub disable_unique_checks: bool,
    /// Prepend NO_AUTO_VALUE_ON_ZERO — preserva PK=0 em tabelas com
    /// AUTO_INCREMENT (mesmo default do mysqldump).
    #[serde(default = "default_true")]
    pub preserve_zero_auto_increment: bool,
}

fn default_true() -> bool {
    true
}

fn default_emit_every() -> u32 {
    50
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportProgress {
    pub statements_done: u64,
    pub errors: u32,
    /// Nome do arquivo sendo processado (útil em ZIP multi-entry).
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
    let mut total_stmts: u64 = 0;
    let mut total_errs: u32 = 0;

    // Lê o arquivo — se é ZIP, processa cada entry em ordem alfabética;
    // se é SQL, processa direto.
    let path = std::path::PathBuf::from(&opts.path);
    let is_zip = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    // Session prelude — prepended a CADA statement pra garantir que os
    // SETs valham na MESMA conexão que executa o DDL/DML. sqlx pool
    // pode devolver conns diferentes entre execute()s, então um `SET
    // FOREIGN_KEY_CHECKS=0` inicial sozinho não basta.
    let mut session_prelude = String::new();
    if opts.disable_fk_checks {
        session_prelude.push_str("SET FOREIGN_KEY_CHECKS=0; ");
    }
    if opts.disable_unique_checks {
        session_prelude.push_str("SET UNIQUE_CHECKS=0; ");
    }
    if opts.preserve_zero_auto_increment {
        session_prelude.push_str(
            "SET sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO'); ",
        );
    }

    // USE schema inicial, se dado — também prependa ao prelude.
    if let Some(ref schema) = opts.schema {
        if !schema.is_empty() {
            session_prelude.push_str(&format!(
                "USE {}; ",
                target.quote_ident(schema)
            ));
        }
    }

    if is_zip {
        // Extrai todas as entries .sql pra (name, content) ANTES de qualquer
        // await — `ZipFile` não é `Send`. Isso carrega tudo em memória; pra
        // dumps gigantes, V2 pode streamar por entry com temp-file.
        let entries: Vec<(String, String)> = {
            let f = std::fs::File::open(&path)
                .map_err(|e| format!("abrir zip: {}", e))?;
            let mut zip = zip::ZipArchive::new(f)
                .map_err(|e| format!("ler zip: {}", e))?;
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
            out
        };
        for (name, content) in entries {
            if !control.check().await {
                break;
            }
            process_sql(
                &app,
                &opts,
                &*target,
                &control,
                &content,
                &name,
                &session_prelude,
                &mut total_stmts,
                &mut total_errs,
            )
            .await?;
        }
    } else {
        let buf = std::fs::read_to_string(&path)
            .map_err(|e| format!("abrir arquivo: {}", e))?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("dump.sql")
            .to_string();
        process_sql(
            &app,
            &opts,
            &*target,
            &control,
            &buf,
            &name,
            &session_prelude,
            &mut total_stmts,
            &mut total_errs,
        )
        .await?;
    }

    let done = ImportDone {
        statements_done: total_stmts,
        errors: total_errs,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let _ = app.emit("sql_import:done", &done);
    Ok(done)
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
    // Detecta dialeto do arquivo de uma vez (mais barato que per-stmt).
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
        // Traduz se source != target. Se dialect indetectável, pass-through.
        let translated: String = if needs_translate {
            normalize_for(trimmed, source_dialect, target_dialect)
        } else {
            trimmed.to_string()
        };
        let final_sql = translated.trim();
        if final_sql.is_empty() {
            continue;
        }
        // Skipa statements que são sabidamente incompatíveis com o target
        // e não têm análogo (ex: LOCK TABLES em PG). Não conta como erro.
        if should_skip_for_target(final_sql, target_dialect) {
            continue;
        }
        *total_stmts += 1;
        // Prepend prelude só se o target é MySQL — os SETs são MySQL-only.
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
        if *total_stmts % opts.emit_every as u64 == 0 {
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
    // Emit final pra esse source.
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

/// Splitter naive mas razoável: respeita aspas simples/duplas,
/// backticks, comentários de linha `-- ...` e bloco `/* ... */`, e a
/// diretiva `DELIMITER xxx` que mysqldump usa em triggers/procedures.
fn split_statements(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::with_capacity(256);
    let mut delim: String = ";".to_string();
    let bytes = src.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();

    while i < len {
        let b = bytes[i];

        // DELIMITER directive — case-insensitive, no início da linha
        // (permitindo whitespace antes).
        if (buf.is_empty() || buf.ends_with('\n'))
            && at_word_ci(bytes, i, b"DELIMITER")
        {
            // Avança pra depois de DELIMITER.
            i += 9;
            // Skip whitespace.
            while i < len && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            // Lê até EOL.
            let mut new_delim = String::new();
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                new_delim.push(bytes[i] as char);
                i += 1;
            }
            let new_delim = new_delim.trim().to_string();
            if !new_delim.is_empty() {
                delim = new_delim;
            }
            // Consome newline.
            while i < len && (bytes[i] == b'\n' || bytes[i] == b'\r') {
                i += 1;
            }
            continue;
        }

        // Comentário de linha.
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

        // Comentário de bloco.
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

        // String / identificador aspeado — consome até o fechamento.
        if b == b'\'' || b == b'"' || b == b'`' {
            let quote = b;
            buf.push(b as char);
            i += 1;
            while i < len {
                let c = bytes[i];
                if c == b'\\' && i + 1 < len {
                    // Backslash-escape (\' \" \\ etc).
                    buf.push(c as char);
                    buf.push(bytes[i + 1] as char);
                    i += 2;
                    continue;
                }
                if c == quote {
                    // Duplicado = escape (MySQL ANSI). Mantém.
                    if i + 1 < len && bytes[i + 1] == quote {
                        buf.push(c as char);
                        buf.push(c as char);
                        i += 2;
                        continue;
                    }
                    buf.push(c as char);
                    i += 1;
                    break;
                }
                buf.push(c as char);
                i += 1;
            }
            continue;
        }

        // Delimiter match — fim de statement.
        if at_str(bytes, i, delim.as_bytes()) {
            let stmt = buf.trim();
            if !stmt.is_empty() {
                out.push(stmt.to_string());
            }
            buf.clear();
            i += delim.len();
            continue;
        }

        buf.push(b as char);
        i += 1;
    }

    // Sobras.
    let tail = buf.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
    out
}

/// Skipa statements que são claramente incompatíveis com o target e não
/// têm análogo trivial — silencioso, não conta como erro. Previne erro
/// "Unknown command" que só polui a UI.
fn should_skip_for_target(stmt: &str, target: Dialect) -> bool {
    let upper = stmt.trim_start().to_uppercase();
    match target {
        Dialect::Postgres => {
            // Statements MySQL que sobraram sem análogo em PG.
            upper.starts_with("DELIMITER ")
                || upper.starts_with("LOCK TABLES")
                || upper.starts_with("UNLOCK TABLES")
                || upper.starts_with("ALTER DATABASE") // charset/collation MySQL
                || upper.starts_with("ANALYZE TABLE")
                || upper.starts_with("OPTIMIZE TABLE")
                || upper.starts_with("CHECK TABLE")
                || upper.starts_with("REPAIR TABLE")
                || upper.starts_with("FLUSH ")
                || upper.starts_with("USE ") // USE não existe em PG (search_path já setado)
                || (upper.starts_with("SET ")
                    && (upper.contains("FOREIGN_KEY_CHECKS")
                        || upper.contains("UNIQUE_CHECKS")
                        || upper.contains("SQL_LOG_BIN")
                        || upper.contains("SQL_MODE")
                        || upper.contains("@@SESSION")
                        || upper.contains("SQL_NOTES")))
        }
        Dialect::Mysql => {
            // Statements PG que não rodam em MySQL.
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

/// Detecta SETs globais que o nosso prelude já vai aplicar por-statement,
/// pra evitar rodar 2x (inofensivo, mas ruído e lento). Match heurístico
/// via contém.
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
    // Delimitador após a palavra — próximo byte não pode ser alfanum.
    if i + needle.len() < bytes.len() {
        let next = bytes[i + needle.len()];
        if next.is_ascii_alphanumeric() || next == b'_' {
            return false;
        }
    }
    true
}
