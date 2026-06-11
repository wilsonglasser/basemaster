import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowRightLeft,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import type { SavedTransfer, TransferJob, Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appAlert, appConfirm, appPrompt } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { ipc } from "@/lib/ipc";
import { useTabs } from "@/state/tabs";

interface ParsedConfig {
  sourceConnectionId: Uuid | null;
  targetConnectionId: Uuid | null;
  jobs: Array<{ sourceSchema: string; targetSchema: string; tables: string[] }>;
}

function parseConfig(raw: string): ParsedConfig {
  try {
    const c = JSON.parse(raw);
    return {
      sourceConnectionId: c.sourceConnectionId ?? null,
      targetConnectionId: c.targetConnectionId ?? null,
      jobs: Array.isArray(c.jobs) ? c.jobs : [],
    };
  } catch {
    return { sourceConnectionId: null, targetConnectionId: null, jobs: [] };
  }
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function SavedTransfersListView() {
  const t = useT();
  const connections = useConnections((s) => s.connections);
  const openTab = useTabs((s) => s.open);
  const openOrFocus = useTabs((s) => s.openOrFocus);

  const [items, setItems] = useState<SavedTransfer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const connName = useCallback(
    (id: Uuid | null) =>
      id ? connections.find((c) => c.id === id)?.name ?? id : "?",
    [connections],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await ipc.savedTransfers.list());
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((x) => x.name.toLowerCase().includes(q));
  }, [items, filter]);

  const openEmpty = () =>
    openTab({
      label: t("tree.dataTransfer"),
      kind: { kind: "data-transfer" },
    });

  const openSaved = (item: SavedTransfer) => {
    const cfg = parseConfig(item.config);
    const jobs: TransferJob[] = cfg.jobs.map((j) => ({
      source_schema: j.sourceSchema,
      target_schema: j.targetSchema,
      tables: j.tables ?? [],
    }));
    openOrFocus(
      (tab) =>
        tab.kind.kind === "data-transfer" &&
        tab.kind.savedTransferId === item.id,
      () => ({
        label: item.name,
        kind: {
          kind: "data-transfer",
          sourceConnectionId: cfg.sourceConnectionId ?? undefined,
          targetConnectionId: cfg.targetConnectionId ?? undefined,
          initialJobs: jobs,
          savedTransferId: item.id,
        },
      }),
    );
  };

  const renameSaved = async (item: SavedTransfer) => {
    const next = await appPrompt(t("savedTransfers.renamePrompt"), {
      defaultValue: item.name,
    });
    if (!next || !next.trim() || next === item.name) return;
    try {
      await ipc.savedTransfers.update(item.id, {
        name: next.trim(),
        config: item.config,
      });
      await refresh();
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };

  const deleteSaved = async (item: SavedTransfer) => {
    const ok = await appConfirm(
      t("savedTransfers.deleteConfirm", { name: item.name }),
    );
    if (!ok) return;
    try {
      await ipc.savedTransfers.delete(item.id);
      await refresh();
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs">
        <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{t("savedTransfers.title")}</span>
        <span className="tabular-nums text-muted-foreground">
          ({filtered.length})
        </span>
        <div className="relative ml-3">
          <Search className="pointer-events-none absolute left-1.5 top-1.5 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("savedTransfers.filter")}
            className="h-6 w-56 rounded border border-border bg-background pl-6 pr-2 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={openEmpty}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-conn-accent px-2 text-[11px] font-medium text-conn-accent-foreground hover:opacity-90"
          >
            <Plus className="h-3 w-3" />
            {t("savedTransfers.new")}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("common.refresh")}
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !items ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            {t("common.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <div className="text-sm text-muted-foreground">
                {t("savedTransfers.empty")}
              </div>
              <button
                type="button"
                onClick={openEmpty}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
              >
                <Plus className="h-3 w-3" />
                {t("savedTransfers.new")}
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
              <tr className="border-b border-border">
                <th className="w-[26%] px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("savedTransfers.col.name")}
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("savedTransfers.col.route")}
                </th>
                <th className="w-[12%] px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("savedTransfers.col.schemas")}
                </th>
                <th className="w-[20%] px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("savedTransfers.col.updated")}
                </th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  connName={connName}
                  onOpen={() => openSaved(item)}
                  onRename={() => renameSaved(item)}
                  onDelete={() => deleteSaved(item)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Row({
  item,
  connName,
  onOpen,
  onRename,
  onDelete,
}: {
  item: SavedTransfer;
  connName: (id: Uuid | null) => string;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const cfg = useMemo(() => parseConfig(item.config), [item.config]);
  const menuItems: ContextEntry[] = [
    {
      icon: <ArrowRightLeft className="h-3.5 w-3.5" />,
      label: t("savedTransfers.open"),
      onClick: onOpen,
    },
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: t("tree.rename"),
      onClick: onRename,
    },
    { separator: true },
    {
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: t("common.delete"),
      onClick: onDelete,
      variant: "destructive",
    },
  ];
  const menu = useContextMenu(menuItems);
  return (
    <>
      <tr
        className="group cursor-pointer border-b border-border/50 hover:bg-accent/30"
        onDoubleClick={onOpen}
        onContextMenu={menu.openAt}
      >
        <td className="truncate px-3 py-1.5 font-medium">{item.name}</td>
        <td className="px-3 py-1.5 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="truncate">{connName(cfg.sourceConnectionId)}</span>
            <ArrowRight className="h-3 w-3 shrink-0 opacity-50" />
            <span className="truncate">{connName(cfg.targetConnectionId)}</span>
          </span>
        </td>
        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
          {t("savedTransfers.schemaCount", { n: cfg.jobs.length })}
        </td>
        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
          {formatDate(item.updated_at)}
        </td>
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t("tree.rename")}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              title={t("common.delete")}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </td>
      </tr>
      {menu.element}
    </>
  );
}
