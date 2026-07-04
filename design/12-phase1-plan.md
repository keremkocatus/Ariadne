# 12 — Faz 1: Analiz ve Milestone Planı

> Tarih: 2026-07-04. Ön koşul: 11'deki refactor + sertleştirme tamamlanmış olmalı
> (özellikle R1 lib.rs, R2 db/ bölünmesi ve H5 tracing — buradaki işler onların
> üstüne kurulur). Roadmap'teki (10) Faz 1 listesi geçerli; **sıralama kullanıcı
> önceliğiyle revize edildi** (Q&A 2026-07-04): multi-connection, cache persist ve
> EXPLAIN öne alındı; query history sonraya kaydı. CI/release pipeline ertelendi.

## 0. Sıralama ve gerekçe

| Milestone | İçerik | Roadmap # | Neden bu sıra |
|---|---|---|---|
| P1-M1 | Multi-connection eşzamanlı + hızlı geçiş | 2 | Kullanıcının 1. tercihi; backend zaten hazır → düşük maliyet/yüksek değer |
| P1-M2 | Yerel depo (SQLite) + cache disk persist | 3 (+1'in altyapısı) | Kullanıcı tercihi; M4'ün de (history) depo altyapısını kurar |
| P1-M3 | Okunaklı EXPLAIN (ANALYZE) görünümü | 4 | Kullanıcı tercihi |
| P1-M4 | Query history + saved snippets | 1 | Değerli ama kullanıcı önceliği düşük; M2'nin deposunu kullanır → ucuzlar |
| P1-M5 | Günlük konfor paketi (force kill, tam export, hücre görüntüleme, frequency ranking, açık tema) | 7, 8, 9 | Küçük bağımsız işler; araya serpiştirilebilir |
| Ertelenen | Auto-update + release pipeline (5), inline edit (6), formatter (10), SSH tüneli (11) | — | §6 |

Her milestone yine "çalışan uygulama bırakır" (10'daki felsefe).

---

## P1-M1 — Multi-connection eşzamanlı + hızlı geçiş

### Analiz: neredeyiz?

Backend **tasarım gereği hazır**: `AppState.connections` zaten `HashMap<ConnectionId,
Arc<ActiveConnection>>`; her bağlantının kendi pool'u, cache'i (`ArcSwap`) ve
`ExecRegistry`'si var. `schemaStore` zaten `byConnection` map'i tutuyor. İş neredeyse
tamamen frontend'de — 10'daki "mimari hazır, UI işi" tespiti doğrulandı.

**Asıl kırılma noktası:** bugün `tabsStore.run` bağlantıyı **çalıştırma anında**
`activeConnectionId`'den alıyor. İki bağlantı açıkken bu, "tab A'nın sorgusu yanlış
sunucuda koşar" hatasına açık — multi-connection'ın gerçek işi tab↔bağlantı
bağının kurulmasıdır (design 07 §2: "tab'lar bağlantıya bağlı").

### Plan

1. **Tab modeli**: `Tab`'a kalıcı `connectionId` alanı. Tab açılırken aktif bağlantıyı devralır; tab başlığına profil renk şeridi (06 §1 güvenlik özelliği) + bağlantı adı tooltip'i.
2. **Bağlantı yaşam döngüsü**: `connectionStore` çoklu aktif bağlantı listesi tutar (`activeConnectionId` sadece "yeni tab hangi bağlantıyla açılır" varsayılanıdır). `ConnectionMenu` → bağlı profiller listesi + connect/disconnect tek menüde.
3. **Explorer**: aktif *tab'ın* bağlantısını gösterir (aktif bağlantıyı değil) — tab değiştirince explorer o sunucunun şemasına döner. Üstte hangi bağlantıya bakıldığını gösteren renk şeritli başlık.
4. **Completion/peek yolu**: Monaco provider'ları `connection_id`'yi aktif tab'dan alır (bugün `activeConnectionId`'den alıyor — aynı kırılma noktası).
5. **Disconnect etkisi**: o bağlantıya bağlı tab'lar "connection closed — reconnect or switch" bandına düşer; sonuçlar korunur (salt-okunur), yeniden çalıştırma yeni bağlantı seçtirir. H3'teki `ExecRegistry::shutdown` çağrılır.
6. **Kısayol**: `Ctrl+K` palette'e (H8) "switch connection" eylemi; status bar aktif tab'ın bağlantısını renk şeridiyle gösterir.

Backend'de tek dokunuş: yok denecek kadar az — komutlar zaten `connection_id` alıyor.

**Kabul:** iki farklı sunucuya bağlıyken iki tab'da eşzamanlı sorgu koşar; tab
değiştirince explorer + completion doğru şemayı kullanır; A bağlantısı koparken B
etkilenmez; renk şeridi prod/dev ayrımını her tab'da gösterir.

**Risk:** UI state kombinatoriği (tab × bağlantı × tx). Önlem: tab'ın tüm bağlantı
bilgisi tek yerden (`tab.connectionId`) türetilir, ikinci bir "aktif" kavramı UI'da
yaşamaz.

---

## P1-M2 — Yerel depo (SQLite) + cache disk persist

### Analiz

Design 03 §4 Faz 1 opsiyonu: cache immutable snapshot olduğundan persist eklemek
yapıyı değiştirmez — doğrulandı: `SchemaCache::build` ham parçalardan kuruluyor;
persist edilecek şey **build girdileri** (schemas, tables, functions, fks,
search_path, server_version), cache'in kendisi değil. Böylece indeksler her
yüklemede yeniden hesaplanır (versiyonlama derdi yok).

**Depo kararı:** tek yerel SQLite dosyası `{app_data_dir}/ariadne.db`, `rusqlite`
ile (design 03 §4'ün öngördüğü crate). Bu depo M4'te history/snippets tablolarını
da alacak — tek dosya, tek modül: `store/` (Rust tarafında `db/`den ayrı; `db/`
Postgres'e, `store/` yerel duruma aittir).

```
store/
├── mod.rs        # bağlantı + migration (PRAGMA user_version ile)
├── schema_blob.rs# cache persist: profile_id → (server_version, fetched_at, payload)
└── (M4: history.rs, snippets.rs)
```

Payload encoding: `serde` + `postcard` (kompakt binary; JSON'a göre ~3-5x küçük,
şema evrimi `user_version` migration'ıyla yönetilir — uyumsuz sürümde blob atılır,
cache zaten yeniden çekilebilir veridir).

> 💡 **Rust notu — rusqlite sync'tir.** rusqlite çağrıları bloklar; tokio
> runtime'ında `tokio::task::spawn_blocking` içinde koşturulur (01 §2'deki kural:
> I/O async, ama *yerel* disk I/O'su kısa ve nadir olduğundan blocking pool yeterli).

### Plan

1. `store/` modülü + migration altyapısı (`user_version`).
2. **Kaydetme**: her başarılı `fetch_schema_cache` sonrası build girdileri `spawn_blocking` ile diske yazılır (key: `profile_id` — connection_id değil; connection geçici, profil kalıcı).
3. **Yükleme (load-then-refresh)**: `connect` sırasında diskte blob varsa cache anında ondan kurulur → explorer/completion 0. saniyede dolu; arka planda normal fetch koşar, bitince swap + `schema:refreshed`. Status bar diskten yüklenen cache'i "cache: 2g önce (disk)" diye işaretler — stale olduğu görünür (03 §4 staleness ilkesi).
4. **Geçersizleme**: blob `server_version` uyuşmazsa veya `user_version` migration'ı karşılamıyorsa atılır. Profil silinince blob'u da silinir.
5. Kısmi şema refresh (11 §6'dan devralınan): `refresh_schema { schema }` — 4 sorguya `WHERE nspname = $1` filtresi + mevcut snapshot kopyasına merge + swap (03 §4). Dev sunucularında tek şema tazeleme hızlanır.

**Kabul:** uygulamayı kapat-aç → bağlan → explorer ve autocomplete daha fetch
bitmeden dolu (dev şemasında < 200 ms hedef); server sürümü değişmiş profilde
sessizce tam fetch'e düşer.

**Risk:** bayat cache ile yanlış öneri. Önlem: disk cache *sadece* fetch bitene
kadarki pencereyi doldurur; kullanıcı zaten Faz 0'dan beri "cache: X önce"
göstergesine sahip.

---

## P1-M3 — Okunaklı EXPLAIN (ANALYZE) görünümü

### Analiz

Design 05 §5 kancası hazır: `classify` zaten `ExplainStmt`'i görüyor (bugün
`returns_rows=true` ile düz satır olarak akıyor). Plan JSON'u tek satır-tek kolon
döner; iş (a) bunu yapısal sonuca çevirmek, (b) ağaç UI'ı.

### Plan

1. **Backend**: `classify` EXPLAIN tespitinde statement'ı `EXPLAIN (FORMAT JSON, ...)`'a normalize eder (kullanıcı `FORMAT` yazdıysa dokunulmaz); sonuç `StatementResult::Explain { plan_json: String, analyze: bool }` olarak döner (02 §3'e yeni kind — API tek tüketicili, kırıcı değişiklik serbest).
2. **Toolbar**: Run yanında `Explain` ve `Explain Analyze` butonları (+ `Ctrl+L` / `Ctrl+M` SSMS muadili kısayollar): seçili/tam SQL'i explain önekiyle koşturur — kullanıcının SQL'ine kalıcı dokunuş yok.
3. **ANALYZE güvenliği**: `EXPLAIN ANALYZE` DML'i **gerçekten çalıştırır**. Kural: statement DML ise (classify biliyor) ANALYZE isteği otomatik `BEGIN … ROLLBACK` sarmalı içinde koşar + sonuç başlığında "rolled back" rozeti. Destructive guard EXPLAIN ANALYZE yolunda da çalışır.
4. **UI (`components/explain/`)**: plan JSON'u ağaç olarak render edilir; düğümde node type, ilişki/index adı, cost, rows (est vs actual), süre. Sıcak nokta vurgusu: toplam sürenin > %20'sini yiyen düğümler amber (07 §4 renk istisnasına "profiling sinyali" olarak eklenir — monokrom kuralın bilinçli 4. deliği). Est/actual satır oranı > 10x sapanlar işaretlenir (kötü istatistik sinyali). Düğüm tıklayınca ham JSON detay paneli.
5. Ham metin görünümü her zaman bir sekme olarak kalır (JSON→ağaç render'ı bilinmeyen node tipinde düşerse fallback).

**Kabul:** karmaşık bir JOIN sorgusunda Explain Analyze tek tıkla ağacı gösterir;
en pahalı düğüm ilk bakışta seçilir; UPDATE üzerinde Explain Analyze veriyi
değiştirmez.

**Risk:** Plan JSON şemasının PG sürümleri arası küçük farkları. Önlem: render
bilinmeyen alanları yutar (serde `#[serde(default)]` / dinamik `serde_json::Value`
gezinme), ham sekme her zaman var.

---

## P1-M4 — Query history + saved snippets

### Analiz

M2'nin `store/` altyapısı üstüne iki tablo. Design 10 #1'in kapsamı korunur,
maliyeti M2 sonrası küçülür.

### Plan

1. `store/history.rs`: her `run_query` sonrası kayıt — `(profile_id, sql, started_at, duration_ms, row_count, error_kind?)`. SQL metni tam saklanır; arama FTS5 ile (rusqlite bundled özelliği). Sınır: 10k kayıt / profil, LRU budama.
2. `store/snippets.rs`: `(name, sql, created_at)` CRUD.
3. UI: sidebar'a Explorer'ın yanına ikinci panel sekmesi "History" (fuzzy arama + çift tık = yeni tab'a aç); palette'e (H8) "insert snippet" eylemi; editörde seçim sağ-tık → "Save as snippet".
4. Privacy: history *yalnızca* yereldedir (00 §5 local-first); "clear history" butonu.

**Kabul:** dün koştuğum sorguyu history aramasıyla < 2 sn'de bulup tekrar koşarım.

---

## P1-M5 — Günlük konfor paketi (bağımsız küçük işler)

Sıra esnek; her biri tek oturumluk iş, milestone'lar arasına serpiştirilebilir:

| İş | Tasarım referansı | Not |
|---|---|---|
| Force kill | 05 §9 | `kill_query` komutu → `pg_terminate_backend`; cancel 5 sn etki etmezse buton dönüşür |
| Tam sonuç CSV export | 02 §3 `export_result_csv` | `COPY (sql) TO STDOUT` server-side stream → dosya; tokio task + progress event |
| Hücre tam-değer görüntüleme | 05 §4 | 8KB kesilen hücreye tık → tam değeri çeken tekil SELECT + modal (JSON pretty-print) |
| Completion frequency ranking | 10 #7 | `store/`'a kullanım sayacı; `rank()`'e `base + freq_boost` — candidates.rs zaten skorlu |
| Açık tema | 07 §4 | Monokrom açık varyant; `theme.css` CSS variables zaten tek kaynak |
| Kolon başlığı → ORDER BY önerisi | 07 §4 | Grid'de client-side sort yasağının tasarlanmış alternatifi |

---

## 4. Sözleşme değişiklikleri özeti (02'ye işlenecek)

| Değişiklik | Nerede |
|---|---|
| `StatementResult::Explain { plan_json, analyze }` | M3 |
| `kill_query { connection_id, query_id }` | M5 |
| `export_result_csv { connection_id, sql, file_path, format }` + `export:progress` event | M5 |
| `refresh_schema { connection_id, schema? }` kısmi refresh aktif | M2 |
| History/snippet komutları: `list_history`, `search_history`, `save_snippet`, `list_snippets`, `delete_snippet`, `clear_history` | M4 |
| Event: `result:frozen` (11-H7'den), `connection:lost` (06 §4 — M1 ile birlikte gelir) | M1/M2 |

## 5. Test yaklaşımı (CI'sız dünyada)

- Saf mantık her zamanki gibi unit: EXPLAIN JSON parse fixture'ları, history budama, postcard blob round-trip, frequency ranking.
- Canlı DB akışları mevcut `--ignored` düzeninde büyür (multi-connection eşzamanlılık, COPY export, kill).
- Release öncesi manuel checklist (08 §5) genişler: iki sunuculu duman testi + soğuk açılış disk-cache ölçümü.

## 6. Faz 1'den bilinçli çıkarılanlar

| Ne | Neden | Ne zaman |
|---|---|---|
| Auto-update + release pipeline (10 #5, 09) | CI kararıyla birlikte ertelendi (Q&A 2026-07-04); tek makinede elle kurulum yeterli | Paylaşım ihtiyacı doğunca — 09 planı hazır |
| Inline veri düzenleme (10 #6) | Yüksek dikkat isteyen iş (PK çözümü, UPDATE önizleme); önceliklenen üçlüden sonra değerlendirilir | Faz 1 sonu / Faz 2 kapısında yeniden değerlendirme |
| SQL formatter (10 #10) | Harici entegrasyon araştırması gerekiyor | İhtiyaç sıklığına göre |
| SSH tüneli (10 #11) | "İhtiyaç doğarsa" koşulu hâlâ doğmadı | İhtiyaç doğunca |
