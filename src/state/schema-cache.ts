import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import type { Column, SchemaInfo, TableInfo, Uuid } from "@/lib/types";

interface ConnectionCache {
  schemas: SchemaInfo[] | null;
  /** schema → tables (null = ainda não carregado) */
  tables: Record<string, TableInfo[]>;
  /** schema → table → cols */
  columns: Record<string, Record<string, Column[]>>;
}

interface SchemaCacheState {
  caches: Record<Uuid, ConnectionCache>;
  ensureSchemas: (id: Uuid) => Promise<SchemaInfo[]>;
  ensureTables: (id: Uuid, schema: string) => Promise<TableInfo[]>;
  ensureColumns: (id: Uuid, schema: string, table: string) => Promise<Column[]>;
  /** Carrega tabelas + todas as colunas do schema em uma única chamada. */
  ensureSnapshot: (id: Uuid, schema: string) => Promise<TableInfo[]>;
  invalidate: (id: Uuid) => void;
  invalidateSchema: (id: Uuid, schema: string) => void;
}

const emptyCache = (): ConnectionCache => ({
  schemas: null,
  tables: {},
  columns: {},
});

export const useSchemaCache = create<SchemaCacheState>((set, get) => ({
  caches: {},

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
}));
