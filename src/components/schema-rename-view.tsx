import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, Check, Loader2, X } from "lucide-react";

import { ipc } from "@/lib/ipc";
import type { Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useTabs } from "@/state/tabs";

interface Props {
  tabId: string;
  connectionId: Uuid;
  from: string;
  to: string;
}

interface BackendProgress {
  done: number;
  total: number;
  current: string;
}

export function SchemaRenameView({ tabId, connectionId, from, to }: Props) {
  const t = useT();
  const closeMany = useTabs((s) => s.closeMany);
  const close = useTabs((s) => s.close);
  const patchTab = useTabs((s) => s.patch);
  const invalidateConn = useSchemaCache((s) => s.invalidate);

  const [progress, setProgress] = useState<BackendProgress | null>(null);
  const [status, setStatus] = useState<"running" | "done" | "error">(
    "running",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const progressUnlisten = listen<BackendProgress>(
      "schema_rename:progress",
      (e) => setProgress(e.payload),
    );
    const doneUnlisten = listen<unknown>("schema_rename:done", () => {
      setStatus("done");
      // Sidebar would still show the old schema; invalidate to force re-fetch.
      invalidateConn(connectionId);
      // Close tabs that pointed to the old schema : they'd 404 now.
      closeMany(
        (tab) =>
          (tab.kind.kind === "table" ||
            tab.kind.kind === "tables-list" ||
            tab.kind.kind === "saved-queries-list" ||
            tab.kind.kind === "new-table") &&
          "connectionId" in tab.kind &&
          tab.kind.connectionId === connectionId &&
          "schema" in tab.kind &&
          tab.kind.schema === from,
      );
    });
    return () => {
      void progressUnlisten.then((fn) => fn());
      void doneUnlisten.then((fn) => fn());
    };
  }, [connectionId, from, invalidateConn, closeMany]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await ipc.db.renameSchema(connectionId, from, to);
      } catch (e) {
        setStatus("error");
        setErrorMsg(String(e));
      }
    })();
  }, [connectionId, from, to]);

  const pct =
    progress && progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : status === "done"
        ? 100
        : 0;

  useEffect(() => {
    const suffix =
      status === "done" ? " · ok" : status === "error" ? " · err" : "";
    patchTab(tabId, {
      label: `${t("schemaRename.tabLabel", { name: from })}${suffix}`,
      dirty: status === "running",
    });
  }, [status, tabId, from, t, patchTab]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/30 px-6 text-xs">
        <div className="text-sm font-semibold">{t("schemaRename.title")}</div>
        <div className="ml-2 flex items-center gap-2 font-mono text-muted-foreground">
          <span>{from}</span>
          <ArrowRight className="h-3 w-3" />
          <span className="text-foreground">{to}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {status === "running" ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("schemaRename.running")}
            </>
          ) : status === "done" ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" />
              {t("schemaRename.done")}
            </>
          ) : (
            <>
              <X className="h-3 w-3 text-destructive" />
              {t("schemaRename.failed")}
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-6 pt-6">
          <div className="rounded-md border border-border bg-card/40 p-4">
            <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
              <span className="text-sm font-medium text-foreground">
                {t("schemaRename.overall")}
              </span>
              <div className="flex items-baseline gap-3 tabular-nums text-muted-foreground">
                <span>
                  {progress
                    ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} ${t("schemaRename.tablesUnit")}`
                    : t("schemaRename.preparing")}
                </span>
                <span className="text-sm font-semibold text-foreground">
                  {Math.floor(pct)}%
                </span>
              </div>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full transition-all duration-300",
                  status === "error"
                    ? "bg-destructive"
                    : status === "done"
                      ? "bg-emerald-500"
                      : "bg-conn-accent",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {progress && status === "running" && (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="font-mono">
                  {t("schemaRename.currentTable", { name: progress.current })}
                </span>
              </div>
            )}
          </div>

          {status === "done" && (
            <div className="flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-400">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <div className="font-medium">{t("schemaRename.successTitle")}</div>
                <div className="mt-1 text-xs opacity-80">
                  {t("schemaRename.successDetail", { from, to })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => close(tabId)}
                className="shrink-0 rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500/30"
              >
                {t("schemaRename.closeTab")}
              </button>
            </div>
          )}

          {status === "error" && errorMsg && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-xs text-destructive">
              <div className="mb-1 font-medium">{t("schemaRename.errorTitle")}</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] opacity-90">
                {errorMsg}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
