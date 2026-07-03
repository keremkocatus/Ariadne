# 05 — Query Execution: Async Akış, İptal, Pagination

Tasarımın ana kısıtı: **200M+ satırlık production tablolar.** Hiçbir akış sonucu komple belleğe çekemez; her sorgu iptal edilebilir olmalı.

## 1. Çalıştırma akışı

```
run_query(conn_id, sql, tab_id)
 1. pg_query::split → statement listesi
 1b. destructive guard: AST'de WHERE'siz UPDATE/DELETE varsa çalıştırmadan
     RunResult yerine `needs_confirmation` döner; frontend onay alıp
     `run_query { confirmed: true }` ile tekrar çağırır (bkz. §8)
 2. tab'ın session bağlantısını al: tab'da açık tx VARSA mevcut sabitlenmiş
    bağlantı kullanılır (bkz. §7); yoksa pool'dan acquire edilir
 3. backend_pid'i kaydet (iptal için)
 4. her statement için sırayla:
    ├─ SELECT/VALUES/WITH..SELECT (AST'den anlaşılır) → CURSOR yolu (aşağıda)
    ├─ INSERT/UPDATE/DELETE (RETURNING'li ise cursor yolu) → execute, affected count
    └─ DDL/diğer → execute, command tag
 5. RunResult döndür; connection cursor açıksa tutulur, değilse pool'a iade
```

Statement'lar arası hata: kalanlar çalıştırılmaz, o ana kadarki sonuçlar + `query:error` döner (psql davranışı).

## 2. Büyük sonuç: server-side cursor yolu

**Karar: keyset/LIMIT enjeksiyonu değil, gerçek server-side cursor.** Gerekçe: kullanıcı *rastgele* SQL yazar — ORDER BY'sız, window'lu, CTE'li. Sorguyu yeniden yazmak (LIMIT eklemek) semantiği bozabilir; cursor bozamaz.

```sql
BEGIN READ ONLY;                          -- yalnızca cursor yaşarken açık kalan tx
DECLARE ariadne_cur_<query_id> NO SCROLL CURSOR FOR <kullanıcı SQL'i>;
FETCH FORWARD 500 FROM ariadne_cur_<query_id>;   -- ilk sayfa
-- kullanıcı scroll ettikçe: FETCH FORWARD 500 ...  (fetch_page komutu)
-- tab kapanınca / yeni sorgu gelince: CLOSE + COMMIT  (close_result)
```

- Sayfa boyu varsayılan **500 satır** (config'ten değiştirilebilir). Grid virtualized olduğundan kullanıcı "sonsuz scroll" hisseder; `has_more` bitince durur.
- `NO SCROLL`: geriye gitme yok → Postgres materialize etmek zorunda kalmaz. Geri scroll frontend'de zaten fetch edilmiş satırlardan servis edilir (satırlar tab state'inde birikir; bkz. bellek sınırı).
- **Frontend bellek sınırı**: tab başına maks. **100k satır** tutulur; aşılırsa kullanıcıya "ilk 100k satır gösteriliyor — filtre ekleyin" bandı. 200M satırı UI'da gezmek use-case değil; kazara `SELECT *`'a karşı sigorta.
- **Açık tx trade-off'u**: cursor yaşadıkça `READ ONLY` tx açık kalır → uzun süre açık kalırsa vacuum'u geciktirebilir. Önlem: cursor'lu tab **15 dk** idle kalırsa otomatik `CLOSE` + tx commit; grid'de "sonuç dondu, yeniden çalıştır" bandı çıkar. Süre config'te.

> 💡 **Rust notu — sqlx ile ham protokol işleri.** Bu akışta prepared statement gerekmez; `sqlx::raw_sql`/`Executor::fetch_many` simple query protokolüyle çoklu statement da yürütebilir. Cursor komutları (`DECLARE`, `FETCH`) normal SQL string'leri olarak aynı connection'dan gönderilir — kritik olan hepsinin **aynı** connection'da kalması (tx connection'a bağlıdır). Bu yüzden sorgu başına pool'dan tek connection alınıp `RunningQuery` içinde saklanır.

## 3. İptal (cancel_query)

Postgres iptali ayrı bir kanaldan gider. **Yöntem: yeni kısa ömürlü bağlantı + `pg_cancel_backend($pid)`.**

```
cancel_query(query_id)
 → running_queries[query_id].backend_pid
 → pool'dan bağımsız tek atımlık bağlantı aç (aynı credentials)
 → SELECT pg_cancel_backend($1)
 → çalışan FETCH/execute "57014 query_canceled" hatasıyla döner
 → ErrorKind::QueryCancelled'a map edilir (UI hata değil, "cancelled" durumu gösterir)
```

- Bu yol sqlx'in cancel API eksikliğinden bağımsız çalışır ve wire-level cancel request'in (PID+secret) taşıdığı race'lerden etkilenmez.
- `pg_cancel_backend` kendi oturumlarımız için superuser gerektirmez (aynı kullanıcı).
- Timeout iptali de aynı mekanizma: `RunningQuery` başlarken `tokio::time::timeout` sarmalanır; süre dolarsa aynı cancel yolu tetiklenir, hata `ErrorKind::Timeout` olur. Varsayılan timeout: **yok** (analitik sorgular saatler sürebilir); kullanıcı profil bazında `statement_timeout` set edebilir (bkz. 06).

## 4. Satır → IPC dönüşümü

