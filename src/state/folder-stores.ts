import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import type {
  SchemaFolder,
  SchemaFolderAssignment,
  TableFolder,
  TableFolderAssignment,
  Uuid,
} from "@/lib/types";

// ---------------------------------------------------------------- schema folders

interface SchemaFoldersState {
  /** connId -> folders (null = not loaded). */
  folders: Record<Uuid, SchemaFolder[] | null>;
  /** connId -> schemaName -> folderId. */
  assignments: Record<Uuid, Record<string, Uuid>>;

  ensure: (connectionId: Uuid) => Promise<void>;
  reload: (connectionId: Uuid) => Promise<void>;
  create: (connectionId: Uuid, name: string) => Promise<SchemaFolder>;
  rename: (connectionId: Uuid, id: Uuid, name: string) => Promise<void>;
  delete: (connectionId: Uuid, id: Uuid) => Promise<void>;
  move: (
    connectionId: Uuid,
    schema: string,
    folderId: Uuid | null,
  ) => Promise<void>;
}

function asgMap(
  rows: SchemaFolderAssignment[],
): Record<string, Uuid> {
  const m: Record<string, Uuid> = {};
  for (const a of rows) m[a.schema_name] = a.folder_id;
  return m;
}

export const useSchemaFolders = create<SchemaFoldersState>((set, get) => ({
  folders: {},
  assignments: {},

  async ensure(connectionId) {
    if (get().folders[connectionId]) return;
    await get().reload(connectionId);
  },

  async reload(connectionId) {
    const [folders, asgs] = await Promise.all([
      ipc.schemaFolders.list(connectionId),
      ipc.schemaFolders.assignments(connectionId),
    ]);
    set((s) => ({
      folders: { ...s.folders, [connectionId]: folders },
      assignments: { ...s.assignments, [connectionId]: asgMap(asgs) },
    }));
  },

  async create(connectionId, name) {
    const folder = await ipc.schemaFolders.create(connectionId, name);
    set((s) => {
      const cur = s.folders[connectionId] ?? [];
      return {
        folders: { ...s.folders, [connectionId]: [...cur, folder] },
      };
    });
    return folder;
  },

  async rename(connectionId, id, name) {
    await ipc.schemaFolders.rename(id, name);
    set((s) => {
      const cur = s.folders[connectionId] ?? [];
      return {
        folders: {
          ...s.folders,
          [connectionId]: cur.map((f) => (f.id === id ? { ...f, name } : f)),
        },
      };
    });
  },

  async delete(connectionId, id) {
    await ipc.schemaFolders.delete(id);
    set((s) => {
      const cur = s.folders[connectionId] ?? [];
      const asg = s.assignments[connectionId] ?? {};
      const nextAsg = { ...asg };
      for (const k of Object.keys(nextAsg)) {
        if (nextAsg[k] === id) delete nextAsg[k];
      }
      return {
        folders: {
          ...s.folders,
          [connectionId]: cur.filter((f) => f.id !== id),
        },
        assignments: { ...s.assignments, [connectionId]: nextAsg },
      };
    });
  },

  async move(connectionId, schema, folderId) {
    await ipc.schemaFolders.move(connectionId, schema, folderId);
    set((s) => {
      const cur = { ...(s.assignments[connectionId] ?? {}) };
      if (folderId) cur[schema] = folderId;
      else delete cur[schema];
      return { assignments: { ...s.assignments, [connectionId]: cur } };
    });
  },
}));

// ---------------------------------------------------------------- table folders

type SchemaKey = string; // `${connId}:${schema}`

function key(connectionId: Uuid, schema: string): SchemaKey {
  return `${connectionId}:${schema}`;
}

interface TableFoldersState {
  /** key(connId, schema) -> folders (null = not loaded). */
  folders: Record<SchemaKey, TableFolder[] | null>;
  /** key(connId, schema) -> tableName -> folderId. */
  assignments: Record<SchemaKey, Record<string, Uuid>>;

  ensure: (connectionId: Uuid, schema: string) => Promise<void>;
  reload: (connectionId: Uuid, schema: string) => Promise<void>;
  create: (
    connectionId: Uuid,
    schema: string,
    name: string,
  ) => Promise<TableFolder>;
  rename: (
    connectionId: Uuid,
    schema: string,
    id: Uuid,
    name: string,
  ) => Promise<void>;
  delete: (connectionId: Uuid, schema: string, id: Uuid) => Promise<void>;
  move: (
    connectionId: Uuid,
    schema: string,
    table: string,
    folderId: Uuid | null,
  ) => Promise<void>;
}

function tasgMap(
  rows: TableFolderAssignment[],
): Record<string, Uuid> {
  const m: Record<string, Uuid> = {};
  for (const a of rows) m[a.table_name] = a.folder_id;
  return m;
}

export const useTableFolders = create<TableFoldersState>((set, get) => ({
  folders: {},
  assignments: {},

  async ensure(connectionId, schema) {
    if (get().folders[key(connectionId, schema)]) return;
    await get().reload(connectionId, schema);
  },

  async reload(connectionId, schema) {
    const [folders, asgs] = await Promise.all([
      ipc.tableFolders.list(connectionId, schema),
      ipc.tableFolders.assignments(connectionId, schema),
    ]);
    const k = key(connectionId, schema);
    set((s) => ({
      folders: { ...s.folders, [k]: folders },
      assignments: { ...s.assignments, [k]: tasgMap(asgs) },
    }));
  },

  async create(connectionId, schema, name) {
    const folder = await ipc.tableFolders.create(connectionId, schema, name);
    const k = key(connectionId, schema);
    set((s) => {
      const cur = s.folders[k] ?? [];
      return { folders: { ...s.folders, [k]: [...cur, folder] } };
    });
    return folder;
  },

  async rename(connectionId, schema, id, name) {
    await ipc.tableFolders.rename(id, name);
    const k = key(connectionId, schema);
    set((s) => {
      const cur = s.folders[k] ?? [];
      return {
        folders: {
          ...s.folders,
          [k]: cur.map((f) => (f.id === id ? { ...f, name } : f)),
        },
      };
    });
  },

  async delete(connectionId, schema, id) {
    await ipc.tableFolders.delete(id);
    const k = key(connectionId, schema);
    set((s) => {
      const cur = s.folders[k] ?? [];
      const asg = s.assignments[k] ?? {};
      const nextAsg = { ...asg };
      for (const t of Object.keys(nextAsg)) {
        if (nextAsg[t] === id) delete nextAsg[t];
      }
      return {
        folders: { ...s.folders, [k]: cur.filter((f) => f.id !== id) },
        assignments: { ...s.assignments, [k]: nextAsg },
      };
    });
  },

  async move(connectionId, schema, table, folderId) {
    await ipc.tableFolders.move(connectionId, schema, table, folderId);
    const k = key(connectionId, schema);
    set((s) => {
      const cur = { ...(s.assignments[k] ?? {}) };
      if (folderId) cur[table] = folderId;
      else delete cur[table];
      return { assignments: { ...s.assignments, [k]: cur } };
    });
  },
}));
