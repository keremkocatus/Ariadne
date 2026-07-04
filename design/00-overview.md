# Ariadne — Design Overview

> Bu klasördeki dokümanlar Ariadne'nin tasarım referansıdır. Implementasyon sırasında çelişki çıkarsa önce buradaki karar güncellenir, sonra kod yazılır.

## 1. Tek cümlelik vizyon

pgAdmin'in kırık autocomplete'ini ve donan object explorer'ını çözen; hızlı açılan, az RAM yiyen, local-first bir PostgreSQL IDE'si.

## 2. Çözülen problem

1. **Autocomplete**: Şema-farkında değil, context-farkında değil. Ariadne gerçek Postgres parser'ı (`pg_query.rs`) + in-memory şema cache ile tablo/kolon/RPC/JOIN önerisi verir.
2. **Object explorer**: Derin nesting, donma, arama yok. Ariadne virtualized tree + fuzzy search + pin ile çözer.

Görsel şölen (ER diagram, dashboard, monitoring) bilinçli olarak **kapsam dışı**.

## 3. Kesinleşmiş kararlar

| Konu | Karar | Detay dokümanı |
|---|---|---|
| Shell | Tauri v2 | 01 |
| Backend | Rust (sidecar yok), tek crate + modüller ile başla | 01 |
| DB erişim | sqlx (postgres + tokio) | 05 |
| SQL parser | pg_query.rs (libpg_query binding) | 04 |
| Şema cache | İlk bağlantıda tek seferde çekilir, **Faz 0: sadece in-memory** (disk persist Faz 1+) | 03 |
| Frontend | React + TypeScript | 07 |
| State | Zustand | 07 |
| Editör | Monaco + custom completion provider | 04, 07 |
| Tree | react-arborist | 07 |
| Grid | TanStack Table + row virtualization | 05, 07 |
| UI kit | shadcn/ui + Tailwind | 07 |
| Tema | **Siyah-beyaz monokrom minimalizm**; renk yalnızca hata/uyarı/profil-şeridi sinyallerinde | 07 §4 |
| Kısayollar | **SSMS (MSSQL) tarzı**: `Ctrl+E` çalıştır, `Alt+F1` nesne bilgisi, `Ctrl+D` satır kopyala | 07 §3 |
| Uygulama ikonu | Faz 0: geçici monokrom placeholder (`tauri icon` ile üretim); özel tasarım sonra | 09 §5 |
| Uygulama UI dili | **İngilizce** (buton/menü/mesajlar) — "ileride paylaşılabilir" hedefiyle uyumlu, i18n altyapısı kurulmaz | — |
| Credentials | OS keychain (`keyring` crate); öncelik Windows Credential Manager | 06 |
| Platform | Cross-platform hedef, **Windows birinci öncelik** | 09 |
| Completion hesabı | **Rust tarafında** hesaplanır; frontend'e hazır öneri listesi gider | 02, 04 |
| Faz 0 kapsamı | Autocomplete + tree + basit (virtualized ama edit'siz) grid | 10 |
| Transaction desteği | **Faz 0'da var** — tab = session modeli; açık tx'te bağlantı tab'a sabitlenir | 05 §7 |
| Destructive guard | WHERE'siz UPDATE/DELETE/TRUNCATE onay diyaloğu, Faz 0 | 05 §8 |
| Sonuç export | Faz 0: fetch edilmiş satırlardan CSV/clipboard; Faz 1: COPY ile tam export | 07, 02 |
| Force kill & formatter | Faz 1 | 05 §9, 10 |
| Doküman dili | Türkçe anlatım + İngilizce teknik terim; `💡 Rust notu` kutuları içerir | — |

## 4. Kapsam özeti

- **P0**: şema-farkında + context-aware autocomplete, object explorer (fuzzy search, pin), virtualized tree, <1sn cold start / düşük RAM, virtualized result grid (200M+ satır tablolara karşı güvenli).
- **P1**: query history + snippets, multi-connection hızlı geçiş, EXPLAIN görünümü, inline edit, keyboard-first UX (Cmd/Ctrl+Enter, command palette, çoklu tab), cache disk persist, auto-update.
- **P2 (kapsam dışı)**: dependency graph, ER diagram, user/role yönetimi, replication/backup, monitoring dashboard.

## 5. Tasarım prensipleri

1. **Local-first, tek binary.** Bulut yok, telemetri yok.
2. **Cache performansın kalbi.** Autocomplete ve tree asla canlı DB round-trip yapmaz.
3. **Gerçek parser, tahmin değil.** Regex/heuristic yasak; parse edilemeyen SQL'de bile fallback gerçek lexer (`pg_query` scan) üzerinden.
4. **Her özellik "P0 problemi çözüyor mu" testinden geçer.**
5. **Rust yüzeyi dar ve net.** Gereksiz soyutlama yok; komut sayısı az, her komutun tek işi var. (Proje sahibi Rust'a yeni — bkz. 💡 kutuları.)
6. **200M satırlık tablo varsayılan senaryo.** Hiçbir akış "tablo küçüktür" varsayımı yapamaz.

## 6. Doküman indeksi

| # | Dosya | İçerik |
|---|---|---|
| 00 | overview.md | Bu dosya |
| 01 | architecture.md | Sistem mimarisi, process modeli, Rust proje iskeleti |
| 02 | command-api.md | Tauri command'ları, request/response tipleri, hata modeli, event'ler |
| 03 | schema-cache.md | Cache veri modeli, catalog sorguları, refresh/invalidation |
| 04 | autocomplete.md | Parser pipeline'ı, context çıkarımı, Monaco entegrasyonu |
| 05 | query-execution.md | Async execution, cancel, cursor-based pagination, timeout |
| 06 | connections-security.md | Profil modeli, keyring, reconnect, hata formatı |
| 07 | frontend.md | Zustand store'ları, layout, tab yönetimi, tema |
| 08 | testing.md | Rust unit/integration, frontend, e2e stratejisi |
| 09 | packaging.md | Bundler, code signing, auto-update |
| 10 | roadmap.md | Faz 0/1/2, milestone'lar, kabul kriterleri |
| 11 | phase0-refactor.md | Faz 0 sonrası yapısal refactor + design-sapması sertleştirme planı (uygulandı) |
| 12 | phase1-plan.md | Faz 1 analiz ve milestone planı (öncelik: multi-connection, cache persist, EXPLAIN) |
| 13 | handoff.md | Oturum devir notu: nerede kaldık, sırada ne var (soğuk başlangıç haritası) |
| 14 | gui-feedback-backlog.md | Elle GUI testinden çıkan ham bulgu/istek listesi (planı 15'e taşındı) |
| 15 | gui-backlog-plan.md | GUI backlog derin planı: P1-U1…U4 milestone'ları (uygulandı) |
| 16 | user-flows.md | Persona/senaryo analizi + boşluklar + Ö1–Ö8 önerileri (yaşayan belge) |
| 17 | scenario-plan.md | Ö1–Ö8 derin teknik planı: P1-V1…V4 milestone'ları (V4, M5 force-kill'i üstlenir) |
| 18 | explorer-nav-plan.md | GUI turu 2: Explorer hijyeni + SQL Server tarzı navigasyon planı (P1-W1…W3) |

## 7. Stack güncellik notları (Temmuz 2026 itibarıyla doğrulandı)

- `pg_query` crate 6.x serisinde, pganalyze tarafından aktif bakımda; Postgres 16+ sürümlerinden beri Windows build desteği var. **Faz 0'ın ilk gününde Windows'ta `cargo build` ile doğrulanmalı** (libpg_query C kaynağını derliyor — MSVC toolchain gerekir).
- Tauri v2 updater plugin'i imzalı artifact zorunlu kılıyor (`tauri signer generate` ile üretilen key çifti); detay 09'da.
- react-arborist aktif bakımda (v3.12+), 10k+ node'da virtualized render doğrulanmış.
