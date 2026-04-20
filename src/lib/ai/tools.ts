import { tool } from "ai";
import { z } from "zod";

import { ipc } from "@/lib/ipc";
import { formatSqlText } from "@/lib/sql-format";
import type { Value } from "@/lib/types";
import { useApproval } from "@/state/ai-approval";
import { useConnections } from "@/state/connections";
import { useQueryTabBridge } from "@/state/query-tab-bridge";
import { useTabs } from "@/state/tabs";

const READ_ONLY_SQL = /^\s*(select|show|explain|describe|desc|with)\b/i;

async function ensureOpen(connectionId: string) {
  const st = useConnections.getState();
  if (st.active.has(connectionId)) return;
  await st.open(connectionId);
}

function connDriver(connectionId: string): string | undefined {
  return useConnections
    .getState()
    .connections.find((c) => c.id === connectionId)?.driver;
}

function connAccent(connectionId: string): string | null {
  return (
    useConnections
      .getState()
      .connections.find((c) => c.id === connectionId)?.color ?? null
  );
}

function valuePreview(v: Value): string {
  switch (v.type) {
    case "null":
      return "NULL";
    case "bool":
      return String(v.value);
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
      return String(v.value);
    case "json":
      return JSON.stringify(v.value);
    case "bytes":
      return `<${v.value.length} bytes>`;
  }
}

function qid(driver: string | undefined, name: string): string {
  return driver === "postgres"
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, "``")}\``;
}

function activeQueryTabId(): string | null {
  const st = useTabs.getState();
  const tab = st.tabs.find((t) => t.id === st.activeId);
  if (!tab || tab.kind.kind !== "query") return null;
  return tab.id;
}

/** Builds a short summary of SELECT rows for tool responses. */
function rowsToText(columns: string[], rows: Value[][], limit = 100) {
  const sliced = rows.slice(0, limit);
  return {
    columns,
    rows: sliced.map((r) => r.map(valuePreview)),
    total_rows: rows.length,
    truncated: rows.length > limit,
  };
}

async function runReadOnly(
  connectionId: string,
  sql: string,
  schema: string | null,
) {
  await ensureOpen(connectionId);
  const batch = await ipc.db.runQuery(connectionId, sql, schema);
  const first = batch.results[0];
  if (!first) return { empty: true };
  if (first.kind === "error") throw new Error(first.message);
  if (first.kind === "modify") {
    return { rows_affected: first.rows_affected };
  }
  return rowsToText(first.columns, first.rows);
}

async function requestApproval(req: {
  title: string;
  description: string;
  sql?: string;
  meta?: Record<string, string | number | null | undefined>;
  kind?: "sql" | "rows" | "generic";
}): Promise<void> {
  const ok = await useApproval.getState().requestApproval({
    kind: req.kind ?? (req.sql ? "sql" : "generic"),
    title: req.title,
    description: req.description,
    sql: req.sql,
    meta: req.meta,
  });
  if (!ok) throw new Error("user_denied");
}

// ---------------------------------------------------------------- tools

