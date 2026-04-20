/**
 * Gera o SQL de manutenção conforme o driver. Cada SGBD tem suas
 * próprias palavras: MySQL usa `OPTIMIZE/REPAIR/ANALYZE/CHECK TABLE`,
 * Postgres usa `VACUUM/ANALYZE/REINDEX`. Ações sem análogo retornam
 * null — o chamador deve esconder da UI nesses casos.
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
    // Postgres não aceita lista — roda uma por vez, separa por `;`.
    const q = (t: string) => `${quotePg(schema)}.${quotePg(t)}`;
    switch (action) {
      case "OPTIMIZE":
        // VACUUM é o análogo mais próximo (reclaim space + re-tune).
        return tables.map((t) => `VACUUM ${q(t)};`).join("\n");
      case "ANALYZE":
        return tables.map((t) => `ANALYZE ${q(t)};`).join("\n");
      case "REPAIR":
        // REINDEX é o mais próximo — reconstrói índices corrompidos.
        return tables.map((t) => `REINDEX TABLE ${q(t)};`).join("\n");
      case "CHECK":
        // PG não tem CHECK TABLE; usa VACUUM VERBOSE como diagnóstico.
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
    // Todos têm análogo — mas VACUUM FULL e outros requerem lock.
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
