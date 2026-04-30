import {
  readText as tauriReadText,
  writeText as tauriWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

import type { Uuid } from "@/lib/types";

/**
 * "copy tables" clipboard format.
 * - Text: names separated by \n (user sees the list if pasted elsewhere)
 * - Metadata: comment-like JSON at the start, or in separate storage
 *
 * We use this hybrid text format:
 *   #basemaster:tables {"connectionId":"...","schema":"..."}
 *   table1
 *   table2
 *   table3
 *
 * For folder copy we use a different header that bundles the folder name:
 *   #basemaster:table-folder {"connectionId":"...","schema":"...","folder":"..."}
 *   table1
 *   table2
 *
 * The first line lets pasting into any editor show a "natural" list
 * (bare names) while our parser recognizes the header and reconstructs
 * the original context.
 */
export interface TableClipboardPayload {
  connectionId: Uuid;
  schema: string;
  tables: string[];
  /** When present, this clipboard is a folder copy: paste should also
   *  recreate the folder on the target side and assign the new tables. */
  folderName?: string;
}

const HEADER_TABLES = "#basemaster:tables ";
const HEADER_TABLE_FOLDER = "#basemaster:table-folder ";

export function serializeTableClipboard(p: TableClipboardPayload): string {
  if (p.folderName) {
    const header = `${HEADER_TABLE_FOLDER}${JSON.stringify({
      connectionId: p.connectionId,
      schema: p.schema,
      folder: p.folderName,
    })}`;
    return [header, ...p.tables].join("\n");
  }
  const header = `${HEADER_TABLES}${JSON.stringify({
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
  try {
    if (head.startsWith(HEADER_TABLE_FOLDER)) {
      const meta = JSON.parse(head.slice(HEADER_TABLE_FOLDER.length));
      if (
        typeof meta.connectionId !== "string" ||
        typeof meta.schema !== "string" ||
        typeof meta.folder !== "string"
      ) {
        return null;
      }
      return {
        connectionId: meta.connectionId,
        schema: meta.schema,
        folderName: meta.folder,
        tables: lines.slice(1),
      };
    }
    if (head.startsWith(HEADER_TABLES)) {
      const meta = JSON.parse(head.slice(HEADER_TABLES.length));
      if (
        typeof meta.connectionId !== "string" ||
        typeof meta.schema !== "string"
      ) {
        return null;
      }
      return {
        connectionId: meta.connectionId,
        schema: meta.schema,
        tables: lines.slice(1),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeTableClipboard(
  p: TableClipboardPayload,
): Promise<void> {
  const text = serializeTableClipboard(p);
  // Tauri plugin — no browser permission prompt.
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
