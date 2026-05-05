import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import type { Column, SchemaInfo, TableInfo, Uuid } from "@/lib/types";

interface ConnectionCache {
  schemas: SchemaInfo[] | null;
  /** schema → tables (null = not loaded yet) */
  tables: Record<string, TableInfo[]>;
  /** schema → table → cols */
  columns: Record<string, Record<string, Column[]>>;
}

interface SchemaCacheState {
  caches: Record<Uuid, ConnectionCache>;
  /** Increments whenever a connection's schema list changes externally
   *  (CREATE/DROP/RENAME SCHEMA). Components holding a local copy of the
   *  list observe this and refetch. */
  schemaListTick: Record<Uuid, number>;
  /** Schema names that the user just dropped, before the listSchemas
   *  refetch confirms removal. Consumers filter these out of their visible
   *  list to avoid the "ghost" lingering during the IPC round-trip. */
  pendingSchemaDrops: Record<Uuid, string[]>;
  ensureSchemas: (id: Uuid) => Promise<SchemaInfo[]>;
  ensureTables: (id: Uuid, schema: string) => Promise<TableInfo[]>;
  ensureColumns: (id: Uuid, schema: string, table: string) => Promise<Column[]>;
  /** Loads tables + all columns of the schema in a single call. */
  ensureSnapshot: (id: Uuid, schema: string) => Promise<TableInfo[]>;
  invalidate: (id: Uuid) => void;
  invalidateSchema: (id: Uuid, schema: string) => void;
  /** Optimistically removes the given table names from the cached snapshot
   *  of `schema` (without re-fetching the whole schema). Used right after
   *  a successful DROP TABLE so the tree updates immediately. */
  removeTablesFromCache: (id: Uuid, schema: string, names: string[]) => void;
  /** Tombstone for a just-dropped schema so any tree node that holds a
   *  local list filters it out until the next listSchemas returns. */
  markSchemaDropped: (id: Uuid, schema: string) => void;
  clearPendingSchemaDrops: (id: Uuid) => void;
  /** Marks that the LIST of schemas changed. */
  bumpSchemaList: (id: Uuid) => void;
}

const emptyCache = (): ConnectionCache => ({
  schemas: null,
  tables: {},
  columns: {},
});

export const useSchemaCache = create<SchemaCacheState>((set, get) => ({
  caches: {},
  schemaListTick: {},
  pendingSchemaDrops: {},

  async ensureSchemas(id) {
    const c = get().caches[id] ?? emptyCache();
    if (c.schemas) return c.schemas;
    const schemas = await ipc.db.listSchemas(id);
    set((s) => ({
      caches: {
        ...s.caches,
        [id]: { ...(s.caches[id] ?? emptyCache()), schemas },
      },
    }));
    return schemas;
  },

  async ensureTables(id, schema) {
    const c = get().caches[id] ?? emptyCache();
    if (c.tables[schema]) return c.tables[schema];
    const tables = await ipc.db.listTables(id, schema);
    set((s) => {
      const cur = s.caches[id] ?? emptyCache();
      return {
        caches: {
          ...s.caches,
          [id]: { ...cur, tables: { ...cur.tables, [schema]: tables } },
        },
      };
    });
    return tables;
  },

  async ensureColumns(id, schema, table) {
    const c = get().caches[id] ?? emptyCache();
    if (c.columns[schema]?.[table]) return c.columns[schema][table];
    const cols = await ipc.db.describeTable(id, schema, table);
    set((s) => {
      const cur = s.caches[id] ?? emptyCache();
      const schemaCols = cur.columns[schema] ?? {};
      return {
        caches: {
          ...s.caches,
          [id]: {
            ...cur,
            columns: {
              ...cur.columns,
              [schema]: { ...schemaCols, [table]: cols },
            },
          },
        },
      };
    });
    return cols;
  },

  async ensureSnapshot(id, schema) {
    const c = get().caches[id] ?? emptyCache();
    if (c.tables[schema] && c.columns[schema]) {
      return c.tables[schema];
    }
    const snap = await ipc.db.prefetchSchema(id, schema);
    set((s) => {
      const cur = s.caches[id] ?? emptyCache();
      return {
        caches: {
          ...s.caches,
          [id]: {
            ...cur,
            tables: { ...cur.tables, [schema]: snap.tables },
            columns: {
              ...cur.columns,
              [schema]: { ...(cur.columns[schema] ?? {}), ...snap.columns },
            },
          },
        },
      };
    });
    return snap.tables;
  },

  invalidate(id) {
    set((s) => {
      const next = { ...s.caches };
      delete next[id];
      return { caches: next };
    });
  },

  invalidateSchema(id, schema) {
    set((s) => {
      const cur = s.caches[id];
      if (!cur) return s;
      const tables = { ...cur.tables };
      const columns = { ...cur.columns };
      delete tables[schema];
      delete columns[schema];
      return {
        caches: { ...s.caches, [id]: { ...cur, tables, columns } },
      };
    });
  },

  removeTablesFromCache(id, schema, names) {
    if (names.length === 0) return;
    const drop = new Set(names);
    set((s) => {
      const cur = s.caches[id];
      if (!cur) return s;
      const cachedTables = cur.tables[schema];
      if (!cachedTables) return s;
      const nextTables = cachedTables.filter((t) => !drop.has(t.name));
      const cols = cur.columns[schema] ?? {};
      const nextCols = { ...cols };
      for (const n of drop) delete nextCols[n];
      return {
        caches: {
          ...s.caches,
          [id]: {
            ...cur,
            tables: { ...cur.tables, [schema]: nextTables },
            columns: { ...cur.columns, [schema]: nextCols },
          },
        },
      };
    });
  },

  markSchemaDropped(id, schema) {
    set((s) => {
      const cur = s.pendingSchemaDrops[id] ?? [];
      if (cur.includes(schema)) return s;
      return {
        pendingSchemaDrops: {
          ...s.pendingSchemaDrops,
          [id]: [...cur, schema],
        },
      };
    });
  },

  clearPendingSchemaDrops(id) {
    set((s) => {
      if (!s.pendingSchemaDrops[id]) return s;
      const next = { ...s.pendingSchemaDrops };
      delete next[id];
      return { pendingSchemaDrops: next };
    });
  },

  bumpSchemaList(id) {
    set((s) => ({
      schemaListTick: {
        ...s.schemaListTick,
        [id]: (s.schemaListTick[id] ?? 0) + 1,
      },
    }));
  },
}));
