// Mirrors types serialized by the Rust backend (serde).
// Keep in sync with:
//   crates/core/src/{connection,schema,value}.rs
//   crates/store/src/connections.rs

export type Uuid = string;

export interface SavedQuery {
  id: Uuid;
  connection_id: Uuid;
  schema: string | null;
  name: string;
  sql: string;
  created_at: number;
  updated_at: number;
}

export interface SavedQueryDraft {
  name: string;
  sql: string;
  schema?: string | null;
}

export interface QueryHistoryEntry {
  id: Uuid;
  connection_id: Uuid;
  schema: string | null;
  sql: string;
  executed_at: number;
  elapsed_ms: number;
  rows_affected: number | null;
  success: boolean;
  error_msg: string | null;
}

export interface QueryHistoryDraft {
  sql: string;
  schema?: string | null;
  elapsed_ms: number;
  rows_affected?: number | null;
  success: boolean;
  error_msg?: string | null;
}

export type TlsMode = "disabled" | "preferred" | "required";

export interface SshTunnelConfig {
  host: string;
  port: number;
  user: string;
  password?: string | null;
  private_key_path?: string | null;
  private_key_passphrase?: string | null;
}

export interface HttpProxyConfig {
  host: string;
  port: number;
  user?: string | null;
  password?: string | null;
}

export interface McpStatus {
  running: boolean;
  port: number;
  token: string | null;
}

export interface ExportedFolder {
  name: string;
  color: string | null;
}

export interface ExportedConnection {
  name: string;
  color: string | null;
  driver: string;
  host: string;
  port: number;
  user: string;
  default_database: string | null;
  tls: TlsMode;
  password: string | null;
  ssh_tunnel: SshTunnelConfig | null;
  ssh_password: string | null;
  ssh_key_passphrase: string | null;
  http_proxy: HttpProxyConfig | null;
  http_proxy_password: string | null;
  folder_name: string | null;
}

export interface ExportPayload {
  version: number;
  folders: ExportedFolder[];
  connections: ExportedConnection[];
}

export interface DockerCandidate {
  id: string;
  container_name: string;
  image: string;
  /** "mysql" | "postgres" */
  driver: string;
  host: string;
  port: number;
  user: string | null;
  password: string | null;
  default_database: string | null;
  running: boolean;
  via_wsl: boolean;
}

export interface ConnectionFolder {
  id: Uuid;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: number;
}

export interface ConnectionFolderDraft {
  name: string;
  color?: string | null;
}

export interface ConnectionProfile {
  id: Uuid;
  name: string;
  color: string | null;
  driver: string;
  host: string;
  port: number;
  user: string;
  default_database: string | null;
  tls: TlsMode;
  ssh_tunnel: SshTunnelConfig | null;
  http_proxy: HttpProxyConfig | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  folder_id: Uuid | null;
}

export interface ConnectionDraft {
  name: string;
  color?: string | null;
  driver?: string;
  host: string;
  port: number;
  user: string;
  default_database?: string | null;
  tls?: TlsMode;
  ssh_tunnel?: SshTunnelConfig | null;
  http_proxy?: HttpProxyConfig | null;
}

export interface SchemaInfo {
  name: string;
  charset?: string | null;
  collation?: string | null;
}

export type TableKind = "table" | "view" | "materialized_view";

export interface TableInfo {
  schema: string;
  name: string;
  kind: TableKind;
  engine?: string | null;
  row_estimate?: number | null;
  size_bytes?: number | null;
  comment?: string | null;
}

export type ColumnType =
  | { kind: "integer"; bits: number; unsigned: boolean }
  | { kind: "decimal"; precision: number; scale: number }
  | { kind: "float" }
  | { kind: "double" }
  | { kind: "boolean" }
  | { kind: "text"; max_len: number | null }
  | { kind: "blob"; max_len: number | null }
  | { kind: "json" }
  | { kind: "date" }
  | { kind: "time" }
  | { kind: "date_time" }
  | { kind: "timestamp" }
  | { kind: "enum"; values: string[] }
  | { kind: "set"; values: string[] }
  | { kind: "other"; raw: string };

export interface Column {
  name: string;
  column_type: ColumnType;
  nullable: boolean;
  default?: string | null;
  is_primary_key: boolean;
  is_auto_increment: boolean;
  comment?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  is_primary: boolean;
  index_type?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  ref_schema?: string | null;
  ref_table: string;
  ref_columns: string[];
  on_update?: string | null;
  on_delete?: string | null;
}

export interface TableOptions {
  engine?: string | null;
  charset?: string | null;
  collation?: string | null;
  row_format?: string | null;
  auto_increment?: number | null;
  comment?: string | null;
}

export type Value =
  | { type: "null"; value?: null }
  | { type: "bool"; value: boolean }
  | { type: "int"; value: number }
  | { type: "u_int"; value: number }
  | { type: "float"; value: number }
  | { type: "decimal"; value: string }
  | { type: "string"; value: string }
  | { type: "bytes"; value: number[] }
  | { type: "json"; value: unknown }
  | { type: "date"; value: string }
  | { type: "time"; value: string }
  | { type: "date_time"; value: string }
  | { type: "timestamp"; value: string };

export interface SourceTable {
  schema: string;
  table: string;
  pk_columns: string[];
}

export interface QueryResult {
  columns: string[];
  rows: Value[][];
  source_table: SourceTable | null;
  elapsed_ms: number;
  truncated: boolean;
}

export interface ExecuteResult {
  rows_affected: number;
  last_insert_id: number | null;
  elapsed_ms: number;
}

export interface SchemaSnapshot {
  tables: TableInfo[];
  /** table name → columns (in declaration order) */
  columns: Record<string, Column[]>;
}

