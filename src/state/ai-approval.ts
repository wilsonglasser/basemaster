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
  /** Head of the queue — the request the dialog is currently showing. */
  pending: PendingApproval | null;
  /** FIFO of pending approvals; `pending` mirrors queue[0]. */
  queue: PendingApproval[];
  requestApproval: (
    req: Omit<PendingApproval, "id" | "resolve">,
  ) => Promise<boolean>;
  resolveCurrent: (approved: boolean) => void;
}

export const useApproval = create<ApprovalState>((set, get) => ({
  pending: null,
  queue: [],
  requestApproval(req) {
    // A model step can emit several write tool calls at once. Queue them and
    // resolve one at a time instead of silently denying all but the last.
    return new Promise<boolean>((resolve) => {
      const item: PendingApproval = { ...req, id: crypto.randomUUID(), resolve };
      set((s) => {
        const queue = [...s.queue, item];
        return { queue, pending: queue[0] };
      });
    });
  },
  resolveCurrent(approved) {
    const cur = get().queue[0];
    if (!cur) return;
    cur.resolve(approved);
    const queue = get().queue.slice(1);
    set({ queue, pending: queue[0] ?? null });
  },
}));
