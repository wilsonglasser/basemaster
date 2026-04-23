import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownUp,
  FileCode2,
  FilePlus2,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import type { SavedQuery, Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appAlert, appConfirm, appPrompt } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { filterBySchema, useSavedQueries } from "@/state/saved-queries";
import { useTabs } from "@/state/tabs";

interface Props {
  connectionId: Uuid;
  /** Se informado, filtra pra esse schema + queries sem schema (globais). */
  schema?: string;
}

type SortKey = "name" | "schema" | "updated";
type SortDir = "asc" | "desc";

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

export function SavedQueriesListView({ connectionId, schema }: Props) {
  const ensure = useSavedQueries((s) => s.ensure);
  const refresh = useSavedQueries((s) => s.refresh);
  const createQuery = useSavedQueries((s) => s.create);
  const updateQuery = useSavedQueries((s) => s.update);
  const deleteQuery = useSavedQueries((s) => s.delete);
  const allForConn = useSavedQueries((s) => s.cache[connectionId]);
  const loading = useSavedQueries((s) => s.loading[connectionId]);
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const t = useT();

  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    ensure(connectionId).catch((e) =>
      console.warn("saved_queries ensure:", e),
    );
  }, [connectionId, ensure]);

  const scoped = useMemo(() => {
    if (!allForConn) return [];
    return schema ? filterBySchema(allForConn, schema) : allForConn;
  }, [allForConn, schema]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let arr = scoped;
    if (q) {
      arr = arr.filter(
        (x) =>
          x.name.toLowerCase().includes(q) ||
          (x.schema ?? "").toLowerCase().includes(q) ||
          x.sql.toLowerCase().includes(q),
      );
    }
    arr = [...arr].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      } else if (sortKey === "schema") {
        cmp = (a.schema ?? "").localeCompare(b.schema ?? "", undefined, {
          sensitivity: "base",
        });
      } else if (sortKey === "updated") {
        cmp = a.updated_at - b.updated_at;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [scoped, filter, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "updated" ? "desc" : "asc");
    }
  };

  const openQuery = (q: SavedQuery) => {
    openOrFocus(
      (tab) =>
        tab.kind.kind === "query" && tab.kind.savedQueryId === q.id,
      () => ({
        label: q.name,
        kind: {
          kind: "query",
          connectionId: q.connection_id,
          schema: q.schema ?? undefined,
          initialSql: q.sql,
          savedQueryId: q.id,
          savedQueryName: q.name,
        },
        accentColor: conn?.color,
      }),
    );
  };

  const createBlank = async () => {
    const name = await appPrompt(t("savedQueriesList.newNamePrompt"), {
      defaultValue: t("query.savedQueryDefaultName"),
    });
    if (!name || !name.trim()) return;
    try {
      const saved = await createQuery(connectionId, {
        name: name.trim(),
        sql: "-- nova query\nSELECT 1;",
        schema: schema ?? null,
      });
      openQuery(saved);
    } catch (e) {
      void appAlert(`${t("savedQueriesList.createFailed")}: ${e}`);
    }
  };

  const renameQuery = async (q: SavedQuery) => {
    const next = await appPrompt(t("tree.renameSavedQueryPrompt"), {
      defaultValue: q.name,
    });
    if (!next || next.trim() === "" || next === q.name) return;
    try {
      await updateQuery(q.id, {
        name: next.trim(),
        sql: q.sql,
        schema: q.schema,
      });
    } catch (e) {
      void appAlert(`${t("tree.renameFailed")}: ${e}`);
    }
  };

  const removeQuery = async (q: SavedQuery) => {
    const ok = await appConfirm(
      t("tree.deleteSavedQueryConfirm", { name: q.name }),
    );
    if (!ok) return;
    try {
      await deleteQuery(connectionId, q.id);
    } catch (e) {
      void appAlert(`${t("tree.deleteFailed")}: ${e}`);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs">
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {conn?.name}
          {schema ? ` · ${schema}` : ""} · {t("tree.savedQueries")}
        </span>
        <span className="tabular-nums text-muted-foreground">
          ({filtered.length}
          {filtered.length !== scoped.length &&
            ` ${t("savedQueriesListView.countSuffix", { total: scoped.length })}`})
        </span>
        <div className="relative ml-3">
          <Search className="pointer-events-none absolute left-1.5 top-1.5 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("savedQueriesList.filter")}
            className="h-6 w-56 rounded border border-border bg-background pl-6 pr-2 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={createBlank}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-conn-accent px-2 text-[11px] font-medium text-conn-accent-foreground hover:opacity-90"
          >
            <FilePlus2 className="h-3 w-3" />
            {t("savedQueriesList.new")}
          </button>
          <button
            type="button"
            onClick={() => refresh(connectionId)}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("common.refresh")}
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !allForConn ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            {t("common.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <div className="text-sm text-muted-foreground">
                {t("savedQueriesList.empty")}
              </div>
              <button
                type="button"
                onClick={createBlank}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
              >
                <FilePlus2 className="h-3 w-3" />
                {t("savedQueriesList.new")}
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
              <tr className="border-b border-border">
                <Th onClick={() => toggleSort("name")} active={sortKey === "name"} dir={sortDir} className="w-[22%]">
                  {t("savedQueriesList.col.name")}
                </Th>
                <Th onClick={() => toggleSort("schema")} active={sortKey === "schema"} dir={sortDir} className="w-[14%]">
                  {t("savedQueriesList.col.schema")}
                </Th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("savedQueriesList.col.sql")}
                </th>
                <Th onClick={() => toggleSort("updated")} active={sortKey === "updated"} dir={sortDir} className="w-[18%]">
                  {t("savedQueriesList.col.updated")}
                </Th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((q) => (
                <Row
                  key={q.id}
                  q={q}
                  onOpen={() => openQuery(q)}
                  onRename={() => renameQuery(q)}
                  onDelete={() => removeQuery(q)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
  className?: string;
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "cursor-pointer select-none px-3 py-2 text-left font-medium hover:bg-accent/40",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          <span className="text-[10px] text-muted-foreground">
            {dir === "asc" ? "▲" : "▼"}
          </span>
        ) : (
          <ArrowDownUp className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

function Row({
  q,
  onOpen,
  onRename,
  onDelete,
}: {
  q: SavedQuery;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const menuItems: ContextEntry[] = [
    {
      icon: <FileCode2 className="h-3.5 w-3.5" />,
      label: t("tree.openSavedQuery"),
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
        onClick={onOpen}
        onContextMenu={menu.openAt}
      >
        <td className="truncate px-3 py-1.5 font-medium">{q.name}</td>
        <td className="px-3 py-1.5 text-muted-foreground">
          {q.schema ?? <span className="italic opacity-60">—</span>}
        </td>
        <td className="max-w-0 truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {truncate(q.sql, 180)}
        </td>
        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
          {formatDate(q.updated_at)}
        </td>
        <td className="px-3 py-1.5">
          <div className="hidden items-center gap-0.5 group-hover:flex">
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
