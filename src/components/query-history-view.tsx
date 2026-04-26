import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileCode2,
  History,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type { QueryHistoryEntry, Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appConfirm } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

interface Props {
  connectionId: Uuid;
}

function formatWhen(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

type StatusFilter = "all" | "success" | "error";

/** Renders `text` with any substring matching `query` (case-insensitive)
 *  wrapped in a highlight span. Falls back to plain text when no match. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let hit = lower.indexOf(q, i);
  let key = 0;
  while (hit >= 0) {
    if (hit > i) parts.push(<span key={key++}>{text.slice(i, hit)}</span>);
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-conn-accent/30 px-0.5 text-foreground"
      >
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    i = hit + q.length;
    hit = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(<span key={key++}>{text.slice(i)}</span>);
  return <>{parts}</>;
}

export function QueryHistoryView({ connectionId }: Props) {
  const t = useT();
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const newTab = useTabs((s) => s.open);
  const [entries, setEntries] = useState<QueryHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [schema, setSchema] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await ipc.queryHistory.list(connectionId);
      setEntries(list);
    } catch (e) {
      console.error("queryHistory list:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  /** Unique schemas seen in the history — for the schema dropdown. */
  const availableSchemas = useMemo(() => {
    if (!entries) return [] as string[];
    const set = new Set<string>();
    for (const e of entries) if (e.schema) set.add(e.schema);
    return [...set].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (status === "success" && !e.success) return false;
      if (status === "error" && e.success) return false;
      if (schema && e.schema !== schema) return false;
      if (q && !e.sql.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, status, schema]);

  const hasActiveFilters =
    filter.trim().length > 0 || status !== "all" || schema !== "";

  const clearFilters = () => {
    setFilter("");
    setStatus("all");
    setSchema("");
  };

  const current = filtered.find((e) => e.id === selected) ?? null;

  const reopen = (entry: QueryHistoryEntry, autoRun: boolean) => {
    newTab({
      label: truncate(entry.sql, 40),
      kind: {
        kind: "query",
        connectionId: entry.connection_id,
        schema: entry.schema ?? undefined,
        initialSql: entry.sql,
        autoRun,
      },
      accentColor: conn?.color,
    });
  };

  const clearAll = async () => {
    const ok = await appConfirm(t("queryHistory.clearConfirm"));
    if (!ok) return;
    await ipc.queryHistory.clear(connectionId);
    await load();
  };

  const deleteOne = async (id: Uuid) => {
    await ipc.queryHistory.delete(id);
    setEntries((prev) => prev?.filter((e) => e.id !== id) ?? null);
    if (selected === id) setSelected(null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs">
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {t("tree.historyLabel", { name: conn?.name ?? "" })}
        </span>
        <span className="tabular-nums text-muted-foreground">
          ({filtered.length}
          {entries && filtered.length !== entries.length &&
            t("queryHistory.countSuffix", { total: entries.length })})
        </span>
        <div className="relative ml-3">
          <Search className="pointer-events-none absolute left-1.5 top-1.5 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("queryHistory.filterPlaceholder")}
            className="h-6 w-56 rounded border border-border bg-background pl-6 pr-2 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          />
        </div>
        <div className="flex items-center rounded border border-border p-0.5">
          {(["all", "success", "error"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                "h-5 rounded px-2 text-[11px] transition-colors",
                status === s
                  ? "bg-conn-accent/20 text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {t(`queryHistory.status.${s}` as const)}
            </button>
          ))}
        </div>
        {availableSchemas.length > 0 && (
          <select
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            className="h-6 rounded border border-border bg-background px-1.5 text-xs focus:border-conn-accent focus:outline-none"
          >
            <option value="">{t("queryHistory.allSchemas")}</option>
            {availableSchemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("queryHistory.clearFilters")}
          >
            <X className="h-3 w-3" />
            {t("queryHistory.clearFilters")}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={load}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("common.refresh")}
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={!entries || entries.length === 0}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-destructive/30 px-2 text-[11px] text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            title={t("queryHistory.clearAllTitle")}
          >
            <Trash2 className="h-3 w-3" />
            {t("queryHistory.clearAll")}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Lista */}
        <div className="min-h-0 overflow-auto border-r border-border">
          {entries === null ? (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="grid h-full place-items-center text-xs italic text-muted-foreground">
              {entries.length === 0
                ? t("queryHistory.noneYet")
                : t("queryHistory.noMatch")}
            </div>
          ) : (
            <ul>
              {filtered.map((e) => (
                <li
                  key={e.id}
                  onClick={() => setSelected(e.id)}
                  onDoubleClick={() => reopen(e, true)}
                  className={cn(
                    "cursor-pointer border-b border-border/50 px-3 py-2 text-xs transition-colors",
                    selected === e.id
                      ? "bg-conn-accent/15"
                      : "hover:bg-accent/30",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {e.success ? (
                      <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                    ) : (
                      <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
                    )}
                    <span className="flex-1 truncate font-mono text-[11px]">
                      <HighlightedText
                        text={truncate(e.sql, 120)}
                        query={filter.trim()}
                      />
                    </span>
                  </div>
                  <div className="ml-5 mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span>{formatWhen(e.executed_at)}</span>
                    <span>·</span>
                    <span className="tabular-nums">
                      <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                      {(e.elapsed_ms / 1000).toFixed(2)}s
                    </span>
                    {e.schema && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{e.schema}</span>
                      </>
                    )}
                    {e.rows_affected != null && e.rows_affected > 0 && (
                      <>
                        <span>·</span>
                        <span>{e.rows_affected} rows</span>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detalhe */}
        <div className="flex min-h-0 flex-col overflow-hidden">
          {current ? (
            <>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/20 px-3 text-[11px]">
                <span className="text-muted-foreground">
                  {formatWhen(current.executed_at)}
                </span>
                <span className="text-muted-foreground/40">·</span>
                <span className="tabular-nums">
                  {(current.elapsed_ms / 1000).toFixed(2)}s
                </span>
                {current.schema && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="font-mono">{current.schema}</span>
                  </>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => reopen(current, false)}
                    className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[11px] hover:bg-accent"
                  >
                    <FileCode2 className="h-3 w-3" />
                    {t("queryHistory.openInEditor")}
                  </button>
                  <button
                    type="button"
                    onClick={() => reopen(current, true)}
                    className="inline-flex h-6 items-center gap-1 rounded bg-conn-accent px-2 text-[11px] font-medium text-conn-accent-foreground hover:opacity-90"
                  >
                    <FileCode2 className="h-3 w-3" />
                    {t("queryHistory.run")}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteOne(current.id)}
                    className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                    title={t("queryHistory.deleteFromHistoryTitle")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-background p-3 font-mono text-xs">
                {current.sql}
              </pre>
              {current.error_msg && (
                <div className="shrink-0 border-t border-destructive/30 bg-destructive/5 p-3 text-[11px] text-destructive">
                  <div className="mb-1 font-medium">{t("queryHistory.errorLabel")}</div>
                  <pre className="whitespace-pre-wrap break-all font-mono">
                    {current.error_msg}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="grid h-full place-items-center text-xs italic text-muted-foreground">
              {t("queryHistory.pickHint")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
