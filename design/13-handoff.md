# 13 — Oturum Devir Notu (Handoff)

> Tarih: 2026-07-04. Bu dosya "nerede kaldık, sırada ne var" sorusunu yeni bir
> oturumun (veya ileride kendimin) soğuk başlangıçta cevaplayabilmesi için var.
> Tek gerçek kaynak yine kod + design/00–12; bu dosya onlara yönlendiren harita.

## 1. Şu anki durum (main branch)

- **Faz 0 (M0–M3) tamamlandı** ve **design/11 refactor + sertleştirme main'e merge edildi** (merge commit `Merge phase0-refactor: …`).
- **Faz 1, P1-M1 (multi-connection eşzamanlı + hızlı geçiş) tamamlandı** (2026-07-04, commit `feat(P1-M1): …`). Tab artık kalıcı `connectionId` taşıyor; Explorer/StatusBar/CommandPalette/ConnectionMenu/Toolbar/TabBar/Monaco completion+peek hepsi aktif *tab'ın* bağlantısını takip ediyor (global `activeConnectionId` yalnız "yeni tab" varsayılanı). Yeni `ConnectionClosedBanner` + Ctrl+K/menü "switch connection" ile disconnect sonrası tab yeniden bağlanabiliyor. Yüksek-efor 5-açılı paralel kod incelemesi 8 gerçek bulgu çıkardı ve hepsi düzeltildi — en ciddisi: bağlantı bir açık tx ortasında koparsa tab'ın sonsuza dek kilitlenmesi (`releaseTabsForConnection` ile çözüldü) ve `setConnection`'ın açık bir sunucu-cursor'u (hasMore) görmezden gelip çapraz-bağlantı fetchMore/closeResult'a yol açması.
- Kapanış kapısı **yeşil**: 39 Rust unit testi (3 canlı-DB testi `--ignored`), `cargo clippy --all-targets -- -D warnings` temiz, `cargo fmt --check` temiz, `tsc --noEmit` temiz, `npm run build` (vite) geçiyor.
- `phase0-refactor` branch'i merge sonrası **silinebilir** (`git branch -d phase0-refactor`).
- Yüksek-efor kod incelemesi yapıldı; 4 gerçek bug bulunup düzeltildi (cursor-yolu marker offset, tab-kapatmada başarısız commit, bayat grid, refresh-bayrağı panik sızıntısı) — commit `fix(review): …`.
- **Elle doğrulandı (kısmen):** `npm run tauri dev` ile canlı bir Postgres'e (Railway, `.env`'deki `TEST_DB_URL`) bağlanıp connect/schema-refresh/run_query akışı gözle test edildi, sorunsuz. Bu sırada `cargo test -- --ignored` da gerçek DB'ye karşı koşturuldu ve H2-sonrası hâlâ eski sözleşmeyi bekleyen bir test (`cancel_long_query`) bulunup düzeltildi (commit `fix(test): …`) — P1-M1 ile ilgisiz, bağımsız bug.
- **GUI testinden çıkan bulgular design/14'e yazıldı** (ham backlog, henüz planlanmadı). **Önemli:** design/14 §2, P1-M1'in `ConnectionMenu.bindActiveTab` davranışıyla (üstten bağlantı seçince aktif tab'ı da rebind etme) kullanıcı beklentisinin ÇELİŞTİĞİNİ not ediyor — sonraki derin planlamada öncelikli gözden geçirilmeli.

**Kodun güncel şekli** (design/11'den sonra):
- Rust: `lib.rs`(`ariadne_lib`)+ince `main.rs`; `db/` = pool+types+classify+rows+exec; `complete/` = mod+lexer+context+candidates; `cache/` = mod+catalog+snapshot; `logging.rs`; komutlar ince.
- Frontend: `App.tsx` saf kompozisyon; `components/layout/`(Toolbar,StatusBar,ResizeHandle,CommandPalette), `components/query/`(ResultArea,CloseTabDialog,…), `components/explorer/`(Explorer,tree,icons,NodeRow,PeekPanel); `lib/`(shortcuts,errors,events,api).

## 2. Nasıl çalıştırılır / doğrulanır

- **Çalıştır:** yeni terminalde `npm run tauri dev` (cargo PATH'te, `LIBCLANG_PATH` kalıcı). Harness bash'inde önce: `export PATH="$USERPROFILE/.cargo/bin:$PATH"; export LIBCLANG_PATH="/c/Program Files/LLVM/bin"`.
- **Doğrula:** `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`; kökte `npx tsc --noEmit` ve gerekirse `npm run build`.
- **Canlı-DB testleri:** `ARIADNE_DATABASE_URL` set + `cargo test -- --ignored` (salt-okunur + TEMP tablo; kullanıcı verisine dokunmaz).
- DB uygulama içinden bağlantı diyaloğuyla seçilir (şifre OS keychain'e). `ARIADNE_LOG=debug` ile ayrıntılı log.

## 3. Sırada ne var — Faz 1 (design/12)

Kullanıcı önceliğiyle sıralı (Q&A 2026-07-04). Her milestone "çalışan uygulama bırakır".

1. ~~**P1-M1 — Multi-connection eşzamanlı + hızlı geçiş**~~ ✅ **tamamlandı**, elle test edildi (yukarı bakın).
2. ~~**P1-M1.5 — design/14'teki GUI backlog'unun derin planlaması.**~~ ✅ **Plan yazıldı (2026-07-04): design/15** (P1-U1…U4 milestone'ları; U1 = tab↔connection semantik düzeltmesi — pristine-tab kuralı — öncelikli) ve **design/16** (kullanıcı senaryoları + Ö1–Ö8 önerileri; Ö5/Ö1/Ö7 ilgili U-milestone'lara iliştirilecek). **Buradan başla: P1-U1'i uygula** (design/15 §P1-U1), sonra U2→U3→U4, sonra P1-M2.
3. **P1-M2 — Yerel SQLite depo + cache disk persist** (design 12 §P1-M2). `rusqlite` + `store/` modülü; cache build-girdilerini `postcard` ile diske yaz, `connect`'te load-then-refresh. Bu depo M4 history'nin de altyapısı.
4. **P1-M3 — Okunaklı EXPLAIN (ANALYZE)** (design 12 §P1-M3). `classify` zaten `ExplainStmt` görüyor; `StatementResult::Explain{plan_json}` + ağaç UI; DML'de ANALYZE otomatik `BEGIN…ROLLBACK` sarmalı.
5. **P1-M4 — Query history + snippets**, **P1-M5 — konfor paketi** (force kill, tam CSV export, hücre tam-değer, frequency ranking, açık tema).

Sözleşme değişiklikleri (02'ye işlenecek) özeti design/12 §4'te.

## 4. Açık kararlar / dikkat edilecekler

- **CI/testcontainers/criterion: kullanıcı şimdilik istemedi** (tek geliştirici, lokal `cargo test` yeterli). Release/paylaşım fazında yeniden değerlendir.
- **Windows integration-test kısıtı (design/11 R1 notu):** `tests/`'ten tam Tauri uygulamasını linkleyen testler Windows'ta yüklenemiyor (`STATUS_ENTRYPOINT_NOT_FOUND`). Saf DB/cache/complete mantığını Windows'ta da `tests/`'ten test etmek istenirse, bunları Tauri'siz bir **`core` crate**'e almak gerekir (workspace split — design 01 §4 tetikleyicisi ilk kez oluştu). Faz 1'de P1-M2'nin `store/` işiyle birlikte değerlendirilebilir.
- **Faz 0 çıkış ölçümleri hâlâ elle yapılacak:** cold start < 1 sn, idle RAM < 200 MB (design 01 §7, 10 çıkış kriteri). Ölçüm sonuçları design/10'a işlenmeli.
- **Bilinçli ertelenenler** (design/11 §6, 12 §6): sistem-şema nesneleri cache dışı, kısmi şema refresh, auto-update/release pipeline (09), inline edit, SQL formatter, SSH tüneli.

## 5. Yeni oturum "start here"

> "design/13'ü, design/15'i ve design/16'yı oku; **P1-U1'i uygula** (design/15
> §P1-U1 — tab↔connection semantiği: pristine-tab kuralı, focusConnection,
> Databases ▸; + design/16 Ö5 read-only rozeti). Sonra U2 (+Ö1/Ö7) → U3 → U4,
> sonra Faz 1 P1-M2'ye (yerel SQLite depo, design/12 §P1-M2) geç."

Memory: `m0-status.md` güncel durumu tutuyor.
