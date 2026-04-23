import { create } from "zustand";

import type { Uuid } from "@/lib/types";

/**
 * Current selection in the sidebar (connection tree). Only one node at a time.
 * Used by global shortcuts (Ctrl+C copies the table, Ctrl+V pastes into
 * the selected connection/schema) and by "selected" styling.
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
      /** Identifies which category within the schema was selected. */
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
