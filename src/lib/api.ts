// The frontend ↔ Rust contract. These types mirror the serde types in Rust
// one-to-one. Components never call `invoke` directly; everything goes through here.
import { invoke } from "@tauri-apps/api/core";

// ---- Hata modeli (design 02 §2) ----
export type ErrorKind =
  | "connection_failed"
  | "connection_lost"
  | "query_error"
  | "query_cancelled"
  | "timeout"
  | "parse_error"
  | "keyring_error"
  | "internal";

export interface AriadneError {
  kind: ErrorKind;
  message: string;
  detail?: string;
  sqlstate?: string;
  position?: number;
  hint?: string;
}

export function isAriadneError(e: unknown): e is AriadneError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

// ---- Profiller (design 06) ----
export type SslMode = "disable" | "prefer" | "require" | "verify_ca" | "verify_full";

export interface ConnectionProfile {
  id: string;
  name: string;
  color?: string | null;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl_mode: SslMode;
  statement_timeout_ms?: number | null;
  read_only: boolean;
  options: Record<string, string>;
}

// save_profile girdisi — id yoksa yeni profil.
export type ProfileInput = Omit<ConnectionProfile, "id"> & { id?: string };

export interface ConnectionInfo {
  connection_id: string;
  profile_id: string;
  server_version: string;
  database: string;
  user: string;
  color?: string | null;
}

export interface TestResult {
  server_version: string;
  latency_ms: number;
}

export function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke("list_profiles");
}
export function saveProfile(
  profile: ProfileInput,
  password?: string,
): Promise<ConnectionProfile> {
  return invoke("save_profile", { profile, password });
}
export function deleteProfile(profileId: string): Promise<void> {
  return invoke("delete_profile", { profileId });
}
export function testConnection(
  profile: ProfileInput,
  password?: string,
): Promise<TestResult> {
  return invoke("test_connection", { profile, password });
}
export function connect(
  profileId: string,
  databaseOverride?: string,
): Promise<ConnectionInfo> {
  return invoke("connect", { profileId, databaseOverride });
}
export function disconnect(connectionId: string): Promise<void> {
  return invoke("disconnect", { connectionId });
}

// ---- Database list (for the "Databases ▸" switcher) ----
export interface DatabaseInfo {
  name: string;
  is_current: boolean;
}
export function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return invoke("list_databases", { connectionId });
}

// ---- Schema ----
export type RelKind = "table" | "view" | "mat_view" | "foreign" | "partitioned" | "sequence";
export type FnKind = "function" | "procedure" | "aggregate" | "window";

export interface SnapCol {
  name: string;
  type_name: string;
  not_null: boolean;
}
export interface SnapRel {
  oid: number;
  name: string;
  kind: RelKind;
  estimated_rows: number;
  comment?: string | null;
  columns: SnapCol[];
}
export interface SnapFn {
  oid: number;
  name: string;
  signature: string;
  kind: FnKind;
  /** Whether the return type is `trigger` — for the explorer's "trigger function" filter. */
  is_trigger: boolean;
  comment?: string | null;
}
export interface SnapSchema {
  name: string;
  is_system: boolean;
  relations: SnapRel[];
  functions: SnapFn[];
}
export interface SchemaSnapshot {
  fetched_at: string;
  server_version: string;
  search_path: string[];
  schemas: SnapSchema[];
}

export function getSchemaSnapshot(connectionId: string): Promise<SchemaSnapshot> {
  return invoke("get_schema_snapshot", { connectionId });
}
export function refreshSchema(connectionId: string): Promise<void> {
  return invoke("refresh_schema", { connectionId });
}

// ---- Relation detail + function source (on-demand) ----
export interface IndexInfo {
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
}
export interface TriggerInfo {
  name: string;
  timing: string;
  events: string;
  function: string;
}
export interface RelationDetails {
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
  size_bytes: number;
  live_rows: number;
}
export function getRelationDetails(
  connectionId: string,
  schema: string,
  name: string,
): Promise<RelationDetails> {
  return invoke("get_relation_details", { connectionId, schema, name });
}
export function getFunctionSource(connectionId: string, fnOid: number): Promise<string> {
  return invoke("get_function_source", { connectionId, fnOid });
}

// ---- Sunucu aktivitesi + backend sinyalleme (design 17 §P1-V4) ----
export interface ActivityRow {
  pid: number;
  datname?: string | null;
  usename?: string | null;
  application_name: string;
  client_addr?: string | null;
  state?: string | null;
  wait_event?: string | null;
  backend_start?: string | null;
  query_start?: string | null;
  duration_ms?: number | null;
  query: string;
  is_self: boolean;
  is_app: boolean;
}
export function listActivity(connectionId: string): Promise<ActivityRow[]> {
  return invoke("list_activity", { connectionId });
}
export type SignalMode = "cancel" | "terminate";
export function signalBackend(
  connectionId: string,
  pid: number,
  mode: SignalMode,
): Promise<boolean> {
  return invoke("signal_backend", { connectionId, pid, mode });
}

