import { create } from "zustand";

import type { Uuid } from "@/lib/types";

/** Opens the create-table dialog from anywhere. */
export interface CreateTableRequest {
  connectionId: Uuid;
  schema: string;
  /** Connection accent hex — for styling. */
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
