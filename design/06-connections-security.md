# 06 — Bağlantı & Credential Yönetimi, Hata/Retry

## 1. Profil modeli

```rust
pub struct ConnectionProfile {
    pub id: ProfileId,
    pub name: String,              // "prod-analytics"
    pub color: Option<String>,     // tab/status bar şerit rengi — prod'u yeşil sanma kazasına karşı
    pub host: String,
    pub port: u16,                 // default 5432
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,         // Disable | Prefer | Require | VerifyCa | VerifyFull
    pub statement_timeout_ms: Option<u64>,   // None = sınırsız
    pub read_only: bool,           // true → session default_transaction_read_only=on (prod koruması)
    pub options: HashMap<String, String>,    // application_name vb. ek parametreler
}
```

- Saklama yeri: `{app_config_dir}/profiles.json` (Tauri `app_config_dir`; Windows'ta `%APPDATA%/ariadne/`). **Şifre bu dosyaya asla yazılmaz.**
- `application_name` daima `ariadne` set edilir → sunucuda `pg_stat_activity`'de ayırt edilebilirlik.

## 2. Şifreler: OS keychain

- `keyring` crate: Windows Credential Manager (öncelikli platform), macOS Keychain, Linux Secret Service tek API'de.
- Kayıt anahtarı: `service = "ariadne"`, `account = profile_id`. Profil silinince keyring kaydı da silinir.
- Şifre bellekten geçerken `zeroize` ile sarılır; log'a, error mesajına, IPC'ye asla çıkmaz (connection string log'lanırken şifre alanı redact edilir).
- Keyring erişimi başarısız olursa (`KeyringError`): kullanıcıya şifreyi elle girme diyaloğu — uygulama çalışmaya devam eder, sadece o oturum için bellekte tutulur.
- **Connection string import**: "New connection" diyaloğuna `postgres://user:pass@host:port/db?sslmode=require` yapıştırılınca parse edilip forma dökülür (şifre keyring'e). Parser olarak sqlx'in `PgConnectOptions::from_str`'ı kullanılır — el yazması URL parser yok.

## 3. Pool ayarları

| Ayar | Değer | Gerekçe |
|---|---|---|
| max_connections | 5 | IDE'dir, uygulama sunucusu değil; sorgu-başına-dedicated model (05) için yeterli |
| min_connections | 0 | idle'da sunucuda slot işgal etme |
| acquire_timeout | 10 sn | 5 slot da doluysa (5 uzun sorgu koşuyor) net hata: "eşzamanlı sorgu sınırı" |
| idle_timeout | 5 dk | idle bağlantı bırakılır → düşük ayak izi |
| test_before_acquire | true | ölü bağlantıyı kullanıcıya hata olarak yansıtma |

## 4. Kopma ve retry davranışı

**İlke: veri işi yapan hiçbir şey otomatik retry edilmez.** Bir sorgu koşarken bağlantı koptuysa sorgunun sunucuda tamamlanıp tamamlanmadığı bilinemez; sessiz retry, DML'i iki kez çalıştırabilir.

| Durum | Davranış |
|---|---|
| Sorgu sırasında kopma | Sorgu `ConnectionLost` hatasıyla düşer; **retry yok**. UI: hata + "Reconnect" butonu |
| Idle'da kopma (pool test'i yakalar) | Sessizce yeni bağlantı denenir (1 kez); başarısızsa `connection:lost` event → status bar kırmızı, banner |
| Cache refresh sırasında kopma | Eski snapshot kalır (zaten immutable), refresh hatası status bar'da sessiz uyarı |
| Reconnect (kullanıcı tetikli) | Pool yeniden kurulur; açık cursor'lu tab'lar "sonuç geçersiz, yeniden çalıştır" durumuna düşer (cursor'lar öldü) |
| Laptop sleep/resume | Idle-kopma yoluyla aynı: ilk işlemde test_before_acquire yakalar, sessiz tek deneme |

## 5. Hata sunumu

Kaynak format 02'deki `AriadneError`. Sunum kuralları:

- **Syntax/semantik SQL hataları** (`QueryError` + `position`): editörde ilgili offset'e kırmızı marker + alt panelde mesaj. Postgres'in `HINT`/`DETAIL` alanları katlanabilir bölümde. sqlstate koduna insan-dili başlık eşlemesi küçük bir tabloyla (`42P01 → "Tablo bulunamadı"` vb., ~20 yaygın kod; gerisi ham mesaj).
- **Bağlantı hataları**: teknik zinciri (`detail`) gizle, tek satır net neden göster: "Şifre hatalı (28P01)", "Sunucuya ulaşılamadı (timeout)".
- **Internal**: "Beklenmeyen hata" + detayı kopyalama butonu (issue açmak için).

## 6. Güvenlik notları

- TLS: `ssl_mode` sqlx'e doğrudan geçer; `VerifyFull` için CA sertifika dosyası profile eklenebilir (Faz 1; Faz 0'da `Require`'a kadar).
- SQL injection kavramı bu bağlamda yok (kullanıcı zaten ham SQL yazıyor) ama **cache catalog sorguları** parametrize edilir; şema adı gibi girdiler asla format!'la SQL'e gömülmez.
- `read_only` profil bayrağı Faz 0'da var: prod bağlantısını yanlışlıkla UPDATE'ten koruyan en ucuz sigorta (`SET default_transaction_read_only = on`; kullanıcı isterse `BEGIN READ WRITE` ile bilinçli delebilir — engel değil, emniyet kemeri).
