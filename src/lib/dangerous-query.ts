/**
 * Detects UPDATE / DELETE statements that don't have a WHERE clause —
 * the classic footgun that wipes a whole table by accident.
 *
 * The parser is intentionally rough: it splits on `;` (respecting
 * strings and identifiers), strips line and block comments, then checks
 * the leading keyword and whether `WHERE` appears anywhere. False
 * positives (nested WHERE only in a subquery) aren't flagged — devs
 * writing such queries generally know what they're doing. False
 * negatives (missed risky UPDATE/DELETE) are the scary case, so we err
 * toward being strict on simple-shape statements.
 */

export interface DangerousStatement {
  /** 0-based index of the statement in the input SQL. */
  index: number;
  /** "UPDATE" | "DELETE". */
  kind: "UPDATE" | "DELETE";
  /** Target table identifier if we can extract one; `null` otherwise. */
  table: string | null;
  /** Original raw statement text (including whitespace), for display. */
  sql: string;
}

/** Splits SQL into statements on top-level semicolons. Quote-aware
 *  for `'...'`, `"..."`, and backtick identifiers. Block comments and
 *  line comments are tracked so `;` inside them doesn't split. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // Line comment: -- ... \n
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        current += sql[i++];
      }
      continue;
    }
    // Block comment: /* ... */
    if (c === "/" && sql[i + 1] === "*") {
      current += sql[i++];
      current += sql[i++];
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        current += sql[i++];
      }
      if (i < n) {
        current += sql[i++];
        current += sql[i++];
      }
      continue;
    }
    // String literal or quoted identifier — consume until closing quote,
    // respecting doubled-quote escapes (`''` inside `'...'`).
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      current += sql[i++];
      while (i < n) {
        if (sql[i] === quote) {
          current += sql[i++];
          if (sql[i] === quote) {
            // doubled quote escape
            current += sql[i++];
            continue;
          }
          break;
        }
        if (sql[i] === "\\" && quote !== "`") {
          current += sql[i++];
          if (i < n) current += sql[i++];
          continue;
        }
        current += sql[i++];
      }
      continue;
    }
    if (c === ";") {
      if (current.trim().length > 0) out.push(current);
      current = "";
      i++;
      continue;
    }
    current += sql[i++];
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

/** Strip comments from `sql` so subsequent keyword scans see only code. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < n) i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += sql[i++];
      while (i < n) {
        if (sql[i] === quote) {
          out += sql[i++];
          if (sql[i] === quote) {
            out += sql[i++];
            continue;
          }
          break;
        }
        if (sql[i] === "\\" && quote !== "`") {
          out += sql[i++];
          if (i < n) out += sql[i++];
          continue;
        }
        out += sql[i++];
      }
      continue;
    }
    out += sql[i++];
  }
  return out;
}

export function detectDangerousStatements(sql: string): DangerousStatement[] {
  const statements = splitStatements(sql);
  const risky: DangerousStatement[] = [];
  statements.forEach((raw, index) => {
    const stripped = stripComments(raw).trim();
    if (!stripped) return;

    const leading = stripped.match(/^\s*(UPDATE|DELETE)\b/i);
    if (!leading) return;

    const kind = leading[1].toUpperCase() as "UPDATE" | "DELETE";
    // Simple check: any WHERE anywhere. Subquery-only WHERE is a known
    // false-negative escape hatch documented at module level.
    if (/\bWHERE\b/i.test(stripped)) return;

    const table = extractTable(kind, stripped);
    risky.push({ index, kind, table, sql: raw.trim() });
  });
  return risky;
}

function extractTable(
  kind: "UPDATE" | "DELETE",
  stripped: string,
): string | null {
  if (kind === "UPDATE") {
    const m = stripped.match(/^\s*UPDATE\s+([`"\w.]+)/i);
    return m ? cleanIdent(m[1]) : null;
  }
  // DELETE FROM <table>  |  DELETE <alias> FROM <table>
  const m =
    stripped.match(/^\s*DELETE\s+FROM\s+([`"\w.]+)/i) ||
    stripped.match(/^\s*DELETE\s+[`"\w.]+\s+FROM\s+([`"\w.]+)/i);
  return m ? cleanIdent(m[1]) : null;
}

function cleanIdent(raw: string): string {
  return raw.replace(/[`"]/g, "");
}
