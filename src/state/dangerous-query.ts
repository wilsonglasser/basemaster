import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { DangerousStatement } from "@/lib/dangerous-query";

interface PendingPrompt {
  statements: DangerousStatement[];
  resolve: (proceed: boolean) => void;
}

interface DangerousQueryState {
  /** When true, UPDATE/DELETE without WHERE runs without asking. User
   *  opts in by ticking "don't ask again" on the confirm dialog;
   *  re-enable under Settings → Security. */
  skipGuard: boolean;
  setSkipGuard: (v: boolean) => void;

  /** Internal: only the current active prompt. Not persisted. */
  pending: PendingPrompt | null;
  /** Schedules a confirm prompt. Resolves `true` when the user confirms
   *  (and maybe flips `skipGuard`), `false` on reject / Escape. */
  askConfirm: (statements: DangerousStatement[]) => Promise<boolean>;
  /** Dialog calls this to resolve the pending prompt. */
  resolvePending: (proceed: boolean, dontAskAgain: boolean) => void;
}

export const useDangerousQuery = create<DangerousQueryState>()(
  persist(
    (set, get) => ({
      skipGuard: false,
      setSkipGuard: (v) => set({ skipGuard: v }),

      pending: null,
      askConfirm: (statements) =>
        new Promise<boolean>((resolve) => {
          set({ pending: { statements, resolve } });
        }),
      resolvePending: (proceed, dontAskAgain) => {
        const current = get().pending;
        if (!current) return;
        set({ pending: null });
        if (proceed && dontAskAgain) set({ skipGuard: true });
        current.resolve(proceed);
      },
    }),
    {
      name: "basemaster.dangerousQueryGuard",
      storage: createJSONStorage(() => localStorage),
      // Only persist the user's preference, not the transient prompt.
      partialize: (s) => ({ skipGuard: s.skipGuard }),
    },
  ),
);
