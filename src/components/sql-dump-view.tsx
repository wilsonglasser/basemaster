import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Check,
  Database,
  FileText,
  FolderArchive,
  Loader2,
  Play,
  Square,
  X,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type {
  DumpCompression,
  DumpContent,
  DumpDone,
  DumpFormat,
  DumpOptions,
  DumpTableDone,
  DumpTableProgress,
  Uuid,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

interface Props {
  tabId: string;
  sourceConnectionId: Uuid;
  scopes: Array<{ schema: string; tables?: string[] }>;
}

export function SqlDumpView({ tabId, sourceConnectionId, scopes }: Props) {
  const t = useT();
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === sourceConnectionId),
  );
  const patchTab = useTabs((s) => s.patch);

  const [format, setFormat] = useState<DumpFormat>("sql");
  const [compression, setCompression] =
    useState<DumpCompression>("stored");
  const [content, setContent] = useState<DumpContent>("both");
  const [dropBeforeCreate, setDropBeforeCreate] = useState(true);
  const [extendedInserts, setExtendedInserts] = useState(true);
  const [completeInserts, setCompleteInserts] = useState(false);
  const [hexBlob, setHexBlob] = useState(true);
  const [createSchema, setCreateSchema] = useState(false);
  const [path, setPath] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<DumpDone | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [perTable, setPerTable] = useState<Map<string, DumpTableProgress>>(
    new Map(),
  );
  const [doneTable, setDoneTable] = useState<Map<string, DumpTableDone>>(
    new Map(),
  );

  const defaultName = useMemo(() => {
    if (scopes.length === 1) {
      const s = scopes[0];
      if (s.tables && s.tables.length === 1) return `${s.schema}.${s.tables[0]}`;
      return s.schema;
    }
    return `dump-${scopes.length}-schemas`;
  }, [scopes]);

  // Key de cada tabela na UI: "schema.table".
  const tableKey = (schema: string, table: string) => `${schema}.${table}`;

  // Listeners de eventos.
  useEffect(() => {
    if (!running) return;
    const offProgress = listen<DumpTableProgress>(
      "sql_dump:progress",
      (e) => {
        setPerTable((prev) => {
          const next = new Map(prev);
          next.set(tableKey(e.payload.schema, e.payload.table), e.payload);
          return next;
        });
      },
    );
    const offTableDone = listen<DumpTableDone>("sql_dump:table_done", (e) => {
      setDoneTable((prev) => {
        const next = new Map(prev);
        next.set(tableKey(e.payload.schema, e.payload.table), e.payload);
        return next;
      });
    });
    const offDone = listen<DumpDone>("sql_dump:done", (e) => {
      setDone(e.payload);
      setRunning(false);
    });
    return () => {
      void offProgress.then((fn) => fn());
      void offTableDone.then((fn) => fn());
      void offDone.then((fn) => fn());
    };
  }, [running]);

  // Dirty + label.
  useEffect(() => {
    patchTab(tabId, {
      label: running
        ? t("sqlDump.labelRunning")
        : done
          ? t("sqlDump.labelDone")
          : t("sqlDump.labelIdle"),
      dirty: running,
    });
  }, [running, done, tabId, patchTab, t]);

  // Ao mudar o formato, atualiza a extensão do path já escolhido
  // (troca .sql <-> .zip). Se não havia path, nada acontece.
  useEffect(() => {
    setPath((cur) => {
      if (!cur) return cur;
      const targetExt = format === "zip" ? "zip" : "sql";
      // Substitui a última extensão, seja qual for.
      const noExt = cur.replace(/\.[^./\\]+$/, "");
      return `${noExt}.${targetExt}`;
    });
  }, [format]);

  const pickPath = async () => {
    const ext = format === "zip" ? "zip" : "sql";
    const label = format === "zip" ? "ZIP" : "SQL";
    const p = await save({
      title: t("sqlDump.saveTitle"),
      defaultPath: `${defaultName}.${ext}`,
      filters: [{ name: label, extensions: [ext] }],
    });
    if (p) setPath(p);
  };

  const handleStart = async () => {
    let target = path;
    if (!target) {
      const ext = format === "zip" ? "zip" : "sql";
      const label = format === "zip" ? "ZIP" : "SQL";
      const p = await save({
        title: t("sqlDump.saveTitle"),
        defaultPath: `${defaultName}.${ext}`,
        filters: [{ name: label, extensions: [ext] }],
      });
      if (!p) return;
      target = p;
      setPath(p);
    }
    const opts: DumpOptions = {
      source_connection_id: sourceConnectionId,
      scopes,
      path: target,
      format,
      compression: format === "zip" ? compression : undefined,
      content,
      drop_before_create: dropBeforeCreate,
      extended_inserts: extendedInserts,
      complete_inserts: completeInserts,
      hex_blob: hexBlob,
      create_schema: createSchema,
    };
    setStartError(null);
    setDone(null);
    setPerTable(new Map());
    setDoneTable(new Map());
    setRunning(true);
    try {
      await ipc.sqlDump.start(opts);
    } catch (e) {
      setStartError(String(e));
      setRunning(false);
    }
  };

  const handleStop = async () => {
    if (!window.confirm(t("sqlDump.stopConfirm"))) {
      return;
    }
    try {
      await ipc.transfer.stop();
    } catch (e) {
      console.error("stop dump:", e);
    }
  };

  // Lista de tabelas pra render do checklist: pré-conhecidas (scope.tables)
  // união com as que chegam via events (necessário pra schema-dump onde
  // backend descobre a lista).
  const allTables = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ schema: string; table: string }> = [];
    for (const s of scopes) {
      for (const t of s.tables ?? []) {
        const k = `${s.schema}.${t}`;
        if (!seen.has(k)) {
          seen.add(k);
          list.push({ schema: s.schema, table: t });
        }
      }
    }
    const addFromMap = (p: { schema: string; table: string }) => {
      const k = `${p.schema}.${p.table}`;
      if (!seen.has(k)) {
        seen.add(k);
        list.push({ schema: p.schema, table: p.table });
      }
    };
    perTable.forEach(addFromMap);
    doneTable.forEach(addFromMap);
    return list;
  }, [scopes, perTable, doneTable]);

  const totalTables =
    allTables.length > 0 ? allTables.length : doneTable.size || 1;
  const tablesDone = doneTable.size;
  const totalRows = Array.from(perTable.values()).reduce(
    (a, p) => a + p.done,
    0,
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/30 px-6 text-sm">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold">{t("sqlDump.header")}</h2>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{conn?.name}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {scopes.map((s) => s.schema).join(", ")}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {/* Formato */}
          <Card title={t("sqlDump.section.format")}>
            <div className="grid grid-cols-2 gap-2">
              <FormatCard
                active={format === "sql"}
                icon={<FileText className="h-4 w-4" />}
                label={t("sqlDump.formatSqlLabel")}
                hint={t("sqlDump.formatSqlHint")}
                onClick={() => setFormat("sql")}
              />
              <FormatCard
                active={format === "zip"}
                icon={<FolderArchive className="h-4 w-4" />}
                label={t("sqlDump.formatZipLabel")}
                hint={t("sqlDump.formatZipHint")}
                onClick={() => setFormat("zip")}
              />
            </div>
            {format === "zip" && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <FormatCard
                  compact
                  active={compression === "stored"}
                  label={t("sqlDump.compressionStoredLabel")}
                  hint={t("sqlDump.compressionStoredHint")}
                  onClick={() => setCompression("stored")}
                />
                <FormatCard
                  compact
                  active={compression === "deflate"}
                  label={t("sqlDump.compressionDeflateLabel")}
                  hint={t("sqlDump.compressionDeflateHint")}
                  onClick={() => setCompression("deflate")}
                />
              </div>
            )}
          </Card>

          {/* Conteúdo */}
          <Card title={t("sqlDump.section.content")}>
            <div className="grid grid-cols-3 gap-2">
              <FormatCard
                compact
                active={content === "structure"}
                label={t("sqlDump.contentStructure")}
                onClick={() => setContent("structure")}
              />
              <FormatCard
                compact
                active={content === "data"}
                label={t("sqlDump.contentData")}
                onClick={() => setContent("data")}
              />
              <FormatCard
                compact
                active={content === "both"}
                label={t("sqlDump.contentBoth")}
                onClick={() => setContent("both")}
              />
            </div>
          </Card>

          {/* Opções */}
          <Card title={t("sqlDump.section.options")}>
            <Toggle
              label={t("sqlDump.optDrop")}
              value={dropBeforeCreate}
              onChange={setDropBeforeCreate}
              disabled={content === "data"}
            />
            <Toggle
              label={t("sqlDump.optExtended")}
              value={extendedInserts}
              onChange={setExtendedInserts}
              disabled={content === "structure"}
            />
            <Toggle
              label={t("sqlDump.optComplete")}
              value={completeInserts}
              onChange={setCompleteInserts}
              disabled={content === "structure"}
            />
            {conn?.driver !== "postgres" && (
              <Toggle
                label={t("sqlDump.optHexBlob")}
                value={hexBlob}
                onChange={setHexBlob}
                disabled={content === "structure"}
              />
            )}
            <Toggle
              label={
                conn?.driver === "postgres"
                  ? t("sqlDump.optCreateSchemaPg")
                  : t("sqlDump.optCreateSchemaMysql")
              }
              value={createSchema}
              onChange={setCreateSchema}
            />
          </Card>

          {/* Destino */}
          <Card title={t("sqlDump.section.dest")}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={pickPath}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
              >
                {t("sqlDump.pickFile")}
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {path ?? t("sqlDump.pickFilePending")}
              </span>
            </div>
          </Card>

          {/* Execução */}
          {startError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              <pre className="whitespace-pre-wrap break-all font-mono">
                {startError}
              </pre>
            </div>
          )}

          {(running || done) && (
            <Card title={t("sqlDump.section.progress")}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="tabular-nums text-muted-foreground">
                  {t("sqlDump.tablesProgress", { done: tablesDone, total: totalTables })}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {t("sqlDump.rowsCount", { n: totalRows.toLocaleString() })}
                </span>
              </div>
              <div className="space-y-1 text-xs">
                {allTables.length > 0 ? (
                  allTables.map(({ schema, table }) => (
                    <TableRow
                      key={tableKey(schema, table)}
                      schema={schema}
                      table={table}
                      progress={perTable.get(tableKey(schema, table))}
                      done={doneTable.get(tableKey(schema, table))}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground">
                    {t("sqlDump.discoveringTables")}
                  </div>
                )}
              </div>
              {done && (
                <div
                  className={cn(
                    "mt-3 rounded-md border p-3 text-xs",
                    done.failed > 0
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                  )}
                >
                  {t("sqlDump.doneSummary", {
                    status:
                      done.failed > 0
                        ? t("sqlDump.doneWithErrors")
                        : t("sqlDump.doneOk"),
                    rows: done.total_rows.toLocaleString(),
                    seconds: (done.elapsed_ms / 1000).toFixed(1),
                  })}
                </div>
              )}
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
            {t("sqlDump.stopBtn")}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStart}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            <Play className="h-3 w-3" />
            {done ? t("sqlDump.runAgainBtn") : t("sqlDump.startBtn")}
          </button>
        )}
      </footer>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-4">
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}

