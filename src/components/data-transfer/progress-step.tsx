import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Square,
  X,
} from "lucide-react";

import type {
  TableDone,
  TableNote,
  TableProgress,
  TableWorkerProgress,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

/** How many ms each just-finished table stays visible in the "running"
 *  bucket before migrating to its final bucket (completed/errors). Without
 *  this delay, on fast runs the user wouldn't see the check/cross. */
const FINISH_HOLD_MS = 3000;

type Bucket = "running" | "errors" | "completed";

export function ProgressStep({
  tables,
  perTable,
  doneTable,
  running,
  finalSummary,
  startError,
  failedTables,
  onRetryFailed,
  onRetrySingle,
  overallDone,
  overallTotal,
  overallPct,
  tablesDone,
  totalTables,
  paused,
  stopping,
  onPause,
  onResume,
  onStop,
  workersByTable,
  notesByTable,
}: {
  tables: string[];
  perTable: Map<string, TableProgress>;
  doneTable: Map<string, TableDone>;
  running: boolean;
  finalSummary: { total_rows: number; elapsed_ms: number; failed: number } | null;
  startError: string | null;
  failedTables: string[];
  onRetryFailed: () => void;
  onRetrySingle: (table: string) => void;
  overallDone: number;
  overallTotal: number;
  overallPct: number;
  tablesDone: number;
  totalTables: number;
  paused: boolean;
  stopping: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  workersByTable: Map<string, Map<number, TableWorkerProgress>>;
  notesByTable: Map<string, TableNote[]>;
}) {
  const t = useT();
  // With only 1 table, the "overall progress" is redundant with the checklist.
  const showOverall = totalTables > 1;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (t: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  // Active bucket — default "running" to follow execution. Switched
  // via pill tabs. If the whole run ended without errors, jump to
  // "completed"; if there are errors, don't jump (let the user decide).
  const [activeBucket, setActiveBucket] = useState<Bucket>("running");

  // Timestamp when each table entered `doneTable`. Needed to apply the
  // FINISH_HOLD_MS delay before migrating to completed/errors. The order of
  // done events comes from the backend, we don't control it.
  const finishedAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const map = finishedAtRef.current;
    for (const name of doneTable.keys()) {
      if (!map.has(name)) map.set(name, Date.now());
    }
    // Clear entries for tables that went away (e.g. retry reset).
    for (const name of map.keys()) {
      if (!doneTable.has(name)) map.delete(name);
    }
  }, [doneTable]);

  // Clock tick — forces re-render while any table is in the "hold period"
  // so the Date.now() - finishedAt < HOLD predicate re-evaluates. Stops
  // as soon as all finished tables have passed the hold.
  const [, setClock] = useState(0);
  useEffect(() => {
    const hasPendingHold = Array.from(finishedAtRef.current.values()).some(
      (ts) => Date.now() - ts < FINISH_HOLD_MS,
    );
    if (!hasPendingHold) return;
    const id = window.setInterval(() => setClock((c) => c + 1), 250);
    return () => window.clearInterval(id);
  }, [doneTable]);

  // Categorize each table — hold: still shown in "running" even though
  // doneTable already has an entry (to give the 3s highlight before migrating).
  const { runningList, errorsList, completedList } = useMemo(() => {
    const now = Date.now();
    const runningList: string[] = [];
    const errorsList: string[] = [];
    const completedList: string[] = [];
    for (const tbl of tables) {
      const d = doneTable.get(tbl);
      if (!d) {
        // pending or running — both live in "running"
        runningList.push(tbl);
        continue;
      }
      const finishedAt = finishedAtRef.current.get(tbl) ?? 0;
      const inHold = now - finishedAt < FINISH_HOLD_MS;
      if (inHold) {
        runningList.push(tbl);
      } else if (d.error) {
        errorsList.push(tbl);
      } else {
        completedList.push(tbl);
      }
    }
    return { runningList, errorsList, completedList };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, doneTable]);

  // Auto-switch to the "completed" bucket when everything ended without errors.
  // If there are errors, don't switch automatically — the user wants to see them.
  useEffect(() => {
    if (!finalSummary) return;
    if (runningList.length > 0) return;
    if (finalSummary.failed === 0 && errorsList.length === 0) {
      setActiveBucket("completed");
    } else if (activeBucket === "running") {
      // If the user was on running and now there are errors, move to errors.
      if (errorsList.length > 0) setActiveBucket("errors");
      else setActiveBucket("completed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalSummary, runningList.length, errorsList.length]);

  const visibleTables =
    activeBucket === "running"
      ? runningList
      : activeBucket === "errors"
        ? errorsList
        : completedList;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {startError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <pre className="whitespace-pre-wrap break-all font-mono">{startError}</pre>
        </div>
      )}

      {/* Final summary (when finished) */}
      {finalSummary && (
        <div
          className={cn(
            "flex items-start gap-3 rounded-md border p-4 text-sm",
            finalSummary.failed > 0
              ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
          )}
        >
          <div className="flex-1">
            <div className="font-medium">
              {finalSummary.failed > 0
                ? t("dataTransfer.doneWithErrors")
                : t("dataTransfer.doneOk")}
            </div>
            <div className="mt-1 text-xs opacity-80">
              {t("dataTransfer.summaryLine", {
                rows: finalSummary.total_rows.toLocaleString(),
                seconds: (finalSummary.elapsed_ms / 1000).toFixed(1),
              })}
              {finalSummary.failed > 0 &&
                t("dataTransfer.summaryFailuresSuffix", {
                  failed: finalSummary.failed,
                })}
            </div>
          </div>
          {finalSummary.failed > 0 && failedTables.length > 0 && !running && (
            <button
              type="button"
              onClick={onRetryFailed}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/30"
            >
              <RotateCcw className="h-3 w-3" />
              {t("dataTransfer.retryFailures", {
                n: failedTables.length,
                plural: failedTables.length === 1 ? "" : "s",
              })}
            </button>
          )}
        </div>
      )}

      {/* Controls: pause/resume/stop — only during execution */}
      {running && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card/40 p-3">
          {paused ? (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
            >
              <Play className="h-3 w-3" />
              {t("dataTransfer.resume")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onPause}
              disabled={stopping}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pause className="h-3 w-3" />
              {t("dataTransfer.pause")}
            </button>
          )}
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stopping ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Square className="h-3 w-3" />
            )}
            {stopping ? t("dataTransfer.stopping") : t("dataTransfer.stop")}
          </button>
          <div className="ml-auto text-[11px] text-muted-foreground">
            {paused
              ? t("dataTransfer.paused")
              : stopping
                ? t("dataTransfer.encerrando")
                : t("dataTransfer.running")}
          </div>
        </div>
      )}

      {/* Overall progress — sticky at top to follow scroll.
       *  Hidden when there's only 1 table (redundant with the checklist). */}
      {showOverall && (
      <div className="sticky top-0 z-10 rounded-md border border-border bg-card/95 p-4 backdrop-blur">
        <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">
              {t("dataTransfer.overall")}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {t("dataTransfer.tablesDoneFormat", { done: tablesDone, total: totalTables })}
            </span>
          </div>
          <div className="flex items-baseline gap-3 tabular-nums text-muted-foreground">
            <span>
              {overallDone.toLocaleString()}
              {overallTotal > 0 && ` / ${overallTotal.toLocaleString()}`} linhas
            </span>
            <span className="text-sm font-semibold text-foreground">
              {Math.floor(overallPct)}%
            </span>
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full transition-all duration-300",
              finalSummary?.failed && finalSummary.failed > 0
                ? "bg-amber-500"
                : "bg-conn-accent",
            )}
            style={{ width: `${overallPct}%` }}
          />
        </div>

        {/* Pill tabs — running / errors / completed */}
        <div className="mt-3 flex items-center gap-1 text-[11px]">
          <BucketPill
            label={t("dataTransfer.bucketRunning")}
            count={runningList.length}
            tone="accent"
            active={activeBucket === "running"}
            onClick={() => setActiveBucket("running")}
          />
          <BucketPill
            label={t("dataTransfer.bucketErrors")}
            count={errorsList.length}
            tone="destructive"
            active={activeBucket === "errors"}
            onClick={() => setActiveBucket("errors")}
          />
          <BucketPill
            label={t("dataTransfer.bucketCompleted")}
            count={completedList.length}
            tone="success"
            active={activeBucket === "completed"}
            onClick={() => setActiveBucket("completed")}
          />
        </div>
      </div>
      )}

      {/* Per-table checklist — filtered by active bucket */}
      <div className="space-y-1">
        {visibleTables.length === 0 && (
          <div className="rounded-md border border-border/60 bg-card/30 px-3 py-6 text-center text-xs italic text-muted-foreground">
            {activeBucket === "running"
              ? t("dataTransfer.bucketRunningEmpty")
              : activeBucket === "errors"
                ? t("dataTransfer.bucketErrorsEmpty")
                : t("dataTransfer.bucketCompletedEmpty")}
          </div>
        )}
        {visibleTables.map((tbl) => {
          const p = perTable.get(tbl);
          const d = doneTable.get(tbl);
          const pct =
            p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : d && !d.error ? 100 : 0;
          const status: "pending" | "running" | "done" | "error" = d
            ? d.error
              ? "error"
              : "done"
            : p
              ? "running"
              : "pending";

          const rowsLine = d
            ? t("dataTransfer.summaryLine", {
                rows: d.rows.toLocaleString(),
                seconds: (d.elapsed_ms / 1000).toFixed(1),
              })
            : p
              ? `${p.done.toLocaleString()}${p.total > 0 ? ` / ${p.total.toLocaleString()}` : ""}`
              : "—";

          const workers = workersByTable.get(tbl);
          const hasWorkers = workers && workers.size > 0;
          const isExpanded = expanded.has(tbl);
          return (
            <div
              key={tbl}
              className={cn(
                "rounded-md border px-3 py-2 transition-colors",
                status === "error"
                  ? "border-destructive/40 bg-destructive/5"
                  : status === "done"
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : status === "running"
                      ? "border-conn-accent/40 bg-conn-accent/5"
                      : "border-border bg-card/30",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2 text-xs",
                  hasWorkers && "cursor-pointer",
                )}
                onClick={hasWorkers ? () => toggleExpand(tbl) : undefined}
              >
                {hasWorkers && (
                  <span className="grid h-4 w-4 place-items-center text-muted-foreground">
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </span>
                )}
                {status === "done" ? (
                  <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                ) : status === "error" ? (
                  <X className="h-4 w-4 shrink-0 text-destructive" />
                ) : status === "running" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-conn-accent" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded-full border border-muted-foreground/40" />
                )}
                <span className="flex-1 truncate font-mono font-medium">{tbl}</span>
                <span className="shrink-0 text-right tabular-nums text-muted-foreground">
                  {rowsLine}
                </span>
                {status === "running" && p && p.total > 0 && (
                  <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {Math.floor(pct)}%
                  </span>
                )}
                {status === "error" && !running && (
                  <button
                    type="button"
                    onClick={() => onRetrySingle(tbl)}
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-amber-500/20 hover:text-amber-400"
                    title={t("dataTransfer.retrySingleTitle")}
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
              </div>
              {/* Per-table bar */}
              {(status === "running" || status === "done") && (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      status === "done" ? "bg-emerald-500" : "bg-conn-accent",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              {/* Error as full text — wraps so it doesn't overflow the card */}
              {d?.error && (
                <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 p-2">
                  <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-destructive">
                    {d.error}
                  </pre>
                </div>
              )}
              {/* Backend notes (e.g. intra-parallel enabled/disabled) */}
              {(notesByTable.get(tbl) ?? []).map((note, i) => (
                <div
                  key={i}
                  className={cn(
                    "mt-1 rounded border px-2 py-1 text-[10px]",
                    note.level === "warn"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                      : "border-conn-accent/30 bg-conn-accent/5 text-muted-foreground",
                  )}
                >
                  {note.message}
                </div>
              ))}
              {/* Drill-down: intra-table parallelism workers */}
              {isExpanded && hasWorkers && (
                <WorkerList workers={workers!} />
              )}
            </div>
          );
        })}
      </div>

      {running && !finalSummary && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Transferindo…
        </div>
      )}
    </div>
  );
}

