import { create } from "zustand";

type SetView = (view: "data" | "structure") => void;
type StartEdit = () => void;

interface TableViewBridge {
  setters: Record<string, SetView>;
  editStarters: Record<string, StartEdit>;
  register: (tabId: string, fn: SetView) => void;
  unregister: (tabId: string) => void;
  registerEdit: (tabId: string, fn: StartEdit) => void;
  unregisterEdit: (tabId: string) => void;
  setViewOf: (tabId: string, view: "data" | "structure") => boolean;
  /** Tenta iniciar modo edit da aba. Retorna true se conseguiu. */
  startEditOf: (tabId: string) => boolean;
}

export const useTableViewBridge = create<TableViewBridge>((set, get) => ({
  setters: {},
  editStarters: {},
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
  registerEdit(tabId, fn) {
    set((s) => ({ editStarters: { ...s.editStarters, [tabId]: fn } }));
  },
  unregisterEdit(tabId) {
    set((s) => {
      const next = { ...s.editStarters };
      delete next[tabId];
      return { editStarters: next };
    });
  },
  setViewOf(tabId, view) {
    const fn = get().setters[tabId];
    if (!fn) return false;
    fn(view);
    return true;
  },
  startEditOf(tabId) {
    const fn = get().editStarters[tabId];
    if (!fn) return false;
    fn();
    return true;
  },
}));
