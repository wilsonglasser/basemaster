import type { InsertMode } from "@/lib/types";

/** Options persisted across wizard runs. `endpoints` (conn/schema) are NOT
 *  included — they belong to the operation context, not the preference. */
export interface PersistedTransferOptions {
  dropTarget: boolean;
  createTables: boolean;
  emptyTarget: boolean;
  chunkSize: number;
  continueOnError: boolean;
  concurrency: number;
  insertMode: InsertMode;
  disableFkChecks: boolean;
  disableUniqueChecks: boolean;
  disableBinlog: boolean;
  useTransaction: boolean;
  lockTarget: boolean;
  maxStmtKb: number;
  useKeyset: boolean;
  createTargetSchema: boolean;
  createRecords: boolean;
  completeInserts: boolean;
  extendedInserts: boolean;
  hexBlob: boolean;
  singleTransaction: boolean;
  lockSource: boolean;
  preserveZeroAutoInc: boolean;
  copyTriggers: boolean;
  intraTableWorkers: number;
  intraTableMinRows: number;
}

const TRANSFER_OPTS_KEY = "basemaster.transferOptions";

export function buildDefaultTransferOptions(
  cpuCores: number,
): PersistedTransferOptions {
  return {
    dropTarget: true,
    createTables: true,
    emptyTarget: false,
    chunkSize: 1000,
    continueOnError: false,
    concurrency: cpuCores,
    insertMode: "insert",
    disableFkChecks: true,
    disableUniqueChecks: true,
    disableBinlog: false,
    useTransaction: true,
    lockTarget: false,
    maxStmtKb: 1024,
    useKeyset: true,
    createTargetSchema: true,
    createRecords: true,
    completeInserts: true,
    extendedInserts: true,
    hexBlob: true,
    singleTransaction: false,
    lockSource: false,
    preserveZeroAutoInc: true,
    copyTriggers: true,
    intraTableWorkers: 1,
    intraTableMinRows: 10000,
  };
}

export function readPersistedTransferOptions():
  | Partial<PersistedTransferOptions>
  | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TRANSFER_OPTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return null;
    return parsed as Partial<PersistedTransferOptions>;
  } catch {
    return null;
  }
}

export function writePersistedTransferOptions(
  opts: PersistedTransferOptions,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSFER_OPTS_KEY, JSON.stringify(opts));
  } catch {
    // quota/full → ignore silently, preferences aren't critical.
  }
}
