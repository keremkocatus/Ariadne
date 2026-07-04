# 11 — Faz 0 Refactor & Sertleştirme Planı

> Tarih: 2026-07-04. Faz 0 (M0–M3) tamamlandıktan sonra, Faz 1'e girmeden yapılan
> kod incelemesinin çıktısı. Karar (Q&A): kapsam = **yapısal refactor + design
> sapmalarını kapatan sertleştirme** birlikte. CI/testcontainers/criterion bilinçli
> olarak ertelendi (§6).

## 1. İnceleme özeti: neler iyi, neler borç

**İyi olan (değişmeyecek):** Kod, design 01 §4'teki iskeleti izliyor. `commands/`
ince IPC katmanı; iş mantığı `db/`, `cache/`, `complete/`, `profiles/` içinde ve bu
modüller Tauri'den habersiz. Cache immutable snapshot + `ArcSwap` (lock'suz okuma),
completion tamamen Rust'ta, 23 saf unit test + canlı DB testleri mevcut. Tek crate
kararı korunuyor — workspace tetikleyicileri (derleme > 60 sn, ikinci tüketici)
oluşmadı (01 §4).

**Borçlar iki sınıf:**

| Sınıf | Ne | Neden şimdi |
|---|---|---|
| Yapısal | `lib.rs` yok (sadece `[[bin]]`), 650+ satırlık dosyalar, `state.rs`'te DB işi, frontend'de şişkin `App.tsx`/`Explorer.tsx` | Faz 1 tam bu dosyalara ekleme yapacak (EXPLAIN, kill, export, multi-connection). Bölmeden eklersek "her şey birkaç dosyada" sorunu doğar |
| Davranışsal (design sapması) | Hata marker'ı çalışmıyor, kısmi sonuç kayboluyor, tx'li tab sessiz rollback, logging yok... (§4 tablosu) | Design 00: "çelişki çıkarsa önce karar güncellenir, sonra kod" — bunlar güncellenmemiş karar değil, yarım bırakılmış implementasyon |

## 2. İlkeler

1. **Her adım sonunda uygulama çalışır ve `cargo test` yeşildir** (roadmap'in milestone felsefesiyle aynı).
2. Yapısal adımlar (R\*) **davranış değiştirmez** — sadece kod taşıma/bölme. Sertleştirme adımları (H\*) davranış ekler ve mümkünse test getirir.
3. Her R/H maddesi ayrı commit; refactor ile davranış değişikliği aynı commit'e girmez.
4. Modül bölerken kural: **dosya boyutu değil, sorumluluk sınırı.** Bir dosya tek soruyu cevaplamalı ("bu modül ne yapar?" tek cümle).

> 💡 **Rust notu — modül bölmek ucuzdur.** Rust'ta `exec.rs`'i `exec/` klasörüne
> çevirmek (`exec/mod.rs` + alt dosyalar) sadece dosya taşıma + `mod` satırlarıdır;
> import eden taraf `crate::db::exec::run_query` yolunu aynen kullanmaya devam eder.
> Bu yüzden bölme işlemleri risksizdir — derleyici hiçbir kullanımın kırılmasına izin vermez.

## 3. Yapısal refactor (R1–R6)

### R1 — `lib.rs` + ince `main.rs` (en önemli yapısal adım)

Şu an crate yalnızca binary hedefi (`[[bin]]`). Sorun: Rust'ta `tests/`
klasöründeki integration testler crate'i ancak **library** olarak import edebilir.
Faz 1'de gerçek-DB integration testleri (08 §2) yazılabilsin diye şimdiden:

```
src-tauri/src/
├── main.rs      # 4 satır: fn main() { ariadne_lib::run() }
├── lib.rs       # mod'lar + pub fn run() (tauri::Builder buraya taşınır)
└── (diğer modüller aynen)
```

`Cargo.toml`'a `[lib] name = "ariadne_lib"` eklenir (bin ile aynı `ariadne` adı
Windows'ta çıktı dosyası çakışması yaratır; `_lib` soneki Tauri v2'nin standart
şablonudur). *Kabul: `cargo build` + uygulama açılışı aynen çalışır; 34 unit test
artık lib hedefi (`ariadne_lib`) altında koşar.*

