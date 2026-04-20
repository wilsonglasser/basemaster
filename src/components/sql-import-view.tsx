import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  FileText,
  FolderOpen,
  Play,
  Square,
  Upload,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type {
  ImportDone,
  ImportOptions,
  ImportProgress,
  ImportStmtError,
  Uuid,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useTabs } from "@/state/tabs";

interface Props {
  tabId: string;
  targetConnectionId: Uuid;
  schema?: string;
}

export function SqlImportView({ tabId, targetConnectionId, schema }: Props) {
  const t = useT();
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === targetConnectionId),
  );
  const ensureSchemas = useSchemaCache((s) => s.ensureSchemas);
  const schemas = useSchemaCache(
    (s) => s.caches[targetConnectionId]?.schemas ?? null,
  );
  const invalidateSchema = useSchemaCache((s) => s.invalidateSchema);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const patchTab = useTabs((s) => s.patch);

  const [path, setPath] = useState<string | null>(null);
  const [targetSchema, setTargetSchema] = useState<string>(
    schema ?? conn?.default_database ?? "",
  );
  const [continueOnError, setContinueOnError] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [done, setDone] = useState<ImportDone | null>(null);
  const [errors, setErrors] = useState<ImportStmtError[]>([]);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    ensureSchemas(targetConnectionId).catch(() => {});
  }, [targetConnectionId, ensureSchemas]);

  // Listeners.
  useEffect(() => {
    if (!running) return;
    const offProgress = listen<ImportProgress>("sql_import:progress", (e) => {
      setProgress(e.payload);
    });
    const offErr = listen<ImportStmtError>("sql_import:stmt_error", (e) => {
      setErrors((prev) => [...prev, e.payload]);
    });
    const offDone = listen<ImportDone>("sql_import:done", (e) => {
      setDone(e.payload);
      setRunning(false);
    });
    return () => {
      void offProgress.then((fn) => fn());
      void offErr.then((fn) => fn());
      void offDone.then((fn) => fn());
    };
  }, [running]);

  useEffect(() => {
    patchTab(tabId, {
      label: running
        ? t("sqlImport.labelRunning")
        : done
          ? t("sqlImport.labelDone")
          : t("sqlImport.labelIdle"),
      dirty: running,
    });
  }, [running, done, tabId, patchTab, t]);

  const pickFile = async () => {
    const p = await openFileDialog({
      title: t("sqlImport.pickFileTitle"),
      filters: [
        { name: t("sqlImport.pickFileFilterLabel"), extensions: ["sql", "zip"] },
        { name: t("sqlImport.pickFileAllLabel"), extensions: ["*"] },
      ],
    });
    if (typeof p === "string") setPath(p);
  };

  const handleStart = async () => {
    if (!path) {
      await pickFile();
      return;
    }
    const opts: ImportOptions = {
      target_connection_id: targetConnectionId,
      path,
      schema: targetSchema || null,
      continue_on_error: continueOnError,
    };
    setStartError(null);
    setProgress(null);
    setDone(null);
    setErrors([]);
    setRunning(true);
    try {
      await ipc.sqlImport.start(opts);
      // Invalida + re-fetch do schema afetado. Evita sumir a conexão
      // inteira da tree (perda de "config prévia" enquanto re-carrega).
      // Se não sabemos o schema, lista os schemas de novo — tree recarrega.
      if (targetSchema) {
        invalidateSchema(targetConnectionId, targetSchema);
        ensureSnapshot(targetConnectionId, targetSchema).catch(() => {});
      } else {
        await ensureSchemas(targetConnectionId);
      }
    } catch (e) {
      setStartError(String(e));
      setRunning(false);
    }
  };

  const handleStop = async () => {
    if (!window.confirm(t("sqlImport.stopConfirm"))) {
      return;
    }
    try {
      await ipc.transfer.stop();
    } catch (e) {
      console.error("stop import:", e);
    }
  };

  const fileKindLabel = !path
    ? null
    : path.toLowerCase().endsWith(".zip")
      ? "ZIP"
      : "SQL";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/30 px-6 text-sm">
        <Upload className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold">SQL Import</h2>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{conn?.name}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <Card title={t("sqlImport.cardFile")}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={pickFile}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
              >
                <FolderOpen className="h-3 w-3" />
                {t("sqlImport.pickFile")}
              </button>
              {path ? (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate font-mono">{path}</span>
                    {fileKindLabel && (
                      <span className="shrink-0 rounded bg-conn-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase text-conn-accent">
                        {fileKindLabel}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <span className="text-xs italic text-muted-foreground">
                  {t("sqlImport.noFile")}
                </span>
              )}
            </div>
          </Card>

          <Card title={t("sqlImport.cardDest")}>
            <label className="grid grid-cols-[160px_1fr] items-center gap-2 text-xs">
              <span>{t("sqlImport.defaultSchemaLabel")}</span>
              <select
                value={targetSchema}
                onChange={(e) => setTargetSchema(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              >
                <option value="">{t("sqlImport.noUsePrev")}</option>
                {(schemas ?? []).map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t("sqlImport.useHint")}
            </p>
          </Card>

          <Card title={t("sqlImport.cardOptions")}>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
                className="h-3.5 w-3.5 accent-conn-accent"
              />
              {t("sqlImport.continueOnError")}
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t("sqlImport.continueHint")}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("sqlImport.dialectHint")}
            </p>
          </Card>

          {startError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              <pre className="whitespace-pre-wrap break-all font-mono">
                {startError}
              </pre>
            </div>
          )}

          {(running || done) && (
            <Card title={t("sqlImport.cardProgress")}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="tabular-nums">
                  {t("sqlImport.statementsLabel", {
                    n: (progress?.statements_done ?? 0).toLocaleString(),
                    plural: (progress?.statements_done ?? 0) === 1 ? "" : "s",
                  })}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {t("sqlImport.errorsLabel", {
                    n: (progress?.errors ?? 0).toLocaleString(),
                    plural: (progress?.errors ?? 0) === 1 ? "" : "s",
                  })}
                </span>
              </div>
              {progress?.current_source && (
                <div className="truncate text-[11px] text-muted-foreground">
                  {progress.current_source}
                </div>
              )}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full transition-all",
                    done
                      ? done.errors > 0
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                      : "bg-conn-accent animate-pulse",
                  )}
                  style={{
                    width: done ? "100%" : running ? "100%" : "0",
                  }}
                />
              </div>
              {done && (
                <div
                  className={cn(
                    "mt-2 rounded-md border p-2 text-xs",
                    done.errors > 0
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                  )}
                >
                  {done.errors > 0
                    ? t("sqlImport.doneWithErrors", {
                        n: done.errors,
                        plural: done.errors === 1 ? "" : "s",
                      })
                    : t("sqlImport.doneOk")}
                  {t("sqlImport.doneStatements", {
                    n: done.statements_done.toLocaleString(),
                    seconds: (done.elapsed_ms / 1000).toFixed(1),
                  })}
                </div>
              )}
            </Card>
          )}

          {errors.length > 0 && (
            <Card title={t("sqlImport.cardErrors", { count: errors.length })}>
              <div className="max-h-64 space-y-1 overflow-auto">
                {errors.slice(-50).map((err) => (
                  <div
                    key={`${err.index}-${err.message.slice(0, 40)}`}
                    className="rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px]"
                  >
                    <div className="flex items-center gap-1.5 font-medium text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      <span>{t("sqlImport.stmtLabel", { index: err.index })}</span>
                    </div>
                    <div className="mt-1 font-mono text-muted-foreground">
                      {err.message}
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground/70">
                      {err.sql.slice(0, 200)}
                      {err.sql.length > 200 ? "…" : ""}
                    </pre>
                  </div>
                ))}
                {errors.length > 50 && (
                  <div className="text-[10px] italic text-muted-foreground">
                    {t("sqlImport.showingLastN", { total: errors.length })}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border bg-card/30 px-6">
        {running ? (
          <button
            type="button"
            onClick={handleStop}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20"
          >
            <Square className="h-3 w-3" />
            {t("sqlImport.stopBtn")}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStart}
            disabled={!path}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {done ? <Check className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {done ? t("sqlImport.runAgainBtn") : t("sqlImport.importBtn")}
          </button>
        )}
      </footer>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-4">
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}
