# Architecture

Ariadne is a desktop application: a Rust backend and a React/TypeScript frontend that
communicate over Tauri's IPC. This document explains the shape of the system and the
design decisions behind it. See [backend.md](backend.md) and [frontend.md](frontend.md)
for detail, and [ipc-api.md](ipc-api.md) for the exact contract.

## The two halves

```
┌─────────────────────────────────────────┐
│  Frontend (React + TypeScript, Vite)     │
│  Monaco editor · result grid · explorer  │
│  Zustand stores · Tauri invoke()         │
└───────────────────┬─────────────────────┘
                    │  IPC (commands + events)
┌───────────────────┴─────────────────────┐
│  Backend (Rust, Tauri)                   │
│  commands → db / cache / complete        │
│  sqlx (Postgres) · pg_query · keyring    │
└───────────────────┬─────────────────────┘
                    │  Postgres wire protocol
              ┌─────┴─────┐
              │ PostgreSQL │
              └───────────┘
```

The frontend never talks to Postgres directly. It calls typed IPC commands; the
backend owns every connection, cursor, and transaction. The frontend also subscribes to
a handful of backend-emitted events (schema refresh, connection lost, result frozen).

## Design principles

**Local-first.** Everything runs on the user's machine. There is no telemetry, no
analytics, and no network access beyond the database connections the user configures.
The Monaco editor and all assets are bundled — nothing is fetched from a CDN at runtime.

**The schema cache is the performance core.** Autocomplete and the object explorer read
from an in-process, immutable snapshot of the database catalog, never from a live query.
The live database is queried only on connect and on explicit/automatic refresh. A
refresh builds a brand-new cache and swaps it in atomically (via `ArcSwap`), so readers
never block. This is what makes completion feel instant on databases with thousands of
tables.

**Never materialize large results.** The target is tables with 200M+ rows. A
row-returning query is executed through a server-side cursor inside a transaction; the
first page is fetched immediately and further pages are fetched on scroll. Results are
capped in the UI as a safety net. Because the work happens behind a cursor, every query
is cancellable, and a truly stuck backend can be terminated.

**A tab is a session.** Each editor tab maps to one backend session with its own
dedicated connection while a cursor or transaction is open. This makes `BEGIN` /
`COMMIT` / `ROLLBACK` behave exactly as in `psql`: the transaction spans statements in
that tab until the user ends it. A tab is permanently bound to one connection.

**Safe by default.** A destructive guard intercepts `UPDATE`/`DELETE`/`TRUNCATE`
without a `WHERE` clause and asks for confirmation, showing an estimated row count from
the cache. Read-only connection profiles set `default_transaction_read_only=on` on every
pooled connection, so writes are rejected by Postgres itself. Cell edits go through a
transaction that refuses to commit unless exactly one row matched.

**Real Postgres parsing, not heuristics.** Statement classification and the completion
lexer are built on `pg_query` — the actual PostgreSQL parser/scanner compiled to a
library — so half-written and unusual SQL is handled correctly rather than with fragile
regexes.

**Thin IPC, logic in modules.** The Tauri command layer only deserializes arguments,
calls a module, and serializes the result. The real logic lives in modules (`db`,
`cache`, `complete`, `profiles`) that are independent of Tauri and unit-testable without
a UI.

## Data flow: running a query

1. The user presses Ctrl+Enter. The frontend reads the selection (or the whole text)
   and calls `run_query` with a client-generated `query_id`.
2. The backend splits the script into statements, classifies each, and applies the
   destructive guard. If confirmation is needed, it returns early and the frontend shows
   a dialog.
3. The last row-returning statement opens a server-side cursor and fetches the first
   page; other statements run inline. Transaction state is tracked per tab.
4. The result (columns, first page, transaction status, and any partial-failure error)
   comes back and lands in the tab's store. If the query ran DDL, the backend refreshes
   the schema cache in the background and emits an event.
5. On scroll, the frontend calls `fetch_page` with the `query_id` to pull the next page
   from the open cursor.

## Repository layout

```
src/               Frontend (React + TypeScript)
  components/       UI: editor, grid, explorer, layout, dialogs
  stores/           Zustand stores (tabs, connections, schema, ui)
  lib/              api bindings, Monaco providers, helpers
src-tauri/          Backend (Rust)
  src/commands/     Thin IPC command handlers
  src/db/           Execution engine, pooling, classification, row reading
  src/cache/        Schema cache + catalog queries + frontend snapshot
  src/complete/     Completion engine (lexer, context, candidates)
  src/profiles/     Connection profiles + OS keychain
docs/               This documentation
```
