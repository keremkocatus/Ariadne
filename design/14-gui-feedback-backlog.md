# 14 — GUI Test Bulguları / Backlog (ham notlar)

> Tarih: 2026-07-04. P1-M1 (multi-connection) `npm run tauri dev` ile canlı DB'ye
> karşı elle test edilirken toplanan bulgular. **Bunlar ham notlardır — henüz
> tasarlanmadı, önceliklendirilmedi, kabul kriteri yazılmadı.** Yeni bir oturumda
> önce derin planlama yapılacak (design/12 tarzı bir analiz + milestone bölünmesi),
> sonra uygulanacak. Bu dosya yalnızca "unutmayalım" amaçlı bir yakalama listesi.

## 1. Editör / çalıştırma

- **Seçili kod parçasını çalıştırma eksik.** Şu an Run (Ctrl+Enter/Ctrl+E/F5) her
  zaman tüm tab'ın SQL'ini çalıştırıyor gibi görünüyor; SSMS/Azure Data Studio
  tarzı "mouse ile seçili metni çalıştır" özelliği yok. (İlgili: design/07 §3.)
- **Hata marker'ı editörde kalıcı kalıyor.** Bir statement hata verince kırmızı
  alt-çizgi marker'ı ekleniyor (design 11 §H1); hatalı kodu silip düzeltsem bile
  marker editörde kalmaya devam ediyor — yalnızca yeni bir Run temizliyor gibi
  görünüyor, ama muhtemelen edit anında da temizlenmeli (stale marker bug).

## 2. Tab'lar

- **Her yeni tab'ın başlığı aynı ("Query").** Numaralandırma istiyoruz (Query 1,
  Query 2, …). Farklı bağlantılardaki tab'lar için başlıkta hangi connection'a
  ait olduğu da görünsün (bugün yalnızca renk şeridi + tooltip var — design 12
  §P1-M1 item 1'de tooltip eklendi ama başlık metninde bağlantı adı yok).
- **"Yeni tab" (+) butonu tab şeridinin en soluna/uzağına değil, mevcut tab'ların
  hemen sağına taşınsın** — klasik tarayıcı "yeni sekme" butonu gibi.
- **Kritik davranış netleştirmesi — P1-M1'in ConnectionMenu davranışıyla
  ÇELİŞİYOR, tekrar gözden geçirilmeli:** her tab'ın TEK bir connection'a (ve o
  connection'ın TEK bir veritabanına) bağlı olması gerektiği doğrulandı, ama
  şu anki uygulama (design 12 §P1-M1, `ConnectionMenu.bindActiveTab`) üstten
  bağlantı seçildiğinde **aktif tab'ı da o bağlantıya bağlıyor**. Kullanıcı
  bunun YANLIŞ olduğunu belirtti: üstten bağlantı seçmek o anki tab'ı
  değiştirmemeli; bunun yerine muhtemelen otomatik yeni bir tab açılmalı (yeni
  bağlantıyla). **Sonraki derin planlamada `bindActiveTab` çağrıları
  (ConnectionMenu + CommandPalette) yeniden değerlendirilmeli** — belki üstten
  seçim sadece "yeni tab varsayılanı"nı değiştirmeli + otomatik yeni tab açmalı,
  aktif tab'ı sessizce rebind etmemeli.
- **Aynı connection içinde farklı bir veritabanına geçiş** için bir yol olsun
  (bugün "connection" = tek sunucu + tek db; sunucu aynı kalıp db değiştirmek
  için profili yeniden bağlamak gerekiyor gibi görünüyor).

## 3. Bağlantı seçimi

- **Üstten (ConnectionMenu) bağlantı seçildiğinde Explorer/tablolar otomatik
  refreshlensin.** Bugün yeni `connect()` sonrası `loadSnapshot` çağrılıyor
  ama zaten-bağlı bir connection'a geçişte (menüden tıklama) otomatik refresh
  tetiklenmiyor olabilir — doğrulanmalı.

## 4. Explorer — tıklama davranışı

- **Tabloya tek tık = sadece bilgi/peek göstersin** (bugünkü davranışı çok
  beğendi); **çift tık = tabloyu aç** (yeni tab'da `SELECT * FROM …`). Şu an
  `Explorer.openNode` tek tıkta hem peek hem open birlikte tetikliyor — ayrılmalı.
- **Peek panelinde aşağı kaydırınca index ve trigger bilgileri de görünsün**
  (bugün muhtemelen yalnızca kolonlar var).
- **Alt+F1 (object info) çıktısı command output (sonuç) ekranında da görünsün**
  — SQL Server "sp_help" mantığı gibi. Bugün yalnızca `ObjectInfoPanel` (yüzen
  panel) var; sonuç alanına da yansımalı (ya da onun yerini alacak bir mod).
- **Çok sütunlu tablolarda peek/kolon listesi taşma durumunu handle etsin**
  (yatay scroll / sanallaştırma — tek-tık kolon görünümü için).

## 5. Explorer — filtreleme

- **Tables ve Functions sekmelerine sağ-tık ile filtre menüsü** eklensin:
  - Tablo adına / fonksiyon adına göre metin filtresi.
  - Mümkünse tablo **tipi**ne göre filtre (table / view / vs.).
  - Fonksiyon **tipi**ne göre filtre (trigger function / system function /
    kullanıcı RPC fonksiyonu gibi).

## 6. Fonksiyonlar

- **Fonksiyona çift tık → yeni tab'da o fonksiyonun tam `CREATE OR REPLACE
  FUNCTION …` kaynağı açılsın** (SQL Server "Modify" özelliği gibi) — düzenleyip
  tekrar çalıştırılabilir olmalı.

## 7. Diğer yeni bölümler

- **Ayarlar sekmesi** (şimdilik minimal olabilir — kapsam sonraki planlamada).
- **.sql dosyası açma/kaydetme** — önemli, eksik.
- **Users & Roles** görünümü GUI'ye eklensin (Postgres rol/kullanıcı listesi;
  kapsam — salt-okunur liste mi, CRUD mu — planlamada netleşecek).

## 8. Sonraki adım

Yeni oturum: bu listeyi design/12 tarzında analiz edip (neredeyiz / plan /
kabul / risk) milestone'lara böl — muhtemelen birden fazla küçük milestone
(editör/tab UX, explorer/peek zenginleştirme, connection-tab izolasyonu düzeltmesi,
dosya I/O, users&roles) design/12'nin P1-M4/P1-M5'iyle birleştirilebilir ya da
ayrı bir Faz olarak (P1-M6+) sıraya konabilir. §2'deki ConnectionMenu çelişkisi
öncelikli — mevcut davranış kullanıcı beklentisiyle uyuşmuyor.
