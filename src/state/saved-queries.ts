import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import type { SavedQuery, SavedQueryDraft, Uuid } from "@/lib/types";

/**
 * Saved-queries cache per connection. The tree asks by (conn, schema)
 * but we store everything per connection — schema filtering is done
 * via a selector. This simplifies invalidation after CRUD.
 */
interface SavedQueriesState {
  /** connection_id -> full list for that connection */
  cache: Record<Uuid, SavedQuery[]>;
  loading: Record<Uuid, boolean>;

  /** Fetch (or return cache) of queries for that connection. */
  ensure: (connectionId: Uuid) => Promise<SavedQuery[]>;
  /** Force reload from the backend. */
  refresh: (connectionId: Uuid) => Promise<SavedQuery[]>;
  /** Clear the cache for a connection (e.g. disconnected). */
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
      // Await the existing in-flight (simple polling — rare).
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

/** Selector: queries for this connection that belong to the given schema
 *  OR are "global" (schema null). The tree uses this. */
export function filterBySchema(
  all: SavedQuery[],
  schema: string,
): SavedQuery[] {
  return all.filter((q) => q.schema === schema || q.schema === null);
}
