import { listen } from "@tauri-apps/api/event";

import { ipc } from "@/lib/ipc";
import type { DataExportProgress, Uuid } from "@/lib/types";
import { useExport } from "@/state/export-state";
import type { ExportProgress } from "@/components/export-dialog";
import type { ExportFormat } from "./export";

/**
 * Full-table export. The backend streams rows straight to disk (keyset
 * pagination, no row data over the IPC bridge) and emits `data_export:*`
 * events; we relay them to the dialog's progress bar.
 */
export async function streamTableToFile(
  connectionId: Uuid,
  schema: string,
  table: string,
  selectedColumns: readonly string[],
  format: ExportFormat,
  path: string,
  setProgress: (p: ExportProgress | null) => void,
): Promise<void> {
  setProgress({ done: 0, total: null, message: "Exportando…" });
  const un = await listen<DataExportProgress>("data_export:progress", (e) => {
    setProgress({
      done: e.payload.done,
      total: e.payload.total > 0 ? e.payload.total : null,
      message: "Exportando…",
    });
  });
  try {
    await ipc.dataExport.start({
      source_connection_id: connectionId,
      tables: [{ schema, table, columns: [...selectedColumns] }],
      format,
      path,
      bundle_zip: false,
    });
  } finally {
    un();
  }
}

/**
 * Entry point for right-click "Export" on the tree/tables-list. Fetches
 * only the column list (via describe_table) and opens the global dialog
 * with a streaming callback.
 */
export async function startTableExport(
  connectionId: Uuid,
  schema: string,
  table: string,
): Promise<void> {
  try {
    const cols = await ipc.db.describeTable(connectionId, schema, table);
    useExport.getState().open({
      columns: cols.map((c) => c.name),
      defaultName: `${schema}.${table}`,
      mode: "stream",
      streamContext: { connectionId, schema, table },
    });
  } catch (e) {
    alert(`Falha ao ler estrutura: ${e}`);
  }
}

/**
 * Bulk export: the backend streams every table into a single ZIP (one entry
 * per table). Format choice + ZIP path come from the global export dialog
 * (multi-stream mode).
 */
export async function startMultiTableExport(
  connectionId: Uuid,
  schema: string,
  tables: string[],
): Promise<void> {
  if (tables.length === 0) return;
  useExport.getState().open({
    mode: "multi-stream",
    defaultName: `${schema}-tables`,
    multiContext: { connectionId, schema, tables },
  });
}

/** Used by the global export dialog when running a multi-stream request. */
export async function streamMultiTablesToZip(
  connectionId: Uuid,
  schema: string,
  tables: readonly string[],
  format: ExportFormat,
  outputZipPath: string,
  setProgress: (p: ExportProgress | null) => void,
): Promise<void> {
  setProgress({ done: 0, total: tables.length, message: "Exportando…" });
  const un = await listen<DataExportProgress>("data_export:progress", (e) => {
    setProgress({
      done: e.payload.done,
      total: e.payload.total > 0 ? e.payload.total : null,
      message: `Exportando ${e.payload.table}…`,
    });
  });
  try {
    await ipc.dataExport.start({
      source_connection_id: connectionId,
      // Empty columns => backend exports every column of each table.
      tables: tables.map((table) => ({ schema, table })),
      format,
      path: outputZipPath,
      bundle_zip: true,
    });
  } finally {
    un();
  }
}