- Değerler Postgres **text format**'ında okunur ve string olarak taşınır (bkz. 02 §3 gerekçe).
- Hücre boyutu sınırı: **8 KB/hücre**; aşan değer kesilir, `truncated_cells: true` işaretlenir, grid hücresinde "…" + tıklayınca `SELECT col FROM ... WHERE` ile tam değer çekme (Faz 1). `bytea` daima `\x` hex preview (ilk 256 byte).
- 500 satır × ~20 kolon JSON payload'ı tipikte < 1 MB — Tauri IPC için sorunsuz. Ölçüm kötü çıkarsa alternatif hazır: sayfayı `postcard`/MessagePack'le `tauri::ipc::Response` raw body olarak taşımak (tasarım değişmez, encoding değişir).

## 5. EXPLAIN desteği (P1 önizleme)

Faz 0'da özel UI yok, ama tasarım kancası: `run_query` AST'de `ExplainStmt` görürse `StatementResult`'a `kind: "explain"` eklemek yeterli olacak. Okunaklı EXPLAIN görünümü (ağaç render'ı) Faz 1.

## 6. RunningQuery yaşam döngüsü

```rust
pub struct RunningQuery {
    pub query_id: QueryId,
    pub tab_id: String,
    pub conn: PoolConnection<Postgres>,  // dedicated
    pub backend_pid: i32,
    pub cursor_open: bool,
    pub started_at: Instant,
    pub last_fetch_at: Instant,          // idle-close için
}
```

Durumlar: `Running → (FirstPage) → CursorIdle ↔ Fetching → Closed | Cancelled | Errored`.
Temizlik garantileri: tab kapanışı → `close_result`; disconnect → tüm running query'lere cancel + close; uygulama kapanışı → pool drop zaten TCP'yi kapatır, Postgres tx'i rollback eder (leak yok).

## 7. Kullanıcı transaction'ları: tab = session modeli

Kullanıcı `BEGIN` yazıp ayrı çalıştırmalarla devam edebilmeli — günlük kullanım gereksinimi. Naif "her run_query pool'dan bağlantı alır" modeli bunu kırar (BEGIN ve UPDATE farklı bağlantılara düşer). Çözüm:

**Kural: bir tab'da açık transaction varken o tab'ın bağlantısı sabitlenir** (pool'a iade edilmez); tx kapanınca (COMMIT/ROLLBACK) iade edilir.

```rust
pub struct TabSession {
    pub tab_id: String,
    pub pinned_conn: Option<PoolConnection<Postgres>>, // Some ⇔ açık tx var
    pub tx_status: TxStatus,   // Idle | InTransaction | Aborted
}
```

**Tx durumu takibi**: Ariadne o bağlantının *tek* istemcisi olduğundan durum deterministik izlenir — her statement'ın AST'inde `TransactionStmt` (BEGIN/START, COMMIT, ROLLBACK, SAVEPOINT, ROLLBACK TO) aranır ve state machine güncellenir; tx içinde herhangi bir statement hata verirse durum `Aborted` olur (Postgres semantiği: ROLLBACK'e kadar her şey `25P02` ile reddedilir). Bilinen edge: procedure içi `COMMIT` (CALL ile transaction control) takibi şaşırtabilir — `CallStmt` sonrası durum bilinmiyorsa güvenli taraf: durum `Unknown` sayılıp bir sonraki statement hatasından senkronize olunur; tasarım notu olarak kabul edilmiş risk.

**Davranış kuralları:**

| Durum | Davranış |
|---|---|
| RunResult her zaman `tx_status` taşır | UI tab rozetini bundan günceller (bkz. 07) |
| Tx açıkken SELECT | Cursor **kullanıcının tx'i içinde** DECLARE edilir (ayrı READ ONLY tx açılmaz); COMMIT/ROLLBACK gelince cursor ölür → grid "sonuç geçersiz, yeniden çalıştır" bandı |
| Tab kapatma, tx açıkken | Onay diyaloğu: Commit / Rollback / Vazgeç |
| Disconnect / uygulama kapanışı, tx açıkken | Onay istenir; onaysız kapanışta Postgres zaten rollback eder (veri güvenli taraf) |
| Idle açık tx > 10 dk | Status bar'da amber uyarı: "Açık transaction bekliyor" (lock + vacuum etkisi); otomatik rollback YOK — kullanıcının işi yarım olabilir |
| Aborted durumda yeni statement | Çalıştırılmadan net mesaj: "Transaction aborted — önce ROLLBACK" + tek tık Rollback butonu |

Commit/Rollback butonları yeni komut gerektirmez: `run_query(tab_id, "COMMIT")` ile aynı yoldan gider.

`read_only` profil bayrağıyla ilişki (06): `default_transaction_read_only=on` sadece *default*'tur; kullanıcı `BEGIN READ WRITE` ile bilinçli olarak delebilir — tasarım gereği engel değil emniyet kemeri.

## 8. Destructive statement guard

AST zaten her statement için üretiliyor; `UpdateStmt`/`DeleteStmt` node'unda `whereClause == None` (ve `TRUNCATE`) tespiti bedava. Davranış: statement çalıştırılmadan `run_query` sonucu `needs_confirmation: { statement_index, kind, table }` döner; frontend onay diyaloğu gösterir ("`orders` tablosunda WHERE'siz DELETE — ~2.1M satır etkilenecek", satır tahmini cache'ten). Onaylanırsa `confirmed: true` ile yeniden çağrılır ve o çalıştırma için guard atlanır. Script içindeyse önceki statement'lar çalıştırılmış olur — onay diyaloğu bunu belirtir.

## 9. Force kill (Faz 1)

Cancel (`pg_cancel_backend`) nazik yoldur; takılı kalmış oturumlar için `kill_query` komutu `pg_terminate_backend(pid)` çağırır (bağlantı sunucu tarafında ölür, tab session'ı sıfırlanır). UI: cancel 5 sn içinde etki etmezse ⏹ butonu "Force kill" seçeneğine dönüşür.
