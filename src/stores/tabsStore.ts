import { create, type StoreApi } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { toast } from "sonner";
import * as api from "@/lib/api";
import type {
  AriadneError,
  ColumnMeta,
  Confirmation,
  ObjectInfo,
  StatementResult,
  TxStatus,
} from "@/lib/api";
import { useConnectionStore } from "./connectionStore";
import { useUiStore } from "./uiStore";
import { useHistoryStore } from "./historyStore";

// Max rows held per tab in the UI (a safety net against an accidental SELECT *).
const MAX_ROWS = 100_000;

export interface QueryState {
  queryId?: string;
  columns: ColumnMeta[];
  rows: (string | null)[][];
  hasMore: boolean;
  fetchedTotal: number;
  elapsedMs: number;
  extra: StatementResult[]; // non-rows results (affected/empty)
  running: boolean;
  fetchingMore: boolean;
  error?: AriadneError | null;
  txStatus: TxStatus;
  needsConfirmation?: Confirmation | null;
  capped: boolean;
  /// The idle cursor was closed server-side → the result is frozen.
  frozen: boolean;
  /// Whether the last run executed a selection — drives the "ran selection" badge.
  ranSelection: boolean;
  /// The last run's selection start offset; added to `error.position` when placing
  /// the error marker in the full text (0 for a full-text run).
  selectionOffset: number;
  /// The error marker went stale when the SQL was edited → the editor marker is
  /// hidden but the error banner stays until the next run.
  markerStale: boolean;
  /// The opts of the run awaiting confirmation: after confirm it must run with the
  /// SAME selection/SQL — otherwise a confirmed selection would run the whole text.
  pendingRun: RunOpts | null;
  /// Alt+F1 object info is shown as an overlay in the results area. Closing it (null)
  /// restores the query result underneath — the result is NOT overwritten.
  infoResult: ObjectInfo | null;
  /// Marked when a query finishes in a background (non-active) tab: a dot is shown on
  /// the TabBar title; setActive clears it once the tab is seen.
  finishedUnseen: boolean;
}

/// Options for run(). If `sql` is given, a selection is run.
export interface RunOpts {
  confirmed?: boolean;
  sql?: string;
  selectionOffset?: number;
}

export interface Tab {
  id: string;
  title: string;
  sql: string;
  /// The connection the tab is permanently bound to. Inherited from the active
  /// connection when the tab opens; afterward it only changes via `setConnection` (a
  /// user action) — it's not re-read at run time.
  connectionId: string | null;
  /// The path if bound to a .sql file; null for an in-memory tab.
  filePath: string | null;
  /// The file's last saved/opened content — dirty = `sql !== savedSql`.
  savedSql: string | null;
  /// Whether the tab was opened from a table (explorer double-click / palette "open
  /// table"). If set, one of the cell-editing conditions is met (the others: PK
  /// resolves + PK values are in the row). null for arbitrary/JOIN queries → view-only.
  sourceTable: { schema: string; name: string } | null;
  query: QueryState;
}

/// Whether a file-backed tab has unsaved changes.
export function isDirty(tab: Tab): boolean {
  return tab.filePath != null && tab.sql !== tab.savedSql;
}

/// Title (file name) from a path — handles Windows/POSIX separators.
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/// The number N of an auto-named "Query N" tab title, or null for a renamed/file tab.
function parseQueryNumber(title: string): number | null {
  const m = /^Query (\d+)$/.exec(title);
  return m ? Number(m[1]) : null;
}

/// Allocates the next "Query N" number: the smallest `n >= from` not already used by an
/// existing tab title. Keeps numbering monotonic within a session (closed numbers aren't
/// reused) while skipping numbers held by tabs restored from a previous session — the
/// counter resets to 1 each launch, so this prevents a new tab from duplicating a
/// restored "Query N".
function allocTabNumber(tabs: Tab[], from: number): { number: number; next: number } {
  const used = new Set(
    tabs.map((t) => parseQueryNumber(t.title)).filter((n): n is number => n != null),
  );
  let n = from;
  while (used.has(n)) n += 1;
  return { number: n, next: n + 1 };
}

