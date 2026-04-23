import { create } from "zustand";

import type { Uuid } from "@/lib/types";

/**
 * Multi-select of tables in the sidebar (connection tree).
 * Scope: (connectionId, schema). Scope changed → clears.
 *
 * Behavior (Navicat-like):
 *  - Simple click: replaces the selection with the clicked table (or
 *    clears if coming from another scope).
 *  - Ctrl+click: toggles the table in the selection within the same scope.
 *  - Shift+click: extends a range between the anchor and the current table.
 *
 * The ordered `tables` is kept by the tree node via `setOrderedList`
 * — needed so Shift+click knows the range. Each table category
 * calls this on render.
 */
export interface SidebarMultiScope {
  connectionId: Uuid;
  schema: string;
}

interface SidebarMultiState {
  scope: SidebarMultiScope | null;
  /** Set of selected table names in the current scope. */
  selected: Set<string>;
  /** Last clicked table — anchor for shift+click. */
  anchor: string | null;
  /** Ordered list of tables in the scope (provided by the UI). */
  ordered: string[];

  setOrderedList: (scope: SidebarMultiScope, ordered: string[]) => void;
  /** Decides single/ctrl/shift based on modifier keys. */
  handleClick: (
    scope: SidebarMultiScope,
    table: string,
    mods: { ctrl: boolean; shift: boolean },
  ) => void;
  /** Makes sure `table` is in the selection. If not and not ctrl/shift,
   *  replaces. Used by right-click. */
  ensureContains: (scope: SidebarMultiScope, table: string) => void;
  clear: () => void;
  isSelected: (scope: SidebarMultiScope, table: string) => boolean;
}

export const sameMultiScope = (
  a: SidebarMultiScope | null,
  b: SidebarMultiScope,
) => !!a && a.connectionId === b.connectionId && a.schema === b.schema;
const sameScope = sameMultiScope;

export const useSidebarMultiSelect = create<SidebarMultiState>((set, get) => ({
  scope: null,
  selected: new Set<string>(),
  anchor: null,
  ordered: [],

  setOrderedList(scope, ordered) {
    const cur = get();
    if (sameScope(cur.scope, scope)) {
      // Same scope: just update order (tables may have been
      // added/removed), without touching the selection. Filter out removed ones.
      const setOrd = new Set(ordered);
      const filtered = new Set<string>();
      cur.selected.forEach((t) => setOrd.has(t) && filtered.add(t));
      set({ ordered, selected: filtered });
    } else {
      set({ ordered });
    }
  },

  handleClick(scope, table, mods) {
    const cur = get();
    const inScope = sameScope(cur.scope, scope);
    if (mods.shift && inScope && cur.anchor) {
      const list = cur.ordered;
      const a = list.indexOf(cur.anchor);
      const b = list.indexOf(table);
      if (a >= 0 && b >= 0) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        const range = new Set<string>(cur.selected);
        for (let i = from; i <= to; i++) range.add(list[i]);
        set({ scope, selected: range });
        return;
      }
    }
    if (mods.ctrl && inScope) {
      const next = new Set(cur.selected);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      set({ scope, selected: next, anchor: table });
      return;
    }
    set({ scope, selected: new Set([table]), anchor: table });
  },

  ensureContains(scope, table) {
    const cur = get();
    if (sameScope(cur.scope, scope) && cur.selected.has(table)) return;
    set({ scope, selected: new Set([table]), anchor: table });
  },

  clear() {
    set({ scope: null, selected: new Set(), anchor: null });
  },

  isSelected(scope, table) {
    const cur = get();
    return sameScope(cur.scope, scope) && cur.selected.has(table);
  },
}));
