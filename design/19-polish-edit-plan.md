# 19 — GUI Cila + Hücre Düzenleme (GUI turu 3 → P1-X milestone'ları)

> Tarih: 2026-07-04. Girdi: kullanıcının v0.0.1 + design/18 sonrası üçüncü GUI test
> turu (8 not + v0.0.2 hedefi). Bu dosya önce **projenin güncel durumunu** özetler,
> sonra notları design/15/17/18 tarzında (neredeyiz / plan / kabul / risk)
> **P1-X1…X4** milestone'larına böler. "X" = polish/edit track. Kod referansları
> 2026-07-04 (`p1-u-gui-backlog` dalı) itibarıyladır.
>
> **DURUM (2026-07-04): X1–X4 + design/20 (Y1–Y3) TAMAMEN UYGULANDI, v0.0.2'ye
> yükseltildi.** Her milestone ayrı feat commit'i, her commit'te gate yeşil (44 Rust
> testi +7 ignored, clippy -D, rustfmt, tsc, vite build). Sıra: X1→X2→X3→Y1→Y2→Y3→X4
> →v0.0.2. Kök-neden bulguları: N1 backend'deymiş (read_rows 0 satırda sütun vermiyor
> → describe fallback); N2 iki katman (N4 render + peek-shift yarışı → tek-tık peek
> debounce). **Henüz main'e merge EDİLMEDİ, canlı duman testi YAPILMADI** (kullanıcı
> ekran başında değildi) — §5'teki zorunlu elle test listesi bir sonraki adımdır.

## 1. Projenin güncel durumu (2026-07-04, v0.0.1)

`p1-u-gui-backlog` dalı, main'e **henüz merge edilmedi**. Tamamlanan track'ler:

- **Faz 0 (M0–M3) + design/11 refactor** — main'de. Tauri v2 + React/TS Postgres IDE.
- **P1-M1** — multi-connection eşzamanlı + hızlı geçiş (tab↔connection semantiği).
- **P1-U1…U4** (design/15) — GUI backlog: bağlantı semantiği, seçim-run + marker,
  Explorer etkileşim (peek/index/trigger/fonksiyon kaynağı/filtre), Ayarlar,
  Users&Roles, .sql aç/kaydet.
- **P1-V1…V4** (design/17) — senaryo paketi: RO rozeti + boş-durum kartı + bitiş
  sinyali, grid zengin kopyalama (CSV/TSV/JSON/Markdown), açılış reconnect daveti,
  Activity paneli + `signal_backend` + tab force-kill. **Sürüm 0.0.1'e yükseltildi.**
- **P1-W1…W3** (design/18) — Explorer/nav turu: reconnect toast netliği, Explorer
  hijyeni (sistem şemaları gizli, public otomatik açık, kategori tavanı 200+"more"),
  SQL Server tarzı `server ▸ database ▾` bağlam çubuğu + New Query/Ctrl+N.

**Gate durumu:** her commit'te yeşil — 40 Rust unit testi (+4 canlı-DB `--ignored`),
clippy `-D warnings`, rustfmt, tsc, vite build. **Canlı DB elle testi track sonu
yapılmadı** (kullanıcı ekran başında değildi); bu turdaki notlar o testin ilk
gerçek geri bildirimidir → bazıları gerçek bug (N2, N4).

**Sırada (bu turdan sonra):** P1-X1…X4 (bu belge) → v0.0.2 → dalı main'e merge +
kapsamlı canlı duman testi → Faz 1 **P1-M2** (yerel SQLite depo, design/12 §P1-M2).

## 2. Ham notlar → madde eşlemesi

