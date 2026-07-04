# 17 — Senaryo-Türevi Öneriler Derin Planı (design/16 Ö1–Ö8 → P1-V milestone'ları)

> Tarih: 2026-07-04. Girdi: design/16'nın Ö1–Ö8 önerileri. Bağlam: design/16 §4
> "Hemen" sınıfını (Ö1/Ö5/Ö7) U-milestone'larına iliştirmeyi öngörmüştü, ama
> **P1-U1…U4 bu ekler olmadan tamamlandı** — Ö'lerin tamamı hâlâ açık. Bu dosya
> onları design/15 tarzında (analiz / plan / kabul / risk) **P1-V1…V4**
> milestone'larına böler. "V" = flow track (senaryo-türevi); U-track'e ve
> design/12'nin M-track'ine dokunmaz. Kod referansları 2026-07-04 itibarıyla
> `p1-u-gui-backlog` dalına göredir (U1…U4 dahil).

## 0. Sıralama ve gerekçe

| Milestone | İçerik | design/16 kaynağı | Neden bu sıra |
|---|---|---|---|
| P1-V1 | Görünürlük paketi: read-only rozeti + boş-durum kartı + bitiş sinyali | Ö5, Ö1, Ö7 | Üçü de frontend-only, backend'siz, tek oturum; her gün hissedilir |
| P1-V2 | Grid zengin kopyalama menüsü | Ö3 | Bağımsız, frontend-only; günlük değeri M5 CSV export'tan yüksek |
| P1-V3 | Açılışta tek-tık reconnect + tab yeniden bağlama | Ö2 | Küçük ama persist şeması değişiyor; V1/V2'den ayrı oturumda temiz |
| P1-V4 | Activity paneli + cancel/kill backend'i | Ö4 (+ design/12 M5 "force kill" kalemi) | Yeni backend komutları; M5'in kill işini **bu milestone üstlenir** (aynı komutun iki tüketicisi tek oturumda) |
| Ertelenen | Ö6 (M4 sonrası), Ö8 (sıkışınca), Ö7'nin OS-bildirimi varyantı | §6 | Bağımlılık/öncelik |

Önerilen genel akış: **U-dalını merge + duman testi → V1 → V2 → V3 → P1-M2 →
P1-M3 → V4 (M5 kalemleriyle birlikte)**. V1–V3 toplam 2–3 küçük oturumdur ve
M2'nin SQLite işine hiçbir bağımlılıkları yoktur; V4 ise M5 ile kaynaşık olduğu
için M-track o noktaya gelince yapılır (prod yangını senaryosu acilleşirse öne
çekilebilir — V4'ün de M2/M3'e bağımlılığı yok). Her milestone yine "çalışan
uygulama bırakır"; gate aynı: rust testleri + clippy `-D warnings` + fmt +
`tsc --noEmit` + vite build.

---

## P1-V1 — Görünürlük paketi (Ö5 + Ö1 + Ö7)

### Analiz: neredeyiz?

- **Ö5 (read-only):** `read_only` alanı profilde var (`profiles/mod.rs:45`),
  backend her pool bağlantısında `SET default_transaction_read_only = on`
  uyguluyor (`db/pool.rs:56`) — **zorlanıyor ama görünmüyor**. `ConnectionInfo`
  read_only taşımıyor; taşımasına gerek de yok: frontend'de
  `connections[id].profile_id → profiles.find(...).read_only` zinciri zaten
  kurulabilir (TabBar `connLabel` aynı deseni kullanıyor, `TabBar.tsx:51`).
  **Backend değişikliği sıfır.** İkinci yüz: RO ihlali PG'den SQLSTATE
  **25006** ("cannot execute … in a read-only transaction") olarak döner;
  bugün ham mesaj gösteriliyor, profil bağlantısı kurulmuyor.