function BucketPill({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: "accent" | "destructive" | "success";
  active: boolean;
  onClick: () => void;
}) {
  const toneClass = cn(
    "rounded-full px-2 py-0.5 text-[10px] tabular-nums font-medium",
    tone === "accent"
      ? active
        ? "bg-conn-accent/30 text-foreground"
        : "bg-conn-accent/15 text-conn-accent"
      : tone === "destructive"
        ? active
          ? "bg-destructive/30 text-foreground"
          : "bg-destructive/15 text-destructive"
        : active
          ? "bg-emerald-500/30 text-foreground"
          : "bg-emerald-500/15 text-emerald-500",
  );
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors",
        active
          ? "border-border bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      <span>{label}</span>
      <span className={toneClass}>{count}</span>
    </button>
  );
}

/** Grid with the workers of a table (intra-table parallelism).
 *  Each worker shows its PK range [low, high), rows done,
 *  elapsed time and status. Sorted by worker_id. */
function WorkerList({
  workers,
}: {
  workers: Map<number, TableWorkerProgress>;
}) {
  const sorted = useMemo(() => {
    return Array.from(workers.values()).sort((a, b) => a.worker_id - b.worker_id);
  }, [workers]);
  return (
    <div className="mt-2 grid gap-1 rounded border border-border/60 bg-background/40 p-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Workers ({sorted.length})
      </div>
      {sorted.map((w) => {
        const status: "pending" | "running" | "done" | "error" = w.finished
          ? w.error
            ? "error"
            : "done"
          : "running";
        return (
          <div
            key={w.worker_id}
            className={cn(
              "flex items-baseline gap-2 rounded px-2 py-1 text-[11px]",
              status === "error"
                ? "bg-destructive/10"
                : status === "done"
                  ? "bg-emerald-500/10"
                  : "bg-conn-accent/10",
            )}
          >
            <span className="shrink-0">
              {status === "done" ? (
                <Check className="h-3 w-3 text-emerald-500" />
              ) : status === "error" ? (
                <X className="h-3 w-3 text-destructive" />
              ) : (
                <Loader2 className="h-3 w-3 animate-spin text-conn-accent" />
              )}
            </span>
            <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
              #{w.worker_id}
            </span>
            <span className="flex-1 truncate font-mono text-muted-foreground">
              PK [{w.low_pk} .. {w.high_pk})
            </span>
            <span className="shrink-0 tabular-nums">
              {w.done.toLocaleString()} linhas
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
              {(w.elapsed_ms / 1000).toFixed(1)}s
            </span>
            {w.error && (
              <span
                className="ml-2 max-w-[50%] shrink truncate font-mono text-destructive"
                title={w.error}
              >
                {w.error}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
