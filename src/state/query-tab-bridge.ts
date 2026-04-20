import { create } from "zustand";

type SetSql = (sql: string) => void;

interface QueryTabBridge {
  /** tabId → setter exposto pelo QueryTab montado. */
  setters: Record<string, SetSql>;
  register: (tabId: string, fn: SetSql) => void;
  unregister: (tabId: string) => void;
  /** Retorna true se conseguiu setar (aba montada). */
  setSqlIn: (tabId: string, sql: string) => boolean;
}

export const useQueryTabBridge = create<QueryTabBridge>((set, get) => ({
  setters: {},
  register(tabId, fn) {
    set((s) => ({ setters: { ...s.setters, [tabId]: fn } }));
  },
  unregister(tabId) {
    set((s) => {
      const next = { ...s.setters };
      delete next[tabId];
      return { setters: next };
    });
  },
  setSqlIn(tabId, sql) {
    const fn = get().setters[tabId];
    if (!fn) return false;
    fn(sql);
    return true;
  },
}));
