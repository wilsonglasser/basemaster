import { invoke } from "@tauri-apps/api/core";

import type {
  CellEdit,
  Column,
  ConnectionDraft,
  ConnectionFolder,
  ConnectionFolderDraft,
  ConnectionProfile,
  DockerCandidate,
  DumpDone,
  ExportPayload,
  DumpOptions,
  ImportDone,
  ImportOptions,
  EditResult,
  ForeignKeyInfo,
  IndexInfo,
  InsertResult,
  KnownHostEntry,
  McpStatus,
  PageOptions,
  PkEntry,
  QueryHistoryDraft,
  QueryHistoryEntry,
  QueryResult,
  QueryRunBatch,
  SavedQuery,
  SavedQueryDraft,
  SchemaInfo,
  SchemaSnapshot,
  TableInfo,
  TableOpResult,
  TableOptions,
  TransferDone,
  TransferOptions,
  Uuid,
} from "./types";

/**
 * Typed client for Tauri commands. All front-end IPC calls go through here.
 *
 * Convention: Rust command arguments in snake_case become camelCase in JS
 * (Tauri auto-converts). Errors arrive as `string`.
 */
export const ipc = {
  ping: () => invoke<string>("ping"),

  connections: {
    list: () => invoke<ConnectionProfile[]>("connection_list"),

    get: (id: Uuid) => invoke<ConnectionProfile>("connection_get", { id }),

    create: (
      draft: ConnectionDraft,
      password: string | null,
      sshPassword: string | null = null,
      sshKeyPassphrase: string | null = null,
      sshJumpsSecrets: string | null = null,
      httpProxyPassword: string | null = null,
    ) =>
      invoke<ConnectionProfile>("connection_create", {
        draft,
        password,
        sshPassword,
        sshKeyPassphrase,
        sshJumpsSecrets,
        httpProxyPassword,
      }),

    update: (
      id: Uuid,
      draft: ConnectionDraft,
      password: string | null,
      sshPassword: string | null = null,
      sshKeyPassphrase: string | null = null,
      sshJumpsSecrets: string | null = null,
      httpProxyPassword: string | null = null,
    ) =>
      invoke<ConnectionProfile>("connection_update", {
        id,
        draft,
        password,
        sshPassword,
        sshKeyPassphrase,
        sshJumpsSecrets,
        httpProxyPassword,
      }),

    delete: (id: Uuid) => invoke<void>("connection_delete", { id }),

    test: (
      draft: ConnectionDraft,
      password: string | null,
      sshPassword: string | null = null,
      sshKeyPassphrase: string | null = null,
      sshJumpsSecrets: string | null = null,
      httpProxyPassword: string | null = null,
    ) =>
      invoke<void>("connection_test", {
        draft,
        password,
        sshPassword,
        sshKeyPassphrase,
        sshJumpsSecrets,
        httpProxyPassword,
      }),

    open: (id: Uuid) => invoke<void>("connection_open", { id }),

    close: (id: Uuid) => invoke<void>("connection_close", { id }),

    active: () => invoke<Uuid[]>("connection_active"),

    reorder: (orderedIds: Uuid[]) =>
      invoke<void>("connection_reorder", { orderedIds }),
  },

  db: {
    listSchemas: (connectionId: Uuid) =>
      invoke<SchemaInfo[]>("list_schemas", { connectionId }),

    listTables: (connectionId: Uuid, schema: string) =>
      invoke<TableInfo[]>("list_tables", { connectionId, schema }),

    describeTable: (connectionId: Uuid, schema: string, table: string) =>
      invoke<Column[]>("describe_table", { connectionId, schema, table }),

    listIndexes: (connectionId: Uuid, schema: string, table: string) =>
      invoke<IndexInfo[]>("list_indexes", { connectionId, schema, table }),

    listForeignKeys: (connectionId: Uuid, schema: string, table: string) =>
      invoke<ForeignKeyInfo[]>("list_foreign_keys", {
        connectionId,
        schema,
        table,
      }),

    tableOptions: (connectionId: Uuid, schema: string, table: string) =>
      invoke<TableOptions>("table_options", { connectionId, schema, table }),

    duplicateTable: (
      connectionId: Uuid,
      schema: string,
      source: string,
      target: string,
      copyData: boolean,
    ) =>
      invoke<void>("duplicate_table", {
        connectionId,
        schema,
        source,
        target,
        copyData,
      }),

    findAvailableTableName: (connectionId: Uuid, schema: string, base: string) =>
      invoke<string>("find_available_table_name", {
        connectionId,
        schema,
        base,
      }),

    renameTable: (
      connectionId: Uuid,
      schema: string,
      from: string,
      to: string,
    ) =>
      invoke<void>("rename_table", { connectionId, schema, from, to }),

    dropTables: (connectionId: Uuid, schema: string, tables: string[]) =>
      invoke<TableOpResult[]>("drop_tables", { connectionId, schema, tables }),

    truncateTables: (connectionId: Uuid, schema: string, tables: string[]) =>
      invoke<TableOpResult[]>("truncate_tables", {
        connectionId,
        schema,
        tables,
      }),

    emptyTables: (connectionId: Uuid, schema: string, tables: string[]) =>
      invoke<TableOpResult[]>("empty_tables", { connectionId, schema, tables }),

    renameSchema: (connectionId: Uuid, from: string, to: string) =>
      invoke<void>("rename_schema", { connectionId, from, to }),

    /** Tables + all columns in a single call — for autocomplete. */
    prefetchSchema: (connectionId: Uuid, schema: string) =>
      invoke<SchemaSnapshot>("schema_prefetch", { connectionId, schema }),

    /** Navicat mode — TableView. */
    tableCount: (connectionId: Uuid, schema: string, table: string) =>
      invoke<number>("table_count", { connectionId, schema, table }),

    tablePage: (
      connectionId: Uuid,
      schema: string,
      table: string,
      options: PageOptions,
    ) =>
      invoke<QueryResult>("table_page", {
        connectionId,
        schema,
        table,
        options,
      }),

    applyTableEdits: (
      connectionId: Uuid,
      schema: string,
      table: string,
      edits: CellEdit[],
    ) =>
      invoke<EditResult[]>("apply_table_edits", {
        connectionId,
        schema,
        table,
        edits,
      }),

    deleteTableRows: (
      connectionId: Uuid,
      schema: string,
      table: string,
      rows: PkEntry[][],
    ) =>
      invoke<EditResult[]>("delete_table_rows", {
        connectionId,
        schema,
        table,
        rows,
      }),

    insertTableRows: (
      connectionId: Uuid,
      schema: string,
      table: string,
      rows: PkEntry[][],
    ) =>
      invoke<InsertResult[]>("insert_table_rows", {
        connectionId,
        schema,
        table,
        rows,
      }),

    runQuery: (
      connectionId: Uuid,
      sql: string,
      schema: string | null,
      requestId: string | null = null,
    ) =>
      invoke<QueryRunBatch>("query_run", {
        connectionId,
        schema,
        sql,
        requestId,
      }),

    cancelQuery: (requestId: string) =>
      invoke<boolean>("query_cancel", { requestId }),
  },

  ssh: {
    respondKey: (requestId: string, accept: boolean) =>
      invoke<boolean>("ssh_host_key_respond", { requestId, accept }),

    knownHostsList: () =>
      invoke<KnownHostEntry[]>("ssh_known_hosts_list"),

    knownHostsRemove: (host: string, port: number, fingerprintSha256: string) =>
      invoke<void>("ssh_known_hosts_remove", {
        host,
        port,
        fingerprintSha256,
      }),
  },

  transfer: {
    start: (opts: TransferOptions) =>
      invoke<TransferDone>("data_transfer_start", { opts }),
    pause: () => invoke<void>("data_transfer_pause"),
    resume: () => invoke<void>("data_transfer_resume"),
    stop: () => invoke<void>("data_transfer_stop"),
    checkBinlogEnabled: (connectionId: Uuid) =>
      invoke<boolean>("check_binlog_enabled", { connectionId }),
  },

  sqlDump: {
    start: (opts: DumpOptions) =>
      invoke<DumpDone>("sql_dump_start", { opts }),
  },

  sqlImport: {
    start: (opts: ImportOptions) =>
      invoke<ImportDone>("sql_import_start", { opts }),
  },

  folders: {
    list: () => invoke<ConnectionFolder[]>("connection_folders_list"),
    create: (draft: ConnectionFolderDraft) =>
      invoke<ConnectionFolder>("connection_folders_create", { draft }),
    rename: (id: Uuid, name: string) =>
      invoke<void>("connection_folders_rename", { id, name }),
    delete: (id: Uuid) =>
      invoke<void>("connection_folders_delete", { id }),
    move: (connectionId: Uuid, folderId: Uuid | null) =>
      invoke<void>("connection_folders_move", {
        connectionId,
        folderId,
      }),
  },

  queryHistory: {
    list: (connectionId: Uuid, limit?: number) =>
      invoke<QueryHistoryEntry[]>("query_history_list", {
        connectionId,
        limit: limit ?? null,
      }),
    insert: (connectionId: Uuid, draft: QueryHistoryDraft) =>
      invoke<QueryHistoryEntry>("query_history_insert", {
        connectionId,
        draft,
      }),
    delete: (id: Uuid) => invoke<void>("query_history_delete", { id }),
    clear: (connectionId: Uuid) =>
      invoke<number>("query_history_clear", { connectionId }),
  },

  savedQueries: {
    list: (connectionId: Uuid, schema?: string) =>
      invoke<SavedQuery[]>("saved_queries_list", {
        connectionId,
        schema: schema ?? null,
      }),
    listAll: (connectionId: Uuid) =>
      invoke<SavedQuery[]>("saved_queries_list_all", { connectionId }),
    create: (connectionId: Uuid, draft: SavedQueryDraft) =>
      invoke<SavedQuery>("saved_queries_create", { connectionId, draft }),
    update: (id: Uuid, draft: SavedQueryDraft) =>
      invoke<SavedQuery>("saved_queries_update", { id, draft }),
    delete: (id: Uuid) => invoke<void>("saved_queries_delete", { id }),
  },

  docker: {
    discover: () => invoke<DockerCandidate[]>("docker_discover_connections"),
  },

  portability: {
    export: (includePasswords: boolean) =>
      invoke<ExportPayload>("connections_export", { includePasswords }),
    importParse: (path: string) =>
      invoke<ExportPayload>("connections_import_parse", { path }),
    importApply: (payload: ExportPayload) =>
      invoke<number>("connections_import_apply", { payload }),
  },

  mcp: {
    status: () => invoke<McpStatus>("mcp_status"),
    start: (port?: number) =>
      invoke<McpStatus>("mcp_start", { port: port ?? null }),
    stop: () => invoke<McpStatus>("mcp_stop"),
  },

  taskbar: {
    /** Controls the icon progress bar in the taskbar (Windows) / dock (macOS).
     *  status: "none" | "normal" | "indeterminate" | "paused" | "error".
     *  progress: 0..=100 (ignored for indeterminate/none). */
    setProgress: (
      status: "none" | "normal" | "indeterminate" | "paused" | "error",
      progress?: number,
    ) => invoke<void>("set_taskbar_progress", { status, progress }),
  },

  window: {
    openDetached: (
      label: string,
      urlFragment: string,
      title: string,
      x?: number,
      y?: number,
    ) =>
      invoke<void>("open_detached_window", {
        label,
        urlFragment,
        title,
        x,
        y,
      }),
    close: (label: string) => invoke<void>("close_window", { label }),
  },
};

export const CONN_COLORS = [
  { name: "azul", hex: "#3b82f6" },
  { name: "roxo", hex: "#8b5cf6" },
  { name: "rosa", hex: "#ec4899" },
  { name: "vermelho", hex: "#ef4444" },
  { name: "laranja", hex: "#f97316" },
  { name: "âmbar", hex: "#f59e0b" },
  { name: "verde", hex: "#22c55e" },
  { name: "ciano", hex: "#06b6d4" },
] as const;