function emptyQuery(): QueryState {
  return {
    columns: [],
    rows: [],
    hasMore: false,
    fetchedTotal: 0,
    elapsedMs: 0,
    extra: [],
    running: false,
    fetchingMore: false,
    txStatus: "idle",
    capped: false,
    frozen: false,
    ranSelection: false,
    selectionOffset: 0,
    markerStale: false,
    pendingRun: null,
    infoResult: null,
    finishedUnseen: false,
  };
}

function newTab(
  sql = "",
  connectionId: string | null = null,
  sourceTable: { schema: string; name: string } | null = null,
): Tab {
  return {
    id: crypto.randomUUID(),
    title: "Query",
    sql,
    connectionId,
    filePath: null,
    savedSql: null,
    sourceTable,
    query: emptyQuery(),
  };
}

/// Whether a tab is "pristine": untouched (empty SQL) + no result + idle tx + no
/// pending page/running query. Choosing a connection from the top menu rebinds a
/// pristine tab in place (to avoid noise); otherwise it opens a new tab.
export function isPristine(tab: Tab): boolean {
  const q = tab.query;
  return (
    tab.sql.trim() === "" &&
    !q.running &&
    q.txStatus === "idle" &&
    !q.hasMore &&
    q.columns.length === 0 &&
    q.rows.length === 0 &&
    q.extra.length === 0 &&
    !q.error
  );
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /// A tab awaiting close confirmation because it has an open tx.
  closeRequest: string | null;
  /// A tab awaiting close confirmation because of unsaved file changes. The tx
  /// confirmation comes first; this is an independent next step.
  dirtyCloseRequest: string | null;
  /// The sequence number for the next tab ("Query 1/2/3…"). Doesn't rewind on close
  /// within a session (so names don't collide), but is NOT persisted: it resets to 1
  /// each launch and the allocator skips numbers held by restored tabs.
  nextTabNumber: number;

  addTab: (
    sql?: string,
    connectionId?: string | null,
    sourceTable?: { schema: string; name: string } | null,
  ) => string;
  /// Updates a single cell of the result grid in place: after a successful UPDATE it
  /// refreshes the grid WITHOUT re-running the query.
  patchCell: (id: string, rowIndex: number, colIndex: number, value: string | null) => void;
  closeTab: (id: string) => void;
  resolveClose: (action: "commit" | "rollback" | "cancel") => Promise<void>;
  setActive: (id: string) => void;
  setSql: (id: string, sql: string) => void;
  /// Renames a tab manually (double-click to rename).
  renameTab: (id: string, title: string) => void;
  /// Opens a .sql file in a new tab (content + path + title); returns the id.
  openFileTab: (sql: string, filePath: string, connectionId: string | null) => string;
  /// Records file metadata after a save (path + savedSql + title).
  markSaved: (id: string, filePath: string, savedSql: string) => void;
  /// Force-closes an unsaved file tab (after save/discard).
  forceCloseTab: (id: string) => void;
  /// Cancels the dirty-close confirmation.
  cancelDirtyClose: () => void;
  /// Changes a tab's connection (Ctrl+K "switch connection" or the closed-connection
  /// banner). Rejected while a query is running or a tx is open (that resource belongs
  /// to the old connection).
  setConnection: (id: string, connectionId: string | null) => boolean;
  /// When a connection closes, clears the running/tx state of its tabs — see the note
  /// in setConnection.
  releaseTabsForConnection: (connectionId: string) => void;
  /// After a startup reconnect: moves restored tabs bound to old (dead) connection
  /// ids onto the new connection. Restored tabs are idle (emptyQuery), so they're
  /// reassigned directly.
  remapConnection: (oldConnectionIds: string[], newConnectionId: string) => void;

  run: (id: string, opts?: RunOpts) => Promise<void>;
  fetchMore: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /// Kills a stuck query's backend when cancel has no effect.
  forceKill: (id: string) => Promise<void>;
  txControl: (id: string, sql: "COMMIT" | "ROLLBACK") => Promise<void>;
  dismissConfirmation: (id: string) => void;
  markFrozen: (tabId: string) => void;
  /// Puts Alt+F1 object info into the results-area overlay (null = close).
  setInfoResult: (tabId: string, info: ObjectInfo | null) => void;

  active: () => Tab | null;
}

