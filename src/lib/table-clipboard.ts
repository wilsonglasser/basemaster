import {
  readText as tauriReadText,
  writeText as tauriWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

import type { Uuid } from "@/lib/types";

/**
 * Formato "copy tables" pro clipboard.
 * - Texto: nomes separados por \n (user vê a lista se colar em outro lugar)
 * - Metadados: JSON no início em comentário-like, ou em storage separado
 *
 * Usamos o seguinte formato híbrido no texto:
 *   #basemaster:tables {"connectionId":"...","schema":"..."}
 *   table1
 *   table2
 *   table3
 *
 * A primeira linha permite o paste em qualquer editor mostrar a lista
 * "natural" (nomes soltos) enquanto nosso parser reconhece o header
 * e reconstrói o contexto de origem.
 */
export interface TableClipboardPayload {
  connectionId: Uuid;
  schema: string;
  tables: string[];
}

const HEADER_PREFIX = "#basemaster:tables ";

export function serializeTableClipboard(p: TableClipboardPayload): string {
  const header = `${HEADER_PREFIX}${JSON.stringify({
    connectionId: p.connectionId,
    schema: p.schema,
  })}`;
  return [header, ...p.tables].join("\n");
}

export function parseTableClipboard(
  text: string,
): TableClipboardPayload | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const head = lines[0];
  if (!head.startsWith(HEADER_PREFIX)) return null;
  try {
    const meta = JSON.parse(head.slice(HEADER_PREFIX.length));
    if (typeof meta.connectionId !== "string" || typeof meta.schema !== "string") {
      return null;
    }
    return {
      connectionId: meta.connectionId,
      schema: meta.schema,
      tables: lines.slice(1),
    };
  } catch {
    return null;
  }
}

export async function writeTableClipboard(
  p: TableClipboardPayload,
): Promise<void> {
  const text = serializeTableClipboard(p);
  // Plugin Tauri — sem permission prompt do browser.
  await tauriWriteText(text);
}

export async function readTableClipboard(): Promise<
  TableClipboardPayload | null
> {
  try {
    const text = await tauriReadText();
    return parseTableClipboard(text);
  } catch {
    return null;
  }
}
