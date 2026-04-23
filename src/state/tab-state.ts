import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Filter, FilterNode, OrderBy } from "@/lib/types";

/**
 * TAB runtime state — source of truth for "live" state that must
 * survive detach/reattach and (eventually) app restart. Each tab
 * (keyed by tabId) writes here; the mounting component reads on mount
 * (via `snapshot`) to initialize.
 *
 * Because it's `persist`ed to localStorage, and localStorage is shared
 * between WebviewWindows on the same origin, state SURVIVES detach
 * (the new window reads via the same tabId) without passing a payload
 * via event. Also enables a future "reopen last tabs" feature on app
 * startup.
 *
 * Heads-up: DYNAMIC, heavy content (grid rows, dirty edits) does NOT go
 * here — config only. Dirty edits survive reattach through another
 * dedicated mechanism (separate, next iteration).
 */

export interface QueryTabState {
  sql?: string;
  schema?: string;
}

export interface TableTabState {
  page?: number;
  limit?: number;
  orderBy?: OrderBy | null;
  hiddenColumns?: string[];
  /** Column names in the visual order chosen by the user (reorder). */
  columnOrder?: string[];
  /** Filter tree (nested AND/OR). V1 stored flat `filters`; the loader
   *  converts to `filterTree` automatically. */
  filterTree?: FilterNode | null;
  /** @deprecated V1. Converted to filterTree on mount. */
  filters?: Filter[];
}

export type TabRuntimeState =
  | ({ kind: "query" } & QueryTabState)
  | ({ kind: "table" } & TableTabState);

interface TabStateStore {
  byTab: Record<string, TabRuntimeState>;
  patchQuery: (tabId: string, p: Partial<QueryTabState>) => void;
  patchTable: (tabId: string, p: Partial<TableTabState>) => void;
  snapshot: (tabId: string) => TabRuntimeState | undefined;
  queryOf: (tabId: string) => QueryTabState | undefined;
  tableOf: (tabId: string) => TableTabState | undefined;
  remove: (tabId: string) => void;
  /** Copy (or move, if `removeSource`) an entry from `from` to `to`.
   *  Used in tear-off/reattach to transfer state between tabIds. */
  move: (from: string, to: string, removeSource?: boolean) => void;
}

export const useTabState = create<TabStateStore>()(
  persist(
    (set, get) => ({
      byTab: {},
      patchQuery(tabId, p) {
        set((s) => {
          const cur = s.byTab[tabId];
          const base: QueryTabState =
            cur && cur.kind === "query" ? (cur as QueryTabState) : {};
          return {
            byTab: {
              ...s.byTab,
              [tabId]: { kind: "query", ...base, ...p },
            },
          };
        });
      },
      patchTable(tabId, p) {
        set((s) => {
          const cur = s.byTab[tabId];
          const base: TableTabState =
            cur && cur.kind === "table" ? (cur as TableTabState) : {};
          return {
            byTab: {
              ...s.byTab,
              [tabId]: { kind: "table", ...base, ...p },
            },
          };
        });
      },
      snapshot(tabId) {
        return get().byTab[tabId];
      },
      queryOf(tabId) {
        const s = get().byTab[tabId];
        return s && s.kind === "query" ? s : undefined;
      },
      tableOf(tabId) {
        const s = get().byTab[tabId];
        return s && s.kind === "table" ? s : undefined;
      },
      remove(tabId) {
        set((s) => {
          const next = { ...s.byTab };
          delete next[tabId];
          return { byTab: next };
        });
      },
      move(from, to, removeSource) {
        set((s) => {
          const entry = s.byTab[from];
          if (!entry) return s;
          const next = { ...s.byTab, [to]: entry };
          if (removeSource) delete next[from];
          return { byTab: next };
        });
      },
    }),
    { name: "basemaster.tab-state" },
  ),
);
