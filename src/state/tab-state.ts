import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Filter, FilterNode, OrderBy } from "@/lib/types";

/**
 * Runtime state DAS ABAS — source of truth pro estado "vivo" que deve
 * sobreviver a detach/reattach e (futuramente) a restart do app. Cada
 * aba (keyed por tabId) escreve aqui; quem monta a aba lê no mount
 * (via `snapshot`) pra se inicializar.
 *
 * Por ser `persist` em localStorage, e localStorage ser compartilhado
 * entre WebviewWindows na mesma origem, o estado SOBREVIVE a detach
 * (nova janela lê pelo mesmo tabId) sem precisar passar payload via
 * event. Também habilita no futuro uma função de "abrir últimas abas"
 * ao subir o app.
 *
 * ⚠ Conteúdo DINÂMICO e pesado (rows da grid, dirty edits) NÃO vai aqui
 * — só config. Dirty edits sobrevivem a reattach via outro mecanismo
 * dedicado (separado, próxima iteração).
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
  /** Nomes das colunas na ordem visual escolhida pelo usuário (reorder). */
  columnOrder?: string[];
  /** Árvore de filtros (AND/OR aninhados). V1 salvou `filters` flat; o
   *  loader converte pra `filterTree` automaticamente. */
  filterTree?: FilterNode | null;
  /** @deprecated V1. Convertido pra filterTree no mount. */
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
  /** Copia (ou move, se `removeSource`) uma entrada de `from` pra `to`.
   *  Usado no tear-off/reattach pra transferir state entre tabIds. */
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
