import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  FolderArchive,
  Info,
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
  DumpTableNote,
  DumpTableProgress,
  DumpWorkerProgress,
  Uuid,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { appConfirm } from "@/state/app-dialog";
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
  const [concurrency, setConcurrency] = useState(4);
  const [intraWorkers, setIntraWorkers] = useState(1);
  const [intraMinRows, setIntraMinRows] = useState(100000);
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
  const [workersByTable, setWorkersByTable] = useState<
    Map<string, Map<number, DumpWorkerProgress>>
  >(new Map());
  const [notesByTable, setNotesByTable] = useState<
    Map<string, DumpTableNote[]>
  >(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
    const offWorker = listen<DumpWorkerProgress>(
      "sql_dump:worker_progress",
      (e) => {
        const k = tableKey(e.payload.schema, e.payload.table);
        setWorkersByTable((prev) => {
          const next = new Map(prev);
          const inner = new Map(next.get(k) ?? new Map());
          inner.set(e.payload.worker_id, e.payload);
          next.set(k, inner);
          return next;
        });
      },
    );
    const offNote = listen<DumpTableNote>("sql_dump:table_note", (e) => {
      const k = tableKey(e.payload.schema, e.payload.table);
      setNotesByTable((prev) => {
        const next = new Map(prev);
        next.set(k, [...(next.get(k) ?? []), e.payload]);
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
      void offWorker.then((fn) => fn());
      void offNote.then((fn) => fn());
      void offDone.then((fn) => fn());
    };
  }, [running]);

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  // On format change, update the extension of the already-chosen path
  // (swap .sql <-> .zip). If there was no path, nothing happens.
  useEffect(() => {
    setPath((cur) => {
      if (!cur) return cur;
      const targetExt = format === "zip" ? "zip" : "sql";
      // Replace the last extension, whatever it is.
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
      concurrency,
      intra_table_workers: intraWorkers,
      intra_table_min_rows: intraMinRows,
    };
    setStartError(null);
    setDone(null);
    setPerTable(new Map());
    setDoneTable(new Map());
    setWorkersByTable(new Map());
    setNotesByTable(new Map());
    setExpanded(new Set());
    setRunning(true);
    try {
      await ipc.sqlDump.start(opts);
    } catch (e) {
      setStartError(String(e));
      setRunning(false);
    }
  };

  const handleStop = async () => {
    const ok = await appConfirm(t("sqlDump.stopConfirm"));
    if (!ok) return;
    try {
      await ipc.transfer.stop();
    } catch (e) {
      console.error("stop dump:", e);
    }
  };

  // Table list for the checklist: pre-known (scope.tables) union with
  // those that arrive via events (needed for schema-dump where the
  // backend discovers the list).
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

          {/* Content */}
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

          {/* Options */}
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

          {/* Parallelism */}
          <Card title={t("sqlDump.section.parallel")}>
            <NumberField
              label={t("sqlDump.parConcurrency")}
              hint={t("sqlDump.parConcurrencyHint")}
              value={concurrency}
              min={1}
              max={8}
              onChange={setConcurrency}
            />
            <NumberField
              label={t("sqlDump.parIntra")}
              hint={t("sqlDump.parIntraHint")}
              value={intraWorkers}
              min={1}
              max={8}
              onChange={setIntraWorkers}
              disabled={content === "structure"}
            />
            {intraWorkers > 1 && (
              <NumberField
                label={t("sqlDump.parIntraMin")}
                hint={t("sqlDump.parIntraMinHint")}
                value={intraMinRows}
                min={1}
                max={100000000}
                step={10000}
                onChange={setIntraMinRows}
                disabled={content === "structure"}
              />
            )}
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

          {/* Execution */}
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
                  allTables.map(({ schema, table }) => {
                    const k = tableKey(schema, table);
                    return (
                      <TableRow
                        key={k}
                        schema={schema}
                        table={table}
                        progress={perTable.get(k)}
                        done={doneTable.get(k)}
                        workers={workersByTable.get(k)}
                        notes={notesByTable.get(k)}
                        expanded={expanded.has(k)}
                        onToggle={() => toggleExpand(k)}
                      />
                    );
                  })
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

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-3 text-xs",
        disabled ? "cursor-not-allowed opacity-50" : "",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{label}</div>
        {hint && (
          <div className="truncate text-[10px] text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) {
            onChange(Math.min(max, Math.max(min, Math.floor(n))));
          }
        }}
        className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right font-mono text-xs tabular-nums"
      />
    </label>
  );
}

/** Per-shard drill-down for an intra-table parallel dump. Mirrors the
 *  data-transfer wizard's worker list: PK range, rows, elapsed, status. */
function WorkerList({
  workers,
}: {
  workers: Map<number, DumpWorkerProgress>;
}) {
  const sorted = useMemo(
    () => Array.from(workers.values()).sort((a, b) => a.worker_id - b.worker_id),
    [workers],
  );
  return (
    <div className="mt-1 grid gap-1 rounded border border-border/60 bg-background/40 p-2">
      {sorted.map((w) => {
        const status: "running" | "done" | "error" = w.finished
          ? w.error
            ? "error"
            : "done"
          : "running";
        return (
          <div
            key={w.worker_id}
            className={cn(
              "flex items-baseline gap-2 rounded px-2 py-0.5 text-[10px]",
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
            <span className="w-10 shrink-0 tabular-nums text-muted-foreground">
              #{w.worker_id}
            </span>
            <span className="flex-1 truncate font-mono text-muted-foreground">
              PK [{w.low_pk} .. {w.high_pk})
            </span>
            <span className="shrink-0 tabular-nums">
              {w.done.toLocaleString()}
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
              {(w.elapsed_ms / 1000).toFixed(1)}s
            </span>
            {w.error && (
              <span
                className="ml-1 max-w-[40%] shrink truncate font-mono text-destructive"
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

function NotesBadge({ notes }: { notes?: DumpTableNote[] }) {
  if (!notes || notes.length === 0) return null;
  const hasWarn = notes.some((n) => n.level === "warn");
  const Icon = hasWarn ? AlertCircle : Info;
  return (
    <span
      className={cn(
        "grid h-4 w-4 shrink-0 place-items-center",
        hasWarn ? "text-amber-400" : "text-muted-foreground",
      )}
      title={notes.map((n) => n.message).join("\n")}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

function TableRow({
  schema,
  table,
  progress,
  done,
  workers,
  notes,
  expanded,
  onToggle,
}: {
  schema: string;
  table: string;
  progress?: DumpTableProgress;
  done?: DumpTableDone;
  workers?: Map<number, DumpWorkerProgress>;
  notes?: DumpTableNote[];
  expanded: boolean;
  onToggle: () => void;
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
  const hasWorkers = workers !== undefined && workers.size > 0;
  return (
    <div
      className={cn(
        "rounded border px-2 py-1",
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
        className={cn("flex items-center gap-2", hasWorkers && "cursor-pointer")}
        onClick={hasWorkers ? onToggle : undefined}
      >
        {hasWorkers && (
          <span className="grid h-3.5 w-3.5 shrink-0 place-items-center text-muted-foreground">
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </span>
        )}
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
        <NotesBadge notes={notes} />
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
      {hasWorkers && expanded && <WorkerList workers={workers} />}
    </div>
  );
}