> ⚠️ **Uygulama bulgusu (2026-07-04, Windows):** `tests/` klasöründeki bir binary
> `ariadne_lib::run`'a (dolayısıyla tüm Tauri/WebView2 COM runtime'ına) referans
> verdiğinde exe **yüklenemiyor** (`STATUS_ENTRYPOINT_NOT_FOUND`, 0xc0000139) —
> `ariadne_lib`'e sembol referansı vermeyen test ise sorunsuz koşuyor (linker
> webview runtime'ını strip ediyor). Yani lib split unit testler için tam çalışır,
> ama **tam Tauri uygulamasını linkleyen integration testler Windows'ta lokal
> koşamaz.** Bunun iki sonucu: (a) Faz 1 gerçek-DB integration testleri zaten 08 §2
> gereği Linux CI'da koşacak (orada bu sorun yok); (b) DB/cache/complete saf
> mantığını Windows'ta da `tests/`'ten test edebilmek, bunları Tauri linklemeyen
> ayrı bir `core` crate'e almayı gerektirir — yani **workspace split tetikleyicisi**
> (01 §4) bu ihtiyaçla birlikte ilk kez somutlaştı. Karar Faz 1'e (12) bırakıldı;
> Faz 0'da saf modüller `#[cfg(test)]` in-crate unit testleriyle korunmaya devam eder.

### R2 — `db/` yeniden düzenleme

`db/exec.rs` (656 satır) dört ayrı sorumluluk taşıyor. Bölünme:

```
db/
├── mod.rs        # dış API re-export'ları + touches_schema
├── pool.rs       # build_pool + map_ssl  ← state.rs'ten TAŞINIR (DB işi DB'de)
├── types.rs      # IPC sözleşme tipleri: RunResult, StatementResult, Page,
│                 # ColumnMeta, TxStatus, Confirmation (design 02 §3)
├── classify.rs   # StmtInfo, classify(), first_keyword, stmt_returns_rows
│                 # + destructive/tx unit testleri buraya
├── rows.rs       # read_rows (PgRow → text cells, 8KB kesme)
└── exec.rs       # SADECE yaşam döngüsü: ExecRegistry, TabState, run_query,
                  # fetch_page, cancel, close_result (+ canlı DB testleri)
```

`state.rs` sonrası: yalnızca `AppState`, `ActiveConnection`, `ConnectionInfo` —
paylaşılan state tanımı, başka hiçbir şey. *Kabul: davranış birebir; tüm testler
taşındıkları modülde yeşil.*

### R3 — `complete/` bölünmesi

`context.rs` (699 satır) içinden gerçek lexer katmanı ayrılır:

```
complete/
├── mod.rs        # orchestration + IPC tipleri (mevcut)
├── lexer.rs      # Tok, TokKind, tokenize(), classify(), statement_bounds,
│                 # match_paren, split_items  ← pg_query::scan sarmalayıcısı
├── context.rs    # Clause/StmtKind/RelRef/CompletionContext, analyze(),
│                 # identifier_at, call_context, extract_relations, CTE çıkarımı
└── candidates.rs # (mevcut — dokunulmaz)
```

Gerekçe: Faz 1'deki "completion ranking'e kullanım frekansı" ve schema-qualified
öneriler `context`/`candidates`'a dokunacak; lexer ise stabil altyapı. *Kabul: 23
test aynen geçer.*

### R4 — `cache/` (hafif dokunuş)

Mevcut bölünme (model `mod.rs`, sorgular `catalog.rs`) doğru. Tek iş: frontend'e
giden `SchemaSnapshot`/`Snap*` tipleri `cache/snapshot.rs`'e alınır (`to_snapshot`
dahil) — Faz 1 disk persist eklerken `cache/persist.rs` bunun yanına gelecek ve
`mod.rs` model tanımı olarak yalın kalacak.

### R5 — Görünürlük ve hijyen

- Modül-içi yardımcılar `pub` → `pub(crate)`/private'a indirilir (dış API bilinçli seçilir).
- `#[allow(dead_code)]`'lar gözden geçirilir: H\* adımlarında kullanılmaya başlayanlar (örn. `estimated_rows` guard'da, `position`/`hint` hata yolunda) temizlenir; kalanlar Faz 1 planına referans verir.
- `rustfmt` + `cargo clippy -- -D warnings` lokal alışkanlık olarak sıfır uyarıya çekilir (CI yok ama disiplin var).

### R6 — Frontend yapısal düzen

