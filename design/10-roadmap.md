# 10 — Roadmap: Fazlar, Milestone'lar, Kabul Kriterleri

Karar (Q&A): Faz 0 = autocomplete + tree + basit grid. Milestone'lar **her adımda çalışan uygulama** bırakacak şekilde sıralandı — Rust öğrenme eğrisi de basitten zora doğru akar.

## Faz 0 — "pgAdmin'i kapatabilirim" sürümü

### M0 — İskelet yürüyor (Rust ısınması)
Tauri v2 projesi + React/TS/Tailwind/shadcn kurulumu. **Gün 1 riski erit**: `pg_query` ve `sqlx` Windows'ta derleniyor mu — boş projede doğrula (00 §7). Tek hardcoded bağlantı, tek editör (Monaco, completion'sız), `run_query`'nin cursor'suz hali, sonuç ham `<pre>`. AriadneError iskeleti.
✅ *Kabul: `SELECT version()` yazıp Ctrl+Enter ile sonucu görüyorum.*

### M1 — Şema cache + object explorer (P0 #3, #4)
Catalog sorguları → SchemaCache → snapshot → react-arborist tree. Fuzzy search + pin. Profil CRUD + keyring + bağlantı diyaloğu (hardcoded bağlantı gider). Refresh (manuel + connect'te).
✅ *Kabul: prod şemasında (yüzlerce tablo) tree anında açılıyor, arama < 50ms, pin çalışıyor.*

### M2 — Autocomplete (P0 #1, #2 — projenin kalbi)
Sıra: (a) context çıkarımı — golden test tablosuyla TDD (08 §1), (b) sentinel/onarım kademeleri, (c) aday üretimi + rank, (d) Monaco provider + signature help. FK-güdümlü JOIN önerisi dahil.
Aynı motorun ikinci tüketicisi olarak `get_object_info` + `Alt+F1` peek paneli de bu milestone'da (alias çözümü zaten yazılmış oluyor).
✅ *Kabul: 04'teki golden case'lerin tamamı geçiyor; gerçek şemada `u.` yazınca doğru kolonlar < 10ms'de düşüyor; `JOIN` yazınca FK'li tablo ON koşuluyla ilk sırada; `u` üzerinde Alt+F1 users'ın kolon/FK panelini açıyor.*

### M3 — Gerçek grid + execution sertleşmesi (P0 #6)
Cursor'lu execution (05), fetch_page/sonsuz scroll, cancel, TanStack grid (satır+kolon virtualization), çoklu tab, statement split, hata → editör marker. **Transaction desteği: tab = session modeli + TX rozeti + Commit/Rollback (05 §7)**. **Destructive guard: WHERE'siz UPDATE/DELETE onayı (05 §8)**. **Grid'den kopyalama/CSV export (fetch edilmiş satırlar, 07)**. Performans bütçe ölçümleri (01 §6) + criterion bench'ler.
✅ *Kabul: 200M satırlık tabloda `SELECT *` → ilk 500 satır anında, scroll akıcı, cancel < 1sn etki ediyor, RAM sınırda. BEGIN → ayrı çalıştırmayla UPDATE → ROLLBACK akışı çalışıyor; WHERE'siz DELETE onay soruyor.*

**Faz 0 çıkış kriteri:** 1 hafta boyunca günlük işte pgAdmin'i hiç açmadan çalışabilmek. Cold start < 1sn, idle RAM < 200MB ölçülmüş.

## Faz 1 — Günlük konforu (sıralama fayda/maliyete göre)

1. Query history + saved snippets (yerel SQLite)
2. Multi-connection eşzamanlı + hızlı geçiş (mimari zaten hazır — UI işi)
3. Cache disk persist (rusqlite) → dev şemalarda anında cold start
4. Okunaklı EXPLAIN (ANALYZE) görünümü
5. Auto-update + release pipeline (09)
6. Inline veri düzenleme (PK'lı tablolarda hücre edit → UPDATE önizlemesi)
7. Completion ranking'e kullanım frekansı; açık tema; hücre tam-değer görüntüleme
8. Force kill — `pg_terminate_backend` (05 §9)
9. Tam sonuç export'u — `COPY TO STDOUT` ile server-side CSV stream (02 `export_result_csv`)
10. SQL formatter (`Ctrl+Shift+F`) — pg_query deparse yorum/stil kaybettiği için harici formatter entegrasyonu değerlendirilecek
11. SSH tüneli üzerinden bağlantı (bastion arkasındaki DB'ler) — ihtiyaç doğarsa; `russh` ile lokal port forward, profil modeline `ssh: Option<SshConfig>` eklenir

## Faz 2 — Bilinçli olarak yok

Dependency graph, ER diagram, role yönetimi, monitoring/backup tooling. Her yeni fikir için filtre: **"Bu, P0'daki iki kırık şeyi (autocomplete/explorer) daha iyi çözüyor mu?"** Hayırsa girmiyor.

## Risk kaydı

| Risk | Etki | Erken sinyal / önlem |
|---|---|---|
| `pg_query` Windows/MSVC derleme sorunu | Stack'in kalbi | M0 gün 1'de test; kırıksa fallback `pg_parse` crate'i değerlendirilir (daha hafif binding) |
| Yarım-SQL onarımının yetersiz kaldığı pattern'ler | Autocomplete kalitesi | Golden test tablosu + günlük kullanımda "kötü öneri" günlüğü tutup case'e çevirme |
| Rust öğrenme eğrisi (async/ownership) | Takvim | Milestone'lar kasıtlı küçük; 💡 kutuları; M0-M1 basit I/O, zor eşzamanlılık M3'te |
| Tauri IPC'de büyük payload yavaşlığı | Grid akıcılığı | M3'te ölç; gerekirse raw-body binary encoding (05 §4'te hazır plan) |
| Açık cursor tx'lerinin prod'da vacuum etkisi | Prod hijyeni | 15dk idle-close (05 §2) + status bar'da açık cursor göstergesi |
