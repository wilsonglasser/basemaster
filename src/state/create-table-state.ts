import { create } from "zustand";

import type { Uuid } from "@/lib/types";

/** Abre o dialog de criar tabela pra qualquer lugar. */
export interface CreateTableRequest {
  connectionId: Uuid;
  schema: string;
  /** Hex do accent da conexão — pro visual. */
  color?: string | null;
}

interface CreateTableState {
  request: CreateTableRequest | null;
  open: (req: CreateTableRequest) => void;
  close: () => void;
}

export const useCreateTable = create<CreateTableState>((set) => ({
  request: null,
  open(req) {
    set({ request: req });
  },
  close() {
    set({ request: null });
  },
}));
