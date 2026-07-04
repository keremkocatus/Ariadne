# 16 — Kullanıcı Odaklı Akışlar ve Senaryo-Türevi Öneriler

> Tarih: 2026-07-04. Amaç: Ariadne'yi kullanması muhtemel insan profillerini ve
> onların uygulamaya girdikleri andan itibaren adım adım ne yaptıklarını yazmak;
> her adımda bugünkü uygulamanın verdiği cevabı işaretlemek (✅ var / 🔶 kısmen —
> planlandı / ❌ yok) ve buradan çıkan yeni önerileri önceliklendirmek.
> design/15'teki U-milestone'lara ve design/12'nin M-milestone'larına referans verir.

## 1. Profiller (persona)

| # | Kim | Tipik oturum | Toleransı düşük olduğu şey |
|---|---|---|---|
| P1 | **Backend geliştirici** (birincil persona — bugünkü kullanıcı) | Günde onlarca kez: tablo bak, sorgu yaz-koş-düzelt, sonucu koda taşı | Yavaş açılış, şema araması, bağlantı karışması |
| P2 | **Prod yangını söndüren** (aynı kişi, kötü gününde) | Nadir ama kritik: yavaş sorguyu bul, planına bak, gerekirse öldür | Yanlış sunucuda komut koşmak, belirsizlik |
| P3 | **Veri bakan / analist-vari** | Uzun SELECT'ler, sonucu dışarı alma, dünkü sorguyu bulma | Sonucu kaybetmek, elle tekrar yazmak |
| P4 | **DB bakımcısı (hafif DBA)** | Roller, izinler, şişen tablolar, kilitler | Ekranda görünmeyen sunucu durumu |
| P5 | **Migration/fonksiyon yazarı** | DDL taslağı, fonksiyon düzenleme, tx içinde deneme | Yanlışlıkla commit, kaynağa ulaşamamak |

## 2. Senaryolar (adım adım)

### S1 — İlk açılış (P1, ilk 5 dakika)

1. Uygulamayı açar → boş tab + "No connection". **❌ Boşluk**: ne yapacağını
   söyleyen hiçbir şey yok; ConnectionMenu'nün küçük butonunu keşfetmesi gerekir.
2. Profil oluşturur, Test → Connect. ✅ (keychain, renk, test akışı var)
3. Explorer dolar, tabloya tıklar, kolonlara bakar. ✅ (peek; U3 tık ayrımıyla netleşecek)
4. İlk sorgusunu yazar, autocomplete'i görür, Ctrl+Enter. ✅

**→ Öneri Ö1 (boş durum ekranı):** bağlantısız tab'ın editör alanına hafif bir
"başlangıç kartı": *Connect (Ctrl+K) · Open .sql (Ctrl+O) · kısayol listesi*.
Tek component, veri yok; ilk izlenimi ve keşfedilebilirliği büyütür.

### S2 — Günlük döngü (P1, en sık akış)

1. Uygulamayı açar → dünkü tab'ları SQL'leriyle geri gelir. ✅ (persist)
2. Ama bağlantılar boş başlar → banner'dan yeniden bağlanması gerekir. 🔶
   Banner var; yine de her sabah aynı 2 tık.
3. Şemada tablo arar (Ctrl+P). ✅ — açılışta cache fetch'ini bekler. 🔶 P1-M2
   (disk persist) bunu 0 saniyeye indirecek; **M2'nin değerini S2 doğruluyor.**
4. Sorgunun bir parçasını seçip koşar. 🔶 U2.
5. Sonuçtan birkaç hücreyi koda/PR'a kopyalar. **❌ Boşluk**: grid'de "kopyala"
   yalnız ne varsa o (tek hücre metni?); satır/kolon/seçim'i CSV-JSON-Markdown
   olarak alma yolu yok.

