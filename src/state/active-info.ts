import { create } from "zustand";

/**
 * Live state of the active tab that the status bar needs to display.
 * QueryTab (and others) writes here; StatusBar reads.
 *
 * Keyed by tabId so we don't lose info when the user switches tabs.
 */
export interface QueryTabLive {
  /** SQL of the currently focused result. */
  currentSql?: string;
  /** Rows in the focused result. undefined = N/A (e.g. Messages). */
  totalRows?: number;
  /** Execution time of the focused statement in ms. */
  elapsedMs?: number;
  /** Selected column in the grid (zero-based). */
  cellCol?: number;
  /** Selected row in the grid (zero-based). */
  cellRow?: number;
  /** Current editor content (live) — read by query-tab tear-off. */
  editorSql?: string;
  /** Schema selected in the editor selector (to reattach into the same). */
  editorSchema?: string;
}

interface ActiveInfoState {
  byTab: Record<string, QueryTabLive>;
  patch: (tabId: string, patch: Partial<QueryTabLive>) => void;
  clear: (tabId: string) => void;
}

export const useActiveInfo = create<ActiveInfoState>((set) => ({
  byTab: {},
  patch(tabId, p) {
    set((s) => ({
      byTab: {
        ...s.byTab,
        [tabId]: { ...s.byTab[tabId], ...p },
      },
    }));
  },
  clear(tabId) {
    set((s) => {
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    });
  },
}));