export type SortDir = "asc" | "desc";

export interface OrderBy {
  column: string;
  direction: SortDir;
}

// --- Data Transfer --------------------------------------------------------

export type InsertMode = "insert" | "insert_ignore" | "replace";

export interface TransferOptions {
  source_connection_id: Uuid;
  source_schema: string;
  target_connection_id: Uuid;
  target_schema: string;
  tables: string[];
  drop_target?: boolean;
  create_tables?: boolean;
  empty_target?: boolean;
  chunk_size?: number;
  continue_on_error?: boolean;
  concurrency?: number;
  insert_mode?: InsertMode;
  disable_fk_checks?: boolean;
  disable_unique_checks?: boolean;
  disable_binlog?: boolean;
  use_transaction?: boolean;
  lock_target?: boolean;
  max_statement_size_kb?: number;
  use_keyset_pagination?: boolean;
  create_target_schema?: boolean;
  create_records?: boolean;
  complete_inserts?: boolean;
  extended_inserts?: boolean;
  hex_blob?: boolean;
  single_transaction?: boolean;
  lock_source?: boolean;
  preserve_zero_auto_increment?: boolean;
  copy_triggers?: boolean;
  intra_table_workers?: number;
  intra_table_min_rows?: number;
}

export interface TableProgress {
  table: string;
  done: number;
  total: number;
  elapsed_ms: number;
}

export interface TableDone {
  table: string;
  rows: number;
  elapsed_ms: number;
  error: string | null;
}

export interface TableNote {
  table: string;
  message: string;
  /** "info" | "warn" */
  level: string;
}

export type DumpFormat = "sql" | "zip";
export type DumpCompression = "stored" | "deflate";
export type DumpContent = "structure" | "data" | "both";

export interface DumpScope {
  schema: string;
  tables?: string[];
}

export interface DumpOptions {
  source_connection_id: Uuid;
  scopes: DumpScope[];
  path: string;
  format: DumpFormat;
  compression?: DumpCompression;
  content?: DumpContent;
  drop_before_create?: boolean;
  extended_inserts?: boolean;
  complete_inserts?: boolean;
  hex_blob?: boolean;
  create_schema?: boolean;
  chunk_size?: number;
  max_statement_size_kb?: number;
}

export interface DumpTableProgress {
  schema: string;
  table: string;
  done: number;
  total: number;
  elapsed_ms: number;
}

export interface DumpTableDone {
  schema: string;
  table: string;
  rows: number;
  elapsed_ms: number;
  error: string | null;
}

export interface DumpDone {
  total_rows: number;
  elapsed_ms: number;
  tables_done: number;
  failed: number;
}

export interface ImportOptions {
  target_connection_id: Uuid;
  path: string;
  schema?: string | null;
  continue_on_error?: boolean;
  emit_every?: number;
  disable_fk_checks?: boolean;
  disable_unique_checks?: boolean;
  preserve_zero_auto_increment?: boolean;
}

export interface ImportProgress {
  statements_done: number;
  errors: number;
  current_source: string;
}

export interface ImportStmtError {
  index: number;
  sql: string;
  message: string;
}

export interface ImportDone {
  statements_done: number;
  errors: number;
  elapsed_ms: number;
}

export interface TableWorkerProgress {
  table: string;
  worker_id: number;
  /** PK bounds (inclusive, exclusive). String to support i128. */
  low_pk: string;
  high_pk: string;
  done: number;
  elapsed_ms: number;
  finished: boolean;
  error: string | null;
}

export interface TransferDone {
  total_rows: number;
  elapsed_ms: number;
  failed: number;
}

export type FilterOp =
  | "eq"
  | "not_eq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "not_contains"
  | "begins_with"
  | "not_begins_with"
  | "ends_with"
  | "not_ends_with"
  | "is_null"
  | "is_not_null"
  | "is_empty"
  | "is_not_empty"
  | "between"
  | "not_between"
  | "in"
  | "not_in"
  | "custom";

export interface Filter {
  column: string;
  op: FilterOp;
  /** Ignored for is_null/is_not_null/is_empty/is_not_empty.
   *  For in/not_in: CSV string. For custom: raw SQL fragment. */
  value?: Value | null;
  /** Second value, only for between/not_between. */
  value2?: Value | null;
}

export type GroupOp = "and" | "or";

export type FilterNode =
  | { kind: "leaf"; filter: Filter }
  | { kind: "group"; op: GroupOp; children: FilterNode[] };

export interface PageOptions {
  limit: number;
  offset: number;
  order_by?: OrderBy | null;
  filter_tree?: FilterNode | null;
}

export interface PkEntry {
  column: string;
  value: Value;
}

export interface CellEdit {
  row_pk: PkEntry[];
  column: string;
  new_value: Value;
}

export type EditResult =
  | { kind: "ok"; rows_affected: number }
  | { kind: "err"; message: string };

export type InsertResult =
  | { kind: "ok"; last_insert_id: number }
  | { kind: "err"; message: string };

export interface TableOpResult {
  table: string;
  error: string | null;
}

export type QueryRunResult =
  | {
      kind: "select";
      sql: string;
      columns: string[];
      rows: Value[][];
      elapsed_ms: number;
    }
  | {
      kind: "modify";
      sql: string;
      rows_affected: number;
      last_insert_id: number | null;
      elapsed_ms: number;
    }
  | {
      kind: "error";
      sql: string;
      message: string;
      elapsed_ms: number;
    };

export interface QueryRunBatch {
  results: QueryRunResult[];
  started_at_ms: number;
  finished_at_ms: number;
  total_ms: number;
}
