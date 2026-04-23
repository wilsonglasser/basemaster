import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useShortcut } from "@/lib/shortcuts/use-shortcuts";
import {
  ArrowDownUp,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Table as TableIcon,
  Trash2,
  Wrench,
} from "lucide-react";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import { startTableExport } from "@/lib/export-table";
import {
  buildMaintenanceSql,
  type MaintenanceAction,
} from "@/lib/maintenance-sql";
import { ipc } from "@/lib/ipc";
import {
  readTableClipboard,
  writeTableClipboard,
} from "@/lib/table-clipboard";
import type { Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appAlert, appPrompt } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { confirmDestructive } from "@/state/destructive-confirm";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useTabs } from "@/state/tabs";

interface Props {
  connectionId: Uuid;
  schema: string;
  category?: "all" | "tables" | "views";
}

type SortKey = "name" | "kind" | "engine" | "rows" | "size";
type SortDir = "asc" | "desc";

function formatBytes(b: number | null | undefined): string {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function TablesListView({
  connectionId,
  schema,
  category = "all",
}: Props) {
  const tables = useSchemaCache(
    (s) => s.caches[connectionId]?.tables[schema],
  );
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const invalidateSchema = useSchemaCache((s) => s.invalidateSchema);
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const connActive = useConnections((s) => s.active.has(connectionId));
  const openConn = useConnections((s) => s.open);
  const newTab = useTabs((s) => s.open);
  const t = useT();

  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelected, setLastSelected] = useState<string | null>(null);

  const onlySelectedName = selected.size === 1 ? [...selected][0] : null;

  const handleRowSelect = (name: string, e: React.MouseEvent) => {
    const names = sortedRef.current;
    if (e.shiftKey && lastSelected && names) {
      const a = names.findIndex((n) => n === lastSelected);
      const b = names.findIndex((n) => n === name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = names.slice(lo, hi + 1);
        setSelected(new Set(range));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      setLastSelected(name);
      return;
    }
    setSelected(new Set([name]));
    setLastSelected(name);
  };

  const sortedRef = useRef<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Persisted view mode — "list" = table with columns,
  // "grid" = cards with name only (file explorer icons view style).
  const [viewMode, setViewMode] = useState<"list" | "grid">(() => {
    if (typeof window === "undefined") return "list";
    return window.localStorage.getItem("basemaster.tablesListViewMode") ===
      "grid"
      ? "grid"
      : "list";
  });
  useEffect(() => {
    window.localStorage.setItem(
      "basemaster.tablesListViewMode",
      viewMode,
    );
  }, [viewMode]);

  // Rename inline: pattern "slow double-click" (file-explorer).
  // Primeiro click seleciona; segundo click (>300ms depois) entra em
  // rename; dbl-click fast cancela o timer e abre a tabela.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  // F2 — renomeia item selecionado na lista (overrides o handler global).
  useShortcut(
    "rename.selected",
    useCallback(() => {
      if (onlySelectedName) {
        setEditingName(onlySelectedName);
        setEditingDraft(onlySelectedName);
      }
    }, [onlySelectedName]),
  );
  const renameTimerRef = useRef<number | null>(null);
  const clearRenameTimer = () => {
    if (renameTimerRef.current != null) {
      window.clearTimeout(renameTimerRef.current);
      renameTimerRef.current = null;
    }
  };
  const scheduleRename = (name: string) => {
    clearRenameTimer();
    renameTimerRef.current = window.setTimeout(() => {
      setEditingName(name);
      setEditingDraft(name);
      renameTimerRef.current = null;
    }, 500);
  };
  const commitRename = async () => {
    if (!editingName) return;
    const next = editingDraft.trim();
    if (!next || next === editingName) {
      setEditingName(null);
      return;
    }
    const oldName = editingName;
    setEditingName(null);
    try {
      await ipc.db.renameTable(connectionId, schema, oldName, next);
      // Fecha abas da tabela antiga.
      useTabs
        .getState()
        .closeMany(
          (tab) =>
            tab.kind.kind === "table" &&
            tab.kind.connectionId === connectionId &&
            tab.kind.schema === schema &&
            tab.kind.table === oldName,
        );
      invalidateSchema(connectionId, schema);
      ensureSnapshot(connectionId, schema).catch(() => {});
      setSelected((prev) => {
        if (!prev.has(oldName)) return prev;
        const copy = new Set(prev);
        copy.delete(oldName);
        copy.add(next);
        return copy;
      });
    } catch (e) {
      void appAlert(t("tablesList.renameFailed", { error: String(e) }));
    }
  };
  const cancelRename = () => {
    setEditingName(null);
    setEditingDraft("");
  };
  useEffect(() => () => clearRenameTimer(), []);

  // Ensure the connection is open + snapshot is loaded.
  useEffect(() => {
    (async () => {
      if (!connActive && conn) {
        try {
          await openConn(connectionId);
        } catch (e) {
          console.warn("open conn:", e);
          return;
        }
      }
      if (!tables) {
        setLoading(true);
        try {
          await ensureSnapshot(connectionId, schema);
        } finally {
          setLoading(false);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, connActive]);

  const sorted = useMemo(() => {
    if (!tables) return [];
    const q = filter.toLowerCase();
    let filtered = q
      ? tables.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.comment ?? "").toLowerCase().includes(q),
        )
      : [...tables];
    // Filtro por categoria (tables vs views).
    if (category === "tables") {
      filtered = filtered.filter(
        (t) => t.kind !== "view" && t.kind !== "materialized_view",
      );
    } else if (category === "views") {
      filtered = filtered.filter(
        (t) => t.kind === "view" || t.kind === "materialized_view",
      );
    }
    filtered.sort((a, b) => {
      const m = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name) * m;
        case "kind":
          return a.kind.localeCompare(b.kind) * m;
        case "engine":
          return (a.engine ?? "").localeCompare(b.engine ?? "") * m;
        case "rows":
          return ((a.row_estimate ?? 0) - (b.row_estimate ?? 0)) * m;
        case "size":
          return ((a.size_bytes ?? 0) - (b.size_bytes ?? 0)) * m;
      }
    });
    return filtered;
  }, [tables, filter, sortKey, sortDir, category]);

  // Keep the ref so handleRowSelect can compute the shift-click range.
  useEffect(() => {
    sortedRef.current = sorted.map((t) => t.name);
  }, [sorted]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  const openTable = (name: string) => {
    newTab({
      label: name,
      kind: { kind: "table", connectionId, schema, table: name },
      accentColor: conn?.color,
    });
  };

  const duplicate = async (name: string) => {
    try {
      const suggested = await ipc.db.findAvailableTableName(
        connectionId,
        schema,
        name,
      );
      const newName = await appPrompt(
        t("tree.duplicatePrompt", { source: name }),
        { defaultValue: suggested },
      );
      if (!newName || newName.trim() === "") return;
      await ipc.db.duplicateTable(
        connectionId,
        schema,
        name,
        newName.trim(),
        true,
      );
      invalidateSchema(connectionId, schema);
      await ensureSnapshot(connectionId, schema);
    } catch (e) {
      void appAlert(t("tablesList.duplicateFailed", { error: String(e) }));
    }
  };

  /** Bulk targets: if the given table is in the selection, operates on
   *  all selected; otherwise only on it. Right-click respects the set. */
  const bulkTargets = (name: string): string[] => {
    if (selected.has(name) && selected.size > 1) return Array.from(selected);
    return [name];
  };

  const reportFailures = (
    results: { table: string; error: string | null }[],
  ) => {
    const failed = results.filter((r) => r.error);
    if (failed.length === 0) return;
    void appAlert(
      t("tablesList.pasteFailures", {
        list: failed.map((r) => `${r.table}: ${r.error}`).join("\n"),
      }),
    );
  };

  const deleteTables = async (name: string) => {
    const targets = bulkTargets(name);
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
    try {
      const results = await ipc.db.dropTables(connectionId, schema, targets);
      invalidateSchema(connectionId, schema);
      await ensureSnapshot(connectionId, schema);
      // Clear selection for those that actually went away.
      const dropped = new Set(results.filter((r) => !r.error).map((r) => r.table));
      setSelected((prev) => {
        const next = new Set(prev);
        dropped.forEach((d) => next.delete(d));
        return next;
      });
      reportFailures(results);
    } catch (e) {
      void appAlert(t("tablesList.deleteFailed", { error: String(e) }));
    }
  };

  const truncateTables = async (name: string) => {
    const targets = bulkTargets(name);
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
    try {
      const results = await ipc.db.truncateTables(connectionId, schema, targets);
      invalidateSchema(connectionId, schema);
      await ensureSnapshot(connectionId, schema);
      reportFailures(results);
    } catch (e) {
      void appAlert(t("tablesList.deleteFailed", { error: String(e) }));
    }
  };

  const emptyTables = async (name: string) => {
    const targets = bulkTargets(name);
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
    try {
      const results = await ipc.db.emptyTables(connectionId, schema, targets);
      invalidateSchema(connectionId, schema);
      await ensureSnapshot(connectionId, schema);
      reportFailures(results);
    } catch (e) {
      void appAlert(t("tablesList.deleteFailed", { error: String(e) }));
    }
  };

  // ---------- Copy/Paste ----------
  /** Lista alvo do copy: todos os selecionados. */
  const copyTargets = (): string[] => Array.from(selected);

  const handleCopy = async () => {
    const tables = copyTargets();
    if (tables.length === 0) return;
    try {
      await writeTableClipboard({
        connectionId,
        schema,
        tables,
      });
    } catch (e) {
      console.error("copy:", e);
    }
  };

  const handlePaste = async () => {
    const payload = await readTableClipboard();
    if (!payload) {
      void appAlert(t("tablesList.pasteInvalid"));
      return;
    }
    const sameConn = payload.connectionId === connectionId;
    const sameSchema = sameConn && payload.schema === schema;

    if (sameConn && sameSchema) {
      // Mesma origem: duplica cada uma localmente (_copy, _copy_1…).
      await duplicateMany(payload.tables);
      return;
    }

    // Different source: open the pre-configured wizard.
    newTab({
      label: t("tree.dataTransfer"),
      kind: {
        kind: "data-transfer",
        sourceConnectionId: payload.connectionId,
        sourceSchema: payload.schema,
        targetConnectionId: connectionId,
        targetSchema: schema,
        tables: payload.tables,
      },
      accentColor: conn?.color ?? null,
    });
  };

  const duplicateMany = async (names: string[]) => {
    const failed: string[] = [];
    for (const name of names) {
      try {
        const avail = await ipc.db.findAvailableTableName(
          connectionId,
          schema,
          name,
        );
        await ipc.db.duplicateTable(connectionId, schema, name, avail, true);
      } catch (e) {
        failed.push(`${name}: ${e}`);
      }
    }
    invalidateSchema(connectionId, schema);
    await ensureSnapshot(connectionId, schema);
    if (failed.length > 0) {
      void appAlert(t("tablesList.pasteFailures", { list: failed.join("\n") }));
    }
  };

  // Ctrl+C / Ctrl+V / Ctrl+A at the view level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore if focus is in an input/textarea.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void handleCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void handlePaste();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const all = sortedRef.current;
        if (all && all.length > 0) {
          setSelected(new Set(all));
          setLastSelected(all[all.length - 1]);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId, schema]);

  const refresh = async () => {
    setLoading(true);
    invalidateSchema(connectionId, schema);
    try {
      await ensureSnapshot(connectionId, schema);
    } finally {
      setLoading(false);
    }
  };

  // Single context menu, reused for any row.
  const [ctxItems, setCtxItems] = useState<ContextEntry[]>([]);
  const ctxMenu = useContextMenu(ctxItems);

  const runMaintenanceMulti = (
    action: MaintenanceAction,
    singleName?: string,
  ) => {
    // Use the multi-selection if anything is checked — otherwise just
    // the context-menu row.
    const names =
      selected.size > 0 ? Array.from(selected) : singleName ? [singleName] : [];
    if (names.length === 0) return;
    const sql = buildMaintenanceSql(
      conn?.driver ?? "mysql",
      action,
      schema,
      names,
    );
    if (!sql) return;
    newTab({
      label: `${action.toLowerCase()} · ${names.length} tabela${names.length === 1 ? "" : "s"}`,
      kind: {
        kind: "query",
        connectionId,
        schema,
        initialSql: sql,
        autoRun: true,
      },
      accentColor: conn?.color,
    });
  };

  const handleRowContextMenu = (name: string, e: React.MouseEvent) => {
    // Keep selection if already selected (for bulk ops); otherwise replace it.
    if (!selected.has(name)) {
      setSelected(new Set([name]));
      setLastSelected(name);
    }
    const copyCount = bulkTargets(name).length;
    setCtxItems([
      {
        icon: <TableIcon className="h-3.5 w-3.5" />,
        label: t("tree.openTable"),
        onClick: () => openTable(name),
      },
      {
        icon: <Copy className="h-3.5 w-3.5" />,
        label:
          copyCount > 1
            ? `${t("tablesList.copy")} (${copyCount})`
            : t("tablesList.copy"),
        onClick: () => void handleCopy(),
      },
      {
        icon: <ClipboardPaste className="h-3.5 w-3.5" />,
        label: t("tablesList.paste"),
        onClick: () => void handlePaste(),
      },
      {
        icon: <Copy className="h-3.5 w-3.5" />,
        label: t("tree.duplicate"),
        onClick: () => duplicate(name),
      },
      {
        icon: <Download className="h-3.5 w-3.5" />,
        label: t("tree.export"),
        onClick: () => startTableExport(connectionId, schema, name),
      },
      { separator: true },
      {
        submenu: true,
        icon: <Wrench className="h-3.5 w-3.5" />,
        label: t("tablesList.maintainLabel"),
        items: [
          {
            icon: <Wrench className="h-3.5 w-3.5" />,
            label: t("tree.maintainOptimize"),
            onClick: () => runMaintenanceMulti("OPTIMIZE", name),
          },
          {
            icon: <Wrench className="h-3.5 w-3.5" />,
            label: t("tree.maintainAnalyze"),
            onClick: () => runMaintenanceMulti("ANALYZE", name),
          },
          {
            icon: <Wrench className="h-3.5 w-3.5" />,
            label: t("tree.maintainCheck"),
            onClick: () => runMaintenanceMulti("CHECK", name),
          },
          {
            icon: <Wrench className="h-3.5 w-3.5" />,
            label: t("tree.maintainRepair"),
            onClick: () => runMaintenanceMulti("REPAIR", name),
          },
        ],
      },
      { separator: true },
      ...((): ContextEntry[] => {
        const count = bulkTargets(name).length;
        const many = count > 1;
        return [
          {
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: many
              ? t("tree.truncateTableMenuMany", { count })
              : t("tree.truncateTableMenuOne"),
            variant: "destructive",
            onClick: () => truncateTables(name),
          },
          {
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: many
              ? t("tree.emptyTableMenuMany", { count })
              : t("tree.emptyTableMenuOne"),
            variant: "destructive",
            onClick: () => emptyTables(name),
          },
          {
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: many
              ? t("tree.dropTableMenuMany", { count })
              : t("tree.dropTableMenuOne"),
            variant: "destructive",
            onClick: () => deleteTables(name),
          },
        ];
      })(),
    ]);
    ctxMenu.openAt(e);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs">
        <span className="text-muted-foreground">{schema}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="font-medium">
          {sorted.length}{" "}
          {category === "views"
            ? sorted.length === 1
              ? t("tablesList.viewWord")
              : t("tablesList.viewWordPlural")
            : category === "tables"
              ? sorted.length === 1
                ? t("tablesList.tableWord")
                : t("tablesList.tableWordPlural")
              : t("tablesList.title", { count: tables?.length ?? 0 })}
        </span>

        <div className="ml-4 flex items-center gap-1">
          <ToolbarBtn
            icon={<Plus className="h-3.5 w-3.5" />}
            label={t("tree.newTable")}
            onClick={() =>
              newTab({
                label: t("tablesList.newTableTabLabel", { schema }),
                kind: { kind: "new-table", connectionId, schema },
                accentColor: conn?.color,
              })
            }
          />
          <ToolbarBtn
            icon={<TableIcon className="h-3.5 w-3.5" />}
            label={t("tablesList.open")}
            disabled={!onlySelectedName}
            onClick={() => onlySelectedName && openTable(onlySelectedName)}
          />
          <ToolbarBtn
            icon={<Copy className="h-3.5 w-3.5" />}
            label={
              selected.size > 0
                ? `${t("tablesList.copy")} (${selected.size})`
                : t("tablesList.copy")
            }
            disabled={selected.size === 0}
            onClick={handleCopy}
          />
          <ToolbarBtn
            icon={<ClipboardPaste className="h-3.5 w-3.5" />}
            label={t("tablesList.paste")}
            onClick={handlePaste}
          />
          <ToolbarBtn
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label={
              selected.size > 1
                ? `${t("common.delete")} (${selected.size})`
                : t("common.delete")
            }
            disabled={selected.size === 0}
            onClick={() => {
              const first = selected.values().next().value;
              if (first) deleteTables(first);
            }}
            destructive
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("tablesList.filter")}
              className="w-56 rounded-md border border-border bg-background py-1 pl-6 pr-2 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
            />
          </div>
          <div className="ml-1 flex items-center gap-0 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={cn(
                "grid h-6 w-6 place-items-center rounded",
                viewMode === "list"
                  ? "bg-conn-accent/20 text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
              title={t("tablesList.viewList")}
            >
              <List className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={cn(
                "grid h-6 w-6 place-items-center rounded",
                viewMode === "grid"
                  ? "bg-conn-accent/20 text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
              title={t("tablesList.viewGrid")}
            >
              <LayoutGrid className="h-3 w-3" />
            </button>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            title={t("common.refresh")}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!connActive && (
          <div className="grid h-full place-items-center p-6 text-xs text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("tablesList.connecting")}
            </div>
          </div>
        )}
        {connActive && !tables && loading && (
          <div className="grid h-full place-items-center p-6 text-xs text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("tablesList.loadingTables")}
            </div>
          </div>
        )}
        {connActive && tables && viewMode === "grid" && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1 p-2">
            {sorted.map((tb) => {
              const isView =
                tb.kind === "view" || tb.kind === "materialized_view";
              const Icon = isView ? Eye : TableIcon;
              const isSel = selected.has(tb.name);
              return (
                <div
                  key={tb.name}
                  onClick={(e) => {
                    if (
                      !e.shiftKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      isSel &&
                      selected.size === 1
                    ) {
                      scheduleRename(tb.name);
                      return;
                    }
                    handleRowSelect(tb.name, e);
                  }}
                  onDoubleClick={() => {
                    clearRenameTimer();
                    openTable(tb.name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!isSel) {
                      setSelected(new Set([tb.name]));
                      setLastSelected(tb.name);
                    }
                    handleRowContextMenu(tb.name, e);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors select-none",
                    isSel
                      ? "border-conn-accent/50 bg-conn-accent/15"
                      : "border-border hover:bg-accent/30",
                  )}
                  title={tb.comment ?? undefined}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {editingName === tb.name ? (
                    <RenameInput
                      draft={editingDraft}
                      onDraft={setEditingDraft}
                      onCommit={commitRename}
                      onCancel={cancelRename}
                    />
                  ) : (
                    <span className="flex-1 truncate font-mono">
                      {tb.name}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {connActive && tables && viewMode === "list" && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card/60 backdrop-blur">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <Th sortKey="name" current={sortKey} dir={sortDir} onSort={toggleSort}>
                  {t("tablesList.colName")}
                </Th>
                {category === "all" && (
                  <Th sortKey="kind" current={sortKey} dir={sortDir} onSort={toggleSort}>
                    {t("tablesList.colKind")}
                  </Th>
                )}
                <Th sortKey="engine" current={sortKey} dir={sortDir} onSort={toggleSort}>
                  {t("tablesList.colEngine")}
                </Th>
                <Th
                  sortKey="rows"
                  current={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                >
                  {t("tablesList.colRows")}
                </Th>
                <Th
                  sortKey="size"
                  current={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                >
                  {t("tablesList.colSize")}
                </Th>
                <th className="px-3 py-1.5 text-left font-medium">
                  {t("tablesList.colComment")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((tb) => {
                const isSel = selected.has(tb.name);
                return (
                <tr
                  key={tb.name}
                  onClick={(e) => {
                    if (
                      !e.shiftKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      isSel &&
                      selected.size === 1
                    ) {
                      scheduleRename(tb.name);
                      return;
                    }
                    handleRowSelect(tb.name, e);
                  }}
                  onDoubleClick={() => {
                    clearRenameTimer();
                    openTable(tb.name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!isSel) {
                      setSelected(new Set([tb.name]));
                      setLastSelected(tb.name);
                    }
                    handleRowContextMenu(tb.name, e);
                  }}
                  className={cn(
                    "cursor-pointer border-t border-border transition-colors select-none",
                    isSel
                      ? "bg-conn-accent/15 text-foreground"
                      : "hover:bg-accent/30",
                  )}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      {tb.kind === "view" ? (
                        <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <TableIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      {editingName === tb.name ? (
                        <RenameInput
                          draft={editingDraft}
                          onDraft={setEditingDraft}
                          onCommit={commitRename}
                          onCancel={cancelRename}
                        />
                      ) : (
                        <span className="font-medium">{tb.name}</span>
                      )}
                    </div>
                  </Td>
                  {category === "all" && (
                    <Td className="text-[11px] text-muted-foreground">
                      {tb.kind === "view" ? "VIEW" : "TABLE"}
                    </Td>
                  )}
                  <Td className="font-mono text-[11px] text-muted-foreground">
                    {tb.engine ?? "—"}
                  </Td>
                  <Td align="right" className="tabular-nums text-muted-foreground">
                    {tb.row_estimate != null
                      ? tb.row_estimate.toLocaleString()
                      : "—"}
                  </Td>
                  <Td align="right" className="tabular-nums text-muted-foreground">
                    {formatBytes(tb.size_bytes)}
                  </Td>
                  <Td className="truncate text-[11px] text-muted-foreground">
                    {tb.comment ?? ""}
                  </Td>
                </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-xs italic text-muted-foreground"
                  >
                    {filter
                      ? t("tablesList.noMatch")
                      : t("tablesList.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {ctxMenu.element}
    </div>
  );
}

function ToolbarBtn({
  icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : destructive
            ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Th({
  children,
  sortKey,
  current,
  dir,
  onSort,
  align = "left",
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = current === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        "cursor-pointer select-none px-3 py-1.5 font-medium transition-colors",
        align === "right" ? "text-right" : "text-left",
        active ? "text-foreground" : "hover:text-foreground",
      )}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active && (
          <ArrowDownUp
            className={cn(
              "h-2.5 w-2.5",
              dir === "asc" ? "opacity-60" : "rotate-180 opacity-60",
            )}
          />
        )}
      </span>
    </th>
  );
}

function Td({
  children,
  className,
  align = "left",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn(
        "px-3 py-1.5",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Inline input used for rename via slow double-click. Auto-selects
 *  everything on mount. Enter confirms, ESC cancels, blur also confirms. */
function RenameInput({
  draft,
  onDraft,
  onCommit,
  onCancel,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      onChange={(e) => onDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCommit}
      className="h-6 flex-1 rounded border border-conn-accent/60 bg-background px-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
    />
  );
}
