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
import { startTableExport } from "@/lib/export-table";
import { ipc } from "@/lib/ipc";
import {
  readTableClipboard,
  writeTableClipboard,
} from "@/lib/table-clipboard";
import type {
  ConnectionProfile,
  SavedQuery,
  SchemaInfo,
  TableInfo,
} from "@/lib/types";
import { DbIcon } from "@/components/ui/db-icon";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { filterBySchema, useSavedQueries } from "@/state/saved-queries";
import { useSchemaCache } from "@/state/schema-cache";
import { HighlightText } from "@/components/ui/highlight-text";
import { matches, useSidebarFilter } from "@/state/sidebar-filter";
import { useSidebarSelection } from "@/state/sidebar-selection";
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
        return `-- CREATE TRIGGER (PostgreSQL) — requer FUNCTION primeiro\nCREATE OR REPLACE FUNCTION ${q(schema)}.${q("trg_fn")}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- manipulação\n  RETURN NEW;\nEND;\n$$;\n\nCREATE TRIGGER ${q("nome_do_trigger")}\nBEFORE INSERT ON ${q(schema)}.${q("tabela")}\nFOR EACH ROW\nEXECUTE FUNCTION ${q(schema)}.${q("trg_fn")}();`;
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

  // Agrupa conexões por folder_id. Null = root.
  const byFolder = new Map<string, ConnectionProfile[]>();
  for (const c of connections) {
    const key = c.folder_id ?? "__root__";
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key)!.push(c);
  }

  return (
    <ul className="grid gap-0.5">
      {/* Pastas primeiro, na ordem definida. */}
      {folders.map((f) => (
        <FolderNode
          key={f.id}
          folder={f}
          connections={byFolder.get(f.id) ?? []}
        />
      ))}
      {/* Drop zone pro root (aparece só se há pastas — senão não
           faz sentido tirar conexão "pro root" já que já tá lá). */}
      {folders.length > 0 && <RootDropZone />}
      {/* Conexões soltas no root. */}
      {(byFolder.get("__root__") ?? []).map((c) => (
        <ConnectionNode key={c.id} conn={c} />
      ))}
    </ul>
  );
}

/** Drop zone invisível entre pastas e conexões root — só aparece
 *  visualmente quando há drag em cima. */
