# 04 — Autocomplete: Parser Pipeline'ı ve Monaco Entegrasyonu

Projenin var oluş sebebi bu doküman. Hedef: **her tuşta < 10ms'de, imlecin bağlamına uygun, şema-farkında öneri.**

## 1. Pipeline özeti

```
sql + cursor_offset
   │
   ├─ 1. statement split (pg_query::split) → imlecin içinde olduğu statement
   │
   ├─ 2a. pg_query::parse(statement) BAŞARILI → AST'den context çıkar
   ├─ 2b. parse BAŞARISIZ (yarım SQL) → onarım denemeleri → yine olmazsa
   │       pg_query::scan token akışından context çıkar (gerçek lexer, regex değil)
   │
   ├─ 3. CompletionContext {clause, relations, prefix, qualifier}
   │
   ├─ 4. cache snapshot'tan aday üretimi (clause'a göre)
   │
   └─ 5. rank + kes (≤ 50) → CompletionItem[]
```

## 2. Yarım SQL problemi ve onarım stratejisi

`libpg_query` error recovery yapmaz: `SELECT id, FROM users` parse edilemez. Ama kullanıcı **her zaman** yarım SQL yazar. Çözüm kademeli:

**Kademe 1 — sondaki eksikliği tamamla:** imlecin bulunduğu noktaya sentinel bir identifier enjekte et ve parse'ı yeniden dene:
```
"SELECT u. FROM users u"  (imleç u.'dan sonra)
→ "SELECT u.__ariadne__ FROM users u"   → parse OLUR
→ AST'de __ariadne__'nin konumu = imlecin bağlamı (ColumnRef, qualifier=u)
```
Bu tek numara vakaların büyük çoğunluğunu çözer; sqls/postgres-lsp gibi araçların da kullandığı bilinen tekniktir.

**Kademe 2 — kuyruğu kes:** sentinel'le de parse olmuyorsa (örn. `SELECT * FROM users WHERE (`), imleçten sonrasını at, sondaki tamamlanmamış token'ları buda, tekrar dene.

**Kademe 3 — token fallback:** hâlâ olmuyorsa `pg_query::scan` çıktısı üzerinde geriye doğru yürü: son görülen ana keyword (`SELECT`/`FROM`/`WHERE`/`JOIN`/`ON`/`GROUP BY`...) clause'u belirler; `FROM`/`JOIN` sonrası görülen `ident [AS] ident` çiftleri relation listesini verir. Bu hâlâ Postgres'in gerçek lexer'ı — prensip 3 ihlal edilmiyor.

Kademe sonuçları aynı `CompletionContext` tipine düşer; sonraki aşamalar hangi kademeden geldiğini bilmez.

## 3. CompletionContext ve çıkarımı

```rust
pub struct CompletionContext {
    pub clause: Clause,          // SelectList | From | JoinTarget | JoinOn | Where |
                                 // GroupBy | OrderBy | Having | Returning | InsertCols |
                                 // UpdateSet | FunctionArgs | Unknown
    pub relations: Vec<RelRef>,  // FROM/JOIN'de görünür ilişkiler (CTE'ler dahil)
    pub prefix: String,          // imleç altındaki yarım kelime ("ema" gibi)
    pub qualifier: Option<String>, // "u." yazıldıysa Some("u") — alias/şema olabilir
    pub statement_kind: StmtKind,  // Select | Insert | Update | Delete | Call | Other
}

pub struct RelRef {
    pub alias: Option<String>,   // "u"
    pub target: RelTarget,       // Table(TableId) | Cte(name, Vec<Column-ish>) | Subquery(çıkarılabilen kolonlar)
}
```

**AST'den çıkarım**: parse ağacında imlecin (sentinel'in) bulunduğu node'a inen path izlenir. Path üzerindeki en yakın clause node'u `clause`'u verir; aynı statement'ın (ve üst seviyedeki dış sorguların) `fromClause`'ları `relations`'ı doldurur. CTE'ler (`WithClause`) isim + kolon listesiyle relation olarak eklenir. Subquery içindeyken dış sorgu alias'ları da görünür (Postgres scoping kurallarına uygun: correlated subquery yazılabilmeli).

**Alias çözümü**: `qualifier` önce `relations` içindeki alias'larla, sonra şema adlarıyla, en son alias'sız tablo adlarıyla eşlenir. `u.` → `users` bulunursa adaylar = `users`'ın kolonları.

## 4. Clause → aday üretim kuralları