| # | Kullanıcı notu | Tür | Milestone |
|---|---|---|---|
| N1 | Boş SELECT sonucunda "Results will appear here…" yerine boş tablo (başlık + 0 satır) gelmeli | polish | X1 |
| N2 | Tablo adına çift-tık SELECT sorgusu atmıyor | **bug** | X2 |
| N3 | Tablo adına sağ-tık'ta webview'in kendi menüsü (Geri/Yenile/Yazdır/İncele) açılıyor — engelle | **bug** | X1 |
| N4 | Explorer connection değişince tablo/fonksiyon ağacını GETİRMİYOR; Roles/Activity'ye gidip gelince geliyor | **bug** | X2 |
| N5 | Uygulama sekmesi/penceresi başlığına "Ariadne — PostgreSQL IDE" | polish | X3 |
| N6 | Footer "Copy ▾" menüsü yukarıda/kopuk çıkıyor, kötü görünüyor | polish | X1 |
| N7 | Sonuç panelinin yüksekliği ayarlanamıyor — resize edilebilir olsun | polish | X3 |
| N8 | Hücreye çift-tık → popup: tam değer + düzenleme alanı + Kaydet/Vazgeç; UPDATE hata yönetimi + loading | **feature (data-write!)** | X4 |
| N9 | Bu özelliklerden sonra v0.0.2'ye geç | sürüm | §3 |

Önerilen sıra: **X1 → X2 → X3 → X4 → v0.0.2**. X1/X2/X3 küçük-orta ve düşük risk;
X4 en büyük ve **kullanıcının DB'sine YAZAR** — ayrı ele alınır (bkz. X4 riski).

---

## P1-X1 — Grid & menü cilası (N1, N3, N6)

### Analiz

- **N1 (boş sonuç):** `ResultArea` (`ResultArea.tsx`) sonucu `hasRows =
  q.columns.length > 0` ile karar veriyor; kolon yoksa "Results will appear here.
  Run with Ctrl+Enter" placeholder'ı basıyor. 0 satır ama kolonlu SELECT'te grid
  zaten açılır; kullanıcı placeholder gördüğüne göre ya sonuç kolonsuz dönüyor ya
  da "run edildi mi" ayrımı yok. Kök: "henüz sorgu koşulmadı" ile "koştu, sonuç
  boş" ayrımı yapılmıyor. Çözüm: bir sonuç üretildiyse (rows-statement döndüyse,
  0 satır dahi olsa) boş grid göster; placeholder yalnız hiç koşulmamışken.
- **N3 (webview sağ-tık menüsü):** Explorer'da yaprak (relation/function) ve "more"
  düğümlerinde sağ-tık `openFilterMenu`'ye düşüyor ama yalnız `category`/`schema`
  için `preventDefault` çağrılıyor; relation'da hiçbir şey yapılmadığından
  **tarayıcı/webview varsayılan menüsü** (resimdeki Geri/Yenile/Yazdır/İncele)
  açılıyor. Çözüm: Explorer ağaç konteynerinde (ya da NodeRow kökünde) her sağ-tık
  `preventDefault` edilsin (webview menüsü hiçbir yerde istenmiyor). İdeali:
  uygulama genelinde context menüyü bastırıp yalnız kendi menülerimizi göstermek.
- **N6 (copy menü konumu):** `ResultGrid` footer'daki "Copy ▾" menüyü
  `{x:clientX, y:clientY}` + `top: min(y, innerHeight-320)` ile açıyor; buton en
  altta olduğundan menü ~320px yukarı, butondan kopuk çıkıyor (kullanıcının
  şikâyeti). Çözüm: footer Copy'yi butona tutturulmuş, **yukarı açılan** bir menü
  yap — ya Radix DropdownMenu (`side="top"`, anchored) ya da hand-rolled menüyü
  butonun hemen üstüne (menü yüksekliği kadar `y - h`) konumla. Sağ-tık hücre
  menüsü (imleç konumunda) olduğu gibi kalır; yalnız footer girişi düzeltilir.

### Plan

