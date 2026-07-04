import { create, type StoreApi } from "zustand";
import * as api from "@/lib/api";
import type {
  AriadneError,
  ColumnMeta,
  Confirmation,
  StatementResult,
  TxStatus,
} from "@/lib/api";
import { useConnectionStore } from "./connectionStore";

// Tab başına UI'da tutulan maks satır (design 05 §2 — kazara SELECT * sigortası).
const MAX_ROWS = 100_000;

export interface QueryState {
  queryId?: string;
  connectionId?: string;
  columns: ColumnMeta[];
  rows: (string | null)[][];
  hasMore: boolean;
  fetchedTotal: number;
  elapsedMs: number;
  extra: StatementResult[]; // rows olmayan sonuçlar (affected/empty)
  running: boolean;
  fetchingMore: boolean;
  error?: AriadneError | null;
  txStatus: TxStatus;
  needsConfirmation?: Confirmation | null;
  capped: boolean;
}

export interface Tab {
  id: string;
  title: string;
  sql: string;
  query: QueryState;
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
  };
}

function newTab(sql = "SELECT version();"): Tab {
  return { id: crypto.randomUUID(), title: "Query", sql, query: emptyQuery() };
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /// Açık tx'li olduğu için kapatılması onay bekleyen tab (design 05 §7 / 11 §H4).
  closeRequest: string | null;

  addTab: (sql?: string) => string;
  closeTab: (id: string) => void;
  resolveClose: (action: "commit" | "rollback" | "cancel") => Promise<void>;
  setActive: (id: string) => void;
  setSql: (id: string, sql: string) => void;

  run: (id: string, confirmed?: boolean) => Promise<void>;
  fetchMore: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  txControl: (id: string, sql: "COMMIT" | "ROLLBACK") => Promise<void>;
  dismissConfirmation: (id: string) => void;

  active: () => Tab | null;
}

/// Tab'ı gerçekten kapatır: backend cursor/tx kaynağını bırakır, tab'ı listeden siler.
function rawCloseTab(
  set: StoreApi<TabsState>["setState"],
  get: () => TabsState,
  id: string,
) {
  const tab = get().tabs.find((t) => t.id === id);
  const connId = tab?.query.connectionId;
  if (connId) void api.closeResult(connId, id).catch(() => {});
  set((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id);
    const activeTabId =
      s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
    return { tabs, activeTabId };
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

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  closeRequest: null,

  addTab(sql) {
    const t = newTab(sql);
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id }));
    return t.id;
  },

  closeTab(id) {
    // Açık tx varsa doğrudan kapatma — Commit/Rollback/Cancel onayı iste (design 05 §7).
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && tab.query.txStatus !== "idle") {
      set({ closeRequest: id });
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
    rawCloseTab(set, get, id);
  },

  setActive(id) {
    set({ activeTabId: id });
  },

  setSql(id, sql) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sql } : t)) }));
  },

  async run(id, confirmed) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.query.running) return;
    const connId = useConnectionStore.getState().activeConnectionId;
    if (!connId) {
      patchQuery(set, id, { error: { kind: "connection_failed", message: "Connect to a database first" } });
      return;
    }
    const queryId = crypto.randomUUID();
    patchQuery(set, id, {
      running: true,
      error: null,
      needsConfirmation: null,
      connectionId: connId,
      queryId,
    });
    try {
      const res = await api.runQuery(connId, tab.sql, id, queryId, confirmed);
      if (res.needs_confirmation) {
        patchQuery(set, id, { running: false, needsConfirmation: res.needs_confirmation });
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
        // Kısmi sonuç: statements + (varsa) hata birlikte gösterilir (design 11 §H2).
        error: res.error ?? null,
        capped: false,
      });
    } catch (e) {
      patchQuery(set, id, {
        running: false,
        error: api.isAriadneError(e) ? e : { kind: "internal", message: String(e) },
      });
    }
  },

  async fetchMore(id) {
    const tab = get().tabs.find((t) => t.id === id);
    const q = tab?.query;
    if (!tab || !q || !q.hasMore || q.fetchingMore || q.capped || !q.connectionId || !q.queryId)
      return;
    patchQuery(set, id, { fetchingMore: true });
    try {
      const page = await api.fetchPage(q.connectionId, q.queryId);
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
    const q = get().tabs.find((t) => t.id === id)?.query;
    if (q?.connectionId && q.queryId) await api.cancelQuery(q.connectionId, q.queryId).catch(() => {});
  },

  async txControl(id, sql) {
    const tab = get().tabs.find((t) => t.id === id);
    const connId = tab?.query.connectionId ?? useConnectionStore.getState().activeConnectionId;
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
    patchQuery(set, id, { needsConfirmation: null });
  },

  active() {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },
}));
