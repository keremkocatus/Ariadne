# Backend (Rust)

The backend owns all database state — connections, cursors, transactions, and the
schema cache — and exposes a thin, typed IPC surface to the frontend. It is written to
be independent of Tauri where it matters: the `db`, `cache`, `complete`, and `profiles`
modules are plain Rust and are unit-tested without a UI.

## Module map

| Module | Responsibility |
| --- | --- |
| `lib.rs` | Tauri builder, command registration, the idle-cursor sweeper. `main.rs` only calls `run()`. |
| `commands/` | Thin IPC handlers: deserialize → call a module → serialize. |
| `db/` | The execution engine and its supporting pieces. |
| `cache/` | The immutable schema cache, catalog queries, and the frontend snapshot. |
| `complete/` | The completion engine (lexer, context analysis, candidate generation). |
| `profiles/` | Connection profiles on disk + passwords in the OS keychain. |
| `state.rs` | Shared `AppState`: the map of active connections. |
| `error.rs` | The single `AriadneError` type crossing the IPC boundary. |
| `logging.rs` | Console + rolling-file logging with redaction rules. |

## Execution engine (`db/`)

- **`pool.rs`** builds a `PgPool` from a profile. Every new connection gets
  `application_name = 'ariadne'`, an optional `statement_timeout`, and
  `default_transaction_read_only = on` for read-only profiles. Pool size defaults
  to 3 and is a per-profile setting (clamped to 1–10).
- **`classify.rs`** classifies a statement via the `pg_query` AST: does it return rows,
  is it a destructive DML without a `WHERE` clause, does it transition transaction
  state. Pure functions.
- **`rows.rs`** turns `PgRow`s into text-format cells. Values are read as Postgres text
  (to preserve numeric/bigint precision and render bytea/timestamps faithfully). Cells
  over 8 KB are truncated with a flag.
- **`exec.rs`** is the heart. It holds per-tab state (a pinned connection, transaction
  status, and an optional open cursor) and implements:
  - **Cursored execution.** The last row-returning statement in a script is run through
    `DECLARE … CURSOR` and the first page is `FETCH`ed. If there's no user transaction,
    an internal `BEGIN READ ONLY` is opened to keep the cursor alive and is committed
    when the cursor closes. An exhausted cursor (result fully fetched) is closed
    eagerly and its pinned connection returns to the pool — only results with pending
    pages or open transactions hold a connection.
  - **Pagination.** `fetch_page` pulls the next page from the open cursor.
  - **Cancellation** via `pg_cancel_backend` from an independent pool connection, and
    **force-kill** via `pg_terminate_backend`.
  - **Partial results.** If a statement in a multi-statement script fails, the results
    accumulated so far are kept and the error is returned alongside them (psql-like);
    remaining statements don't run.
  - **Idle-cursor sweeping.** A background task closes internal-transaction cursors that
    have been idle too long (so they don't hold back vacuum) and emits `result:frozen`.

### Connect directly to Postgres — not through a transaction pooler

Ariadne assumes each logical connection maps to one Postgres backend for its whole
lifetime, like most interactive SQL tools. Connect it to a **direct** (or
session-pooled) endpoint. Do **not** point it at a transaction-pooling endpoint
(PgBouncer/Supavisor in `transaction` mode — e.g. Supabase's port 6543; use 5432
instead). Behind a transaction pooler:

- **Paged results break.** Cursored execution keeps a `DECLARE CURSOR` inside an open
  transaction while a result is paged; poolers commonly reclaim such backends
  (`idle_transaction_timeout`), which surfaces as a sudden "cursor does not exist" /
  connection-lost error that looks like an Ariadne bug.
- **Read-only enforcement can silently degrade.** `default_transaction_read_only = on`
  is set once per physical connection; a pooler can remap the session to a different
  backend between transactions where that `SET` never happened — no error, the
  read-only profile just stops being enforced server-side.
- **Prepared statements and pid-based cancel** may also misbehave (sqlx prepares
  statements; cancellation targets a `pg_backend_pid` that the pooler may have
  reassigned).

This is the same guidance most Postgres providers give for GUI tools and migrations.
If an app tier needs transaction pooling for scale, give interactive tools like
Ariadne a separate direct endpoint rather than routing them through the pooler.

### Zero-row column names

A subtlety worth noting: sqlx exposes column metadata only through a returned row, so a
`SELECT` that returns zero rows would otherwise have no column names. When that happens,
`exec.rs` recovers the real headers with an extended-protocol `describe` (Parse +
Describe, no Execute — side-effect free), so the grid renders with headers and an empty
body instead of a misleading placeholder.

## Schema cache (`cache/`)

- **`catalog.rs`** fetches everything from `pg_catalog` (not `information_schema`) in
  four parallel queries: schemas, tables + columns, constraints (PK/FK), and functions.
  System schemas are listed but their objects are not fetched, keeping the cache lean.
- **`mod.rs`** builds an immutable `SchemaCache`: the tables/functions plus fast lookup
  indexes (`schema.name → id`, `name → ids`, and a bidirectional FK adjacency graph used
  for JOIN completion).
- **`snapshot.rs`** produces the lightweight, deterministically ordered `SchemaSnapshot`
  the frontend tree and search consume.

A refresh builds a new `SchemaCache` and stores it via `ArcSwap`, so completion readers
never wait on a lock. DDL run from within Ariadne triggers a debounced background
refresh automatically.

## Completion engine (`complete/`)

A pure module that reads the cache and never touches the database (target: under 10 ms).

- **`lexer.rs`** wraps `pg_query::scan` into an offset-tagged token stream — the real
  Postgres scanner, so unfinished SQL still tokenizes robustly.
- **`context.rs`** infers a `CompletionContext` from the tokens around the cursor: the
  clause (SELECT list, FROM, JOIN, WHERE, …), the relations in scope (including CTEs and
  correlated outer aliases), and the prefix/qualifier being typed.
- **`candidates.rs`** generates and ranks suggestions per clause. The standout is
  FK-driven `JOIN`: after `FROM users u JOIN`, it offers `orders o ON o.user_id = u.id`
  from the FK graph.
- **`mod.rs`** also serves Alt+F1 object info (resolving an identifier or alias to a
  table) and signature help for function calls.

## Errors, profiles, logging

- **`AriadneError`** is the one serializable error type. sqlx errors lift into it via
  `?`; for Postgres errors it extracts SQLSTATE, the message, and the position/hint/detail
  used to place a Monaco marker.
- **`profiles/`** stores connection profiles as JSON (without passwords) in the app config
  directory; passwords go to the OS keychain via `keyring`.
- **`logging.rs`** writes to the console and a daily rolling file. Redaction rules: SQL
  text only at `debug`, durations/row counts at `info`, and passwords/connection strings
  at no level.

## Tests

Unit tests cover the pure logic (classification, function-argument parsing, completion
"golden" cases, error-position math, SQL construction for cell edits). Live-DB
integration tests are marked `#[ignore]` and require `ARIADNE_DATABASE_URL`; they use
read-only queries and session-local `TEMP` tables only. Run them with
`cargo test -- --ignored`.