1. **N1 (UYGULANDI — kök neden backend'deymiş, frontend flag GEREKMEDİ):**
   Gerçek kök: `db/rows.rs::read_rows` sütun metadata'sını `rows.first()`'ten
   türetiyordu; 0 satırlı SELECT'te `None` → `columns = []` → `Rows { columns: [] }`
   döndü → frontend `hasRows = columns.length > 0` false → placeholder. Çözüm
   backend'de: `read_rows` boş sütun döndürürse `open_cursor_and_fetch` /
   `run_inline_rows` extended-protocol `describe` (Parse+Describe, execute yok →
   yan etkisiz) ile GERÇEK başlıkları çeker (`db/exec.rs::describe_columns`, yalnız
   empty durumunda 1 round-trip). Böylece 0 satırlı SELECT `Rows { columns:[…], rows:[] }`
   döner → `hasRows` true → grid başlıklar + "0 rows" ile açılır, placeholder çıkmaz.
   Frontend'e HİÇ dokunulmadı. Placeholder yalnız gerçekten hiç statement koşmamışken
   (boş/yorum-only SQL) görünür. Test: `zero_row_select_still_reports_columns` (ignored,
   canlı-DB).
2. **N3:** `Explorer` ağaç sarmalayıcı div'ine `onContextMenu` — hedef bir
   kategori/şema değilse (relation/function/more/boşluk) `e.preventDefault()`
   (kendi menümüz yoksa da webview menüsü çıkmasın). Ek güvenlik: `App` kökünde
   global `onContextMenu` preventDefault (üretim; geliştirmede DevTools'a İncele
   gerekiyorsa `import.meta.env.DEV` istisnası). Karar: yalnız Explorer'da bastır
   (global bastırma kopyala-yapıştır/DevTools'u zora sokabilir; dar tut).
3. **N6:** Footer "Copy ▾" → Radix `DropdownMenu` (trigger = buton), `side="top"
   align="end"`, içerik CopyMenu kalemlerinin aynısı. Sağ-tık yolu (hücrede,
   imleç konumunda) mevcut hand-rolled `CopyMenu` ile kalır. İki menü aynı
   biçimlendiricileri (`lib/clipboard.ts`) çağırır. (Alternatif: hand-rolled menüyü
   `y - menuH` ile yukarı konumla — daha az bağımlılık; Radix zaten projede,
   dropdown daha sağlam. Radix seçildi.)

### Kabul

- 0 satır dönen SELECT: başlıklar + "0 rows" footer'lı boş grid görünür,
  placeholder DEĞİL. Hiç koşulmamış tab'da placeholder görünür.
- Explorer'da tabloya/fonksiyona/boşluğa sağ-tık: webview menüsü AÇILMAZ (kategori/
  şema sağ-tık kendi menülerini açar).
- Footer "Copy ▾" tıklanınca menü butonun hemen üstünde, ona tutturulmuş açılır.

### Risk

- Global context-menu bastırması DevTools "İncele"yi engeller → yalnız Explorer'da
  bastırılır, üretimde global istisna değerlendirilir (X1'de dar kapsam).

---

## P1-X2 — Explorer connect-anı yenileme + çift-tık bug'ları (N2, N4)

### Analiz — N4 kök neden (bulundu)

`Explorer` içindeki `useSize()` (`Explorer.tsx:438`) ResizeObserver'ı `useEffect(…,
[])` ile **mount'ta bir kez** kuruyor ve `if (!ref.current) return` ile erken
çıkıyor. Ama `sizeRef` div'i yalnız **snapshot HAZIR** dalında render ediliyor
(`!snapshot ? Loading : <>… <div ref={sizeRef}>…`). Sıra:
1. Explorer connectionId ile mount olur, snapshot henüz yok → "Loading schema…",
   `sizeRef` div'i YOK → useSize effect'i çalışır, `ref.current` null → observer
   HİÇ kurulmaz.
2. Snapshot gelir → re-render → `sizeRef` div mount olur → ama effect (boş deps)
   tekrar çalışmaz → `height` 0'da kalır → `height > 0 && <Tree>` **false** →
   **ağaç boş**.
3. Roles/Activity'ye geçince Explorer unmount olur; geri gelince **yeniden mount**
   → snapshot artık hazır → `sizeRef` ilk render'da var → effect `ref.current`'ı
   görür → observer kurulur → `height > 0` → ağaç gelir. ✅

Bu, "conn'da gelmiyor, sekme gidip gelince geliyor" davranışını birebir açıklıyor.

**Çözüm:** ResizeObserver'ı **callback ref** ile bağla (düğüm mount olunca kurulur,
deps sorunu yok). Ya da `sizeRef` div'ini her zaman render et (loading'de de).
Callback-ref daha sağlam:
```ts
function useSize() {
  const [height, setHeight] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (node) {
      const ro = new ResizeObserver((es) => setHeight(es[0].contentRect.height));
      ro.observe(node);
      roRef.current = ro;
    }
  }, []);
  return { ref, height };
}
```
Ek güvenlik: `height <= 0` iken Tree'ye ölçülene kadar makul bir fallback yükseklik
verilebilir; ama callback-ref ilk paint'te ölçtüğünden gerekmeyebilir.

### Analiz — N2 (çift-tık SELECT atmıyor)

`NodeRow` yaprakta `onDoubleClick={() => isLeaf && onActivate(d)}`, `onActivate` →
`activateNode` → `onOpenRelation(schema, name)` → `App.openRelation` → `addTab(
"SELECT * … LIMIT 500", tabConnectionId)` + `run(id)`. Kod yolu **doğru görünüyor**;
statik incelemede kusur yok. Olası nedenler (canlı tekrar gerekli):
- (a) N4 ile aynı kök: ağaç hiç render olmadıysa çift-tık da yakalanmaz — **N4
  düzelince N2 kendiliğinden düzelebilir** (en olası). Kullanıcı ağacı görüyordu
  (sekme gidip-gelme sonrası), ama o durumda arborist satırının event'i ölçüm/
  remount sonrası tutarsız olabilir.
- (b) react-arborist satırın çift-tık'ını kendi seçim/aç-kapa mantığıyla yutuyor
  olabilir → `onActivate` çağrılmıyor.
- (c) tek-tık peek + çift-tık yarışı; ilk tık peek panelini açıp odağı değiştiriyor
  olabilir.

**Plan:** X2 uygulanırken önce N4 düzeltilir, sonra N2 **canlı tekrar edilir**;
hâlâ sorunsa `onActivate`'in çağrıldığını (log) + `openRelation`'ın `run`'a
gittiğini doğrula. Gerekirse çift-tık'ı NodeRow yerine react-arborist'in
`onActivate`/`onDoubleClick` API'sine taşı, ya da tek-tık peek gecikmesini kaldır.

**UYGULANDI (N2 kök neden bulundu — İKİ katman):**
- (a) N4 (ağaç hiç render olmuyor) → callback-ref ile düzeltildi (aşağıdaki `useSize`).
- (b) **Peek-shift yarışı (asıl statik neden):** `PeekPanel` akış-içi bir flex çocuğu
  (`max-h-[42%]`), tek-tık'ta açılınca `flex-1` ağaç alanını KÜÇÜLTÜR → satırlar
  yukarı kayar. Çift-tık'ın 1. tıklaması peek'i açıp layout'u kaydırdığından 2.
  tıklama farklı bir satıra denk gelir; tarayıcı `dblclick`'i yalnız iki tık AYNI
  elemandaysa ateşler → hiç ateşlenmez → SELECT açılmaz. **Ağaç görünürken bile**
  reprodüksiyonu bu açıklar. Çözüm: react-arborist'in `Tree.onActivate` prop'u
  KULLANILMADI — çünkü DefaultRow `node.handleClick` ile **tek tıkta** `activate()`
  çağırıyor (her tıkta tab açardı, doğrulandı). Bunun yerine **tek-tık peek 220ms
  debounce** edildi: çift-tık aradaki timer'ı iptal eder → peek açılmaz, kayma olmaz,
  `activateNode` hemen çalışır. peek/activate hem ağaç hem pinned/arama listelerinde
  tutarlı. (plan option (c)).

### Kabul

- Yeni bir profile bağlanınca Explorer ağacı (şemalar/Tables/…) **hemen** görünür;
  Roles/Activity'ye gitmeye gerek kalmaz.
- Tabloya çift-tık: o tabloya `SELECT * … LIMIT 500` yeni tab'da koşar ve sonuç gelir.

### Risk

- N2 statik olarak görünmediğinden düzeltme canlı-tekrar gerektirir; X2 kabulü
  `npm run tauri dev` ile doğrulanmalı (bu track'in ilk "elle test şart" maddesi).

---

## P1-X3 — Ayarlanabilir sonuç paneli + pencere başlığı (N5, N7)

### Analiz

- **N7:** `App.tsx` gövdesi editör `flex-[3]` + sonuç `flex-[2]` sabit oranlı; arada
  resize yok. `ResizeHandle` bileşeni var (sidebar genişliği için, yatay sürükleme).
  Sonuç paneli için **dikey** bir tutamaç + `uiStore`'da saklanan yükseklik/oran
  gerekir.
- **N5:** Pencere başlığı `tauri.conf.json` `app.windows[0].title` ile set edilir
  (şu an muhtemelen "Ariadne"). "Ariadne — PostgreSQL IDE" yapılır. (Web sekmesi
  değil; masaüstü pencere başlığı — Tauri.)

### Plan

1. **N7:** `uiStore`'a `resultsHeight` (px) ya da `resultsRatio` (0–1) + setter,
   persist. `App` editör/sonuç bölünmesini `flex` yerine sonuç paneline explicit
   yükseklik verip aralarına **yatay `ResizeHandle`** (mevcut bileşenin dikey-drag
   varyantı ya da yeni `HResizeHandle`) koyar. Min/max sınır (ör. 80px – %80).
   Sonuç gizliyken (resultsVisible=false) tutamaç görünmez.
2. **N5:** `tauri.conf.json` → `app.windows[0].title = "Ariadne — PostgreSQL IDE"`.
   (İstenirse başlık dinamik: aktif bağlantı/DB adı eklenebilir — kapsam dışı,
   şimdilik sabit.)

### Kabul

- Editör ile sonuç paneli arasındaki tutamaç sürüklenince sonuç yüksekliği değişir;
  restart'ta korunur; min/max sınırlarına takılır.
- Uygulama penceresi başlığı "Ariadne — PostgreSQL IDE".

### Risk

- Dikey resize + Monaco layout: editör yüksekliği değişince Monaco'nun `layout()`
  tetiklenmeli (aksi halde editör boyutu bozulur). Monaco `automaticLayout` açıksa
  kendi halleder; değilse ResizeHandle sonrası layout çağrısı. Kabulde kontrol.

---

## P1-X4 — Hücre görüntüleme/düzenleme popup'ı (N8) — DATA-WRITE, dikkatli

### Analiz + kapsam kararı

Kullanıcı: hücreye çift-tık → popup, tam değer + düzenleme alanı + Kaydet/Vazgeç,
UPDATE hata yönetimi + loading. Bu, design/12 §6'da **bilinçli ertelenen "inline
veri düzenleme"** (roadmap #6): yüksek dikkat isteyen iş (PK çözümü, UPDATE
önizleme, tip cast). İki katmana ayrılır:

- **Görüntüleyici (her zaman güvenli):** her hücrede çift-tık → popup, hücrenin TAM
  değeri (grid'de kesik/8KB olabilir — design 05 §4 "hücre tam-değer görüntüleme",
  M5 kalemi). JSON ise pretty-print. Salt-okunur; her sonuç için çalışır.
- **Düzenleyici (yalnızca güvenli-düzenlenebilir sonuçta):** UPDATE ancak sonucun
  **tek tablodan** geldiği ve satırın **PK'sının çözülebildiği** durumda açılır.
  Rastgele sorgu (JOIN, ifade, GROUP BY) düzenlenemez → popup salt-görüntüleyici
  moda düşer, "read-only (not a simple table result)" notu.

**Düzenlenebilirlik nasıl bilinir?** Öneri (düşük riskli): tab'ı bir tablodan
açarken (`openRelation` çift-tık ya da palette "open table") tab'a
`sourceTable: { schema, name }` işaretle. Düzenleme için gereken:
(a) `sourceTable` var, (b) PK kolonları cache'ten alınır, (c) PK kolonlarının
DEĞERLERİ sonuç satırında mevcut (SELECT * olduğundan genelde var). Üçü sağlanırsa
düzenleme açık. Değilse görüntüleyici.

**Backend (yeni komut):** `update_cell { connection_id, schema, table, pk: [{
column, value }], column, new_value: string | null } → { updated: u64 }`. SQL:
`UPDATE "schema"."table" SET "column" = $1 WHERE "pk1" = $2 AND … ` — `new_value`
null ise `SET "column" = NULL`. Tip cast: `new_value` metin olarak bind edilir;
kolon tipi cast'ı için `$1::text::"<type>"` ya da kolon tipini cache'ten alıp
`CAST`. **En güvenlisi:** PK karşılaştırmaları da metin-cast riski taşır → PK
değerleri sonuçtan metin geldiğinden `WHERE "pk"::text = $n` ile karşılaştır (indeks
kaybı olabilir ama tekil satır güncellemesi; kabul). Güncelleme **1 satırdan
fazlasını etkiley­emez** güvencesi: komut `updated != 1` ise rollback + hata
("expected exactly 1 row, matched N") — yanlış/çoğul güncellemeyi önler
(BEGIN; UPDATE; eğer rowcount!=1 ROLLBACK else COMMIT).

**Frontend:** çift-tık hücre → `CellDialog` (Radix Dialog): textarea (tam değer) +
NULL checkbox + Kaydet/Vazgeç. Düzenlenemezse textarea salt-okunur + not. Kaydet →
loading (dialog + grid kilitli) → `update_cell` → başarıda grid'deki hücreyi
yerinde güncelle (yeniden sorgu yok) + toast; hata → dialog içinde kırmızı mesaj
(errors.ts başlığı), dialog açık kalır.

### Plan (özet — X4'e gelince detaylandırılır)

1. Grid hücresine çift-tık → `onCellEdit(rowIndex, colIndex)`; ResultArea/tab
   düzeyinde `CellDialog` state.
2. `sourceTable` tab alanı; `openRelation`/palette open-table bunu set eder.
3. Backend `update_cell` (BEGIN/UPDATE/rowcount==1 guard/COMMIT|ROLLBACK) + api.ts
   binding + design/02 sözleşmesi.
4. `CellDialog`: görüntüleyici + (düzenlenebilirse) editör; loading; hata basımı.
5. Başarıda grid satır-hücresini yerinde patch (tabsStore aksiyonu).

### Kabul

- Herhangi bir sonuçta hücreye çift-tık: tam değer popup'ta görünür (kesik
  değerler tam).
- `SELECT *`'le açılmış tablo sonucunda bir hücreyi düzenleyip Kaydet: DB'de UPDATE
  koşar (tam 1 satır), grid güncellenir, toast; JOIN/ifade sonucunda editör kapalı,
  "read-only" notu.
- Hatalı değer (tip/constraint): dialog içinde okunur hata, veri değişmez, dialog açık.
- UPDATE sürerken dialog "Saving…" ve tekrar-Kaydet engellenir.

### Risk (YÜKSEK — kullanıcı onayı önerilir)

- **Kullanıcının canlı DB'sine YAZAR.** X1–X3 salt-UI; X4 veri değiştirir. Uygulama
  başlamadan kapsamın (yalnız güvenli tek-tablo+PK, 1-satır guard, read_only profil
  bloğu) kullanıcı tarafından onaylanması önerilir. **read_only profilde düzenleme
  tamamen kapalı** (RO sigortası, design 06 §66) — editör hiç açılmaz.
- Tip cast (metin→kolon tipi) tüm tiplerde temiz olmayabilir (enum, jsonb, array).
  v1: cast'ı `$1::text::type` ile dene, hata olursa kullanıcıya bas (guard zaten
  1-satır); karmaşık tipler "not editable in v1" notuyla kapatılabilir.
- Kompozit PK / PK'sız tablo: PK yoksa düzenleme kapalı (WHERE kurulamaz). ctid
  fallback BİLİNÇLİ OLARAK KULLANILMAZ (kırılgan).

---

## 3. v0.0.2 hedefi (N9)

X1–X4 (ya da kullanıcının onayladığı alt-küme) bitince sürüm **0.0.2**'ye
yükseltilir: `package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json` /
`Cargo.lock` / StatusBar (`v0.0.1`→`v0.0.2`). design/02'ye X4 `update_cell`
sözleşmesi, design/13 ve bu belgeye durum işlenir.

## 4. Sözleşme değişiklikleri

| Değişiklik | Milestone |
|---|---|
| `update_cell { connection_id, schema, table, pk[], column, new_value }` → `{ updated }` | X4 |
| (X1–X3 backend'e dokunmaz) | — |

## 5. Test yaklaşımı

- **Saf/unit:** N1 sonuç-durumu ayrımı (frontend, tsc+build); `update_cell` SQL
  kurulumu (Rust unit: kolon/PK tırnaklama, NULL dalı, 1-satır guard) + canlı-DB
  `--ignored` (TEMP tablo: UPDATE round-trip, çoğul-eşleşme rollback).
- **Elle duman (ZORUNLU — bu tur bug'ları elle testte çıktı):** N4 connect-anı
  ağaç; N2 çift-tık SELECT; N3 sağ-tık webview menüsü yok; N6 copy menü konumu;
  N1 boş sonuç grid'i; N7 sonuç paneli resize; X4 hücre görüntüle + düzenle
  (tek-tablo) + read-only/JOIN'de kilitli.

## 6. Bilinçli kapsam dışı

| Ne | Neden | Ne zaman |
|---|---|---|
| Hücre görüntüleyicide 8KB üstü değerin sunucudan yeniden çekilmesi | X4 görüntüleyici grid değerini gösterir (<8KB tam); >8KB kesik değeri DB'den yeniden çekmek ayrı iş (design 05 §4 M5) | Talep olursa |
| ctid tabanlı düzenleme (PK'sız tablo) | Kırılgan; yanlış satır riski | Gerekirse, açık uyarıyla |
| Toplu/çok-hücre düzenleme, satır ekleme/silme | v1 tek-hücre yeter | Talep olursa |
| İlk snapshot fetch gecikmesi (N4'ün ayrı bir yüzü değil; N4 render bug'ıdır) | — | — |
| Dinamik pencere başlığı (aktif DB) | Sabit başlık yeter | İstenirse |

## 7. Finalize kararları (2026-07-04 Q&A, kullanıcı onayladı)

1. **Sıra:** X1 → X2 → X3 → **Y1 → Y2 → Y3 (design/20)** → **X4 en son** → v0.0.2.
   Gerekçe: X4 tek data-write işi; diğer her şey stabilken yapılır ve sorun
   çıkarsa v0.0.2'yi bloke etmeden daraltılabilir. **v0.0.2 iki belgeyi (19+20)
   birden kapsar.**
2. **X4 kapsamı onaylandı:** görüntüleyici her hücrede; düzenleme yalnız
   tek-tablo + PK çözülebilen sonuçta; tam-1-satır guard'ı; read_only profilde
   editör kapalı; ctid fallback yok (plandaki gibi).
3. Kod doğrulamaları: Radix dialog/dropdown-menu zaten bağımlılıkta (X1/X4 ek
   bağımlılık istemez); Monaco `automaticLayout: true` → X3 layout riski pratikte
   yok.
