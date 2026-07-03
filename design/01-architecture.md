# 01 — Sistem Mimarisi ve Rust Proje İskeleti

## 1. Yüksek seviye mimari

```
┌─────────────────────────────────────────────────────────┐
│  WebView (React + TS)                                   │
│  Monaco ─ react-arborist ─ TanStack Table ─ Zustand     │
└──────────────┬──────────────────────────▲───────────────┘
               │ invoke(command, args)    │ events (emit)
               ▼                          │
┌─────────────────────────────────────────┴───────────────┐
│  Tauri Core (Rust, tokio runtime)                        │
│                                                          │
│  commands/   → ince IPC katmanı (validate + delege)      │
│  db/         → sqlx pool'ları, query runner, cancel      │
│  cache/      → SchemaCache (in-memory, RwLock)           │
│  complete/   → pg_query parse/scan → CompletionContext   │
│               → cache ile birleştirip öneri listesi      │
│  profiles/   → bağlantı profilleri + keyring             │
│  error.rs    → tek hata tipi (AriadneError)              │
└──────────────┬───────────────────────────────────────────┘
               │ TCP (sqlx / tokio-postgres wire)
               ▼
         PostgreSQL sunucuları
```

Kritik mimari karar: **completion hesabı tamamen Rust'ta yapılır.** Frontend'e AST değil, sıralanmış hazır öneri listesi (`CompletionItem[]`) gider. Gerekçe:

- Parser ve cache zaten Rust tarafında; AST'yi IPC'den geçirmek hem yavaş hem tip cehennemine yol açar.
- Completion mantığı saf Rust fonksiyonu olur → UI olmadan unit test edilebilir (bkz. 08).
- Monaco provider'ı ~50 satırlık ince adapter'a iner.

## 2. Process ve thread modeli

