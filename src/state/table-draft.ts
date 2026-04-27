import { create } from "zustand";

/**
 * In-memory draft state for a TableView's structure editor.
 *
 * `App.tsx` only renders the active tab — switching tabs unmounts
 * `<TableView>` and `<StructurePane>`, so dirty edits in their local
 * `useState` would be lost. This store keeps them alive per tabId for
 * the lifetime of the session (no persistence — drafts shouldn't survive
 * an app restart).
 */

export interface DraftColumn {
  uid: string;
  originalName: string | null;
  name: string;
  rawType: string;
  nullable: boolean;
  default: string | null;
  comment: string;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
}

export interface DraftIndex {
  uid: string;
  originalName: string | null;
  name: string;
  columns: string[];
  unique: boolean;
  indexType: string; // BTREE | HASH | FULLTEXT | SPATIAL
}

export interface DraftForeignKey {
  uid: string;
  originalName: string | null;
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface DraftOptions {
  engine: string;
  charset: string;
  collation: string;
  rowFormat: string;
  autoIncrement: string;
  comment: string;
}

export type StructureTab =
  | "columns"
  | "indexes"
  | "foreign_keys"
  | "checks"
  | "triggers"
  | "options"
  | "sql";

export interface TableDraftEntry {
  /** Sub-tab of TableView (data grid vs structure pane). */
  view?: "data" | "structure";
  /** Currently editing the structure (true after `startEdit`). */
  editing?: boolean;
  /** Active inner tab of the structure pane (columns, indexes, etc). */
  structureTab?: StructureTab;
  draftCols?: DraftColumn[];
  draftIdx?: DraftIndex[];
  draftFks?: DraftForeignKey[];
  draftOpts?: DraftOptions;
}

interface TableDraftStore {
  byTab: Record<string, TableDraftEntry>;
  get: (tabId: string) => TableDraftEntry | undefined;
  patch: (tabId: string, p: Partial<TableDraftEntry>) => void;
  clear: (tabId: string) => void;
}

export const useTableDraft = create<TableDraftStore>()((set, get) => ({
  byTab: {},
  get(tabId) {
    return get().byTab[tabId];
  },
  patch(tabId, p) {
    set((s) => {
      const cur = s.byTab[tabId] ?? {};
      return { byTab: { ...s.byTab, [tabId]: { ...cur, ...p } } };
    });
  },
  clear(tabId) {
    set((s) => {
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    });
  },
}));
