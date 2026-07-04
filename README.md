# Ariadne

A local-first PostgreSQL IDE built with [Tauri](https://tauri.app) (Rust) and
React + TypeScript. Ariadne is designed for large, real-world databases: schema-aware
autocomplete comes from an in-process cache, results from 200M-row tables are paged
with server-side cursors rather than pulled into memory, and every query is
cancellable.

> **Status: early / pre-release (v0.0.2).** The core works and is used day to day, but
> the app has not been through a formal release or wide testing yet. Expect rough
> edges.

## Highlights

- **Local-first.** No telemetry, no CDN calls, no cloud. The schema is cached in
  process; the Monaco editor and all assets are bundled.
- **Schema-aware autocomplete.** A Rust completion engine (built on the real Postgres
  parser, `pg_query`) suggests tables, columns, and functions with clause awareness,
  FK-driven `JOIN … ON` completions, signature help, and Alt+F1 object info.
- **Built for big tables.** Queries execute through a server-side cursor and page on
  scroll; results are never fully materialized. Every query can be cancelled, and a
  stuck backend can be force-killed.
- **Safe by default.** A destructive guard confirms `UPDATE`/`DELETE`/`TRUNCATE`
  without a `WHERE` clause (with an estimated row count). Read-only connection profiles
  set `default_transaction_read_only=on`. Cell edits run a single-row-guarded `UPDATE`.
- **Multi-connection.** Connect to several databases at once; each tab is permanently
  bound to its own connection. Switch databases on the same server from the context bar.
- **A real result grid.** Virtualized rendering, rich copy (CSV/TSV/JSON/Markdown),
  resizable columns, and a cell view/edit popup.
- **Ergonomics.** Command palette (Ctrl+K), SQL formatter, `.sql` open/save, a server
  activity view (`pg_stat_activity` with cancel/terminate), and a DB stats strip.

## Tech stack

- **Backend:** Rust, [Tauri v2](https://tauri.app), [sqlx](https://github.com/launchbadge/sqlx)
  (Postgres), [pg_query](https://github.com/pganalyze/pg_query.rs) (the Postgres parser),
  `keyring` (OS keychain), `tracing`.
- **Frontend:** React + TypeScript, [Vite](https://vitejs.dev), Tailwind CSS v4,
  [Zustand](https://github.com/pmndrs/zustand), [Monaco](https://github.com/microsoft/monaco-editor),
  [react-arborist](https://github.com/brimdata/react-arborist) (tree),
  [TanStack Virtual](https://tanstack.com/virtual) (grid), [cmdk](https://github.com/pacocoursey/cmdk),
  Radix UI, [sql-formatter](https://github.com/sql-formatter-org/sql-formatter).

## Documentation

- [docs/architecture.md](docs/architecture.md) — the big picture and design principles.
- [docs/backend.md](docs/backend.md) — the Rust backend: modules, execution model,
  schema cache, completion engine.
- [docs/frontend.md](docs/frontend.md) — the React frontend: stores, components,
  Monaco integration.
- [docs/ipc-api.md](docs/ipc-api.md) — the IPC contract (commands, shapes, events).
- [docs/release.md](docs/release.md) — cutting a release, signing, and the in-app updater.

## Building from source

### Prerequisites

- **Node.js** 20+ and **npm**.
- **Rust** (stable) with the platform's C toolchain.
- **LLVM / libclang** — `pg_query`'s build runs `bindgen`, which needs `libclang`. On
  Windows, install LLVM (e.g. `winget install LLVM.LLVM`) and set
  `LIBCLANG_PATH=C:\Program Files\LLVM\bin`. On macOS/Linux, install `llvm`/`clang`
  via your package manager.
- Platform Tauri prerequisites — see the
  [Tauri setup guide](https://tauri.app/start/prerequisites/).

### Run in development

```sh
npm install
npm run tauri dev
```

The database is chosen inside the app via the connection dialog; the password is stored
in the OS keychain. No environment variables are required.

### Build a release bundle

```sh
npm run tauri build
```

## Development

- **Frontend checks:** `npm run build` (runs `tsc` then `vite build`).
- **Backend checks:** from `src-tauri/`:
  `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.
- **Live-DB tests:** `ARIADNE_DATABASE_URL=… cargo test -- --ignored`. These use
  read-only queries and session-local `TEMP` tables only — they never touch your data.

## License

MIT — see [LICENSE](LICENSE).