- Tek process (Tauri v2, sidecar yok). WebView OS'in kendi webview'ını kullanır (Windows'ta WebView2).
- Rust tarafı `tokio` multi-thread runtime üzerinde çalışır; Tauri async command'ları doğrudan tokio task'ı olarak yürütür.
- DB I/O tamamen async (sqlx). CPU-bound tek iş `pg_query` parse'ı — tek statement için < 1ms olduğundan ayrı thread pool gerekmez; 1 MB üstü script'lerde `tokio::task::spawn_blocking` ile korunur.

> 💡 **Rust notu — neden her yerde `async`?** DB'ye giden her çağrı ağ beklemesidir. `async fn` bu beklemeyi thread'i bloklamadan yapar; tokio aynı anda binlerce beklemeyi birkaç OS thread'i üzerinde çevirir. Kural: I/O yapan her fonksiyon `async`, saf hesap yapan (parse, completion ranking) fonksiyonlar sync kalır.

## 3. Paylaşılan state

```rust
pub struct AppState {
    /// connection_id → aktif bağlantı (pool + cache + çalışan sorgular)
    pub connections: RwLock<HashMap<ConnectionId, Arc<ActiveConnection>>>,
    pub profiles: ProfileStore,          // disk'teki profiller (şifresiz)
}

pub struct ActiveConnection {
    pub id: ConnectionId,
    pub pool: sqlx::PgPool,
    pub schema_cache: ArcSwap<SchemaCache>,     // bkz. 03
    pub running_queries: DashMap<QueryId, RunningQuery>, // bkz. 05
}
```

- `AppState` Tauri'nin `manage()` mekanizmasıyla tüm command'lara enjekte edilir (`State<'_, AppState>`).
- `SchemaCache` **immutable snapshot** olarak tutulur: refresh yeni cache'i sıfırdan kurar ve `ArcSwap` ile atomik değiştirir. Okuyanlar (completion) lock beklemez.

> 💡 **Rust notu — `Arc`, `RwLock`, `ArcSwap`.** `Arc<T>` = referans sayılan paylaşılan sahiplik (birden çok task aynı veriyi okuyabilir). `RwLock` = çok okuyucu / tek yazıcı kilidi. `ArcSwap` = "pointer'ı atomik değiştir" — cache gibi *toptan yenilenen* veriler için lock'suz okuma sağlar. Completion her tuşta çalıştığı için okuma yolunda kilit istemiyoruz.

## 4. Rust proje iskeleti: tek crate mi, workspace mi?

**Karar: Faz 0'da tek crate (`src-tauri`), modüllerle.** Workspace'e geçiş kriteri aşağıda.

Değerlendirme:

| | Tek crate + modüller | Cargo workspace (core/db/parser/app) |
|---|---|---|
| Rust'a yeni başlayan için | ✅ tek `Cargo.toml`, tek derleme hedefi | ❌ crate sınırları, visibility, path bağımlılıkları erken karmaşa |
| Derleme süresi | Küçük projede fark yok | Büyük projede incremental avantaj |
| Test izolasyonu | Modüller zaten ayrı test edilir | Crate başına test — marjinal fayda |
| Brief prensibi ("gereksiz soyutlama yok") | ✅ | ❌ erken soyutlama |

**Workspace'e geçiş tetikleyicisi**: (a) derleme > 60 sn olur ve suçlu bağımlılık ayrıştırılabilirse, veya (b) completion motoru CLI/LSP gibi ikinci bir tüketici kazanırsa. İkisi de olmadan bölme yok.

### Dizin yapısı

```
ariadne/
├── design/                  # bu dokümanlar
├── src/                     # React + TS frontend
│   ├── components/          #   explorer/, editor/, grid/, layout/
│   ├── stores/              #   zustand store'ları (bkz. 07)
│   ├── lib/                 #   tauri invoke wrapper'ları, tipler
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          # tauri builder, state manage, command register
│   │   ├── error.rs         # AriadneError (bkz. 02)
│   │   ├── commands/        # her dosya bir komut ailesi: connect.rs, query.rs,
│   │   │                    # schema.rs, complete.rs, profile.rs
│   │   ├── db/              # pool kurulumu, executor, cancel, row → JSON
│   │   ├── cache/           # SchemaCache modeli + catalog sorguları (bkz. 03)
│   │   ├── complete/        # context.rs (AST/scan → context), rank.rs, engine.rs
│   │   └── profiles/        # profil CRUD + keyring
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

`commands/` katmanı **ince** tutulur: deserialize → ilgili modülü çağır → sonucu serialize. İş mantığı `db/`, `cache/`, `complete/` içinde yaşar; bu modüller Tauri'den habersizdir (test edilebilirlik için kritik).

## 5. İki temel akış

**Autocomplete (her tuş):**
```
Monaco onType → invoke("get_completions", {conn_id, sql, offset})
  → complete::engine: pg_query parse (başarısızsa scan fallback)
  → CompletionContext {clause, visible_relations, prefix, qualifier}
  → cache snapshot'tan aday üret → rank → CompletionItem[] (≤ 50)
  → Monaco'ya döner. Hedef bütçe: < 10ms p95 (DB round-trip YOK).
```

**Query çalıştırma:**
```
Ctrl+Enter → invoke("run_query", {conn_id, sql, tab_id})
  → statement split (pg_query) → tek tek çalıştır
  → SELECT ise: server-side cursor aç, ilk sayfayı döndür (bkz. 05)
  → sonraki sayfalar fetch_page ile (pull-based); iptal cancel_query ile
  → durum event'leri: "query:finished" / "query:error" (bkz. 02 §4)
```

## 6. Logging & tanılama

`tracing` + `tracing-subscriber`: konsol (dev) + günlük dönen dosya (`app_log_dir`, 7 gün saklama). Seviye: default `info`, env ile `debug`. Kurallar: SQL metni `debug`'da loglanır (`info`'da sadece süre/satır sayısı), şifre/connection string **hiçbir seviyede** loglanmaz (06 §2 redaksiyon kuralı). `Internal` hatalarının "detayı kopyala" çıktısına son 50 log satırı eklenir — issue raporlama için.

## 7. Performans bütçeleri (P0 gereksinim #5'in sayısallaştırılması)

| Metrik | Bütçe |
|---|---|
| Cold start (pencere görünür + etkileşimli) | < 1 sn |
| Idle RAM (1 bağlantı, orta boy şema) | < 200 MB (WebView dahil) |
| Completion yanıtı (parse + rank) | < 10 ms p95 |
| Tree açılma (500 tablolu şema) | < 100 ms, jank yok |
| İlk sayfa sonucu (basit SELECT) | sorgu süresi + < 50 ms overhead |

Bu bütçeler 08'deki test stratejisinde ölçüm olarak yer alır.
