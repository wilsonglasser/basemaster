/**
 * Generate maintenance SQL per driver. Each DBMS has its own
 * keywords: MySQL uses `OPTIMIZE/REPAIR/ANALYZE/CHECK TABLE`,
 * Postgres uses `VACUUM/ANALYZE/REINDEX`. Actions without an analog
 * return null — the caller should hide them in the UI.
 */
export type MaintenanceAction =
  | "OPTIMIZE"
  | "ANALYZE"
  | "CHECK"
  | "REPAIR";

function quoteMysql(ident: string): string {
  return `\`${ident.replace(/`/g, "``")}\``;
}

function quotePg(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export function buildMaintenanceSql(
  driver: string,
  action: MaintenanceAction,
  schema: string,
  tables: readonly string[],
): string | null {
  if (tables.length === 0) return null;

  if (driver === "postgres") {
    // Postgres doesn't accept a list — run one at a time, separated by `;`.
    const q = (t: string) => `${quotePg(schema)}.${quotePg(t)}`;
    switch (action) {
      case "OPTIMIZE":
        // VACUUM is the closest analog (reclaim space + re-tune).
        return tables.map((t) => `VACUUM ${q(t)};`).join("\n");
      case "ANALYZE":
        return tables.map((t) => `ANALYZE ${q(t)};`).join("\n");
      case "REPAIR":
        // REINDEX is the closest — rebuilds corrupted indexes.
        return tables.map((t) => `REINDEX TABLE ${q(t)};`).join("\n");
      case "CHECK":
        // PG has no CHECK TABLE; use VACUUM VERBOSE as diagnostic.
        return tables.map((t) => `VACUUM (VERBOSE) ${q(t)};`).join("\n");
    }
  }

  // MySQL (default).
  const list = tables
    .map((t) => `${quoteMysql(schema)}.${quoteMysql(t)}`)
    .join(", ");
  return `${action} TABLE ${list};`;
}

export function availableMaintenanceActions(
  driver: string,
): MaintenanceAction[] {
  if (driver === "postgres") {
    // All have analogs — but VACUUM FULL and others require locks.
    return ["OPTIMIZE", "ANALYZE", "REPAIR", "CHECK"];
  }
  return ["OPTIMIZE", "ANALYZE", "CHECK", "REPAIR"];
}

export function maintenanceLabelKey(action: MaintenanceAction): string {
  switch (action) {
    case "OPTIMIZE":
      return "tree.maintainOptimize";
    case "ANALYZE":
      return "tree.maintainAnalyze";
    case "CHECK":
      return "tree.maintainCheck";
    case "REPAIR":
      return "tree.maintainRepair";
  }
}
