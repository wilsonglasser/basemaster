import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Cog,
  Copy,
  Database,
  Download,
  Eye,
  FileCode2,
  Gauge,
  FileText,
  Folder as FolderIcon,
  FunctionSquare,
  History,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Table as TableIcon,
  Trash2,
  Unplug,
  Upload,
  Wrench,
} from "lucide-react";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import {
  formatCompactBytes,
  formatCompactNumber,
} from "@/lib/format-number";
import {
  buildMaintenanceSql,
  type MaintenanceAction,
} from "@/lib/maintenance-sql";
import { startMultiTableExport, startTableExport } from "@/lib/export-table";
import { ipc } from "@/lib/ipc";
import {
  readTableClipboard,
  writeTableClipboard,
} from "@/lib/table-clipboard";
import type {
  ConnectionProfile,
  SavedQuery,
  SchemaFolder,
  SchemaInfo,
  TableFolder,
  TableInfo,
  Uuid,
} from "@/lib/types";
import { DbIcon } from "@/components/ui/db-icon";
import { cn } from "@/lib/utils";
import { appAlert, appConfirm, appPrompt } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { filterBySchema, useSavedQueries } from "@/state/saved-queries";
import { useSchemaCache } from "@/state/schema-cache";
import { useSchemaFolders, useTableFolders } from "@/state/folder-stores";
import { HighlightText } from "@/components/ui/highlight-text";
import { matches, useSidebarFilter } from "@/state/sidebar-filter";
import { useSidebarSelection } from "@/state/sidebar-selection";
import {
  sameMultiScope,
  useSidebarMultiSelect,
} from "@/state/sidebar-multi-select";
import { confirmDestructive } from "@/state/destructive-confirm";
import { runExecutor, type ExecutorJob } from "@/state/executor";
import { useTableViewBridge } from "@/state/table-view-bridge";
import { useTabs } from "@/state/tabs";

type DdlKind = "view" | "function" | "procedure" | "trigger";

function ddlTemplate(
  driver: string,
  kind: DdlKind,
  schema: string,
): string {
  const isPg = driver === "postgres";
  const q = (s: string) => (isPg ? `"${s}"` : `\`${s}\``);
  switch (kind) {
    case "view":
      return `-- CREATE VIEW\nCREATE OR REPLACE VIEW ${q(schema)}.${q("nome_da_view")} AS\nSELECT *\nFROM ${q("tabela")}\nWHERE /* condição */;`;
    case "function":
      if (isPg) {
        return `-- CREATE FUNCTION (PostgreSQL)\nCREATE OR REPLACE FUNCTION ${q(schema)}.${q("nome_da_funcao")}(\n  p_arg INTEGER\n) RETURNS INTEGER\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN p_arg * 2;\nEND;\n$$;`;
      }
      return `-- CREATE FUNCTION (MySQL)\nDELIMITER //\nCREATE FUNCTION ${q(schema)}.${q("nome_da_funcao")}(\n  p_arg INT\n) RETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN p_arg * 2;\nEND//\nDELIMITER ;`;
    case "procedure":
      if (isPg) {
        return `-- CREATE PROCEDURE (PostgreSQL)\nCREATE OR REPLACE PROCEDURE ${q(schema)}.${q("nome_da_procedure")}(\n  p_arg INTEGER\n)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- lógica aqui\n  RAISE NOTICE 'arg=%', p_arg;\nEND;\n$$;`;
      }
      return `-- CREATE PROCEDURE (MySQL)\nDELIMITER //\nCREATE PROCEDURE ${q(schema)}.${q("nome_da_procedure")}(\n  IN p_arg INT\n)\nBEGIN\n  -- lógica aqui\n  SELECT p_arg;\nEND//\nDELIMITER ;`;
    case "trigger":
      if (isPg) {
        return `-- CREATE TRIGGER (PostgreSQL) : requer FUNCTION primeiro\nCREATE OR REPLACE FUNCTION ${q(schema)}.${q("trg_fn")}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- manipulação\n  RETURN NEW;\nEND;\n$$;\n\nCREATE TRIGGER ${q("nome_do_trigger")}\nBEFORE INSERT ON ${q(schema)}.${q("tabela")}\nFOR EACH ROW\nEXECUTE FUNCTION ${q(schema)}.${q("trg_fn")}();`;
      }
      return `-- CREATE TRIGGER (MySQL)\nDELIMITER //\nCREATE TRIGGER ${q("nome_do_trigger")}\nBEFORE INSERT ON ${q(schema)}.${q("tabela")}\nFOR EACH ROW\nBEGIN\n  -- manipulação\nEND//\nDELIMITER ;`;
  }
}

function openDdlTemplate(
  conn: ConnectionProfile,
  schema: string,
  kind: DdlKind,
  _newTab: unknown,
) {
  const sql = ddlTemplate(conn.driver, kind, schema);
  useTabs.getState().open({
    label: `${kind} · ${schema}`,
    kind: {
      kind: "query",
      connectionId: conn.id,
      schema,
      initialSql: sql,
    },
    accentColor: conn.color,
  });
}

export function ConnTree() {
  const connections = useConnections((s) => s.connections);
  const folders = useConnections((s) => s.folders);
  useSidebarShortcuts();
  if (connections.length === 0 && folders.length === 0) return null;

  // Group connections by folder_id. Null = root.
  const byFolder = new Map<string, ConnectionProfile[]>();
  for (const c of connections) {
    const key = c.folder_id ?? "__root__";
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key)!.push(c);
  }

  return (
    <ul className="grid gap-0.5">
      {/* Folders first, in the defined order. */}
      {folders.map((f) => (
        <FolderNode
          key={f.id}
          folder={f}
          connections={byFolder.get(f.id) ?? []}
        />
      ))}
      {/* Root drop zone (only appears if there are folders : otherwise
           it makes no sense to "move to root" since it's already there). */}
      {folders.length > 0 && <RootDropZone />}
      {/* Connections at the root. */}
      {(byFolder.get("__root__") ?? []).map((c) => (
        <ConnectionNode key={c.id} conn={c} />
      ))}
    </ul>
  );
}

/** Invisible drop zone between folders and root connections : only
 *  appears visually when being dragged over. */
/** Official driver icon (simple-icons). Lights up in the connection color
 *  when active; goes dim/muted when disconnected. */
function DriverIcon({
  driver,
  active,
  color,
}: {
  driver: string;
  active: boolean;
  color: string | null;
}) {
  return <DbIcon driver={driver} active={active} color={color} />;
}

function RootDropZone() {
  const t = useT();
  const refresh = useConnections((s) => s.refresh);
  const [over, setOver] = useState(false);
  return (
    <li
      className={cn(
        "h-2 rounded-md transition-all",
        over && "h-5 bg-conn-accent/20 ring-1 ring-conn-accent/60",
      )}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes("application/x-basemaster-connection")
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(
          "application/x-basemaster-connection",
        );
        if (!id) return;
        try {
          await ipc.folders.move(id, null);
          await refresh();
        } catch (err) {
          void appAlert(t("tree.moveFailed", { error: String(err) }));
        }
      }}
    />
  );
}

