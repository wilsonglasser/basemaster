import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  Database,
  Loader2,
  Play,
  RotateCcw,
  X,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type {
  ConnectionProfile,
  InsertMode,
  SchemaInfo,
  TableDone,
  TableInfo,
  TableNote,
  TableProgress,
  TableWorkerProgress,
  TransferOptions,
  Uuid,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { appConfirm } from "@/state/app-dialog";
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

interface Props {
  tabId: string;
  initialSourceConnectionId?: Uuid;
  initialSourceSchema?: string;
  initialTargetConnectionId?: Uuid;
  initialTargetSchema?: string;
  initialTables?: string[];
  /** If true, jumps straight to the options step. */
  initialAutoAdvance?: boolean;
}

export function DataTransferWizard({
  tabId,
  initialSourceConnectionId,
  initialSourceSchema,
  initialTargetConnectionId,
  initialTargetSchema,
  initialTables,
  initialAutoAdvance,
}: Props) {
  const t = useT();
  const patchTab = useTabs((s) => s.patch);
  const connections = useConnections((s) => s.connections);
  const activeSet = useConnections((s) => s.active);
  const openConn = useConnections((s) => s.open);

  const [step, setStep] = useState<Step>(
    initialAutoAdvance ? "options" : "endpoints",
  );

  // --- endpoints
  const [sourceConn, setSourceConn] = useState<Uuid | null>(
    initialSourceConnectionId ?? null,
  );
  const [targetConn, setTargetConn] = useState<Uuid | null>(
    initialTargetConnectionId ?? null,
  );
  const [sourceSchemas, setSourceSchemas] = useState<SchemaInfo[]>([]);
  const [targetSchemas, setTargetSchemas] = useState<SchemaInfo[]>([]);
  const [sourceSchema, setSourceSchema] = useState<string>(
    initialSourceSchema ?? "",
  );
  const [targetSchema, setTargetSchema] = useState<string>(
    initialTargetSchema ?? "",
  );

  // --- tables
  const [allTables, setAllTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(
    new Set(initialTables ?? []),
  );
  // Derive directly from the prop instead of capturing in useState — so if
  // the wizard re-renders after session-restore rehydrate (initialTables
  // arrived after the first mount), we still catch the right preselection.
  const preseededTables = useMemo(
    () => new Set(initialTables ?? []),
    [initialTables],
  );
  const [tableFilter, setTableFilter] = useState("");

  // --- options
  // Defaults persisted in localStorage — the last configuration used is
  // memorized and becomes the starting point next time. Individual missing
  // keys fall back to the structured default (for users who never ran a transfer).
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
  // Default pending check — the wizard queries the target to decide:
  // log_bin=OFF → safe to enable (no-op). log_bin=ON → let the user decide.
  const [disableBinlog, setDisableBinlog] = useState(get("disableBinlog"));
  const [binlogCheckDone, setBinlogCheckDone] = useState(false);
  const [useTransaction, setUseTransaction] = useState(get("useTransaction"));
  const [lockTarget, setLockTarget] = useState(get("lockTarget"));
  const [maxStmtKb, setMaxStmtKb] = useState(get("maxStmtKb"));
  const [useKeyset, setUseKeyset] = useState(get("useKeyset"));
  // Navicat-style
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

  // Persist to localStorage on every change — native debouncing via React
  // batching; to avoid slider thrash, saving on unmount is also unnecessary
  // (localStorage is sync + cheap at the scope of this blob).
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
    });
  }, [
    dropTarget, createTables, emptyTarget, chunkSize, continueOnError,
    concurrency, insertMode, disableFkChecks, disableUniqueChecks,
    disableBinlog, useTransaction, lockTarget, maxStmtKb, useKeyset,
    createTargetSchema, createRecords, completeInserts, extendedInserts,
    hexBlob, singleTransaction, lockSource, preserveZeroAutoInc,
    copyTriggers, intraTableWorkers, intraTableMinRows,
  ]);

  // --- progress
  const [perTable, setPerTable] = useState<Map<string, TableProgress>>(new Map());
  const [doneTable, setDoneTable] = useState<Map<string, TableDone>>(new Map());
  /** Map table → workerId → latest worker payload. Used for
   *  drill-down in the UI when intra-table parallelism is active. */
  const [workersByTable, setWorkersByTable] = useState<
    Map<string, Map<number, TableWorkerProgress>>
  >(new Map());
  /** Informational messages emitted by the backend, per table. */
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
      // If paused, unpause so workers wake up and see the stop.
      if (paused) {
        await ipc.transfer.resume();
        setPaused(false);
      }
    } catch (e) {
      console.error("stop:", e);
    }
  };

  // --- load schemas when conn changes
  useEffect(() => {
    if (!sourceConn) return;
    (async () => {
      try {
        if (!activeSet.has(sourceConn)) await openConn(sourceConn);
        const list = await ipc.db.listSchemas(sourceConn);
        setSourceSchemas(list);
      } catch (e) {
        console.error("source schemas:", e);
      }
    })();
  }, [sourceConn, activeSet, openConn]);

  useEffect(() => {
    if (!targetConn) return;
    (async () => {
      try {
        if (!activeSet.has(targetConn)) await openConn(targetConn);
        const list = await ipc.db.listSchemas(targetConn);
        setTargetSchemas(list);
        // Binlog check is MySQL-only. Skip if the target is PG.
        const connInfo = useConnections
          .getState()
          .connections.find((c) => c.id === targetConn);
        const targetIsMysql = connInfo?.driver === "mysql";
        if (targetIsMysql && !binlogCheckDone) {
          try {
            const enabled = await ipc.transfer.checkBinlogEnabled(targetConn);
            if (!enabled) setDisableBinlog(true);
          } catch {
            // ignore — keep default
          }
          setBinlogCheckDone(true);
        }
      } catch (e) {
        console.error("target schemas:", e);
      }
    })();
  }, [targetConn, activeSet, openConn, binlogCheckDone]);

  // --- load tables from source when schema changes.
  // Ensure the connection is open before listing — on session restore the
  // wizard mounts with sourceConn/sourceSchema already set, but the
  // connection hasn't been reopened yet; we need to wait (or open here).
  useEffect(() => {
    if (!sourceConn || !sourceSchema) {
      setAllTables([]);
      setTablesError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setTablesLoading(true);
      setTablesError(null);
      try {
        if (!activeSet.has(sourceConn)) await openConn(sourceConn);
        const ts = await ipc.db.listTables(sourceConn, sourceSchema);
        if (cancelled) return;
        setAllTables(ts);
        if (preseededTables.size > 0) {
          const valid = new Set(
            ts.filter((t) => preseededTables.has(t.name)).map((t) => t.name),
          );
          setSelectedTables(valid);
        } else {
          setSelectedTables(new Set(ts.map((t) => t.name)));
        }
      } catch (e) {
        if (!cancelled) setTablesError(String(e));
      } finally {
        if (!cancelled) setTablesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceConn, sourceSchema, activeSet, openConn, preseededTables]);

  const reloadTables = () => {
    // Force re-run of the effect by clearing the error and incrementing nothing:
    // the simplest way is re-setting sourceSchema to itself, which doesn't help
    // (React won't re-fire). So we call it directly.
    if (!sourceConn || !sourceSchema) return;
    let cancelled = false;
    (async () => {
      setTablesLoading(true);
      setTablesError(null);
      try {
        if (!activeSet.has(sourceConn)) await openConn(sourceConn);
        const ts = await ipc.db.listTables(sourceConn, sourceSchema);
        if (cancelled) return;
        setAllTables(ts);
        if (preseededTables.size > 0) {
          const valid = new Set(
            ts.filter((t) => preseededTables.has(t.name)).map((t) => t.name),
          );
          setSelectedTables(valid);
        }
      } catch (e) {
        if (!cancelled) setTablesError(String(e));
      } finally {
        if (!cancelled) setTablesLoading(false);
      }
    })();
  };

  // --- progress event listener
  useEffect(() => {
    if (!running) return;
    const progressUnlisten = listen<TableProgress>("transfer:progress", (e) => {
      setPerTable((prev) => {
        const next = new Map(prev);
        next.set(e.payload.table, e.payload);
        return next;
      });
    });
    const doneUnlisten = listen<TableDone>("transfer:table_done", (e) => {
      setDoneTable((prev) => {
        const next = new Map(prev);
        next.set(e.payload.table, e.payload);
        return next;
      });
    });
    const workerUnlisten = listen<TableWorkerProgress>(
      "transfer:worker_progress",
      (e) => {
        const p = e.payload;
        setWorkersByTable((prev) => {
          const next = new Map(prev);
          const inner = new Map(next.get(p.table) ?? new Map());
          inner.set(p.worker_id, p);
          next.set(p.table, inner);
          return next;
        });
      },
    );
    const noteUnlisten = listen<TableNote>("transfer:table_note", (e) => {
      setNotesByTable((prev) => {
        const next = new Map(prev);
        const arr = next.get(e.payload.table) ?? [];
        next.set(e.payload.table, [...arr, e.payload]);
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
    });
    return () => {
      void progressUnlisten.then((fn) => fn());
      void doneUnlisten.then((fn) => fn());
      void finalUnlisten.then((fn) => fn());
      void workerUnlisten.then((fn) => fn());
      void noteUnlisten.then((fn) => fn());
    };
  }, [running]);

  const sourceConnInfo = connections.find((c) => c.id === sourceConn);
  const targetConnInfo = connections.find((c) => c.id === targetConn);
  const targetIsMysql = (targetConnInfo?.driver ?? "mysql") === "mysql";
  const crossDialect =
    sourceConnInfo?.driver !== targetConnInfo?.driver &&
    !!sourceConnInfo?.driver &&
    !!targetConnInfo?.driver;
  const canGoToTables =
    !!sourceConn && !!targetConn && !!sourceSchema && !!targetSchema;
  const canRun = selectedTables.size > 0;

  const filteredTables = useMemo(() => {
    if (!tableFilter.trim()) return allTables;
    const q = tableFilter.toLowerCase();
    return allTables.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTables, tableFilter]);

  const toggleTable = (name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const selectAll = () => setSelectedTables(new Set(allTables.map((t) => t.name)));
  const selectNone = () => setSelectedTables(new Set());

  /** Runs the transfer. If `onlyTables` is given, only those are re-run
   *  (previous successes are kept in the progress view). */
  const handleRun = async (onlyTables?: string[]) => {
    if (!sourceConn || !targetConn) return;
    const tablesToRun = onlyTables ?? Array.from(selectedTables);
    if (tablesToRun.length === 0) return;

    setStep("progress");
    setRunning(true);
    setFinalSummary(null);
    setStartError(null);
    setPaused(false);
    setStopping(false);

    // If this is a retry, clear only the entries for the tables about to run
    // (preserves the green check for those that succeeded before).
    if (onlyTables) {
      setPerTable((prev) => {
        const next = new Map(prev);
        for (const t of onlyTables) next.delete(t);
        return next;
      });
      setDoneTable((prev) => {
        const next = new Map(prev);
        for (const t of onlyTables) next.delete(t);
        return next;
      });
      setWorkersByTable((prev) => {
        const next = new Map(prev);
        for (const t of onlyTables) next.delete(t);
        return next;
      });
      setNotesByTable((prev) => {
        const next = new Map(prev);
        for (const t of onlyTables) next.delete(t);
        return next;
      });
    } else {
      setPerTable(new Map());
      setDoneTable(new Map());
      setWorkersByTable(new Map());
      setNotesByTable(new Map());
    }

    try {
      const opts: TransferOptions = {
        source_connection_id: sourceConn,
        source_schema: sourceSchema,
        target_connection_id: targetConn,
        target_schema: targetSchema,
        tables: tablesToRun,
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
      };
      await ipc.transfer.start(opts);
    } catch (e) {
      setStartError(String(e));
      setRunning(false);
    }
  };

  const failedTables = useMemo(() => {
    return Array.from(doneTable.values())
      .filter((d) => d.error)
      .map((d) => d.table);
  }, [doneTable]);

  const retryFailed = () => {
    if (failedTables.length === 0) return;
    handleRun(failedTables);
  };
  const retrySingle = (table: string) => {
    handleRun([table]);
  };

  // --- Overall progress (sums done/total rows across all tables)
  const overallRows = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const p of perTable.values()) {
      done += p.done;
      total += p.total;
    }
    // Count tables already done as done=final-total (refinement for 100%)
    for (const d of doneTable.values()) {
      if (!d.error) {
        const p = perTable.get(d.table);
        if (p) {
          // If partial done < final rows, use final rows.
          done += Math.max(0, d.rows - p.done);
        } else {
          done += d.rows;
          total += d.rows;
        }
      }
    }
    return { done, total };
  }, [perTable, doneTable]);

  const totalTables = selectedTables.size || 1;
  const tablesDone = doneTable.size;
  const overallPct = overallRows.total > 0
    ? Math.min(100, (overallRows.done / overallRows.total) * 100)
    : totalTables > 0
      ? (tablesDone / totalTables) * 100
      : 0;

  // Update the tab title with % while running — feedback even when
  // the tab is in the background.
  useEffect(() => {
    if (running) {
      patchTab(tabId, {
        label: `Transfer · ${Math.floor(overallPct)}%`,
        dirty: true,
      });
    } else if (finalSummary) {
      const suffix = finalSummary.failed > 0
        ? ` · ${finalSummary.failed} err`
        : " · ok";
      patchTab(tabId, { label: `Transfer${suffix}`, dirty: false });
    }
  }, [running, finalSummary, overallPct, tabId, patchTab]);

  // Progress bar on the taskbar icon — feedback even with the
  // window minimized. Clears when done (ok, error or stopped).
  useEffect(() => {
    if (running) {
      const status = paused ? "paused" : "normal";
      ipc.taskbar.setProgress(status, Math.floor(overallPct)).catch(() => {});
    } else if (finalSummary) {
      const status = finalSummary.failed > 0 ? "error" : "normal";
      ipc.taskbar.setProgress(status, 100).catch(() => {});
      // Hide the bar after a few seconds so it doesn't stay pinned.
      const id = window.setTimeout(() => {
        ipc.taskbar.setProgress("none").catch(() => {});
      }, 4000);
      return () => window.clearTimeout(id);
    } else {
      ipc.taskbar.setProgress("none").catch(() => {});
    }
  }, [running, paused, overallPct, finalSummary]);

  return (
    <div className="flex h-full flex-col">
      <StepperHeader step={step} onJump={running ? undefined : setStep} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {step === "endpoints" && (
          <EndpointsStep
            connections={connections}
            sourceConn={sourceConn}
            setSourceConn={setSourceConn}
            targetConn={targetConn}
            setTargetConn={setTargetConn}
            sourceSchemas={sourceSchemas}
            targetSchemas={targetSchemas}
            sourceSchema={sourceSchema}
            setSourceSchema={setSourceSchema}
            targetSchema={targetSchema}
            setTargetSchema={setTargetSchema}
            sourceConnInfo={sourceConnInfo}
            targetConnInfo={targetConnInfo}
          />
        )}

        {step === "tables" && (
          <TablesStep
            tables={filteredTables}
            selected={selectedTables}
            filter={tableFilter}
            onFilter={setTableFilter}
            onToggle={toggleTable}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            total={allTables.length}
            loading={tablesLoading}
            error={tablesError}
            onReload={reloadTables}
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
            targetIsMysql={targetIsMysql}
            crossDialect={crossDialect}
          />
        )}

        {step === "progress" && (
          <ProgressStep
            tables={Array.from(selectedTables)}
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
        onRun={handleRun}
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
}: {
  step: Step;
  onJump?: (s: Step) => void;
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
        // Direct jump only for already-visited (done) steps — avoids jumping
        // ahead without filling in what's needed. "progress" is never clickable.
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
    </div>
  );
}

function EndpointsStep({
  connections,
  sourceConn,
  setSourceConn,
  targetConn,
  setTargetConn,
  sourceSchemas,
  targetSchemas,
  sourceSchema,
  setSourceSchema,
  targetSchema,
  setTargetSchema,
  sourceConnInfo,
  targetConnInfo,
}: {
  connections: ConnectionProfile[];
  sourceConn: Uuid | null;
  setSourceConn: (v: Uuid) => void;
  targetConn: Uuid | null;
  setTargetConn: (v: Uuid) => void;
  sourceSchemas: SchemaInfo[];
  targetSchemas: SchemaInfo[];
  sourceSchema: string;
  setSourceSchema: (v: string) => void;
  targetSchema: string;
  setTargetSchema: (v: string) => void;
  sourceConnInfo: ConnectionProfile | undefined;
  targetConnInfo: ConnectionProfile | undefined;
}) {
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto_1fr] items-start gap-6">
      <EndpointCard
        title="Origem"
        connections={connections}
        connId={sourceConn}
        onConn={setSourceConn}
        schemas={sourceSchemas}
        schema={sourceSchema}
        onSchema={setSourceSchema}
        connInfo={sourceConnInfo}
      />
      <div className="mt-24 grid place-items-center">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-conn-accent/20 text-conn-accent">
          <ArrowRight className="h-4 w-4" />
        </div>
      </div>
      <EndpointCard
        title="Destino"
        connections={connections}
        connId={targetConn}
        onConn={setTargetConn}
        schemas={targetSchemas}
        schema={targetSchema}
        onSchema={setTargetSchema}
        connInfo={targetConnInfo}
      />
    </div>
  );
}

function EndpointCard({
  title,
  connections,
  connId,
  onConn,
  schemas,
  schema,
  onSchema,
  connInfo,
}: {
  title: string;
  connections: ConnectionProfile[];
  connId: Uuid | null;
  onConn: (v: Uuid) => void;
  schemas: SchemaInfo[];
  schema: string;
  onSchema: (v: string) => void;
  connInfo: ConnectionProfile | undefined;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-border bg-card/40 p-5">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <label className="mb-1 block text-xs text-muted-foreground">{t("dataTransfer.connectionLabel")}</label>
      <select
        value={connId ?? ""}
        onChange={(e) => onConn(e.target.value)}
        className="mb-4 w-full rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
      >
        <option value="" disabled>
          {t("dataTransfer.connectionSelect")}
        </option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label className="mb-1 block text-xs text-muted-foreground">{t("dataTransfer.databaseLabel")}</label>
      <select
        value={schema}
        onChange={(e) => onSchema(e.target.value)}
        disabled={schemas.length === 0}
        className="w-full rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40 disabled:opacity-50"
      >
        <option value="" disabled>
          {t("dataTransfer.connectionSelect")}
        </option>
        {schemas.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>

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

function TablesStep({
  tables,
  selected,
  filter,
  onFilter,
  onToggle,
  onSelectAll,
  onSelectNone,
  total,
  loading,
  error,
  onReload,
}: {
  tables: TableInfo[];
  selected: Set<string>;
  filter: string;
  onFilter: (v: string) => void;
  onToggle: (name: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  total: number;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  const t = useT();
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-center gap-3">
        <Database className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm font-medium">
          {t("dataTransfer.selectTables", { selected: selected.size, total })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("dataTransfer.selectAll")}
          </button>
          <span className="text-muted-foreground/40">·</span>
          <button
            type="button"
            onClick={onSelectNone}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("dataTransfer.selectNone")}
          </button>
        </div>
      </div>
      <input
        type="text"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        placeholder={t("dataTransfer.filterPlaceholder")}
        className="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
      />
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t("dataTransfer.listTablesFailed")}</div>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] opacity-80">
              {error}
            </pre>
          </div>
          <button
            type="button"
            onClick={onReload}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-[11px] hover:bg-destructive/20"
          >
            <RotateCcw className="h-3 w-3" />
            {t("dataTransfer.retry")}
          </button>
        </div>
      )}
      <div className="grid max-h-[420px] grid-cols-2 gap-1 overflow-auto rounded-md border border-border p-2">
        {loading && tables.length === 0 && (
          <div className="col-span-2 flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Conectando e listando tabelas…
          </div>
        )}
        {tables.map((t) => (
          <label
            key={t.name}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={selected.has(t.name)}
              onChange={() => onToggle(t.name)}
              className="h-3 w-3"
            />
            <span className="flex-1 truncate font-mono">{t.name}</span>
            {t.row_estimate != null && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {t.row_estimate.toLocaleString()}
              </span>
            )}
            {t.kind === "view" && (
              <span className="text-[9px] uppercase text-muted-foreground/60">
                view
              </span>
            )}
          </label>
        ))}
        {tables.length === 0 && !loading && !error && (
          <div className="col-span-2 p-4 text-center text-xs italic text-muted-foreground">
            Nenhuma tabela
          </div>
        )}
      </div>
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