// ---- DB stats strip ----
export interface DbStats {
  active_connections: number;
  max_connections?: number | null;
  cache_hit_ratio?: number | null; // 0..1
  db_size_bytes?: number | null;
}
export function dbStats(connectionId: string): Promise<DbStats> {
  return invoke("db_stats", { connectionId });
}

// ---- Single-cell editing (DATA-WRITE) ----
export interface PkPredicate {
  column: string;
  value: string;
}
export function getPrimaryKey(
  connectionId: string,
  schema: string,
  table: string,
): Promise<string[]> {
  return invoke("get_primary_key", { connectionId, schema, table });
}
export function updateCell(args: {
  connectionId: string;
  schema: string;
  table: string;
  pk: PkPredicate[];
  column: string;
  newValue: string | null;
}): Promise<{ updated: number }> {
  return invoke("update_cell", args);
}

// ---- Roller (design 15 §P1-U4, salt-okunur) ----
export interface RoleInfo {
  name: string;
  is_superuser: boolean;
  can_login: boolean;
  create_db: boolean;
  create_role: boolean;
  replication: boolean;
  valid_until?: string | null;
  member_of: string[];
}
export function listRoles(connectionId: string): Promise<RoleInfo[]> {
  return invoke("list_roles", { connectionId });
}

// ---- .sql dosya okuma/yazma (design 15 §P1-U4). Yol native diyalogdan gelir. ----
export function readTextFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}
export function writeTextFile(path: string, content: string): Promise<void> {
  return invoke("write_text_file", { path, content });
}

// ---- Query (design 02 §3, 05) ----
export interface ColumnMeta {
  name: string;
  type_name: string;
  type_oid: number;
}
export interface Page {
  rows: (string | null)[][];
  has_more: boolean;
  fetched_total: number;
  elapsed_ms: number;
}
export type StatementResult =
  | { kind: "rows"; columns: ColumnMeta[]; first_page: Page; truncated_cells: boolean }
  | { kind: "affected"; command: string; row_count: number }
  | { kind: "empty"; command: string };
export type TxStatus = "idle" | "in_transaction" | "aborted";
export interface Confirmation {
  statement_index: number;
  kind: "update" | "delete" | "truncate";
  table: string;
  estimated_rows: number | null;
}
export interface RunResult {
  query_id: string;
  statements: StatementResult[];
  tx_status: TxStatus;
  needs_confirmation?: Confirmation | null;
  // Partial results: if a statement failed, the earlier statements and the error are
  // returned together.
  error?: AriadneError | null;
  error_statement_index?: number | null;
}

export function runQuery(
  connectionId: string,
  sql: string,
  tabId: string,
  queryId: string,
  confirmed?: boolean,
  maxRowsPerPage?: number,
): Promise<RunResult> {
  return invoke("run_query", { connectionId, sql, tabId, queryId, confirmed, maxRowsPerPage });
}
export function fetchPage(connectionId: string, queryId: string): Promise<Page> {
  return invoke("fetch_page", { connectionId, queryId });
}
export function cancelQuery(connectionId: string, queryId: string): Promise<void> {
  return invoke("cancel_query", { connectionId, queryId });
}
/// Kills the backend of a stuck query. The returned bool is whether it was signaled.
export function forceKillQuery(connectionId: string, queryId: string): Promise<boolean> {
  return invoke("force_kill_query", { connectionId, queryId });
}
export function closeResult(connectionId: string, tabId: string): Promise<void> {
  return invoke("close_result", { connectionId, tabId });
}

// ---- Completion (design 02 §3, 04) ----
export type CompletionKind =
  | "table"
  | "view"
  | "column"
  | "function"
  | "schema"
  | "keyword"
  | "join";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  insert_text: string;
  is_snippet: boolean;
  detail?: string | null;
  sort_key: string;
}
export interface CompletionResult {
  items: CompletionItem[];
  replace_range: { start: number; end: number };
}

export interface ObjColumn {
  name: string;
  type_name: string;
  not_null: boolean;
  is_pk: boolean;
}
export interface ObjFk {
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  constraint_name: string;
}
export interface ObjectInfo {
  schema: string;
  name: string;
  kind: string;
  estimated_rows: number;
  comment?: string | null;
  columns: ObjColumn[];
  primary_key: string[];
  foreign_keys: ObjFk[];
}
export interface SignatureHelp {
  label: string;
  parameters: string[];
  active_parameter: number;
}

export function getCompletions(
  connectionId: string,
  sql: string,
  cursorOffset: number,
): Promise<CompletionResult> {
  return invoke("get_completions", { connectionId, sql, cursorOffset });
}
export function getObjectInfo(
  connectionId: string,
  sql: string,
  cursorOffset: number,
): Promise<ObjectInfo | null> {
  return invoke("get_object_info", { connectionId, sql, cursorOffset });
}
export function getSignatureHelp(
  connectionId: string,
  sql: string,
  cursorOffset: number,
): Promise<SignatureHelp | null> {
  return invoke("get_signature_help", { connectionId, sql, cursorOffset });
}
