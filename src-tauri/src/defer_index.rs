//! Defer secondary indexes — splits non-essential indexes out of a CREATE
//! TABLE so they can be built AFTER the bulk load instead of being maintained
//! row-by-row during it.
//!
//! On InnoDB (and Postgres) building a secondary index in one pass over the
//! already-loaded table (sorted build) is far cheaper than the per-row B-tree
//! maintenance an inline index pays during `INSERT`. `FOREIGN_KEY_CHECKS=0`
//! already removes the FK cost during transfer/import; this removes the
//! secondary-index cost, the other half of the load-time write amplification.
//!
//! What stays inline (never deferred):
//!   - PRIMARY KEY — clustered; keyset pagination depends on it.
//!   - UNIQUE — deferring changes validation semantics, and it can back an FK.
//!   - FOREIGN KEY / CONSTRAINT — and any plain KEY that backs an FK (MySQL
//!     auto-creates a backing index for an inline FK, so deferring that KEY
//!     would leave a redundant duplicate).
//!
//! What gets deferred:
//!   - Plain `KEY`/`INDEX`/`FULLTEXT`/`SPATIAL` (MySQL, inline) → one combined
//!     `ALTER TABLE ... ADD ...` run after load.
//!   - `CREATE INDEX ...` statements that Postgres' DDL builder appends after
//!     the table (already separate; we just peel them off to run them later).
//!
//! Same-dialect only. Cross-dialect DDL is rewritten by `sql_translate`, which
//! already strips MySQL inline KEY lines, so there is nothing here to defer.

use basemaster_core::{ForeignKeyInfo, IndexInfo};

use crate::sql_translate::Dialect;

/// Result of splitting a CREATE TABLE DDL.
pub struct Split {
    /// CREATE statement to run BEFORE the load (table minus deferred indexes).
    pub create: String,
    /// Ready-to-run statements to execute AFTER the load. For MySQL this is a
    /// single combined `ALTER TABLE ... ADD ...`; for Postgres one entry per
    /// `CREATE INDEX`. Empty when nothing could be deferred.
    pub deferred: Vec<String>,
}

/// Splits secondary indexes out of `ddl` (same-dialect path). `table_ident` is
/// the already-quoted UNQUALIFIED table name (e.g. `` `t` ``), used to build
/// the MySQL `ALTER TABLE` — unqualified so the statement resolves against
/// whatever schema context (`USE`/search_path) the load runs in, matching the
/// unqualified `CREATE TABLE` that `SHOW CREATE TABLE` returns.
///
/// On any uncertainty the DDL is returned untouched (`deferred` empty) — a
/// safe no-op that keeps the inline-index behavior.
pub fn split(ddl: &str, dialect: Dialect, table_ident: &str) -> Split {
    match dialect {
        Dialect::Mysql => split_mysql(ddl, table_ident),
        Dialect::Postgres => split_postgres(ddl),
        Dialect::Unknown => Split {
            create: ddl.to_string(),
            deferred: Vec::new(),
        },
    }
}

