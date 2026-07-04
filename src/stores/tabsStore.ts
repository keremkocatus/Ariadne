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
  /// Son run bir seçim mi koştu (design 15 §P1-U2) — ResultArea "ran selection" rozeti.
  ranSelection: boolean;
  /// Son run'ın seçim başlangıç offset'i; hata marker'ını tam metne konumlarken
  /// `error.position`'a eklenir (tam metin run'ında 0).
  selectionOffset: number;
  /// SQL düzenlenince hata marker'ı bayatladı → editör marker'ı gizlenir, hata
  /// bandı yeni run'a kadar kalır (design 15 §P1-U2 madde 2).
  markerStale: boolean;
  /// Onay bekleyen run'ın opts'u (design 15 §P1-U2 riski): confirm sonrası AYNI
  /// seçim/SQL ile koşulmalı — aksi halde onaylanan seçimken tüm metin koşar.
  pendingRun: RunOpts | null;
  /// Alt+F1 nesne bilgisi sonuç alanında overlay olarak gösterilir (design 15
  /// §P1-U3). Kapatılınca (null) altındaki sorgu sonucu geri gelir — sonuç EZİLMEZ.
  infoResult: ObjectInfo | null;
  /// Arka plandaki (aktif olmayan) tab'da sorgu bittiğinde işaretlenir (design 17
  /// §P1-V1 Ö7): TabBar başlığında nokta gösterilir; setActive görülünce temizler.
  finishedUnseen: boolean;
}

/// run() opsiyonları (design 15 §P1-U2). `sql` verilirse seçim koşulur.
export interface RunOpts {
  confirmed?: boolean;
  sql?: string;
  selectionOffset?: number;
}

export interface Tab {
  id: string;
  title: string;
  sql: string;
  /// Tab'ın kalıcı olarak bağlı olduğu bağlantı (design 12 §P1-M1). Tab açılırken
  /// o anki aktif bağlantıdan devralınır; sonrasında yalnız `setConnection` ile
  /// (kullanıcı eylemiyle) değişir — çalıştırma anında yeniden okunmaz.
  connectionId: string | null;
  /// Bir .sql dosyasına bağlıysa yolu (design 15 §P1-U4); yoksa null (bellek tab'ı).
  filePath: string | null;
  /// Dosyanın son kaydedilen/açılan içeriği — dirty = `sql !== savedSql`.
  savedSql: string | null;
  query: QueryState;
}

/// Dosya-bağlı bir tab'da kaydedilmemiş değişiklik var mı (design 15 §P1-U4).
export function isDirty(tab: Tab): boolean {
  return tab.filePath != null && tab.sql !== tab.savedSql;
}

/// Dosya yolundan başlık (dosya adı) — Windows/POSIX ayraçları.
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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

