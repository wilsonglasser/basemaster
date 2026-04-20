import Papa from "papaparse";
import * as XLSX from "xlsx";

import type { Value } from "@/lib/types";

export type ImportFormat = "csv" | "json" | "xlsx";

export interface ParsedData {
  columns: string[];
  /** Linhas: strings brutas (CSV) ou valores JS (XLSX/JSON). */
  rows: unknown[][];
}

export function detectFormat(path: string): ImportFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
  return null;
}

export async function parseFile(
  content: Uint8Array,
  fileName: string,
): Promise<ParsedData> {
  const fmt = detectFormat(fileName);
  if (!fmt) throw new Error(`Formato não suportado: ${fileName}`);

  switch (fmt) {
    case "csv": {
      const text = new TextDecoder("utf-8").decode(content);
      const delimiter = fileName.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      const res = Papa.parse<string[]>(text, {
        delimiter,
        skipEmptyLines: true,
      });
      if (res.errors.length > 0) {
        const fatal = res.errors.find((e) => e.type === "Delimiter");
        if (fatal) throw new Error(fatal.message);
      }
      const data = res.data;
      if (data.length === 0) return { columns: [], rows: [] };
      return { columns: data[0], rows: data.slice(1) };
    }

    case "json": {
      const text = new TextDecoder("utf-8").decode(content);
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error("JSON precisa ser array de objetos");
      }
      if (parsed.length === 0) return { columns: [], rows: [] };
      const cols = Array.from(
        new Set(parsed.flatMap((o) => Object.keys(o ?? {}))),
      );
      const rows = parsed.map((o) =>
        cols.map((c) => (o as Record<string, unknown>)[c]),
      );
      return { columns: cols, rows };
    }

    case "xlsx": {
      const wb = XLSX.read(content, { type: "array" });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
      });
      if (aoa.length === 0) return { columns: [], rows: [] };
      const cols = (aoa[0] as unknown[]).map((v) => String(v ?? ""));
      return { columns: cols, rows: aoa.slice(1) as unknown[][] };
    }
  }
}

/** Coerce um valor qualquer pra shape Value. */
export function toValue(v: unknown): Value {
  if (v == null || v === "") return { type: "null" };
  if (typeof v === "boolean") return { type: "bool", value: v };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "int", value: v }
      : { type: "float", value: v };
  }
  if (v instanceof Date) {
    return { type: "date_time", value: v.toISOString() };
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return { type: "null" };
    // Tenta número.
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isSafeInteger(n)) return { type: "int", value: n };
    }
    if (/^-?\d+\.\d+$/.test(trimmed)) {
      return { type: "float", value: Number(trimmed) };
    }
    const low = trimmed.toLowerCase();
    if (low === "true") return { type: "bool", value: true };
    if (low === "false") return { type: "bool", value: false };
    if (low === "null") return { type: "null" };
    return { type: "string", value: v };
  }
  return { type: "json", value: v };
}
