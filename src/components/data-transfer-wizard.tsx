import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Square,
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
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

type Step = "endpoints" | "tables" | "options" | "progress";

interface Props {
  tabId: string;
  initialSourceConnectionId?: Uuid;
  initialSourceSchema?: string;
  initialTargetConnectionId?: Uuid;
  initialTargetSchema?: string;
  initialTables?: string[];
  /** Se true, pula direto pra step de opções. */
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
  // Deriva direto do prop em vez de capturar em useState — assim se o
  // wizard é re-renderizado após rehydrate do session-restore (initialTables
  // chegou depois do primeiro mount), ainda pegamos a preseleção certa.
  const preseededTables = useMemo(
    () => new Set(initialTables ?? []),
    [initialTables],
  );
  const [tableFilter, setTableFilter] = useState("");

  // --- options
  const [dropTarget, setDropTarget] = useState(true);
  const [createTables, setCreateTables] = useState(true);
  const [emptyTarget, setEmptyTarget] = useState(false);
  const [chunkSize, setChunkSize] = useState(1000);
  const [continueOnError, setContinueOnError] = useState(false);
  // Default: cores do usuário, clamp em 8 (limite do pool MySQL).
  const cpuCores = useMemo(() => {
    const hw = typeof navigator !== "undefined"
      ? navigator.hardwareConcurrency ?? 4
      : 4;
    return Math.max(1, Math.min(8, hw));
  }, []);
  const [concurrency, setConcurrency] = useState(cpuCores);
  const [insertMode, setInsertMode] = useState<InsertMode>("insert");
  const [disableFkChecks, setDisableFkChecks] = useState(true);
  const [disableUniqueChecks, setDisableUniqueChecks] = useState(true);
  // Default pending check — wizard consulta o target pra decidir:
  // log_bin=OFF → seguro ligar (no-op). log_bin=ON → deixa user decidir.
  const [disableBinlog, setDisableBinlog] = useState(false);
  const [binlogCheckDone, setBinlogCheckDone] = useState(false);
  const [useTransaction, setUseTransaction] = useState(true);
  const [lockTarget, setLockTarget] = useState(false);
  const [maxStmtKb, setMaxStmtKb] = useState(1024);
  const [useKeyset, setUseKeyset] = useState(true);
  // Navicat-style
  const [createTargetSchema, setCreateTargetSchema] = useState(true);
  const [createRecords, setCreateRecords] = useState(true);
  const [completeInserts, setCompleteInserts] = useState(true);
  const [extendedInserts, setExtendedInserts] = useState(true);
  const [hexBlob, setHexBlob] = useState(true);
  const [singleTransaction, setSingleTransaction] = useState(false);
  const [lockSource, setLockSource] = useState(false);
  const [preserveZeroAutoInc, setPreserveZeroAutoInc] = useState(true);
  const [copyTriggers, setCopyTriggers] = useState(true);
  const [intraTableWorkers, setIntraTableWorkers] = useState(1);
  const [intraTableMinRows, setIntraTableMinRows] = useState(10000);