- **Ö1 (boş durum):** `App.tsx:126` aktif tab'ı her zaman `SqlEditor` ile
  render ediyor; bağlantısız + bomboş tab'da kullanıcıya yol gösteren hiçbir
  şey yok. U1'in `isPristine` yardımcıcısı (`tabsStore.ts:117`) "kart ne zaman
  görünsün" sorusunun hazır cevabı. ConnectionMenu Radix dropdown'ı bugün
  kontrolsüz (kendi iç state'i) — karttan programatik açmak için kontrollü
  yapılması gerekir.
- **Ö7 (bitiş sinyali):** `tabsStore.run` sonucu `patchQuery` ile yazıyor;
  tab aktif değilse kullanıcıya hiçbir sinyal yok. Tab-başına state zaten var,
  sonner toast altyapısı projede kurulu. Wall-clock süre run() içinde
  ölçülmüyor (`elapsed_ms` yalnız ilk sayfanın süresi) — eşik için ayrıca
  ölçülmeli.

### Plan

1. **Ö5a — rozet:** `StatusBar`'da bağlantı adının yanına, profil `read_only`
   ise küçük "RO" rozeti (warn tonu, tooltip: "Read-only profile —
   default_transaction_read_only=on"). Aynı rozet `ConnectionMenu`'nün bağlı
   bağlantı satırlarına ve `TabBar` bağlantı etiketinin yanına (tek karakterlik
   muted "RO"; şerit kalabalığı riskine karşı yalnız etiket varken). Ortak
   yardımcı: `connectionStore`'a `isReadOnly(connectionId): boolean` selector'ı
   (profil silinmişse `false` — rozet kaybolur, zarar yok).
2. **Ö5b — hata netliği:** `lib/errors.ts`'e (hata bandının mesaj ürettiği
   yerde) kural: `error.sqlstate === "25006"` ve tab'ın profili `read_only`
   ise hint'e "This profile is read-only (profile setting) — edit the profile
   or use BEGIN READ WRITE deliberately." eklenir. Destructive-guard mesajına
   dokunulmaz (o ayrı katman).
3. **Ö1 — boş durum kartı:** yeni `components/query/EmptyStateCard.tsx`.
   Görünme koşulu: `active && !active.connectionId && isPristine(active)`.
   Editörün ÜZERİNE ortalanmış overlay (`pointer-events-none` sarmalayıcı,
   butonlar `pointer-events-auto`) — editör tıklanabilir/yazılabilir kalır,
   ilk karakterle `isPristine` düşer ve kart kendiliğinden kaybolur. İçerik:
   *Connect…* butonu, *Open .sql* butonu (`openSqlFile()`), altında 4-5
   satırlık kısayol listesi (Ctrl+K palette, Ctrl+Enter run, Ctrl+P şema
   araması, Ctrl+T yeni tab). Veri yok, state yok.
4. **Ö1 altyapısı — kontrollü ConnectionMenu:** `uiStore`'a `connectMenuOpen`
   + `setConnectMenuOpen`; `ConnectionMenu` Radix dropdown'ı `open`/
   `onOpenChange` ile bu state'e bağlanır. Karttaki *Connect…* butonu
   `setConnectMenuOpen(true)` çağırır. (Palette'i açmak da olurdu; menü
   S1 senaryosundaki "keşfedilemeyen küçük buton"un kendisini öğrettiği için
   tercih edildi.)
5. **Ö7a — tab rozeti:** `QueryState`'e `finishedUnseen: boolean` (persist
   edilmez — query state zaten persist dışı). `run()` finally-noktasında
   (başarı VE hata dalında) `get().activeTabId !== id` ise `true` yazılır.
   `setActive(id)` o tab'ın bayrağını temizler. `TabBar` bayraklıysa başlığın
   soluna küçük dolu nokta (dirty `●`'dan farklı: accent/ok tonu; hata ile
   bittiyse danger tonu — `query.error` varlığına bakılır).
