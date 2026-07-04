import { create, type StoreApi } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
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
  /// Idle cursor sunucu tarafında kapatıldı (design 11 §H7) → sonuç donduruldu.
  frozen: boolean;
}

export interface Tab {
  id: string;
  title: string;
  sql: string;
  /// Tab'ın kalıcı olarak bağlı olduğu bağlantı (design 12 §P1-M1). Tab açılırken
  /// o anki aktif bağlantıdan devralınır; sonrasında yalnız `setConnection` ile
  /// (kullanıcı eylemiyle) değişir — çalıştırma anında yeniden okunmaz.
  connectionId: string | null;
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
    frozen: false,
  };
}

function newTab(sql = "", connectionId: string | null = null): Tab {
  return { id: crypto.randomUUID(), title: "Query", sql, connectionId, query: emptyQuery() };
}

/// Tab "pristine" mi: hiç dokunulmamış (boş SQL) + sonuç yok + idle tx + bekleyen
/// sayfa/çalışan sorgu yok (design 15 §P1-U1). Üstten bağlantı seçimi pristine
/// tab'ı yerinde rebind eder (gürültü olmasın); değilse yeni tab açar.
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
  /// Açık tx'li olduğu için kapatılması onay bekleyen tab (design 05 §7 / 11 §H4).
  closeRequest: string | null;

  addTab: (sql?: string, connectionId?: string | null) => string;
  closeTab: (id: string) => void;
  resolveClose: (action: "commit" | "rollback" | "cancel") => Promise<void>;
  setActive: (id: string) => void;
  setSql: (id: string, sql: string) => void;
  /// Tab'ın bağlantısını değiştirir (Ctrl+K "switch connection" veya kapalı
  /// bağlantı bandındaki seçim). Çalışan sorgu ya da açık tx varken reddedilir
  /// (o kaynak eski bağlantıya ait — design 12 §P1-M1 riski).
  setConnection: (id: string, connectionId: string | null) => boolean;
  /// Bağlantı kapandığında o bağlantıya bağlı tab'ların çalışan/tx durumunu
  /// temizler (design 12 §P1-M1 item 5) — bkz. setConnection'daki not.
  releaseTabsForConnection: (connectionId: string) => void;

  run: (id: string, confirmed?: boolean) => Promise<void>;
  fetchMore: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  txControl: (id: string, sql: "COMMIT" | "ROLLBACK") => Promise<void>;
  dismissConfirmation: (id: string) => void;
  markFrozen: (tabId: string) => void;

  active: () => Tab | null;
}

/// Tab'ı gerçekten kapatır: backend cursor/tx kaynağını bırakır, tab'ı listeden siler.
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
    // En az bir tab garantisi (design 12 §P1-M1): boş tab listesi Explorer/
    // StatusBar/CommandPalette'i "no connection" gösterir, canlı bir bağlantı
    // olsa bile — kapanan tab'ın bağlantısıyla devam eden taze bir tab açılır.
    if (tabs.length === 0) tabs = [newTab(undefined, connId ?? null)];
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

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activeTabId: null,
  closeRequest: null,

  addTab(sql, connectionId) {
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId;
    const t = newTab(sql, connId);
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
    // Yalnız tx GERÇEKTEN kapandıysa tab'ı kapat. COMMIT/ROLLBACK başarısızsa
    // (ör. bağlantı koptu) tx hâlâ açık; tab'ı kapatmak "kaydedildi" yanılgısı
    // yaratır → tab açık kalır, hatası bandda görünür (design 11 §H4).
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && tab.query.txStatus === "idle") {
      rawCloseTab(set, get, id);
    }
  },

  setActive(id) {
    set({ activeTabId: id });
  },

  setSql(id, sql) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sql } : t)) }));
  },

  setConnection(id, connectionId) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    // hasMore de reddedilir: açık bir sunucu-taraflı cursor (pagination) varsa o
    // cursor ESKİ bağlantıda yaşıyor — rebind sonrası fetchMore/closeResult yanlış
    // bağlantıya gider (yüksek-efor code review bulgusu). Kullanıcı ya tüm sayfaları
    // çekmeli ya da sorguyu bitirmeli önce.
    if (tab.query.running || tab.query.txStatus !== "idle" || tab.query.hasMore) return false;
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, connectionId } : t)) }));
    return true;
  },

  releaseTabsForConnection(connectionId) {
    // Bağlantı kapandığında (disconnect ya da connection:lost) o bağlantıya bağlı
    // tab'ların sunucu-taraflı durumu (tx/cursor) da öldü — aksi halde txStatus
    // hiç "idle"a dönmediği için setConnection/closeTab sonsuza dek reddeder
    // (yüksek-efor code review: "stuck tab" bulgusu). Sonuçlar salt-okunur kalır.
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.connectionId === connectionId
          ? { ...t, query: { ...t.query, running: false, txStatus: "idle", hasMore: false, fetchingMore: false } }
          : t,
      ),
    }));
  },

  async run(id, confirmed) {
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
    const queryId = crypto.randomUUID();
    patchQuery(set, id, {
      running: true,
      error: null,
      needsConfirmation: null,
      frozen: false,
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
      // Transport-seviyesi hata (invoke reddi, ör. connection_lost): geçerli sonuç
      // yok → eski grid'i temizle ki hata bandı bayat satırların üstünde durmasın.
      // (SQL hataları buraya DÜŞMEZ; onlar Ok(RunResult{error}) ile success dalından
      //  geçer ve kısmi sonuçları korur — design 11 §H2.)
      patchQuery(set, id, {
        running: false,
        columns: [],
        rows: [],
        extra: [],
        hasMore: false,
        fetchedTotal: 0,
        error: api.isAriadneError(e) ? e : { kind: "internal", message: String(e) },
      });
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
    patchQuery(set, id, { needsConfirmation: null });
  },

  markFrozen(tabId) {
    // Cursor sunucuda kapandı: yeni sayfa çekilemez, "yeniden çalıştır" bandı gösterilir.
    patchQuery(set, tabId, { frozen: true, hasMore: false });
  },

  active() {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },
    }),
    {
      // Son açık tab'ların SQL'i persist edilir; sonuçlar ASLA (design 07 §1 / 11 §H8).
      // connectionId de persist edilir — uygulama yeniden açıldığında bağlantılar
      // boş başlar, bu yüzden restore edilen tab'lar "connection closed" bandına
      // düşer (aynı mekanizma, ekstra kod yok — design 12 §P1-M1).
      name: "ariadne-tabs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({ id: t.id, title: t.title, sql: t.sql, connectionId: t.connectionId })),
        activeTabId: s.activeTabId,
      }),
      // Diskten dönen tab'lara taze boş query iliştir (çalıştırma durumu kalıcı değil).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as {
          tabs?: { id: string; title: string; sql: string; connectionId?: string | null }[];
          activeTabId?: string | null;
        };
        const tabs: Tab[] = (p.tabs ?? []).map((t) => ({
          ...t,
          connectionId: t.connectionId ?? null,
          query: emptyQuery(),
        }));
        return {
          ...current,
          tabs,
          activeTabId: tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId! : (tabs[0]?.id ?? null),
        };
      },
    },
  ),
);
