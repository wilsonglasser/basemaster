//! SQL Import V1 — runs a `.sql` (or `.zip` with multiple `.sql`s) on
//! the target. Respects strings, comments, and the `DELIMITER` directive
//! common in dumps with triggers/procedures.
//!
//! Events:
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
    let mut total_stmts: u64 = 0;
    let mut total_errs: u32 = 0;

    // Read the file — if it's a ZIP, process each entry in alphabetical order;
    // if it's a SQL, process directly.
    let path = std::path::PathBuf::from(&opts.path);
    let is_zip = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    // Session prelude — prepended to EVERY statement to ensure the
    // SETs apply on the SAME connection that runs the DDL/DML. The sqlx
    // pool may hand out different conns between execute()s, so a lone
    // initial `SET FOREIGN_KEY_CHECKS=0` isn't enough.
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

    // Initial USE schema, if given — also prepend to the prelude.
    if let Some(ref schema) = opts.schema {
        if !schema.is_empty() {
            session_prelude.push_str(&format!(
                "USE {}; ",
                target.quote_ident(schema)
            ));
        }
    }

    if is_zip {
        // Extract all .sql entries into (name, content) BEFORE any await —
        // `ZipFile` isn't `Send`. This loads everything in memory; for
        // huge dumps, V2 can stream per-entry with a temp-file.
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

/// Naive but reasonable splitter: respects single/double quotes,
/// backticks, line comments `-- ...` and block `/* ... */`, and the
/// `DELIMITER xxx` directive that mysqldump uses on triggers/procedures.
fn split_statements(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::with_capacity(256);
    let mut delim: String = ";".to_string();
    let bytes = src.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();

    while i < len {
        let b = bytes[i];

        // DELIMITER directive — case-insensitive, at the start of the line
        // (allowing whitespace before).
        if (buf.is_empty() || buf.ends_with('\n'))
            && at_word_ci(bytes, i, b"DELIMITER")
        {
            // Advance past DELIMITER.
            i += 9;
            // Skip whitespace.
            while i < len && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            // Read until EOL.
            let mut new_delim = String::new();
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                new_delim.push(bytes[i] as char);
                i += 1;
            }
            let new_delim = new_delim.trim().to_string();
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
                    // Doubled = escape (MySQL ANSI). Keep.
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

        // Delimiter match — end of statement.
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

    // Leftovers.
    let tail = buf.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
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
