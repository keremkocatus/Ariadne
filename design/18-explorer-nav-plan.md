# 18 — Explorer & Navigasyon İyileştirmeleri (GUI turu 2 → P1-W milestone'ları)

> **DURUM (2026-07-04): P1-W1…W3'ün HEPSİ tamamlandı** ve `p1-u-gui-backlog`
> dalına commit'lendi (W1 reconnect toast netliği+takılma, W2 Explorer hijyeni,
> W3 bağlam çubuğu + New Query/Ctrl+N). Hepsi frontend-only; gate her commit'te
> yeşil (tsc + vite build). **Canlı DB elle testi henüz yapılmadı.** W3'te
> bilinçli UX kararı: sığ bağlam çubuğu (tam nested ağaç yerine) — §P1-W3 analizi.

> Tarih: 2026-07-04. Girdi: kullanıcının v0.0.1 sonrası ikinci GUI test turu (7
> ham not). Bu dosya notları design/15/17 tarzında (neredeyiz / plan / kabul /
> risk) analiz edip **P1-W1…W3** milestone'larına böler. "W" = workflow/explorer
> track; U/V/M track'lerine dokunmaz. Kod referansları 2026-07-04 (v0.0.1,
> `p1-u-gui-backlog` dalı) itibarıyladır.

## 0. Ham notlar → madde eşlemesi

| # | Kullanıcı notu | Milestone |
|---|---|---|
| N1 | Reconnect toast'ı yalnız DB adını yazıyor; aynı adlı iki DB'de hangisi benim belli değil | W1 |
| N2 | Reconnect toast'ı takıldı — başka işler yaptım, sağ altta gitmedi | W1 |
| N3 | Explorer'da public şema hemen gelmiyor | W2 |
| N4 | 2000 tablo varsa hepsi yüklenip kasmasın; maks ~100-200 gelsin, gerisi filtreyle. Aynısı functions için | W2 |
| N5 | Explorer'a `information_schema` ve `pg_catalog` geliyor, içleri boş — gösterme | W2 |
| N6 | Üstteki connection kısmı pratikliği öldürüyor; SQL Server tarzı server→database→şema→tablo; smooth, çok derin olmasın; default DB bağlanırken seçilen olsun | W3 |
| N7 | Explorer'da server/database üstünde sağ-tık "yeni query"; kısayol ata, yoksa Ctrl+N | W3 |

Önerilen sıra: **W1 → W2 → W3**. W1/W2 küçük, frontend-only, bağımsız; W3 en büyük
(Explorer yeniden yapılandırma) ama yine backend'siz (`list_databases` +
`connectProfile` zaten var). Her milestone "çalışan uygulama bırakır"; gate:
tsc + vite build (+ W'lerde backend'e dokunulmuyorsa rust gate'i tetiklenmez).

---

## P1-W1 — Reconnect toast'ı netleştir + takılmayı gider (N1, N2)

### Analiz: neredeyiz?

`lib/sessionResume.ts` her distinct (profil, DB) için toast basıyor; başlık
`Reconnect to ${name}` (name = profil adı ?? DB adı) ve **`duration: Infinity`**.
İki sorun:
- **N1:** `name` yalnız profil adı; kullanıcı "DB adı yazıyor" diyor — demek ki
  profil adı = DB adı ya da profil adı ayırt edici değil. Sunucu (host) + DB
  birlikte gösterilmeli ki iki farklı sunucudaki aynı-adlı DB ayrışsın.
- **N2:** `Infinity` süre → toast kullanıcı elle kapatana kadar (kapatma butonu
  da yok) sonsuza dek durur. "Başka işler yaptım, gitmedi" tam bu. Ayrıca
  kullanıcı o bağlantıyı BAŞKA yoldan (menüden) kurarsa toast hâlâ durur.

`offerReconnect` bugün profil adını `conn.profiles.find(...).name`'den alıyor;
host bilgisi de aynı profilde var (`ConnectionProfile.host/port`).

### Plan

1. **Etiket (N1):** toast başlığı `Reconnect to <profileName>` + açıklama satırı
   (`description`) `<user>@<host>:<port> · <database>`. Böylece aynı DB adının iki
   sunucudaki hali (host farkı) ve aynı sunucuda farklı profiller ayrışır. Etiket
   `Invite`'a `profile: ConnectionProfile` taşınarak kurulur (collectInvites zaten
   profili biliyor).
2. **Süre + id (N2):** `duration: Infinity` → sonlu ve makul (**30 sn**;
   `RECONNECT_TOAST_MS`). Ayrıca her toast'a stabil `id` (`reconnect:<profileId>:<db>`)
   verilir → tekrar çağrıda üst üste yığılmaz. `closeButton: true` ile elle
   kapatılabilir.
