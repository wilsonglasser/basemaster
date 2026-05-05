import type {
  Filter,
  FilterNode,
  FilterOp,
  OrderBy,
  Value,
} from "@/lib/types";

type Dialect = "mysql" | "postgres" | "sqlite";

interface Options {
  dialect: Dialect;
  schema?: string | null;
  table: string;
  filterTree?: FilterNode | null;
  orderBy?: OrderBy | null;
  limit?: number;
  offset?: number;
}

/** Builds a literal SELECT mirroring what `select_table_page` would run on
 *  the backend. Used to seed the "Edit query" tab; the user can re-run /
 *  edit it from there. Values are quoted inline (not parameterized) since
 *  we want a self-contained snippet, not a prepared statement. */
export function buildTablePageSql(opts: Options): string {
  const ident = identQuoter(opts.dialect);
  const qualified =
    opts.schema && opts.schema.length > 0
      ? `${ident(opts.schema)}.${ident(opts.table)}`
      : ident(opts.table);

  let sql = `SELECT * FROM ${qualified}`;
  const where = renderNode(opts.filterTree ?? null, opts.dialect);
  if (where) sql += `\nWHERE ${where}`;
  if (opts.orderBy) {
    const dir = opts.orderBy.direction === "asc" ? "ASC" : "DESC";
    sql += `\nORDER BY ${ident(opts.orderBy.column)} ${dir}`;
  }
  if (opts.limit && opts.limit > 0) {
    sql += `\nLIMIT ${opts.limit}`;
    if (opts.offset && opts.offset > 0) {
      sql += ` OFFSET ${opts.offset}`;
    }
  }
  return sql + ";";
}

function identQuoter(dialect: Dialect): (s: string) => string {
  if (dialect === "mysql") {
    return (s) => "`" + s.replace(/`/g, "``") + "`";
  }
  return (s) => '"' + s.replace(/"/g, '""') + '"';
}

function renderNode(
  node: FilterNode | null,
  dialect: Dialect,
): string | null {
  if (!node) return null;
  if (node.kind === "leaf") return renderLeaf(node.filter, dialect);
  const parts = node.children
    .map((c) => renderNode(c, dialect))
    .filter((s): s is string => s != null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const join = node.op === "and" ? " AND " : " OR ";
  return `(${parts.join(join)})`;
}

function renderLeaf(f: Filter, dialect: Dialect): string {
  const ident = identQuoter(dialect);
  const colRaw = ident(f.column);
  const ci = (f.case_insensitive ?? false) && supportsCi(f.op);
  const colCmp = ci ? `LOWER(${colRaw})` : colRaw;
  const wrap = (lit: string) => (ci ? `LOWER(${lit})` : lit);

  switch (f.op) {
    case "eq":
      return `${colCmp} = ${wrap(quoteValue(f.value, dialect))}`;
    case "not_eq":
      return `${colCmp} <> ${wrap(quoteValue(f.value, dialect))}`;
    case "gt":
      return `${colRaw} > ${quoteValue(f.value, dialect)}`;
    case "lt":
      return `${colRaw} < ${quoteValue(f.value, dialect)}`;
    case "gte":
      return `${colRaw} >= ${quoteValue(f.value, dialect)}`;
    case "lte":
      return `${colRaw} <= ${quoteValue(f.value, dialect)}`;
    case "contains":
    case "begins_with":
    case "ends_with": {
      const pat = likePattern(valueText(f.value), f.op, dialect);
      const kw = ci && dialect === "postgres" ? "ILIKE" : "LIKE";
      const left = ci && dialect !== "postgres" ? `LOWER(${colRaw})` : colRaw;
      return `${left} ${kw} ${pat}`;
    }
    case "not_contains":
    case "not_begins_with":
    case "not_ends_with": {
      const pat = likePattern(valueText(f.value), f.op, dialect);
      const kw = ci && dialect === "postgres" ? "NOT ILIKE" : "NOT LIKE";
      const left = ci && dialect !== "postgres" ? `LOWER(${colRaw})` : colRaw;
      return `${left} ${kw} ${pat}`;
    }
    case "is_null":
      return `${colRaw} IS NULL`;
    case "is_not_null":
      return `${colRaw} IS NOT NULL`;
    case "is_empty":
      return `${colRaw} = ''`;
    case "is_not_empty":
      return `${colRaw} <> ''`;
    case "between":
      return `${colRaw} BETWEEN ${quoteValue(f.value, dialect)} AND ${quoteValue(
        f.value2,
        dialect,
      )}`;
    case "not_between":
      return `${colRaw} NOT BETWEEN ${quoteValue(f.value, dialect)} AND ${quoteValue(
        f.value2,
        dialect,
      )}`;
    case "in":
      return inListClause(colCmp, ci, f, dialect, false);
    case "not_in":
      return inListClause(colCmp, ci, f, dialect, true);
    case "custom": {
      const frag = valueText(f.value);
      return `${colRaw} ${frag}`;
    }
  }
}

function supportsCi(op: FilterOp): boolean {
  switch (op) {
    case "eq":
    case "not_eq":
    case "contains":
    case "not_contains":
    case "begins_with":
    case "not_begins_with":
    case "ends_with":
    case "not_ends_with":
    case "in":
    case "not_in":
      return true;
    default:
      return false;
  }
}

function inListClause(
  col: string,
  ci: boolean,
  f: Filter,
  dialect: Dialect,
  not: boolean,
): string {
  const items = splitInCsv(valueText(f.value));
  if (items.length === 0) return not ? "1=1" : "1=0";
  const literals = items
    .map((it) => quoteString(it, dialect))
    .map((lit) => (ci ? `LOWER(${lit})` : lit));
  const kw = not ? "NOT IN" : "IN";
  return `${col} ${kw} (${literals.join(", ")})`;
}

function splitInCsv(text: string): string[] {
  return text
    .split(",")
    .map((p) => p.trim().replace(/^['"]|['"]$/g, ""))
    .filter((s) => s.length > 0);
}

function valueText(v: Value | null | undefined): string {
  if (!v || v.type === "null") return "";
  switch (v.type) {
    case "string":
    case "decimal":
    case "date":
    case "time":
    case "date_time":
    case "timestamp":
      return v.value;
    case "int":
    case "u_int":
    case "float":
      return String(v.value);
    case "bool":
      return v.value ? "1" : "0";
    default:
      return "";
  }
}

function quoteValue(
  v: Value | null | undefined,
  dialect: Dialect,
): string {
  if (!v || v.type === "null") return "NULL";
  switch (v.type) {
    case "int":
    case "u_int":
    case "float":
    case "decimal":
      return String(v.value);
    case "bool":
      return dialect === "postgres"
        ? v.value
          ? "TRUE"
          : "FALSE"
        : v.value
          ? "1"
          : "0";
    default:
      return quoteString(valueText(v), dialect);
  }
}

function quoteString(s: string, _dialect: Dialect): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function likePattern(raw: string, op: FilterOp, dialect: Dialect): string {
  // Mirrors backend escape: \ _ % become \\ \_ \%.
  const escaped = raw
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/%/g, "\\%");
  let pat: string;
  switch (op) {
    case "begins_with":
    case "not_begins_with":
      pat = `${escaped}%`;
      break;
    case "ends_with":
    case "not_ends_with":
      pat = `%${escaped}`;
      break;
    default:
      pat = `%${escaped}%`;
  }
  return quoteString(pat, dialect);
}
