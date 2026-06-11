import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  Database,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type {
  ConnectionFolder,
  ConnectionProfile,
  InsertMode,
  JobProgress,
  MultiTransferOptions,
  SchemaInfo,
  TableDone,
  TableInfo,
  TableNote,
  TableProgress,
  TableWorkerProgress,
  TransferJob,
  TransferOptions,
  Uuid,
} from "@/lib/types";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useSchemaCache } from "@/state/schema-cache";
import { useTableFolders } from "@/state/folder-stores";
import { appConfirm, appPrompt } from "@/state/app-dialog";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";
import { OptionsStep } from "@/components/data-transfer/options-step";
import { ProgressStep } from "@/components/data-transfer/progress-step";
import {
  buildDefaultTransferOptions,
  readPersistedTransferOptions,
  writePersistedTransferOptions,
  type PersistedTransferOptions,
} from "@/components/data-transfer/persisted-options";

type Step = "endpoints" | "tables" | "options" | "progress";

/** A schema-to-schema row in the jobs editor. `tables` empty means "all
 *  tables of the source schema" (resolved at run time); a non-empty list is
 *  an explicit subset. */
interface JobRow {
  key: string;
  sourceSchema: string;
  targetSchema: string;
  tables: string[];
}

/** Shape persisted in a saved transfer's `config` JSON. */
interface SavedTransferConfig {
  version: 1;
  sourceConnectionId: Uuid | null;
  targetConnectionId: Uuid | null;
  jobs: Array<{ sourceSchema: string; targetSchema: string; tables: string[] }>;
  options: Partial<TransferOptions>;
}

interface Props {
  tabId: string;
  initialSourceConnectionId?: Uuid;
  initialSourceSchema?: string;
  initialTargetConnectionId?: Uuid;
  initialTargetSchema?: string;
  initialTables?: string[];
  /** If true, jumps straight to the options step. */
  initialAutoAdvance?: boolean;
  /** When pasting a folder: after a successful transfer, recreate the
   *  folder on the target schema and assign the transferred tables. */
  initialTargetFolderName?: string;
  /** Pre-seeded schema jobs (e.g. loaded from a saved transfer). */
  initialJobs?: TransferJob[];
  /** If opened from a saved preset, its id : "Save" updates it in place. */
  initialSavedTransferId?: Uuid;
}

let jobKeySeq = 0;
const nextJobKey = () => `job-${jobKeySeq++}`;

