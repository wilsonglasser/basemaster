/**
 * Helpers to map ColumnType ↔ Glide cells (Custom + builtin),
 * and Value ↔ string conversions used by dirty state.
 */

import type { EditableGridCell } from "@glideapps/glide-data-grid";
import { GridCellKind } from "@glideapps/glide-data-grid";

import { formatValue, isNullish } from "@/lib/format-value";
import type { Column, ColumnType, Value } from "@/lib/types";

export type DateKind = "date" | "time" | "datetime-local";

export type EditorKind =
  | { kind: "text" }
  | {
      kind: "number";
      /** false blocks negative sign (UNSIGNED types). */
      allowNegative: boolean;
      /** Fixed decimals for DECIMAL(p,s). undefined = unrestricted. */
      fixedDecimals?: number;
    }
  | { kind: "boolean" }
  | { kind: "enum"; values: string[] }
  | { kind: "date"; dateKind: DateKind };

/** Resolves which editor to use for a column. */
export function pickEditorKind(column: Column | undefined): EditorKind {
  if (!column) return { kind: "text" };
  const t: ColumnType = column.column_type;
  switch (t.kind) {
    case "integer":
      return { kind: "number", allowNegative: !t.unsigned };
    case "float":
    case "double":
      return { kind: "number", allowNegative: true };
    case "decimal":
      return {
        kind: "number",
        allowNegative: true,
        fixedDecimals: t.scale,
      };
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      return { kind: "enum", values: t.values };
    case "date":
      return { kind: "date", dateKind: "date" };
    case "time":
      return { kind: "date", dateKind: "time" };
    case "date_time":
    case "timestamp":
      return { kind: "date", dateKind: "datetime-local" };
    default:
      return { kind: "text" };
  }
}

/** Parses MySQL-ish text ("YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", "HH:MM:SS") into Date. */
export function parseDateText(text: string, kind: DateKind): Date | null {
  if (!text) return null;
  if (kind === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (kind === "time") {
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
    if (!m) return null;
    const d = new Date(1970, 0, 1);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0));
    return d;
  }
  // datetime-local
  const normalized = text.replace(" ", "T");
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** Formats Date → MySQL text. */
export function formatDateForMysql(d: Date, kind: DateKind): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (kind === "date") {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (kind === "time") {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Extracts the "text" from an edited cell (any kind). This text goes to dirty. */
export function extractCellText(cell: EditableGridCell): string {
  if (cell.kind === GridCellKind.Text) {
    return String(cell.data ?? "");
  }
  if (cell.kind === GridCellKind.Number) {
    return cell.data === undefined || cell.data === null
      ? ""
      : String(cell.data);
  }
  if (cell.kind === GridCellKind.Boolean) {
    if (cell.data === true) return "1";
    if (cell.data === false) return "0";
    return "";
  }
  if (cell.kind === GridCellKind.Custom) {
    const d = cell.data as
      | { kind: "dropdown-cell"; value?: string | null }
      | {
          kind: "date-picker-cell";
          date?: Date | null;
          format: DateKind;
          displayDate?: string;
        }
      | undefined;
    if (!d) return "";
    if (d.kind === "dropdown-cell") return d.value ?? "";
    if (d.kind === "date-picker-cell") {
      if (!d.date) return d.displayDate ?? "";
      return formatDateForMysql(d.date, d.format);
    }
  }
  return "";
}

/** Parses a value into Number cell (returns undefined for NULL/invalid). */
export function valueToNumber(v: Value | undefined): number | undefined {
  if (!v || isNullish(v)) return undefined;
  switch (v.type) {
    case "int":
    case "u_int":
    case "float":
      return v.value as number;
    case "decimal":
      return Number(v.value);
    case "string": {
      const n = Number(v.value);
      return isNaN(n) ? undefined : n;
    }
    default:
      return undefined;
  }
}

/** Parses a dirty-state string to Number. */
export function textToNumber(text: string): number | undefined {
  if (!text) return undefined;
  const n = Number(text);
  return isNaN(n) ? undefined : n;
}

/** Parses to Boolean cell. */
export function valueToBoolean(v: Value | undefined): boolean | undefined {
  if (!v || isNullish(v)) return undefined;
  if (v.type === "bool") return v.value;
  if (v.type === "int" || v.type === "u_int") return v.value !== 0;
  if (v.type === "string") return v.value === "1" || v.value.toLowerCase() === "true";
  return undefined;
}

/** Default display text (NULL or formatted). */
export function displayText(v: Value | undefined, isDirty: boolean, dirtyText: string | undefined): string {
  if (isDirty) return dirtyText ?? "";
  return isNullish(v) ? "NULL" : formatValue(v);
}
