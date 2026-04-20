import { ipc } from "@/lib/ipc";
import type { Uuid } from "@/lib/types";
import { useExport } from "@/state/export-state";
import type { ExportProgress } from "@/components/export-dialog";

import {
  buildXlsx,
  csvDataLine,
  csvHeaderLine,
  csvSeparator,
  jsonRowObject,
  writeFile,
  type ExportFormat,
} from "./export";

const quote = (id: string) => `\`${id.replace(/`/g, "``")}\``;

/**
 * Streaming export de uma tabela: busca em chunks e escreve direto no
 * arquivo em append, sem carregar tudo em memória. Suporta CSV e JSON.
 * XLSX usa o fallback in-memory (formato não é append-friendly).
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
  // Total (pra barra de progresso) — COUNT(*) uma vez.
  setProgress({ done: 0, total: null, message: "Contando linhas…" });
  let total: number | null = null;
  try {
    const countBatch = await ipc.db.runQuery(
      connectionId,
      `SELECT COUNT(*) FROM ${quote(schema)}.${quote(table)}`,
      schema,
    );
    const first = countBatch.results[0];
    if (first?.kind === "select" && first.rows.length > 0) {
      const v = first.rows[0][0];
      if (v.type === "int" || v.type === "u_int" || v.type === "float") {
        total = Number(v.value);
      } else if (v.type === "decimal") {
        total = Number(v.value);
      }
    }
  } catch {
    // sem contagem — roda sem total.
  }

  // XLSX: roda tudo em memória via SELECT sem chunks. Aceita colunas
  // filtradas. Memória proporcional ao tamanho da tabela.
  if (format === "xlsx") {
    setProgress({ done: 0, total, message: "Carregando linhas…" });
    const cols = selectedColumns.map((c) => quote(c)).join(", ");
    const batch = await ipc.db.runQuery(
      connectionId,
      `SELECT ${cols} FROM ${quote(schema)}.${quote(table)}`,
      schema,
    );
    const r = batch.results[0];
    if (!r || r.kind !== "select") throw new Error("sem resultado");
    setProgress({ done: r.rows.length, total, message: "Gerando XLSX…" });
    await writeFile(path, buildXlsx(r.columns, r.rows));
    return;
  }

  // CSV / JSON: streaming chunked.
  const CHUNK = 5000;
  const colsSql = selectedColumns.map((c) => quote(c)).join(", ");
  let offset = 0;
  let done = 0;
  let isFirst = true;

  while (true) {
    const sql = `SELECT ${colsSql} FROM ${quote(schema)}.${quote(
      table,
    )} LIMIT ${CHUNK} OFFSET ${offset}`;
    const batch = await ipc.db.runQuery(connectionId, sql, schema);
    const r = batch.results[0];
    if (!r || r.kind !== "select") break;
    if (r.rows.length === 0) {
      if (isFirst) {
        // tabela vazia — grava só header (CSV) ou array vazio (JSON)
        await writeFirstChunk(path, format, r.columns, []);
      }
      break;
    }

    if (isFirst) {
      await writeFirstChunk(path, format, r.columns, r.rows);
      isFirst = false;
    } else {
      await writeNextChunk(path, format, r.columns, r.rows);
    }
    done += r.rows.length;
    setProgress({ done, total, message: "Exportando…" });
    if (r.rows.length < CHUNK) break;
    offset += r.rows.length;
  }

  // JSON: fechar o array.
  if (format === "json") {
    await writeFile(path, new TextEncoder().encode("\n]\n"), true);
  }
}

async function writeFirstChunk(
  path: string,
  format: ExportFormat,
  columns: readonly string[],
  rows: readonly (readonly import("./types").Value[])[],
): Promise<void> {
  if (format === "json") {
    let body = "[\n";
    body += rows
      .map((r) => "  " + JSON.stringify(jsonRowObject(columns, r)))
      .join(",\n");
    await writeFile(path, new TextEncoder().encode(body));
    return;
  }
  // CSV com BOM UTF-8 + header + rows
  const sep = csvSeparator(format);
  const lines: string[] = [csvHeaderLine(columns, sep)];
  for (const r of rows) lines.push(csvDataLine(r, sep));
  const body = "\uFEFF" + lines.join("\r\n");
  await writeFile(path, new TextEncoder().encode(body));
}

async function writeNextChunk(
  path: string,
  format: ExportFormat,
  columns: readonly string[],
  rows: readonly (readonly import("./types").Value[])[],
): Promise<void> {
  if (format === "json") {
    // Continua o array com ",\n  obj,\n  obj,..."
    const body =
      ",\n" +
      rows
        .map((r) => "  " + JSON.stringify(jsonRowObject(columns, r)))
        .join(",\n");
    await writeFile(path, new TextEncoder().encode(body), true);
    return;
  }
  // CSV: "\r\n" + linhas
  const sep = csvSeparator(format);
  const body =
    "\r\n" + rows.map((r) => csvDataLine(r, sep)).join("\r\n");
  await writeFile(path, new TextEncoder().encode(body), true);
}

/**
 * Entry point do right-click "Exportar" na tree/tables-list. Busca só a
 * lista de colunas (via describe_table) e abre o dialog global com um
 * callback de streaming.
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
