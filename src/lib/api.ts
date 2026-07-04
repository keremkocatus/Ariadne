// Frontend ↔ Rust sözleşmesi (design 02). Tipler Rust'taki serde tipleriyle
// birebir tutulur. Component'ler çıplak invoke ÇAĞIRMAZ; hep buradan geçer (07 §5).
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
export function connect(profileId: string): Promise<ConnectionInfo> {
  return invoke("connect", { profileId });
}
export function disconnect(connectionId: string): Promise<void> {
  return invoke("disconnect", { connectionId });
}

// ---- Şema (design 03) ----
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
  // Kısmi sonuç: bir statement patladıysa önceki statements + hata birlikte döner
  // (design 05 §1 / 11 §H2).
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