| Dosya | Sorun | Bölünme |
|---|---|---|
| `App.tsx` (280) | Layout + toolbar + sonuç alanı + resize + global kısayollar tek yerde | `components/layout/Toolbar.tsx`, `StatusBar.tsx`, `ResizeHandle.tsx`; `ResultArea` → `components/query/ResultArea.tsx`; global kısayollar `lib/shortcuts.ts` (tek kayıt noktası — Faz 1 palette de buraya bağlanacak) |
| `Explorer.tsx` (447) | Tree kurulumu + fuzzy düzleştirme + node renderer + peek tek dosyada | `explorer/buildTree.ts` (saf fonksiyonlar: `buildTree`, `flatten`), `explorer/NodeRenderer.tsx`, `explorer/PeekPanel.tsx`; `Explorer.tsx` orkestrasyon |
| `tabsStore.ts` | `patchQuery(set: any, ...)` tip kaçağı | `StoreApi<TabsState>["setState"]` ile tiplendirilir |
| hata sunumu | `AriadneError` gösterimi component'lerde dağınık (07 §5 kural 2: tek yerde normalize) | `lib/errors.ts`: `kind`→sunum kararı + sqlstate→insan-dili başlık tablosu (~20 kod, 06 §5). H1 ile birlikte gelir |

## 4. Sertleştirme (H1–H8): design sapmalarını kapatma

Sıra = günlük kullanım değeri. Her madde ilgili design bölümüne bağlı; design
değişmiyor, kod design'a getiriliyor.

### H1 — Hata `position`/`hint` çıkarımı → Monaco marker'ı gerçekten çalışsın (design 02 §2, 06 §5)

