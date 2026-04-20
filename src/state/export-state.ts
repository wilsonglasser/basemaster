import { create } from "zustand";

import type { Uuid, Value } from "@/lib/types";

/**
 * Estado global pra abrir o dialog de export de qualquer lugar. Dois
 * modos: "memory" (rows já em memória, usado pelo result-set do query
 * tab / página atual do table view) e "stream" (só tem colunas — o
 * dialog vai buscar dados via streaming chunked).
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