/// Cross-dialect path: the DDL translator drops MySQL inline `KEY` lines, so
/// without this the secondary indexes would be lost on a MySQL→Postgres copy.
/// Rebuilds them as `CREATE INDEX` in the `target` dialect from the source
/// table's structured index list. Skips PRIMARY, UNIQUE (handled inline by the
/// table translation), and FULLTEXT/SPATIAL/GIN/GiST (no clean cross-dialect
/// mapping). When the target is MySQL, also skips any index that backs an FK
/// (MySQL auto-creates that backing index for the inline constraint).
///
/// `schema`/`table` are raw (unquoted); the statements are schema-qualified in
/// the target dialect so they are unambiguous regardless of session context.
pub fn deferred_for_target(
    indexes: &[IndexInfo],
    fks: &[ForeignKeyInfo],
    target: Dialect,
    schema: &str,
    table: &str,
) -> Vec<String> {
    let qi = ident_quoter(target);
    let qt = format!("{}.{}", qi(schema), qi(table));
    let fk_cols: Vec<&[String]> = fks.iter().map(|f| f.columns.as_slice()).collect();
    let mut out = Vec::new();
    for ix in indexes {
        if ix.is_primary || ix.unique || ix.columns.is_empty() {
            continue;
        }
        if is_special_index_type(ix.index_type.as_deref()) {
            continue;
        }
        if target == Dialect::Mysql && cols_back_fk(&ix.columns, &fk_cols) {
            continue;
        }
        let cols = ix
            .columns
            .iter()
            .map(|c| qi(c))
            .collect::<Vec<_>>()
            .join(", ");
        // `CREATE INDEX` is accepted by both dialects. Index names are kept
        // as-is; a clash on the target (MySQL names are table-scoped, Postgres
        // schema-scoped) surfaces as a soft per-statement error at run time.
        out.push(format!("CREATE INDEX {} ON {} ({});", qi(&ix.name), qt, cols));
    }
    out
}

fn ident_quoter(d: Dialect) -> fn(&str) -> String {
    match d {
        Dialect::Postgres => |s: &str| format!("\"{}\"", s.replace('"', "\"\"")),
        _ => |s: &str| format!("`{}`", s.replace('`', "``")),
    }
}

/// FULLTEXT/SPATIAL (MySQL) and GIN/GiST/BRIN (Postgres) have no clean
/// cross-dialect equivalent, so they are dropped rather than mistranslated.
fn is_special_index_type(t: Option<&str>) -> bool {
    let Some(t) = t else { return false };
    let t = t.to_ascii_lowercase();
    t.contains("fulltext")
        || t.contains("spatial")
        || t.contains("gin")
        || t.contains("gist")
        || t.contains("brin")
}

fn cols_back_fk(cols: &[String], fk_cols: &[&[String]]) -> bool {
    fk_cols
        .iter()
        .any(|fk| !fk.is_empty() && cols.len() >= fk.len() && &cols[..fk.len()] == *fk)
}

// ----------------------------------------------------------------- MySQL

fn split_mysql(ddl: &str, table_ident: &str) -> Split {
    let no_op = || Split {
        create: ddl.to_string(),
        deferred: Vec::new(),
    };
    let Some((open, close)) = outer_parens(ddl) else {
        return no_op();
    };
    let body = &ddl[open + 1..close];
    let items = split_top_level(body);
    if items.is_empty() {
        return no_op();
    }

    // FK column-lists drive the "is this KEY backing an FK?" check.
    let fk_cols: Vec<Vec<String>> = items
        .iter()
        .filter(|it| {
            let u = it.trim_start().to_ascii_uppercase();
            u.starts_with("CONSTRAINT") || u.starts_with("FOREIGN KEY")
        })
        .filter(|it| it.to_ascii_uppercase().contains("FOREIGN KEY"))
        .filter_map(|it| index_columns(it))
        .collect();

    let mut kept: Vec<String> = Vec::with_capacity(items.len());
    let mut defer: Vec<String> = Vec::new();
    for it in &items {
        if is_deferrable_key(it) && !backs_fk(it, &fk_cols) {
            defer.push(format!("ADD {}", it.trim()));
        } else {
            kept.push(it.trim().to_string());
        }
    }

    if defer.is_empty() {
        return no_op();
    }

    let prefix = &ddl[..=open];
    let suffix = &ddl[close..]; // ")" + table options + trailing ";"
    let create = format!("{}\n  {}\n{}", prefix, kept.join(",\n  "), suffix);
    let alter = format!("ALTER TABLE {} {};", table_ident, defer.join(", "));
    Split {
        create,
        deferred: vec![alter],
    }
}