function FolderNode({
  folder,
  connections,
}: {
  folder: import("@/lib/types").ConnectionFolder;
  connections: ConnectionProfile[];
}) {
  const t = useT();
  const refreshFolders = useConnections((s) => s.refreshFolders);
  const refresh = useConnections((s) => s.refresh);
  const [expanded, setExpanded] = useState(true);
  const [dragOver, setDragOver] = useState(false);

  const rename = async () => {
    const next = await appPrompt(t("tree.renameFolderPrompt"), {
      defaultValue: folder.name,
    });
    if (!next || !next.trim() || next === folder.name) return;
    try {
      await ipc.folders.rename(folder.id, next.trim());
      await refreshFolders();
    } catch (e) {
      await appAlert(t("tree.renameTableErr", { error: String(e) }));
    }
  };

  const remove = async () => {
    const hasConns = connections.length > 0;
    if (!hasConns) {
      const ok = await appConfirm(
        t("tree.deleteEmptyFolderConfirm", { name: folder.name }),
      );
      if (!ok) return;
      try {
        await ipc.folders.delete(folder.id);
        await refresh();
      } catch (e) {
        await appAlert(t("common.failure", { error: String(e) }));
      }
      return;
    }
    // Has connections: 3 options : cancel, move to root, delete together.
    const choice = await appConfirm(
      t("tree.deleteFolderWithConnsConfirm", {
        name: folder.name,
        count: connections.length,
      }),
    );
    try {
      if (choice) {
        // Delete connections one by one.
        for (const c of connections) {
          await ipc.connections.delete(c.id);
        }
      }
      await ipc.folders.delete(folder.id);
      await refresh();
    } catch (e) {
      await appAlert(t("common.failure", { error: String(e) }));
    }
  };

  const exportConnections = async () => {
    try {
      const includePasswords = await appConfirm(
        t("tree.exportFolderPrompt", {
          count: connections.length,
          name: folder.name,
        }),
      );
      const payload = await ipc.portability.export(includePasswords);
      const connNames = new Set(connections.map((c) => c.name));
      const filtered = {
        ...payload,
        folders: payload.folders.filter((f) => f.name === folder.name),
        connections: payload.connections.filter((c) => connNames.has(c.name)),
      };
      if (filtered.connections.length === 0) {
        void appAlert(t("tree.nothingToExport"));
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `${folder.name.replace(/[^\w.-]/g, "_")}.bmconn`,
        filters: [{ name: "BaseMaster", extensions: ["bmconn", "json"] }],
      });
      if (!path) return;
      const bytes = new TextEncoder().encode(JSON.stringify(filtered, null, 2));
      const { invoke: doInvoke } = await import("@tauri-apps/api/core");
      await doInvoke("save_file", { path, data: Array.from(bytes) });
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData("application/x-basemaster-connection");
    if (!id) return;
    try {
      await ipc.folders.move(id, folder.id);
      await refresh();
    } catch (err) {
      void appAlert(t("tree.moveFailed", { error: String(err) }));
    }
  };

  const menu = useContextMenu([
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: t("tree.renameFolder"),
      onClick: rename,
    },
    {
      icon: <Download className="h-3.5 w-3.5" />,
      label: t("tree.exportFolderConnections", { count: connections.length }),
      onClick: exportConnections,
      disabled: connections.length === 0,
    },
    { separator: true },
    {
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: t("tree.deleteFolder"),
      onClick: remove,
      variant: "destructive",
    },
  ]);

  return (
    <li>
      <div
        className={cn(
          "flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs font-medium tracking-wide transition-colors",
          dragOver
            ? "bg-conn-accent/20 text-foreground ring-1 ring-conn-accent/60"
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
        )}
        onClick={() => setExpanded((x) => !x)}
        onContextMenu={menu.openAt}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes("application/x-basemaster-connection")
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <span className="grid h-4 w-4 place-items-center">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <FolderIcon className="h-3 w-3 shrink-0" />
        <span className="flex-1 truncate">{folder.name}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {connections.length}
        </span>
      </div>
      {menu.element}
      {expanded && connections.length > 0 && (
        <ul className="ml-3 grid gap-0.5 border-l border-border/50 pl-1">
          {connections.map((c) => (
            <ConnectionNode key={c.id} conn={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Global sidebar shortcuts. Ctrl+C copies the current selection to the
 *  clipboard (1 table if it's a table, all tables of the schema if a schema).
 *  Ctrl+V opens the transfer wizard with the current selection as target
 *  (connection or schema). Ignored when focus is in an input/textarea,
 *  so we don't steal normal copy/paste in fields. */
function useSidebarShortcuts() {
  const newTab = useTabs((s) => s.open);
  const t = useT();
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      // Don't stomp on copy/paste in inputs/textareas/content-editable.
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        const tag = tgt.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tgt.isContentEditable ||
          tgt.closest("[contenteditable='true']")
        ) {
          return;
        }
        // Skip if focus is in the main panel (active tab content : grid,
        // query editor, etc.). The sidebar shortcut is exclusive to the
        // sidebar tree; otherwise Ctrl+C in a table grid would stomp the
        // grid's own copy.
        if (tgt.closest("main")) return;
      }
      // If the user has a text selection (e.g. inside a <pre> SQL preview),
      // let the native copy run : this shortcut is only for "no selection,
      // sidebar item focused" cases.
      if (key === "c" && (window.getSelection()?.toString().length ?? 0) > 0) {
        return;
      }
      const sel = useSidebarSelection.getState().selected;
      if (!sel) return;

      if (key === "c") {
        if (sel.kind === "table") {
          e.preventDefault();
          await writeTableClipboard({
            connectionId: sel.connectionId,
            schema: sel.schema,
            tables: [sel.table],
          });
        } else if (sel.kind === "schema") {
          const cache = useSchemaCache.getState().caches[sel.connectionId];
          const items = cache?.tables[sel.schema];
          if (!items || items.length === 0) return;
          e.preventDefault();
          await writeTableClipboard({
            connectionId: sel.connectionId,
            schema: sel.schema,
            tables: items.filter((x) => x.kind === "table").map((x) => x.name),
          });
        }
        return;
      }

      if (key === "v") {
        if (sel.kind !== "connection" && sel.kind !== "schema") return;
        const payload = await readTableClipboard();
        if (!payload) return;
        e.preventDefault();
        const conns = useConnections.getState().connections;
        const tgtConn = conns.find((c) => c.id === sel.connectionId);
        if (!tgtConn) return;
        const tgtSchema =
          sel.kind === "schema"
            ? sel.schema
            : tgtConn.default_database ?? payload.schema;
        newTab({
          label: t("tree.dataTransfer"),
          kind: {
            kind: "data-transfer",
            sourceConnectionId: payload.connectionId,
            sourceSchema: payload.schema,
            targetConnectionId: sel.connectionId,
            targetSchema: tgtSchema,
            tables: payload.tables,
            targetFolderName: payload.folderName,
          },
          accentColor: tgtConn.color,
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTab, t]);
}

function ConnectionNode({ conn }: { conn: ConnectionProfile }) {
  const active = useConnections((s) => s.active.has(conn.id));
  const open = useConnections((s) => s.open);
  const close = useConnections((s) => s.close);
  const remove = useConnections((s) => s.remove);
  const openTab = useTabs((s) => s.openOrFocus);
  const newTab = useTabs((s) => s.open);
  const invalidate = useSchemaCache((s) => s.invalidate);
  const bumpSchemaList = useSchemaCache((s) => s.bumpSchemaList);
  const clearPendingSchemaDrops = useSchemaCache(
    (s) => s.clearPendingSchemaDrops,
  );
  const schemaListTick = useSchemaCache((s) => s.schemaListTick[conn.id] ?? 0);
  const pendingSchemaDrops = useSchemaCache(
    (s) => s.pendingSchemaDrops[conn.id],
  );
  const t = useT();
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const isSelected =
    sidebarSelected?.kind === "connection" &&
    sidebarSelected.connectionId === conn.id;

  const [expanded, setExpanded] = useState(false);
  const [schemas, setSchemas] = useState<SchemaInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [dropHint, setDropHint] = useState<"above" | "below" | null>(null);

  const reorderConnectionRelativeTo = async (
    draggedId: string,
    targetId: string,
    above: boolean,
  ) => {
    const st = useConnections.getState();
    const all = st.connections;
    const target = all.find((c) => c.id === targetId);
    const dragged = all.find((c) => c.id === draggedId);
    if (!target || !dragged) return;

    // If folder changed, move first (same IPC for folder).
    if (dragged.folder_id !== target.folder_id) {
      await ipc.folders.move(draggedId, target.folder_id ?? null);
    }

    // Reorder within the same group (target's folder_id).
    const group = st.connections
      .filter((c) => c.folder_id === target.folder_id && c.id !== draggedId);
    const targetIdx = group.findIndex((c) => c.id === targetId);
    if (targetIdx < 0) {
      await st.refresh();
      return;
    }
    const insertAt = above ? targetIdx : targetIdx + 1;
    const reordered = [
      ...group.slice(0, insertAt),
      dragged,
      ...group.slice(insertAt),
    ];
    await ipc.connections.reorder(reordered.map((c) => c.id));
    await st.refresh();
  };
  const [error, setError] = useState<string | null>(null);

  const refreshSchemas = async () => {
    setLoading(true);
    try {
      const s = await ipc.db.listSchemas(conn.id);
      setSchemas(s);
      clearPendingSchemaDrops(conn.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-reload when someone (e.g. create/drop schema) bumps the tick.
  // Only refetch if the connection is active : otherwise the next connect handles it.
  useEffect(() => {
    if (schemaListTick === 0) return;
    if (!active) return;
    void refreshSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaListTick]);

  const handleClick = async () => {
    setError(null);
    if (!active) {
      setLoading(true);
      try {
        await open(conn.id);
        setExpanded(true);
        await refreshSchemas();
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!expanded) {
      setExpanded(true);
      if (!schemas) await refreshSchemas();
    } else {
      setExpanded(false);
    }
  };

  const editConn = () => {
    openTab(
      (tab) =>
        tab.kind.kind === "edit-connection" &&
        tab.kind.connectionId === conn.id,
      () => ({
        label: `${t("common.edit")} : ${conn.name}`,
        kind: { kind: "edit-connection", connectionId: conn.id },
        accentColor: conn.color,
      }),
    );
  };

  const newQuery = () => {
    newTab({
      label: t("tree.newQuery"),
      kind: {
        kind: "query",
        connectionId: conn.id,
        schema: conn.default_database ?? undefined,
      },
      accentColor: conn.color,
    });
  };

  const disconnect = async () => {
    const tabsState = useTabs.getState();
    const isRelated = (tab: { kind: Record<string, unknown> & { kind: string } }) => {
      const k = tab.kind;
      if ("connectionId" in k && k.connectionId === conn.id) return true;
      if ("sourceConnectionId" in k && k.sourceConnectionId === conn.id) return true;
      if ("targetConnectionId" in k && k.targetConnectionId === conn.id) return true;
      return false;
    };
    const relatedCount = tabsState.tabs.filter(isRelated).length;
    if (relatedCount > 0) {
      const ok = await appConfirm(
        t("tree.disconnectCloseTabs", {
          name: conn.name,
          count: relatedCount,
        }),
      );
      if (!ok) return;
      tabsState.closeMany(isRelated);
    }
    setExpanded(false);
    setSchemas(null);
    invalidate(conn.id);
    await close(conn.id);
  };

  const connect = async () => {
    setError(null);
    setLoading(true);
    try {
      await open(conn.id);
      setExpanded(true);
      await refreshSchemas();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const deleteConn = async () => {
    const ok = await appConfirm(t("tree.deleteConfirm", { name: conn.name }));
    if (!ok) return;
    invalidate(conn.id);
    await remove(conn.id);
  };

  const folders = useConnections((s) => s.folders);
  const refreshConns = useConnections((s) => s.refresh);
  const refreshFolders = useConnections((s) => s.refreshFolders);
  const moveToFolder = async (folderId: string | null) => {
    try {
      await ipc.folders.move(conn.id, folderId);
      await refreshConns();
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };
  const createFolderAndMove = async () => {
    const name = await appPrompt(t("sidebar.newFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      const f = await ipc.folders.create({ name: name.trim() });
      await refreshFolders();
      await moveToFolder(f.id);
    } catch (e) {
      await appAlert(t("tree.createFolderFailed", { error: String(e) }));
    }
  };

  const refresh = async () => {
    invalidate(conn.id);
    setSchemas(null);
    if (active && expanded) await refreshSchemas();
  };

  const openDataTransfer = () => {
    newTab({
      label: t("tree.dataTransfer"),
      kind: {
        kind: "data-transfer",
        sourceConnectionId: conn.id,
        sourceSchema: conn.default_database ?? undefined,
      },
      accentColor: conn.color,
    });
  };

  const openSqlImport = (schemaOverride?: string) => {
    newTab({
      label: t("tree.importLabel", { name: conn.name }),
      kind: {
        kind: "sql-import",
        targetConnectionId: conn.id,
        schema: schemaOverride ?? conn.default_database ?? undefined,
      },
      accentColor: conn.color,
    });
  };

  const openSlowQueries = () => {
    // Dialect-specific top-N slow queries. Requires the relevant
    // performance schema / extension to be enabled on the server.
    let sql: string | null = null;
    if (conn.driver === "mysql" || conn.driver === "mariadb") {
      sql = `-- Top slow queries (needs performance_schema enabled)
SELECT
  digest_text                                  AS query,
  count_star                                   AS calls,
  ROUND(avg_timer_wait / 1e9, 2)               AS avg_ms,
  ROUND(sum_timer_wait / 1e9, 2)               AS total_ms,
  sum_rows_examined                            AS rows_examined,
  sum_rows_sent                                AS rows_sent
FROM performance_schema.events_statements_summary_by_digest
WHERE digest_text IS NOT NULL
ORDER BY sum_timer_wait DESC
LIMIT 50;`;
    } else if (conn.driver === "postgres") {
      sql = `-- Top slow queries (needs the pg_stat_statements extension)
SELECT
  query,
  calls,
  ROUND(total_exec_time::numeric, 2)   AS total_ms,
  ROUND(mean_exec_time::numeric, 2)    AS avg_ms,
  rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 50;`;
    }
    if (!sql) return;
    newTab({
      label: t("tree.slowQueriesLabel", { name: conn.name }),
      kind: {
        kind: "query",
        connectionId: conn.id,
        schema: conn.default_database ?? undefined,
        initialSql: sql,
        autoRun: true,
      },
      accentColor: conn.color,
    });
  };

  const openHistory = () => {
    openTab(
      (tab) =>
        tab.kind.kind === "query-history" &&
        tab.kind.connectionId === conn.id,
      () => ({
        label: t("tree.historyLabel", { name: conn.name }),
        kind: { kind: "query-history", connectionId: conn.id },
        accentColor: conn.color,
      }),
    );
  };

  const refresh_ = useConnections((s) => s.refresh);

  const exportConnection = async () => {
    try {
      const includePasswords = await appConfirm(
        t("tree.exportConnPrompt", { name: conn.name }),
      );
      const payload = await ipc.portability.export(includePasswords);
      // Filter to just the clicked connection.
      const filtered = {
        ...payload,
        connections: payload.connections.filter((c) => c.name === conn.name),
      };
      if (filtered.connections.length === 0) {
        void appAlert(t("tree.connNotFoundInPayload"));
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `${conn.name.replace(/[^\w.-]/g, "_")}.bmconn`,
        filters: [{ name: "BaseMaster", extensions: ["bmconn", "json"] }],
      });
      if (!path) return;
      const bytes = new TextEncoder().encode(
        JSON.stringify(filtered, null, 2),
      );
      const { invoke: doInvoke } = await import("@tauri-apps/api/core");
      await doInvoke("save_file", { path, data: Array.from(bytes) });
    } catch (e) {
      void appAlert(t("tree.exportFailed", { error: String(e) }));
    }
  };

  const duplicateConnection = async () => {
    try {
      const payload = await ipc.portability.export(true);
      const src = payload.connections.find((c) => c.name === conn.name);
      if (!src) {
        void appAlert(t("tree.connNotFound"));
        return;
      }
      const dup = {
        ...payload,
        folders: [],
        connections: [
          { ...src, name: `${src.name} (${t("tree.duplicateCopySuffix")})` },
        ],
      };
      const n = await ipc.portability.importApply(dup);
      if (n > 0) await refresh_();
    } catch (e) {
      void appAlert(t("tree.duplicateFailed", { error: String(e) }));
    }
  };

  const invalidateForConn = useSchemaCache((s) => s.invalidateSchema);
  const ensureForConn = useSchemaCache((s) => s.ensureSnapshot);

  /** Paste onto the connection: reads clipboard, decides whether to open transfer or duplicate. */
  const pasteTables = async () => {
    const payload = await readTableClipboard();
    if (!payload) {
      await appAlert(t("tree.pasteInvalid"));
      return;
    }
    // Target assumed: this connection. Schema: ask which (prompt with default).
    const targetSchema = await appPrompt(t("tree.pasteSchemaPrompt"), {
      defaultValue: conn.default_database ?? payload.schema,
    });
    if (!targetSchema || !targetSchema.trim()) return;
    const tgtSchema = targetSchema.trim();

    const sameConn = payload.connectionId === conn.id;
    const sameSchema = sameConn && payload.schema === tgtSchema;
    if (sameConn && sameSchema) {
      // Same source: duplicate each one locally.
      try {
        const failed: string[] = [];
        for (const name of payload.tables) {
          try {
            const avail = await ipc.db.findAvailableTableName(
              conn.id,
              tgtSchema,
              name,
            );
            await ipc.db.duplicateTable(
              conn.id,
              tgtSchema,
              name,
              avail,
              true,
            );
          } catch (e) {
            failed.push(`${name}: ${e}`);
          }
        }
        invalidateForConn(conn.id, tgtSchema);
        await ensureForConn(conn.id, tgtSchema);
        if (failed.length > 0) {
          await appAlert(t("tree.pasteFailures", { list: failed.join("\n") }));
        }
      } catch (e) {
        await appAlert(t("tree.pasteFailed", { error: String(e) }));
      }
      return;
    }

    // Different source: open a pre-configured wizard.
    newTab({
      label: t("tree.dataTransfer"),
      kind: {
        kind: "data-transfer",
        sourceConnectionId: payload.connectionId,
        sourceSchema: payload.schema,
        targetConnectionId: conn.id,
        targetSchema: tgtSchema,
        tables: payload.tables,
        targetFolderName: payload.folderName,
      },
      accentColor: conn.color,
    });
  };

  // "Move to folder" items : one per existing folder + option to
  // create a new folder + option to remove from folder (go to root).
  const moveItems: ContextEntry[] = [
    ...folders.map<ContextEntry>((f) => ({
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToFolder", { name: f.name }),
      onClick: () => moveToFolder(f.id),
      disabled: conn.folder_id === f.id,
    })),
    {
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToNewFolder"),
      onClick: createFolderAndMove,
    },
    ...(conn.folder_id
      ? [
          {
            icon: <FolderIcon className="h-3.5 w-3.5" />,
            label: t("tree.removeFromFolder"),
            onClick: () => moveToFolder(null),
          } as ContextEntry,
        ]
      : []),
  ];

  const createDatabaseOrSchema = async () => {
    const name = await appPrompt(
      conn.driver === "postgres"
        ? t("tabs.newDatabasePromptPg")
        : t("tabs.newDatabasePromptMysql"),
    );
    if (!name || !name.trim()) return;
    const quoted =
      conn.driver === "postgres"
        ? `"${name.trim().replace(/"/g, '""')}"`
        : `\`${name.trim().replace(/`/g, "``")}\``;
    const keyword = conn.driver === "postgres" ? "SCHEMA" : "DATABASE";
    const sql = `CREATE ${keyword} ${quoted};`;
    try {
      await ipc.db.runQuery(conn.id, sql, null);
      bumpSchemaList(conn.id);
    } catch (e) {
      await appAlert(
        t("tree.createDbFailed", {
          name: name.trim(),
          error: String(e),
        }),
      );
    }
  };

  const openProcesses = () => {
    newTab({
      label: `${t("tree.processes")} · ${conn.name}`,
      kind: { kind: "processes", connectionId: conn.id },
      accentColor: conn.color,
    });
  };

  const openUsers = () => {
    newTab({
      label: `${t("tree.users")} · ${conn.name}`,
      kind: { kind: "users", connectionId: conn.id },
      accentColor: conn.color,
    });
  };

  const createSchemaFolderForConn = useSchemaFolders((s) => s.create);
  const createSchemaFolder = async () => {
    const name = await appPrompt(t("tree.schemaFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      await createSchemaFolderForConn(conn.id, name.trim());
    } catch (e) {
      void appAlert(t("tree.createFolderFailed", { error: String(e) }));
    }
  };

  const menuItems: ContextEntry[] = active
    ? [
        { icon: <FileCode2 className="h-3.5 w-3.5" />, label: t("tree.newQuery"), onClick: newQuery },
        { icon: <Database className="h-3.5 w-3.5" />, label: conn.driver === "postgres" ? t("tabs.newDatabaseLabelPg") : t("tabs.newDatabaseLabelMysql"), onClick: createDatabaseOrSchema },
        { icon: <ClipboardPaste className="h-3.5 w-3.5" />, label: t("tree.pasteTables"), onClick: pasteTables },
        { icon: <ArrowRightLeft className="h-3.5 w-3.5" />, label: t("tree.dataTransfer"), onClick: openDataTransfer },
        { icon: <Upload className="h-3.5 w-3.5" />, label: t("tree.sqlImport"), onClick: () => openSqlImport() },
        { icon: <History className="h-3.5 w-3.5" />, label: t("tree.queryHistory"), onClick: openHistory },
        ...(conn.driver !== "sqlite"
          ? [
              {
                icon: <Gauge className="h-3.5 w-3.5" />,
                label: t("tree.slowQueries"),
                onClick: openSlowQueries,
              } as ContextEntry,
            ]
          : []),
        { icon: <Cog className="h-3.5 w-3.5" />, label: t("tree.processes"), onClick: openProcesses },
        { icon: <Plug className="h-3.5 w-3.5" />, label: t("tree.users"), onClick: openUsers },
        { icon: <FolderIcon className="h-3.5 w-3.5" />, label: t("tree.newSchemaFolder"), onClick: createSchemaFolder },
        { icon: <RefreshCw className="h-3.5 w-3.5" />, label: t("common.refresh"), onClick: refresh },
        { icon: <Unplug className="h-3.5 w-3.5" />, label: t("tree.disconnect"), onClick: disconnect, variant: "warning" },
        { separator: true },
        ...moveItems,
        { separator: true },
        { icon: <Pencil className="h-3.5 w-3.5" />, label: t("tree.editConnection"), onClick: editConn },
        { icon: <Copy className="h-3.5 w-3.5" />, label: t("tree.duplicateConnection"), onClick: duplicateConnection },
        { icon: <Download className="h-3.5 w-3.5" />, label: t("tree.exportConnection"), onClick: exportConnection },
        { icon: <Trash2 className="h-3.5 w-3.5" />, label: t("tree.deleteConnection"), onClick: deleteConn, variant: "destructive" },
      ]
    : [
        { icon: <Plug className="h-3.5 w-3.5" />, label: t("tree.connect"), onClick: connect },
        { separator: true },
        ...moveItems,
        { separator: true },
        { icon: <Pencil className="h-3.5 w-3.5" />, label: t("tree.editConnection"), onClick: editConn },
        { icon: <Copy className="h-3.5 w-3.5" />, label: t("tree.duplicateConnection"), onClick: duplicateConnection },
        { icon: <Download className="h-3.5 w-3.5" />, label: t("tree.exportConnection"), onClick: exportConnection },
        { icon: <Trash2 className="h-3.5 w-3.5" />, label: t("tree.deleteConnection"), onClick: deleteConn, variant: "destructive" },
      ];

  const menu = useContextMenu(menuItems);

  return (
    <li
      style={
        // Always re-scope --conn-accent per connection so it doesn't inherit
        // the root's (App.tsx sets it based on the active tab). Without this,
        // editing a connection's color in the form would visually leak to
        // any connection without its own color.
        {
          "--conn-accent": conn.color ?? "var(--conn-accent-default)",
        } as React.CSSProperties
      }
    >
      <div
        className={cn(
          "group relative flex h-7 cursor-grab select-none items-center gap-1.5 rounded-md px-1.5 text-sm transition-colors active:cursor-grabbing",
          isSelected
            ? "bg-conn-accent/30 text-foreground ring-1 ring-conn-accent/60"
            : active
              ? "bg-conn-accent/15 text-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          dropHint === "above" && "border-t-2 border-conn-accent",
          dropHint === "below" && "border-b-2 border-conn-accent",
        )}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-basemaster-connection",
            conn.id,
          );
          e.dataTransfer.setData("text/plain", conn.name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (
            !e.dataTransfer.types.includes(
              "application/x-basemaster-connection",
            )
          )
            return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          setDropHint(e.clientY < mid ? "above" : "below");
        }}
        onDragLeave={() => setDropHint(null)}
        onDrop={async (e) => {
          e.preventDefault();
          const draggedId = e.dataTransfer.getData(
            "application/x-basemaster-connection",
          );
          const wantAbove = dropHint === "above";
          setDropHint(null);
          if (!draggedId || draggedId === conn.id) return;
          try {
            await reorderConnectionRelativeTo(draggedId, conn.id, wantAbove);
          } catch (err) {
            void appAlert(t("tree.reorderFailed", { error: String(err) }));
          }
        }}
        onClick={() => {
          setSidebarSelected({
            kind: "connection",
            connectionId: conn.id,
            color: conn.color,
          });
          void handleClick();
        }}
        onContextMenu={menu.openAt}
      >
        <span className="grid h-4 w-4 place-items-center text-muted-foreground">
          {loading && !expanded ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>

        <DriverIcon driver={conn.driver} active={active} color={conn.color} />

        <span className="flex-1 truncate">{conn.name}</span>

        <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-popover/95 px-1 py-0.5 shadow-md ring-1 ring-border backdrop-blur-sm group-hover:flex">
          {active && (
            <>
              <IconBtn title={t("tree.newQuery")} onClick={newQuery}>
                <FileCode2 className="h-3 w-3" />
              </IconBtn>
              <IconBtn title={t("tree.disconnect")} onClick={disconnect} warning>
                <Unplug className="h-3 w-3" />
              </IconBtn>
            </>
          )}
          <IconBtn title={t("common.edit")} onClick={editConn}>
            <Pencil className="h-3 w-3" />
          </IconBtn>
          <IconBtn title={t("common.delete")} onClick={deleteConn} destructive>
            <Trash2 className="h-3 w-3" />
          </IconBtn>
        </div>
      </div>

      {menu.element}

      {/* Erro de conexão : sempre visível sob o item, mesmo colapsado.
          Senão o usuário só vê o spinner rodando e depois parar em silêncio. */}
      {error && !expanded && (
        <div className="ml-6 mr-1.5 my-1 flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          <span className="shrink-0 font-bold">!</span>
          <span className="flex-1 break-words font-mono leading-tight">
            {error}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setError(null);
            }}
            className="shrink-0 opacity-60 hover:opacity-100"
            title={t("common.dismiss")}
          >
            ×
          </button>
        </div>
      )}

      {expanded && (
        <ul
          className={cn(
            "ml-4 grid gap-0.5 border-l pl-1",
            active
              ? "border-conn-accent/40 bg-conn-accent/5"
              : "border-border",
          )}
          onDragOver={(e) => {
            if (
              e.dataTransfer.types.includes(
                "application/x-basemaster-schema",
              ) &&
              e.dataTransfer.getData(
                "application/x-basemaster-schema-conn",
              ) === conn.id
            ) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={async (e) => {
            const sourceConn = e.dataTransfer.getData(
              "application/x-basemaster-schema-conn",
            );
            const schemaName = e.dataTransfer.getData(
              "application/x-basemaster-schema",
            );
            if (sourceConn !== conn.id || !schemaName) return;
            // Only act if the schema was actually inside a folder.
            const cur = useSchemaFolders
              .getState()
              .assignments[conn.id]?.[schemaName];
            if (!cur) return;
            e.preventDefault();
            try {
              await useSchemaFolders
                .getState()
                .move(conn.id, schemaName, null);
            } catch (err) {
              void appAlert(t("tree.moveFailed", { error: String(err) }));
            }
          }}
        >
          {error && (
            <li className="px-1.5 py-1 text-xs text-destructive">{error}</li>
          )}
          {!error && schemas && (
            <SchemasList
              conn={conn}
              schemas={
                pendingSchemaDrops && pendingSchemaDrops.length > 0
                  ? schemas.filter(
                      (s) => !pendingSchemaDrops.includes(s.name),
                    )
                  : schemas
              }
            />
          )}
          {!error && !schemas && (
            <li className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("common.loading")}
            </li>
          )}
          {!error && schemas?.length === 0 && (
            <li className="px-1.5 py-1 text-xs italic text-muted-foreground">
              {t("tree.noSchemas")}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

const SYSTEM_SCHEMAS_MYSQL = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
]);
const SYSTEM_SCHEMAS_POSTGRES = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
]);

function isSystemSchema(driver: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (driver === "postgres") {
    if (SYSTEM_SCHEMAS_POSTGRES.has(lower)) return true;
    // Schemas pg_temp_*, pg_toast_* are also internal.
    if (lower.startsWith("pg_temp_") || lower.startsWith("pg_toast_")) return true;
    return false;
  }
  return SYSTEM_SCHEMAS_MYSQL.has(lower);
}

// Natural sort: "sis_2" < "sis_10" < "sis_100". Backend orders lexically,
// but for humans the order "1, 2, 10, 100" is expected (Navicat, Explorer etc).
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function SchemasList({
  conn,
  schemas,
}: {
  conn: ConnectionProfile;
  schemas: SchemaInfo[];
}) {
  const ensureFolders = useSchemaFolders((s) => s.ensure);
  const folders = useSchemaFolders((s) => s.folders[conn.id]);
  const assignments = useSchemaFolders((s) => s.assignments[conn.id]);

  useEffect(() => {
    void ensureFolders(conn.id).catch(() => {});
  }, [conn.id, ensureFolders]);

  const { user, system } = useMemo(() => {
    const u: SchemaInfo[] = [];
    const s: SchemaInfo[] = [];
    for (const sc of schemas) {
      if (isSystemSchema(conn.driver, sc.name)) s.push(sc);
      else u.push(sc);
    }
    u.sort((a, b) => naturalCollator.compare(a.name, b.name));
    s.sort((a, b) => naturalCollator.compare(a.name, b.name));
    return { user: u, system: s };
  }, [schemas, conn.driver]);

  // Split user schemas into (a) those with a folder assignment and
  // (b) loose ones. Folders render first, loose schemas after.
  const { groupedByFolder, loose } = useMemo(() => {
    const grouped: Record<Uuid, SchemaInfo[]> = {};
    const lose: SchemaInfo[] = [];
    for (const sc of user) {
      const fid = assignments?.[sc.name];
      if (fid) {
        (grouped[fid] ??= []).push(sc);
      } else {
        lose.push(sc);
      }
    }
    return { groupedByFolder: grouped, loose: lose };
  }, [user, assignments]);

  return (
    <>
      {(folders ?? []).map((f) => (
        <SchemaFolderNode
          key={f.id}
          conn={conn}
          folder={f}
          schemas={groupedByFolder[f.id] ?? []}
        />
      ))}
      {loose.map((s) => (
        <SchemaNode key={s.name} conn={conn} schema={s} />
      ))}
      {system.length > 0 && (
        <EngineSchemasGroup conn={conn} schemas={system} />
      )}
    </>
  );
}

function EngineSchemasGroup({
  conn,
  schemas,
}: {
  conn: ConnectionProfile;
  schemas: SchemaInfo[];
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const query = useSidebarFilter((s) => s.query);
  // If the filter matches an internal name, auto-expand.
  const anyMatch = query
    ? schemas.some((s) => matches(s.name, query))
    : false;
  const effectiveExpanded = expanded || anyMatch;

  // If filter is active and no system schema matches, hide the whole group.
  if (query && !anyMatch) return null;

  return (
    <li>
      <div
        onClick={() => setExpanded((e) => !e)}
        className="group flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground/70 hover:bg-accent/40"
      >
        <span className="grid h-4 w-4 place-items-center">
          {effectiveExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <FolderIcon className="h-3 w-3 shrink-0" />
        <span className="flex-1 truncate italic">{t("tree.engineSchemas")}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {schemas.length}
        </span>
      </div>
      {effectiveExpanded && (
        <ul className="ml-4 border-l border-border/60 pl-1">
          {schemas.map((s) => (
            <SchemaNode key={s.name} conn={conn} schema={s} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SchemaNode({
  conn,
  schema,
}: {
  conn: ConnectionProfile;
  schema: SchemaInfo;
}) {
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const invalidateSchema = useSchemaCache((s) => s.invalidateSchema);
  const bumpSchemaList = useSchemaCache((s) => s.bumpSchemaList);
  const tables = useSchemaCache((s) => s.caches[conn.id]?.tables[schema.name]);
  const newTab = useTabs((s) => s.open);
  const t = useT();
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const savedQueriesCache = useSavedQueries((s) => s.cache[conn.id]);
  const isSelected =
    sidebarSelected?.kind === "schema" &&
    sidebarSelected.connectionId === conn.id &&
    sidebarSelected.schema === schema.name;

  const query = useSidebarFilter((s) => s.query);
  const schemaMatches = matches(schema.name, query);

  const [expanded, setExpanded] = useState(false);

  // We only consider matches inside a schema when it is EXPANDED
  // (already opened by the user). Closed schemas are out of search scope.
  const hasMatchingTable = useMemo(() => {
    if (!query || !expanded || !tables) return false;
    return tables.some((tb) => matches(tb.name, query));
  }, [tables, query, expanded]);
  const hasMatchingSavedQuery = useMemo(() => {
    if (!query || !expanded || !savedQueriesCache) return false;
    return filterBySchema(savedQueriesCache, schema.name).some((q) =>
      matches(q.name, query),
    );
  }, [savedQueriesCache, schema.name, query, expanded]);
  const hiddenByFilter =
    !!query && !schemaMatches && !hasMatchingTable && !hasMatchingSavedQuery;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureSnapshot(conn.id, schema.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-expand if it's the connection's default database.
  useEffect(() => {
    if (conn.default_database === schema.name && !expanded) {
      setExpanded(true);
      if (!tables) load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!tables) await load();
  };

  const newQuery = () => {
    newTab({
      label: t("tree.queryLabel", { name: schema.name }),
      kind: { kind: "query", connectionId: conn.id, schema: schema.name },
      accentColor: conn.color,
    });
  };

  const refresh = async () => {
    invalidateSchema(conn.id, schema.name);
    if (expanded) await load();
  };

  const newDumpTab = useTabs((s) => s.open);
  const openSchemaDump = () => {
    newDumpTab({
      label: t("tree.dumpLabel", { name: schema.name }),
      kind: {
        kind: "sql-dump",
        sourceConnectionId: conn.id,
        scopes: [{ schema: schema.name }],
      },
      accentColor: conn.color,
    });
  };

  const renameSchema = async () => {
    const next = await appPrompt(t("tree.renameSchemaPrompt"), {
      defaultValue: schema.name,
    });
    if (!next || !next.trim() || next === schema.name) return;
    const ok = await appConfirm(
      t("tree.renameSchemaConfirm", { old: schema.name, next }),
    );
    if (!ok) return;
    try {
      // Open a progress tab: the operation is a serial table-by-table
      // RENAME and may take long. The tab subscribes to schema_rename:*
      // events and starts the rename on mount.
      useTabs.getState().open({
        label: t("schemaRename.tabLabel", { name: schema.name }),
        kind: {
          kind: "schema-rename",
          connectionId: conn.id,
          from: schema.name,
          to: next.trim(),
        },
        accentColor: conn.color ?? null,
      });
      // The view itself will close pre-existing tabs and invalidate the cache
      // when the rename completes; keep this catch only for surface errors.
    } catch (e) {
      await appAlert(t("tree.renameTableErr", { error: String(e) }));
    }
  };

  const newTableHere = () =>
    useTabs.getState().open({
      label: t("newTable.tabLabel", { schema: schema.name }),
      kind: {
        kind: "new-table",
        connectionId: conn.id,
        schema: schema.name,
      },
      accentColor: conn.color,
    });

  const newDumpTabForImport = useTabs((s) => s.open);
  const openSchemaImport = () => {
    newDumpTabForImport({
      label: t("tree.importLabel", { name: schema.name }),
      kind: {
        kind: "sql-import",
        targetConnectionId: conn.id,
        schema: schema.name,
      },
      accentColor: conn.color,
    });
  };

  const dbLabel = conn.driver === "postgres" ? t("tree.dbLabelSchema") : t("tree.dbLabelDatabase");

  const createSiblingDatabase = async () => {
    const name = await appPrompt(
      conn.driver === "postgres"
        ? t("tabs.newDatabasePromptPg")
        : t("tabs.newDatabasePromptMysql"),
    );
    if (!name || !name.trim()) return;
    const isPg = conn.driver === "postgres";
    const quoted = isPg
      ? `"${name.trim().replace(/"/g, '""')}"`
      : `\`${name.trim().replace(/`/g, "``")}\``;
    const keyword = isPg ? "SCHEMA" : "DATABASE";
    try {
      await ipc.db.runQuery(conn.id, `CREATE ${keyword} ${quoted};`, null);
      bumpSchemaList(conn.id);
    } catch (e) {
      await appAlert(
        t("tree.createDbFailed", {
          name: name.trim(),
          error: String(e),
        }),
      );
    }
  };

  const dropSchema = async () => {
    const ok = await confirmDestructive({
      title: t("tree.dropDbTitle", { kind: dbLabel, name: schema.name }),
      description: t("tree.dropDbBody"),
      items: [schema.name],
      confirmLabel: t("tree.dropDbConfirmLabel", { kind: dbLabel }),
      checkboxLabel: t("tree.destructiveAck"),
      connectionName: conn.name,
      connectionColor: conn.color ?? null,
    });
    if (!ok) return;
    const isPg = conn.driver === "postgres";
    const quoted = isPg
      ? `"${schema.name.replace(/"/g, '""')}"`
      : `\`${schema.name.replace(/`/g, "``")}\``;
    const keyword = isPg ? "SCHEMA" : "DATABASE";
    const cascade = isPg ? " CASCADE" : "";
    const sql = `DROP ${keyword} ${quoted}${cascade};`;
    try {
      await ipc.db.runQuery(conn.id, sql, null);
      // Optimistic remove: tombstone hides the row immediately while
      // refreshSchemas (triggered via bumpSchemaList) is in flight.
      useSchemaCache.getState().markSchemaDropped(conn.id, schema.name);
      invalidateSchema(conn.id, schema.name);
      bumpSchemaList(conn.id);
    } catch (e) {
      await appAlert(t("tree.dropDbFailed", { error: String(e) }));
    }
  };

  // Copy ALL tables in the schema to the clipboard : shortcut for
  // transfer/paste to another connection without opening the listing.
  const copyAllTables = async () => {
    try {
      const snap = await ensureSnapshot(conn.id, schema.name);
      const tableNames = snap
        .filter((tb) => tb.kind !== "view" && tb.kind !== "materialized_view")
        .map((tb) => tb.name);
      if (tableNames.length === 0) {
        void appAlert(t("tree.noTables"));
        return;
      }
      await writeTableClipboard({
        connectionId: conn.id,
        schema: schema.name,
        tables: tableNames,
      });
    } catch (e) {
      void appAlert(t("tree.pasteFailed", { error: String(e) }));
    }
  };

  const pasteTablesHere = async () => {
    const payload = await readTableClipboard();
    if (!payload) {
      void appAlert(t("tree.pasteInvalid"));
      return;
    }
    const sameConn = payload.connectionId === conn.id;
    const sameSchema = sameConn && payload.schema === schema.name;

    if (sameConn && sameSchema) {
      // Same schema: duplicate each one (_copy, _copy_1…).
      const failed: string[] = [];
      for (const name of payload.tables) {
        try {
          const avail = await ipc.db.findAvailableTableName(
            conn.id,
            schema.name,
            name,
          );
          await ipc.db.duplicateTable(
            conn.id,
            schema.name,
            name,
            avail,
            true,
          );
        } catch (e) {
          failed.push(`${name}: ${e}`);
        }
      }
      invalidateSchema(conn.id, schema.name);
      await ensureSnapshot(conn.id, schema.name);
      if (failed.length > 0) {
        void appAlert(t("tree.pasteFailures", { list: failed.join("\n") }));
      }
      return;
    }

    // Different source: open a pre-configured wizard.
    newTab({
      label: t("tree.dataTransfer"),
      kind: {
        kind: "data-transfer",
        sourceConnectionId: payload.connectionId,
        sourceSchema: payload.schema,
        targetConnectionId: conn.id,
        targetSchema: schema.name,
        tables: payload.tables,
        targetFolderName: payload.folderName,
      },
      accentColor: conn.color,
    });
  };

  const schemaFolders = useSchemaFolders((s) => s.folders[conn.id]) ?? [];
  const schemaAssignments =
    useSchemaFolders((s) => s.assignments[conn.id]) ?? {};
  const moveSchemaToFolder = useSchemaFolders((s) => s.move);
  const createSchemaFolderForConn = useSchemaFolders((s) => s.create);
  const createTableFolderForSchema = useTableFolders((s) => s.create);
  const currentSchemaFolderId = schemaAssignments[schema.name];

  const moveToFolderItems: ContextEntry[] = [
    ...schemaFolders.map<ContextEntry>((f) => ({
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToFolder", { name: f.name }),
      onClick: async () => {
        try {
          await moveSchemaToFolder(conn.id, schema.name, f.id);
        } catch (e) {
          void appAlert(t("tree.moveFailed", { error: String(e) }));
        }
      },
      disabled: currentSchemaFolderId === f.id,
    })),
    {
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToNewFolder"),
      onClick: async () => {
        const name = await appPrompt(t("tree.schemaFolderPrompt"));
        if (!name || !name.trim()) return;
        try {
          const f = await createSchemaFolderForConn(conn.id, name.trim());
          await moveSchemaToFolder(conn.id, schema.name, f.id);
        } catch (e) {
          void appAlert(t("tree.moveFailed", { error: String(e) }));
        }
      },
    },
    ...(currentSchemaFolderId
      ? [
          {
            icon: <FolderIcon className="h-3.5 w-3.5" />,
            label: t("tree.removeFromFolder"),
            onClick: async () => {
              try {
                await moveSchemaToFolder(conn.id, schema.name, null);
              } catch (e) {
                void appAlert(t("tree.moveFailed", { error: String(e) }));
              }
            },
          } as ContextEntry,
        ]
      : []),
  ];

  const newTableFolder = async () => {
    const name = await appPrompt(t("tree.tableFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      await createTableFolderForSchema(conn.id, schema.name, name.trim());
    } catch (e) {
      void appAlert(t("tree.createFolderFailed", { error: String(e) }));
    }
  };

  const menu = useContextMenu([
    { icon: <FileCode2 className="h-3.5 w-3.5" />, label: t("tree.newQuerySchema"), onClick: newQuery },
    { icon: <Plus className="h-3.5 w-3.5" />, label: t("tree.newTable"), onClick: newTableHere },
    { icon: <FolderIcon className="h-3.5 w-3.5" />, label: t("tree.newTableFolder"), onClick: newTableFolder },
    { icon: <Database className="h-3.5 w-3.5" />, label: t("tree.newDbSibling", { kind: dbLabel }), onClick: createSiblingDatabase },
    { separator: true },
    { icon: <Copy className="h-3.5 w-3.5" />, label: t("tree.copyTables"), onClick: copyAllTables },
    { icon: <ClipboardPaste className="h-3.5 w-3.5" />, label: t("tree.pasteTables"), onClick: pasteTablesHere },
    { separator: true },
    {
      submenu: true,
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToFolderMenu"),
      items: moveToFolderItems,
    },
    { separator: true },
    { icon: <FileText className="h-3.5 w-3.5" />, label: t("tree.sqlDump"), onClick: openSchemaDump },
    { icon: <Upload className="h-3.5 w-3.5" />, label: t("tree.sqlImport"), onClick: openSchemaImport },
    { separator: true },
    { icon: <Pencil className="h-3.5 w-3.5" />, label: t("tree.rename"), onClick: renameSchema },
    { icon: <RefreshCw className="h-3.5 w-3.5" />, label: t("common.refresh"), onClick: refresh },
    { separator: true },
    { icon: <Trash2 className="h-3.5 w-3.5" />, label: t("tree.dropDbLabel", { kind: dbLabel }), onClick: dropSchema, variant: "destructive" },
  ]);

  if (hiddenByFilter) return null;

  return (
    <li>
      <div
        className={cn(
          "group relative flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors",
          isSelected
            ? "bg-conn-accent/25 text-foreground ring-1 ring-conn-accent/60"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-basemaster-schema",
            schema.name,
          );
          e.dataTransfer.setData(
            "application/x-basemaster-schema-conn",
            conn.id,
          );
          e.dataTransfer.setData("text/plain", schema.name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => {
          setSidebarSelected({
            kind: "schema",
            connectionId: conn.id,
            schema: schema.name,
            color: conn.color,
          });
          void handleClick();
        }}
        onContextMenu={menu.openAt}
      >
        <span className="grid h-4 w-4 place-items-center">
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <Database
          className={cn(
            "h-3 w-3 shrink-0",
            expanded && "fill-conn-accent/30 text-conn-accent",
          )}
        />
        <HighlightText
          text={schema.name}
          query={query}
          className={cn(
            "flex-1 truncate",
            expanded && "font-medium text-foreground",
          )}
        />
        {tables && (
          <span className="text-[10px] tabular-nums text-muted-foreground/60">
            {tables.length}
          </span>
        )}
      </div>

      {menu.element}

      {expanded && (
        <ul
          className="ml-4 grid gap-0.5 border-l border-border pl-1"
          onDragOver={(e) => {
            if (
              e.dataTransfer.types.includes(
                "application/x-basemaster-table",
              ) &&
              e.dataTransfer.getData(
                "application/x-basemaster-table-conn",
              ) === conn.id &&
              e.dataTransfer.getData(
                "application/x-basemaster-table-schema",
              ) === schema.name
            ) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={async (e) => {
            const sourceConn = e.dataTransfer.getData(
              "application/x-basemaster-table-conn",
            );
            const sourceSchema = e.dataTransfer.getData(
              "application/x-basemaster-table-schema",
            );
            const tableName = e.dataTransfer.getData(
              "application/x-basemaster-table",
            );
            if (
              sourceConn !== conn.id ||
              sourceSchema !== schema.name ||
              !tableName
            ) {
              return;
            }
            const cur = useTableFolders
              .getState()
              .assignments[`${conn.id}:${schema.name}`]?.[tableName];
            if (!cur) return;
            e.preventDefault();
            try {
              await useTableFolders
                .getState()
                .move(conn.id, schema.name, tableName, null);
            } catch (err) {
              void appAlert(t("tree.moveFailed", { error: String(err) }));
            }
          }}
        >
          {error && (
            <li className="px-1.5 py-1 text-[11px] text-destructive">
              {error}
            </li>
          )}
          {!error && tables && (
            <CategoryGroup conn={conn} schema={schema.name} tables={tables} />
          )}
          {!error && !tables && loading && (
            <li className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("tree.indexing")}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function SchemaFolderNode({
  conn,
  folder,
  schemas,
}: {
  conn: ConnectionProfile;
  folder: SchemaFolder;
  schemas: readonly SchemaInfo[];
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const renameFolder = useSchemaFolders((s) => s.rename);
  const deleteFolder = useSchemaFolders((s) => s.delete);
  const moveSchema = useSchemaFolders((s) => s.move);

  const handleRename = async () => {
    const next = await appPrompt(t("tree.renameFolderPrompt"), {
      defaultValue: folder.name,
    });
    if (!next || !next.trim() || next === folder.name) return;
    try {
      await renameFolder(conn.id, folder.id, next.trim());
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };

  const handleDelete = async () => {
    const ok = await appConfirm(
      t("tree.deleteFolderConfirm", { name: folder.name }),
    );
    if (!ok) return;
    try {
      await deleteFolder(conn.id, folder.id);
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };

  const handleDrop = async (schemaName: string) => {
    try {
      await moveSchema(conn.id, schemaName, folder.id);
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };

  const menu = useContextMenu([
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: t("tree.renameFolder"),
      onClick: handleRename,
    },
    {
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: t("tree.deleteFolder"),
      onClick: handleDelete,
      variant: "destructive",
    },
  ]);

  return (
    <li>
      <div
        onClick={() => setExpanded((e) => !e)}
        onContextMenu={menu.openAt}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes("application/x-basemaster-schema") &&
            e.dataTransfer.getData("application/x-basemaster-schema-conn") ===
              conn.id
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          const sourceConn = e.dataTransfer.getData(
            "application/x-basemaster-schema-conn",
          );
          const schemaName = e.dataTransfer.getData(
            "application/x-basemaster-schema",
          );
          if (sourceConn !== conn.id || !schemaName) return;
          e.preventDefault();
          e.stopPropagation();
          void handleDrop(schemaName);
        }}
        className="group flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        title={folder.name}
      >
        <span className="grid h-4 w-4 place-items-center">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <FolderIcon className="h-3 w-3 shrink-0" />
        <span className="flex-1 truncate font-medium">{folder.name}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {schemas.length}
        </span>
      </div>
      {menu.element}
      {expanded && (
        <ul className="ml-4 grid gap-0.5 border-l border-border/60 pl-1">
          {schemas.length === 0 ? (
            <li className="px-1.5 py-0.5 text-[11px] italic text-muted-foreground/60">
              {t("tree.folderEmpty")}
            </li>
          ) : (
            schemas.map((s) => (
              <SchemaNode key={s.name} conn={conn} schema={s} />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

function TableFolderNode({
  conn,
  schema,
  folder,
  tables,
}: {
  conn: ConnectionProfile;
  schema: string;
  folder: TableFolder;
  tables: readonly TableInfo[];
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const renameFolder = useTableFolders((s) => s.rename);
  const deleteFolder = useTableFolders((s) => s.delete);
  const moveTable = useTableFolders((s) => s.move);

  const handleRename = async () => {
    const next = await appPrompt(t("tree.renameFolderPrompt"), {
      defaultValue: folder.name,
    });
    if (!next || !next.trim() || next === folder.name) return;
    try {
      await renameFolder(conn.id, schema, folder.id, next.trim());
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };

  const handleDelete = async () => {
    const ok = await appConfirm(
      t("tree.deleteFolderConfirm", { name: folder.name }),
    );
    if (!ok) return;
    try {
      await deleteFolder(conn.id, schema, folder.id);
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };

  const handleDrop = async (tableName: string) => {
    try {
      await moveTable(conn.id, schema, tableName, folder.id);
    } catch (e) {
      void appAlert(t("tree.moveFailed", { error: String(e) }));
    }
  };

  const handleCopyFolder = async () => {
    const tableNames = tables
      .filter((it) => it.kind !== "view" && it.kind !== "materialized_view")
      .map((it) => it.name);
    if (tableNames.length === 0) {
      void appAlert(t("tree.noTables"));
      return;
    }
    try {
      await writeTableClipboard({
        connectionId: conn.id,
        schema,
        tables: tableNames,
        folderName: folder.name,
      });
    } catch (e) {
      void appAlert(t("tree.pasteFailed", { error: String(e) }));
    }
  };

  const menu = useContextMenu([
    {
      icon: <Copy className="h-3.5 w-3.5" />,
      label: t("tree.copyTables"),
      onClick: handleCopyFolder,
    },
    { separator: true },
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: t("tree.renameFolder"),
      onClick: handleRename,
    },
    {
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: t("tree.deleteFolder"),
      onClick: handleDelete,
      variant: "destructive",
    },
  ]);

  return (
    <li>
      <div
        onClick={() => setExpanded((e) => !e)}
        onContextMenu={menu.openAt}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes("application/x-basemaster-table") &&
            e.dataTransfer.getData("application/x-basemaster-table-conn") ===
              conn.id &&
            e.dataTransfer.getData("application/x-basemaster-table-schema") ===
              schema
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          const sourceConn = e.dataTransfer.getData(
            "application/x-basemaster-table-conn",
          );
          const sourceSchema = e.dataTransfer.getData(
            "application/x-basemaster-table-schema",
          );
          const tableName = e.dataTransfer.getData(
            "application/x-basemaster-table",
          );
          if (
            sourceConn !== conn.id ||
            sourceSchema !== schema ||
            !tableName
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          void handleDrop(tableName);
        }}
        className="group flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        title={folder.name}
      >
        <span className="grid h-4 w-4 place-items-center">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <FolderIcon className="h-3 w-3 shrink-0" />
        <span className="flex-1 truncate">{folder.name}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {tables.length}
        </span>
      </div>
      {menu.element}
      {expanded && (
        <ul className="ml-4 grid gap-0.5 border-l border-border/60 pl-1">
          {tables.length === 0 ? (
            <li className="px-1.5 py-0.5 text-[11px] italic text-muted-foreground/60">
              {t("tree.folderEmpty")}
            </li>
          ) : (
            tables.map((it) => <TableNode key={it.name} conn={conn} table={it} />)
          )}
        </ul>
      )}
    </li>
  );
}

/** Groups schema items into categories (Tables / Views / Functions /
 *  Procedures / Saved queries). Functions/Procedures/Queries are
 *  placeholders until the backend exposes them. */
function CategoryGroup({
  conn,
  schema,
  tables,
}: {
  conn: ConnectionProfile;
  schema: string;
  tables: readonly TableInfo[];
}) {
  const t = useT();
  const newTab = useTabs((s) => s.openOrFocus);
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const setOrderedList = useSidebarMultiSelect((s) => s.setOrderedList);
  const tablesSelected =
    sidebarSelected?.kind === "category" &&
    sidebarSelected.connectionId === conn.id &&
    sidebarSelected.schema === schema &&
    sidebarSelected.category === "tables";
  const viewsSelected =
    sidebarSelected?.kind === "category" &&
    sidebarSelected.connectionId === conn.id &&
    sidebarSelected.schema === schema &&
    sidebarSelected.category === "views";
  const query = useSidebarFilter((s) => s.query);
  // If the schema already matches the query, show everything. Otherwise filter by name.
  const schemaMatches = matches(schema, query);
  const { tableList, viewList } = useMemo(() => {
    const tL: TableInfo[] = [];
    const v: TableInfo[] = [];
    for (const it of tables) {
      if (!schemaMatches && !matches(it.name, query)) continue;
      if (it.kind === "view" || it.kind === "materialized_view") v.push(it);
      else tL.push(it);
    }
    return { tableList: tL, viewList: v };
  }, [tables, query, schemaMatches]);

  const ensureTableFolders = useTableFolders((s) => s.ensure);
  const tableFolders = useTableFolders(
    (s) => s.folders[`${conn.id}:${schema}`],
  );
  const tableAssignments = useTableFolders(
    (s) => s.assignments[`${conn.id}:${schema}`],
  );

  useEffect(() => {
    void ensureTableFolders(conn.id, schema).catch(() => {});
  }, [conn.id, schema, ensureTableFolders]);

  const { groupedTables, looseTables } = useMemo(() => {
    const grouped: Record<Uuid, TableInfo[]> = {};
    const lose: TableInfo[] = [];
    for (const it of tableList) {
      const fid = tableAssignments?.[it.name];
      if (fid) (grouped[fid] ??= []).push(it);
      else lose.push(it);
    }
    return { groupedTables: grouped, looseTables: lose };
  }, [tableList, tableAssignments]);

  // Keep the multi-select store in sync with the visible list :
  // shift+click needs the ordered range to work.
  useEffect(() => {
    setOrderedList(
      { connectionId: conn.id, schema },
      tableList.map((t) => t.name),
    );
  }, [conn.id, schema, tableList, setOrderedList]);

  const selectCategory = (category: "tables" | "views" | "queries") => {
    setSidebarSelected({
      kind: "category",
      connectionId: conn.id,
      schema,
      category,
      color: conn.color,
    });
  };

  const openTablesList = () => {
    selectCategory("tables");
    newTab(
      (tab) =>
        tab.kind.kind === "tables-list" &&
        tab.kind.connectionId === conn.id &&
        tab.kind.schema === schema &&
        (tab.kind.category ?? "all") === "tables",
      () => ({
        label: t("tree.tablesLabel", { schema }),
        kind: {
          kind: "tables-list",
          connectionId: conn.id,
          schema,
          category: "tables",
        },
        accentColor: conn.color,
      }),
    );
  };
  const openViewsList = () => {
    selectCategory("views");
    newTab(
      (tab) =>
        tab.kind.kind === "tables-list" &&
        tab.kind.connectionId === conn.id &&
        tab.kind.schema === schema &&
        tab.kind.category === "views",
      () => ({
        label: t("tree.viewsLabel", { schema }),
        kind: {
          kind: "tables-list",
          connectionId: conn.id,
          schema,
          category: "views",
        },
        accentColor: conn.color,
      }),
    );
  };

  return (
    <>
      <Category
        icon={<TableIcon className="h-3 w-3" />}
        label={t("tree.tables")}
        count={tableList.length}
        defaultExpanded
        empty={t("tree.noTables")}
        onClick={openTablesList}
        selected={tablesSelected}
        clickableWhenEmpty
      >
        {(tableFolders ?? []).map((f) => (
          <TableFolderNode
            key={f.id}
            conn={conn}
            schema={schema}
            folder={f}
            tables={groupedTables[f.id] ?? []}
          />
        ))}
        {looseTables.map((it) => (
          <TableNode key={it.name} conn={conn} table={it} />
        ))}
      </Category>
      {viewList.length > 0 ? (
        <Category
          icon={<Eye className="h-3 w-3" />}
          label={t("tree.views")}
          count={viewList.length}
          empty={t("tree.noViews")}
          onClick={openViewsList}
          selected={viewsSelected}
        >
          {viewList.map((it) => (
            <TableNode key={it.name} conn={conn} table={it} />
          ))}
        </Category>
      ) : (
        <CategoryPlaceholder
          icon={<Eye className="h-3 w-3" />}
          label={t("tree.views")}
          onCreate={() => openDdlTemplate(conn, schema, "view", newTab)}
        />
      )}
      <CategoryPlaceholder
        icon={<FunctionSquare className="h-3 w-3" />}
        label={t("tree.functions")}
        onCreate={() =>
          openDdlTemplate(conn, schema, "function", newTab)
        }
      />
      <CategoryPlaceholder
        icon={<Cog className="h-3 w-3" />}
        label={t("tree.procedures")}
        onCreate={() =>
          openDdlTemplate(conn, schema, "procedure", newTab)
        }
      />
      <CategoryPlaceholder
        icon={<Wrench className="h-3 w-3" />}
        label={t("tree.triggersLabel")}
        onCreate={() =>
          openDdlTemplate(conn, schema, "trigger", newTab)
        }
      />
      <SavedQueriesCategory conn={conn} schema={schema} />
    </>
  );
}

function Category({
  icon,
  label,
  count,
  children,
  defaultExpanded = false,
  empty,
  onClick,
  clickableWhenEmpty = false,
  selected = false,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  empty: string;
  /** Click on the label (not the chevron) : e.g., open tables-list. */
  onClick?: () => void;
  /** If true, onClick fires even without items : useful for "Queries"
   *  where the empty screen has meaning (button to create the first query). */
  clickableWhenEmpty?: boolean;
  /** If true, paints the header with the selection highlight. */
  selected?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(defaultExpanded && count > 0);
  const isEmpty = count === 0;
  const canClick = !isEmpty || clickableWhenEmpty;
  return (
    <li>
      <div
        className={cn(
          "flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors",
          selected
            ? "bg-conn-accent/25 text-foreground ring-1 ring-conn-accent/60"
            : !canClick
              ? "text-muted-foreground/50"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
        )}
        onClick={() => canClick && onClick?.()}
        title={onClick ? t("tree.clickToList") : undefined}
      >
        {/* Chevron é clicável independente do resto : toggle da árvore */}
        <span
          className="grid h-4 w-4 cursor-pointer place-items-center rounded hover:bg-accent/50"
          onClick={(e) => {
            e.stopPropagation();
            if (!isEmpty) setExpanded((x) => !x);
          }}
          title={t("tree.expandCollapse")}
        >
          {isEmpty ? (
            <span className="h-3 w-3" />
          ) : expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[10px] tabular-nums normal-case text-muted-foreground/60">
          {count}
        </span>
      </div>
      {expanded && count > 0 && (
        <ul className="grid gap-0.5">{children}</ul>
      )}
      {expanded && count === 0 && (
        <div className="px-5 py-0.5 text-[11px] italic text-muted-foreground/50">
          {empty}
        </div>
      )}
    </li>
  );
}

function CategoryPlaceholder({
  icon,
  label,
  onCreate,
}: {
  icon: React.ReactNode;
  label: string;
  /** Opcional: abre uma query com DDL template pra criar este tipo. */
  onCreate?: () => void;
}) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        onClick={onCreate}
        className="group flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50 hover:bg-accent/30 hover:text-foreground"
        title={t("tree.createPlaceholderHint", { label: label.toLowerCase() })}
      >
        <span className="grid h-4 w-4 place-items-center">
          <span className="h-3 w-3" />
        </span>
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 truncate text-left">{label}</span>
        <span className="text-[9px] italic normal-case tracking-normal text-muted-foreground/50 opacity-0 group-hover:opacity-100">
          {t("tree.createShort")}
        </span>
      </button>
    </li>
  );
}

function TableNode({
  conn,
  table,
}: {
  conn: ConnectionProfile;
  table: TableInfo;
}) {
  const newTab = useTabs((s) => s.open);
  const query = useSidebarFilter((s) => s.query);
  const hasOpenTab = useTabs((s) =>
    s.tabs.some(
      (tab) =>
        tab.kind.kind === "table" &&
        tab.kind.connectionId === conn.id &&
        tab.kind.schema === table.schema &&
        tab.kind.table === table.name,
    ),
  );
  const invalidateSchema = useSchemaCache((s) => s.invalidateSchema);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const removeTablesFromCache = useSchemaCache((s) => s.removeTablesFromCache);
  const t = useT();
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const isSelected =
    sidebarSelected?.kind === "table" &&
    sidebarSelected.connectionId === conn.id &&
    sidebarSelected.schema === table.schema &&
    sidebarSelected.table === table.name;

  const isView = table.kind === "view" || table.kind === "materialized_view";
  // Views ficam fora do multi-select (DROP VIEW != DROP TABLE).
  const multiScope = { connectionId: conn.id, schema: table.schema };
  const multiSelected = useSidebarMultiSelect((s) =>
    !isView && sameMultiScope(s.scope, multiScope) ? s.selected : null,
  );
  const isMultiSelected =
    !isView && multiSelected != null && multiSelected.has(table.name);
  const handleMultiClick = useSidebarMultiSelect((s) => s.handleClick);
  const ensureMultiContains = useSidebarMultiSelect((s) => s.ensureContains);
  const clearMulti = useSidebarMultiSelect((s) => s.clear);

  const closeTabsForTable = useTabs((s) => s.closeMany);

  const runMaintenance = (action: MaintenanceAction) => {
    const targets = bulkTargets();
    const sql = buildMaintenanceSql(
      conn.driver,
      action,
      table.schema,
      targets,
    );
    if (!sql) return;
    const label =
      targets.length === 1
        ? `${action.toLowerCase()} · ${targets[0]}`
        : `${action.toLowerCase()} · ${targets.length} tables`;
    newTab({
      label,
      kind: {
        kind: "query",
        connectionId: conn.id,
        schema: table.schema,
        initialSql: sql,
        autoRun: true,
      },
      accentColor: conn.color,
    });
  };
  // Maintain-submenu label reuses t via the outer scope.

  const rename = async () => {
    const next = await appPrompt(
      t("tree.renameTablePrompt", { name: table.name }),
      { defaultValue: table.name },
    );
    if (!next || !next.trim() || next === table.name) return;
    try {
      await ipc.db.renameTable(
        conn.id,
        table.schema,
        table.name,
        next.trim(),
      );
      // Close tabs for the old table : kind references the old name.
      closeTabsForTable(
        (tab) =>
          tab.kind.kind === "table" &&
          tab.kind.connectionId === conn.id &&
          tab.kind.schema === table.schema &&
          tab.kind.table === table.name,
      );
      invalidateSchema(conn.id, table.schema);
      ensureSnapshot(conn.id, table.schema).catch(() => {});
    } catch (e) {
      void appAlert(t("tree.renameTableErr", { error: String(e) }));
    }
  };

  const duplicate = async () => {
    const targets = bulkTargets();
    if (targets.length === 1) {
      try {
        const suggested = await ipc.db.findAvailableTableName(
          conn.id,
          table.schema,
          targets[0],
        );
        const newName = await appPrompt(
          t("tree.duplicatePrompt", { source: targets[0] }),
          { defaultValue: suggested },
        );
        if (!newName || newName.trim() === "") return;
        await ipc.db.duplicateTable(
          conn.id,
          table.schema,
          targets[0],
          newName.trim(),
          true,
        );
        invalidateSchema(conn.id, table.schema);
        ensureSnapshot(conn.id, table.schema).catch(() => {});
      } catch (e) {
        void appAlert(t("tree.duplicateFailed", { error: String(e) }));
      }
      return;
    }
    // Bulk: confirm count first — multi-select can be invisible and a
    // bulk duplicate on the wrong set creates many `_copy` tables.
    const ok = await appConfirm(
      t("tree.duplicateBulkConfirm", { count: String(targets.length) }),
    );
    if (!ok) return;
    // Auto-pick available names, no per-table prompt. Run via the
    // executor for per-table progress + ok/error feedback.
    const jobs: ExecutorJob[] = targets.map((name) => ({
      id: name,
      label: name,
      run: async () => {
        const avail = await ipc.db.findAvailableTableName(
          conn.id,
          table.schema,
          name,
        );
        await ipc.db.duplicateTable(conn.id, table.schema, name, avail, true);
      },
    }));
    await runExecutor(t("tree.duplicate"), jobs);
    invalidateSchema(conn.id, table.schema);
    ensureSnapshot(conn.id, table.schema).catch(() => {});
  };

  const openTable = () => {
    const targets = bulkTargets();
    for (const name of targets) {
      newTab({
        label: name,
        kind: {
          kind: "table",
          connectionId: conn.id,
          schema: table.schema,
          table: name,
        },
        accentColor: conn.color,
      });
    }
  };

  const editTable = () => {
    const targets = bulkTargets();
    if (targets.length === 1) {
      // Single: drive existing tab via bridge if open.
      const tabsSt = useTabs.getState();
      const existing = tabsSt.tabs.find(
        (x) =>
          x.kind.kind === "table" &&
          x.kind.connectionId === conn.id &&
          x.kind.schema === table.schema &&
          x.kind.table === targets[0],
      );
      if (existing) {
        tabsSt.setActive(existing.id);
        const bridge = useTableViewBridge.getState();
        const ok = bridge.setViewOf(existing.id, "structure");
        if (ok) {
          setTimeout(() => bridge.startEditOf(existing.id), 50);
          return;
        }
      }
    }
    for (const name of targets) {
      newTab({
        label: name,
        kind: {
          kind: "table",
          connectionId: conn.id,
          schema: table.schema,
          table: name,
          initialView: "structure",
          initialEdit: true,
        },
        accentColor: conn.color,
      });
    }
  };

  const openSelectAll = () => {
    const targets = bulkTargets();
    const isPg = conn.driver === "postgres";
    for (const name of targets) {
      const qi = isPg
        ? `"${name.replace(/"/g, '""')}"`
        : `\`${name.replace(/`/g, "``")}\``;
      newTab({
        label: t("tree.queryLabel", { name }),
        kind: {
          kind: "query",
          connectionId: conn.id,
          schema: table.schema,
          initialSql: `SELECT *\n  FROM ${qi}\n LIMIT 200;`,
          autoRun: true,
        },
        accentColor: conn.color,
      });
    }
  };

  const openEmptyQuery = () => {
    newTab({
      label: t("tree.queryLabel", { name: table.schema }),
      kind: { kind: "query", connectionId: conn.id, schema: table.schema },
      accentColor: conn.color,
    });
  };

  const copyName = async () => {
    const targets = bulkTargets();
    // Confirm when bulk to avoid pasting an unexpected set after a stale
    // multi-select. Single click stays silent.
    if (targets.length > 1) {
      const ok = await appConfirm(
        t("tree.copyTablesBulkConfirm", { count: String(targets.length) }),
      );
      if (!ok) return;
    }
    try {
      await writeTableClipboard({
        connectionId: conn.id,
        schema: table.schema,
        tables: targets,
      });
    } catch (e) {
      console.error("copy:", e);
    }
  };

  /** Target tables for bulk actions (dump, export, copy, maintenance,
   *  destructive). Respects multi-select if the clicked table is part of it;
   *  otherwise operates on itself only. Views are never multi-bulk. */
  const bulkTargets = (): string[] => {
    if (isView) return [table.name];
    if (multiSelected && multiSelected.has(table.name) && multiSelected.size > 1) {
      return Array.from(multiSelected);
    }
    return [table.name];
  };

  const closeTabsForTables = (names: Set<string>) => {
    closeTabsForTable(
      (tab) =>
        tab.kind.kind === "table" &&
        tab.kind.connectionId === conn.id &&
        tab.kind.schema === table.schema &&
        names.has(tab.kind.table),
    );
  };

  const reportFailures = (results: { table: string; error: string | null }[]) => {
    const failed = results.filter((r) => r.error);
    if (failed.length === 0) return;
    const list = failed.map((r) => `${r.table}: ${r.error}`).join("\n");
    void appAlert(t("tree.bulkOpFailures", { list }));
  };

  const dropSelected = async () => {
    const targets = bulkTargets();
    const many = targets.length > 1;
    const ok = await confirmDestructive({
      title: many
        ? t("tree.dropTableTitleMany", { count: targets.length })
        : t("tree.dropTableTitleOne"),
      description: t("tree.dropTableBody"),
      items: targets,
      confirmLabel: many
        ? t("tree.dropTableConfirmMany", { count: targets.length })
        : t("tree.dropTableConfirmOne"),
      checkboxLabel: t("tree.destructiveAck"),
    });
    if (!ok) return;
    // Bulk (>1 tables): run via the executor so each DROP shows live
    // progress + per-table ok/error instead of one opaque blocking call.
    if (many && !isView) {
      const jobs: ExecutorJob[] = targets.map((name) => ({
        id: name,
        label: name,
        run: async () => {
          const [res] = await ipc.db.dropTables(conn.id, table.schema, [name]);
          if (res?.error) throw new Error(res.error);
        },
      }));
      const { results } = await runExecutor(
        t("tree.dropTableTitleMany", { count: targets.length }),
        jobs,
      );
      const droppedOk = results
        .filter((r) => r.error === null)
        .map((r) => r.id);
      closeTabsForTables(new Set(droppedOk));
      if (droppedOk.length > 0) {
        removeTablesFromCache(conn.id, table.schema, droppedOk);
      }
      clearMulti();
      return;
    }
    try {
      // View → DROP VIEW (single table + isView case).
      const results = isView
        ? [
            {
              table: table.name,
              error: await (async () => {
                try {
                  const isPg = conn.driver === "postgres";
                  const qi = isPg
                    ? `"${table.name.replace(/"/g, '""')}"`
                    : `\`${table.name.replace(/`/g, "``")}\``;
                  await ipc.db.runQuery(
                    conn.id,
                    `DROP VIEW ${qi}`,
                    table.schema,
                  );
                  return null as string | null;
                } catch (e) {
                  return String(e);
                }
              })(),
            },
          ]
        : await ipc.db.dropTables(conn.id, table.schema, targets);
      closeTabsForTables(new Set(targets));
      // Optimistic remove of successfully-dropped names so the tree updates
      // instantly; failed drops stay visible.
      const droppedOk = results
        .filter((r) => r.error === null)
        .map((r) => r.table);
      if (droppedOk.length > 0) {
        removeTablesFromCache(conn.id, table.schema, droppedOk);
      }
      clearMulti();
      reportFailures(results);
    } catch (e) {
      void appAlert(t("tree.bulkOpFailed", { error: String(e) }));
    }
  };

  const truncateSelected = async () => {
    const targets = bulkTargets();
    const many = targets.length > 1;
    const ok = await confirmDestructive({
      title: many
        ? t("tree.truncateTableTitleMany", { count: targets.length })
        : t("tree.truncateTableTitleOne"),
      description: t("tree.truncateTableBody"),
      items: targets,
      confirmLabel: many
        ? t("tree.truncateTableConfirmMany", { count: targets.length })
        : t("tree.truncateTableConfirmOne"),
      checkboxLabel: t("tree.destructiveAck"),
    });
    if (!ok) return;
    if (many) {
      const jobs: ExecutorJob[] = targets.map((name) => ({
        id: name,
        label: name,
        run: async () => {
          const [res] = await ipc.db.truncateTables(conn.id, table.schema, [
            name,
          ]);
          if (res?.error) throw new Error(res.error);
        },
      }));
      await runExecutor(
        t("tree.truncateTableTitleMany", { count: targets.length }),
        jobs,
      );
      invalidateSchema(conn.id, table.schema);
      ensureSnapshot(conn.id, table.schema).catch(() => {});
      return;
    }
    try {
      const results = await ipc.db.truncateTables(
        conn.id,
        table.schema,
        targets,
      );
      // Don't close tabs : rows only; the user keeps editing structure.
      invalidateSchema(conn.id, table.schema);
      ensureSnapshot(conn.id, table.schema).catch(() => {});
      reportFailures(results);
    } catch (e) {
      void appAlert(t("tree.bulkOpFailed", { error: String(e) }));
    }
  };

  const emptySelected = async () => {
    const targets = bulkTargets();
    const many = targets.length > 1;
    const ok = await confirmDestructive({
      title: many
        ? t("tree.emptyTableTitleMany", { count: targets.length })
        : t("tree.emptyTableTitleOne"),
      description: t("tree.emptyTableBody"),
      items: targets,
      confirmLabel: many
        ? t("tree.emptyTableConfirmMany", { count: targets.length })
        : t("tree.emptyTableConfirmOne"),
      checkboxLabel: t("tree.destructiveAck"),
    });
    if (!ok) return;
    if (many) {
      const jobs: ExecutorJob[] = targets.map((name) => ({
        id: name,
        label: name,
        run: async () => {
          const [res] = await ipc.db.emptyTables(conn.id, table.schema, [name]);
          if (res?.error) throw new Error(res.error);
        },
      }));
      await runExecutor(
        t("tree.emptyTableTitleMany", { count: targets.length }),
        jobs,
      );
      invalidateSchema(conn.id, table.schema);
      ensureSnapshot(conn.id, table.schema).catch(() => {});
      return;
    }
    try {
      const results = await ipc.db.emptyTables(conn.id, table.schema, targets);
      invalidateSchema(conn.id, table.schema);
      ensureSnapshot(conn.id, table.schema).catch(() => {});
      reportFailures(results);
    } catch (e) {
      void appAlert(t("tree.bulkOpFailed", { error: String(e) }));
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (isView) {
      // Views ficam fora do multi-select.
      clearMulti();
      setSidebarSelected({
        kind: "table",
        connectionId: conn.id,
        schema: table.schema,
        table: table.name,
        color: conn.color,
      });
      return;
    }
    handleMultiClick(multiScope, table.name, {
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
    });
    setSidebarSelected({
      kind: "table",
      connectionId: conn.id,
      schema: table.schema,
      table: table.name,
      color: conn.color,
    });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!isView) ensureMultiContains(multiScope, table.name);
    menu.openAt(e);
  };

  const tableFolderList =
    useTableFolders((s) => s.folders[`${conn.id}:${table.schema}`]) ?? [];
  const tableAssignmentsForSchema =
    useTableFolders((s) => s.assignments[`${conn.id}:${table.schema}`]) ?? {};
  const moveTableToFolder = useTableFolders((s) => s.move);
  const createTableFolderInline = useTableFolders((s) => s.create);
  const currentTableFolderId = tableAssignmentsForSchema[table.name];

  const moveBulk = async (folderId: string | null) => {
    const targets = bulkTargets();
    const failed: string[] = [];
    for (const name of targets) {
      try {
        await moveTableToFolder(conn.id, table.schema, name, folderId);
      } catch (e) {
        failed.push(`${name}: ${e}`);
      }
    }
    if (failed.length > 0) {
      void appAlert(t("tree.moveFailed", { error: failed.join("\n") }));
    }
  };

  const moveTableItems: ContextEntry[] = [
    ...tableFolderList.map<ContextEntry>((f) => ({
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToFolder", { name: f.name }),
      onClick: () => void moveBulk(f.id),
      // For single-row context, hide the redundant "move to current folder";
      // for bulk, always enabled since other rows may differ.
      disabled:
        bulkTargets().length === 1 && currentTableFolderId === f.id,
    })),
    {
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("tree.moveToNewFolder"),
      onClick: async () => {
        const name = await appPrompt(t("tree.tableFolderPrompt"));
        if (!name || !name.trim()) return;
        try {
          const f = await createTableFolderInline(
            conn.id,
            table.schema,
            name.trim(),
          );
          await moveBulk(f.id);
        } catch (e) {
          void appAlert(t("tree.moveFailed", { error: String(e) }));
        }
      },
    },
    ...(currentTableFolderId
      ? [
          {
            icon: <FolderIcon className="h-3.5 w-3.5" />,
            label: t("tree.removeFromFolder"),
            onClick: () => void moveBulk(null),
          } as ContextEntry,
        ]
      : []),
  ];

  const menu = useContextMenu([
    ...((): ContextEntry[] => {
      const targets = bulkTargets();
      const many = targets.length > 1;
      const countSuffix = many ? ` (${targets.length})` : "";
      return [
        {
          icon: <TableIcon className="h-3.5 w-3.5" />,
          label: `${t("tree.openTable")}${countSuffix}`,
          onClick: openTable,
        },
        {
          icon: <Pencil className="h-3.5 w-3.5" />,
          label: `${t("tree.editTable")}${countSuffix}`,
          shortcut: "Ctrl+D",
          onClick: editTable,
        },
        {
          submenu: true,
          icon: <FolderIcon className="h-3.5 w-3.5" />,
          label: `${t("tree.moveToFolderMenu")}${countSuffix}`,
          items: moveTableItems,
        },
        {
          icon: <FileCode2 className="h-3.5 w-3.5" />,
          label: many
            ? `${t("tree.selectAll", { name: table.name })} (${targets.length})`
            : t("tree.selectAll", { name: table.name }),
          onClick: openSelectAll,
        },
        {
          icon: <FileCode2 className="h-3.5 w-3.5" />,
          label: t("tree.emptyQuery"),
          onClick: openEmptyQuery,
        },
      ];
    })(),
    { separator: true },
    ...((): ContextEntry[] => {
      const targets = bulkTargets();
      const many = targets.length > 1;
      const countSuffix = many ? ` (${targets.length})` : "";
      return [
        {
          icon: <Copy className="h-3.5 w-3.5" />,
          label: `${t("tree.copy")}${countSuffix}`,
          shortcut: "Ctrl+C",
          onClick: copyName,
        },
        {
          icon: <Copy className="h-3.5 w-3.5" />,
          label: `${t("tree.duplicate")}${countSuffix}`,
          onClick: duplicate,
        },
        {
          icon: <Pencil className="h-3.5 w-3.5" />,
          label: t("tree.rename"),
          onClick: rename,
          disabled: many,
        },
        { separator: true },
        {
          submenu: true,
          icon: <Wrench className="h-3.5 w-3.5" />,
          label: `${t("tree.maintainLabel")}${countSuffix}`,
          items: [
            {
              icon: <Wrench className="h-3.5 w-3.5" />,
              label: t("tree.maintainOptimize"),
              onClick: () => runMaintenance("OPTIMIZE"),
            },
            {
              icon: <Wrench className="h-3.5 w-3.5" />,
              label: t("tree.maintainAnalyze"),
              onClick: () => runMaintenance("ANALYZE"),
            },
            {
              icon: <Wrench className="h-3.5 w-3.5" />,
              label: t("tree.maintainCheck"),
              onClick: () => runMaintenance("CHECK"),
            },
            {
              icon: <Wrench className="h-3.5 w-3.5" />,
              label: t("tree.maintainRepair"),
              onClick: () => runMaintenance("REPAIR"),
            },
          ],
        },
      ];
    })(),
    { separator: true },
    ...((): ContextEntry[] => {
      const targets = bulkTargets();
      const many = targets.length > 1;
      const countSuffix = many ? ` (${targets.length})` : "";
      const dumpLabel = many
        ? `Dump · ${targets.length} tables`
        : `Dump · ${table.name}`;
      return [
        {
          icon: <Download className="h-3.5 w-3.5" />,
          label: `${t("tree.export")}${countSuffix}`,
          onClick: () => {
            if (targets.length === 1) {
              void startTableExport(conn.id, table.schema, targets[0]);
            } else {
              void startMultiTableExport(conn.id, table.schema, targets);
            }
          },
        },
        {
          icon: <Upload className="h-3.5 w-3.5" />,
          label: t("tree.importData"),
          onClick: () =>
            newTab({
              label: `Import · ${table.name}`,
              kind: {
                kind: "data-import",
                connectionId: conn.id,
                schema: table.schema,
                table: table.name,
              },
            }),
        },
        {
          icon: <FileText className="h-3.5 w-3.5" />,
          label: `${t("tree.sqlDump")}${countSuffix}`,
          onClick: () =>
            newTab({
              label: dumpLabel,
              kind: {
                kind: "sql-dump",
                sourceConnectionId: conn.id,
                scopes: [{ schema: table.schema, tables: targets }],
              },
              accentColor: conn.color,
            }),
        },
      ];
    })(),
    { separator: true },
    // Truncate / Empty only make sense on tables; hidden on views.
    ...((): ContextEntry[] => {
      const count = bulkTargets().length;
      const many = count > 1;
      const items: ContextEntry[] = [];
      if (!isView) {
        items.push({
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: many
            ? t("tree.truncateTableMenuMany", { count })
            : t("tree.truncateTableMenuOne"),
          onClick: truncateSelected,
          variant: "destructive",
        });
        items.push({
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: many
            ? t("tree.emptyTableMenuMany", { count })
            : t("tree.emptyTableMenuOne"),
          onClick: emptySelected,
          variant: "destructive",
        });
      }
      items.push({
        icon: <Trash2 className="h-3.5 w-3.5" />,
        label: many
          ? t("tree.dropTableMenuMany", { count })
          : t("tree.dropTableMenuOne"),
        onClick: dropSelected,
        variant: "destructive",
      });
      return items;
    })(),
  ]);

  return (
    <li>
      <div
        className={cn(
          "group relative flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors",
          isSelected
            ? "bg-conn-accent/25 text-foreground ring-1 ring-conn-accent/60"
            : isMultiSelected
              ? "bg-conn-accent/15 text-foreground ring-1 ring-conn-accent/40"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        title={[
          table.comment,
          table.engine ? `engine: ${table.engine}` : null,
          table.row_estimate != null
            ? `rows≈ ${table.row_estimate.toLocaleString()}`
            : null,
          table.size_bytes != null
            ? `size: ${formatCompactBytes(table.size_bytes)}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-basemaster-table",
            table.name,
          );
          e.dataTransfer.setData(
            "application/x-basemaster-table-conn",
            conn.id,
          );
          e.dataTransfer.setData(
            "application/x-basemaster-table-schema",
            table.schema,
          );
          e.dataTransfer.setData("text/plain", table.name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={openTable}
      >
        <span className="w-4" />
        <TableIcon
          className={cn(
            "h-3 w-3 shrink-0",
            hasOpenTab && "fill-conn-accent/30 text-conn-accent",
          )}
        />
        <HighlightText
          text={table.name}
          query={query}
          className={cn(
            "flex-1 truncate",
            hasOpenTab && "font-medium text-foreground",
          )}
        />
        {table.kind === "view" && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
            {t("tree.view")}
          </span>
        )}
        {/* Approx row count badge : hides on hover to make room for the
            action buttons. */}
        {table.row_estimate != null && (
          <span className="text-[10px] tabular-nums text-muted-foreground/60 group-hover:hidden">
            {formatCompactNumber(table.row_estimate)}
          </span>
        )}
        <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-popover/95 px-1 py-0.5 shadow-md ring-1 ring-border backdrop-blur-sm group-hover:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openSelectAll();
            }}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={`SELECT * FROM ${table.name}`}
          >
            <FileCode2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openTable();
            }}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t("tree.openTable")}
          >
            <TableIcon className="h-3 w-3" />
          </button>
        </div>
      </div>
      {menu.element}
    </li>
  );
}

/** "Saved queries" category under each schema : lists queries
 *  persisted in local SQLite (via saved_queries repo). */
function SavedQueriesCategory({
  conn,
  schema,
}: {
  conn: ConnectionProfile;
  schema: string;
}) {
  const t = useT();
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const ensure = useSavedQueries((s) => s.ensure);
  const all = useSavedQueries((s) => s.cache[conn.id]);
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const isSelected =
    sidebarSelected?.kind === "category" &&
    sidebarSelected.connectionId === conn.id &&
    sidebarSelected.schema === schema &&
    sidebarSelected.category === "queries";
  const query = useSidebarFilter((s) => s.query);
  const schemaMatches = matches(schema, query);
  const list = useMemo(() => {
    const base = all ? filterBySchema(all, schema) : [];
    if (!query || schemaMatches) return base;
    return base.filter((q) => matches(q.name, query));
  }, [all, schema, query, schemaMatches]);

  // Loads on demand. `ensure` returns the cache if already present.
  useEffect(() => {
    ensure(conn.id).catch((e) =>
      console.warn("saved_queries ensure:", e),
    );
  }, [conn.id, ensure]);

  const openList = () => {
    setSidebarSelected({
      kind: "category",
      connectionId: conn.id,
      schema,
      category: "queries",
      color: conn.color,
    });
    openOrFocus(
      (tab) =>
        tab.kind.kind === "saved-queries-list" &&
        tab.kind.connectionId === conn.id &&
        tab.kind.schema === schema,
      () => ({
        label: `${schema} · ${t("tree.savedQueries")}`,
        kind: { kind: "saved-queries-list", connectionId: conn.id, schema },
        accentColor: conn.color,
      }),
    );
  };

  return (
    <Category
      icon={<Save className="h-3 w-3" />}
      label={t("tree.savedQueries")}
      count={list.length}
      empty={t("tree.noSavedQueries")}
      onClick={openList}
      clickableWhenEmpty
      selected={isSelected}
    >
      {list.map((q) => (
        <SavedQueryNode key={q.id} conn={conn} saved={q} />
      ))}
    </Category>
  );
}

function SavedQueryNode({
  conn,
  saved,
}: {
  conn: ConnectionProfile;
  saved: SavedQuery;
}) {
  const t = useT();
  const newTab = useTabs((s) => s.open);
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const deleteQuery = useSavedQueries((s) => s.delete);
  const updateQuery = useSavedQueries((s) => s.update);
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const searchQuery = useSidebarFilter((s) => s.query);
  const isSelected =
    sidebarSelected?.kind === "saved_query" &&
    sidebarSelected.savedQueryId === saved.id;

  const openQuery = () => {
    openOrFocus(
      (tab) =>
        tab.kind.kind === "query" &&
        tab.kind.savedQueryId === saved.id,
      () => ({
        label: saved.name,
        kind: {
          kind: "query",
          connectionId: conn.id,
          schema: saved.schema ?? undefined,
          initialSql: saved.sql,
          savedQueryId: saved.id,
          savedQueryName: saved.name,
        },
        accentColor: conn.color,
      }),
    );
  };

  const openNewTab = () => {
    newTab({
      label: saved.name,
      kind: {
        kind: "query",
        connectionId: conn.id,
        schema: saved.schema ?? undefined,
        initialSql: saved.sql,
        savedQueryId: saved.id,
        savedQueryName: saved.name,
      },
      accentColor: conn.color,
    });
  };

  const rename = async () => {
    const next = await appPrompt(t("tree.renameSavedQueryPrompt"), {
      defaultValue: saved.name,
    });
    if (!next || next.trim() === "" || next === saved.name) return;
    try {
      await updateQuery(saved.id, {
        name: next.trim(),
        sql: saved.sql,
        schema: saved.schema,
      });
    } catch (e) {
      void appAlert(`${t("tree.renameFailed")}: ${e}`);
    }
  };

  const remove = async () => {
    const ok = await appConfirm(
      t("tree.deleteSavedQueryConfirm", { name: saved.name }),
    );
    if (!ok) return;
    try {
      await deleteQuery(conn.id, saved.id);
    } catch (e) {
      void appAlert(`${t("tree.deleteFailed")}: ${e}`);
    }
  };

  const menu = useContextMenu([
    {
      icon: <FileCode2 className="h-3.5 w-3.5" />,
      label: t("tree.openSavedQuery"),
      onClick: openQuery,
    },
    {
      icon: <FileCode2 className="h-3.5 w-3.5" />,
      label: t("tree.openSavedQueryNewTab"),
      onClick: openNewTab,
    },
    { separator: true },
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: t("tree.rename"),
      onClick: rename,
    },
    {
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: t("common.delete"),
      onClick: remove,
      variant: "destructive",
    },
  ]);

  return (
    <li>
      <div
        className={cn(
          "group relative flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors",
          isSelected
            ? "bg-conn-accent/25 text-foreground ring-1 ring-conn-accent/60"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        onDoubleClick={openQuery}
        onClick={() => {
          setSidebarSelected({
            kind: "saved_query",
            connectionId: conn.id,
            savedQueryId: saved.id,
            color: conn.color,
          });
          openQuery();
        }}
        onContextMenu={menu.openAt}
        title={saved.sql.slice(0, 200)}
      >
        <span className="w-4" />
        <Save className="h-3 w-3 shrink-0" />
        <HighlightText
          text={saved.name}
          query={searchQuery}
          className="flex-1 truncate"
        />
      </div>
      {menu.element}
    </li>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  destructive,
  warning,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  destructive?: boolean;
  warning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cn(
        "grid h-5 w-5 place-items-center rounded hover:bg-muted",
        warning
          ? "text-orange-500 hover:text-orange-400"
          : destructive
            ? "text-muted-foreground hover:text-destructive"
            : "text-muted-foreground hover:text-foreground",
      )}
      title={title}
    >
      {children}
    </button>
  );
}
