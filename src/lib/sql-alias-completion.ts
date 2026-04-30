import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

import { statementAtCursor } from "./sql-statements";

/**
 * SQL words that can syntactically appear right after `FROM <table>` or
 * `JOIN <table>` and would otherwise be misread as an alias by our regex.
 * Anything in this set is rejected as an alias candidate.
 */
const NOT_ALIAS = new Set([
  "where",
  "group",
  "order",
  "limit",
  "having",
  "union",
  "intersect",
  "except",
  "on",
  "using",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "cross",
  "natural",
  "lateral",
  "select",
  "from",
  "into",
  "values",
  "set",
  "and",
  "or",
  "as",
  "when",
  "then",
  "else",
  "end",
  "case",
  "by",
  "desc",
  "asc",
  "not",
  "is",
  "null",
  "between",
  "in",
  "like",
  "exists",
  "for",
  "update",
  "delete",
  "returning",
  "with",
  "window",
  "partition",
  "over",
]);

function unquote(id: string): string {
  return id.replace(/^[`"]|[`"]$/g, "");
}

export interface AliasMap {
  /** Lowercased alias OR table name → real (case-preserved) table name. */
  byAlias: Map<string, string>;
}

/** Parses `FROM`/`JOIN` clauses out of a single SQL statement and builds
 *  a map alias→table. Unaliased tables map to themselves. Cross-schema
 *  references (`schema.table`) collapse to the table name; column lookup
 *  is per-table for now (current schema).
 */
export function parseTableAliases(stmt: string): AliasMap {
  const byAlias = new Map<string, string>();
  // Strip comments so a `-- FROM x y` line in a comment doesn't pollute.
  const cleaned = stmt
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const re =
    /\b(?:from|join)\s+(?:[`"]?\w+[`"]?\.)?([`"]?\w+[`"]?)(?:\s+(?:as\s+)?([`"]?\w+[`"]?))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const tableQuoted = m[1];
    const aliasQuoted = m[2];
    const table = unquote(tableQuoted);
    const tableLc = table.toLowerCase();
    if (NOT_ALIAS.has(tableLc)) continue;
    const aliasRaw = aliasQuoted ? unquote(aliasQuoted) : null;
    const aliasLc = aliasRaw?.toLowerCase() ?? null;
    if (aliasLc && !NOT_ALIAS.has(aliasLc)) {
      byAlias.set(aliasLc, table);
      // Also accept the table's own name unless another alias already claimed it.
      if (!byAlias.has(tableLc)) byAlias.set(tableLc, table);
    } else {
      byAlias.set(tableLc, table);
    }
  }
  return { byAlias };
}

/**
 * Autocomplete source that resolves `alias.col` (or `tableName.col`) to the
 * columns of the underlying table, by scanning the FROM/JOIN clauses of the
 * statement under the cursor.
 *
 * `getColumns(tableLowercase)` should return the column list for that table
 * : the caller owns the schema cache, so the source stays decoupled from
 * the schema data structure.
 */
export function aliasCompletionSource(
  getColumns: (tableLowercase: string) => string[] | undefined,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/[`"\w]+\.[\w]*/);
    if (!before) return null;
    const text = before.text;
    const dot = text.lastIndexOf(".");
    if (dot < 0) return null;
    const aliasPart = unquote(text.slice(0, dot)).toLowerCase();
    if (!aliasPart) return null;

    const docText = context.state.doc.toString();
    const seg = statementAtCursor(docText, context.pos);
    const stmt = seg?.sql ?? docText;
    const { byAlias } = parseTableAliases(stmt);
    const real = byAlias.get(aliasPart);
    if (!real) return null;
    const cols = getColumns(real.toLowerCase());
    if (!cols || cols.length === 0) return null;
    return {
      from: before.from + dot + 1,
      to: context.pos,
      options: cols.map((c) => ({ label: c, type: "property" })),
      validFor: /^\w*$/,
    };
  };
}