function newTab(sql = "", connectionId: string | null = null): Tab {
  return {
    id: crypto.randomUUID(),
    title: "Query",
    sql,
    connectionId,
    filePath: null,
    savedSql: null,
    query: emptyQuery(),
  };
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
  /// Kaydedilmemiş dosya değişikliği olduğu için kapatılması onay bekleyen tab
  /// (design 15 §P1-U4). tx onayı önce gelir; bu ondan bağımsız bir sonraki adım.
  dirtyCloseRequest: string | null;
  /// Bir sonraki tab için sıra numarası (design 15 §P1-U2): "Query 1/2/3…". Tab
  /// kapatınca geri sarmaz (isim çakışması olmasın). Persist edilir.
  nextTabNumber: number;

  addTab: (sql?: string, connectionId?: string | null) => string;
  closeTab: (id: string) => void;
  resolveClose: (action: "commit" | "rollback" | "cancel") => Promise<void>;
  setActive: (id: string) => void;
  setSql: (id: string, sql: string) => void;
  /// Tab başlığını elle değiştirir (çift-tık ile yeniden adlandırma, design 15 §P1-U2).
  renameTab: (id: string, title: string) => void;
  /// Bir .sql dosyasını yeni tab'da açar (içerik + yol + başlık), döndürür id.
  openFileTab: (sql: string, filePath: string, connectionId: string | null) => string;
  /// Kaydetme sonrası dosya meta'sını işler (yol + savedSql + başlık).
  markSaved: (id: string, filePath: string, savedSql: string) => void;
  /// Kaydedilmemiş dosya tab'ını zorla kapatır (save/discard sonrası).
  forceCloseTab: (id: string) => void;
  /// Dirty-close onayını iptal eder.
  cancelDirtyClose: () => void;
  /// Tab'ın bağlantısını değiştirir (Ctrl+K "switch connection" veya kapalı
  /// bağlantı bandındaki seçim). Çalışan sorgu ya da açık tx varken reddedilir
  /// (o kaynak eski bağlantıya ait — design 12 §P1-M1 riski).
  setConnection: (id: string, connectionId: string | null) => boolean;
  /// Bağlantı kapandığında o bağlantıya bağlı tab'ların çalışan/tx durumunu
  /// temizler (design 12 §P1-M1 item 5) — bkz. setConnection'daki not.
  releaseTabsForConnection: (connectionId: string) => void;
  /// Açılışta reconnect sonrası: eski (ölü) bağlantı id'lerine bağlı restore
  /// edilmiş tab'ları yeni bağlantıya taşır (design 17 §P1-V3). Restore edilen
  /// tab'lar idle (emptyQuery) olduğundan doğrudan yeniden atanır.
  remapConnection: (oldConnectionIds: string[], newConnectionId: string) => void;

  run: (id: string, opts?: RunOpts) => Promise<void>;
  fetchMore: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /// Donmuş sorgunun backend'ini öldürür (design 17 §P1-V4): cancel etki etmezse.
  forceKill: (id: string) => Promise<void>;
  txControl: (id: string, sql: "COMMIT" | "ROLLBACK") => Promise<void>;
  dismissConfirmation: (id: string) => void;
  markFrozen: (tabId: string) => void;
  /// Alt+F1 nesne bilgisini sonuç alanı overlay'ine koyar (null = kapat).
  setInfoResult: (tabId: string, info: ObjectInfo | null) => void;

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
    let nextTabNumber = s.nextTabNumber;
    // En az bir tab garantisi (design 12 §P1-M1): boş tab listesi Explorer/
    // StatusBar/CommandPalette'i "no connection" gösterir, canlı bir bağlantı
    // olsa bile — kapanan tab'ın bağlantısıyla devam eden taze bir tab açılır.
    if (tabs.length === 0) {
      tabs = [{ ...newTab(undefined, connId ?? null), title: `Query ${nextTabNumber}` }];
      nextTabNumber += 1;
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

/// Bir run bittiğinde arka plan sinyali (design 17 §P1-V1 Ö7). Tab aktif değilse
/// başlık noktası; ayrıca yeterince uzun sürdüyse (ayar eşiği) ve tab arka planda
/// (ya da pencere gizli) ise bitiş toast'ı. `rowCount` null = yalnız süre.
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

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activeTabId: null,
  closeRequest: null,
  dirtyCloseRequest: null,
  nextTabNumber: 1,

  addTab(sql, connectionId) {
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId;
    const t = { ...newTab(sql, connId), title: `Query ${get().nextTabNumber}` };
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id, nextTabNumber: s.nextTabNumber + 1 }));
    return t.id;
  },

  closeTab(id) {
    // Açık tx varsa doğrudan kapatma — Commit/Rollback/Cancel onayı iste (design 05 §7).
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && tab.query.txStatus !== "idle") {
      set({ closeRequest: id });
      return;
    }
    // Kaydedilmemiş dosya değişikliği varsa Save/Don't save/Cancel onayı (design 15 §P1-U4).
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
    // Yalnız tx GERÇEKTEN kapandıysa tab'ı kapat. COMMIT/ROLLBACK başarısızsa
    // (ör. bağlantı koptu) tx hâlâ açık; tab'ı kapatmak "kaydedildi" yanılgısı
    // yaratır → tab açık kalır, hatası bandda görünür (design 11 §H4).
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && tab.query.txStatus === "idle") {
      rawCloseTab(set, get, id);
    }
  },

  setActive(id) {
    // Tab'a bakılınca arka plan bitiş noktası temizlenir (design 17 §P1-V1 Ö7).
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
        // Hata marker'ı düzenlemeyle bayatlar (offset artık yanlış yeri gösterir):
        // marker gizlenir, hata bandı yeni run'a kadar kalır (design 15 §P1-U2).
        const needStale = t.query.error?.position != null && !t.query.markerStale;
        return { ...t, sql, query: needStale ? { ...t.query, markerStale: true } : t.query };
      }),
    }));
  },

  renameTab(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return; // boş ada izin verme
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
    // Seçim varsa yalnız onu koştur (design 15 §P1-U2); offset marker'ı tam metne
    // doğru konumlamak için saklanır. Statement-split/destructive-guard/tx davranışı
    // değişmez — backend'e giden yalnızca daha kısa bir SQL.
    const ranSelection = opts?.sql != null;
    const sql = opts?.sql ?? tab.sql;
    const selectionOffset = opts?.selectionOffset ?? 0;
    const queryId = crypto.randomUUID();
    // Wall-clock: bitiş sinyali eşiği için (design 17 §P1-V1 Ö7). first_page.elapsed_ms
    // yalnız ilk sayfanın sunucu süresi; buradaki ölçüm round-trip'i kapsar.
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
        // Onay sonrası AYNI opts ile koşulmalı (seçim korunur) — pendingRun'da tut.
        // Onay bir duraklamadır, bitiş değil → sinyal yok.
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
        // Kısmi sonuç: statements + (varsa) hata birlikte gösterilir (design 11 §H2).
        error: res.error ?? null,
        capped: false,
      });
      // Satır sayısı: SELECT → çekilen ilk sayfa; DML → etkilenen toplam; yoksa null.
      const rowCount =
        rowsStmt?.kind === "rows"
          ? rowsStmt.first_page.fetched_total
          : res.statements.some((s) => s.kind === "affected")
            ? res.statements.reduce((n, s) => n + (s.kind === "affected" ? s.row_count : 0), 0)
            : null;
      // Kullanıcı iptali (query_cancelled) kendi bilinçli eylemi — bitiş sinyali yok.
      if (res.error?.kind !== "query_cancelled") {
        signalFinish(set, get, id, performance.now() - startedAt, rowCount, res.error != null);
      }
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
    // Cursor sunucuda kapandı: yeni sayfa çekilemez, "yeniden çalıştır" bandı gösterilir.
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
      // Son açık tab'ların SQL'i persist edilir; sonuçlar ASLA (design 07 §1 / 11 §H8).
      // connectionId de persist edilir — uygulama yeniden açıldığında bağlantılar
      // boş başlar, bu yüzden restore edilen tab'lar "connection closed" bandına
      // düşer (aynı mekanizma, ekstra kod yok — design 12 §P1-M1).
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
        })),
        activeTabId: s.activeTabId,
        nextTabNumber: s.nextTabNumber,
      }),
      // Diskten dönen tab'lara taze boş query iliştir (çalıştırma durumu kalıcı değil).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as {
          tabs?: {
            id: string;
            title: string;
            sql: string;
            connectionId?: string | null;
            filePath?: string | null;
            savedSql?: string | null;
          }[];
          activeTabId?: string | null;
          nextTabNumber?: number;
        };
        const tabs: Tab[] = (p.tabs ?? []).map((t) => ({
          ...t,
          connectionId: t.connectionId ?? null,
          filePath: t.filePath ?? null,
          savedSql: t.savedSql ?? null,
          query: emptyQuery(),
        }));
        return {
          ...current,
          tabs,
          activeTabId: tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId! : (tabs[0]?.id ?? null),
          // Sayaç geri sarmasın: en az (mevcut tab sayısı + 1)'den başla.
          nextTabNumber: p.nextTabNumber ?? tabs.length + 1,
        };
      },
    },
  ),
);
