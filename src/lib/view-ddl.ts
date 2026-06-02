import { ipc } from "@/lib/ipc";
import type { Value } from "@/lib/types";

/** Best-effort coercion of a result cell to a UTF-8 string. SHOW CREATE VIEW
 *  on MySQL can come back as bytes when the connection charset is binary. */
function cellToString(v: Value | undefined): string {
  if (!v) return "";
  switch (v.type) {
    case "string":
    case "decimal":
    case "date":
    case "time":
    case "date_time":
    case "timestamp":
      return v.value;
    case "bytes":
      return new TextDecoder().decode(new Uint8Array(v.value));
    default:
      return "";
  }
}

function qIdent(name: string, driver: string): string {
  if (driver === "postgres" || driver === "sqlite") {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Fetches a view's definition and returns a re-runnable editing statement
 *  (CREATE OR REPLACE for MySQL/PG, DROP + CREATE for SQLite). Throws if the
 *  view definition can't be retrieved. */
export async function fetchEditViewSql(
  connectionId: string,
  driver: string,
  schema: string,
  view: string,
): Promise<string> {
  const qiSchema = qIdent(schema, driver);
  const qiView = qIdent(view, driver);

  if (driver === "mysql" || driver === "mariadb") {
    const batch = await ipc.db.runQuery(
      connectionId,
      `SHOW CREATE VIEW ${qiSchema}.${qiView}`,
      schema,
    );
    const res = batch.results[0];
    if (!res || res.kind !== "select") {
      throw new Error(res?.kind === "error" ? res.message : "no result");
    }
    const idx = res.columns.findIndex((c) => c.toLowerCase() === "create view");
    const stmt = cellToString(res.rows[0]?.[idx === -1 ? 1 : idx]);
    // Strip DEFINER so the statement survives across different users, and make
    // it idempotent so the edit can be re-applied without a manual DROP.
    return stmt
      .replace(/DEFINER=`[^`]*`@`[^`]*`\s*/i, "")
      .replace(/^CREATE\s+(?!OR REPLACE)/i, "CREATE OR REPLACE ");
  }

  if (driver === "postgres") {
    const batch = await ipc.db.runQuery(
      connectionId,
      `SELECT pg_get_viewdef('${qiSchema}.${qiView}'::regclass, true) AS def`,
      schema,
    );
    const res = batch.results[0];
    if (!res || res.kind !== "select") {
      throw new Error(res?.kind === "error" ? res.message : "no result");
    }
    const body = cellToString(res.rows[0]?.[0]).trim();
    return `CREATE OR REPLACE VIEW ${qiSchema}.${qiView} AS\n${body}`;
  }

  // SQLite: full CREATE VIEW lives in sqlite_master. No CREATE OR REPLACE, so
  // emit a DROP first to keep the edit re-runnable.
  const batch = await ipc.db.runQuery(
    connectionId,
    `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = '${view.replace(/'/g, "''")}'`,
    schema,
  );
  const res = batch.results[0];
  if (!res || res.kind !== "select") {
    throw new Error(res?.kind === "error" ? res.message : "no result");
  }
  const stmt = cellToString(res.rows[0]?.[0]).trim();
  return `DROP VIEW IF EXISTS ${qiView};\n${stmt};`;
}
