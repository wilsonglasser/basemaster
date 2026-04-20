import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import type { SavedQuery, SavedQueryDraft, Uuid } from "@/lib/types";

/**
 * Cache de queries salvas por conexão. A tree pede por (conn, schema)
 * mas aqui armazenamos tudo por conexão — a filtragem por schema é
 * feita via seletor. Isso simplifica invalidação depois de CRUD.
 */
interface SavedQueriesState {
  /** connection_id -> lista completa daquela conexão */
  cache: Record<Uuid, SavedQuery[]>;
  loading: Record<Uuid, boolean>;

  /** Busca (ou devolve cache) das queries daquela conexão. */
  ensure: (connectionId: Uuid) => Promise<SavedQuery[]>;
  /** Força reload do backend. */
  refresh: (connectionId: Uuid) => Promise<SavedQuery[]>;
  /** Limpa o cache de uma conexão (ex: desconectou). */
  invalidate: (connectionId: Uuid) => void;

  create: (
    connectionId: Uuid,
    draft: SavedQueryDraft,
  ) => Promise<SavedQuery>;
  update: (id: Uuid, draft: SavedQueryDraft) => Promise<SavedQuery>;
  delete: (connectionId: Uuid, id: Uuid) => Promise<void>;
}

export const useSavedQueries = create<SavedQueriesState>((set, get) => ({
  cache: {},
  loading: {},

  async ensure(connectionId) {
    const cached = get().cache[connectionId];
    if (cached) return cached;
    if (get().loading[connectionId]) {
      // Aguarda o in-flight existente (polling simples — raro).
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          if (!get().loading[connectionId]) {
            clearInterval(id);
            resolve();
          }
        }, 30);
      });
      return get().cache[connectionId] ?? [];
    }
    return get().refresh(connectionId);
  },

  async refresh(connectionId) {
    set((s) => ({ loading: { ...s.loading, [connectionId]: true } }));
    try {
      const list = await ipc.savedQueries.listAll(connectionId);
      set((s) => ({ cache: { ...s.cache, [connectionId]: list } }));
      return list;
    } finally {
      set((s) => ({ loading: { ...s.loading, [connectionId]: false } }));
    }
  },

  invalidate(connectionId) {
    set((s) => {
      const next = { ...s.cache };
      delete next[connectionId];
      return { cache: next };
    });
  },

  async create(connectionId, draft) {
    const saved = await ipc.savedQueries.create(connectionId, draft);
    set((s) => {
      const cur = s.cache[connectionId] ?? [];
      const sorted = [...cur, saved].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      return { cache: { ...s.cache, [connectionId]: sorted } };
    });
    return saved;
  },

  async update(id, draft) {
    const saved = await ipc.savedQueries.update(id, draft);
    set((s) => {
      const cur = s.cache[saved.connection_id] ?? [];
      const next = cur.map((q) => (q.id === id ? saved : q));
      next.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      return { cache: { ...s.cache, [saved.connection_id]: next } };
    });
    return saved;
  },

  async delete(connectionId, id) {
    await ipc.savedQueries.delete(id);
    set((s) => {
      const cur = s.cache[connectionId];
      if (!cur) return {};
      return {
        cache: {
          ...s.cache,
          [connectionId]: cur.filter((q) => q.id !== id),
        },
      };
    });
  },
}));

/** Seletor: queries desta conexão que pertencem ao schema informado
 *  OU são "globais" (schema null). A tree usa isso. */
export function filterBySchema(
  all: SavedQuery[],
  schema: string,
): SavedQuery[] {
  return all.filter((q) => q.schema === schema || q.schema === null);
}
