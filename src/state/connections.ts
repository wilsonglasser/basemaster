import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import type { ConnectionFolder, ConnectionProfile, Uuid } from "@/lib/types";

interface ConnectionsState {
  connections: ConnectionProfile[];
  folders: ConnectionFolder[];
  active: Set<Uuid>;
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  open: (id: Uuid) => Promise<void>;
  close: (id: Uuid) => Promise<void>;
  remove: (id: Uuid) => Promise<void>;
  upsertLocal: (profile: ConnectionProfile) => void;
  refreshFolders: () => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set) => ({
  connections: [],
  folders: [],
  active: new Set(),
  loading: false,
  error: null,

  async refresh() {
    set({ loading: true, error: null });
    try {
      const [list, folders, active] = await Promise.all([
        ipc.connections.list(),
        ipc.folders.list(),
        ipc.connections.active(),
      ]);
      set({
        connections: list,
        folders,
        active: new Set(active),
        loading: false,
      });
    } catch (e: unknown) {
      set({ error: String(e), loading: false });
    }
  },

  async refreshFolders() {
    try {
      const folders = await ipc.folders.list();
      set({ folders });
    } catch (e) {
      console.error("folders refresh:", e);
    }
  },

  async open(id) {
    await ipc.connections.open(id);
    set((s) => {
      const active = new Set(s.active);
      active.add(id);
      return { active };
    });
  },

  async close(id) {
    await ipc.connections.close(id);
    set((s) => {
      const active = new Set(s.active);
      active.delete(id);
      return { active };
    });
  },

  async remove(id) {
    await ipc.connections.delete(id);
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      active: new Set([...s.active].filter((x) => x !== id)),
    }));
  },

  upsertLocal(profile) {
    set((s) => {
      const idx = s.connections.findIndex((c) => c.id === profile.id);
      const next =
        idx >= 0
          ? s.connections.map((c) => (c.id === profile.id ? profile : c))
          : [...s.connections, profile];
      next.sort((a, b) => a.name.localeCompare(b.name));
      return { connections: next };
    });
  },
}));
