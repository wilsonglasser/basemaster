import { invoke } from "./invoke";
import * as XLSX from "xlsx";

import type { Value } from "./types";

export type ExportFormat = "csv_comma" | "csv_semicolon" | "json" | "xlsx";

/** Convert `Value` tagged-union into a plain JS/Excel value. */
export function valueToPlain(v: Value): string | number | boolean | null {
  switch (v.type) {
    case "null":
      return null;
    case "bool":
      return v.value;
    case "int":
    case "u_int":
    case "float":
      return v.value;
    case "decimal":
      return v.value;
    case "string":
      return v.value;
    case "bytes":
      return `0x${v.value
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`;
    case "json":
      return JSON.stringify(v.value);
    case "date":
    case "time":
    case "date_time":
    case "timestamp":
      return v.value;
  }
}

function escapeCsvField(raw: unknown, sep: string): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw);
  if (
    s.includes(sep) ||
    s.includes("\n") ||
    s.includes("\r") ||
    s.includes('"')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Separator derived from format. */
export function csvSeparator(format: ExportFormat): string {
  return format === "csv_semicolon" ? ";" : ",";
}

/** CSV: header line (no BOM — add externally on the 1st write). */
export function csvHeaderLine(
  columns: readonly string[],
  sep: string,
): string {
  return columns.map((c) => escapeCsvField(c, sep)).join(sep);
}

/** CSV: format a data row. */
export function csvDataLine(
  row: readonly Value[],
  sep: string,
): string {
  return row
    .map((v) => escapeCsvField(valueToPlain(v), sep))
    .join(sep);
}

/** JSON: format a row as a {col: val} object. */
export function jsonRowObject(
  columns: readonly string[],
  row: readonly Value[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = valueToPlain(row[i]);
  }
  return obj;
}

/** XLSX: in-memory, no streaming. */
export function buildXlsx(
  columns: readonly string[],
  rows: readonly (readonly Value[])[],
): Uint8Array {
  const aoa: unknown[][] = [[...columns]];
  for (const row of rows) {
    aoa.push(row.map((v) => valueToPlain(v)));
  }
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Dados");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out);
}

/** Write bytes to a path — wrapper for the Rust command. */
export async function writeFile(
  path: string,
  data: Uint8Array,
  append = false,
): Promise<void> {
  await invoke("save_file", {
    path,
    data: Array.from(data),
    append,
  });
}

/**
 * In-memory export (all rows already available). Used when data is
 * already loaded — query-tab, table-view current page.
 */
export async function writeInMemory(
  path: string,
  format: ExportFormat,
  columns: readonly string[],
  rows: readonly (readonly Value[])[],
): Promise<void> {
  if (format === "xlsx") {
    await writeFile(path, buildXlsx(columns, rows));
    return;
  }
  if (format === "json") {
    const arr = rows.map((r) => jsonRowObject(columns, r));
    const bytes = new TextEncoder().encode(JSON.stringify(arr, null, 2));
    await writeFile(path, bytes);
    return;
  }
  // CSV
  const sep = csvSeparator(format);
  const lines: string[] = [csvHeaderLine(columns, sep)];
  for (const row of rows) lines.push(csvDataLine(row, sep));
  const bytes = new TextEncoder().encode("\uFEFF" + lines.join("\r\n"));
  await writeFile(path, bytes);
}

export const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: "csv_comma", label: "CSV (vírgula)" },
  { id: "csv_semicolon", label: "CSV (ponto-vírgula)" },
  { id: "json", label: "JSON" },
  { id: "xlsx", label: "Excel (xlsx)" },
];
