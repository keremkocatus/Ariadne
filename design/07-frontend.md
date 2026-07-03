# 07 — Frontend: State Management, Layout, UI/UX İskeleti

## 1. State management kararı: Zustand

| Kriter | Zustand | Redux Toolkit | Context |
|---|---|---|---|
| Boilerplate | ~0 | orta (slice/action şablonları) | düşük ama... |
| Selector bazlı re-render kontrolü | ✅ yerleşik | ✅ | ❌ context değişince tüm consumer'lar render |
| Async akış (tauri invoke) | düz `async` fonksiyon | thunk/saga töreni | düz ama state dağınık |
| Store dışından erişim (event handler, Monaco provider) | ✅ `useStore.getState()` | mümkün ama dolambaçlı | ❌ hook dışı erişim yok |
| Ekip/ölçek ihtiyacı | tek geliştirici → fazlası yük | büyük ekip standardı | küçük ağaçlar için |

**Karar: Zustand.** Belirleyici etken: Tauri event listener'ları ve Monaco provider'ları React ağacının *dışında* yaşar; Zustand'ın `getState()/setState()` ile hook'suz erişimi bu köprüyü doğal kurar. Context'te bu imkânsız, Redux'ta törenli.

### Store dilimleri (ayrı store'lar, tek dev store değil)

```
stores/
├── connectionStore   # profiller, aktif bağlantılar, bağlantı durumu (lost/ok)
├── schemaStore       # connection_id → SchemaSnapshot, arama indeksi, pin'ler, refresh durumu
├── tabsStore         # açık tab'lar [{id, title, connection_id, sql, dirty, result_ref}], aktif tab
├── queryStore        # query_id → {durum, sayfalar, kolonlar, elapsed, error}
└── uiStore           # sidebar genişliği, tema, panel oranları, command palette açık mı
```

Kalıcılık: `uiStore` + pin'ler + son açık tab'ların SQL'i → `zustand/persist` ile `localStorage` yerine **Tauri fs**'e (app_config_dir/ui-state.json) yazan custom storage adapter. Sorgu sonuçları asla persist edilmez.

> Tauri event köprüsü tek dosyada kurulur (`lib/events.ts`): `listen("query:finished", e => queryStore.getState().onFinished(e))` — component'ler event bilmez, sadece store'a abone olur.

## 2. Layout

```
┌────────────────────────────────────────────────────────────────┐
│ ⌘K palette │ bağlantı seçici ▾ │ ▶ Run │ ⟳ Refresh │     ⚙     │  ← toolbar (h-10)
├───────────────┬────────────────────────────────────────────────┤
│ EXPLORER      │  tab1: users-analiz ×  │ tab2 ×  │ +           │  ← tab bar
│ ┌───────────┐ ├────────────────────────────────────────────────┤
│ │ 🔍 fuzzy  │ │                                                │
│ └───────────┘ │            Monaco Editor                       │
│ 📌 pinned     │                                                │
│  users        ├────────────── ═ (sürüklenebilir) ──────────────┤
│  orders       │  Result Grid (TanStack + virtualizer)          │
│ ▾ public      │  500 rows fetched (~2.1M total) · 340ms · ⏹    │
│  ▸ tables     │                                                │
│  ▸ views      │                                                │
│  ▸ functions  │                                                │
│  ▸ sequences  │                                                │
├───────────────┴────────────────────────────────────────────────┤
│ ● prod-analytics (renk şeridi) │ cache: 2 dk önce │ v0.1.0     │  ← status bar
└─────────────────────────────────────────────────────────────────┘
```

- **Explorer** (sol, 260px, gizlenebilir `Ctrl+B`): en üstte fuzzy search (yazınca ağaç filtrelenmiş düz listeye dönüşür — nesting'te kaybolma problemi kökten çözülür), altında pin bölümü, sonra şema ağacı. Ağaç derinliği sabit **3**: `schema → kategori → nesne`. Kolonlar ağaçta yok — nesneye tıklayınca sağda peek paneli/tooltip (pgAdmin'in sonsuz nesting hatasına bilinçli tepki).
- **Tab modeli**: tab = editör + kendi sonucu. Tab'lar bağlantıya bağlı; tab başlığında profil renk şeridi.
- **Editör/grid split**: dikey, sürüklenebilir, grid çift-tık ile collapse.
- Grid durum çubuğu: satır sayısı, `estimated_rows`'tan toplam tahmini, süre, cancel butonu.

## 3. Ana etkileşimler

Kısayol felsefesi: **SSMS (MSSQL) alışkanlıkları temel alınır** — proje sahibinin kas hafızası oradan geliyor. pgAdmin şeması bilinçli olarak izlenmez.

