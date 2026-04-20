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
      /** SQL pré-preenchido (atalhos como "SELECT * FROM tbl"). */
      initialSql?: string;
      /** Executa o initialSql automaticamente ao montar a aba. */
      autoRun?: boolean;
      /** Se a aba tá "linkada" a uma query salva, Ctrl+S atualiza ela. */
      savedQueryId?: Uuid;
      savedQueryName?: string;
    }
  | {
      kind: "table";
      connectionId: Uuid;
      schema: string;
      table: string;
      /** View inicial da aba (só aplicada no primeiro mount). */
      initialView?: "data" | "structure";
      /** Se true + initialView=structure → já entra em modo edição. */
      initialEdit?: boolean;
    }
  | {
      kind: "tables-list";
      connectionId: Uuid;
      schema: string;
      /** Filtrar por categoria. "all" mostra tudo com coluna Tipo;
       *  "tables"/"views" esconde a coluna Tipo. */
      category?: "all" | "tables" | "views";
    }
  | {
      kind: "saved-queries-list";
      connectionId: Uuid;
      /** Opcional: filtra por schema. null = mostra todas da conexão. */
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
      /** Lista de schemas com tabelas (vazio = todas). */
      scopes: Array<{ schema: string; tables?: string[] }>;
    }
  | {
      kind: "sql-import";
      targetConnectionId: Uuid;
      /** Schema default (aplicado via USE antes do import). */
      schema?: string;
    }
  | {
      kind: "data-transfer";
      /** Preseta source pré-selecionada (opcional — vem do context da sidebar). */
      sourceConnectionId?: Uuid;
      sourceSchema?: string;
      /** Preseta target (quando vem de um paste). */
      targetConnectionId?: Uuid;
      targetSchema?: string;
      /** Tabelas já selecionadas (do clipboard ou contexto). */
      tables?: string[];
      /** Pula direto pro step de opções/execução. */
      autoAdvance?: boolean;
    };

export interface Tab {
  id: string;
  label: string;
  kind: TabKind;
  dirty?: boolean;
  /** Hex que pinta o accent da aba (vem da conexão ativa). */
  accentColor?: string | null;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;

  open: (tab: Omit<Tab, "id">, explicitId?: string) => string;
  /** Abre nova aba se nenhuma satisfaz o predicado; senão foca a existente. */
  openOrFocus: (
    matches: (t: Tab) => boolean,
    factory: () => Omit<Tab, "id">,
  ) => string;
  close: (id: string) => void;
  /** Fecha múltiplas abas por predicado. Retorna quantas foram fechadas. */
  closeMany: (predicate: (t: Tab) => boolean) => number;
  setActive: (id: string) => void;
  patch: (id: string, patch: Partial<Omit<Tab, "id">>) => void;
  /** Reserva um id sem criar aba ainda — útil pra pré-seedar estruturas
   *  externas (tab-state) antes de chamar `open` com esse id. */
  reserveId: () => string;
}

let counter = 0;
const nextId = () => `tab-${++counter}`;

const initialTab: Tab = {
  id: nextId(),
  label: "Bem-vindo",
  kind: { kind: "welcome" },
};

/** Kinds que NÃO sobrevivem a restart — formulários em progresso e
 *  views com estado ephemeral podem gerar confusão se restaurados. */
const EPHEMERAL_KINDS: TabKind["kind"][] = [
  "new-connection",
  "edit-connection",
];

/** Filtra tabs inválidas após rehidratação e recalcula counter. */
function sanitizeRestored(tabs: Tab[], activeId: string | null) {
  const valid = tabs.filter(
    (t) => !EPHEMERAL_KINDS.includes(t.kind.kind as TabKind["kind"]),
  );
  // Bumpa counter pro máximo visto pra evitar colisão com ids novos.
  let maxN = 0;
  for (const t of valid) {
    const m = /^tab-(\d+)$/.exec(t.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  counter = maxN;
  // Se restaurou tudo vazio, coloca o welcome de volta.
  if (valid.length === 0) {
    const wid = nextId();
    return {
      tabs: [{ id: wid, label: "Bem-vindo", kind: { kind: "welcome" } as TabKind }],
      activeId: wid,
    };
  }
  // Se o activeId foi removido, seleciona o primeiro.
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
      // Não persiste funções — só o state primitivo.
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