/// Whether an item is a plain secondary index that may be deferred: KEY,
/// INDEX, FULLTEXT [KEY|INDEX], SPATIAL [KEY|INDEX]. Excludes PRIMARY/UNIQUE
/// KEY and CONSTRAINT/FOREIGN KEY.
fn is_deferrable_key(item: &str) -> bool {
    let u = item.trim_start().to_ascii_uppercase();
    if u.starts_with("PRIMARY")
        || u.starts_with("UNIQUE")
        || u.starts_with("CONSTRAINT")
        || u.starts_with("FOREIGN")
    {
        return false;
    }
    u.starts_with("KEY ")
        || u.starts_with("KEY(")
        || u.starts_with("INDEX ")
        || u.starts_with("INDEX(")
        || u.starts_with("FULLTEXT")
        || u.starts_with("SPATIAL")
}

/// True when this KEY's leftmost columns match an FK's columns (MySQL would
/// auto-create such an index for the FK, so deferring it makes a duplicate).
fn backs_fk(key_item: &str, fk_cols: &[Vec<String>]) -> bool {
    let Some(kcols) = index_columns(key_item) else {
        return false;
    };
    fk_cols.iter().any(|fk| {
        !fk.is_empty() && kcols.len() >= fk.len() && kcols[..fk.len()] == fk[..]
    })
}

/// Extracts the column names from the first `(...)` group of an index/FK item,
/// normalized (backticks/quotes/whitespace and any `(len)`/`ASC`/`DESC`
/// suffix stripped).
fn index_columns(item: &str) -> Option<Vec<String>> {
    let (o, c) = outer_parens(item)?;
    let inner = &item[o + 1..c];
    let cols = split_top_level(inner)
        .into_iter()
        .map(|c| normalize_col(&c))
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>();
    if cols.is_empty() {
        None
    } else {
        Some(cols)
    }
}

fn normalize_col(raw: &str) -> String {
    let mut s = raw.trim();
    // Drop a trailing prefix-length like `(191)` and ASC/DESC ordering.
    if let Some(p) = s.find('(') {
        s = s[..p].trim_end();
    }
    let lower = s.to_ascii_lowercase();
    for suf in [" asc", " desc"] {
        if lower.ends_with(suf) {
            s = s[..s.len() - suf.len()].trim_end();
            break;
        }
    }
    s.trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == ' ')
        .to_string()
}

// --------------------------------------------------------------- Postgres

fn split_postgres(ddl: &str) -> Split {
    // The PG DDL builder emits the table first, then any non-unique indexes as
    // standalone `CREATE INDEX ...;`. Peel those off to run after the load.
    let mut create_lines: Vec<&str> = Vec::new();
    let mut deferred: Vec<String> = Vec::new();
    let mut in_create_index = false;
    let mut buf = String::new();

    for line in ddl.lines() {
        let t = line.trim_start();
        if in_create_index || t.to_ascii_uppercase().starts_with("CREATE INDEX") {
            in_create_index = true;
            buf.push_str(line);
            buf.push('\n');
            if line.trim_end().ends_with(';') {
                deferred.push(buf.trim().to_string());
                buf.clear();
                in_create_index = false;
            }
            continue;
        }
        create_lines.push(line);
    }
    if !buf.trim().is_empty() {
        deferred.push(buf.trim().to_string());
    }

    if deferred.is_empty() {
        return Split {
            create: ddl.to_string(),
            deferred,
        };
    }
    Split {
        create: create_lines.join("\n").trim_end().to_string(),
        deferred,
    }
}

// ------------------------------------------------------------------ scan

/// Byte indices of the first top-level `(` and its matching `)`, quote/backtick
/// aware. `None` if unbalanced or absent.
fn outer_parens(sql: &str) -> Option<(usize, usize)> {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let len = bytes.len();
    let mut open: Option<usize> = None;
    let mut depth = 0i32;
    while i < len {
        let b = bytes[i];
        if b == b'\'' || b == b'"' || b == b'`' {
            i = skip_quoted(bytes, i);
            continue;
        }
        if b == b'(' {
            if open.is_none() {
                open = Some(i);
            }
            depth += 1;
        } else if b == b')' {
            depth -= 1;
            if depth == 0 {
                return open.map(|o| (o, i));
            }
        }
        i += 1;
    }
    None
}