export function DataTransferWizard({
  tabId,
  initialSourceConnectionId,
  initialSourceSchema,
  initialTargetConnectionId,
  initialTargetSchema,
  initialTables,
  initialAutoAdvance,
  initialTargetFolderName,
  initialJobs,
  initialSavedTransferId,
}: Props) {
  const t = useT();
  const patchTab = useTabs((s) => s.patch);
  const connections = useConnections((s) => s.connections);
  const folders = useConnections((s) => s.folders);
  const activeSet = useConnections((s) => s.active);
  const openConn = useConnections((s) => s.open);

  const [step, setStep] = useState<Step>(
    initialAutoAdvance ? "options" : "endpoints",
  );

  // --- endpoints (connection pair only; schemas live in jobs)
  const [sourceConn, setSourceConn] = useState<Uuid | null>(
    initialSourceConnectionId ?? null,
  );
  const [targetConn, setTargetConn] = useState<Uuid | null>(
    initialTargetConnectionId ?? null,
  );
  const [sourceSchemas, setSourceSchemas] = useState<SchemaInfo[]>([]);
  const [targetSchemas, setTargetSchemas] = useState<SchemaInfo[]>([]);

  // --- jobs (schema-to-schema rows)
  const [jobs, setJobs] = useState<JobRow[]>(() => {
    if (initialJobs && initialJobs.length > 0) {
      return initialJobs.map((j) => ({
        key: nextJobKey(),
        sourceSchema: j.source_schema,
        targetSchema: j.target_schema,
        tables: j.tables ?? [],
      }));
    }
    if (initialSourceSchema) {
      return [
        {
          key: nextJobKey(),
          sourceSchema: initialSourceSchema,
          targetSchema: initialTargetSchema ?? initialSourceSchema,
          tables: initialTables ?? [],
        },
      ];
    }
    return [];
  });
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  // Lazily-loaded table lists per source schema (for the per-job picker and
  // for resolving "all tables" at run time).
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, TableInfo[]>>(
    {},
  );
  const [tablesLoading, setTablesLoading] = useState<Set<string>>(new Set());

  // --- saved transfer link
  const [savedId, setSavedId] = useState<Uuid | null>(
    initialSavedTransferId ?? null,
  );
  const [savedName, setSavedName] = useState<string>("");

  // --- options (persisted in localStorage; last config is the next default)
  const persistedOpts = useMemo(() => readPersistedTransferOptions(), []);
  const cpuCores = useMemo(() => {
    const hw = typeof navigator !== "undefined"
      ? navigator.hardwareConcurrency ?? 4
      : 4;
    return Math.max(1, Math.min(8, hw));
  }, []);
  const defaults = useMemo(
    () => buildDefaultTransferOptions(cpuCores),
    [cpuCores],
  );
  const get = <K extends keyof PersistedTransferOptions>(
    k: K,
  ): PersistedTransferOptions[K] =>
    (persistedOpts?.[k] ?? defaults[k]) as PersistedTransferOptions[K];

  const [dropTarget, setDropTarget] = useState(get("dropTarget"));
  const [createTables, setCreateTables] = useState(get("createTables"));
  const [emptyTarget, setEmptyTarget] = useState(get("emptyTarget"));
  const [chunkSize, setChunkSize] = useState(get("chunkSize"));
  const [continueOnError, setContinueOnError] = useState(get("continueOnError"));
  const [concurrency, setConcurrency] = useState(get("concurrency"));
  const [insertMode, setInsertMode] = useState<InsertMode>(get("insertMode"));
  const [disableFkChecks, setDisableFkChecks] = useState(get("disableFkChecks"));
  const [disableUniqueChecks, setDisableUniqueChecks] = useState(
    get("disableUniqueChecks"),
  );
  const [disableBinlog, setDisableBinlog] = useState(get("disableBinlog"));
  const [binlogCheckDone, setBinlogCheckDone] = useState(false);
  const [useTransaction, setUseTransaction] = useState(get("useTransaction"));
  const [lockTarget, setLockTarget] = useState(get("lockTarget"));
  const [maxStmtKb, setMaxStmtKb] = useState(get("maxStmtKb"));
  const [useKeyset, setUseKeyset] = useState(get("useKeyset"));
  const [createTargetSchema, setCreateTargetSchema] = useState(
    get("createTargetSchema"),
  );
  const [createRecords, setCreateRecords] = useState(get("createRecords"));
  const [completeInserts, setCompleteInserts] = useState(get("completeInserts"));
  const [extendedInserts, setExtendedInserts] = useState(get("extendedInserts"));
  const [hexBlob, setHexBlob] = useState(get("hexBlob"));
  const [singleTransaction, setSingleTransaction] = useState(
    get("singleTransaction"),
  );
  const [lockSource, setLockSource] = useState(get("lockSource"));
  const [preserveZeroAutoInc, setPreserveZeroAutoInc] = useState(
    get("preserveZeroAutoInc"),
  );
  const [copyTriggers, setCopyTriggers] = useState(get("copyTriggers"));
  const [intraTableWorkers, setIntraTableWorkers] = useState(
    get("intraTableWorkers"),
  );
  const [intraTableMinRows, setIntraTableMinRows] = useState(
    get("intraTableMinRows"),
  );
  const [deferSecondaryIndexes, setDeferSecondaryIndexes] = useState(
    get("deferSecondaryIndexes"),
  );

  // Apply options coming from a loaded saved transfer (once).
  const appliedSavedOptsRef = useRef(false);
  useEffect(() => {
    if (appliedSavedOptsRef.current) return;
    if (!initialSavedTransferId) return;
    appliedSavedOptsRef.current = true;
    (async () => {
      try {
        const saved = await ipc.savedTransfers.get(initialSavedTransferId);
        setSavedName(saved.name);
        const cfg = JSON.parse(saved.config) as SavedTransferConfig;
        const o = cfg.options ?? {};
        if (o.drop_target != null) setDropTarget(o.drop_target);
        if (o.create_tables != null) setCreateTables(o.create_tables);
        if (o.empty_target != null) setEmptyTarget(o.empty_target);
        if (o.chunk_size != null) setChunkSize(o.chunk_size);
        if (o.continue_on_error != null) setContinueOnError(o.continue_on_error);
        if (o.concurrency != null) setConcurrency(o.concurrency);
        if (o.insert_mode != null) setInsertMode(o.insert_mode);
        if (o.disable_fk_checks != null) setDisableFkChecks(o.disable_fk_checks);
        if (o.disable_unique_checks != null)
          setDisableUniqueChecks(o.disable_unique_checks);
        if (o.disable_binlog != null) setDisableBinlog(o.disable_binlog);
        if (o.use_transaction != null) setUseTransaction(o.use_transaction);
        if (o.lock_target != null) setLockTarget(o.lock_target);
        if (o.max_statement_size_kb != null) setMaxStmtKb(o.max_statement_size_kb);
        if (o.use_keyset_pagination != null) setUseKeyset(o.use_keyset_pagination);
        if (o.create_target_schema != null)
          setCreateTargetSchema(o.create_target_schema);
        if (o.create_records != null) setCreateRecords(o.create_records);
        if (o.complete_inserts != null) setCompleteInserts(o.complete_inserts);
        if (o.extended_inserts != null) setExtendedInserts(o.extended_inserts);
        if (o.hex_blob != null) setHexBlob(o.hex_blob);
        if (o.single_transaction != null)
          setSingleTransaction(o.single_transaction);
        if (o.lock_source != null) setLockSource(o.lock_source);
        if (o.preserve_zero_auto_increment != null)
          setPreserveZeroAutoInc(o.preserve_zero_auto_increment);
        if (o.copy_triggers != null) setCopyTriggers(o.copy_triggers);
        if (o.intra_table_workers != null)
          setIntraTableWorkers(o.intra_table_workers);
        if (o.intra_table_min_rows != null)
          setIntraTableMinRows(o.intra_table_min_rows);
        if (o.defer_secondary_indexes != null)
          setDeferSecondaryIndexes(o.defer_secondary_indexes);
        // Binlog auto-check would override disable_binlog : honor the saved value.
        setBinlogCheckDone(true);
      } catch (e) {
        console.error("load saved transfer:", e);
      }
    })();
  }, [initialSavedTransferId]);

  /** Builds the flat option object shared by run and save. */
  const optionFields = (): Omit<
    TransferOptions,
    "source_connection_id" | "source_schema" | "target_connection_id" | "target_schema" | "tables"
  > => ({
    drop_target: dropTarget,
    create_tables: createTables,
    empty_target: emptyTarget,
    chunk_size: chunkSize,
    continue_on_error: continueOnError,
    concurrency,
    insert_mode: insertMode,
    disable_fk_checks: disableFkChecks,
    disable_unique_checks: disableUniqueChecks,
    disable_binlog: disableBinlog,
    use_transaction: useTransaction,
    lock_target: lockTarget,
    max_statement_size_kb: maxStmtKb,
    use_keyset_pagination: useKeyset,
    create_target_schema: createTargetSchema,
    create_records: createRecords,
    complete_inserts: completeInserts,
    extended_inserts: extendedInserts,
    hex_blob: hexBlob,
    single_transaction: singleTransaction,
    lock_source: lockSource,
    preserve_zero_auto_increment: preserveZeroAutoInc,
    copy_triggers: copyTriggers,
    intra_table_workers: intraTableWorkers,
    intra_table_min_rows: intraTableMinRows,
    defer_secondary_indexes: deferSecondaryIndexes,
  });

  // Persist option choices to localStorage : the last config becomes the
  // starting point next time.
  useEffect(() => {
    writePersistedTransferOptions({
      dropTarget,
      createTables,
      emptyTarget,
      chunkSize,
      continueOnError,
      concurrency,
      insertMode,
      disableFkChecks,
      disableUniqueChecks,
      disableBinlog,
      useTransaction,
      lockTarget,
      maxStmtKb,
      useKeyset,
      createTargetSchema,
      createRecords,
      completeInserts,
      extendedInserts,
      hexBlob,
      singleTransaction,
      lockSource,
      preserveZeroAutoInc,
      copyTriggers,
      intraTableWorkers,
      intraTableMinRows,
      deferSecondaryIndexes,
    });
  }, [
    dropTarget, createTables, emptyTarget, chunkSize, continueOnError,
    concurrency, insertMode, disableFkChecks, disableUniqueChecks,
    disableBinlog, useTransaction, lockTarget, maxStmtKb, useKeyset,
    createTargetSchema, createRecords, completeInserts, extendedInserts,
    hexBlob, singleTransaction, lockSource, preserveZeroAutoInc,
    copyTriggers, intraTableWorkers, intraTableMinRows, deferSecondaryIndexes,
  ]);

  // --- progress (maps keyed by qualified key : `schema · table` when multi)
  const [perTable, setPerTable] = useState<Map<string, TableProgress>>(new Map());
  const [doneTable, setDoneTable] = useState<Map<string, TableDone>>(new Map());
  const [workersByTable, setWorkersByTable] = useState<
    Map<string, Map<number, TableWorkerProgress>>
  >(new Map());
  const [notesByTable, setNotesByTable] = useState<Map<string, TableNote[]>>(
    new Map(),
  );
  const [running, setRunning] = useState(false);
  const [finalSummary, setFinalSummary] = useState<{
    total_rows: number;
    elapsed_ms: number;
    failed: number;
  } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Ordered qualified keys of the current run + reverse lookup for retries.
  const [runKeys, setRunKeys] = useState<string[]>([]);
  const runMetaRef = useRef<
    Map<string, { sourceSchema: string; targetSchema: string; table: string }>
  >(new Map());
  const isMultiRef = useRef(false);
  const currentJobRef = useRef<{ targetSchema: string }>({ targetSchema: "" });
  const keyFor = (table: string) =>
    isMultiRef.current
      ? `${currentJobRef.current.targetSchema} · ${table}`
      : table;

  const handlePause = async () => {
    try {
      await ipc.transfer.pause();
      setPaused(true);
    } catch (e) {
      console.error("pause:", e);
    }
  };
  const handleResume = async () => {
    try {
      await ipc.transfer.resume();
      setPaused(false);
    } catch (e) {
      console.error("resume:", e);
    }
  };
  const handleStop = async () => {
    const ok = await appConfirm(t("dataTransfer.stopConfirm"));
    if (!ok) return;
    try {
      setStopping(true);
      await ipc.transfer.stop();
      if (paused) {
        await ipc.transfer.resume();
        setPaused(false);
      }
    } catch (e) {
      console.error("stop:", e);
    }
  };

  // --- load schemas when the source connection changes
  useEffect(() => {
    if (!sourceConn) {
      setSourceSchemas([]);
      return;
    }
    (async () => {
      try {
        if (!activeSet.has(sourceConn)) await openConn(sourceConn);
        setSourceSchemas(await ipc.db.listSchemas(sourceConn));
      } catch (e) {
        console.error("source schemas:", e);
      }
    })();
    // Source connection changed : cached table lists are stale.
    setTablesBySchema({});
  }, [sourceConn, activeSet, openConn]);

  // --- load schemas when the target connection changes (+ binlog auto-check)
  useEffect(() => {
    if (!targetConn) {
      setTargetSchemas([]);
      return;
    }
    (async () => {
      try {
        if (!activeSet.has(targetConn)) await openConn(targetConn);
        setTargetSchemas(await ipc.db.listSchemas(targetConn));
        const connInfo = useConnections
          .getState()
          .connections.find((c) => c.id === targetConn);
        if (connInfo?.driver === "mysql" && !binlogCheckDone) {
          try {
            const enabled = await ipc.transfer.checkBinlogEnabled(targetConn);
            if (!enabled) setDisableBinlog(true);
          } catch {
            // ignore : keep default
          }
          setBinlogCheckDone(true);
        }
      } catch (e) {
        console.error("target schemas:", e);
      }
    })();
  }, [targetConn, activeSet, openConn, binlogCheckDone]);

  /** Loads (and caches) the table list of a source schema. */
  const ensureTables = async (schema: string): Promise<TableInfo[]> => {
    if (!sourceConn) return [];
    if (tablesBySchema[schema]) return tablesBySchema[schema];
    setTablesLoading((p) => new Set(p).add(schema));
    try {
      if (!activeSet.has(sourceConn)) await openConn(sourceConn);
      const ts = await ipc.db.listTables(sourceConn, schema);
      setTablesBySchema((prev) => ({ ...prev, [schema]: ts }));
      return ts;
    } catch (e) {
      console.error("list tables:", schema, e);
      return [];
    } finally {
      setTablesLoading((p) => {
        const n = new Set(p);
        n.delete(schema);
        return n;
      });
    }
  };

  // --- job editing helpers
  const addJob = (sourceSchema = "") =>
    setJobs((prev) => [
      ...prev,
      {
        key: nextJobKey(),
        sourceSchema,
        targetSchema: sourceSchema,
        tables: [],
      },
    ]);

  const addAllSchemas = () => {
    const used = new Set(jobs.map((j) => j.sourceSchema));
    const toAdd = sourceSchemas
      .map((s) => s.name)
      .filter((name) => !used.has(name));
    if (toAdd.length === 0) return;
    setJobs((prev) => [
      ...prev,
      ...toAdd.map((name) => ({
        key: nextJobKey(),
        sourceSchema: name,
        targetSchema: name,
        tables: [],
      })),
    ]);
  };

  const updateJob = (key: string, patch: Partial<JobRow>) =>
    setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  const removeJob = (key: string) =>
    setJobs((prev) => prev.filter((j) => j.key !== key));

  const toggleJobExpand = (key: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    const job = jobs.find((j) => j.key === key);
    if (job?.sourceSchema) void ensureTables(job.sourceSchema);
  };

  const sourceConnInfo = connections.find((c) => c.id === sourceConn);
  const targetConnInfo = connections.find((c) => c.id === targetConn);
  const targetIsMysql = (targetConnInfo?.driver ?? "mysql") === "mysql";
  const crossDialect =
    sourceConnInfo?.driver !== targetConnInfo?.driver &&
    !!sourceConnInfo?.driver &&
    !!targetConnInfo?.driver;

  const canGoToTables = !!sourceConn && !!targetConn;
  const validJobs = jobs.filter((j) => j.sourceSchema && j.targetSchema);
  const canRun = validJobs.length > 0;

  /** Resolves the editor rows into concrete `TransferJob`s (fetching the full
   *  table list for any "all tables" row). */
  const resolveJobs = async (): Promise<TransferJob[]> => {
    const out: TransferJob[] = [];
    for (const j of jobs) {
      if (!j.sourceSchema || !j.targetSchema) continue;
      let tables = j.tables;
      if (tables.length === 0) {
        const ts = await ensureTables(j.sourceSchema);
        tables = ts.map((tbl) => tbl.name);
      }
      if (tables.length === 0) continue;
      out.push({
        source_schema: j.sourceSchema,
        target_schema: j.targetSchema,
        tables,
      });
    }
    return out;
  };

  const buildOpts = (resolved: TransferJob[]): MultiTransferOptions => {
    const first = resolved[0];
    return {
      source_connection_id: sourceConn!,
      source_schema: first?.source_schema ?? "",
      target_connection_id: targetConn!,
      target_schema: first?.target_schema ?? "",
      tables: first?.tables ?? [],
      ...optionFields(),
      jobs: resolved,
    };
  };

  /** Runs the given resolved jobs. On a full run (reset=true) rebuilds the
   *  progress view; on a retry (reset=false) only the resetKeys are cleared. */
  const runResolved = async (
    resolved: TransferJob[],
    reset: boolean,
    resetKeys?: string[],
  ) => {
    if (resolved.length === 0) return;

    setStep("progress");
    setRunning(true);
    setFinalSummary(null);
    setStartError(null);
    setPaused(false);
    setStopping(false);
    currentJobRef.current = { targetSchema: "" };

    if (reset) {
      const multi = resolved.length > 1;
      isMultiRef.current = multi;
      const keys: string[] = [];
      const meta = new Map<
        string,
        { sourceSchema: string; targetSchema: string; table: string }
      >();
      for (const job of resolved) {
        for (const table of job.tables) {
          const k = multi ? `${job.target_schema} · ${table}` : table;
          keys.push(k);
          meta.set(k, {
            sourceSchema: job.source_schema,
            targetSchema: job.target_schema,
            table,
          });
        }
      }
      runMetaRef.current = meta;
      setRunKeys(keys);
      setPerTable(new Map());
      setDoneTable(new Map());
      setWorkersByTable(new Map());
      setNotesByTable(new Map());
    } else if (resetKeys) {
      const drop = (prev: Map<string, unknown>) => {
        const next = new Map(prev);
        for (const k of resetKeys) next.delete(k);
        return next;
      };
      setPerTable((p) => drop(p) as Map<string, TableProgress>);
      setDoneTable((p) => drop(p) as Map<string, TableDone>);
      setWorkersByTable(
        (p) => drop(p) as Map<string, Map<number, TableWorkerProgress>>,
      );
      setNotesByTable((p) => drop(p) as Map<string, TableNote[]>);
    }

    try {
      await ipc.transfer.startMulti(buildOpts(resolved));
    } catch (e) {
      setStartError(String(e));
      setRunning(false);
    }
  };

  const handleRun = async () => {
    if (!sourceConn || !targetConn) return;
    const resolved = await resolveJobs();
    if (resolved.length === 0) {
      setStartError(t("dataTransfer.noTablesToRun"));
      setStep("progress");
      return;
    }
    await runResolved(resolved, true);
  };

  const failedTables = useMemo(
    () =>
      Array.from(doneTable.entries())
        .filter(([, d]) => d.error)
        .map(([key]) => key),
    [doneTable],
  );

  /** Rebuilds jobs for a set of failed qualified keys, grouping by schema. */
  const jobsForKeys = (keys: string[]): TransferJob[] => {
    const byPair = new Map<string, TransferJob>();
    for (const k of keys) {
      const m = runMetaRef.current.get(k);
      if (!m) continue;
      const pair = `${m.sourceSchema} ${m.targetSchema}`;
      const job =
        byPair.get(pair) ??
        { source_schema: m.sourceSchema, target_schema: m.targetSchema, tables: [] };
      job.tables.push(m.table);
      byPair.set(pair, job);
    }
    return Array.from(byPair.values());
  };

  const retryFailed = () => {
    if (failedTables.length === 0) return;
    void runResolved(jobsForKeys(failedTables), false, failedTables);
  };
  const retrySingle = (key: string) => {
    void runResolved(jobsForKeys([key]), false, [key]);
  };

  // --- progress event listeners
  useEffect(() => {
    if (!running) return;
    const jobUnlisten = listen<JobProgress>("transfer:job_progress", (e) => {
      currentJobRef.current = { targetSchema: e.payload.target_schema };
    });
    const progressUnlisten = listen<TableProgress>("transfer:progress", (e) => {
      const key = keyFor(e.payload.table);
      setPerTable((prev) => new Map(prev).set(key, e.payload));
    });
    const doneUnlisten = listen<TableDone>("transfer:table_done", (e) => {
      const key = keyFor(e.payload.table);
      setDoneTable((prev) => new Map(prev).set(key, e.payload));
    });
    const workerUnlisten = listen<TableWorkerProgress>(
      "transfer:worker_progress",
      (e) => {
        const key = keyFor(e.payload.table);
        setWorkersByTable((prev) => {
          const next = new Map(prev);
          const inner = new Map(next.get(key) ?? new Map());
          inner.set(e.payload.worker_id, e.payload);
          next.set(key, inner);
          return next;
        });
      },
    );
    const noteUnlisten = listen<TableNote>("transfer:table_note", (e) => {
      const key = keyFor(e.payload.table);
      setNotesByTable((prev) => {
        const next = new Map(prev);
        next.set(key, [...(next.get(key) ?? []), e.payload]);
        return next;
      });
    });
    const finalUnlisten = listen<{
      total_rows: number;
      elapsed_ms: number;
      failed: number;
    }>("transfer:done", (e) => {
      setFinalSummary(e.payload);
      setRunning(false);
      // Re-index every target schema touched so new/dropped tables show up.
      if (targetConn) {
        const cache = useSchemaCache.getState();
        const isActive = useConnections.getState().active.has(targetConn);
        const schemas = new Set(
          Array.from(runMetaRef.current.values()).map((m) => m.targetSchema),
        );
        for (const sch of schemas) {
          cache.invalidateSchema(targetConn, sch);
          if (isActive) {
            cache
              .ensureSnapshot(targetConn, sch)
              .catch((err) =>
                console.warn("[transfer] re-index target failed:", err),
              );
          }
        }
      }

      // Folder paste: recreate the folder on the (single) target schema and
      // assign the transferred tables. Best-effort.
      const onlyTarget =
        initialTargetSchema ??
        Array.from(runMetaRef.current.values())[0]?.targetSchema;
      if (
        targetConn &&
        onlyTarget &&
        initialTargetFolderName &&
        e.payload.failed === 0
      ) {
        const tableNames = Array.from(runMetaRef.current.values())
          .filter((m) => m.targetSchema === onlyTarget)
          .map((m) => m.table);
        if (tableNames.length > 0) {
          (async () => {
            const tfState = useTableFolders.getState();
            await tfState.ensure(targetConn, onlyTarget);
            const existing = (
              tfState.folders[`${targetConn}:${onlyTarget}`] ?? []
            ).find((f) => f.name === initialTargetFolderName);
            const folder =
              existing ??
              (await tfState.create(targetConn, onlyTarget, initialTargetFolderName));
            for (const tn of tableNames) {
              await tfState
                .move(targetConn, onlyTarget, tn, folder.id)
                .catch(() => {});
            }
          })().catch((err) =>
            console.warn("[transfer] folder assign failed:", err),
          );
        }
      }
    });
    return () => {
      void jobUnlisten.then((fn) => fn());
      void progressUnlisten.then((fn) => fn());
      void doneUnlisten.then((fn) => fn());
      void finalUnlisten.then((fn) => fn());
      void workerUnlisten.then((fn) => fn());
      void noteUnlisten.then((fn) => fn());
    };
  }, [running]);

  // --- Overall progress (sums done/total rows across all keys)
  const overallRows = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const p of perTable.values()) {
      done += p.done;
      total += p.total;
    }
    for (const d of doneTable.values()) {
      if (!d.error) done += d.rows;
    }
    return { done, total };
  }, [perTable, doneTable]);

  const totalTables = runKeys.length || 1;
  const tablesDone = doneTable.size;
  const overallPct = useMemo(() => {
    if (runKeys.length === 0) return 0;
    const weight = 100 / runKeys.length;
    let pct = 0;
    for (const k of runKeys) {
      const d = doneTable.get(k);
      if (d) {
        if (!d.error) pct += weight;
        continue;
      }
      const p = perTable.get(k);
      if (p && p.total > 0) pct += Math.min(1, p.done / p.total) * weight;
    }
    return Math.min(100, pct);
  }, [runKeys, perTable, doneTable]);

  // Tab title with % while running.
  useEffect(() => {
    if (running) {
      patchTab(tabId, {
        label: `Transfer · ${Math.floor(overallPct)}%`,
        dirty: true,
      });
    } else if (finalSummary) {
      const suffix =
        finalSummary.failed > 0 ? ` · ${finalSummary.failed} err` : " · ok";
      patchTab(tabId, { label: `Transfer${suffix}`, dirty: false });
    }
  }, [running, finalSummary, overallPct, tabId, patchTab]);

  // Taskbar progress.
  useEffect(() => {
    if (running) {
      const status = paused ? "paused" : "normal";
      ipc.taskbar.setProgress(status, Math.floor(overallPct)).catch(() => {});
    } else if (finalSummary) {
      const status = finalSummary.failed > 0 ? "error" : "normal";
      ipc.taskbar.setProgress(status, 100).catch(() => {});
      const id = window.setTimeout(() => {
        ipc.taskbar.setProgress("none").catch(() => {});
      }, 4000);
      return () => window.clearTimeout(id);
    } else {
      ipc.taskbar.setProgress("none").catch(() => {});
    }
  }, [running, paused, overallPct, finalSummary]);

  // --- save / update preset
  const handleSave = async () => {
    if (!canRun) {
      void appConfirm(t("dataTransfer.saveNeedsJobs"));
      return;
    }
    const name = await appPrompt(t("dataTransfer.savePrompt"), {
      title: t("dataTransfer.saveTitle"),
      defaultValue: savedName,
    });
    if (!name || !name.trim()) return;
    const config: SavedTransferConfig = {
      version: 1,
      sourceConnectionId: sourceConn,
      targetConnectionId: targetConn,
      jobs: validJobs.map((j) => ({
        sourceSchema: j.sourceSchema,
        targetSchema: j.targetSchema,
        tables: j.tables,
      })),
      options: optionFields(),
    };
    const draft = { name: name.trim(), config: JSON.stringify(config) };
    try {
      if (savedId) {
        await ipc.savedTransfers.update(savedId, draft);
      } else {
        const created = await ipc.savedTransfers.create(draft);
        setSavedId(created.id);
        patchTab(tabId, {
          kind: {
            kind: "data-transfer",
            sourceConnectionId: sourceConn ?? undefined,
            targetConnectionId: targetConn ?? undefined,
            savedTransferId: created.id,
          },
        });
      }
      setSavedName(name.trim());
      patchTab(tabId, { label: name.trim() });
    } catch (e) {
      void appConfirm(t("common.failure", { error: String(e) }));
    }
  };

  const headerActions: ReactNode = (
    <button
      type="button"
      onClick={() => void handleSave()}
      disabled={!canRun}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      title={t("dataTransfer.saveTitle")}
    >
      <Save className="h-3.5 w-3.5" />
      {savedId ? t("dataTransfer.update") : t("dataTransfer.save")}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <StepperHeader
        step={step}
        onJump={running ? undefined : setStep}
        actions={headerActions}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {step === "endpoints" && (
          <EndpointsStep
            connections={connections}
            folders={folders}
            sourceConn={sourceConn}
            setSourceConn={setSourceConn}
            targetConn={targetConn}
            setTargetConn={setTargetConn}
            sourceConnInfo={sourceConnInfo}
            targetConnInfo={targetConnInfo}
          />
        )}

        {step === "tables" && (
          <JobsStep
            jobs={jobs}
            sourceSchemas={sourceSchemas}
            targetSchemas={targetSchemas}
            tablesBySchema={tablesBySchema}
            tablesLoading={tablesLoading}
            expanded={expandedJobs}
            onToggleExpand={toggleJobExpand}
            onUpdate={updateJob}
            onRemove={removeJob}
            onAdd={() => addJob()}
            onAddAll={addAllSchemas}
            ensureTables={ensureTables}
          />
        )}

        {step === "options" && (
          <OptionsStep
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            createTables={createTables}
            setCreateTables={setCreateTables}
            emptyTarget={emptyTarget}
            setEmptyTarget={setEmptyTarget}
            chunkSize={chunkSize}
            setChunkSize={setChunkSize}
            continueOnError={continueOnError}
            setContinueOnError={setContinueOnError}
            concurrency={concurrency}
            setConcurrency={setConcurrency}
            insertMode={insertMode}
            setInsertMode={setInsertMode}
            disableFkChecks={disableFkChecks}
            setDisableFkChecks={setDisableFkChecks}
            disableUniqueChecks={disableUniqueChecks}
            setDisableUniqueChecks={setDisableUniqueChecks}
            disableBinlog={disableBinlog}
            setDisableBinlog={setDisableBinlog}
            useTransaction={useTransaction}
            setUseTransaction={setUseTransaction}
            lockTarget={lockTarget}
            setLockTarget={setLockTarget}
            maxStmtKb={maxStmtKb}
            setMaxStmtKb={setMaxStmtKb}
            useKeyset={useKeyset}
            setUseKeyset={setUseKeyset}
            createTargetSchema={createTargetSchema}
            setCreateTargetSchema={setCreateTargetSchema}
            createRecords={createRecords}
            setCreateRecords={setCreateRecords}
            completeInserts={completeInserts}
            setCompleteInserts={setCompleteInserts}
            extendedInserts={extendedInserts}
            setExtendedInserts={setExtendedInserts}
            hexBlob={hexBlob}
            setHexBlob={setHexBlob}
            singleTransaction={singleTransaction}
            setSingleTransaction={setSingleTransaction}
            lockSource={lockSource}
            setLockSource={setLockSource}
            preserveZeroAutoInc={preserveZeroAutoInc}
            setPreserveZeroAutoInc={setPreserveZeroAutoInc}
            copyTriggers={copyTriggers}
            setCopyTriggers={setCopyTriggers}
            intraTableWorkers={intraTableWorkers}
            setIntraTableWorkers={setIntraTableWorkers}
            intraTableMinRows={intraTableMinRows}
            setIntraTableMinRows={setIntraTableMinRows}
            deferSecondaryIndexes={deferSecondaryIndexes}
            setDeferSecondaryIndexes={setDeferSecondaryIndexes}
            targetIsMysql={targetIsMysql}
            crossDialect={crossDialect}
          />
        )}

        {step === "progress" && (
          <ProgressStep
            tables={runKeys}
            perTable={perTable}
            doneTable={doneTable}
            running={running}
            finalSummary={finalSummary}
            startError={startError}
            failedTables={failedTables}
            onRetryFailed={retryFailed}
            onRetrySingle={retrySingle}
            overallDone={overallRows.done}
            overallTotal={overallRows.total}
            overallPct={overallPct}
            tablesDone={tablesDone}
            totalTables={totalTables}
            paused={paused}
            stopping={stopping}
            onPause={handlePause}
            onResume={handleResume}
            onStop={handleStop}
            workersByTable={workersByTable}
            notesByTable={notesByTable}
          />
        )}
      </div>

      <NavFooter
        step={step}
        setStep={setStep}
        canNext={
          step === "endpoints"
            ? canGoToTables
            : step === "tables"
              ? canRun
              : step === "options"
                ? true
                : false
        }
        onRun={() => void handleRun()}
        running={running}
      />
    </div>
  );
}

