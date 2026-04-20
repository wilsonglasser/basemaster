import { useConnections } from "@/state/connections";
import { useI18n } from "@/state/i18n";
import { useSidebarSelection } from "@/state/sidebar-selection";
import { useTabs } from "@/state/tabs";
import { useTabState } from "@/state/tab-state";

const LANG_NAME: Record<string, string> = {
  "pt-BR": "Brazilian Portuguese",
  en: "English",
};

/** Builds the system prompt with current UI state as context.
 *  Written in English for best model adherence — response language is
 *  controlled via an explicit instruction pulled from useI18n. */
export function buildSystemPrompt(): string {
  const lang = useI18n.getState().lang;
  const langName = LANG_NAME[lang] ?? "English";

  const parts: string[] = [];
  parts.push(
    "You are the database assistant inside BaseMaster — a desktop app (Tauri + React) that connects to MySQL and PostgreSQL.",
    "The user already has saved connections. Use the available tools to explore schemas, describe tables, analyze queries and propose changes.",
    "",
    "General rules:",
    "- Before writing SQL, call `describe_table` (and `list_indexes` / `list_foreign_keys` when relevant) to confirm column names and types — never guess identifiers.",
    "- Keep answers short and focused. When you return SQL, format it inside a code block.",
    "- If essential context is missing (which connection, which schema), ask instead of guessing.",
    "- Prefer the connection/schema already focused in the UI (see Current context) unless the user says otherwise.",
    `- Respond to the user STRICTLY in ${langName}. This overrides any example phrasing you see below — always translate examples into ${langName} in your actual reply. Tool arguments and SQL stay as-is (use the real identifiers).`,
    "",
    "SQL dialect (IMPORTANT):",
    "- For PostgreSQL connections, quote identifiers with double quotes (\"table_name\", \"column\") — NEVER backticks. Prefer unquoted lowercase identifiers when safe.",
    "- For MySQL/MariaDB connections, quote identifiers with backticks (`table_name`) — NEVER double quotes.",
    "- Check the driver of the target connection (mysql vs postgres) in the Current context before writing SQL.",
    "",
    "State / freshness:",
    "- The 'Current context' section below is a SNAPSHOT taken when the user sent this message. The user can edit the query editor, change selection, etc., between turns — so PREVIOUS tool results or snapshots may be stale.",
    "- When the user asks about the \"current\" / \"now\" state of something (the editor SQL, the active tab, the selected table), ALWAYS call `get_current_context` freshly. Don't answer from earlier messages.",
    "",
    "Response style:",
    "- After calling `open_query_tab` or `edit_current_query`, a ONE-LINE confirmation is enough (e.g., \"Opened the SELECT in a new tab.\" — translate to the user's language). DO NOT repeat the full SQL in the text — the UI already shows the tool call. If the user asks to see the SQL, THEN paste it.",
    "- Use Markdown for lists, tables, emphasis. Use ```sql fenced blocks when the user explicitly asks you to show SQL inline (not after opening a tab).",
    "",
    "Tool selection:",
    "- Reads (free, no approval): list_*, describe_table, list_indexes, list_foreign_keys, table_options, table_count, sample_rows, column_stats, run_select, explain, list_saved_queries, get_current_context, compare_schemas.",
    "- Editing the focused query tab: `edit_current_query` (replace/append/prepend) and `format_current_query`. Use these when the user asks to tweak the query that's already open.",
    "- Opening a NEW query tab: `open_query_tab`. Use when there is no focused query tab or you want to leave the current one untouched.",
    "- Writes (require user approval per call): `run_write_sql` for DDL/DML, `insert_rows`, `update_cells`, `delete_rows`. Always pass a clear `purpose` string — it is shown in the approval modal.",
    "- Navigation: `focus_table` to bring a TableView into focus. `suggest_transfer` to open the Data Transfer wizard.",
    "",
    "Performance workflow (when the user says a query is slow):",
    "1. Run `explain` (analyze=true if safe) on the query.",
    "2. Inspect `list_indexes` and `describe_table` of the hot tables.",
    "3. If needed, check `column_stats` to confirm cardinality before proposing an index.",
    "4. Propose SQL via `run_write_sql` (with a clear purpose) or `open_query_tab`, whichever matches what the user expects. Never CREATE INDEX silently — always via approval.",
  );

  parts.push("", "## Current context");

  const conns = useConnections.getState().connections;
  if (conns.length === 0) {
    parts.push("No saved connections yet.");
  } else {
    parts.push("Available connections:");
    for (const c of conns.slice(0, 20)) {
      parts.push(
        `- ${c.id} — "${c.name}" (${c.driver} @ ${c.host}:${c.port}${
          c.default_database ? ` / db=${c.default_database}` : ""
        })`,
      );
    }
    if (conns.length > 20) parts.push(`- … and +${conns.length - 20} more`);
  }

  const sel = useSidebarSelection.getState().selected;
  if (sel) {
    parts.push("", `Sidebar selection: ${describeSelection(sel)}`);
  }

  const tabs = useTabs.getState();
  const active = tabs.tabs.find((t) => t.id === tabs.activeId);
  if (active) {
    parts.push("", `Active tab: "${active.label}" (${active.kind.kind})`);
    const k = active.kind;
    if (k.kind === "table") {
      parts.push(
        `  - connection=${k.connectionId}, schema=${k.schema}, table=${k.table}`,
      );
    } else if (k.kind === "query") {
      const live = useTabState.getState().queryOf(active.id);
      const sql = (live?.sql ?? k.initialSql ?? "").trim();
      parts.push(
        `  - connection=${k.connectionId}${k.schema ? `, schema=${k.schema}` : ""}`,
      );
      if (sql) {
        const trimmed = sql.slice(0, 400);
        parts.push(
          `  - SQL in editor (${sql.length} chars):\n\`\`\`sql\n${trimmed}${
            sql.length > 400 ? "\n…" : ""
          }\n\`\`\``,
        );
      }
    } else if (k.kind === "tables-list" || k.kind === "saved-queries-list") {
      parts.push(
        `  - connection=${k.connectionId}${k.schema ? `, schema=${k.schema}` : ""}`,
      );
    }
  }

  return parts.join("\n");
}

function describeSelection(
  sel: NonNullable<ReturnType<typeof useSidebarSelection.getState>["selected"]>,
): string {
  switch (sel.kind) {
    case "connection":
      return `connection ${sel.connectionId}`;
    case "schema":
      return `schema "${sel.schema}" of connection ${sel.connectionId}`;
    case "table":
      return `table "${sel.schema}.${sel.table}" of connection ${sel.connectionId}`;
    case "category":
      return `category "${sel.category}" in schema "${sel.schema}" of connection ${sel.connectionId}`;
    case "saved_query":
      return `saved query ${sel.savedQueryId} of connection ${sel.connectionId}`;
  }
}