export const TOOLS = {
  // ---------- reads: connections / schema exploration
  list_connections: tool({
    description: "List all saved connections (id, name, driver, host).",
    inputSchema: z.object({}),
    execute: async () => {
      const conns = useConnections.getState().connections;
      return conns.map((c) => ({
        id: c.id,
        name: c.name,
        driver: c.driver,
        host: c.host,
        default_database: c.default_database,
      }));
    },
  }),

  list_schemas: tool({
    description: "List schemas/databases of a connection.",
    inputSchema: z.object({ connection_id: z.string() }),
    execute: async ({ connection_id }) => {
      await ensureOpen(connection_id);
      const out = await ipc.db.listSchemas(connection_id);
      return out.map((s) => s.name);
    },
  }),

  list_tables: tool({
    description: "List tables of a schema.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
    }),
    execute: async ({ connection_id, schema }) => {
      await ensureOpen(connection_id);
      const out = await ipc.db.listTables(connection_id, schema);
      return out.map((t) => ({
        name: t.name,
        kind: t.kind,
        rows: t.row_estimate,
        size_bytes: t.size_bytes,
      }));
    },
  }),

  describe_table: tool({
    description:
      "Columns (type, nullable, PK, default) of a table. Call this before writing queries against unfamiliar tables.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
    }),
    execute: async ({ connection_id, schema, table }) => {
      await ensureOpen(connection_id);
      const cols = await ipc.db.describeTable(connection_id, schema, table);
      return cols.map((c) => ({
        name: c.name,
        type: c.column_type,
        nullable: c.nullable,
        pk: c.is_primary_key,
        auto_inc: c.is_auto_increment,
        default: c.default,
      }));
    },
  }),

  list_indexes: tool({
    description:
      "List indexes of a table (name, columns, unique, is_primary). Essential for query-plan analysis.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
    }),
    execute: async ({ connection_id, schema, table }) => {
      await ensureOpen(connection_id);
      return await ipc.db.listIndexes(connection_id, schema, table);
    },
  }),

  list_foreign_keys: tool({
    description:
      "List foreign keys of a table. Use when composing JOINs or reasoning about relations.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
    }),
    execute: async ({ connection_id, schema, table }) => {
      await ensureOpen(connection_id);
      return await ipc.db.listForeignKeys(connection_id, schema, table);
    },
  }),

  table_options: tool({
    description:
      "Engine, charset, collation, auto_increment and comment of a table.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
    }),
    execute: async ({ connection_id, schema, table }) => {
      await ensureOpen(connection_id);
      return await ipc.db.tableOptions(connection_id, schema, table);
    },
  }),

  table_count: tool({
    description:
      "Exact row count of a table (COUNT(*)). Prefer this over run_select for cardinality checks.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
    }),
    execute: async ({ connection_id, schema, table }) => {
      await ensureOpen(connection_id);
      return { count: await ipc.db.tableCount(connection_id, schema, table) };
    },
  }),

  list_saved_queries: tool({
    description:
      "List saved queries of a connection (optionally filtered by schema).",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string().optional(),
    }),
    execute: async ({ connection_id, schema }) => {
      const list = schema
        ? await ipc.savedQueries.list(connection_id, schema)
        : await ipc.savedQueries.listAll(connection_id);
      return list.map((q) => ({
        id: q.id,
        name: q.name,
        schema: q.schema,
        sql: q.sql.slice(0, 500),
      }));
    },
  }),

  // ---------- data reads
  run_select: tool({
    description:
      "Run a read-only query (SELECT/SHOW/EXPLAIN/WITH) and return up to 100 rows.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string().optional(),
      sql: z.string(),
    }),
    execute: async ({ connection_id, schema, sql }) => {
      if (!READ_ONLY_SQL.test(sql)) {
        throw new Error(
          "run_select accepts only SELECT/SHOW/EXPLAIN/WITH. Use run_write_sql for DDL/DML.",
        );
      }
      return await runReadOnly(connection_id, sql, schema ?? null);
    },
  }),

  sample_rows: tool({
    description:
      "Fetch N sample rows from a table (no filters). Useful to understand column value shapes.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
      limit: z.number().int().min(1).max(100).default(10),
    }),
    execute: async ({ connection_id, schema, table, limit }) => {
      await ensureOpen(connection_id);
      const res = await ipc.db.tablePage(connection_id, schema, table, {
        limit,
        offset: 0,
      });
      return rowsToText(res.columns, res.rows, limit);
    },
  }),

  column_stats: tool({
    description:
      "Compute COUNT(*), COUNT(DISTINCT col), NULL count, MIN and MAX for a column. Supports cardinality analysis before proposing an index.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
      column: z.string(),
    }),
    execute: async ({ connection_id, schema, table, column }) => {
      const driver = connDriver(connection_id);
      const tbl = `${qid(driver, schema)}.${qid(driver, table)}`;
      const col = qid(driver, column);
      const sql = `SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT ${col}) AS distinct_count,
        SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS null_count,
        MIN(${col}) AS min_value,
        MAX(${col}) AS max_value
      FROM ${tbl}`;
      return await runReadOnly(connection_id, sql, schema);
    },
  }),

  explain: tool({
    description:
      "Run EXPLAIN (or EXPLAIN ANALYZE if analyze=true) on the given SQL and return the plan. Use this to diagnose slow queries before proposing indexes.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string().optional(),
      sql: z.string(),
      analyze: z.boolean().default(false),
    }),
    execute: async ({ connection_id, schema, sql, analyze }) => {
      const driver = connDriver(connection_id);
      let prefix = "EXPLAIN";
      if (analyze) {
        prefix = driver === "postgres" ? "EXPLAIN (ANALYZE)" : "EXPLAIN ANALYZE";
      }
      // Remove trailing semicolon to avoid double-statement issues.
      const body = sql.trim().replace(/;\s*$/, "");
      const stmt = `${prefix} ${body}`;
      return await runReadOnly(connection_id, stmt, schema ?? null);
    },
  }),

  // ---------- editor / tab actions
  edit_current_query: tool({
    description:
      "Edit the SQL in the CURRENTLY FOCUSED query tab. mode='replace' overwrites the whole editor; 'append' adds to the end; 'prepend' adds to the beginning. Errors if the active tab is not a query tab.",
    inputSchema: z.object({
      mode: z.enum(["replace", "append", "prepend"]).default("replace"),
      sql: z.string(),
    }),
    execute: async ({ mode, sql }) => {
      const tabId = activeQueryTabId();
      if (!tabId) {
        throw new Error(
          "no_active_query_tab: use open_query_tab instead, or ask the user to focus a query tab.",
        );
      }
      const bridge = useQueryTabBridge.getState();
      const fn = bridge.setters[tabId];
      if (!fn) {
        throw new Error("query tab not mounted");
      }
      // Precisa do sql atual pra append/prepend. A bridge só expõe setter,
      // então leio do tab-state persistido.
      const { useTabState } = await import("@/state/tab-state");
      const current =
        useTabState.getState().queryOf(tabId)?.sql ?? "";
      let next: string;
      if (mode === "append") next = `${current}\n\n${sql}`;
      else if (mode === "prepend") next = `${sql}\n\n${current}`;
      else next = sql;
      fn(next);
      return { applied: mode, chars: next.length };
    },
  }),

  format_current_query: tool({
    description:
      "Format/beautify the SQL in the currently focused query tab (uppercase keywords, indentation, etc.).",
    inputSchema: z.object({}),
    execute: async () => {
      const tabId = activeQueryTabId();
      if (!tabId) throw new Error("no_active_query_tab");
      const { useTabState } = await import("@/state/tab-state");
      const current =
        useTabState.getState().queryOf(tabId)?.sql ?? "";
      const tabs = useTabs.getState().tabs;
      const tab = tabs.find((t) => t.id === tabId);
      const connId = tab?.kind.kind === "query" ? tab.kind.connectionId : null;
      const driver = connId ? connDriver(connId) : undefined;
      const formatted = formatSqlText(current, driver);
      useQueryTabBridge.getState().setSqlIn(tabId, formatted);
      return { formatted_chars: formatted.length };
    },
  }),

  open_query_tab: tool({
    description:
      "Open a NEW query tab with proposed SQL (without executing). Use this when the user has no focused query tab, or when you want to keep the current one intact.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string().optional(),
      sql: z.string(),
      title: z.string().optional(),
    }),
    execute: async ({ connection_id, schema, sql, title }) => {
      useTabs.getState().open({
        label: title ?? "Query (IA)",
        kind: {
          kind: "query",
          connectionId: connection_id,
          schema,
          initialSql: sql,
        },
        accentColor: connAccent(connection_id),
      });
      return { ok: true, chars: sql.length };
    },
  }),

  // ---------- navigation
  focus_table: tool({
    description:
      "Open (or focus) the TableView tab for a given table — lets the user see rows + structure.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
    }),
    execute: async ({ connection_id, schema, table }) => {
      await ensureOpen(connection_id);
      useTabs.getState().openOrFocus(
        (t) =>
          t.kind.kind === "table" &&
          t.kind.connectionId === connection_id &&
          t.kind.schema === schema &&
          t.kind.table === table,
        () => ({
          label: table,
          kind: {
            kind: "table",
            connectionId: connection_id,
            schema,
            table,
          },
          accentColor: connAccent(connection_id),
        }),
      );
      return { ok: true };
    },
  }),

  get_current_context: tool({
    description:
      "Return the CURRENT, LIVE state of the UI (active tab, connection, editor SQL). Always call this fresh when the user asks about the current query — it reflects edits made after the tab was opened.",
    inputSchema: z.object({}),
    execute: async () => {
      const { useTabState } = await import("@/state/tab-state");
      const tabs = useTabs.getState();
      const tab = tabs.tabs.find((t) => t.id === tabs.activeId) ?? null;

      let tabData: Record<string, unknown> | null = null;
      if (tab) {
        const k = tab.kind;
        if (k.kind === "query") {
          const live = useTabState.getState().queryOf(tab.id);
          tabData = {
            kind: "query",
            connection_id: k.connectionId,
            // Schema e SQL refletem o editor AGORA (user pode ter mexido
            // depois da aba ser aberta).
            schema: live?.schema ?? k.schema ?? null,
            sql: live?.sql ?? k.initialSql ?? "",
          };
        } else if (k.kind === "table") {
          tabData = {
            kind: "table",
            connection_id: k.connectionId,
            schema: k.schema,
            table: k.table,
          };
        } else if (k.kind === "tables-list" || k.kind === "saved-queries-list") {
          tabData = {
            kind: k.kind,
            connection_id: k.connectionId,
            schema: k.schema ?? null,
          };
        } else {
          tabData = { kind: k.kind };
        }
      }

      return {
        active_tab: tab
          ? {
              id: tab.id,
              label: tab.label,
              ...tabData,
            }
          : null,
        active_connection_ids: Array.from(
          useConnections.getState().active,
        ),
      };
    },
  }),

  // ---------- cross-connection
  compare_schemas: tool({
    description:
      "Compare two schemas (optionally across connections): list tables present only on A, only on B, and columns that differ for common tables.",
    inputSchema: z.object({
      connection_a: z.string(),
      schema_a: z.string(),
      connection_b: z.string(),
      schema_b: z.string(),
    }),
    execute: async ({ connection_a, schema_a, connection_b, schema_b }) => {
      await ensureOpen(connection_a);
      await ensureOpen(connection_b);
      const [ta, tb] = await Promise.all([
        ipc.db.listTables(connection_a, schema_a),
        ipc.db.listTables(connection_b, schema_b),
      ]);
      const namesA = new Set(ta.map((t) => t.name));
      const namesB = new Set(tb.map((t) => t.name));
      const onlyA = ta
        .filter((t) => !namesB.has(t.name))
        .map((t) => t.name);
      const onlyB = tb
        .filter((t) => !namesA.has(t.name))
        .map((t) => t.name);
      const common = ta
        .filter((t) => namesB.has(t.name))
        .map((t) => t.name)
        .slice(0, 40);

      const columnDiffs: Array<{
        table: string;
        only_a: string[];
        only_b: string[];
      }> = [];
      for (const name of common) {
        const [ca, cb] = await Promise.all([
          ipc.db.describeTable(connection_a, schema_a, name),
          ipc.db.describeTable(connection_b, schema_b, name),
        ]);
        const colsA = new Set(ca.map((c) => c.name));
        const colsB = new Set(cb.map((c) => c.name));
        const onlyColsA = ca
          .filter((c) => !colsB.has(c.name))
          .map((c) => c.name);
        const onlyColsB = cb
          .filter((c) => !colsA.has(c.name))
          .map((c) => c.name);
        if (onlyColsA.length > 0 || onlyColsB.length > 0) {
          columnDiffs.push({
            table: name,
            only_a: onlyColsA,
            only_b: onlyColsB,
          });
        }
      }

      return {
        only_a: onlyA,
        only_b: onlyB,
        common_count: common.length,
        column_diffs: columnDiffs,
      };
    },
  }),

  suggest_transfer: tool({
    description:
      "Open the Data Transfer wizard pre-filled with source/target connection, schema and tables. The user reviews and starts the transfer.",
    inputSchema: z.object({
      source_connection_id: z.string(),
      source_schema: z.string(),
      target_connection_id: z.string(),
      target_schema: z.string(),
      tables: z.array(z.string()).optional(),
    }),
    execute: async ({
      source_connection_id,
      source_schema,
      target_connection_id,
      target_schema,
      tables,
    }) => {
      useTabs.getState().open({
        label: "Data Transfer (IA)",
        kind: {
          kind: "data-transfer",
          sourceConnectionId: source_connection_id,
          sourceSchema: source_schema,
          targetConnectionId: target_connection_id,
          targetSchema: target_schema,
          tables,
        },
      });
      return { ok: true };
    },
  }),

  // ---------- writes (require user approval per call)
  run_write_sql: tool({
    description:
      "Execute DDL/DML (CREATE/ALTER/DROP/INSERT/UPDATE/DELETE/TRUNCATE). THE USER MUST APPROVE EACH CALL via a modal. Explain intent in the 'purpose' argument — it's shown to the user.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string().optional(),
      sql: z.string(),
      purpose: z
        .string()
        .describe("Short explanation shown in the approval dialog."),
    }),
    execute: async ({ connection_id, schema, sql, purpose }) => {
      if (READ_ONLY_SQL.test(sql)) {
        throw new Error("Use run_select for read-only SQL.");
      }
      const driver = connDriver(connection_id) ?? "?";
      await requestApproval({
        title: "Agente quer rodar SQL de escrita",
        description: `${purpose}\n\nConexão: ${driver} · schema: ${schema ?? "(default)"}`,
        sql,
      });
      await ensureOpen(connection_id);
      const batch = await ipc.db.runQuery(connection_id, sql, schema ?? null);
      const first = batch.results[0];
      if (!first) return { empty: true };
      if (first.kind === "error") throw new Error(first.message);
      if (first.kind === "modify") {
        return {
          rows_affected: first.rows_affected,
          last_insert_id: first.last_insert_id,
        };
      }
      return rowsToText(first.columns, first.rows);
    },
  }),

  insert_rows: tool({
    description:
      "Insert rows into a table. Each row is an array of PK/column entries. Requires user approval.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
      purpose: z.string(),
      rows: z
        .array(
          z.array(
            z.object({
              column: z.string(),
              value: z.any(),
            }),
          ),
        )
        .min(1),
    }),
    execute: async ({ connection_id, schema, table, purpose, rows }) => {
      await requestApproval({
        title: `Agente quer inserir ${rows.length} linha(s) em ${schema}.${table}`,
        description: purpose,
        kind: "rows",
        meta: { tabela: `${schema}.${table}`, linhas: rows.length },
      });
      await ensureOpen(connection_id);
      // Tipo esperado pelo IPC: PkEntry[][] — normalizamos `value` raw.
      const normalized = rows.map((r) =>
        r.map((e) => ({
          column: e.column,
          value: toValue(e.value),
        })),
      );
      const out = await ipc.db.insertTableRows(
        connection_id,
        schema,
        table,
        normalized,
      );
      return out.map((r) =>
        r.kind === "ok"
          ? { ok: true, last_insert_id: r.last_insert_id }
          : { ok: false, error: r.message },
      );
    },
  }),

  update_cells: tool({
    description:
      "Update specific cells. Each edit identifies the row by its primary-key columns and sets a single new value. Requires user approval.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
      purpose: z.string(),
      edits: z
        .array(
          z.object({
            row_pk: z.array(
              z.object({ column: z.string(), value: z.any() }),
            ),
            column: z.string(),
            new_value: z.any(),
          }),
        )
        .min(1),
    }),
    execute: async ({
      connection_id,
      schema,
      table,
      purpose,
      edits,
    }) => {
      await requestApproval({
        title: `Agente quer atualizar ${edits.length} célula(s) em ${schema}.${table}`,
        description: purpose,
        kind: "rows",
        meta: { tabela: `${schema}.${table}`, edits: edits.length },
      });
      await ensureOpen(connection_id);
      const normalized = edits.map((e) => ({
        row_pk: e.row_pk.map((p) => ({
          column: p.column,
          value: toValue(p.value),
        })),
        column: e.column,
        new_value: toValue(e.new_value),
      }));
      const out = await ipc.db.applyTableEdits(
        connection_id,
        schema,
        table,
        normalized,
      );
      return out.map((r) =>
        r.kind === "ok"
          ? { ok: true, rows_affected: r.rows_affected }
          : { ok: false, error: r.message },
      );
    },
  }),

  delete_rows: tool({
    description:
      "Delete rows identified by their primary-key values. Requires user approval.",
    inputSchema: z.object({
      connection_id: z.string(),
      schema: z.string(),
      table: z.string(),
      purpose: z.string(),
      rows: z
        .array(
          z.array(
            z.object({ column: z.string(), value: z.any() }),
          ),
        )
        .min(1),
    }),
    execute: async ({ connection_id, schema, table, purpose, rows }) => {
      await requestApproval({
        title: `Agente quer deletar ${rows.length} linha(s) de ${schema}.${table}`,
        description: purpose,
        kind: "rows",
        meta: { tabela: `${schema}.${table}`, linhas: rows.length },
      });
      await ensureOpen(connection_id);
      const normalized = rows.map((r) =>
        r.map((e) => ({ column: e.column, value: toValue(e.value) })),
      );
      const out = await ipc.db.deleteTableRows(
        connection_id,
        schema,
        table,
        normalized,
      );
      return out.map((r) =>
        r.kind === "ok"
          ? { ok: true, rows_affected: r.rows_affected }
          : { ok: false, error: r.message },
      );
    },
  }),
};

/** Coerce JS primitive to our Value shape. Agents tend to send bare
 *  strings/numbers/nulls — we wrap them. Accepts already-wrapped Values too. */
function toValue(v: unknown): Value {
  if (v == null) return { type: "null" };
  if (
    typeof v === "object" &&
    v !== null &&
    "type" in v &&
    typeof (v as { type: unknown }).type === "string"
  ) {
    return v as Value;
  }
  if (typeof v === "boolean") return { type: "bool", value: v };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "int", value: v }
      : { type: "float", value: v };
  }
  if (typeof v === "string") return { type: "string", value: v };
  return { type: "json", value: v };
}
