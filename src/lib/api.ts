// The frontend ↔ Rust contract. These types mirror the serde types in Rust
// one-to-one. Components never call `invoke` directly; everything goes through here.
import { invoke } from "@tauri-apps/api/core";

// ---- Error model ----
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

// ---- Connection profiles ----
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
  /** Per-profile pool size; null → default (3). Clamped to 1-10 backend-side. */
  max_pool_connections?: number | null;
  options: Record<string, string>;
}

// Input to save_profile — a missing id means a new profile.
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
  clearPassword?: boolean,
): Promise<ConnectionProfile> {
  return invoke("save_profile", { profile, password, clearPassword });
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
  is_pk: boolean;
}
export interface SnapRel {
  oid: number;
  name: string;
  kind: RelKind;
  estimated_rows: number;
  comment?: string | null;
  /** For a partition: its parent's oid — the tree nests it under that table. */
  parent_oid?: number | null;
  /** For a partition: `FOR VALUES …` / `DEFAULT`. */
  partition_bound?: string | null;
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
  /** The full `CREATE INDEX …` statement. */
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
  is_valid: boolean;
  /** Access method: btree, gin, gist, … */
  method: string;
  /** Key columns / expressions, with " DESC" appended where it applies. */
  key_columns: string[];
  include_columns: string[];
  /** The WHERE predicate of a partial index. */
  predicate?: string | null;
  size_bytes: number;
  scans?: number | null;
}
export interface TriggerInfo {
  name: string;
  /** BEFORE | AFTER | INSTEAD OF */
  timing: string;
  events: string;
  /** ROW | STATEMENT */
  level: string;
  function: string;
  enabled: boolean;
  definition: string;
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

// ---- Full relation details (the Details view) ----
export interface ColumnDetail {
  name: string;
  type_name: string;
  not_null: boolean;
  default_expr?: string | null;
  is_pk: boolean;
  identity?: "always" | "by_default" | null;
  is_generated: boolean;
  comment?: string | null;
}
export type ConstraintKind = "primary_key" | "unique" | "check" | "foreign_key" | "exclusion" | "other";
export interface ConstraintInfo {
  name: string;
  kind: ConstraintKind;
  columns: string[];
  definition: string;
  ref_table?: string | null;
}
export interface IncomingFk {
  name: string;
  table: string;
  definition: string;
}
export interface PartitionInfo {
  schema: string;
  name: string;
  bound?: string | null;
  /** Depth below the inspected table (1 = direct child). */
  level: number;
  is_leaf: boolean;
  size_bytes: number;
  estimated_rows: number;
}
export interface TableStats {
  live_rows: number;
  dead_rows: number;
  seq_scans: number;
  index_scans?: number | null;
  last_vacuum?: string | null;
  last_autovacuum?: string | null;
  last_analyze?: string | null;
  last_autoanalyze?: string | null;
}
export interface RelationFull {
  schema: string;
  name: string;
  kind: RelKind | "other";
  owner: string;
  comment?: string | null;
  estimated_rows: number;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
  stats?: TableStats | null;
  columns: ColumnDetail[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  referenced_by: IncomingFk[];
  triggers: TriggerInfo[];
  partition_key?: string | null;
  /** For a partition: its parent table. */
  partition_of?: { schema: string; name: string } | null;
  partition_bound?: string | null;
  partitions: PartitionInfo[];
  view_definition?: string | null;
}
export function getRelationFull(
  connectionId: string,
  schema: string,
  name: string,
): Promise<RelationFull> {
  return invoke("get_relation_full", { connectionId, schema, name });
}
export function getFunctionSource(connectionId: string, fnOid: number): Promise<string> {
  return invoke("get_function_source", { connectionId, fnOid });
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
  schema: string | null,
  table: string,
): Promise<string[]> {
  return invoke("get_primary_key", { connectionId, schema, table });
}
export function updateCell(args: {
  connectionId: string;
  schema: string | null;
  table: string;
  pk: PkPredicate[];
  column: string;
  newValue: string | null;
}): Promise<{ updated: number }> {
  return invoke("update_cell", args);
}

// ---- Roles ----
export interface RoleInfo {
  name: string;
  is_superuser: boolean;
  can_login: boolean;
  create_db: boolean;
  create_role: boolean;
  replication: boolean;
  bypass_rls: boolean;
  inherit: boolean;
  /** -1 = unlimited. */
  connection_limit: number;
  valid_until?: string | null;
  member_of: string[];
  members: string[];
  comment?: string | null;
  is_current: boolean;
  /** A predefined pg_* role: grantable, but not alterable. */
  is_system: boolean;
}
export function listRoles(connectionId: string): Promise<RoleInfo[]> {
  return invoke("list_roles", { connectionId });
}
export type GrantObjectType = "database" | "schema" | "table" | "view" | "sequence" | "function";
export interface RoleGrant {
  object_type: GrantObjectType;
  schema?: string | null;
  name: string;
  privileges: string[];
}
/** Privileges granted directly to the role in the current database. */
export function getRoleGrants(connectionId: string, role: string): Promise<RoleGrant[]> {
  return invoke("get_role_grants", { connectionId, role });
}
/** Runs UI-built administrative statements in one transaction (all or nothing). */
export function executeStatements(connectionId: string, statements: string[]): Promise<void> {
  return invoke("execute_statements", { connectionId, statements });
}

// ---- pg_cron ----
export interface CronJob {
  job_id: number;
  name?: string | null;
  schedule: string;
  command: string;
  database: string;
  username: string;
  active: boolean;
  last_status?: string | null;
  last_start?: string | null;
  last_duration_ms?: number | null;
  last_message?: string | null;
  recent_runs: number;
  recent_failures: number;
}
export interface CronOverview {
  installed: boolean;
  version?: string | null;
  /** The database pg_cron is configured to live in, when readable. */
  cron_database?: string | null;
  current_database: string;
  has_run_details: boolean;
  jobs: CronJob[];
}
export interface CronRun {
  run_id: number;
  status: string;
  message?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration_ms?: number | null;
  command: string;
}
export interface CronJobInput {
  /** Omitted → create; set → alter that job. */
  job_id?: number | null;
  name: string;
  schedule: string;
  command: string;
  database?: string | null;
  active: boolean;
}
export function cronOverview(connectionId: string): Promise<CronOverview> {
  return invoke("cron_overview", { connectionId });
}
export function cronJobRuns(connectionId: string, jobId: number, limit?: number): Promise<CronRun[]> {
  return invoke("cron_job_runs", { connectionId, jobId, limit });
}
export function cronSaveJob(connectionId: string, job: CronJobInput): Promise<number> {
  return invoke("cron_save_job", { connectionId, job });
}
export function cronSetActive(connectionId: string, jobId: number, active: boolean): Promise<void> {
  return invoke("cron_set_active", { connectionId, jobId, active });
}
export function cronDeleteJob(connectionId: string, jobId: number): Promise<void> {
  return invoke("cron_delete_job", { connectionId, jobId });
}

// ---- .sql file read/write. The path comes from the native dialog. ----
export function readTextFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}
export function writeTextFile(path: string, content: string): Promise<void> {
  return invoke("write_text_file", { path, content });
}

// ---- Query ----
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
/// The single table a plain SELECT reads from (backend-derived from the executed
/// statement) — the basis for cell editing. schema is null when the SQL didn't
/// qualify the name.
export interface SourceTable {
  schema: string | null;
  name: string;
}
/// What ran and how long it took — present on every statement result.
export interface StmtMeta {
  /** Command tag: "SELECT", "CREATE FUNCTION", "COMMIT", … */
  command: string;
  /** The statement on one short line, comments stripped. */
  preview: string;
  elapsed_ms: number;
}
export type StatementResult = StmtMeta &
  (
    | {
        kind: "rows";
        columns: ColumnMeta[];
        first_page: Page;
        truncated_cells: boolean;
        /** Cut at one page and not pageable: only a script's last statement keeps a cursor. */
        partial: boolean;
        source_table?: SourceTable | null;
      }
    | { kind: "affected"; row_count: number }
    | { kind: "empty" }
  );
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
  /** What the failed statement was. */
  error_statement?: StmtMeta | null;
  /** Statements in the script; more than `statements.length` if the run stopped early. */
  total_statements: number;
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
/// A single statement's plan as `EXPLAIN (FORMAT JSON)` text. With `analyze` the
/// statement really runs (inside a transaction that is rolled back). Cancel it with
/// `cancelQuery` and the same `queryId`.
export function explainQuery(
  connectionId: string,
  sql: string,
  queryId: string,
  analyze: boolean,
): Promise<string> {
  return invoke("explain_query", { connectionId, sql, queryId, analyze });
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

// ---- Completion ----
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