/// Splits `body` on top-level commas (depth 0, quote/backtick aware).
fn split_top_level(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut items = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut i = 0usize;
    let len = bytes.len();
    while i < len {
        let b = bytes[i];
        if b == b'\'' || b == b'"' || b == b'`' {
            i = skip_quoted(bytes, i);
            continue;
        }
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                let part = body[start..i].trim();
                if !part.is_empty() {
                    items.push(part.to_string());
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    let part = body[start..].trim();
    if !part.is_empty() {
        items.push(part.to_string());
    }
    items
}

/// Given index `i` at an opening quote byte, returns the index just past the
/// closing quote, honoring backslash and doubled-quote escapes.
fn skip_quoted(bytes: &[u8], i: usize) -> usize {
    let quote = bytes[i];
    let len = bytes.len();
    let mut j = i + 1;
    while j < len {
        let c = bytes[j];
        if c == b'\\' && j + 1 < len {
            j += 2;
            continue;
        }
        if c == quote {
            if j + 1 < len && bytes[j + 1] == quote {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j += 1;
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "`t`";

    #[test]
    fn mysql_defers_plain_key_into_alter() {
        let ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `name` varchar(50) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_name` (`name`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;";
        let s = split(ddl, Dialect::Mysql, T);
        assert!(!s.create.to_uppercase().contains("KEY `IDX_NAME`".to_uppercase().as_str()));
        assert!(s.create.contains("PRIMARY KEY (`id`)"));
        assert_eq!(s.deferred.len(), 1);
        assert!(s.deferred[0].contains("ALTER TABLE `t` ADD KEY `idx_name` (`name`)"));
        assert!(s.create.contains("ENGINE=InnoDB"));
    }

    #[test]
    fn mysql_keeps_primary_and_unique_inline() {
        let ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `email` varchar(80) NOT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_email` (`email`)\n) ENGINE=InnoDB;";
        let s = split(ddl, Dialect::Mysql, T);
        // Nothing deferrable → untouched no-op.
        assert!(s.deferred.is_empty());
        assert!(s.create.contains("UNIQUE KEY `uq_email`"));
    }

    #[test]
    fn mysql_keeps_fk_backing_key_inline() {
        let ddl = "CREATE TABLE `o` (\n  `id` int NOT NULL,\n  `cust_id` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_cust` (`cust_id`),\n  KEY `idx_other` (`cust_id`,`id`),\n  CONSTRAINT `fk_cust` FOREIGN KEY (`cust_id`) REFERENCES `c` (`id`)\n) ENGINE=InnoDB;";
        let s = split(ddl, Dialect::Mysql, T);
        // `fk_cust` backs the FK (exact columns) → stays inline.
        assert!(s.create.contains("KEY `fk_cust` (`cust_id`)"));
        // `idx_other` has cust_id as a prefix of an FK col-list too → also kept
        // (leftmost-prefix rule), so nothing deferred here.
        assert!(s.create.contains("KEY `idx_other`"));
        assert!(s.deferred.is_empty());
    }

    #[test]
    fn mysql_defers_non_fk_key_but_keeps_fk_backing() {
        let ddl = "CREATE TABLE `o` (\n  `id` int NOT NULL,\n  `cust_id` int DEFAULT NULL,\n  `name` varchar(40) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_cust` (`cust_id`),\n  KEY `idx_name` (`name`),\n  CONSTRAINT `fk_cust` FOREIGN KEY (`cust_id`) REFERENCES `c` (`id`)\n) ENGINE=InnoDB;";
        let s = split(ddl, Dialect::Mysql, T);
        assert!(s.create.contains("KEY `fk_cust` (`cust_id`)"));
        assert!(!s.create.contains("`idx_name`"));
        assert_eq!(s.deferred.len(), 1);
        assert!(s.deferred[0].contains("ADD KEY `idx_name` (`name`)"));
    }

    #[test]
    fn mysql_combines_multiple_into_single_alter() {
        let ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `a` int DEFAULT NULL,\n  `b` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_a` (`a`),\n  KEY `idx_b` (`b`)\n) ENGINE=InnoDB;";
        let s = split(ddl, Dialect::Mysql, T);
        assert_eq!(s.deferred.len(), 1);
        assert!(s.deferred[0].contains("ADD KEY `idx_a` (`a`)"));
        assert!(s.deferred[0].contains("ADD KEY `idx_b` (`b`)"));
        // single ALTER, both ADDs comma-joined.
        assert_eq!(s.deferred[0].matches("ALTER TABLE").count(), 1);
    }

    #[test]
    fn mysql_no_panic_on_malformed_ddl() {
        let s = split("not a create table", Dialect::Mysql, T);
        assert!(s.deferred.is_empty());
        assert_eq!(s.create, "not a create table");
    }

    #[test]
    fn postgres_peels_create_index() {
        let ddl = "CREATE TABLE \"s\".\"t\" (\n  \"id\" INTEGER NOT NULL,\n  \"name\" TEXT,\n  PRIMARY KEY (\"id\")\n);\nCREATE INDEX \"idx_name\" ON \"s\".\"t\" (\"name\");\n";
        let s = split(ddl, Dialect::Postgres, "\"s\".\"t\"");
        assert!(s.create.contains("CREATE TABLE"));
        assert!(!s.create.to_uppercase().contains("CREATE INDEX"));
        assert_eq!(s.deferred.len(), 1);
        assert!(s.deferred[0].starts_with("CREATE INDEX \"idx_name\""));
    }

    #[test]
    fn postgres_no_indexes_is_noop() {
        let ddl = "CREATE TABLE \"s\".\"t\" (\n  \"id\" INTEGER NOT NULL,\n  PRIMARY KEY (\"id\")\n);\n";
        let s = split(ddl, Dialect::Postgres, "\"s\".\"t\"");
        assert!(s.deferred.is_empty());
        assert!(s.create.contains("CREATE TABLE"));
    }

    #[test]
    fn index_columns_strips_prefix_len_and_order() {
        assert_eq!(
            index_columns("KEY `idx` (`a`(191), `b` DESC)").unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    fn idx(name: &str, cols: &[&str], unique: bool, is_primary: bool) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            unique,
            is_primary,
            index_type: None,
        }
    }

    #[test]
    fn cross_dialect_reemits_secondary_as_create_index() {
        let indexes = vec![
            idx("PRIMARY", &["id"], true, true),
            idx("uq_email", &["email"], true, false),
            idx("idx_name", &["name"], false, false),
        ];
        let out = deferred_for_target(&indexes, &[], Dialect::Postgres, "s", "t");
        // PK + UNIQUE excluded; only the plain secondary index re-emitted.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "CREATE INDEX \"idx_name\" ON \"s\".\"t\" (\"name\");");
    }

    #[test]
    fn cross_dialect_skips_fk_backing_only_for_mysql_target() {
        let indexes = vec![idx("fk_c", &["cust_id"], false, false)];
        let fks = vec![ForeignKeyInfo {
            name: "fk_c".into(),
            columns: vec!["cust_id".into()],
            ref_schema: None,
            ref_table: "c".into(),
            ref_columns: vec!["id".into()],
            on_update: None,
            on_delete: None,
        }];
        // Postgres does NOT auto-index FK columns → keep (re-emit).
        assert_eq!(deferred_for_target(&indexes, &fks, Dialect::Postgres, "s", "t").len(), 1);
        // MySQL auto-creates the backing index → skip to avoid a duplicate.
        assert!(deferred_for_target(&indexes, &fks, Dialect::Mysql, "s", "t").is_empty());
    }

    #[test]
    fn outer_parens_ignores_parens_in_backticks() {
        let sql = "CREATE TABLE `t(x)` (`id` int)";
        let (o, c) = outer_parens(sql).unwrap();
        assert_eq!(&sql[o..=c], "(`id` int)");
    }
}