// =========================================================================
// Sub-components
// =========================================================================

function StepperHeader({
  step,
  onJump,
  actions,
}: {
  step: Step;
  onJump?: (s: Step) => void;
  actions?: ReactNode;
}) {
  const t = useT();
  const steps: Array<{ id: Step; label: string }> = [
    { id: "endpoints", label: t("dataTransfer.stepEndpoints") },
    { id: "tables", label: t("dataTransfer.stepTables") },
    { id: "options", label: t("dataTransfer.stepOptions") },
    { id: "progress", label: t("dataTransfer.stepProgress") },
  ];
  const activeIdx = steps.findIndex((s) => s.id === step);
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/30 px-6 text-xs">
      {steps.map((s, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        const clickable = !!onJump && done && s.id !== "progress";
        return (
          <div
            key={s.id}
            className={cn(
              "flex items-center gap-2",
              clickable && "cursor-pointer rounded-md px-1 hover:bg-accent/40",
            )}
            onClick={clickable ? () => onJump!(s.id) : undefined}
            title={clickable ? `Voltar pra ${s.label}` : undefined}
          >
            <div
              className={cn(
                "grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold",
                active
                  ? "bg-conn-accent text-conn-accent-foreground"
                  : done
                    ? "bg-emerald-500 text-white"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {done ? <Check className="h-3 w-3" /> : i + 1}
            </div>
            <span
              className={cn(
                "font-medium",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
            )}
          </div>
        );
      })}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

function EndpointsStep({
  connections,
  folders,
  sourceConn,
  setSourceConn,
  targetConn,
  setTargetConn,
  sourceConnInfo,
  targetConnInfo,
}: {
  connections: ConnectionProfile[];
  folders: ConnectionFolder[];
  sourceConn: Uuid | null;
  setSourceConn: (v: Uuid) => void;
  targetConn: Uuid | null;
  setTargetConn: (v: Uuid) => void;
  sourceConnInfo: ConnectionProfile | undefined;
  targetConnInfo: ConnectionProfile | undefined;
}) {
  const groupOrder = useMemo(() => {
    const sorted = [...folders].sort((a, b) => a.sort_order - b.sort_order);
    return sorted.map((f) => f.name);
  }, [folders]);

  const connOptions = useMemo<SearchableSelectOption<Uuid>[]>(() => {
    const folderName = new Map(folders.map((f) => [f.id, f.name] as const));
    return connections.map((c) => ({
      value: c.id,
      label: c.name,
      hint: c.driver,
      group: c.folder_id ? folderName.get(c.folder_id) ?? null : null,
      keywords: [c.host, c.driver, c.user],
    }));
  }, [connections, folders]);

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto_1fr] items-start gap-6 pt-6">
      <EndpointCard
        title="Origem"
        connOptions={connOptions}
        groupOrder={groupOrder}
        connId={sourceConn}
        onConn={setSourceConn}
        connInfo={sourceConnInfo}
      />
      <div className="mt-24 grid place-items-center">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-conn-accent/20 text-conn-accent">
          <ArrowRight className="h-4 w-4" />
        </div>
      </div>
      <EndpointCard
        title="Destino"
        connOptions={connOptions}
        groupOrder={groupOrder}
        connId={targetConn}
        onConn={setTargetConn}
        connInfo={targetConnInfo}
      />
    </div>
  );
}

function EndpointCard({
  title,
  connOptions,
  groupOrder,
  connId,
  onConn,
  connInfo,
}: {
  title: string;
  connOptions: SearchableSelectOption<Uuid>[];
  groupOrder: string[];
  connId: Uuid | null;
  onConn: (v: Uuid) => void;
  connInfo: ConnectionProfile | undefined;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-border bg-card/40 p-5">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>

      <label className="mb-1 block text-xs text-muted-foreground">
        {t("dataTransfer.connectionLabel")}
      </label>
      <SearchableSelect<Uuid>
        value={connId}
        options={connOptions}
        onChange={onConn}
        placeholder={t("dataTransfer.connectionSelect")}
        groupOrder={groupOrder}
        ungroupedLabel="(sem pasta)"
      />

      {connInfo && (
        <div className="mt-5 rounded-md bg-muted/30 p-3 text-[11px] text-muted-foreground">
          <InfoRow label="Host" value={connInfo.host} />
          <InfoRow label="Port" value={String(connInfo.port)} />
          <InfoRow label="User" value={connInfo.user} />
          <InfoRow label="Driver" value={connInfo.driver} />
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-12 shrink-0 opacity-60">{label}:</span>
      <span className="truncate font-mono">{value}</span>
    </div>
  );
}

function JobsStep({
  jobs,
  sourceSchemas,
  targetSchemas,
  tablesBySchema,
  tablesLoading,
  expanded,
  onToggleExpand,
  onUpdate,
  onRemove,
  onAdd,
  onAddAll,
  ensureTables,
}: {
  jobs: JobRow[];
  sourceSchemas: SchemaInfo[];
  targetSchemas: SchemaInfo[];
  tablesBySchema: Record<string, TableInfo[]>;
  tablesLoading: Set<string>;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  onUpdate: (key: string, patch: Partial<JobRow>) => void;
  onRemove: (key: string) => void;
  onAdd: () => void;
  onAddAll: () => void;
  ensureTables: (schema: string) => Promise<TableInfo[]>;
}) {
  const t = useT();
  const sourceOptions = useMemo<SearchableSelectOption<string>[]>(
    () => sourceSchemas.map((s) => ({ value: s.name, label: s.name })),
    [sourceSchemas],
  );
  const targetKnown = useMemo(
    () => new Set(targetSchemas.map((s) => s.name)),
    [targetSchemas],
  );
  const targetOptions = useMemo<SearchableSelectOption<string>[]>(
    () => targetSchemas.map((s) => ({ value: s.name, label: s.name })),
    [targetSchemas],
  );

  return (
    <div className="mx-auto max-w-4xl pt-6">
      <div className="mb-3 flex items-center gap-3">
        <Database className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm font-medium">
          {t("dataTransfer.schemaJobs", { n: jobs.length })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onAddAll}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            {t("dataTransfer.addAllSchemas")}
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 rounded-md bg-conn-accent px-2 py-1 text-[11px] font-medium text-conn-accent-foreground hover:opacity-90"
          >
            <Plus className="h-3 w-3" />
            {t("dataTransfer.addSchema")}
          </button>
        </div>
      </div>

      {jobs.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-10 text-center text-xs italic text-muted-foreground">
          {t("dataTransfer.noJobs")}
        </div>
      )}

      <div className="space-y-2">
        {jobs.map((job) => {
          const willCreate =
            !!job.targetSchema && !targetKnown.has(job.targetSchema);
          const isExpanded = expanded.has(job.key);
          const allTables = job.tables.length === 0;
          const loaded = tablesBySchema[job.sourceSchema];
          const tableCount = allTables ? loaded?.length : job.tables.length;
          return (
            <div
              key={job.key}
              className="rounded-md border border-border bg-card/30 p-3"
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SearchableSelect<string>
                    value={job.sourceSchema || null}
                    options={sourceOptions}
                    onChange={(v) => {
                      // New source schema : reset tables to "all".
                      onUpdate(job.key, {
                        sourceSchema: v,
                        targetSchema: job.targetSchema || v,
                        tables: [],
                      });
                    }}
                    placeholder={t("dataTransfer.sourceSchema")}
                    sort="natural"
                  />
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <SearchableSelect<string>
                    value={job.targetSchema || null}
                    options={targetOptions}
                    onChange={(v) => onUpdate(job.key, { targetSchema: v })}
                    placeholder={t("dataTransfer.targetSchema")}
                    sort="natural"
                    allowCustom
                    customLabel={(v) => `Criar novo schema "${v}"`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onToggleExpand(job.key)}
                  disabled={!job.sourceSchema}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Database className="h-3 w-3" />
                  {allTables
                    ? t("dataTransfer.allTables", {
                        n: tableCount != null ? `(${tableCount})` : "",
                      })
                    : t("dataTransfer.nTables", { n: job.tables.length })}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(job.key)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                  title={t("common.delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {willCreate && (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">
                  <Check className="h-3 w-3 shrink-0" />
                  <span>
                    Schema <span className="font-mono">{job.targetSchema}</span>{" "}
                    não existe : será criado no destino.
                  </span>
                </div>
              )}

              {isExpanded && (
                <JobTablePicker
                  schema={job.sourceSchema}
                  tables={tablesBySchema[job.sourceSchema]}
                  loading={tablesLoading.has(job.sourceSchema)}
                  selected={job.tables}
                  onChange={(tables) => onUpdate(job.key, { tables })}
                  onReload={() => void ensureTables(job.sourceSchema)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Per-job table multi-select. The empty `selected` array means "all"; once
 *  the user deselects any table, `selected` holds the explicit subset (and an
 *  all-selected state collapses back to empty). */
function JobTablePicker({
  schema,
  tables,
  loading,
  selected,
  onChange,
  onReload,
}: {
  schema: string;
  tables: TableInfo[] | undefined;
  loading: boolean;
  selected: string[];
  onChange: (tables: string[]) => void;
  onReload: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const all = tables ?? [];
  const allNames = useMemo(() => all.map((tb) => tb.name), [all]);
  const isSelected = (name: string) =>
    selected.length === 0 || selected.includes(name);

  const toggle = (name: string) => {
    const cur = new Set(selected.length === 0 ? allNames : selected);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    // Collapse "everything selected" back to the canonical empty = all.
    if (cur.size === allNames.length) onChange([]);
    else onChange(Array.from(cur));
  };

  const filtered = useMemo(() => {
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter((tb) => tb.name.toLowerCase().includes(q));
  }, [all, filter]);

  return (
    <div className="mt-2 rounded-md border border-border/60 bg-background/40 p-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("dataTransfer.filterPlaceholder")}
          className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs focus:border-conn-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-[11px] text-muted-foreground hover:text-foreground"
          title={t("dataTransfer.selectAll")}
        >
          {t("dataTransfer.selectAll")}
        </button>
      </div>
      {loading && all.length === 0 ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Listando tabelas de <span className="font-mono">{schema}</span>…
        </div>
      ) : all.length === 0 ? (
        <div className="flex items-center justify-between p-2 text-xs italic text-muted-foreground">
          Nenhuma tabela
          <button
            type="button"
            onClick={onReload}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 not-italic hover:bg-accent"
          >
            <RotateCcw className="h-3 w-3" />
            {t("dataTransfer.retry")}
          </button>
        </div>
      ) : (
        <div className="grid max-h-56 grid-cols-2 gap-0.5 overflow-auto">
          {filtered.map((tb) => (
            <label
              key={tb.name}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={isSelected(tb.name)}
                onChange={() => toggle(tb.name)}
                className="h-3 w-3"
              />
              <span className="flex-1 truncate font-mono">{tb.name}</span>
              {tb.row_estimate != null && (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {tb.row_estimate.toLocaleString()}
                </span>
              )}
              {tb.kind === "view" && (
                <span className="text-[9px] uppercase text-muted-foreground/60">
                  view
                </span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function NavFooter({
  step,
  setStep,
  canNext,
  onRun,
  running,
}: {
  step: Step;
  setStep: (s: Step) => void;
  canNext: boolean;
  onRun: () => void;
  running: boolean;
}) {
  const t = useT();
  const order: Step[] = ["endpoints", "tables", "options", "progress"];
  const idx = order.indexOf(step);
  const back = () => idx > 0 && setStep(order[idx - 1]);
  const next = () => idx < order.length - 1 && setStep(order[idx + 1]);

  return (
    <div className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border bg-card/30 px-6 text-xs">
      {step === "progress" && !running && (
        <>
          <button
            type="button"
            onClick={() => setStep("tables")}
            className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("dataTransfer.backToTablesTitle")}
          >
            {t("dataTransfer.backToTables")}
          </button>
          <button
            type="button"
            onClick={() => setStep("options")}
            className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("dataTransfer.backToOptions")}
          </button>
        </>
      )}
      {step !== "endpoints" && step !== "progress" && (
        <button
          type="button"
          onClick={back}
          className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("dataTransfer.back")}
        </button>
      )}
      {step === "endpoints" && (
        <button
          type="button"
          onClick={next}
          disabled={!canNext}
          className="inline-flex items-center gap-1 rounded-md bg-conn-accent px-3 py-1.5 font-medium text-conn-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("dataTransfer.advance")}
          <ArrowRight className="h-3 w-3" />
        </button>
      )}
      {step === "tables" && (
        <button
          type="button"
          onClick={next}
          disabled={!canNext}
          className="inline-flex items-center gap-1 rounded-md bg-conn-accent px-3 py-1.5 font-medium text-conn-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("dataTransfer.advance")}
          <ArrowRight className="h-3 w-3" />
        </button>
      )}
      {step === "options" && (
        <button
          type="button"
          onClick={() => onRun()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {t("dataTransfer.runTransfer")}
        </button>
      )}
    </div>
  );
}
