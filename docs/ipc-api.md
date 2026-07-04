# IPC contract

The frontend and backend communicate over Tauri's IPC. Every command is defined in Rust
under `src-tauri/src/commands/` and mirrored in TypeScript in `src/lib/api.ts`. All
commands return either their result or an `AriadneError`.

## General rules

- Arguments are passed as a flat object (Tauri deserializes each argument separately).
- The frontend generates a `query_id` for `run_query` so it can cancel a query while it
  runs; `fetch_page` / `cancel_query` / `force_kill_query` refer back to it.
- Reads that aren't part of the schema cache (relation details, roles, activity, stats)
  are on-demand and never cached.

## Error shape

```ts
AriadneError = {
  kind: "connection_failed" | "connection_lost" | "query_error"
      | "query_cancelled" | "timeout" | "parse_error" | "keyring_error" | "internal";
  message: string;
  detail?: string;      // collapsible technical detail
  sqlstate?: string;    // e.g. "42P01"
  position?: number;    // 1-based offset in the SQL, for a Monaco marker
  hint?: string;        // Postgres HINT
}
```

## Commands

### Profiles & connections

| Command | Request → Response |
| --- | --- |
| `list_profiles` | `{}` → `ConnectionProfile[]` |
| `save_profile` | `{ profile, password? }` → `ConnectionProfile` (password goes to the OS keychain, never to disk) |
| `delete_profile` | `{ profileId }` → `void` |
| `test_connection` | `{ profile, password? }` → `{ server_version, latency_ms }` (doesn't persist) |
| `connect` | `{ profileId, databaseOverride? }` → `ConnectionInfo` (schema cache fills in the background) |
| `disconnect` | `{ connectionId }` → `void` (cancels queries, closes cursors/transactions, closes the pool) |
| `list_databases` | `{ connectionId }` → `{ name, is_current }[]` (connectable, non-template databases) |

### Schema

| Command | Request → Response |
| --- | --- |
| `get_schema_snapshot` | `{ connectionId }` → `SchemaSnapshot` (the lightweight tree/search view) |
| `refresh_schema` | `{ connectionId }` → `void` (rebuilds the cache in the background; start/finish via events) |
| `get_relation_details` | `{ connectionId, schema, name }` → `{ indexes[], triggers[], size_bytes, live_rows }` |
| `get_function_source` | `{ connectionId, fnOid }` → `string` (`CREATE OR REPLACE FUNCTION …`) |

### Query execution

| Command | Request → Response |
| --- | --- |
| `run_query` | `{ connectionId, sql, tabId, queryId, confirmed?, maxRowsPerPage? }` → `RunResult` |
| `fetch_page` | `{ connectionId, queryId }` → `Page` (next page from the open cursor) |
| `cancel_query` | `{ connectionId, queryId }` → `void` (`pg_cancel_backend`) |
| `force_kill_query` | `{ connectionId, queryId }` → `bool` (`pg_terminate_backend`; whether a backend was signaled) |
| `close_result` | `{ connectionId, tabId }` → `void` (releases the cursor/tx on tab close) |

`RunResult` carries the statements, the transaction status, an optional
`needs_confirmation` (the destructive guard), and — on a partial failure — the error and
the failed statement index. A row-returning statement produces
`{ kind: "rows", columns, first_page, truncated_cells }`; DML produces
`{ kind: "affected", command, row_count }`; anything else `{ kind: "empty", command }`.

### Completion

| Command | Request → Response |
| --- | --- |
| `get_completions` | `{ connectionId, sql, cursorOffset }` → `CompletionResult` |
| `get_object_info` | `{ connectionId, sql, cursorOffset }` → `ObjectInfo \| null` (Alt+F1) |
| `get_signature_help` | `{ connectionId, sql, cursorOffset }` → `SignatureHelp \| null` |

All three are computed from the cache with no DB round-trip.

### Roles, activity & stats

| Command | Request → Response |
| --- | --- |
| `list_roles` | `{ connectionId }` → `RoleInfo[]` (`pg_roles`, read-only) |
| `list_activity` | `{ connectionId }` → `ActivityRow[]` (`pg_stat_activity` client backends) |
| `signal_backend` | `{ connectionId, pid, mode: "cancel" \| "terminate" }` → `bool` |
| `db_stats` | `{ connectionId }` → `{ active_connections, max_connections?, cache_hit_ratio?, db_size_bytes? }` |

`db_stats` deliberately has no CPU/RAM: host metrics can't be read with plain SQL.

### Data editing (data-write)

| Command | Request → Response |
| --- | --- |
| `get_primary_key` | `{ connectionId, schema, table }` → `string[]` (PK columns in order; empty if none) |
| `update_cell` | `{ connectionId, schema, table, pk: {column,value}[], column, newValue }` → `{ updated }` |

`update_cell` runs `BEGIN; UPDATE "s"."t" SET "col" = $1::<type> WHERE "pk"::text = $n …;`
and commits only if exactly one row matched, otherwise it rolls back and errors. The new
value is bound as text and cast to the column's type; `newValue: null` sets `NULL`. On a
read-only profile the connection is read-only, so the `UPDATE` is rejected by Postgres.

### Files

| Command | Request → Response |
| --- | --- |
| `read_text_file` | `{ path }` → `string` |
| `write_text_file` | `{ path, content }` → `void` |

The native file dialog is opened on the frontend (`@tauri-apps/plugin-dialog`); these
commands only read/write the path the user picked. The broad filesystem plugin
permission is deliberately not granted.

## Events (backend → frontend)

| Event | Payload | Meaning |
| --- | --- | --- |
| `schema:refresh_started` | `{ connection_id }` | A cache refresh began. |
| `schema:refreshed` | `{ connection_id }` | The cache was rebuilt; reload the snapshot. |
| `connection:lost` | `{ connection_id, error }` | A connection died; the frontend releases its tabs' transaction state. |
| `result:frozen` | `{ connection_id, tab_id }` | An idle cursor was closed server-side; the grid shows a "re-run to continue paging" banner. |
