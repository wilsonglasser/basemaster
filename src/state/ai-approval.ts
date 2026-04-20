import { create } from "zustand";

export type ApprovalKind = "sql" | "rows" | "generic";

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  /** SQL a mostrar em bloco de código (kind = "sql"). */
  sql?: string;
  /** Metadata pra UI (ex: quantas linhas, qual tabela). */
  meta?: Record<string, string | number | null | undefined>;
  resolve: (approved: boolean) => void;
}

interface ApprovalState {
  pending: PendingApproval | null;
  requestApproval: (
    req: Omit<PendingApproval, "id" | "resolve">,
  ) => Promise<boolean>;
  resolveCurrent: (approved: boolean) => void;
}

export const useApproval = create<ApprovalState>((set, get) => ({
  pending: null,
  requestApproval(req) {
    return new Promise<boolean>((resolve) => {
      const prev = get().pending;
      // Só um em voo por vez — se chegar outro, nega o anterior.
      if (prev) prev.resolve(false);
      set({
        pending: {
          ...req,
          id: crypto.randomUUID(),
          resolve,
        },
      });
    });
  },
  resolveCurrent(approved) {
    const cur = get().pending;
    if (!cur) return;
    set({ pending: null });
    cur.resolve(approved);
  },
}));
