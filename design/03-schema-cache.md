# 03 — Şema Cache: Veri Modeli ve Refresh Stratejisi

Cache, Ariadne'nin performans kalbidir: autocomplete ve object explorer'ın **tek** veri kaynağı. Canlı DB'ye sadece cache kurulurken/yenilenirken gidilir.

## 1. Veri modeli

```rust
/// Immutable snapshot. Refresh = yeni SchemaCache kur + ArcSwap ile değiştir.
pub struct SchemaCache {
    pub fetched_at: DateTime<Utc>,
    pub schemas: Vec<SchemaInfo>,               // name, owner, is_system

    // Ana depolar — TableId/FunctionId = pg_class.oid / pg_proc.oid (u32)
    pub tables: HashMap<TableId, Table>,
    pub functions: HashMap<FunctionId, Function>,
    pub sequences: Vec<Sequence>,

    // ---- Lookup indeksleri (fetch sonrası bir kez kurulur) ----
    /// "schema.name" (lowercase) → id. Autocomplete'in ana giriş noktası.
    pub table_by_qualified: HashMap<String, TableId>,
    /// name (lowercase) → aynı ada sahip tablolar (farklı şemalarda olabilir)
    pub table_by_name: HashMap<String, SmallVec<[TableId; 2]>>,
    pub function_by_name: HashMap<String, SmallVec<[FunctionId; 2]>>,
    /// FK komşuluk grafiği: JOIN önerisinin kaynağı (iki yönlü)
    pub fk_adjacency: HashMap<TableId, Vec<FkEdge>>,
    /// Fuzzy arama için düz liste: (lowercase_name, kind, id)
    pub search_index: Vec<SearchEntry>,
}

pub struct Table {
    pub id: TableId,
    pub schema: String,
    pub name: String,
    pub kind: RelKind,                 // Table | View | MatView | Foreign | Partitioned
    pub columns: Vec<Column>,          // attnum sırasında
    pub primary_key: Vec<ColIdx>,
    pub comment: Option<String>,
    pub estimated_rows: i64,           // pg_class.reltuples — UI'da "~200M rows" rozeti
}

pub struct Column {
    pub name: String,
    pub type_name: String,             // "int4", "varchar(255)" — format_type() çıktısı
    pub not_null: bool,
    pub has_default: bool,
    pub comment: Option<String>,
}

pub struct FkEdge {
    pub from_table: TableId,
    pub from_cols: Vec<ColIdx>,
    pub to_table: TableId,
    pub to_cols: Vec<ColIdx>,
    pub constraint_name: String,
}

pub struct Function {
    pub id: FunctionId,
    pub schema: String,
    pub name: String,
    pub args: Vec<FnArg>,              // name, type_name, mode (In/Out/InOut/Variadic), has_default
    pub return_type: String,           // "setof orders", "int4", "record"
    pub kind: FnKind,                  // Function | Procedure | Aggregate | Window
    pub comment: Option<String>,
}
```

> 💡 **Rust notu — neden oid tabanlı ID + ayrı indeks map'leri?** String key'lerle tek büyük map kurmak yerine, veriyi bir kez `HashMap<Oid, T>`'de tutup isim→oid indekslerini ayrı kuruyoruz. Böylece FK grafiği gibi ilişkiler ucuz `u32` referanslarıyla gezilir; string clone'lama minimuma iner. `SmallVec<[T; 2]>` = "çoğunlukla 1-2 eleman" durumunda heap allocation'dan kaçınan vektör — mikro optimizasyon ama completion sıcak yolunda değerli.

## 2. Catalog sorguları

`information_schema` değil **`pg_catalog`** kullanılır (kat kat hızlı, kolon bilgisi daha zengin). Fetch **4 sorguda** biter, hepsi paralel atılır (`tokio::join!`):