/** Ícone oficial (simple-icons) do driver. Acende na cor da conexão
 *  quando ativa; fica dim/muted quando desconectada. */
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
          alert(t("tree.moveFailed", { error: String(err) }));
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
    const next = window.prompt(t("tree.renameFolderPrompt"), folder.name);
    if (!next || !next.trim() || next === folder.name) return;
    try {
      await ipc.folders.rename(folder.id, next.trim());
      await refreshFolders();
    } catch (e) {
      alert(t("tree.renameTableErr", { error: String(e) }));
    }
  };

  const remove = async () => {
    const hasConns = connections.length > 0;
    if (!hasConns) {
      if (!window.confirm(t("tree.deleteEmptyFolderConfirm", { name: folder.name }))) return;
      try {
        await ipc.folders.delete(folder.id);
        await refresh();
      } catch (e) {
        alert(t("common.failure", { error: String(e) }));
      }
      return;
    }
    // Tem conexões: 3 opções — cancelar, mover pro root, apagar junto.
    const choice = window.confirm(
      t("tree.deleteFolderWithConnsConfirm", {
        name: folder.name,
        count: connections.length,
      }),
    );
    try {
      if (choice) {
        // Apagar conexões uma a uma.
        for (const c of connections) {
          await ipc.connections.delete(c.id);
        }
      }
      await ipc.folders.delete(folder.id);
      await refresh();
    } catch (e) {
      alert(t("common.failure", { error: String(e) }));
    }
  };

  const exportConnections = async () => {
    try {
      const includePasswords = window.confirm(
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
        alert(t("tree.nothingToExport"));
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
      alert(t("common.failure", { error: String(e) }));
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
      alert(t("tree.moveFailed", { error: String(err) }));
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
          "flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors",
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

/** Atalhos globais na sidebar. Ctrl+C copia a seleção atual pro clipboard
 *  (1 tabela se for table, todas as tabelas do schema se for schema).
 *  Ctrl+V abre o wizard de transferência com a seleção atual como target
 *  (connection ou schema). Ignora quando o foco tá em input/textarea,
 *  pra não atropelar copy/paste normal em campos. */
function useSidebarShortcuts() {
  const newTab = useTabs((s) => s.open);
  const t = useT();
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      // Não atropela copy/paste em inputs/textareas/content-editable.
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

    // Se folder mudou, move primeiro (mesmo IPC pra folder).
    if (dragged.folder_id !== target.folder_id) {
      await ipc.folders.move(draggedId, target.folder_id ?? null);
    }

    // Reordena dentro do mesmo grupo (folder_id do target).
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
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

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
        label: `${t("common.edit")} — ${conn.name}`,
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
    if (!window.confirm(t("tree.deleteConfirm", { name: conn.name }))) return;
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
      alert(t("tree.moveFailed", { error: String(e) }));
    }
  };
  const createFolderAndMove = async () => {
    const name = window.prompt(t("sidebar.newFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      const f = await ipc.folders.create({ name: name.trim() });
      await refreshFolders();
      await moveToFolder(f.id);
    } catch (e) {
      alert(t("tree.createFolderFailed", { error: String(e) }));
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
      const includePasswords = window.confirm(
        t("tree.exportConnPrompt", { name: conn.name }),
      );
      const payload = await ipc.portability.export(includePasswords);
      // Filtra só a conexão clicada.
      const filtered = {
        ...payload,
        connections: payload.connections.filter((c) => c.name === conn.name),
      };
      if (filtered.connections.length === 0) {
        alert(t("tree.connNotFoundInPayload"));
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
      alert(t("tree.exportFailed", { error: String(e) }));
    }
  };

  const duplicateConnection = async () => {
    try {
      const payload = await ipc.portability.export(true);
      const src = payload.connections.find((c) => c.name === conn.name);
      if (!src) {
        alert(t("tree.connNotFound"));
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
      alert(t("tree.duplicateFailed", { error: String(e) }));
    }
  };

  const invalidateForConn = useSchemaCache((s) => s.invalidateSchema);
  const ensureForConn = useSchemaCache((s) => s.ensureSnapshot);

  /** Paste na conexão: lê clipboard, decide se abre transfer ou duplica. */
  const pasteTables = async () => {
    const payload = await readTableClipboard();
    if (!payload) {
      alert(t("tree.pasteInvalid"));
      return;
    }
    // Target assumed: esta conexão. Schema: pergunta qual (prompt com default).
    const targetSchema = window.prompt(
      t("tree.pasteSchemaPrompt"),
      conn.default_database ?? payload.schema,
    );
    if (!targetSchema || !targetSchema.trim()) return;
    const tgtSchema = targetSchema.trim();

    const sameConn = payload.connectionId === conn.id;
    const sameSchema = sameConn && payload.schema === tgtSchema;
    if (sameConn && sameSchema) {
      // Mesma origem: duplica cada uma localmente.
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
        if (failed.length > 0) alert(t("tree.pasteFailures", { list: failed.join("\n") }));
      } catch (e) {
        alert(t("tree.pasteFailed", { error: String(e) }));
      }
      return;
    }

    // Origem diferente: abre wizard pré-configurado.
    newTab({
      label: t("tree.dataTransfer"),
      kind: {
        kind: "data-transfer",
        sourceConnectionId: payload.connectionId,
        sourceSchema: payload.schema,
        targetConnectionId: conn.id,
        targetSchema: tgtSchema,
        tables: payload.tables,
      },
      accentColor: conn.color,
    });
  };

  // Items de "mover pra pasta" — um por folder existente + opção de
  // criar nova pasta + opção de tirar da pasta (ir pro root).
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

  const createDatabaseOrSchema = () => {
    const label = conn.driver === "postgres" ? t("tree.dbLabelSchema") : t("tree.dbLabelDatabase");
    const name = window.prompt(
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
    newTab({
      label: t("tree.newDbLabel", { kind: label, name: name.trim() }),
      kind: {
        kind: "query",
        connectionId: conn.id,
        initialSql: sql,
      },
      accentColor: conn.color,
    });
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

  const menuItems: ContextEntry[] = active
    ? [
        { icon: <FileCode2 className="h-3.5 w-3.5" />, label: t("tree.newQuery"), onClick: newQuery },
        { icon: <Database className="h-3.5 w-3.5" />, label: conn.driver === "postgres" ? t("tabs.newDatabaseLabelPg") : t("tabs.newDatabaseLabelMysql"), onClick: createDatabaseOrSchema },
        { icon: <ClipboardPaste className="h-3.5 w-3.5" />, label: t("tree.pasteTables"), onClick: pasteTables },
        { icon: <ArrowRightLeft className="h-3.5 w-3.5" />, label: t("tree.dataTransfer"), onClick: openDataTransfer },
        { icon: <Upload className="h-3.5 w-3.5" />, label: t("tree.sqlImport"), onClick: () => openSqlImport() },
        { icon: <History className="h-3.5 w-3.5" />, label: t("tree.queryHistory"), onClick: openHistory },
        { icon: <Cog className="h-3.5 w-3.5" />, label: t("tree.processes"), onClick: openProcesses },
        { icon: <Plug className="h-3.5 w-3.5" />, label: t("tree.users"), onClick: openUsers },
        { icon: <RefreshCw className="h-3.5 w-3.5" />, label: t("common.refresh"), onClick: refresh },
        { icon: <Unplug className="h-3.5 w-3.5" />, label: t("tree.disconnect"), onClick: disconnect },
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
        // Sempre re-escopar o --conn-accent por conexão pra não herdar
        // o do root (App.tsx seta ele baseado na aba ativa). Sem isso,
        // editar a cor de uma conexão no form vaza visualmente pra
        // qualquer conexão sem cor própria.
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
            alert(t("tree.reorderFailed", { error: String(err) }));
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

        <div className="hidden items-center gap-0.5 group-hover:flex">
          {active && (
            <>
              <IconBtn title={t("tree.newQuery")} onClick={newQuery}>
                <FileCode2 className="h-3 w-3" />
              </IconBtn>
              <IconBtn title={t("tree.disconnect")} onClick={disconnect}>
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

      {/* Erro de conexão — sempre visível sob o item, mesmo colapsado.
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
        >
          {error && (
            <li className="px-1.5 py-1 text-xs text-destructive">{error}</li>
          )}
          {!error && schemas && (
            <SchemasList conn={conn} schemas={schemas} />
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
    // Schemas pg_temp_*, pg_toast_* também são internos.
    if (lower.startsWith("pg_temp_") || lower.startsWith("pg_toast_")) return true;
    return false;
  }
  return SYSTEM_SCHEMAS_MYSQL.has(lower);
}

function SchemasList({
  conn,
  schemas,
}: {
  conn: ConnectionProfile;
  schemas: SchemaInfo[];
}) {
  const { user, system } = useMemo(() => {
    const u: SchemaInfo[] = [];
    const s: SchemaInfo[] = [];
    for (const sc of schemas) {
      if (isSystemSchema(conn.driver, sc.name)) s.push(sc);
      else u.push(sc);
    }
    return { user: u, system: s };
  }, [schemas, conn.driver]);

  return (
    <>
      {user.map((s) => (
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
  // Se filtro bate com algum nome interno, abre auto.
  const anyMatch = query
    ? schemas.some((s) => matches(s.name, query))
    : false;
  const effectiveExpanded = expanded || anyMatch;

  // Se filtro tá ativo e nenhum system schema casa, esconde o grupo inteiro.
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

  // Só consideramos matches dentro do schema quando ele tá EXPANDIDO
  // (o usuário já abriu). Schemas fechados ficam fora do escopo da busca.
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

  // Auto-expande se for o banco padrão da conexão.
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

  const closeMany = useTabs((s) => s.closeMany);
  const invalidateConn = useSchemaCache((s) => s.invalidate);
  const renameSchema = async () => {
    const next = window.prompt(
      t("tree.renameSchemaPrompt"),
      schema.name,
    );
    if (!next || !next.trim() || next === schema.name) return;
    if (
      !window.confirm(
        t("tree.renameSchemaConfirm", { old: schema.name, next }),
      )
    ) {
      return;
    }
    try {
      await ipc.db.renameSchema(conn.id, schema.name, next.trim());
      // Fecha abas ligadas ao schema antigo.
      closeMany(
        (tab) =>
          (tab.kind.kind === "table" || tab.kind.kind === "tables-list") &&
          tab.kind.connectionId === conn.id &&
          tab.kind.schema === schema.name,
      );
      invalidateConn(conn.id);
    } catch (e) {
      alert(t("tree.renameTableErr", { error: String(e) }));
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

  const createSiblingDatabase = () => {
    const name = window.prompt(
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
    newTab({
      label: t("tree.newDbLabel", { kind: dbLabel, name: name.trim() }),
      kind: {
        kind: "query",
        connectionId: conn.id,
        initialSql: `CREATE ${keyword} ${quoted};`,
      },
      accentColor: conn.color,
    });
  };

  const dropSchema = async () => {
    const confirmed = window.confirm(
      t("tree.dropDbConfirm", { kind: dbLabel, name: schema.name }),
    );
    if (!confirmed) return;
    // Segunda confirmação digitando o nome (proteção extra).
    const typed = window.prompt(
      t("tree.dropDbTypePrompt", { name: schema.name }),
    );
    if (typed !== schema.name) {
      alert(t("tree.dropDbNameMismatch"));
      return;
    }
    const isPg = conn.driver === "postgres";
    const quoted = isPg
      ? `"${schema.name.replace(/"/g, '""')}"`
      : `\`${schema.name.replace(/`/g, "``")}\``;
    const keyword = isPg ? "SCHEMA" : "DATABASE";
    const cascade = isPg ? " CASCADE" : "";
    const sql = `DROP ${keyword} ${quoted}${cascade};`;
    try {
      await ipc.db.runQuery(conn.id, sql, null);
      invalidateSchema(conn.id, schema.name);
      // Força reload de schemas da conexão — expand colapsado primeiro.
      // A árvore do conn reconstrói no próximo tick.
    } catch (e) {
      alert(t("tree.dropDbFailed", { error: String(e) }));
    }
  };

  const menu = useContextMenu([
    { icon: <FileCode2 className="h-3.5 w-3.5" />, label: t("tree.newQuerySchema"), onClick: newQuery },
    { icon: <Plus className="h-3.5 w-3.5" />, label: t("tree.newTable"), onClick: newTableHere },
    { icon: <Database className="h-3.5 w-3.5" />, label: t("tree.newDbSibling", { kind: dbLabel }), onClick: createSiblingDatabase },
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
          "group flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors",
          isSelected
            ? "bg-conn-accent/25 text-foreground ring-1 ring-conn-accent/60"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
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
        <ul className="ml-4 grid gap-0.5 border-l border-border pl-1">
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

/** Agrupa itens do schema em categorias (Tabelas / Views / Functions /
 *  Procedures / Queries salvas). Functions/Procedures/Queries são
 *  placeholders até o backend expor. */
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
  // Se schema já combina com a query, mostra tudo. Senão filtra por nome.
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
      >
        {tableList.map((it) => (
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
  /** Click no label (não na chevron) — ex: abrir tables-list. */
  onClick?: () => void;
  /** Se true, o onClick dispara mesmo sem itens — útil pra "Queries"
   *  onde a tela vazia tem sentido (botão de criar primeira query). */
  clickableWhenEmpty?: boolean;
  /** Se true, pinta o header com o highlight de seleção. */
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
        {/* Chevron é clicável independente do resto — toggle da árvore */}
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
  const t = useT();
  const sidebarSelected = useSidebarSelection((s) => s.selected);
  const setSidebarSelected = useSidebarSelection((s) => s.setSelected);
  const isSelected =
    sidebarSelected?.kind === "table" &&
    sidebarSelected.connectionId === conn.id &&
    sidebarSelected.schema === table.schema &&
    sidebarSelected.table === table.name;

  const closeTabsForTable = useTabs((s) => s.closeMany);

  const runMaintenance = (action: MaintenanceAction) => {
    const sql = buildMaintenanceSql(
      conn.driver,
      action,
      table.schema,
      [table.name],
    );
    if (!sql) return;
    newTab({
      label: `${action.toLowerCase()} · ${table.name}`,
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
    const next = window.prompt(
      t("tree.renameTablePrompt", { name: table.name }),
      table.name,
    );
    if (!next || !next.trim() || next === table.name) return;
    try {
      await ipc.db.renameTable(
        conn.id,
        table.schema,
        table.name,
        next.trim(),
      );
      // Fecha abas da tabela antiga — o kind referencia o nome velho.
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
      alert(t("tree.renameTableErr", { error: String(e) }));
    }
  };

  const duplicate = async () => {
    try {
      // Sugere nome disponível e pergunta ao usuário.
      const suggested = await ipc.db.findAvailableTableName(
        conn.id,
        table.schema,
        table.name,
      );
      const newName = window.prompt(
        t("tree.duplicatePrompt", { source: table.name }),
        suggested,
      );
      if (!newName || newName.trim() === "") return;
      // Copia estrutura + dados. V2 pode perguntar se só estrutura.
      await ipc.db.duplicateTable(
        conn.id,
        table.schema,
        table.name,
        newName.trim(),
        true,
      );
      // Refresh da árvore pra mostrar a nova tabela.
      invalidateSchema(conn.id, table.schema);
      ensureSnapshot(conn.id, table.schema).catch(() => {});
    } catch (e) {
      alert(t("tree.duplicateFailed", { error: String(e) }));
    }
  };

  const openTable = () => {
    newTab({
      label: table.name,
      kind: {
        kind: "table",
        connectionId: conn.id,
        schema: table.schema,
        table: table.name,
      },
      accentColor: conn.color,
    });
  };

  const openSelectAll = () => {
    const isPg = conn.driver === "postgres";
    const qi = isPg
      ? `"${table.name.replace(/"/g, '""')}"`
      : `\`${table.name.replace(/`/g, "``")}\``;
    newTab({
      label: t("tree.queryLabel", { name: table.name }),
      kind: {
        kind: "query",
        connectionId: conn.id,
        schema: table.schema,
        initialSql: `SELECT *\n  FROM ${qi}\n LIMIT 200;`,
        autoRun: true,
      },
      accentColor: conn.color,
    });
  };

  const openEmptyQuery = () => {
    newTab({
      label: t("tree.queryLabel", { name: table.schema }),
      kind: { kind: "query", connectionId: conn.id, schema: table.schema },
      accentColor: conn.color,
    });
  };

  const copyName = async () => {
    try {
      await writeTableClipboard({
        connectionId: conn.id,
        schema: table.schema,
        tables: [table.name],
      });
    } catch (e) {
      console.error("copy:", e);
    }
  };

  const menu = useContextMenu([
    {
      icon: <TableIcon className="h-3.5 w-3.5" />,
      label: t("tree.openTable"),
      onClick: openTable,
    },
    {
      icon: <FileCode2 className="h-3.5 w-3.5" />,
      label: t("tree.selectAll", { name: table.name }),
      onClick: openSelectAll,
    },
    {
      icon: <FileCode2 className="h-3.5 w-3.5" />,
      label: t("tree.emptyQuery"),
      onClick: openEmptyQuery,
    },
    { separator: true },
    {
      icon: <Copy className="h-3.5 w-3.5" />,
      label: t("tree.copy"),
      shortcut: "Ctrl+C",
      onClick: copyName,
    },
    {
      icon: <Copy className="h-3.5 w-3.5" />,
      label: t("tree.duplicate"),
      onClick: duplicate,
    },
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: t("tree.rename"),
      onClick: rename,
    },
    { separator: true },
    {
      submenu: true,
      icon: <Wrench className="h-3.5 w-3.5" />,
      label: t("tree.maintainLabel"),
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
    { separator: true },
    {
      icon: <Download className="h-3.5 w-3.5" />,
      label: t("tree.export"),
      onClick: () =>
        startTableExport(conn.id, table.schema, table.name),
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
      label: t("tree.sqlDump"),
      onClick: () =>
        newTab({
          label: `Dump · ${table.name}`,
          kind: {
            kind: "sql-dump",
            sourceConnectionId: conn.id,
            scopes: [
              { schema: table.schema, tables: [table.name] },
            ],
          },
          accentColor: conn.color,
        }),
    },
  ]);

  return (
    <li>
      <div
        className={cn(
          "group flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors",
          isSelected
            ? "bg-conn-accent/25 text-foreground ring-1 ring-conn-accent/60"
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
        onClick={() =>
          setSidebarSelected({
            kind: "table",
            connectionId: conn.id,
            schema: table.schema,
            table: table.name,
            color: conn.color,
          })
        }
        onContextMenu={menu.openAt}
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
        {/* Badge com contagem aprox — some em hover pra dar espaço aos
            botões de ação. */}
        {table.row_estimate != null && (
          <span className="text-[10px] tabular-nums text-muted-foreground/60 group-hover:hidden">
            {formatCompactNumber(table.row_estimate)}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openSelectAll();
          }}
          className="hidden h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground group-hover:grid"
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
          className="hidden h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground group-hover:grid"
          title={t("tree.openTable")}
        >
          <TableIcon className="h-3 w-3" />
        </button>
      </div>
      {menu.element}
    </li>
  );
}

/** Categoria "Queries salvas" sob cada schema — lista queries
 *  persistidas em SQLite local (via saved_queries repo). */
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

  // Carrega sob demanda. `ensure` devolve cache se já tem.
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
    const next = window.prompt(t("tree.renameSavedQueryPrompt"), saved.name);
    if (!next || next.trim() === "" || next === saved.name) return;
    try {
      await updateQuery(saved.id, {
        name: next.trim(),
        sql: saved.sql,
        schema: saved.schema,
      });
    } catch (e) {
      alert(`${t("tree.renameFailed")}: ${e}`);
    }
  };

  const remove = async () => {
    if (
      !window.confirm(t("tree.deleteSavedQueryConfirm", { name: saved.name }))
    ) {
      return;
    }
    try {
      await deleteQuery(conn.id, saved.id);
    } catch (e) {
      alert(`${t("tree.deleteFailed")}: ${e}`);
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
          "group flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors",
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
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cn(
        "grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted",
        destructive ? "hover:text-destructive" : "hover:text-foreground",
      )}
      title={title}
    >
      {children}
    </button>
  );
}