Tespit: `From<sqlx::Error>` hiçbir zaman `position`/`hint` doldurmuyor; frontend
marker altyapısı hazır ama hep `None` geliyor. M3 kabul kriteri ("hata → editör
marker") fiilen yarım.

- `sqlx::error::DatabaseError` → `PgDatabaseError`'a downcast; `.position()`, `.hint()`, `.detail()` alanları `AriadneError`'a taşınır.
- Çoklu statement script'inde offset düzeltmesi: Postgres position'ı **statement-içi** verir; `run_query` statement'ın script içindeki başlangıç offset'ini bilir → toplanıp mutlak offset gönderilir (aksi halde marker yanlış satıra düşer).
- Frontend `lib/errors.ts` (R6) sqlstate başlık tablosunu uygular.
- Test: kasıtlı bozuk SQL ile position'ın delta'landığı unit test (canlı DB, `--ignored`).

### H2 — Statement hatasında kısmi sonuç korunur (design 05 §1)

Tespit: script'in 3. statement'ı patlarsa ilk ikisinin sonucu da atılıyor (komple
`Err` dönüyor); psql davranışı "o ana kadarki sonuçlar + hata"dır.

- `RunResult`'a `error: Option<AriadneError>` (+ `error_statement_index`) eklenir; hata durumunda `Ok(RunResult { statements: <biriken>, error: Some(..) })` döner.
- `api.ts` + `tabsStore.run` sözleşme güncellemesi: hata VE satırlar birlikte gösterilebilir (grid + hata bandı).
- Not: tx `Aborted` geçişi mevcut davranışıyla korunur.

### H3 — `disconnect` çalışan sorguları iptal eder + tab session'larını kapatır (design 02 §3)

Tespit: `disconnect` sadece pool kapatıyor; `running` map'i ve açık cursor/tx'ler
temizlenmiyor (pool drop TCP'yi kapattığı için sunucu tarafı güvenli, ama registry
sızıntısı + UI'da hayalet durum kalıyor).

- `ExecRegistry::shutdown(pool)`: tüm `running` PID'lerine `pg_cancel_backend`, tüm tab'larda `close_cursor` + `ROLLBACK`, map'ler boşaltılır; `disconnect` pool kapatmadan önce bunu çağırır.

### H4 — Açık tx'li tab kapatılırken onay diyaloğu (design 05 §7)

Tespit: `closeTab` → `close_result` sessizce ROLLBACK ediyor. Design: **Commit /
Rollback / Vazgeç** diyaloğu.

- `tabsStore.closeTab`: tab'ın `txStatus !== "idle"` ise diyalog; seçime göre `txControl` sonrası kapatma. Backend değişikliği yok (`run_query("COMMIT")` yolu zaten var).

### H5 — `tracing` altyapısı (design 01 §6)

- `tracing` + `tracing-subscriber` + `tracing-appender`: dev'de konsol, prod'da `app_log_dir`'de günlük dönen dosya (7 gün). Seviye env ile (`ARIADNE_LOG=debug`).
- Kurallar koda işlenir: SQL metni yalnız `debug`'da; `info`'da süre/satır sayısı; şifre/connection string hiçbir seviyede (06 §2). `eprintln!` kalıntıları silinir.
- Faz 1'deki "Internal hata → son 50 log satırı" için altyapı hazır olur.

### H6 — Destructive guard'a satır tahmini (design 05 §8, 07 §3)

Tespit: `Confirmation.estimated_rows` hep `None`; cache'te `estimated_rows` verisi
duruyor. `run_query` guard tetiklendiğinde tabloyu `SchemaCache`'ten çözer
(`resolve_named` zaten var), tahmini doldurur → diyalog "~2.1M satır etkilenecek"
diyebilir.

### H7 — Cursor hijyeni: 15 dk idle auto-close + refresh debounce (design 05 §2, 03 §5)

- `TabState`'e `last_fetch_at`; periyodik (60 sn) tokio task'ı 15 dk idle cursor'ları `CLOSE` + iç tx commit eder; frontend'e `result:frozen` event'i → grid'de "sonuç dondu — yeniden çalıştır" bandı. Kullanıcı tx'i varken **dokunulmaz** (sadece iç READ ONLY tx kapatılır). Risk kaydındaki "vacuum etkisi" önlemi budur.
- `spawn_cache_refresh`: bağlantı başına `refreshing` bayrağı (AtomicBool) — çalışan refresh varken yeni istek birleştirilir.

### H8 — Kısayol/UX tamamlama (design 07 §3, Faz 0 setinden eksik kalanlar)

- `Ctrl+R`: sonuç panelini gizle/göster (uiStore'a `resultsVisible`).
- `Esc`: sorgu koşarken cancel.
- `Ctrl+K` command palette (`cmdk` zaten bundle'da): bağlantı değiştir / tablo aç / komutlar. Monaco chord çakışması design'daki kuralla (editör odaklıyken chord öncelikli).
- Son açık tab'ların SQL'i persist edilir (tabsStore'a `partialize`'lı persist — sonuçlar asla persist edilmez, 07 §1).
- Not: `localStorage` persist'i Faz 0'da kalır (WebView2 profilinde kalıcı); Tauri fs adapter'ına geçiş Faz 1'de multi-connection persist işiyle birlikte.

## 5. Uygulama sırası ve commit planı

```
1. R1 lib.rs            (yarım gün — tamamen mekanik)
2. R2 db/ bölünmesi     (yarım gün)
3. R3 complete/ + R4 cache/ (yarım gün)
4. R5 hijyen            (clippy sıfırlama dahil)
5. R6 frontend bölünmesi
6. H1 hata marker'ı     ← kullanıcıya görünür ilk kazanım
7. H2 kısmi sonuç
8. H3 disconnect + H4 tx onayı
9. H5 tracing
10. H6 guard tahmini + H7 cursor hijyeni
11. H8 UX tamamlama
```

Toplam kabaca 4–6 iş günü. Her madde bağımsız commit; 6'dan itibaren her commit
`cargo test` + elle duman testi (bağlan → sorgu → hata → iptal) ile doğrulanır.

**Çıkış kriteri:** `cargo clippy -- -D warnings` temiz; tüm testler yeşil; bozuk
SQL'de Monaco'da doğru konumda kırmızı marker; script hatasında önceki sonuçlar
görünür; tx'li tab kapatınca diyalog; log dosyası dönüyor.

## 6. Bilinçli ertelenenler

| Ne | Neden | Nereye |
|---|---|---|
| CI (GitHub Actions), testcontainers integration, criterion bench | Karar (Q&A 2026-07-04): tek geliştirici + lokal `cargo test` yeterli | Release/paylaşım fazı (09 ile birlikte); R1 sayesinde altyapı hazır |
| Sistem şemalarının nesneleri cache'e alınmaz | catalog.rs'te belgeli bilinçli sapma | Faz 1+ (cache persist işiyle birlikte değerlendirilir) |
| Kısmi şema refresh (`refresh_schema {schema}`) | Design 03 §4 Faz 0 der ama tam refresh dev şemalarda henüz yeterince hızlı | Faz 1 cache işleri (12 §M2) |
| Workspace'e bölme | Tetikleyiciler oluşmadı (01 §4) | Tetikleyici oluşursa |
| Faz 0 çıkış ölçümleri (cold start < 1 sn, RAM < 200 MB, 1 hafta pgAdmin'siz) | Refactor değil kullanım işi | Refactor bitince elle ölçüm — sonuçlar 10'a işlenir |
