import { create } from "zustand";

export type ApprovalKind = "sql" | "rows" | "generic";

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  /** SQL to show in a code block (kind = "sql"). */
  sql?: string;
  /** Metadata for UI (e.g. how many rows, which table). */
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
      // Only one in flight at a time — if another arrives, deny the previous.
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