/// Actually closes a tab: releases the backend cursor/tx resource and removes the tab.
function rawCloseTab(
  set: StoreApi<TabsState>["setState"],
  get: () => TabsState,
  id: string,
) {
  const tab = get().tabs.find((t) => t.id === id);
  const connId = tab?.connectionId;
  if (connId) void api.closeResult(connId, id).catch(() => {});
  set((s) => {
    let tabs = s.tabs.filter((t) => t.id !== id);
    let nextTabNumber = s.nextTabNumber;
    // Guarantee at least one tab: an empty tab list makes Explorer/StatusBar/
    // CommandPalette show "no connection" even with a live connection — so a fresh
    // tab carrying the closed tab's connection is opened.
    if (tabs.length === 0) {
      const alloc = allocTabNumber(tabs, nextTabNumber);
      tabs = [{ ...newTab(undefined, connId ?? null), title: `Query ${alloc.number}` }];
      nextTabNumber = alloc.next;
    }
    const activeTabId =
      s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
    return { tabs, activeTabId, nextTabNumber };
  });
}

function patchQuery(
  set: StoreApi<TabsState>["setState"],
  id: string,
  patch: Partial<QueryState>,
) {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, query: { ...t.query, ...patch } } : t)),
  }));
}

/// Background signal when a run finishes. If the tab isn't active, a title dot; and
/// if it ran long enough (the settings threshold) and the tab is in the background
/// (or the window is hidden), a finish toast. `rowCount` null = duration only.
function signalFinish(
  set: StoreApi<TabsState>["setState"],
  get: () => TabsState,
  id: string,
  elapsedMs: number,
  rowCount: number | null,
  isError: boolean,
) {
  const notActive = get().activeTabId !== id;
  if (notActive) patchQuery(set, id, { finishedUnseen: true });
  const noticeSec = useUiStore.getState().settings.longQueryNoticeSeconds;
  if (noticeSec <= 0 || elapsedMs < noticeSec * 1000) return;
  if (!notActive && !document.hidden) return;
  const title = get().tabs.find((t) => t.id === id)?.title ?? "Query";
  const secs = (elapsedMs / 1000).toFixed(1);
  const action = { label: "Go to tab", onClick: () => get().setActive(id) };
  if (isError) {
    toast.error(`${title} failed — ${secs}s`, { action });
  } else {
    const rows = rowCount != null ? `, ${rowCount.toLocaleString()} rows` : "";
    toast.success(`${title} finished — ${secs}s${rows}`, { action });
  }
}