**→ Öneri Ö2 (açılışta tek-tık geri dönüş):** açılışta son oturumun *profil*
listesi biliniyor (tab'ların `connectionId` → profil eşlemesi persist'te var).
Banner'a ek: uygulama açılışında bir toast/kart — "Reconnect to raildb?" tek
tık. Otomatik bağlanma DEĞİL (yanlış ağda/VPN'siz açılışta hata seli olmasın),
tek tıklık davet.
**→ Öneri Ö3 (grid kopyalama menüsü):** grid'de sağ-tık: *Copy cell / Copy row(s)
as CSV / JSON / Markdown table / Copy column name(s)*. P1-M5'teki "tam CSV
export"un küçük kardeşi; günlük değeri ondan yüksek, maliyeti düşük.

### S3 — "Prod'da bir şey yavaş" (P2, kritik akış)

1. Prod profiline bağlanır — kırmızı renk şeridi her tab'da. ✅ (06 §1 tasarımı)
2. Yavaş sorguyu EXPLAIN ANALYZE ile inceler. 🔶 P1-M3 planlı.
3. *Kimin ne koştuğunu* görmek ister (`pg_stat_activity`). **❌ Boşluk**: GUI'de
   sunucu aktivite görünümü yok; elle katalog sorgusu yazması gerekir.
4. Azgın sorguyu öldürür. 🔶 P1-M5 force kill planlı — ama kill'in doğal evi
   3. adımdaki aktivite listesidir ("bu satırı öldür"), kendi tab'ındaki
   cancel değil.
5. Prod'da yanlışlıkla UPDATE yazmaktan korkar. 🔶 Destructive guard var;
   profildeki `read_only` alanı UI'da görünmüyor/zorlanmıyor gibi.

**→ Öneri Ö4 (Activity paneli):** sidebar'a üçüncü sekme ya da palette eylemi:
`pg_stat_activity` listesi (pid, user, state, süre, sorgu özeti) + satırda
Cancel/Kill. P1-M5'teki `kill_query` backend'iyle AYNI oturumda yapılmalı —
aynı komutun iki tüketicisi. P2 personasının uygulamayı "acil durumda da
açtığı araç" yapan özellik budur.
**→ Öneri Ö5 (read-only rozeti):** profil `read_only` ise Toolbar/StatusBar'da
kalıcı "RO" rozeti + guard mesajlarında "this profile is read-only" netliği.
Alan zaten modelde var; iş neredeyse yalnız görünürlük.

### S4 — "Geçen hafta yazdığım sorgu" (P3)

1. Benzer bir işi daha önce çözdüğünü hatırlar. 🔶 P1-M4 history planlı;
   S4, M4'ün kapsamını doğruluyor (fuzzy arama + çift tık yeni tab şart).
2. Sık kullandığı 3-4 sorguyu şablon olarak saklamak ister. 🔶 M4 snippets.
3. Sonucu Excel'e/rapora taşır. 🔶 M5 CSV export; Ö3 küçük ihtiyaçları karşılar.

**→ Öneri Ö6 (yeni tab başlangıç içeriği):** boş yeni tab'da (Ö1 kartının
altında) "son dosyalar + son sorgular (M4 sonrası) + pinned snippet'ler"
listesi. M4'ten ÖNCE yapılmaz; M4'ün UI'ına giriş noktası olarak planlanır.

### S5 — Fonksiyon/migration düzenleme (P5)

1. Fonksiyonu Explorer'da bulur, kaynağını açar. 🔶 U3 planlı.
2. `BEGIN` içinde dener, sonucu inceler, `ROLLBACK`. ✅ (tx rozetleri, kapatma onayı)
3. Beğenince .sql olarak repoya kaydeder. 🔶 U4 planlı.
4. Uzun DDL koşarken başka tab'da çalışır; bitince haber ister. **❌ Boşluk**:
   arka plandaki tab'ın sorgusu bitince hiçbir sinyal yok.

**→ Öneri Ö7 (bitiş sinyali):** aktif olmayan tab'ın sorgusu bitince tab
başlığında nokta/rozet + (≥ N sn sürdüyse, öneri N=10) OS bildirimi ya da toast:
"Query 2 finished — 12.4s, 1,204 rows". Tab-başına state zaten var; ucuz iş,
P5 ve P3'ün uzun sorgularında büyük konfor.

### S6 — Çok ortamlı çalışma (P1, dev+prod yan yana)

1. Dev'e ve prod'a aynı anda bağlanır; tab'lar karışmasın ister. ✅ P1-M1 +
   U1 semantik düzeltmesi tam bunu hedefliyor; U2 bağlantı etiketi tamamlar.
