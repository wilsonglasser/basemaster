import { create } from "zustand";

import type { Uuid } from "@/lib/types";

/**
 * Seleção atual na sidebar (arvore de conexões). Só um nó por vez.
 * Usado por atalhos globais (Ctrl+C copia a tabela, Ctrl+V cola em
 * connection/schema selecionados) e por estilo de "selected".
 */
export type SidebarSelection =
  | {
      kind: "connection";
      connectionId: Uuid;
      color?: string | null;
    }
  | {
      kind: "schema";
      connectionId: Uuid;
      schema: string;
      color?: string | null;
    }
  | {
      kind: "table";
      connectionId: Uuid;
      schema: string;
      table: string;
      color?: string | null;
    }
  | {
      kind: "saved_query";
      connectionId: Uuid;
      savedQueryId: Uuid;
      color?: string | null;
    }
  | {
      kind: "category";
      connectionId: Uuid;
      schema: string;
      /** Identifica qual categoria no schema foi selecionada. */
      category: "tables" | "views" | "queries";
      color?: string | null;
    };

interface SidebarSelectionState {
  selected: SidebarSelection | null;
  setSelected: (s: SidebarSelection | null) => void;
}

export const useSidebarSelection = create<SidebarSelectionState>((set) => ({
  selected: null,
  setSelected(s) {
    set({ selected: s });
  },
}));