/// Resolves a connection id to a human label for the history log — the profile name,
/// falling back to the database name.
function connectionLabel(connId: string): string {
  const cs = useConnectionStore.getState();
  const info = cs.connections[connId];
  const profile = info ? cs.profiles.find((p) => p.id === info.profile_id) : null;
  return profile?.name ?? info?.database ?? "—";
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activeTabId: null,
  closeRequest: null,
  dirtyCloseRequest: null,
  nextTabNumber: 1,

  addTab(sql, connectionId, sourceTable) {
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId;
    const { number, next } = allocTabNumber(get().tabs, get().nextTabNumber);
    const t = { ...newTab(sql, connId, sourceTable ?? null), title: `Query ${number}` };
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id, nextTabNumber: next }));
    return t.id;
  },

  patchCell(id, rowIndex, colIndex, value) {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const rows = t.query.rows.map((r, ri) =>
          ri === rowIndex ? r.map((c, ci) => (ci === colIndex ? value : c)) : r,
        );
        return { ...t, query: { ...t.query, rows } };
      }),
    }));
  },

  closeTab(id) {
    // With an open tx, don't close directly — ask for Commit/Rollback/Cancel.
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && tab.query.txStatus !== "idle") {
      set({ closeRequest: id });
      return;
    }
    // With unsaved file changes, ask Save/Don't save/Cancel.
    if (tab && isDirty(tab)) {
      set({ dirtyCloseRequest: id });
      return;
    }
    rawCloseTab(set, get, id);
  },

  async resolveClose(action) {
    const id = get().closeRequest;
    if (!id) return;
    if (action === "cancel") {
      set({ closeRequest: null });
      return;
    }
    await get().txControl(id, action === "commit" ? "COMMIT" : "ROLLBACK");
    set({ closeRequest: null });
    // Only close the tab if the tx actually closed. If COMMIT/ROLLBACK failed (e.g.
    // the connection dropped) the tx is still open; closing the tab would create a
    // false "saved" impression → the tab stays open with its error in the banner.
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && tab.query.txStatus === "idle") {
      rawCloseTab(set, get, id);
    }
  },

  setActive(id) {
    // Viewing a tab clears its background finish dot.
    set((s) => ({
      activeTabId: id,
      tabs: s.tabs.map((t) =>
        t.id === id && t.query.finishedUnseen ? { ...t, query: { ...t.query, finishedUnseen: false } } : t,
      ),
    }));
  },

  setSql(id, sql) {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        // Editing stales the error marker (the offset now points at the wrong place):
        // the marker is hidden, the error banner stays until the next run.
        const needStale = t.query.error?.position != null && !t.query.markerStale;
        // Once the user edits the SQL, the tab may no longer be "SELECT * FROM
        // sourceTable" → clear sourceTable so cell editing can't target the WRONG
        // table. openRelation/openTable set the sql directly via addTab (they don't go
        // through setSql), so the marker is preserved there.
        const sourceTable = t.sourceTable != null ? null : t.sourceTable;
        return {
          ...t,
          sql,
          sourceTable,
          query: needStale ? { ...t.query, markerStale: true } : t.query,
        };
      }),
    }));
  },

  renameTab(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return; // don't allow an empty name
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: trimmed } : t)) }));
  },

  openFileTab(sql, filePath, connectionId) {
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId;
    const t: Tab = { ...newTab(sql, connId), title: baseName(filePath), filePath, savedSql: sql };
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id }));
    return t.id;
  },

  markSaved(id, filePath, savedSql) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, filePath, savedSql, title: baseName(filePath) } : t,
      ),
    }));
  },

  forceCloseTab(id) {
    set((s) => ({ dirtyCloseRequest: s.dirtyCloseRequest === id ? null : s.dirtyCloseRequest }));
    rawCloseTab(set, get, id);
  },

  cancelDirtyClose() {
    set({ dirtyCloseRequest: null });
  },

  setConnection(id, connectionId) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    // hasMore is also rejected: an open server-side pagination cursor lives on the OLD
    // connection — after a rebind, fetchMore/closeResult would go to the wrong
    // connection. The user must fetch all pages or finish the query first.
    if (tab.query.running || tab.query.txStatus !== "idle" || tab.query.hasMore) return false;
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, connectionId } : t)) }));
    return true;
  },

  releaseTabsForConnection(connectionId) {
    // When a connection closes (disconnect or connection:lost), the server-side state
    // (tx/cursor) of its tabs is dead too — otherwise txStatus never returns to "idle"
    // and setConnection/closeTab would reject forever ("stuck tab"). Results stay
    // read-only.
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.connectionId === connectionId
          ? { ...t, query: { ...t.query, running: false, txStatus: "idle", hasMore: false, fetchingMore: false } }
          : t,
      ),
    }));
  },

  remapConnection(oldConnectionIds, newConnectionId) {
    const old = new Set(oldConnectionIds);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.connectionId && old.has(t.connectionId) ? { ...t, connectionId: newConnectionId } : t,
      ),
    }));
  },

  async run(id, opts) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.query.running) return;
    const connId = tab.connectionId;
    if (!connId) {
      patchQuery(set, id, { error: { kind: "connection_failed", message: "Connect to a database first" } });
      return;
    }
    if (!useConnectionStore.getState().connections[connId]) {
      patchQuery(set, id, {
        error: { kind: "connection_lost", message: "Connection closed — switch or reconnect this tab" },
      });
      return;
    }
    // If there's a selection, run only it; the offset is stored to place the marker in
    // the full text. Statement-split/destructive-guard/tx behavior is unchanged — only
    // a shorter SQL goes to the backend.
    const ranSelection = opts?.sql != null;
    const sql = opts?.sql ?? tab.sql;
    const selectionOffset = opts?.selectionOffset ?? 0;
    const queryId = crypto.randomUUID();
    // Wall-clock, for the finish-signal threshold. first_page.elapsed_ms is only the
    // first page's server time; this measurement covers the round-trip.
    const startedAt = performance.now();
    patchQuery(set, id, {
      running: true,
      error: null,
      needsConfirmation: null,
      frozen: false,
      markerStale: false,
      ranSelection,
      selectionOffset,
      pendingRun: null,
      infoResult: null,
      finishedUnseen: false,
      queryId,
    });
    try {
      const res = await api.runQuery(connId, sql, id, queryId, opts?.confirmed);
      if (res.needs_confirmation) {
        // After confirm it must run with the SAME opts (the selection is kept) — hold
        // it in pendingRun. A confirmation is a pause, not a finish → no signal.
        patchQuery(set, id, { running: false, needsConfirmation: res.needs_confirmation, pendingRun: opts ?? null });
        return;
      }
      const rowsStmt = res.statements.find((s) => s.kind === "rows");
      patchQuery(set, id, {
        running: false,
        txStatus: res.tx_status,
        columns: rowsStmt?.kind === "rows" ? rowsStmt.columns : [],
        rows: rowsStmt?.kind === "rows" ? rowsStmt.first_page.rows : [],
        hasMore: rowsStmt?.kind === "rows" ? rowsStmt.first_page.has_more : false,
        fetchedTotal: rowsStmt?.kind === "rows" ? rowsStmt.first_page.fetched_total : 0,
        elapsedMs: rowsStmt?.kind === "rows" ? rowsStmt.first_page.elapsed_ms : 0,
        extra: res.statements.filter((s) => s.kind !== "rows"),
        // Partial result: statements + (if any) the error are shown together.
        error: res.error ?? null,
        capped: false,
      });
      // Row count: SELECT → the first page fetched; DML → total affected; else null.
      const rowCount =
        rowsStmt?.kind === "rows"
          ? rowsStmt.first_page.fetched_total
          : res.statements.some((s) => s.kind === "affected")
            ? res.statements.reduce((n, s) => n + (s.kind === "affected" ? s.row_count : 0), 0)
            : null;
      useHistoryStore.getState().add({
        sql,
        connectionLabel: connectionLabel(connId),
        at: Date.now(),
        status: res.error ? "error" : "ok",
        rowCount,
        elapsedMs: Math.round(performance.now() - startedAt),
        errorMessage: res.error?.message,
      });
      // A user cancel (query_cancelled) is a deliberate action — no finish signal.
      if (res.error?.kind !== "query_cancelled") {
        signalFinish(set, get, id, performance.now() - startedAt, rowCount, res.error != null);
      }
    } catch (e) {
      // A transport-level error (invoke rejected, e.g. connection_lost): there's no
      // valid result → clear the old grid so the error banner doesn't sit on top of
      // stale rows. (SQL errors don't land here; they come through the success path as
      // Ok(RunResult{error}) and preserve partial results.)
      patchQuery(set, id, {
        running: false,
        columns: [],
        rows: [],
        extra: [],
        hasMore: false,
        fetchedTotal: 0,
        error: api.isAriadneError(e) ? e : { kind: "internal", message: String(e) },
      });
      useHistoryStore.getState().add({
        sql,
        connectionLabel: connectionLabel(connId),
        at: Date.now(),
        status: "error",
        rowCount: null,
        elapsedMs: Math.round(performance.now() - startedAt),
        errorMessage: api.isAriadneError(e) ? e.message : String(e),
      });
      signalFinish(set, get, id, performance.now() - startedAt, null, true);
    }
  },

  async fetchMore(id) {
    const tab = get().tabs.find((t) => t.id === id);
    const q = tab?.query;
    if (!tab || !q || !q.hasMore || q.fetchingMore || q.capped || !tab.connectionId || !q.queryId)
      return;
    patchQuery(set, id, { fetchingMore: true });
    try {
      const page = await api.fetchPage(tab.connectionId, q.queryId);
      let rows = [...get().tabs.find((t) => t.id === id)!.query.rows, ...page.rows];
      let capped = false;
      let hasMore = page.has_more;
      if (rows.length > MAX_ROWS) {
        rows = rows.slice(0, MAX_ROWS);
        capped = true;
        hasMore = false;
      }
      patchQuery(set, id, { rows, hasMore, fetchedTotal: rows.length, fetchingMore: false, capped });
    } catch (e) {
      patchQuery(set, id, {
        fetchingMore: false,
        error: api.isAriadneError(e) ? e : { kind: "internal", message: String(e) },
      });
    }
  },

  async cancel(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.connectionId && tab.query.queryId) {
      await api.cancelQuery(tab.connectionId, tab.query.queryId).catch(() => {});
    }
  },

  async forceKill(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.connectionId && tab.query.queryId) {
      await api.forceKillQuery(tab.connectionId, tab.query.queryId).catch(() => {});
    }
  },

  async txControl(id, sql) {
    const tab = get().tabs.find((t) => t.id === id);
    const connId = tab?.connectionId;
    if (!connId) return;
    const queryId = crypto.randomUUID();
    try {
      const res = await api.runQuery(connId, sql, id, queryId, true);
      patchQuery(set, id, { txStatus: res.tx_status });
    } catch (e) {
      patchQuery(set, id, { error: api.isAriadneError(e) ? e : { kind: "internal", message: String(e) } });
    }
  },

  dismissConfirmation(id) {
    patchQuery(set, id, { needsConfirmation: null, pendingRun: null });
  },

  markFrozen(tabId) {
    // The cursor closed server-side: no more pages can be fetched, a "re-run" banner is shown.
    patchQuery(set, tabId, { frozen: true, hasMore: false });
  },

  setInfoResult(tabId, info) {
    patchQuery(set, tabId, { infoResult: info });
  },

  active() {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },
    }),
    {
      // The SQL of the last open tabs is persisted; results NEVER are. connectionId is
      // persisted too — on restart connections start empty, so restored tabs fall into
      // the "connection closed" banner (same mechanism, no extra code).
      name: "ariadne-tabs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          sql: t.sql,
          connectionId: t.connectionId,
          filePath: t.filePath,
          savedSql: t.savedSql,
          sourceTable: t.sourceTable,
        })),
        activeTabId: s.activeTabId,
      }),
      // Attach a fresh empty query to tabs coming back from disk (run state isn't persisted).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as {
          tabs?: {
            id: string;
            title: string;
            sql: string;
            connectionId?: string | null;
            filePath?: string | null;
            savedSql?: string | null;
            sourceTable?: { schema: string; name: string } | null;
          }[];
          activeTabId?: string | null;
        };
        const tabs: Tab[] = (p.tabs ?? []).map((t) => ({
          ...t,
          connectionId: t.connectionId ?? null,
          filePath: t.filePath ?? null,
          savedSql: t.savedSql ?? null,
          sourceTable: t.sourceTable ?? null,
          query: emptyQuery(),
        }));
        return {
          ...current,
          tabs,
          activeTabId: tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId! : (tabs[0]?.id ?? null),
          // Reset the counter each launch; the allocator skips numbers held by restored
          // "Query N" tabs so a new tab never duplicates one.
          nextTabNumber: 1,
        };
      },
    },
  ),
);
