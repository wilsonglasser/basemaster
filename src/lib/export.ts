import { invoke } from "@tauri-apps/api/core";
import * as XLSX from "xlsx";

import type { Value } from "./types";

export type ExportFormat = "csv_comma" | "csv_semicolon" | "json" | "xlsx";

/** Converte `Value` tagged-union pra valor plano JS/Excel. */
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

/** Separador derivado do formato. */
export function csvSeparator(format: ExportFormat): string {
  return format === "csv_semicolon" ? ";" : ",";
}

/** CSV: linha do header (sem BOM — adicione externamente na 1ª write). */
export function csvHeaderLine(
  columns: readonly string[],
  sep: string,
): string {
  return columns.map((c) => escapeCsvField(c, sep)).join(sep);
}

/** CSV: formata uma linha de dados. */
export function csvDataLine(
  row: readonly Value[],
  sep: string,
): string {
  return row
    .map((v) => escapeCsvField(valueToPlain(v), sep))
    .join(sep);
}

/** JSON: formata uma linha como objeto {col: val}. */
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

/** XLSX: in-memory, sem streaming. */
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

/** Escreve bytes num path — wrapper do command Rust. */
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
 * Export in-memory (todas as linhas já estão disponíveis). Usado quando
 * os dados já foram carregados — query-tab, table-view página atual.
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
