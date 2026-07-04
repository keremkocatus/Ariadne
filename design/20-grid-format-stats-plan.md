# 20 — Grid Kolonları, SQL Formatter, Activity Butonu & DB İstatistikleri (GUI turu 4 → P1-Y)

> Tarih: 2026-07-04. Girdi: kullanıcının design/19 turuyla aynı gün gelen 5 ek not.
> design/15/17/18/19 tarzında (neredeyiz / plan / kabul / risk) **P1-Y1…Y3**
> milestone'larına böler. "Y" = ergonomi/görünürlük track.
> Kod referansları 2026-07-04 (`p1-u-gui-backlog` dalı) itibarıyladır.
>
> **DURUM (2026-07-04): Y1–Y3 TAMAMEN UYGULANDI** (design/19'la birleşik v0.0.2
> turunda). Y1 grid sütun resize + sidebar tutamak affordance; Y2 `sql-formatter`
> + Ctrl+K (editörde format, dışarıda palette); Y3 `db_stats` komutu + StatusBar
> şeridi (30 sn poll, CPU/RAM YOK) + Toolbar Activity butonu. Gate her commit'te
> yeşil. Henüz main'e merge/canlı duman testi YAPILMADI (bkz. design/19 durum notu).

## 0. Ham notlar → madde eşlemesi

| # | Kullanıcı notu | Milestone |
|---|---|---|
| M1 | Command output'ta (sonuç grid'i) sütun genişliği ayarlanabilir olsun | Y1 |
| M2 | Object explorer yatay genişliği de biraz ayarlanabilir olsun | Y1 |
| M3 | Ctrl+K ile SQL formatter | Y2 |
| M4 | Run tuşunun olduğu yere "kim ne çalıştırıyor" (DB admin) butonu | Y3 |
| M5 | Versiyon bilgisinin soluna DB istatistikleri (CPU, RAM, aktif bağlantı); 30 sn'de bir yenilensin | Y3 |

Önerilen sıra: **Y1 → Y2 → Y3**. Hepsi bağımsız; Y1/Y2 frontend-only, Y3 küçük bir
backend komutu ister (`db_stats`). design/19'un (P1-X) yanında ya da sonrasında
yapılabilir — çakışmaz.

---

## P1-Y1 — Ayarlanabilir grid sütunları + sidebar tutamağı (M1, M2)

### Analiz

- **M1 (grid sütun genişliği):** `ResultGrid` (`ResultGrid.tsx`) sütun genişliğini
  sabit `COL_W = 168` ile kullanıyor; `colV` (TanStack horizontal virtualizer)
  `estimateSize: () => COL_W`. Sütunlar yeniden boyutlandırılamıyor. Sanallaştırma
  değişken genişlikleri destekler: her sütun için bir genişlik dizisi + başlık
  hücresinin sağ kenarına bir sürükleme tutamağı.
