import { create } from "zustand";

/**
 * Destructive action confirmation (DROP, TRUNCATE, bulk DELETE).
 * Same pattern as the agent's `useApproval`: one pending at a time,
 * resolve(true|false) via Promise.
 *
 * The dialog forces the user to tick a checkbox before the confirm
 * button enables — avoids "muscle memory" destroying data.
 */
export interface PendingDestructive {
  id: string;
  title: string;
  /** Description line (e.g., "This action cannot be undone."). */
  description: string;
  /** List of affected items (table names, columns, etc.). */
  items: string[];
  /** Confirmation button label (e.g., "Drop 3 tables"). */
  confirmLabel: string;
  /** Text of the checkbox that must be checked. */
  checkboxLabel: string;
  resolve: (confirmed: boolean) => void;
}

interface DestructiveState {
  pending: PendingDestructive | null;
  confirmDestructive: (
    req: Omit<PendingDestructive, "id" | "resolve">,
  ) => Promise<boolean>;
  resolveCurrent: (confirmed: boolean) => void;
}

export const useDestructive = create<DestructiveState>((set, get) => ({
  pending: null,
  confirmDestructive(req) {
    return new Promise<boolean>((resolve) => {
      const prev = get().pending;
      if (prev) prev.resolve(false);
      set({
        pending: { ...req, id: crypto.randomUUID(), resolve },
      });
    });
  },
  resolveCurrent(confirmed) {
    const cur = get().pending;
    if (!cur) return;
    set({ pending: null });
    cur.resolve(confirmed);
  },
}));

export const confirmDestructive = (
  req: Omit<PendingDestructive, "id" | "resolve">,
) => useDestructive.getState().confirmDestructive(req);
