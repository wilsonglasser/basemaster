import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Uuid } from "@/lib/types";

export type TabKind =
  | { kind: "welcome" }
  | { kind: "new-connection" }
  | { kind: "edit-connection"; connectionId: Uuid }
  | {
      kind: "query";
      connectionId: Uuid;
      schema?: string;
      /** Pre-filled SQL (shortcuts like "SELECT * FROM tbl"). */
      initialSql?: string;
      /** Runs initialSql automatically when the tab mounts. */
      autoRun?: boolean;
      /** If the tab is "linked" to a saved query, Ctrl+S updates it. */
      savedQueryId?: Uuid;
      savedQueryName?: string;
    }
  | {
      kind: "table";
      connectionId: Uuid;
      schema: string;
      table: string;
      /** Initial view of the tab (applied only on first mount). */
      initialView?: "data" | "structure";
      /** If true + initialView=structure → enters edit mode right away. */
      initialEdit?: boolean;
    }
  | {
      kind: "tables-list";
      connectionId: Uuid;
      schema: string;
      /** Filter by category. "all" shows everything with a Type column;
       *  "tables"/"views" hides the Type column. */
      category?: "all" | "tables" | "views";
    }
  | {
      kind: "saved-queries-list";
      connectionId: Uuid;
      /** Optional: filter by schema. null = show all of the connection. */
      schema?: string;
    }
  | { kind: "query-history"; connectionId: Uuid }
  | { kind: "processes"; connectionId: Uuid }
  | { kind: "users"; connectionId: Uuid }
  | {
      kind: "data-import";
      connectionId?: Uuid;
      schema?: string;
      table?: string;
    }
  | { kind: "new-table"; connectionId: Uuid; schema: string }
  | { kind: "settings" }
  | {
      kind: "sql-dump";
      sourceConnectionId: Uuid;
      /** List of schemas with tables (empty = all). */
      scopes: Array<{ schema: string; tables?: string[] }>;
    }
  | {
      kind: "sql-import";
      targetConnectionId: Uuid;
      /** Default schema (applied via USE before the import). */
      schema?: string;
    }
  | {
      kind: "data-transfer";
      /** Pre-selected source (optional — comes from the sidebar context). */
      sourceConnectionId?: Uuid;
      sourceSchema?: string;
      /** Pre-selected target (when coming from a paste). */
      targetConnectionId?: Uuid;
      targetSchema?: string;
      /** Tables already selected (from clipboard or context). */
      tables?: string[];
      /** Jump straight to the options/execution step. */
      autoAdvance?: boolean;
    };

export interface Tab {
  id: string;
  label: string;
  kind: TabKind;
  dirty?: boolean;
  /** Hex that paints the tab's accent (comes from the active connection). */
  accentColor?: string | null;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;

  open: (tab: Omit<Tab, "id">, explicitId?: string) => string;
  /** Opens a new tab if none satisfies the predicate; otherwise focuses the existing one. */
  openOrFocus: (
    matches: (t: Tab) => boolean,
    factory: () => Omit<Tab, "id">,
  ) => string;
  close: (id: string) => void;
  /** Closes multiple tabs by predicate. Returns how many were closed. */
  closeMany: (predicate: (t: Tab) => boolean) => number;
  setActive: (id: string) => void;
  patch: (id: string, patch: Partial<Omit<Tab, "id">>) => void;
  /** Reserves an id without creating a tab yet — useful to pre-seed external
   *  structures (tab-state) before calling `open` with that id. */
  reserveId: () => string;
}

let counter = 0;
const nextId = () => `tab-${++counter}`;

const initialTab: Tab = {
  id: nextId(),
  label: "Bem-vindo",
  kind: { kind: "welcome" },
};

/** Kinds that do NOT survive restart — in-progress forms and views
 *  with ephemeral state can cause confusion if restored. */
const EPHEMERAL_KINDS: TabKind["kind"][] = [
  "new-connection",
  "edit-connection",
];

/** Filter invalid tabs after rehydrate and recalculate counter. */
function sanitizeRestored(tabs: Tab[], activeId: string | null) {
  const valid = tabs.filter(
    (t) => !EPHEMERAL_KINDS.includes(t.kind.kind as TabKind["kind"]),
  );
  // Bump counter to the max seen to avoid collisions with new ids.
  let maxN = 0;
  for (const t of valid) {
    const m = /^tab-(\d+)$/.exec(t.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  counter = maxN;
  // If everything restored empty, put welcome back.
  if (valid.length === 0) {
    const wid = nextId();
    return {
      tabs: [{ id: wid, label: "Bem-vindo", kind: { kind: "welcome" } as TabKind }],
      activeId: wid,
    };
  }
  // If activeId was removed, select the first.
  const activeStillThere = valid.some((t) => t.id === activeId);
  return {
    tabs: valid,
    activeId: activeStillThere ? activeId : valid[0].id,
  };
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [initialTab],
      activeId: initialTab.id,

      open(tab, explicitId) {
        const id = explicitId ?? nextId();
        set((s) => ({
          tabs: [...s.tabs, { ...tab, id }],
          activeId: id,
        }));
        return id;
      },

      reserveId() {
        return nextId();
      },

      openOrFocus(matches, factory) {
        const existing = get().tabs.find(matches);
        if (existing) {
          set({ activeId: existing.id });
          return existing.id;
        }
        return get().open(factory());
      },

      close(id) {
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeId = s.activeId;
          if (activeId === id) {
            activeId = tabs[Math.max(0, idx - 1)]?.id ?? tabs[0]?.id ?? null;
          }
          return { tabs, activeId };
        });
      },

      closeMany(predicate) {
        let count = 0;
        set((s) => {
          const keep = s.tabs.filter((t) => {
            if (predicate(t)) {
              count++;
              return false;
            }
            return true;
          });
          const activeId = keep.some((t) => t.id === s.activeId)
            ? s.activeId
            : keep[0]?.id ?? null;
          return { tabs: keep, activeId };
        });
        return count;
      },

      setActive(id) {
        set({ activeId: id });
      },

      patch(id, patch) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        }));
      },
    }),
    {
      name: "basemaster.tabs",
      // Don't persist functions — only primitive state.
      partialize: (s) => ({ tabs: s.tabs, activeId: s.activeId }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const { tabs, activeId } = sanitizeRestored(state.tabs, state.activeId);
        state.tabs = tabs;
        state.activeId = activeId;
      },
    },
  ),
);
