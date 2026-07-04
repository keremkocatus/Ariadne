# Frontend (React + TypeScript)

The frontend is a Vite + React app styled with Tailwind CSS v4. State lives in a few
Zustand stores; components read from them and call typed IPC bindings. It never calls
Tauri's `invoke` directly — everything goes through `src/lib/api.ts`, which mirrors the
Rust types one-to-one.

## Stores (`src/stores/`)

| Store | Owns |
| --- | --- |
| `tabsStore` | The open tabs and their query state (columns, rows, transaction status, errors), plus all the actions: run, fetch more, cancel, tx control, cell patch. Persists tab SQL/metadata (never results). |
| `connectionStore` | Active connections and profiles. Persists only a `lastSession` mapping so restored tabs can offer a reconnect. |
| `schemaStore` | The per-connection schema snapshot, the explorer search/filter, and pins. Persists only pins. |
| `uiStore` | Layout state (sidebar, results panel height, active side tab) and user settings. |

A tab carries a permanent `connectionId`; the whole UI (explorer, completion, status
bar, palette) follows the *active tab's* connection rather than a single global one.

## Key components (`src/components/`)

- **`editor/SqlEditor`** — the Monaco editor. Registers commands (Ctrl+Enter/E/F5 to run,
  Alt+F1 for object info, Ctrl+D line-down, Ctrl+K to format) and reports its selection
  to the run path. SQL completion/signature-help come from Monaco *providers* registered
  once at the language level (`lib/monaco/providers.ts`); they read the active connection
  from a setter, since only the active tab's editor is mounted at a time.
- **`grid/ResultGrid`** — a virtualized grid (TanStack Virtual) with row selection,
  resizable columns, rich copy (CSV/TSV/JSON/Markdown), and infinite scroll that calls
  `fetch_page`. Double-clicking a cell opens **`grid/CellDialog`**.
- **`grid/CellDialog`** — always shows a cell's full value (JSON pretty-printed when
  applicable). Editing is enabled only when the tab was opened from a single table, the
  table's primary key resolves, and the PK values are present in the row; otherwise it's
  a read-only viewer. On save it patches the grid cell in place.
- **`explorer/Explorer`** — the object tree (react-arborist), with a peek panel, group
  filters, pins, and fuzzy search. Single click peeks (debounced), double click opens a
  `SELECT`. The context bar above it switches databases on the same server.
- **`layout/`** — the toolbar, status bar (with the DB stats strip), resize handles, the
  command palette (cmdk), and the settings dialog.
- **`history/QueryHistory`** — a session-only log of executed queries (never persisted);
  clicking an entry reopens its SQL in a new tab. Server activity isn't a panel: the
  toolbar's Activity button opens a new tab, writes the `pg_stat_activity` query, and runs
  it so the result shows in the normal grid.

## Editor semantics worth knowing

- **Run selection.** If there's a non-empty selection, only it runs; the selection's
  offset is tracked so the error marker still lands in the right place in the full text.
- **Cell-edit safety.** A tab opened from a table is marked with `sourceTable`. Editing
  the tab's SQL clears that mark, so a query rewritten to hit a different table can never
  target the original table's `UPDATE`.
- **Partial results.** On a multi-statement failure the results area shows the error
  banner on top and the statements that did run below it.

## IPC bindings (`src/lib/api.ts`)

All backend commands and their request/response shapes are defined here as TypeScript
types and thin wrapper functions. This is the single place `invoke` is called, and it is
kept byte-for-byte compatible with the Rust `serde` types. See
[ipc-api.md](ipc-api.md) for the full contract.

## Events

`lib/events.ts` wires Tauri events to stores in one place: schema refresh start/finish,
`connection:lost` (releases the tab's transaction state so it isn't stuck), and
`result:frozen` (an idle cursor was closed server-side).