3. **Bağlanınca söndür:** `reconnectAndRemap` başarısında `toast.dismiss(id)`
   çağrılır (zaten o toast'ın eyleminden tetiklenir; ama kullanıcı MENÜDEN
   bağlanırsa da sönmeli). Bunun için `connectProfile` başarısında, o (profil, DB)
   için olası `reconnect:` toast id'si `toast.dismiss` edilir — tek satır,
   sessionResume'dan export edilen `dismissReconnectToast(profileId, database)`
   yardımcısıyla. `connectionActions.connectProfile` bu yardımcıyı çağırır.

### Kabul

- İki farklı sunucuda `app` adlı DB'ye bağlıyken kapat-aç: iki toast, biri
  `user@host-a:5432 · app`, diğeri `user@host-b:5432 · app` — ayırt edilir.
- Toast'a dokunmadan 30 sn beklenince kaybolur; kapatma (×) ile hemen kapanır.
- Reconnect daveti dururken aynı bağlantı üstteki menüden kurulursa toast söner.

### Risk

- 30 sn kullanıcının fark etmesi için kısa gelebilir. Karşı-argüman: davet
  kalıcı olmamalı (N2'nin şikâyeti). Restore edilmiş tab'lar zaten banner
  taşıdığından davet kaçsa da reconnect yolu (banner) durur — bilgi kaybı yok.

---

## P1-W2 — Explorer hijyeni: sistem şemalarını gizle, public'i aç, kategori tavanı (N3, N4, N5)

### Analiz

- **N5 (sistem şemaları):** `cache/catalog.rs::fetch_schemas` `pg_catalog` +
  `information_schema`'yı `is_system=true` ile DÖNDÜRÜYOR ama nesnelerini
  (`fetch_tables/functions`) `NOT_SYSTEM` ile ÇEKMİYOR → Explorer'da boş şema
  düğümleri olarak görünüyorlar (`tree.ts::buildTree` hepsini basıyor). Çözüm:
  buildTree'de `is_system` şemaları ele. Backend değişikliği GEREKMEZ (completion
  bu şemaları cache'ten okumuyor; yalnız görsel gizleme). Kullanıcı gerçekten
  sistem nesnelerini isterse ileride "Show system schemas" ayarı eklenir (şimdilik
  kapsam dışı — zaten boşlar).
- **N3 (public hemen gelmiyor):** iki bileşen — (a) ilk snapshot fetch gecikmesi
  (P1-M2 disk-persist'in işi, W kapsamı dışı; not düşülür), (b) `Tree`
  `openByDefault={false}` → hiçbir şey açık değil, kullanıcı public'i elle açmalı.
  Çözüm (b): aktif şemayı (search_path[0] ya da "public") + onun "Tables"
  kategorisini açık başlat. react-arborist `initialOpenState` (id→bool) ile;
  bağlantı değişince yeniden uygulansın diye `<Tree key={connectionId}>`.
- **N4 (kategori tavanı):** `buildTree` her kategoriye TÜM nesneleri koyuyor;
  2000 tabloda hem 2000 TreeNode kurulur (CPU) hem açılınca dev liste. react-
  arborist DOM'u sanallaştırsa da düğüm kurulumu ve devasa scroll kalır. Çözüm:
  kategori başına **tavan (200)**; aşılırsa ilk 200 (ada göre sıralı) + sentetik
  bir "**… N more — filter to narrow**" düğümü. Bu düğüme tık = o kategorinin
  filtre popover'ını açar (filtre zaten var, design 15 §P1-U3). Filtre aktifken
  `filterSnapshot` sonucu tavana takılırsa yine tavan uygulanır (daralt → gör).

### Plan

1. **buildTree — sistem şemalarını ele:** `snap.schemas.filter((sc) => !sc.is_system)`.
   (Sıralama artık yalnız ada göre.) `flatten` de sistem şemalarını atlar (zaten
   boşlar; tutarlılık için).
2. **buildTree — kategori tavanı:** `group()` ve Functions dalında `rels.length >
   CAP` ise `rels` ada göre sıralanıp `slice(0, CAP)`; ardından çocuk listesine
   `{ id: "<sc>:<cat>:more", ntype: "more", name: "N more — filter to narrow",
   moreWhich: "rel"|"fn" }` eklenir. Kategori başlığındaki sayı GERÇEK toplamı
   gösterir (`Tables (2000)`), altında 200 + "1800 more". `CAP = 200`, tek sabit.
3. **TreeNode + NodeRow — "more" düğümü:** `ntype: "more"` eklenir; NodeRow'da
   yaprak gibi (chevron yok), muted italik, tık = `onActivate`/yeni bir
   `onMore(node)` → Explorer o kategorinin filtre popover'ını açar (mevcut
   `setFilterMenu`). Peek/pin yok.
4. **Explorer — default açık:** `initialOpenState` hesaplanır: aktif şema düğümü
   (`schema:${activeSchema}`) + `${activeSchema}:Tables` true. `activeSchema` =
   `snapshot.search_path[0]` (yoksa "public", o da yoksa ilk kullanıcı şeması).
   `<Tree key={connectionId} initialOpenState={...}>`.

### Kabul

- Explorer'da `pg_catalog`/`information_schema` görünmez; yalnız kullanıcı şemaları.
- Bağlanınca public şeması ve Tables kategorisi açık gelir (elle tıklamaya gerek yok).
- 2000 tablolu şemada Tables kategorisi `Tables (2000)` başlığıyla gelir, açınca
  ilk 200 + "1800 more — filter to narrow"; tık filtre kutusunu açar; `users` yazınca
  liste anında daralır ve tavana takılmaz.
- Functions için aynı davranış.

### Risk

- `initialOpenState` yalnız mount'ta uygulanır → `key={connectionId}` remount
  eder; bu, bağlantı değişince kullanıcının elle açtığı düğümleri sıfırlar. Kabul
  edilebilir (bağlantı başına taze görünüm; N3'ün beklentisiyle uyumlu).
- Tavan, nadiren 200'den fazlasını aynı anda görmek isteyen kullanıcıyı filtreye
  zorlar. Karşılık: performans + N4 açık talep. Filtre tek tık uzakta.

---

## P1-W3 — SQL Server tarzı navigasyon + New Query (N6, N7)

### Analiz + karar (belirgin UX kararı)

Kullanıcı üstteki `ConnectionMenu` dropdown'ının "pratikliği öldürdüğünü" söyleyip
"server→database→şema→tablo, ama çok derin olmasın, smooth" istiyor. İki uç yorum:
- (a) Tam SSMS: Explorer ağacının kökü `Server ▸ Databases ▸ db ▸ Schemas ▸ schema
  ▸ Tables ▸ table` (5-7 seviye) — kullanıcının "çok derin olmasın" uyarısına ters.
- (b) Bağlam başlığı + ağaç: Explorer'ın tepesinde kompakt bir **`server ▸ database`
  bağlam çubuğu** (database tıklanınca `list_databases`'ten seçilir = geç), altında
  bugünkü şema→kategori→nesne ağacı.

**Karar: (b).** Gerekçe: "smooth, çok derin olmasın" ısrarı + `list_databases`
zaten lazy; DB geçişini Explorer'a taşımak "üstteki menü pratikliği öldürüyor"
şikâyetini doğrudan çözer, üstteki menü connect/disconnect/profil yönetimi için
kalır (tamamen kaldırılamaz — yeni bağlantı/profil düzenleme oraya bağlı). Bu
bilinçli bir yorumdur; kullanıcı tam nested ağaç isterse W3 üzerine iterasyonla
eklenebilir (bağlam çubuğu geri-uyumlu, atılan iş değil).

- **Default DB (N6 son cümle):** `connect` zaten profil DB'sine (ya da override'a)
  bağlanır — "default = bağlanırken seçilen" hâlihazırda doğru. Bağlam çubuğundaki
  DB dropdown'ı mevcut (bağlı) DB'yi seçili/işaretli gösterir; "seçim zorunluysa
  default olsun" = dropdown açılışta mevcut DB'de açılır. Ekstra iş yok, yalnız
  görünürlük.
- **N7:** server/database bağlam çubuğuna sağ-tık → "New query (Ctrl+N)"; ayrıca
  şema düğümlerine sağ-tık → "New query here". Global **Ctrl+N** = aktif tab'ın
  bağlantısına bağlı yeni boş query tab'ı.

### Plan

1. **Explorer bağlam çubuğu** (`components/explorer/ContextBar.tsx`): arama
   kutusunun ÜSTÜnde, tek satır: `[server ikon] <profileName>  ▸  [db ikon]
   <database> ▾`. profileName tooltip'i `<user>@<host>:<port>`. Database kısmı bir
   buton; tık → mevcut `DatabasesSubmenu` mantığının Explorer'a taşınmış hali:
   `list_databases(connectionId)` lazy, mevcut DB işaretli/disabled, seçince
   `connectProfile(profileId, dbName)` (yeni tab + focus — mevcut semantik). RO
   profilse `RoBadge`. Bağlantı yoksa çubuk "No connection" gösterir.
2. **Sağ-tık — bağlam çubuğu (N7):** server ya da database bölümüne sağ-tık →
   küçük menü (hand-rolled overlay, design 15 §P1-U3 deseni): "New query" +
   "Refresh schema" + (database'de) "Switch database ▸" özeti. "New query" =
   `addTab("", connectionId)` (aktif tab'ın bağlantısı) + o tab'a odaklan.
3. **Sağ-tık — şema düğümü:** buildTree şema düğümleri `ntype:"schema"`. NodeRow
   şema düğümünde sağ-tık → "New query here" (şimdilik yalnız yeni boş tab; ileride
   `SET search_path TO <schema>` önyükleme adayı — kapsam dışı not). Mevcut
   kategori sağ-tık (filtre) davranışı yalnız `category` düğümlerinde kalır (zaten öyle).
4. **Ctrl+N kısayolu:** `lib/shortcuts.ts`'e `Ctrl+N` → aktif tab'ın bağlantısına
   bağlı `addTab("")`. Ctrl+T (yeni tab) korunur; Ctrl+N "yeni query" olarak
   eşanlamlı ana kısayol. Tauri webview'de Ctrl+N pencere açmasın diye
   `preventDefault` (editör-içi de yakalanır — Monaco'nun Ctrl+N binding'i yok).
5. **Üst menüyü sadeleştir (opsiyonel, düşük risk):** `ConnectionMenu` "Databases ▸"
   alt menüsü artık Explorer bağlam çubuğunda olduğundan üstten kaldırılabilir
   (kod tekrarını azaltır); connect/disconnect/profil kısımları kalır. Bu adım
   davranışı bozmaz, yalnız DB-geçişinin tek evi Explorer olur.

### Kabul

- Explorer tepesinde `raildb ▸ app ▾` bağlam çubuğu görünür; `app ▾`ye tıklayınca
  sunucudaki DB'ler listelenir, mevcut olan işaretli; başka DB seçince o DB'de
  yeni tab açılır ve Explorer o DB'nin şemasına geçer.
- Bağlam çubuğuna (ya da bir şemaya) sağ-tık → "New query" boş bir tab'ı aktif
  bağlantıyla açar.
- Ctrl+N her yerde yeni query tab'ı açar (aktif bağlantıya bağlı).
- Default DB bağlanırken seçilen DB'dir; dropdown mevcut DB'de işaretli açılır.

### Risk

- **En büyük risk bu milestone'un UX kararı** ((b) breadcrumb vs tam ağaç). Karar
  yukarıda bilinçli ve geri-uyumlu; kullanıcı görünce tam ağaç isterse çubuk
  üstüne "Databases" açılır düğümü eklenir (atılan iş yok).
- Ctrl+N OS/webview çakışması: `preventDefault` + Tauri'de yeni-pencere kısayolu
  varsayılan bağlı değil; canlı duman testinde doğrulanmalı.
- Bağlam çubuğu + arama + tavan üst üste dikey yer yer; dar sidebar'da sıkışıklık.
  Önlem: çubuk tek satır, 24px; arama zaten var.

---

## 4. Sözleşme değişiklikleri

Yok. W1–W3 tamamen frontend'dir (`list_databases`/`connect`/`connectProfile`
zaten var; catalog sorguları değişmez). design/02'ye ekleme gerekmez.

## 5. Test yaklaşımı

- **Saf mantık (tree.ts):** sistem-şema filtresi, kategori tavanı + "more" düğümü
  üretimi, `initialOpenState` hesabı (aktif şema seçimi) — tree.ts saf olduğundan
  ileride vitest gelince ilk müşteriler; şimdilik gate tsc+build.
- **Elle duman (08 §5):** iki sunucuda aynı-adlı DB ile reconnect etiketleri; 2000+
  tablolu şemada tavan + filtre; sistem şemalarının yokluğu; public otomatik açık;
  bağlam çubuğundan DB geçişi; Ctrl+N + sağ-tık New query.

## 6. Bilinçli kapsam dışı (bu track'ten)

| Ne | Neden | Ne zaman |
|---|---|---|
| İlk snapshot fetch gecikmesi (N3'ün (a) yüzü) | Disk-persist işi | P1-M2 |
| Tam nested Server/Databases ağacı (N6 (a) yorumu) | "Çok derin olmasın" + risk | Kullanıcı isterse W3 üstüne |
| "Show system schemas" ayarı | Sistem nesneleri nadiren gerekli; şimdilik gizli yeter | İhtiyaç doğarsa |
| Şema sağ-tık → `SET search_path` önyüklemeli new query | Küçük konfor | W3 sonrası, istenirse |
| Kategori tavanında sanallaştırılmış "load more" sayfalama | Filtre yeterli; ekstra karmaşa | Talep olursa |
