import { create } from "zustand";
import { persist } from "zustand/middleware";

import { actionById, SHORTCUTS } from "@/lib/shortcuts/registry";
import { normalizeBinding } from "@/lib/shortcuts/match";

interface ShortcutsState {
  /** actionId → canonical binding. null = disabled (no shortcut). */
  overrides: Record<string, string | null>;
  setBinding: (actionId: string, binding: string | null) => void;
  resetBinding: (actionId: string) => void;
  resetAll: () => void;
  /** Resolve effective binding (override || default). */
  resolve: (actionId: string) => string | null;
  /** Reverse map: binding → actionId (only actions with an active binding). */
  indexByBinding: () => Map<string, string[]>;
}

export const useShortcuts = create<ShortcutsState>()(
  persist(
    (set, get) => ({
      overrides: {},

      setBinding(actionId, binding) {
        const norm = binding ? normalizeBinding(binding) : null;
        set((s) => ({
          overrides: { ...s.overrides, [actionId]: norm },
        }));
      },

      resetBinding(actionId) {
        set((s) => {
          const next = { ...s.overrides };
          delete next[actionId];
          return { overrides: next };
        });
      },

      resetAll() {
        set({ overrides: {} });
      },

      resolve(actionId) {
        const action = actionById(actionId);
        if (!action) return null;
        const o = get().overrides[actionId];
        if (o !== undefined) return o; // explicit null = disabled
        return action.defaultBinding;
      },

      indexByBinding() {
        const out = new Map<string, string[]>();
        for (const a of SHORTCUTS) {
          const b = get().resolve(a.id);
          if (!b) continue;
          const arr = out.get(b) ?? [];
          arr.push(a.id);
          out.set(b, arr);
        }
        return out;
      },
    }),
    { name: "basemaster.shortcuts" },
  ),
);
