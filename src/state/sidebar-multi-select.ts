import { create } from "zustand";

import type { Uuid } from "@/lib/types";

/**
 * Seleção múltipla de tabelas na sidebar (árvore de conexões).
 * Escopo: (connectionId, schema). Mudou o escopo, limpa.
 *
 * Comportamento (Navicat-like):
 *  - Click simples: substitui a seleção pela tabela clicada (ou limpa
 *    se vier de outro escopo).
 *  - Ctrl+click: toggla a tabela na seleção dentro do mesmo escopo.
 *  - Shift+click: estende um range entre o anchor e a tabela atual.
 *
 * O `tables` em ordem é guardado pelo nó da árvore via `setOrderedList`
 * — necessário pra Shift+click saber o range. Cada categoria de
 * tabelas chama isso quando renderiza.
 */
export interface SidebarMultiScope {
  connectionId: Uuid;
  schema: string;
}

interface SidebarMultiState {
  scope: SidebarMultiScope | null;
  /** Conjunto de nomes de tabela selecionados no escopo atual. */
  selected: Set<string>;
  /** Última tabela clicada — anchor para shift+click. */
  anchor: string | null;
  /** Lista ordenada de tabelas do escopo (informada pela UI). */
  ordered: string[];

  setOrderedList: (scope: SidebarMultiScope, ordered: string[]) => void;
  /** Decide single/ctrl/shift baseado nas modifier keys. */
  handleClick: (
    scope: SidebarMultiScope,
    table: string,
    mods: { ctrl: boolean; shift: boolean },
  ) => void;
  /** Garante que `table` esteja na seleção. Se não estiver e não for
   *  ctrl/shift, substitui. Usado pelo right-click. */
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
      // Mesmo escopo: só atualiza ordem (tabelas podem ter sido
      // adicionadas/removidas), sem mexer na seleção. Filtra removidas.
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