  // --- progress
  const [perTable, setPerTable] = useState<Map<string, TableProgress>>(new Map());
  const [doneTable, setDoneTable] = useState<Map<string, TableDone>>(new Map());
  /** Mapa table → workerId → último payload do worker. Usado pra
   *  drill-down no UI quando intra-table parallelism tá ativo. */
  const [workersByTable, setWorkersByTable] = useState<
    Map<string, Map<number, TableWorkerProgress>>
  >(new Map());
  /** Mensagens informativas emitidas pelo backend por tabela. */
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
    if (!window.confirm(t("dataTransfer.stopConfirm"))) {
      return;
    }
    try {
      setStopping(true);
      await ipc.transfer.stop();
      // Se estava pausado, sai da pausa pra workers acordarem e verem o stop.
      if (paused) {
        await ipc.transfer.resume();
        setPaused(false);
      }
    } catch (e) {
      console.error("stop:", e);
    }
  };

  // --- load schemas quando conn mudar
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
        // Binlog check é MySQL-only. Skipa se o target for PG.
        const connInfo = useConnections
          .getState()
          .connections.find((c) => c.id === targetConn);
        const targetIsMysql = connInfo?.driver === "mysql";
        if (targetIsMysql && !binlogCheckDone) {
          try {
            const enabled = await ipc.transfer.checkBinlogEnabled(targetConn);
            if (!enabled) setDisableBinlog(true);
          } catch {
            // ignora — mantém default
          }
          setBinlogCheckDone(true);
        }
      } catch (e) {
        console.error("target schemas:", e);
      }
    })();
  }, [targetConn, activeSet, openConn, binlogCheckDone]);

  // --- load tables da source quando schema mudar.
  // Garante que a conexão está aberta antes de listar — no restore de
  // sessão o wizard monta com sourceConn/sourceSchema já setados, mas a
  // conexão ainda não foi reaberta; precisamos esperar (ou abrir aqui).
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
    // Força re-run do effect mudando o error pra null e incrementando nada:
    // a forma mais simples é re-setar sourceSchema pra ele mesmo não ajuda
    // (React não re-dispara). Então chamamos direto.
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

  // --- listener de eventos de progresso
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

  /** Executa a transferência. Se `onlyTables` vem, só recorre essas
   *  (mantém os sucessos anteriores no progresso). */
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

    // Se é retry, limpa só os entries das tabelas que vão rodar agora
    // (preserva o check verde das que funcionaram antes).
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

  // --- Progresso geral (soma as linhas done/total de todas as tabelas)
  const overallRows = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const p of perTable.values()) {
      done += p.done;
      total += p.total;
    }
    // Conta tabelas já done como done=total final (refinamento pra 100%)
    for (const d of doneTable.values()) {
      if (!d.error) {
        const p = perTable.get(d.table);
        if (p) {
          // Se o done parcial < rows finais, usa rows finais.
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

  // Atualiza o título da aba com % enquanto roda — feedback mesmo com
  // a aba em background.
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

  // Barra de progresso no ícone da taskbar — feedback mesmo com a
  // janela minimizada. Limpa quando termina (ok, erro ou stopped).
  useEffect(() => {
    if (running) {
      const status = paused ? "paused" : "normal";
      ipc.taskbar.setProgress(status, Math.floor(overallPct)).catch(() => {});
    } else if (finalSummary) {
      const status = finalSummary.failed > 0 ? "error" : "normal";
      ipc.taskbar.setProgress(status, 100).catch(() => {});
      // Some com a barra depois de uns segundos pra não ficar fixo.
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
        // Pulo direto só pra passos já visitados (done) — evita pular
        // adiante sem preencher o necessário. "progress" nunca é clicável.
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

function OptionsStep(props: {
  dropTarget: boolean;
  setDropTarget: (v: boolean) => void;
  createTables: boolean;
  setCreateTables: (v: boolean) => void;
  emptyTarget: boolean;
  setEmptyTarget: (v: boolean) => void;
  chunkSize: number;
  setChunkSize: (v: number) => void;
  continueOnError: boolean;
  setContinueOnError: (v: boolean) => void;
  concurrency: number;
  setConcurrency: (v: number) => void;
  insertMode: InsertMode;
  setInsertMode: (v: InsertMode) => void;
  disableFkChecks: boolean;
  setDisableFkChecks: (v: boolean) => void;
  disableUniqueChecks: boolean;
  setDisableUniqueChecks: (v: boolean) => void;
  disableBinlog: boolean;
  setDisableBinlog: (v: boolean) => void;
  useTransaction: boolean;
  setUseTransaction: (v: boolean) => void;
  lockTarget: boolean;
  setLockTarget: (v: boolean) => void;
  maxStmtKb: number;
  setMaxStmtKb: (v: number) => void;
  useKeyset: boolean;
  setUseKeyset: (v: boolean) => void;
  createTargetSchema: boolean;
  setCreateTargetSchema: (v: boolean) => void;
  createRecords: boolean;
  setCreateRecords: (v: boolean) => void;
  completeInserts: boolean;
  setCompleteInserts: (v: boolean) => void;
  extendedInserts: boolean;
  setExtendedInserts: (v: boolean) => void;
  hexBlob: boolean;
  setHexBlob: (v: boolean) => void;
  singleTransaction: boolean;
  setSingleTransaction: (v: boolean) => void;
  lockSource: boolean;
  setLockSource: (v: boolean) => void;
  preserveZeroAutoInc: boolean;
  setPreserveZeroAutoInc: (v: boolean) => void;
  copyTriggers: boolean;
  setCopyTriggers: (v: boolean) => void;
  intraTableWorkers: number;
  setIntraTableWorkers: (v: number) => void;
  intraTableMinRows: number;
  setIntraTableMinRows: (v: number) => void;
  targetIsMysql: boolean;
  crossDialect: boolean;
}) {
  const {
    dropTarget,
    setDropTarget,
    createTables,
    setCreateTables,
    emptyTarget,
    setEmptyTarget,
    chunkSize,
    setChunkSize,
    continueOnError,
    setContinueOnError,
    concurrency,
    setConcurrency,
    insertMode,
    setInsertMode,
    disableFkChecks,
    setDisableFkChecks,
    disableUniqueChecks,
    setDisableUniqueChecks,
    disableBinlog,
    setDisableBinlog,
    useTransaction,
    setUseTransaction,
    lockTarget,
    setLockTarget,
    maxStmtKb,
    setMaxStmtKb,
    useKeyset,
    setUseKeyset,
    createTargetSchema,
    setCreateTargetSchema,
    createRecords,
    setCreateRecords,
    completeInserts,
    setCompleteInserts,
    extendedInserts,
    setExtendedInserts,
    hexBlob,
    setHexBlob,
    singleTransaction,
    setSingleTransaction,
    lockSource,
    setLockSource,
    preserveZeroAutoInc,
    setPreserveZeroAutoInc,
    copyTriggers,
    setCopyTriggers,
    intraTableWorkers,
    setIntraTableWorkers,
    intraTableMinRows,
    setIntraTableMinRows,
    targetIsMysql,
    crossDialect,
  } = props;
  const t = useT();
  return (
    <div className="mx-auto max-w-2xl">
      {crossDialect && (
        <div className="mb-4 rounded-md border border-conn-accent/30 bg-conn-accent/5 p-3 text-xs text-muted-foreground">
          {t("dataTransfer.crossDialectNote")}
        </div>
      )}
      <div className="mb-5 flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t("dataTransfer.optionsHeader")}</h3>
      </div>

      <Card title={t("dataTransfer.cardTableOptions")}>
        <Toggle
          label={t("dataTransfer.optCreateTables")}
          value={createTables}
          onChange={setCreateTables}
          hint={t("dataTransfer.optCreateTablesHint")}
        />
        <Toggle
          label={t("dataTransfer.optDropTarget")}
          value={dropTarget}
          onChange={setDropTarget}
          hint={t("dataTransfer.optDropTargetHint")}
        />
        <Toggle
          label={t("dataTransfer.optEmptyTarget")}
          value={emptyTarget}
          onChange={setEmptyTarget}
          hint={t("dataTransfer.optEmptyTargetHint")}
        />
        {targetIsMysql && !crossDialect && (
          <Toggle
            label={t("dataTransfer.optCopyTriggers")}
            value={copyTriggers}
            onChange={setCopyTriggers}
            hint={t("dataTransfer.optCopyTriggersHint")}
          />
        )}
      </Card>

      <Card title={t("dataTransfer.cardRecordOptions")}>
        <Toggle
          label={t("dataTransfer.optCreateRecords")}
          value={createRecords}
          onChange={setCreateRecords}
          hint={t("dataTransfer.optCreateRecordsHint")}
        />
        <label className="grid grid-cols-[180px_1fr] items-center gap-3">
          <span className="text-xs">{t("dataTransfer.optInsertMode")}</span>
          <select
            value={insertMode}
            onChange={(e) => setInsertMode(e.target.value as InsertMode)}
            className="w-full rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          >
            <option value="insert">{t("dataTransfer.optInsertModeInsert")}</option>
            {targetIsMysql && (
              <>
                <option value="insert_ignore">{t("dataTransfer.optInsertModeIgnore")}</option>
                <option value="replace">{t("dataTransfer.optInsertModeReplace")}</option>
              </>
            )}
          </select>
        </label>
        <Toggle
          label={t("dataTransfer.optCompleteInserts")}
          value={completeInserts}
          onChange={setCompleteInserts}
          hint={t("dataTransfer.optCompleteInsertsHint")}
        />
        <Toggle
          label={t("dataTransfer.optExtendedInserts")}
          value={extendedInserts}
          onChange={setExtendedInserts}
          hint={t("dataTransfer.optExtendedInsertsHint")}
        />
        {targetIsMysql && (
          <Toggle
            label={t("dataTransfer.optHexBlob")}
            value={hexBlob}
            onChange={setHexBlob}
            hint={t("dataTransfer.optHexBlobHint")}
          />
        )}
        {targetIsMysql && (
          <Toggle
            label={t("dataTransfer.optPreserveZeroAi")}
            value={preserveZeroAutoInc}
            onChange={setPreserveZeroAutoInc}
            hint={t("dataTransfer.optPreserveZeroAiHint")}
          />
        )}
        <Toggle
          label={t("dataTransfer.optUseTransaction")}
          value={useTransaction}
          onChange={setUseTransaction}
          hint={t("dataTransfer.optUseTransactionHint")}
        />
        {targetIsMysql && (
          <Toggle
            label={t("dataTransfer.optLockTarget")}
            value={lockTarget}
            onChange={setLockTarget}
            hint={t("dataTransfer.optLockTargetHint")}
          />
        )}
      </Card>

      <Card title={t("dataTransfer.cardPerformance")}>
        {targetIsMysql && (
          <>
            <Toggle
              label={t("dataTransfer.optDisableFkChecks")}
              value={disableFkChecks}
              onChange={setDisableFkChecks}
              hint={t("dataTransfer.optDisableFkChecksHint")}
            />
            <Toggle
              label={t("dataTransfer.optDisableUniqueChecks")}
              value={disableUniqueChecks}
              onChange={setDisableUniqueChecks}
              hint={t("dataTransfer.optDisableUniqueChecksHint")}
            />
            <Toggle
              label={t("dataTransfer.optDisableBinlog")}
              value={disableBinlog}
              onChange={setDisableBinlog}
              hint={t("dataTransfer.optDisableBinlogHint")}
            />
          </>
        )}
        <Toggle
          label={t("dataTransfer.optKeyset")}
          value={useKeyset}
          onChange={setUseKeyset}
          hint={t("dataTransfer.optKeysetHint")}
        />
        <label className="grid grid-cols-[180px_1fr] items-center gap-3">
          <span className="text-xs">{t("dataTransfer.optChunkSize")}</span>
          <input
            type="number"
            min={1}
            value={chunkSize}
            onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value)))}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          />
        </label>
        <label className="grid grid-cols-[180px_1fr] items-center gap-3">
          <span className="text-xs">{t("dataTransfer.optMaxStmtKb")}</span>
          <input
            type="number"
            min={16}
            max={64 * 1024}
            value={maxStmtKb}
            onChange={(e) => setMaxStmtKb(Math.max(16, Number(e.target.value)))}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          />
        </label>
        <label className="grid grid-cols-[180px_1fr] items-center gap-3">
          <span className="text-xs">
            {t("dataTransfer.optParallelTables")}
            <span className="ml-1 text-muted-foreground">
              ({concurrency}{" "}
              {concurrency === 1
                ? t("dataTransfer.workerSingular")
                : t("dataTransfer.workerPlural")})
            </span>
          </span>
          <input
            type="range"
            min={1}
            max={8}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="w-full accent-conn-accent"
          />
        </label>
        <label className="grid grid-cols-[180px_1fr] items-center gap-3">
          <span className="text-xs">
            {t("dataTransfer.optParallelIntra")}
            <span className="ml-1 text-muted-foreground">
              ({intraTableWorkers === 1
                ? t("dataTransfer.intraOff")
                : t("dataTransfer.intraWorkers", { n: intraTableWorkers })})
            </span>
          </span>
          <input
            type="range"
            min={1}
            max={8}
            value={intraTableWorkers}
            onChange={(e) => setIntraTableWorkers(Number(e.target.value))}
            className="w-full accent-conn-accent"
          />
        </label>
        <div className="-mt-2 ml-[192px] text-[10px] text-muted-foreground">
          {t("dataTransfer.optParallelIntraNote")}
        </div>
        <label className="grid grid-cols-[180px_1fr] items-center gap-3">
          <span className="text-xs">{t("dataTransfer.optIntraThreshold")}</span>
          <input
            type="number"
            min={1}
            value={intraTableMinRows}
            onChange={(e) =>
              setIntraTableMinRows(Math.max(1, Number(e.target.value)))
            }
            disabled={intraTableWorkers === 1}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40 disabled:opacity-50"
          />
        </label>
      </Card>

      <Card title={t("dataTransfer.cardOtherOptions")}>
        <Toggle
          label={t("dataTransfer.optCreateTargetSchema")}
          value={createTargetSchema}
          onChange={setCreateTargetSchema}
          hint={t("dataTransfer.optCreateTargetSchemaHint")}
        />
        <Toggle
          label={t("dataTransfer.optContinueOnError")}
          value={continueOnError}
          onChange={setContinueOnError}
          hint={t("dataTransfer.optContinueOnErrorHint")}
        />
        {targetIsMysql && (
          <Toggle
            label={t("dataTransfer.optLockSource")}
            value={lockSource}
            onChange={setLockSource}
            hint={t("dataTransfer.optLockSourceHint")}
          />
        )}
        <Toggle
          label={t("dataTransfer.optSingleTransaction")}
          value={singleTransaction}
          onChange={setSingleTransaction}
          hint={t("dataTransfer.optSingleTransactionHint")}
        />
      </Card>

      <p className="mt-4 text-[11px] text-muted-foreground">
        {t("dataTransfer.v12Hint")}
      </p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-lg border border-border bg-card/30 p-5">
      <h4 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <div>
        <div>{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
    </label>
  );
}

function ProgressStep({
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
  // Quando só 1 tabela, o "progresso geral" é redundante com o checklist.
  const showOverall = totalTables > 1;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (t: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {startError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <pre className="whitespace-pre-wrap break-all font-mono">{startError}</pre>
        </div>
      )}

      {/* Sumário final (quando acabou) */}
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

      {/* Controles: pause/resume/stop — só durante execução */}
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

      {/* Progresso geral — escondido quando é só 1 tabela (redundante) */}
      {showOverall && (
      <div className="rounded-md border border-border bg-card/40 p-4">
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
      </div>
      )}

      {/* Checklist por tabela */}
      <div className="space-y-1">
        {tables.map((tbl) => {
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
              {/* Barra por tabela */}
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
              {/* Erro em texto full — quebra linha pra não estourar o card */}
              {d?.error && (
                <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 p-2">
                  <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-destructive">
                    {d.error}
                  </pre>
                </div>
              )}
              {/* Notas do backend (ex: intra-parallel ativado / desativado) */}
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
              {/* Drill-down: workers do intra-table parallelism */}
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

/** Grid com os workers de uma tabela (intra-table parallelism).
 *  Cada worker mostra sua faixa de PK [low, high), linhas feitas,
 *  tempo decorrido e status. Ordenado por worker_id. */
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
