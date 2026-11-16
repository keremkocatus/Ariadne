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
| `uiStore` | Layout state (sidebar, results panel height, active side tab), which dialogs are open, and user settings (theme, logo, snippets). |

A tab carries a permanent `connectionId`; the whole UI (explorer, completion, status
bar, palette) follows the *active tab's* connection rather than a single global one.

## Key components (`src/components/`)

- **`editor/SqlEditor`** — the Monaco editor. Registers commands (Ctrl+Enter/E/F5 to run,
  Alt+F1 for object info, Ctrl+D line-down, Ctrl+K to format) and reports its selection
  to the run path. SQL completion/signature-help come from Monaco *providers* registered
  once at the language level (`lib/monaco/providers.ts`); they read the active connection
  from a setter, since only the active tab's editor is mounted at a time.
- **`grid/ResultGrid`** — a virtualized grid (TanStack Virtual) with column-scoped cell
  selection (shift/ctrl extend a vertical range in one column; Ctrl+C copies it),
  resizable columns, rich copy (CSV/TSV/JSON/Markdown), and infinite scroll that calls
  `fetch_page`. Double-clicking a cell opens **`grid/CellDialog`**.
- **`grid/CellDialog`** — always shows a cell's full value (JSON pretty-printed when
  applicable). Editing is enabled only when the tab was opened from a single table, the
  table's primary key resolves, and the PK values are present in the row; otherwise it's
  a read-only viewer. On save it patches the grid cell in place.
- **`explorer/Explorer`** — the object tree (react-arborist), with a peek panel, group
  filters, pins, and fuzzy search. Single click peeks (debounced), double click opens a
  `SELECT`, right click opens the object menu. Partitions are nested under their parent
  table (shown by their name without the parent's prefix, with the bound next to it), so
  a table with a hundred monthly partitions is one row until expanded. The context bar
  above it switches databases on the same server.
- **`details/RelationDetailsDialog`** — the Details view of one relation: stat tiles
  plus Columns / Indexes / Constraints / Triggers / Partitions / DDL tabs. The DDL is
  reconstructed client-side from the catalog details (`lib/ddl.ts`).
- **`query/ResultArea`** — the results panel. A run with several statements gets a tab
  per result set plus a Messages list (command tag, rows, duration per statement);
  only the last result set is pageable and editable. Object info and execution plans
  cover it as overlays without discarding the result underneath.
- **`query/PlanView`** — renders `EXPLAIN (FORMAT JSON)` as a tree: per-node self time
  (or self cost without ANALYZE), actual vs estimated rows, and a flag where the
  planner's estimate was off by 10× or more.
- **`roles/`** — role management. `RolesPanel` lists roles; `RoleDialogs` create, edit,
  drop and grant. Every statement comes from the pure builders in `lib/roleSql.ts` and
  is shown before it runs.
- **`cron/CronDialog`** — the pg_cron job manager: job list with last outcome, run
  history, create/edit/pause/delete.
- **`snippets/SnippetsDialog`** — ten saved queries bound to Ctrl+1 … Ctrl+0.
- **`brand/`** — the logo marks (`logos.ts`, plain SVG markup) and the `Logo`
  component. The chosen mark is also applied as the window icon at runtime
  (`lib/appIcon.ts`); `docs/logos/` holds the same marks as standalone SVG files.
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
- **Explain.** Ctrl+L shows the estimated plan of the selection (or the whole text);
  Ctrl+Shift+L runs `EXPLAIN ANALYZE`, whose side effects are rolled back.
- **Snippets.** Ctrl+<digit> places the slot's query in the editor and runs just it. If
  an identical copy is already in the document it is reused; otherwise the query goes on
  the cursor's line when that line is blank, or on a new line below it.
- **A run reopens the results panel.** Hiding it with Ctrl+R never hides an outcome.

## IPC bindings (`src/lib/api.ts`)

All backend commands and their request/response shapes are defined here as TypeScript
types and thin wrapper functions. This is the single place `invoke` is called, and it is
kept byte-for-byte compatible with the Rust `serde` types. See
[ipc-api.md](ipc-api.md) for the full contract.

## Events

`lib/events.ts` wires Tauri events to stores in one place: schema refresh start/finish,
`connection:lost` (releases the tab's transaction state so it isn't stuck), and
`result:frozen` (an idle cursor was closed server-side).