1. **Şemalar**: `pg_namespace` — `pg_temp_*`, `pg_toast` hariç; `pg_catalog`/`information_schema` "system" bayrağıyla dahil (autocomplete'te `pg_` yazınca çıksın diye).
2. **Tablolar + kolonlar**: `pg_class` (relkind IN 'r','v','m','f','p') JOIN `pg_attribute` (attnum > 0, not attisdropped) + `format_type()` + `pg_description`. Tek sorgu, satır = kolon; Rust'ta tabloya gruplanır.
3. **Constraint'ler**: `pg_constraint` (contype IN 'p','f') — PK ve FK'lar; `conkey`/`confkey` array'leri kolon indekslerine çevrilir.
4. **Fonksiyonlar**: `pg_proc` + `pg_get_function_arguments(oid)` + `pg_get_function_result(oid)` — arg string'i Rust'ta parse edilir (virgülle ayrılmış `name type [DEFAULT x]` formatı).

Sequence'lar 2. sorgudan gelir (relkind 'S').

**Boyut tahmini**: 1.000 tablo × ort. 15 kolon + 500 fonksiyon ≈ 5–10 MB RAM. Sorun değil; 10.000 tabloluk patolojik şemada bile < 100 MB.

**Fetch süresi hedefi**: orta boy şemada < 500 ms, dev şemada < 3 sn. Fetch **connect'i bloklamaz** — bağlantı anında kullanılabilir, cache dolunca `schema:refreshed` event'i tree'yi doldurur.

## 3. SchemaSnapshot (frontend'e giden hafif görünüm)

Tree + fuzzy search'ün ihtiyacı: şema/tablo/view/fonksiyon/sequence adları, kolon adı+tipi, satır tahmini, comment. FK grafiği ve fonksiyon arg detayı frontend'e **gitmez** (completion Rust'ta). Serialize boyutu tipik şemada < 1 MB JSON — tek `get_schema_snapshot` çağrısıyla taşınır, frontend kendi arama indeksini bundan kurar.

## 4. Refresh ve invalidation stratejisi

**Faz 0 kuralları (basit ve öngörülebilir):**

1. **Connect'te otomatik fetch** (arka planda).
2. **Manuel refresh**: toolbar butonu + `F5` (explorer odaklıyken) + command palette. `refresh_schema` komple yeni snapshot kurar.
3. **DDL sonrası otomatik refresh**: Ariadne içinden çalıştırılan statement'lar zaten parse ediliyor; AST'de `CreateStmt`/`AlterTableStmt`/`DropStmt`/`CreateFunctionStmt`... görülürse sorgu bittikten sonra ilgili bağlantı için sessizce refresh tetiklenir. Ucuz ve kullanıcının %90 senaryosunu (kendi yaptığı DDL) kapatır.
4. **Dışarıdan yapılan DDL** (başka client migration attı): Faz 0'da algılanmaz; staleness göstergesi olarak status bar'da "cache: 12 dk önce" yazar. Kullanıcı bilmediği bir tabloyu göremiyorsa refresh'e basar.

**Faz 1+ opsiyonları** (tasarımda yer ayrıldı, implemente edilmeyecek):
- `event_trigger` gerektirmeyen hafif poll: dakikada bir `SELECT max(oid) ... / count(*)` yerine `pg_stat_all_tables` değişim özeti karşılaştırması.
- Disk persist: `rusqlite` ile snapshot'ı serialize et (`fetched_at` + server version key'li); cold start'ta önce diskten yükle, arka planda tazele. Cache modeli zaten immutable snapshot olduğu için persist eklemek yapıyı değiştirmez — bilinçli tasarım tercihi.

**Kısmi refresh** (`refresh_schema { schema: "public" }`): Faz 0'da desteklenir ama içeride yine 4 sorgu atılır, sadece `WHERE nspname = $1` filtreli; sonuç mevcut snapshot'ın kopyasına merge edilip swap edilir. Dev sunucularda tek şemayı tazelemek belirgin hız kazandırır.

## 5. Eşzamanlılık

- Okuma yolu (completion, snapshot): `ArcSwap::load` — lock yok, bekleme yok.
- Refresh sırasında eski snapshot kullanılmaya devam eder; yenisi hazır olunca atomik swap. "Refresh sırasında autocomplete donması" diye bir kategori tasarım gereği yok.
- Aynı bağlantı için üst üste refresh istekleri debounce edilir (çalışan varsa yenisi kuyruklanmaz, bayrakla birleştirilir).
