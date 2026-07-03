# 02 — Tauri Command API

Frontend ↔ Rust arasındaki tüm sözleşme burada. Tipler hem Rust (`serde`) hem TS tarafında birebir tanımlanır; TS tipleri `src/lib/api.ts` içinde el ile tutulur (Faz 1'de `ts-rs` ile otomatik üretime geçilebilir).

## 1. Genel kurallar

- Her command `Result<T, AriadneError>` döner. Tauri bunu frontend'de resolve/reject'e çevirir.
- İsimlendirme: `snake_case`, fiil + nesne (`run_query`, `save_profile`).
- Uzun süren işler (query, refresh) command olarak başlar, ilerleme **event** ile akar, sonuç yine command dönüşüyle veya final event ile gelir.
- ID'ler: `ConnectionId = String (uuid v4)`, `QueryId = String (uuid v4)`, `ProfileId = String (uuid v4)`.

## 2. Hata modeli

```rust
#[derive(Serialize)]
pub struct AriadneError {
    pub kind: ErrorKind,          // frontend switch'lemesi için
    pub message: String,          // kullanıcıya gösterilecek tek satır
    pub detail: Option<String>,   // katlanabilir teknik detay
    // Postgres kaynaklı hatalarda:
    pub sqlstate: Option<String>, // "42P01" gibi
    pub position: Option<u32>,    // SQL içindeki 1-based byte offset → Monaco marker
    pub hint: Option<String>,     // Postgres'in HINT alanı
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    ConnectionFailed,   // ilk bağlantı kurulamadı
    ConnectionLost,     // aktif bağlantı koptu (bkz. 06)
    QueryError,         // Postgres'ten dönen hata (sqlstate dolu)
    QueryCancelled,     // kullanıcı iptali — UI bunu hata gibi göstermez
    Timeout,
    ParseError,         // pg_query parse hatası (completion değil, explicit parse isteği)
    KeyringError,       // şifre okunamadı/yazılamadı
    Internal,           // beklenmeyen — detail'e Rust hatası gömülür
}
```

> 💡 **Rust notu — `thiserror` + `From`.** İçeride `thiserror` ile zengin bir enum tutulur; IPC sınırında `impl From<InternalError> for AriadneError` ile bu serializable şekle çevrilir. sqlx/keyring/io hataları `?` operatörüyle otomatik yükselir — her yerde `match` yazılmaz.

## 3. Command listesi

### Bağlantı ve profiller (detay: 06)

| Command | Request | Response |
|---|---|---|
| `list_profiles` | — | `ProfileSummary[]` |
| `save_profile` | `{ profile: ProfileInput, password?: string }` | `ProfileSummary` — şifre keyring'e yazılır, JSON'a asla |
| `delete_profile` | `{ profile_id }` | `void` — keyring kaydı da silinir |
| `test_connection` | `{ profile: ProfileInput, password?: string }` | `{ server_version: string, latency_ms: number }` |
| `connect` | `{ profile_id }` | `ConnectionInfo` — pool kurulur, ardından cache fetch **arka planda** başlar |
| `disconnect` | `{ connection_id }` | `void` — çalışan sorgular iptal edilir, pool kapatılır |

```ts
interface ConnectionInfo {
  connection_id: string;
  profile_id: string;
  server_version: string;
  database: string;
  user: string;
}
```

### Şema (detay: 03)

| Command | Request | Response |
|---|---|---|
| `get_schema_snapshot` | `{ connection_id }` | `SchemaSnapshot` — tree'nin tamamını tek seferde besler |
| `refresh_schema` | `{ connection_id, schema?: string }` | `void` — bitince `schema:refreshed` event'i |

`SchemaSnapshot` frontend'in tree ve arama için ihtiyacı olan **hafifletilmiş** görünümdür (kolon default'ları gibi ağır alanlar hariç). Tam veri Rust'ta kalır; completion zaten orada hesaplanır.

### Query (detay: 05)

