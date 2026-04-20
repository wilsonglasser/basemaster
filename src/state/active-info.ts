import { create } from "zustand";

/**
 * Estado "vivo" da aba ativa que a status bar precisa exibir.
 * QueryTab (ou outras) escreve aqui; StatusBar lê.
 *
 * Mantemos por tabId para não perder info quando o usuário troca de aba.
 */
export interface QueryTabLive {
  /** SQL do resultado focado no momento. */
  currentSql?: string;
  /** Linhas no resultado focado. undefined = não-aplicável (ex: Mensagens). */
  totalRows?: number;
  /** Tempo de execução do statement focado em ms. */
  elapsedMs?: number;
  /** Coluna selecionada no grid (zero-based). */
  cellCol?: number;
  /** Linha selecionada no grid (zero-based). */
  cellRow?: number;
  /** Conteúdo atual do editor (live) — lido pelo tear-off de query tabs. */
  editorSql?: string;
  /** Schema selecionado no seletor do editor (pra reatachar no mesmo). */
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
