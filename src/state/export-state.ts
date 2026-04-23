import { create } from "zustand";

import type { Uuid, Value } from "@/lib/types";

/**
 * Global state to open the export dialog from anywhere. Two
 * modes: "memory" (rows already in memory, used by the query tab
 * result-set / table view current page) and "stream" (only columns —
 * the dialog fetches data via chunked streaming).
 */
export type ExportRequest =
  | {
      mode: "memory";
      columns: readonly string[];
      rows: readonly (readonly Value[])[];
      defaultName: string;
    }
  | {
      mode: "stream";
      columns: readonly string[];
      defaultName: string;
      streamContext: {
        connectionId: Uuid;
        schema: string;
        table: string;
      };
    };

interface ExportState {
  request: ExportRequest | null;
  open: (req: ExportRequest) => void;
  close: () => void;
}

export const useExport = create<ExportState>((set) => ({
  request: null,
  open(req) {
    set({ request: req });
  },
  close() {
    set({ request: null });
  },
}));