2. Aynı sorguyu iki ortamda koşup çıktıyı karşılaştırır. **❌ Boşluk** (bilinçli):
   sonuç diff'i büyük iş — Faz 2+ adayı, şimdilik kapsam dışı notu yeter.
3. Aynı sunucuda ikinci veritabanına geçer. 🔶 U1 "Databases ▸".

### S7 — Bakım turu (P4)

1. Rollere/izinlere bakar. 🔶 U4 planlı (salt-okunur).
2. En büyük tabloları, şişmeyi (bloat) merak eder. 🔶 U3 `get_relation_details`
   peek'e `size_bytes` getiriyor; "sunucu geneli en büyük 20 tablo" görünümü yok.
3. Kilitleri kontrol eder. **❌** — Ö4 Activity paneline "locks" sekmesi olarak
   eklenebilir (pg_locks join'i), v1'de şart değil.

**→ Öneri Ö8 (boyut sıralı görünüm — düşük öncelik):** Explorer'da şema düğümü
peek'i: tablolar boyuta göre sıralı mini liste. `get_relation_details` çıktısının
şema-düzeyi toplaması; U3 altyapısı bittikten sonra ucuz.

## 3. Boşluk analizi — özet tablo

| Senaryo adımı | Durum | Nerede çözülüyor |
|---|---|---|
| İlk açılış rehberliği | ❌ | **Ö1** (yeni) |
| Açılışta hızlı yeniden bağlanma | ❌ | **Ö2** (yeni) |
| Seçili metni çalıştırma | 🔶 | U2 |
| Grid'den zengin kopyalama | ❌ | **Ö3** (yeni) |
| Şema aramasının açılış gecikmesi | 🔶 | P1-M2 (öncelik doğrulandı) |
| Sunucu aktivitesi + kill | ❌/🔶 | **Ö4** (yeni) + P1-M5 kill backend'i |
| Read-only görünürlüğü | ❌ | **Ö5** (yeni, ucuz) |
| History/snippets | 🔶 | P1-M4 (öncelik doğrulandı) |
| Yeni tab başlangıç içeriği | ❌ | **Ö6** (M4 sonrası) |
| Fonksiyon kaynağı, .sql, roller, peek zenginleştirme | 🔶 | U3/U4 |
| Arka plan sorgu bitiş sinyali | ❌ | **Ö7** (yeni, ucuz) |
| İki ortam sonuç diff'i | ❌ | Faz 2+ (bilinçli erteleme) |
| Kilitler / boyut turu | ❌ | **Ö8** + Ö4 genişlemesi (düşük öncelik) |

## 4. Önerilerin önceliklendirmesi

**Hemen (mevcut U-milestone'lara iliştir, her biri ≤ yarım oturum):**
- **Ö5** read-only rozeti → U1'e (bağlantı semantiği zaten elleniyor).
- **Ö1** boş durum kartı → U2'ye (TabBar/editör alanı zaten elleniyor).
- **Ö7** bitiş sinyali → U2'ye (tab state zaten elleniyor).

**Yakın dönem (kendi başına küçük iş):**
- **Ö3** grid kopyalama menüsü — bağımsız; M5 export'tan önce bile yapılabilir.
- **Ö2** açılışta reconnect daveti — U1 sonrası (focusConnection'ı kullanır).

**Bağımlı / sıralı:**
- **Ö4** Activity paneli — P1-M5 `kill_query` ile aynı oturum.
- **Ö6** yeni tab başlangıç içeriği — P1-M4 sonrası.
- **Ö8** boyut görünümü — U3 sonrası, sıkışınca.

**Bilinçli erteleme:** sonuç diff'i, lock görünümü v1, grafik/chart, otomatik
bağlanma (Ö2'nin otomatik hali — hata seli riski).

## 5. Sonraki adım

U-milestone'ları uygulanırken "Hemen" sınıfı öneriler ilgili milestone'un kabul
listesine eklenerek gidilir; "Yakın dönem" olanlar U4 sonrasında ayrı küçük
oturumlar. Bu dosya yeni senaryo/bulgu çıktıkça design/14 yerine güncellenecek
yaşayan belgedir (14 ham yakalama listesiydi; planı 15, senaryoları 16 taşır).