- **M2 (object explorer genişliği):** sidebar genişliği **zaten ayarlanabilir**
  (`ResizeHandle`, `App.tsx` → `setSidebarWidth`, clamp 180–560). Ama tutamak çok
  ince (`w-1` = 4px, hover'a kadar görünmez) → keşfedilmesi/yakalanması zor;
  kullanıcı muhtemelen bu yüzden "ayarlanabilir olsun" dedi. Çözüm: tutamağın
  vuruş alanını genişlet (görsel ince kalsın), hover/aktif geri bildirimini belirginleştir.

### Plan

1. **M1 — sütun genişlikleri:** `ResultGrid`'e `colWidths: number[]` local state
   (varsayılan `COL_W`; sonuç kolon sayısı değişince — yeni sorgu — sıfırlanır,
   `useEffect([columns])`). `colV.estimateSize = (i) => colWidths[i] ?? COL_W`;
   genişlik değişince `colV.measure()` / re-render. Başlık hücresinin sağ kenarına
   4px `cursor-col-resize` tutamak (`onMouseDown` → mousemove ile o sütunun
   genişliğini güncelle, min ~48px). Gövde hücreleri aynı `colV` offset/size'ını
   kullandığından otomatik hizalanır. Kalıcılık YOK (oturumluk; sorgu değişince
   sıfırlanır) — v1 sadelik; istenirse sonra tab/sorgu-imzası bazında saklanır.
2. **M2 — tutamak affordance'ı:** `ResizeHandle` görsel genişliği 4px kalır ama
   `hover:bg-fg-muted` (daha belirgin) + istenirse görünür bir dikey "grip" izi;
   clamp aralığı 180–560 → **160–680** genişletilir (dar/geniş şema adlarına yer).
   (Kod zaten var; yalnız görünürlük + aralık.)

### Kabul

- Sonuç grid'inde bir sütun başlığının sağ kenarını sürükleyince o sütun genişler/
  daralır; gövde hücreleri hizalı kalır; çok dar sürüklenince min genişlikte durur.
- Yeni sorgu koşunca sütun genişlikleri varsayılana döner.
- Sidebar kenarındaki tutamak fark edilir (hover'da belirginleşir) ve daha geniş
  bir aralıkta sürüklenebilir.

### Risk

- TanStack virtualizer'da dinamik `estimateSize` sonrası `measure()` çağrılmazsa
  offset'ler bayat kalır → sürükleme sırasında `colV.measure()` tetiklenir; kabulde
  hizalama kontrol edilir.
- Sürükleme sırasında metin seçimi tetiklenmesin → `user-select:none` sürükleme
  boyunca.

---

## P1-Y2 — SQL formatter (Ctrl+K) (M3)

### Analiz

Formatter yok. En temiz yol: `sql-formatter` (npm, saf JS, PostgreSQL diyalekti
destekli, harici host yok → Tauri bundle'ına girer). pg_query'nin deparse'ı
yeniden-yazım için var ama "pretty print" değil; JS formatter daha uygun (design 10
#10 "SQL formatter" kalemi — harici entegrasyon araştırması buydu, `sql-formatter`
cevabı).

**Ctrl+K çakışması:** bugün `Ctrl+K` = command palette (`shortcuts.ts`), ama
**editör içindeyken palette Ctrl+K bilinçli olarak Monaco'ya bırakılıyor**
(`inEditor()` → return). Yani editör odaklıyken Ctrl+K boşta. Karar: **editör
içinde Ctrl+K = format**, editör dışında Ctrl+K = palette (mevcut). Bu, "SQL
yazarken Ctrl+K formatlar" beklentisini karşılar ve palette'i editör dışında
korur. (Alternatif: `Shift+Alt+F` — VSCode muadili; kullanıcı Ctrl+K dediği için
o ana binding, Shift+Alt+F ikincil olarak da eklenebilir.)

### Plan

1. **Bağımlılık:** `sql-formatter` eklenir (`npm i sql-formatter`). `lib/format.ts`:
   `formatSql(sql: string): string` — `format(sql, { language: "postgresql",
   keywordCase: "upper", tabWidth: 2 })`. Saf fonksiyon (test edilebilir).
2. **Editör aksiyonu:** `SqlEditor`'da Monaco `addAction`/`addCommand` ile
   `KeyMod.CtrlCmd | KeyCode.KeyK` → seçim varsa yalnız seçimi, yoksa tüm metni
   formatla ve editör içeriğini değiştir (undo tek adımda geri alınabilsin diye
   `executeEdits`). Değişiklik `onChange` üzerinden `tabsStore.setSql`'e akar.
   Parse edilemeyen SQL'de formatter hata atarsa yakalanır → toast "Couldn't
   format (invalid SQL)", metin dokunulmaz.
3. **Toolbar/palette:** palette'e "Format SQL" eylemi (keşfedilebilirlik); Toolbar'a
   opsiyonel küçük ikon (kapsam: palette yeter, ikon istenirse).

### Kabul

- Editörde SQL yazıp Ctrl+K: SQL okunaklı biçimde yeniden yazılır (anahtar
  kelimeler büyük, girintili); tek Ctrl+Z ile geri alınır.
- Seçim varken Ctrl+K yalnız seçimi formatlar.
- Bozuk SQL'de Ctrl+K içeriği bozmaz, toast uyarır.

### Risk

- `sql-formatter` Postgres'e özgü sözdizimini (ör. `::` cast, `$$` gövde,
  dollar-quoted) her zaman kusursuz formatlamayabilir → dollar-quoted gövde/
  fonksiyon kaynağı gibi durumlar bozulabilir; formatter hata verirse metne
  dokunulmaz (guard). Fonksiyon kaynağı tab'larında (U3) dikkat — gerekirse
  "format" DDL/fonksiyon gövdesinde devre dışı bırakılır.
- Ctrl+K'nın çift anlamı (editörde format / dışında palette) — kabul maddesi
  editör-içi davranışı netleştirir; palette'e "Format SQL" eklenerek de erişilir.

---

## P1-Y3 — Activity butonu + DB istatistik şeridi (M4, M5)

### Analiz

- **M4 (Activity butonu):** "kim ne çalıştırıyor" görünümü **zaten var** — P1-V4
  Activity paneli (`pg_stat_activity`, sidebar 3. sekme). Eksik olan Toolbar'da
  Run yakınında hızlı bir giriş. `uiStore.setSidebarTab("activity")` + sidebar
  görünür yap → tek buton. (Palette'te "Show server activity" de var; bu onun
  Toolbar muadili.)
- **M5 (DB istatistikleri — CPU/RAM gerçeği):** **Önemli kısıt:** DB sunucusunun
  **CPU ve RAM kullanımı düz SQL ile alınamaz.** `pg_stat_activity`/katalog host
  metriklerini vermez; CPU/RAM için sunucu-taraflı bir uzantı gerekir
  (`pgnodemx` — bazı managed sağlayıcılarda; `system_stats`; ya da OS erişimi).
  Railway/RDS gibi ortamlarda bunlar **genelde YOK**. Dürüst plan: SQL ile
  **güvenilir** alınabilenleri göster, CPU/RAM'i ancak uzantı varsa göster, yoksa
  atla/"n/a". Güvenilir metrikler:
  - **Aktif/toplam bağlantı:** `SELECT count(*) FROM pg_stat_activity WHERE
    backend_type='client backend'` + `SHOW max_connections` → "12 / 100 conns".
  - **Cache hit oranı:** `pg_stat_database` (blks_hit / (blks_hit+blks_read)) —
    CPU/RAM proxy'si sayılabilir (bellek verimliliği).
  - **DB boyutu:** `pg_database_size(current_database())`.
  - (Opsiyonel) **TPS/commit oranı:** iki örnek arası `xact_commit` farkı — 30 sn
    aralıkla türetilebilir; v1'de kapsam dışı bırakılabilir.
  - **CPU/RAM:** yalnız `pgnodemx`/`system_stats` mevcutsa (capability tespiti:
    ilgili fonksiyon/uzantı var mı) — yoksa gösterilmez. Kullanıcıya net: "CPU/RAM
    yalnız sunucuda uygun uzantı varsa".

### Plan

1. **Backend — `db_stats { connection_id } → DbStats`:**
   ```rust
   pub struct DbStats {
     active_connections: i64,
     max_connections: Option<i64>,   // SHOW yetkisi yoksa None
     cache_hit_ratio: Option<f64>,   // 0..1
     db_size_bytes: Option<i64>,
   }
   ```
   Tek round-trip (birkaç subquery tek SELECT'te). On-demand, cache dışı.
   **CPU/RAM alanları YOK** — 2026-07-04 Q&A kararı: tamamen kapsam dışı
   (uzantı tespiti kodu da yazılmaz; bkz. §6).
2. **StatusBar (M5):** versiyon (`v0.0.1`) etiketinin **soluna** kompakt bir şerit:
   `⚡12/100 · 98% cache · 2.3 GB`. Aktif
   *tab'ın* bağlantısına bağlı; `useEffect` ile **30 sn** poll (`db_stats`),
   bağlantı/tab değişince sıfırlanır. Bağlantı yoksa/koptuysa şerit gizli. Tooltip'te
   tam açıklamalar (max_connections, cache hit tanımı).
3. **Toolbar (M4):** Run grubunun yanında bir `Activity` ikon-butonu (lucide
   `Activity`) → `uiStore` sidebar'ı görünür yap + `setSidebarTab("activity")`.
   Tooltip "Server activity — who's running what".

### Kabul

- Run yakınındaki Activity butonu tıklanınca sidebar Activity sekmesine geçer
  (gizliyse sidebar açılır).
- StatusBar'da versiyonun solunda aktif bağlantı sayısı + cache hit + DB boyutu
  30 sn'de bir güncellenerek görünür; bağlantı yoksa şerit yok.
- Şeritte CPU/RAM YOK (kapsam dışı); düşük yetkili kullanıcıda alınamayan alanlar
  "—" ile atlanır, hata basılmaz.

### Risk

- 30 sn poll her tab/bağlantıda ayrı sorgu — ucuz (tek SELECT); yalnız aktif tab'ın
  bağlantısı için koşar, arka plan bağlantıları için değil.
- `SHOW max_connections` + `pg_stat_database` düşük yetkili kullanıcıda kısıtlı
  olabilir → alanlar `Option`/"—" ile güvenli döner (hata değil).

## 4. Sözleşme değişiklikleri (design/02'ye — uygulanınca)

| Değişiklik | Milestone |
|---|---|
| `db_stats { connection_id } → DbStats` | Y3 |
| (Y1/Y2 backend'e dokunmaz; `sql-formatter` yalnız frontend bağımlılığı) | — |

## 5. Test yaklaşımı

- **Saf/unit:** `formatSql` (birkaç örnek; bozuk SQL guard) — frontend; `db_stats`
  SQL kurulumu + capability tespiti (Rust unit + canlı-DB `--ignored`: alanlar dolu,
  CPU/RAM uzantısızsa None).
- **Elle duman:** grid sütun sürükleme + hizalama; sidebar tutamak affordance;
  Ctrl+K format (seçim/tam/bozuk); Activity butonu; StatusBar şeridi 30 sn güncelleme
  (uzantısız DB'de CPU/RAM'in yokluğu).

## 6. Bilinçli kapsam dışı

| Ne | Neden | Ne zaman |
|---|---|---|
| **Host CPU/RAM (tamamen — uzantı tespiti dahil)** | Kullanıcı kararı (2026-07-04 Q&A): düz SQL ile alınamaz; pgnodemx/system_stats tespit kodu da yazılmayacak | Ayrı iş, talep olursa |
| Grid sütun genişliklerinin kalıcılığı | v1 oturumluk yeter | Talep olursa (sorgu-imzası bazlı) |
| TPS/commit-rate grafiği | İlk şerit statik metriklerle yeter | Genişletme turunda |
| Formatter ayarları (keyword case, indent) UI'ı | Makul varsayılan yeter | Ayarlar büyürse |

## 7. Finalize kararları (2026-07-04 Q&A, kullanıcı onayladı)

1. **Sıra (19+20 birleşik):** X1 → X2 → X3 → Y1 → Y2 → Y3 → X4 → **v0.0.2**
   (sürüm iki belgeyi birden kapsar). Detay: design/19 §7.
2. **CPU/RAM tamamen kapsam dışı** — `DbStats`'te alan yok, uzantı tespiti yok;
   şerit = aktif/max bağlantı + cache hit + DB boyutu.
3. **Ctrl+K:** editör odaklıyken format, dışarıda palette (plandaki ana öneri);
   palette'e "Format SQL" eylemi eklenir. Shift+Alt+F eklenmez.