6. **Ö7b — toast:** `run()` başında `performance.now()` ile wall-clock ölçümü;
   bitişte süre ≥ eşik (varsayılan **10 sn**, `Settings`'e
   `longQueryNoticeSeconds` alanı — 0 = kapalı) VE tab aktif değil (ya da
   `document.hidden`) ise sonner toast: `"Query 3 finished — 12.4s,
   1,204 rows"` (hata: `toast.error` + kind). Toast'a `action: { label:
   "Go to tab", onClick: setActive(id) }`. Satır sayısı `fetchedTotal` ya da
   affected toplamından; ikisi de yoksa yalnız süre.
7. **Ö7 kapsam sınırı:** OS bildirimi (uygulama minimize iken) bu milestone'da
   YOK — `tauri-plugin-notification` + capability işi; toast yetersiz kalırsa
   §6'daki ertelenen kalem devreye alınır.

### Kabul

- RO profille bağlıyken StatusBar ve bağlantı menüsünde "RO" görünür; UPDATE
  denemesi hata bandında "this profile is read-only" ipucuyla döner.
- Taze açılışta (bağlantısız boş tab) kart görünür; *Connect…* menüyü açar;
  editöre bir karakter yazınca kart kaybolur; connect sonrası (pristine tab
  yerinde bağlanır) kart kaybolur.
- Tab A'da 15 sn'lik sorgu koşarken tab B'ye geçilir: bitince A başlığında
  nokta belirir + toast düşer; toast'taki eylem A'yı aktifleştirir ve nokta
  söner. 2 sn'lik sorguda toast düşmez, yalnız nokta.

### Risk

- Kart overlay'i Monaco'nun tıklama/focus davranışını bozabilir —
  `pointer-events` ayrımı kabul maddesiyle test ediliyor; sorun çıkarsa kart
  editörün üstünde değil yerinde (editör mount edilmeden) render edilir
  (fallback: koşul aynıyken `SqlEditor` yerine kart).
- `finishedUnseen` hızlı ardışık run'larda yarışabilir (tab B'de run bitmeden
  kullanıcı A→B döndü): `setActive` temizlediği için en kötü durumda nokta hiç
  görünmez — kabul edilebilir, kayıp sinyal yanlış sinyalden iyidir.

---

## P1-V2 — Grid zengin kopyalama menüsü (Ö3)

### Analiz

`ResultGrid` bugün hücre/satır **seçimi olmayan** salt-görüntüleme yüzeyi;
footer'daki "Copy CSV/TSV" tüm sonucu kopyalıyor (`ResultGrid.tsx:135`).
Grid TanStack Virtual ile sanallaştırılmış — hücre başına Radix
`ContextMenu.Trigger` sarmak (binlerce trigger) yanlış; **tek** context menu +
`onContextMenu` anında hedef hücreyi data-attribute'tan okumak doğru desen.
Radix context menu U3b'de projeye girdi (Explorer sağ-tık filtreleri) —
bağımlılık hazır. Hücre değerleri zaten string/null (tip bilgisi `ColumnMeta`
düzeyinde) — JSON çıktısında sayılar string kalır, bilinçli kabul (backend'e
gitmeden tip-sadık JSON üretilemez; not düşülür).

### Plan

1. **Seçim modeli (minimal):** `ResultGrid` içinde local state
   `sel: { anchorRow: number; rows: Set<number>; col: number } | null`.
   Hücreye sol tık = o satır seçili + hücre odaklı; Ctrl+tık satır ekle/çıkar;
   Shift+tık aralık. Seçili satırlar `bg-bg-elev` vurgusu, odak hücre ince
   çerçeve. Store'a taşınmaz (sonuç değişince sıfırlanmalı — `rows` referans
   değişiminde `useEffect` ile null'lanır).
2. **Context menu:** grid gövdesi tek `ContextMenu.Root` içine alınır;
   hücre div'lerine `data-row`/`data-col`; `onContextMenu` yakalanınca hedef
   hücre `sel`'e yazılır (seçim dışına sağ-tık = seçimi o hücreye daraltır,
   tarayıcı/IDE deseni). Menü kalemleri:
   - *Copy cell* (null → boş; tooltip'te NULL uyarısı yok, davranış CSV ile tutarlı)
   - *Copy row(s) as CSV* / *as TSV* / *as JSON* / *as Markdown*
   - *Copy column values* (odak kolonun görünen tüm satırlardaki değerleri, satır başına bir)
   - *Copy column name(s)* (seçim varsa seçili kolon; pratikte odak kolon adı + Shift ile tümü: v1'de yalnız odak kolon adı ve "Copy all column names")
   - ayraç — *Copy all as CSV* / *as TSV* (footer butonlarının taşınmış hali; footer'daki ikili KALDIRILIR, tek giriş noktası menü + footer'da tek "Copy" butonu menüyü açar)
3. **Formatlayıcılar:** yeni `lib/clipboard.ts` — saf fonksiyonlar:
   `toCsv(cols, rows, sep)` (mevcut `copy()` buraya taşınır),
   `toJson(cols, rows)` (kolon adı → değer objeleri dizisi; null → `null`),
   `toMarkdown(cols, rows)` (başlık + `---` satırı; hücrede `|` → `\|`,
   newline → boşluk). Hepsi `navigator.clipboard.writeText` + sonner geri
   bildirimi tek `copyToClipboard(label, text)` sarmalayıcısından geçer.
4. **Kapsam sınırı:** kopyalama YALNIZ çekilmiş (`rows` state'indeki)
   satırlar üzerinde çalışır — `hasMore` iken "tüm sonucu" kopyalamak M5
   `export_result_csv`'nin işi; menü altına muted not: "fetched rows only".
   Dikdörtgen (hücre-aralığı) seçim v1'de yok; satır-granülü yeter.

### Kabul

- Bir hücreye sağ-tık → *Copy cell*: yalnız o değer panoda.
- Shift+tık ile 5 satır seçip *Copy rows as Markdown*: PR'a yapıştırılabilir
  düzgün tablo; `|` içeren hücre tabloyu bozmaz.
- *Copy rows as JSON*: kolon adlarıyla obje dizisi; NULL hücre `null`.
- Sonuç yeniden koşulunca eski seçim kaybolur; boş grid'de menü kalemleri disabled.

### Risk

- Tık-seçim mevcut "hücre tooltip'i / metin seçimi" alışkanlığıyla çakışabilir
  (bugün hücre metni mouse ile seçilebiliyor). Önlem: tek tık satır seçimi
  metin seçimini engellemez (`user-select` korunur); sürükle-metin-seçimi
  davranışı değişmez.
- 100k satırlık seçimde Markdown/JSON string üretimi UI thread'i kilitleyebilir.
  Önlem: satır sayısı > 50k ise Markdown/JSON kalemleri disabled (tooltip:
  "use CSV export for large results") — CSV/TSV zaten bugünkü yolla çalışıyor.

---

## P1-V3 — Açılışta tek-tık reconnect + tab yeniden bağlama (Ö2)

### Analiz

**design/16'nın varsayımı yanlış çıktı:** "tab'ların `connectionId` → profil
eşlemesi persist'te var" deniyordu; gerçekte `tabsStore` yalnız ölü
`connectionId` UUID'sini persist ediyor (`tabsStore.ts:481`), `connectionStore`
hiç persist edilmiyor — eşleme oturumla ölüyor. Yani davetten önce **eşlemenin
kalıcılaştırılması** gerekiyor. İkinci içgörü: davetin gerçek değeri toast'ın
kendisi değil, reconnect sonrası eski tab'ların **yeni bağlantıya otomatik
taşınması** — aksi halde kullanıcı yine her tab'da banner'la uğraşır. Açılışta
tüm tab'lar idle olduğundan `setConnection` guard'ları (running/tx/hasMore)
engel değildir; `ConnectionClosedBanner`'ın kullandığı meşru rebind yolu aynen
kullanılır.

### Plan

1. **Eşleme persist'i:** `connectionStore`'a zustand `persist` eklenir —
   yalnız `lastSession: Record<string /*connectionId*/, { profileId: string;
   database: string }>` alanı (`ariadne-connections` anahtarı). `connect()`
   başarısında kayıt düşülür; oturum içinde silinmez (çöp küçük, zararsız);
   `merge` eski kayıtları aynen taşır. `connections`/`activeConnectionId`
   persist edilmeye DEVAM ETMEZ (canlı kaynaklar — mevcut ilke korunur).
2. **Davet mantığı:** yeni `lib/sessionResume.ts` → `offerReconnect()`:
   `loadProfiles()` bittikten sonra App'ten bir kez çağrılır. Restore edilen
   tab'ların `connectionId`'leri `lastSession`'dan (profileId, database)
   çiftlerine çözülür; hâlâ var olan profillere filtrelenir; distinct çift
   başına (en fazla 3 — gürültü sınırı) kalıcı-süreli sonner toast:
   `"Reconnect to raildb?"` + *Reconnect* eylemi. **Otomatik bağlanma YOK**
   (design/16 kararı: VPN'siz açılışta hata seli olmasın).
3. **Reconnect + remap:** eylem `connectProfile(profileId, database)`'i çağırır
   (mevcut orkestrasyon: connect + snapshot + focusConnection); başarı sonrası
   `remapTabs(oldConnIds, newConnId)`: `lastSession`'da o (profil, DB) çiftine
   çözülen TÜM eski id'lere bağlı tab'lar `setConnection(tab.id, newConnId)`
   ile taşınır (idle oldukları için kabul edilir; edilmeyen olursa — teorik —
   banner yolu zaten duruyor). Böylece dünkü çalışma alanı tek tıkla, banner'sız
   geri gelir.
4. **Temizlik:** remap sonrası eski `lastSession` girdileri silinir; ayrıca
   `offerReconnect` çalışırken hiçbir restore-tab eşleşmiyorsa (dosya yeni
   silinmiş profil vs.) sessiz kalır — boş açılışta toast gürültüsü yok.

### Kabul

- raildb'ye bağlı 3 tab'la kapatılan uygulama yeniden açılır: tek toast
  "Reconnect to raildb?"; tıklanınca 3 tab da banner'sız çalışır durumda,
  Explorer dolu, StatusBar doğru DB'yi gösterir.
- Toast yok sayılırsa davranış bugünküyle birebir aynı (banner yolu).
- Profili silinmiş bir bağlantının tab'ları için toast çıkmaz.
- İki farklı profile bağlı tab'larla kapatıldıysa iki ayrı toast; her biri
  yalnız kendi tab'larını taşır.

### Risk

- `lastSession` şişmesi: her connect bir kayıt; budama kuralı — persist'te
  50 kayıttan eskiler (ekleme sırasına göre) atılır. Restore edilen tab'ların
  ihtiyacı zaten son oturumun birkaç kaydı.
- Reconnect sırasında kullanıcı tab'lardan birinde çalışmaya başladıysa
  (`running`/tx) o tab `setConnection` reddine düşer — sessizce atlanır,
  banner'ı görünür kalır; toast eylemi "hepsi ya da hiç" DEĞİL.

---

## P1-V4 — Activity paneli + cancel/kill backend'i (Ö4, design/12 M5 "force kill" dahil)

### Analiz

P2 (prod yangını) personasının kritik akışı: *kim ne koşuyor* → *şunu öldür*.
design/12 M5'in "force kill" kalemi (`kill_query` → `pg_terminate_backend`)
ile aynı mekanizma; design/16 kararı gereği **tek backend, iki tüketici, tek
oturum** — bu milestone M5'in o satırını üstlenir (M5 tablosunda işaretlenecek).
`pg_stat_activity` cluster-genelidir (tüm DB'ler görünür) — P2 tam da bunu
istiyor; `datname` kolonu gösterilir. Yetki gerçeği: superuser olmayan
kullanıcı yalnız KENDİ rolünün backend'lerini öldürebilir (PG 14+:
`pg_signal_backend` üyeliği ile genişler) — hata düzgün yüzeye çıkmalı,
UI yetkiyi tahmin etmeye çalışmamalı. Sidebar U4a'dan beri sekmeli
(`Sidebar.tsx` — Explorer/Roles); üçüncü sekme mimariye hazır oturuyor.
`RolesPanel` (fetch + arama + satır-peek deseni) UI için kopyalanacak şablon.

### Plan

1. **Backend — `commands/activity.rs`:**
   - `list_activity { connection_id } → Vec<ActivityRow>`:
     ```rust
     pub struct ActivityRow {
       pid: i32,
       datname: Option<String>,
       usename: Option<String>,
       application_name: String,
       client_addr: Option<String>,
       state: Option<String>,        // active | idle | idle in transaction | …
       wait_event: Option<String>,   // wait_event_type/wait_event birleşik
       backend_start: String,
       query_start: Option<String>,
       duration_ms: Option<i64>,     // now() - query_start (aktifse)
       query: String,                // ilk 200 karakter (LEFT(query, 200))
       is_self: bool,                // pid = pg_backend_pid() (listeyi çeken conn)
     }
     ```
     Sorgu: `pg_stat_activity WHERE backend_type = 'client backend'`, süre
     `EXTRACT(EPOCH FROM now() - query_start) * 1000`. `application_name =
     'ariadne'` satırları UI'da "this app" rozetiyle işaretlenir (pool tüm
     bağlantılarında app adını zaten set ediyor — `db/pool.rs` yorumu).
   - `signal_backend { connection_id, pid, mode } → bool`;
     `mode: "cancel" | "terminate"` → `pg_cancel_backend($1)` /
     `pg_terminate_backend($1)`. Dönen `false` = "böyle bir backend yok/yetki
     yok sinyalsiz" (PG semantiği); yetki hatası SQLSTATE'iyle normal hata
     yolundan akar. Guard yok — kendi backend'ini öldürmek meşru kullanım
     (donmuş sorgu senaryosu).
2. **M5 köprüsü — kendi sorgunu force-kill:** tab'daki Cancel 5 sn içinde
   etki etmezse buton "Force kill" e dönüşür (design/05 §9 tasarımı):
   `ExecRegistry` çalışan sorgunun backend pid'ini zaten biliyorsa o pid'le,
   bilmiyorsa run başlangıcında `pg_backend_pid()` bir kez okunup
   `QueryState`'e yazılır; Force kill `signal_backend(terminate)` çağırır +
   ardından bağlantı sağlığı kontrolü (pool o conn'u düşürecek). Bu, design/12
   M5 "force kill" satırının uygulanmasıdır.
3. **UI — sidebar üçüncü sekme "Activity"** (`components/activity/
   ActivityPanel.tsx`, lucide `Activity` ikonu):
   - Görünürken 5 sn'de bir `list_activity` (setInterval; sekme/sidebar
     gizlenince durur — `useEffect` cleanup). Elle yenile butonu + "auto"
     göstergesi.
   - Dar panel düzeni (RolesPanel deseni): satırda state noktası (active=ok,
     idle in tx=warn, lock bekleyen [wait_event_type=Lock]=danger) + pid +
     usename + süre + sorgu ilk satırı (truncate). Üstte client-side filtre
     kutusu (pid/user/query substring).
   - Satır tık → alt detay peek: tam (200 karakterlik) sorgu metni, datname,
     client_addr, wait_event, başlangıç zamanları + iki buton: *Cancel*
     (doğrudan) ve *Terminate* (ConfirmDialog: pid + user + sorgu özeti;
     bağlantı prod-renkliyse başlık danger tonunda). İşlem sonrası liste
     hemen tazelenir; `false` dönerse toast "backend not found or not
     permitted".
   - "this app" satırlarında ayrıca hangi tab olduğu söylenmeye ÇALIŞILMAZ
     (pid↔tab eşlemesi ancak madde 2'nin pid kaydıyla mümkün; varsa etiket
     gösterilir, yoksa yalnız rozet).
4. **Palette:** "Show activity" eylemi (sidebar'ı açar + Activity sekmesine
   geçer). Sidebar sekme state'i `useState`'ten `uiStore`'a taşınır
   (`sidebarTab: "explorer" | "roles" | "activity"`) — palette erişimi için.

### Kabul

- İki ayrı bağlantıdan biri `pg_sleep(60)` koşarken Activity'de active satır
  süresiyle görünür; *Cancel* sorguyu iptal eder, koşan tab normal
  `query_cancelled` hatasını alır.
- *Terminate* onay ister; onay sonrası backend ölür, o backend'in tab'ı
  `connection_lost`/banner yoluna düşer (mevcut mekanizma), uygulama ayakta kalır.
- Yetkisiz kill denemesi okunur bir hata toast'ı üretir; panel çalışmaya devam eder.
- Kendi tab'ında cancel 5 sn etkisizse Force kill belirir ve çalışır.
- Panel açıkken liste 5 sn'de bir tazelenir; sekmeden çıkınca polling durur
  (devtools'ta istek görünmez).

### Risk

- **Terminate kendi pool bağlantımızı vurursa:** o `ActiveConnection`'ın
  pool'u bozuk conn'u atar ama açık tx/cursor kaybolur — tab'lar
  `releaseTabsForConnection`/banner yoluyla toparlanıyor (U-track'te
  sertleştirildi); kabul maddesi bunu bilinçli test ediyor.
- Polling her 5 sn bir pool bağlantısı işgal eder — sorgu ucuz (ms) ama
  meşgul pool'da run'larla yarışabilir. Önlem: `list_activity` çağrısı
  görünür-sekme koşuluna sıkı bağlı; interval sabiti tek yerde (ileride
  ayara bağlanabilir).
- `pg_stat_activity.query` başka kullanıcıların sorgularını superuser
  olmayana `<insufficient privilege>` gösterir — UI bunu olduğu gibi, muted
  basar (gizlemeye çalışmaz; yetki gerçeği).

---

## 4. Sözleşme değişiklikleri özeti (uygulanınca design/02'ye işlenecek)

| Değişiklik | Milestone |
|---|---|
| — (V1/V2 backend'e dokunmaz; Ö5 read_only frontend'de profilden türetilir) | V1, V2 |
| `connectionStore` persist anahtarı `ariadne-connections` (`lastSession` eşlemesi) — localStorage sözleşmesi, Tauri API değil | V3 |
| `Settings.longQueryNoticeSeconds` (uiStore, varsayılan 10, 0=kapalı) | V1 |
| `list_activity { connection_id } → Vec<ActivityRow>` | V4 |
| `signal_backend { connection_id, pid, mode: "cancel"\|"terminate" } → bool` (design/12 M5'teki `kill_query` taslağının yerini alır — pid-tabanlı tek komut) | V4 |
| `QueryState.backendPid?` (frontend-içi; force-kill köprüsü) | V4 |

## 5. Test yaklaşımı

- **Saf mantık (frontend, gate=tsc+build; test koşucusu yok — fonksiyonlar
  saf tutulur):** `lib/clipboard.ts` formatlayıcıları (CSV kaçış, Markdown
  pipe kaçışı, JSON null), `sessionResume` çift-çözme mantığı store'lardan
  ayrık saf fonksiyon olarak yazılır (girdi: persist edilmiş tab+lastSession,
  çıktı: davet listesi) — ileride vitest gelirse ilk müşteriler bunlar.
- **Rust unit:** `ActivityRow` süre/truncate hesabı sorguda olduğundan unit
  yüzeyi dar; `signal_backend` mode→SQL eşlemesi basit match — test edilir.
- **Canlı DB `--ignored`:** `list_activity` kendi oturumunu (`is_self`) görür;
  ikinci bağlantıda `pg_sleep` koşarken `signal_backend(cancel)` sorguyu
  düşürür (57014); `terminate` sonrası eski bağlantıda sorgu `connection_lost`
  üretir.
- **Elle duman (08 §5 listesine eklenecek):** V1 üçlüsü (RO rozet + kart +
  bitiş sinyali), 5 satır Markdown kopyalama → PR önizlemesi, kapat-aç →
  reconnect daveti → 3 tab'ın banner'sız dönüşü, Activity'den prod-renkli
  bağlantıda terminate onayı.

## 6. Bilinçli kapsam dışı (bu track'ten)

| Ne | Neden | Ne zaman |
|---|---|---|
| Ö6 — yeni tab başlangıç içeriği (son dosyalar/sorgular/snippet'ler) | M4 history/snippets olmadan içerik yok | P1-M4 sonrası, Ö1 kartının genişletilmesi olarak |
| Ö8 — şema düğümü peek'inde boyut-sıralı tablo listesi | Düşük öncelik; `get_relation_details`'in şema-düzeyi toplaması ayrı sorgu ister | Sıkışınca / bir Explorer oturumunun yanına |
| Ö7 OS bildirimi (`tauri-plugin-notification`) | Toast v1 için yeterli; plugin + capability maliyeti sinyal değerini aşıyor | Toast yetersiz kalırsa (minimize kullanım gözlenirse) |
| Activity'ye "Locks" sekmesi (pg_locks join) | v1'de şart değil (design/16 S7 kararı) | Ö4 kullanımda oturunca, ihtiyaçla |
| Sonuç diff'i (iki ortam karşılaştırma) | Büyük iş, Faz 2+ | design/16 S6 kararı korunuyor |
| Dikdörtgen (hücre-aralığı) grid seçimi | Satır granülü günlük ihtiyacı karşılıyor | Talep doğarsa V2 devamı |