| Clause | Öneriler (öncelik sırasıyla) |
|---|---|
| `SelectList` | qualifier varsa: o relation'ın kolonları. Yoksa: görünür tüm kolonlar (alias öneki eklenerek: birden çok relation varsa `u.email` formunda insert), sonra fonksiyonlar, `*`, keyword'ler (`DISTINCT`, `CASE`...) |
| `From` | tablolar + view'lar (şema öneki kullanıcının `search_path` dışındakilere eklenir), set-returning fonksiyonlar, CTE adları |
| `JoinTarget` | ⭐ **FK-güdümlü sıralama**: görünür relation'lara FK bağı olan tablolar en üstte, `join` kind'ıyla ve **ON dahil snippet** ile: `orders o ON o.user_id = u.id`. Ardından diğer tablolar. |
| `JoinOn` | iki taraftaki relation'ların kolonları; FK eşleşen çift varsa tam koşul önerisi (`o.user_id = u.id`) ilk sırada |
| `Where` / `Having` / `OrderBy` / `GroupBy` | görünür kolonlar (qualifier'a saygılı), sonra fonksiyonlar, keyword'ler |
| `InsertCols` | hedef tablonun kolonları (henüz yazılmamışlar önce) |
| `UpdateSet` | hedef tablonun kolonları + `= ` snippet |
| `FunctionArgs` | signature help devreye girer (aşağıda); kolon önerileri de sürer |
| `Unknown` | statement başı: `SELECT`, `INSERT`, `WITH`... + tablo adları (hızlı `SELECT * FROM x` akışı için) |

**RPC/fonksiyon önerisi**: `Function` cache kaydından `label = "get_user_orders(user_id int4) → setof orders"`, insert snippet: `get_user_orders(${1:user_id})`. `CALL`/`SELECT` bağlamına göre procedure/function filtrelenir.

## 5. Ranking

Skor bileşenleri (yüksekten düşüğe ağırlık):

1. **Prefix eşleşme türü**: exact prefix > kelime-başı fuzzy (`us_em` → `user_email`) > araya-serpme fuzzy. Eşleştirici: basit skorlu subsequence match (Rust'ta ~30 satır; harici crate gerekmez, `fuzzy-matcher`/`nucleo` Faz 1'de değerlendirilebilir).
2. **Bağlam uygunluğu**: clause'un birincil kind'ı (FROM'da tablo, SELECT'te kolon) öne.
3. **Yakınlık**: görünür relation'ların kolonları, görünmeyenlerden önce; `search_path` içindeki şemalar önce.
4. **FK bağı** (JoinTarget'ta): bağlantılı tablo her şeyin üstünde.
5. Eşitlikte alfabetik. Kullanım frekansı (query history'den) **Faz 1**.

`sort_key` Rust'ta üretilir; Monaco'nun kendi filter/sort'u devre dışı bırakılır (`filterText` boş bırakılmaz, sıralama `sortText` ile sabitlenir) — çift sıralama tutarsızlığı klasik Monaco tuzağıdır.

## 6. Monaco entegrasyonu (frontend tarafı)

```ts
monaco.languages.registerCompletionItemProvider("pgsql", {
  triggerCharacters: [".", " ", "(", ","],
  provideCompletionItems: async (model, position) => {
    const offset = model.getOffsetAt(position);
    const res = await invoke<CompletionResult>("get_completions", {
      connectionId, sql: model.getValue(), cursorOffset: offset,
    });
    return { suggestions: res.items.map(toMonacoItem(res.replace_range)) };
  },
});
```

- **Debounce yok**: Rust < 10ms dönüyor; Monaco zaten istekleri iptal edilebilir yönetir. Ölçüm bunu yalanlıyorsa 30ms debounce eklenir (roadmap'te ölçüm maddesi var).
- `is_snippet: true` olanlar `insertTextRules: InsertAsSnippet` ile.
- **Signature help**: `registerSignatureHelpProvider` → `get_signature_help`. Rust tarafı imlecin hangi `FuncCall` argümanında olduğunu AST'den bulur; aktif parametre vurgulanır.
- **Syntax highlighting**: Monaco'nun yerleşik `pgsql` tanımı yeterli (Faz 0). Semantic token'lar (tablo adını farklı renklendirme) P2.
- **Hata markerları**: editör boştayken (500ms idle) `pg_query::parse` sonucu hata varsa `position`'dan Monaco marker'a çevrilir — kırmızı alt çizgi. (Completion yolundan bağımsız, ucuz bir bonus.)

## 7. Edge case kararları

| Durum | Karar |
|---|---|
| Çoklu statement | `pg_query::split` ile imlecin statement'ı izole edilir; diğerleri bağlamı etkilemez |
| Quoted identifier (`"MyTable"`) | Cache lookup'ları lowercase; quoted olanlar ayrıca orijinal haliyle indekslenir. Öneri insert'ünde gerekiyorsa otomatik quote'lanır (büyük harf/özel karakter içeren adlar) |
| Case | Keyword önerileri kullanıcının o statement'taki baskın stiline uyar (SELECT yazmışsa UPPER; Faz 0'da sabit UPPER da kabul) |
| `search_path` | Connect'te `SHOW search_path` okunur, cache'e konur; öneri önekleme ve sıralamada kullanılır |
| Dev şema (10k+ tablo) | Aday üretimi indekslerden (HashMap + prefix taraması); tam liste hiç materialize edilmez, rank sırasında top-50 heap ile kesilir |
| İmleç string literal / comment içinde | scan token'ından anlaşılır → öneri verilmez (boş liste) |