| Command | Request | Response |
|---|---|---|
| `run_query` | `{ connection_id, sql, tab_id, max_rows_per_page?: number, confirmed?: boolean }` | `RunResult` |
| `fetch_page` | `{ query_id }` | `Page` — cursor'dan sonraki sayfa |
| `cancel_query` | `{ query_id }` | `void` — pg_cancel_backend yolu, bkz. 05 |
| `kill_query` | `{ query_id }` | `void` — pg_terminate_backend; cancel etki etmezse (Faz 1, bkz. 05 §9) |
| `close_result` | `{ query_id }` | `void` — cursor + tx kapatılır (tab kapanınca çağrılır) |
| `export_result_csv` | `{ connection_id, sql, file_path, format: "csv" \| "tsv" }` | `{ rows_written }` — `COPY (sql) TO STDOUT` server-side stream, tam sonuç (Faz 1; Faz 0'da export frontend'de fetch edilmiş satırlardan, bkz. 07) |

```ts
interface RunResult {
  query_id: string;
  statements: StatementResult[];   // script'te birden çok statement olabilir
  tx_status: "idle" | "in_transaction" | "aborted";  // tab = session, bkz. 05 §7
  // Dolu ise hiçbir şey çalıştırılmadı (veya statement_index'e kadar çalıştı);
  // onay alınıp confirmed: true ile tekrar çağrılır. bkz. 05 §8
  needs_confirmation?: { statement_index: number; kind: "update" | "delete" | "truncate";
                         table: string; estimated_rows: number | null };
}
type StatementResult =
  | { kind: "rows"; columns: ColumnMeta[]; first_page: Page; truncated_cells: boolean }
  | { kind: "affected"; command: string; row_count: number }   // INSERT/UPDATE/DDL
  | { kind: "empty"; command: string };                        // SET, BEGIN vb.

interface ColumnMeta { name: string; type_name: string; type_oid: number }
interface Page { rows: (string | null)[][]; has_more: boolean; fetched_total: number; elapsed_ms: number }
```

Hücre değerleri **string olarak** taşınır (Postgres text format). Gerekçe: JSON number'ın bigint/numeric hassasiyet kaybı, bytea/timestamp gösterim sorunları. Grid ham string'i gösterir; tip-farkında hizalama `type_oid` üzerinden yapılır.

### Completion (detay: 04)

| Command | Request | Response |
|---|---|---|
| `get_completions` | `{ connection_id, sql, cursor_offset }` | `CompletionResult` |
| `get_signature_help` | `{ connection_id, sql, cursor_offset }` | `SignatureHelp \| null` — fonksiyon çağrısı içindeyken parametre ipucu |
| `get_object_info` | `{ connection_id, sql, cursor_offset }` | `ObjectInfo \| null` — `Alt+F1` peek'i (07). İmleçteki identifier completion motorunun alias çözümüyle bulunur (`u` → `users`); kolonlar + PK/FK + satır tahmini + comment döner. Tamamen cache'ten — SchemaSnapshot'ı ağırlaştırmadan FK detayına erişim yolu |

```ts
interface CompletionResult {
  items: CompletionItem[];              // rank edilmiş, ≤ 50
  replace_range: { start: number; end: number };  // prefix'in offset aralığı
}
interface CompletionItem {
  label: string;                 // "users.email"
  kind: "table" | "view" | "column" | "function" | "schema" | "keyword" | "join";
  insert_text: string;           // snippet syntax olabilir: "orders o ON o.user_id = ${1:u.id}"
  is_snippet: boolean;
  detail?: string;               // "text, not null" / "(user_id int4) → setof orders"
  sort_key: string;              // Rust'ın verdiği sıra korunur
}
```

## 4. Event'ler (Rust → frontend)

| Event | Payload | Ne zaman |
|---|---|---|
| `query:finished` | `{ query_id, tab_id }` | son statement bitti |
| `query:error` | `{ query_id, tab_id, error: AriadneError }` | herhangi bir statement hata verdi |
| `schema:refresh_started` / `schema:refreshed` | `{ connection_id }` | connect sonrası ve manuel refresh'te |
| `connection:lost` | `{ connection_id, error }` | pool bağlantı kaybı algıladı (bkz. 06) |

Not: `run_query` sayfaları event'le değil command dönüşüyle taşır — sayfa zaten kullanıcı scroll'una bağlı (pull-based), event (push-based) modeli backpressure sorunu yaratırdı.

## 5. Versiyonlama

Faz 0'da API tek tüketicili (kendi frontend'imiz) olduğundan versiyonlama yok; kırıcı değişiklik serbest. Sözleşmenin tek kaynağı bu doküman.
