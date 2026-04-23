import { Settings2 } from "lucide-react";

import type { InsertMode } from "@/lib/types";
import { useT } from "@/state/i18n";

export function OptionsStep(props: {
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
