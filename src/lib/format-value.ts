import type { Value } from "@/lib/types";

export function isNullish(v: Value | undefined | null): boolean {
  return !v || v.type === "null";
}

export function formatValue(v: Value | undefined | null): string {
  if (!v || v.type === "null") return "";
  switch (v.type) {
    case "bool":
      return v.value ? "true" : "false";
    case "int":
    case "u_int":
    case "float":
      return String(v.value);
    case "decimal":
    case "string":
    case "date":
    case "time":
    case "date_time":
    case "timestamp":
      return v.value;
    case "json":
      return JSON.stringify(v.value);
    case "bytes":
      return `[${v.value.length} bytes]`;
  }
}
