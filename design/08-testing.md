# 08 — Test Stratejisi

İlke: **test ağırlığı, riskin olduğu yerde.** Risk sıralaması: (1) completion doğruluğu, (2) cursor/cancel yaşam döngüsü, (3) cache kurulumu. UI görselliği en düşük risk → en az e2e.

## 1. Rust unit testleri (en kalın katman)

Mimari gereği `complete/` ve `cache/` Tauri'den bağımsız saf modüller — DB'siz, UI'sız test edilir.

**Completion golden testleri** (ana yatırım):

```rust
// fixture: elle kurulmuş küçük SchemaCache (users, orders, FK: orders.user_id → users.id, 2 fonksiyon)
case!("SELECT | FROM users",            clause: SelectList, has: ["id","email"]);
case!("SELECT u.| FROM users u",        qualifier: "u", has: ["email"], not_has: ["orders"]);
case!("SELECT * FROM |",                clause: From, has: ["users","orders"]);
case!("SELECT * FROM users u JOIN |",   first: "orders o ON o.user_id = u.id");  // FK-güdümlü
case!("SELECT * FROM users WHERE |",    clause: Where);
case!("WITH x AS (SELECT 1 a) SELECT | FROM x", has: ["a"]);            // CTE
case!("SELECT (SELECT | FROM orders o) FROM users u", has: ["u.email"]); // correlated scope
case!("SELECT '| ' FROM users",         empty);                          // string içi
case!("INSERT INTO users (|",           clause: InsertCols);
```

`|` = imleç. Bu tablo büyüdükçe autocomplete'in regresyon zırhı olur; her bug önce buraya case olarak düşer, sonra fix'lenir. Onarım kademeleri (04 §2) için ayrıca: her case hem tam hem kesik (parse edilemeyen) haliyle koşturulur.

**Diğer unit alanları**: catalog satırlarından cache kurulumu (sabit fixture satırları → beklenen struct'lar), fuzzy matcher skorlaması, `pg_get_function_arguments` string parser'ı, quoted identifier kuralları, AriadneError map'lemeleri, **tx state machine** (BEGIN/COMMIT/ROLLBACK/SAVEPOINT dizileri + hata → Aborted geçişleri, 05 §7), **destructive guard tespiti** (WHERE'siz UPDATE/DELETE/TRUNCATE; WHERE'lisi ve CTE'li varyantlar false-positive vermemeli, 05 §8).

> 💡 **Rust notu.** Test aynı dosyanın dibinde `#[cfg(test)] mod tests` içinde yaşar; `cargo test` hepsini koşar. Golden case'ler için `rstest` crate'inin parametrize testleri tablo yazımını çok kısaltır.

## 2. Rust integration testleri (gerçek Postgres)

- `testcontainers` crate ile Docker'da Postgres (16 ve 17 matrix'i) ayağa kalkar; `tests/` klasöründe.
- Kapsam: catalog sorgularının gerçek DB'de doğru cache üretmesi (migration'la kurulmuş bilinen şema), cursor aç/fetch/close döngüsü, cancel'ın gerçekten `57014` düşürmesi (uzun `pg_sleep` sorgusu iptal edilir), çoklu statement script'i, timeout yolu, reconnect sonrası davranış, **çok adımlı transaction akışı** (BEGIN → ayrı run_query'lerle DML → ROLLBACK → verinin değişmediği doğrulanır; aborted tx'te `25P02` yolu).
- CI'da koşar; lokalde `cargo test --test integration -- --ignored` ile opsiyonel (Docker gerektirir).

## 3. Frontend testleri (ince katman)

- **Vitest + React Testing Library**: store logic'i (tab aç/kapa/dirty, sayfa biriktirme, 100k satır sınırı), `lib/errors.ts` yönlendirmesi, fuzzy-search filtre görünümü.
- Tauri `invoke` mock'lanır (`@tauri-apps/api/mocks`).
- Monaco/arborist/grid render detayları test edilmez — kütüphane davranışını test etmenin değeri yok.

## 4. E2E (en ince katman)

- **Faz 0: sadece 1 smoke test** — WebDriver (`tauri-driver`) Windows'ta çalışır: uygulama açılır → test container'a bağlanır → `SELECT 1` koşar → grid'de "1" görünür. Bu test paketleme regresyonlarını (WebView2, bundle) yakalar.
- Senaryo e2e'leri (tab yönetimi, autocomplete UI'ı) bilinçli olarak yazılmaz: kırılganlık/maliyet oranı kötü; aynı güvence unit katmanından geliyor.

## 5. Performans regresyon ölçümleri

01 §6'daki bütçeler için:
- `criterion` bench: completion p95 (< 10ms), 10k-tabloluk sentetik cache'te aday üretimi, cache kurulum süresi.
- Manuel checklist (release öncesi): cold start kronometresi, Task Manager RAM, 500-tablo tree açılışı.

## 6. CI (GitHub Actions)

```
push/PR → [fmt + clippy -D warnings] → [cargo test (unit)] → [vitest]
        → [integration (Linux runner, Docker)] → [tauri build (Windows runner) — artifact üret]
```

Windows build her PR'da koşar: libpg_query'nin MSVC derlemesi kırılırsa anında görülür (00 §7'deki risk).