function FormatCard({
  active,
  icon,
  label,
  hint,
  onClick,
  compact,
}: {
  active: boolean;
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-2 rounded-md border text-left transition-colors",
        compact ? "px-2 py-1.5" : "px-3 py-2",
        active
          ? "border-conn-accent/60 bg-conn-accent/10"
          : "border-border hover:bg-accent/40",
      )}
    >
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{label}</div>
        {hint && (
          <div className="truncate text-[10px] text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
    </button>
  );
}

function Toggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 text-xs",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-3.5 w-3.5 accent-conn-accent"
      />
      {label}
    </label>
  );
}

function TableRow({
  schema,
  table,
  progress,
  done,
}: {
  schema: string;
  table: string;
  progress?: DumpTableProgress;
  done?: DumpTableDone;
}) {
  const status: "pending" | "running" | "done" | "error" = done
    ? done.error
      ? "error"
      : "done"
    : progress
      ? "running"
      : "pending";
  const pct =
    progress && progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : done && !done.error
        ? 100
        : 0;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded border px-2 py-1",
        status === "error"
          ? "border-destructive/40 bg-destructive/5"
          : status === "done"
            ? "border-emerald-500/30 bg-emerald-500/5"
            : status === "running"
              ? "border-conn-accent/40 bg-conn-accent/5"
              : "border-border bg-card/30",
      )}
    >
      {status === "done" ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
      ) : status === "error" ? (
        <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
      ) : status === "running" ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-conn-accent" />
      ) : (
        <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      )}
      <span className="flex-1 truncate font-mono text-[11px]">
        {schema}.{table}
      </span>
      <span className="tabular-nums text-[10px] text-muted-foreground">
        {done
          ? `${done.rows.toLocaleString()} · ${(done.elapsed_ms / 1000).toFixed(1)}s`
          : progress
            ? `${progress.done.toLocaleString()}${progress.total > 0 ? ` / ${progress.total.toLocaleString()}` : ""}`
            : "—"}
      </span>
      {status === "running" && progress && progress.total > 0 && (
        <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
          {Math.floor(pct)}%
        </span>
      )}
      {done?.error && (
        <span
          className="max-w-[40%] truncate text-[10px] text-destructive"
          title={done.error}
        >
          {done.error}
        </span>
      )}
    </div>
  );
}
