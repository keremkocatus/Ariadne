# 13 — Oturum Devir Notu (Handoff)

> Tarih: 2026-07-04. Bu dosya "nerede kaldık, sırada ne var" sorusunu yeni bir
> oturumun (veya ileride kendimin) soğuk başlangıçta cevaplayabilmesi için var.
> Tek gerçek kaynak yine kod + design/00–12; bu dosya onlara yönlendiren harita.

## 1. Şu anki durum (main branch)

- **Faz 0 (M0–M3) tamamlandı** ve **design/11 refactor + sertleştirme main'e merge edildi** (merge commit `Merge phase0-refactor: …`).
- Kapanış kapısı **yeşil**: 39 Rust unit testi (3 canlı-DB testi `--ignored`), `cargo clippy --all-targets -- -D warnings` temiz, `cargo fmt --check` temiz, `tsc --noEmit` temiz, `npm run build` (vite) geçiyor.
- `phase0-refactor` branch'i merge sonrası **silinebilir** (`git branch -d phase0-refactor`).
- Yüksek-efor kod incelemesi yapıldı; 4 gerçek bug bulunup düzeltildi (cursor-yolu marker offset, tab-kapatmada başarısız commit, bayat grid, refresh-bayrağı panik sızıntısı) — commit `fix(review): …`.

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

1. **P1-M1 — Multi-connection eşzamanlı + hızlı geçiş** (design 12 §P1-M1). Backend hazır; asıl iş frontend. **Kritik kırılma noktası:** `tabsStore.run` bağlantıyı çalıştırma anında `activeConnectionId`'den alıyor → tab'a kalıcı `connectionId` bağlanmalı (aksi halde "tab A'nın sorgusu yanlış sunucuda koşar"). Completion/peek Monaco provider'ları da bağlantıyı aktif tab'dan almalı. **Buradan başla.**
2. **P1-M2 — Yerel SQLite depo + cache disk persist** (design 12 §P1-M2). `rusqlite` + `store/` modülü; cache build-girdilerini `postcard` ile diske yaz, `connect`'te load-then-refresh. Bu depo M4 history'nin de altyapısı.
3. **P1-M3 — Okunaklı EXPLAIN (ANALYZE)** (design 12 §P1-M3). `classify` zaten `ExplainStmt` görüyor; `StatementResult::Explain{plan_json}` + ağaç UI; DML'de ANALYZE otomatik `BEGIN…ROLLBACK` sarmalı.
4. **P1-M4 — Query history + snippets**, **P1-M5 — konfor paketi** (force kill, tam CSV export, hücre tam-değer, frequency ranking, açık tema).

Sözleşme değişiklikleri (02'ye işlenecek) özeti design/12 §4'te.

## 4. Açık kararlar / dikkat edilecekler

- **CI/testcontainers/criterion: kullanıcı şimdilik istemedi** (tek geliştirici, lokal `cargo test` yeterli). Release/paylaşım fazında yeniden değerlendir.
- **Windows integration-test kısıtı (design/11 R1 notu):** `tests/`'ten tam Tauri uygulamasını linkleyen testler Windows'ta yüklenemiyor (`STATUS_ENTRYPOINT_NOT_FOUND`). Saf DB/cache/complete mantığını Windows'ta da `tests/`'ten test etmek istenirse, bunları Tauri'siz bir **`core` crate**'e almak gerekir (workspace split — design 01 §4 tetikleyicisi ilk kez oluştu). Faz 1'de P1-M2'nin `store/` işiyle birlikte değerlendirilebilir.
- **Faz 0 çıkış ölçümleri hâlâ elle yapılacak:** cold start < 1 sn, idle RAM < 200 MB (design 01 §7, 10 çıkış kriteri). Ölçüm sonuçları design/10'a işlenmeli.
- **Bilinçli ertelenenler** (design/11 §6, 12 §6): sistem-şema nesneleri cache dışı, kısmi şema refresh, auto-update/release pipeline (09), inline edit, SQL formatter, SSH tüneli.

## 5. Yeni oturum "start here"

> "design/13'ü oku; Faz 1 P1-M1'e (multi-connection) başla — önce tab modeline
> kalıcı `connectionId` bağla (design/12 §P1-M1 planı), sonra completion/peek yolunu
> aktif tab'ın bağlantısına çevir. Değişiklikleri branch'te commit-commit yürüt,
> her adımda cargo test + tsc yeşil kalsın."

Memory: `m0-status.md` güncel durumu tutuyor.
