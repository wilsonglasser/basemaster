/** Read-only SQL enforcement for the AI agent's read tools.
 *
 *  The agent's safety model is "writes require user approval". Read tools
 *  (`run_select`, `explain`) hand raw model-authored SQL straight to the
 *  driver, which runs it via the text protocol — so a naive prefix check is
 *  not enough. Three ways a "read" smuggles a write past approval:
 *    1. multi-statement:  `SELECT 1; DROP TABLE users`
 *    2. CTE write (pg):   `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`
 *    3. EXPLAIN ANALYZE:  actually executes the wrapped statement
 *  This module blocks all three by scanning literal-stripped SQL. */

/** Statements allowed to START a read query. */
const READ_ONLY_START = /^\s*(select|show|explain|describe|desc|with|table|values)\b/i;

/** Data-modifying keywords that must not appear anywhere in a read query.
 *  `analyze` is intentionally absent — it collides with EXPLAIN ANALYZE and is
 *  unreachable as a standalone statement (fails the start-keyword gate). */
const WRITE_KEYWORD =
  /\b(insert|update|delete|drop|alter|create|truncate|replace|merge|upsert|grant|revoke|rename|call|copy|load|into|attach|detach|vacuum|reindex|cluster|comment|prepare|deallocate|execute|exec|begin|commit|rollback|savepoint|lock|unlock|set)\b/i;

/** Removes string literals, quoted identifiers, dollar-quoted bodies and
 *  comments, replacing each with a space. Keyword/`;` scanning then can't be
 *  fooled by data (`WHERE status = 'delete;drop'`) or identifiers (`"delete"`). */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // line comment  -- ... \n
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // block comment  /* ... */
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // single-quoted string (with '' escape)
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += " ";
      continue;
    }
    // double-quoted identifier (with "" escape)
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      out += " ";
      continue;
    }
    // backtick identifier (MySQL)
    if (c === "`") {
      i++;
      while (i < n && sql[i] !== "`") i++;
      i++;
      out += " ";
      continue;
    }
    // dollar-quoted string (Postgres):  $tag$ ... $tag$
    if (c === "$") {
      const m = /^\$([a-zA-Z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Throws if `sql` contains more than one statement (a `;` with anything but
 *  whitespace after it). A single trailing `;` is fine. */
export function assertSingleStatement(sql: string): void {
  const stripped = stripSqlLiterals(sql);
  const semi = stripped.indexOf(";");
  if (semi >= 0 && stripped.slice(semi + 1).trim().length > 0) {
    throw new Error(
      "multi-statement SQL is not allowed here (found ';'). Run one statement at a time; use run_write_sql for changes.",
    );
  }
}

/** Throws unless `sql` is a single, genuinely read-only statement.
 *  Guards `run_select` and (when analyze=true) `explain`. */
export function assertReadOnlySql(sql: string): void {
  const stripped = stripSqlLiterals(sql);

  const semi = stripped.indexOf(";");
  if (semi >= 0 && stripped.slice(semi + 1).trim().length > 0) {
    throw new Error(
      "multi-statement SQL is not allowed here (found ';'). Run one statement at a time; use run_write_sql for changes.",
    );
  }
  if (!READ_ONLY_START.test(stripped)) {
    throw new Error(
      "only read-only SQL (SELECT/SHOW/EXPLAIN/DESCRIBE/WITH/TABLE/VALUES) is allowed here. Use run_write_sql for changes.",
    );
  }
  const m = WRITE_KEYWORD.exec(stripped);
  if (m) {
    throw new Error(
      `data-modifying keyword "${m[1].toUpperCase()}" is not allowed in a read-only query (e.g. CTE writes, SELECT ... INTO, EXPLAIN ANALYZE <write>). Use run_write_sql with a purpose so the user can approve it.`,
    );
  }
}