| Eylem | Kısayol / davranış |
|---|---|
| Çalıştır (seçim varsa sadece seçimi) | **`Ctrl+E`** (SSMS) — `F5` (editör odaklıyken, SSMS) ve `Ctrl+Enter` de alias |
| ⭐ Nesne bilgisi (SSMS `sp_help` muadili) | **`Alt+F1`**: imlecin üstündeki / seçili identifier `get_object_info` komutuyla (02) cache'te çözülür (alias'lar dahil — `u` seçiliyse `users`) → peek paneli: kolonlar, tipler, PK/FK, satır tahmini. DB round-trip yok. Explorer'daki "Peek columns" da aynı paneli kullanır |
| ⭐ Satırı aşağı kopyala (duplicate line) | **`Ctrl+D`** (SSMS/VS) — Monaco'nun `Shift+Alt+↓`'u da açık kalır |
| Satır sil | `Ctrl+Shift+K` (VS/Monaco default) |
| Yorum satırı aç/kapa | `Ctrl+K Ctrl+C` / `Ctrl+K Ctrl+U` (SSMS) + `Ctrl+/` alias |
| UPPERCASE / lowercase | `Ctrl+Shift+U` / `Ctrl+Shift+L` (SSMS) |
| Sonuç panelini gizle/göster | `Ctrl+R` (SSMS) |
| Command palette (bağlantı değiştir, tablo aç, komutlar) | `Ctrl+K` — `cmdk` kütüphanesi (basılı tutmadan tek basış; `Ctrl+K Ctrl+C` chord'uyla Monaco içinde çakışmaz: editör odaklıyken chord önceliklidir) |
| Yeni tab / kapat | `Ctrl+T` / `Ctrl+W` |
| Explorer'da fuzzy search'e odak | `Ctrl+P` |
| Explorer refresh | `F5` (explorer odaklıyken — editörde F5 çalıştırır, bkz. 03 §4) |
| Tabloya çift tık | yeni tab'da `SELECT * FROM t LIMIT 500` hazır + çalıştırılmış |
| Tablo sağ tık | Peek columns / Copy name / Pin / SELECT şablonu / (Faz 1: DDL göster) |
| Cancel | grid'deki ⏹ veya `Esc` (sorgu koşarken); 5 sn etki etmezse buton "Force kill"e dönüşür (Faz 1) |
| Grid sağ tık / `Ctrl+C` | Hücre/seçili satırları kopyala; "Copy as CSV/TSV/JSON" (fetch edilmiş satırlar). "Export full result to file" (Faz 1, `export_result_csv` ile server-side stream) |

**Transaction göstergesi (05 §7):** tab başlığında rozet — tx açıkken amber `TX`, aborted'ta kırmızı `TX!`. Rozet açıkken toolbar'da `Commit` / `Rollback` butonları belirir (içeride `run_query("COMMIT")`). Açık tx'li tab kapatılırken Commit/Rollback/Vazgeç diyaloğu. Status bar 10 dk+ idle açık tx'te amber uyarı gösterir.

**Destructive guard diyaloğu (05 §8):** `needs_confirmation` dönünce modal: "`orders` üzerinde **WHERE'siz DELETE** — ~2.1M satır etkilenecek. Çalıştırılsın mı?" (satır tahmini `estimated_rows`'tan). Onay → `confirmed: true` ile tekrar çağrı. Modal'da "bu oturumda bir daha sorma" YOK — koruma pazarlıksız.

Keyboard-first P1 hedefi olsa da yukarıdaki setin tamamı Faz 0'da var — maliyetleri düşük, günlük değerleri yüksek. Not: `Ctrl+D` Monaco'nun varsayılan "select next occurrence"ını ezer; o özellik `Ctrl+Shift+D`'ye taşınır (multi-cursor kaybolmaz).

## 4. Görsel dil: siyah-beyaz minimalizm

**Karar: monokrom tema.** Renk paleti yalnızca grayscale — arka plan `#0a0a0a`, yüzeyler `#141414`/`#1e1e1e`, çizgiler `#2a2a2a`, metin `#e5e5e5`/`#8a8a8a`, vurgu **beyaz** (seçili öğe = inverted: koyu üstüne açık blok). Gölge yok, gradient yok, border-radius minimal (4px), ikonlar tek renk stroke (lucide).

**Rengin istisnası — sadece güvenlik/durum sinyalleri** (minimalizmin bilinçli deliği; monokrom bir "TX aborted" gözden kaçar):

| Sinyal | Renk |
|---|---|
| Hata (marker, error banner, `TX!`) | kırmızı |
| Uyarı (açık tx idle, cache stale, `TX` rozeti) | amber |
| Profil renk şeridi (prod ayrımı, 06) | kullanıcının seçtiği renk — güvenlik özelliği olduğu için kalır |

Bunlar dışında UI'da renk **yasak**. Monaco teması da aynı kurala uyar: syntax highlighting grayscale tonları + italik/bold ağırlık farklarıyla yapılır (keyword bold beyaz, string açık gri italik, comment koyu gri); tek `theme.css` → CSS variables hem shadcn hem Monaco'yu besler. Varsayılan koyu monokrom; açık monokrom (beyaz zemin) Faz 1.

- Yoğunluk: IDE yoğunluğu — 13px UI fontu, monospace: JetBrains Mono (bundle'a gömülü, lisansı uygun).
- Grid'de `NULL` gösterimi: koyu gri italik `NULL` (boş string'den ayırt edilebilir; boş string `""` olarak gösterilir).
- Grid'de client-side sıralama **Faz 0'da yok** — kısmi fetch edilmiş sonucu sıralamak yanıltıcıdır ("ilk 500 satırın sıralısı" ≠ "sıralı ilk 500"). Kolon başlığına tık Faz 1'de "ORDER BY ekleyip yeniden çalıştır" önerisine dönüşür.
- Kullanılacak shadcn bileşenleri: Dialog (bağlantı formu), DropdownMenu, ContextMenu, Command (cmdk tabanı), Tooltip, Toast (sonner), Resizable (panel split'leri), Badge.
- react-arborist: `rowHeight=24`, indent=16, kendi node renderer'ımız (ikon + ad + satır tahmini rozeti). TanStack Table: `@tanstack/react-virtual` ile hem satır hem **kolon** virtualization (500 kolonluk denormalize tablolar gerçek).

## 5. Frontend ↔ backend köprü kuralları

1. Tüm `invoke` çağrıları `lib/api.ts`'teki tipli wrapper'lardan geçer; component içinde çıplak `invoke` yasak.
2. `AriadneError` tek yerde normalize edilir (`lib/errors.ts`) → toast mı, editör marker'ı mı, banner mı kararı `kind`'a göre.
3. Monaco provider'ları (completion, signature) `lib/monaco/` altında; store'lara `getState()` ile erişir, React'e dokunmaz.
