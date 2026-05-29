import { useEffect } from "react";
import {
  Check,
  X,
  Loader2,
  Circle,
  Ban,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

import { useT, type TKey } from "@/state/i18n";
import { cn } from "@/lib/utils";
import { useExecutor, type JobStatus } from "@/state/executor";

function StatusIcon({ status }: { status: JobStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    case "ok":
      return <Check className="h-3.5 w-3.5 text-emerald-500" />;
    case "error":
      return <X className="h-3.5 w-3.5 text-destructive" />;
    case "skipped":
      return <Ban className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
  }
}

export function ExecutorDialog() {
  const t = useT();
  const open = useExecutor((s) => s.open);
  const title = useExecutor((s) => s.title);
  const jobs = useExecutor((s) => s.jobs);
  const running = useExecutor((s) => s.running);
  const cancelRequested = useExecutor((s) => s.cancelRequested);
  const requestCancel = useExecutor((s) => s.requestCancel);
  const close = useExecutor((s) => s.close);

  // Esc closes only when finished — never abandons a running batch silently.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, running, close]);

  if (!open) return null;

  const total = jobs.length;
  const done = jobs.filter(
    (j) => j.status === "ok" || j.status === "error" || j.status === "skipped",
  ).length;
  const failed = jobs.filter((j) => j.status === "error").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border bg-card/40 px-4 py-3">
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : failed > 0 ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          )}
          <h2 className="flex-1 truncate text-sm font-semibold">{title}</h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("executor.progress", { done: String(done), total: String(total) })}
          </span>
        </header>

        <div className="h-1.5 w-full bg-muted">
          <div
            className={cn(
              "h-full transition-all",
              failed > 0 && !running ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>

        <ul className="flex-1 overflow-y-auto px-2 py-2">
          {jobs.map((j) => (
            <li
              key={j.id}
              className={cn(
                "flex flex-col gap-0.5 rounded-md px-2 py-1.5",
                j.status === "error" && "bg-destructive/5",
              )}
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={j.status} />
                <span
                  className="flex-1 truncate font-mono text-xs"
                  title={j.label}
                >
                  {j.label}
                </span>
                <span
                  className={cn(
                    "text-[10px] uppercase tracking-wide",
                    j.status === "error"
                      ? "text-destructive"
                      : j.status === "ok"
                        ? "text-emerald-500"
                        : "text-muted-foreground",
                  )}
                >
                  {t(`executor.${j.status}` as TKey)}
                </span>
              </div>
              {j.error && (
                <p className="pl-[22px] text-[11px] leading-relaxed text-destructive">
                  {j.error}
                </p>
              )}
            </li>
          ))}
        </ul>

        <footer className="flex items-center justify-between gap-2 border-t border-border bg-card/30 px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {running
              ? cancelRequested
                ? t("executor.cancelling")
                : null
              : failed > 0
                ? t("executor.summaryWithErrors", {
                    ok: String(total - failed - jobs.filter((j) => j.status === "skipped").length),
                    failed: String(failed),
                  })
                : t("executor.summaryAllOk", { count: String(total) })}
          </span>
          {running ? (
            <button
              type="button"
              disabled={cancelRequested}
              onClick={requestCancel}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors",
                cancelRequested
                  ? "cursor-not-allowed text-muted-foreground"
                  : "hover:bg-accent",
              )}
            >
              <X className="h-3.5 w-3.5" />
              {t("executor.cancelRemaining")}
            </button>
          ) : (
            <button
              type="button"
              onClick={close}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              {t("common.close")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
