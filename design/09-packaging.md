# 09 — Paketleme, Code Signing, Auto-Update

Öncelik sırası platform kararıyla aynı: **Windows önce**, macOS/Linux "çalışır durumda tut, cilalama sonra".

## 1. Bundle hedefleri

| Platform | Format | Not |
|---|---|---|
| Windows (öncelik) | **NSIS (.exe)** + MSI | NSIS: updater ile daha sorunsuz, per-user kurulum (admin gerektirmez). WebView2 runtime "downloadBootstrapper" modunda — Win11'de zaten kurulu |
| macOS | .dmg (.app) | Faz 0'da imzasız lokal build yeterli (kendi makinesinde `xattr` ile açılır) |
| Linux | AppImage | En az sürtünmeli tek-dosya |

Beklenen boyut: ~10-15 MB installer (Tauri + Monaco + statik libpg_query). Electron'un ~100MB'ına karşı temel satış noktalarından biri — CI'da bundle boyutu izlenir.

## 2. Code signing gerçekleri

**Windows:**
- Faz 0 (kişisel kullanım): **imzasız.** SmartScreen "unknown publisher" uyarısı verir, "More info → Run anyway" ile geçilir. Tek kullanıcı için kabul edilebilir.
- Paylaşım fazı (P1+): iki yol — (a) **Azure Trusted Signing** (~10$/ay, bireysel geliştiriciye açık, SmartScreen itibarını hızlı kazanır — önerilen), (b) klasik OV sertifikası (~200-400$/yıl + donanım token zorunluluğu). EV şart değil.
- Not: updater imzası (aşağıda) code signing'den **bağımsızdır** ve Faz 0'da bile gerekir.

**macOS (paylaşım fazında):** Apple Developer Program (99$/yıl) + notarization. Tauri bunu `tauri build` akışında destekliyor. Faz 0'da atlanır.

## 3. Auto-update

Tauri v2 `updater` plugin'i, **Faz 1'de** açılır (Faz 0: elle kurulum).

- **Anahtar çifti**: `tauri signer generate` → private key GitHub Actions secret'ı, public key `tauri.conf.json`'a gömülür. Updater imzasız artifact'ı **reddeder** (kapatılamaz — güvenlik açısından doğru). ⚠️ Private key kaybolursa mevcut kurulumlara bir daha update gönderilemez → key 1Password/keyring + offline yedek.
- **Endpoint**: GitHub Releases. `latest.json` (sürüm, notlar, platform → url + signature) release asset'i olarak yayınlanır; updater config'i `https://github.com/<user>/ariadne/releases/latest/download/latest.json`'ı işaret eder. Sunucu maliyeti sıfır, local-first prensibiyle uyumlu (sadece sürüm kontrolü için ağa çıkar, o da kullanıcı onayıyla).
- **Akış**: açılışta sessiz kontrol → "v0.3 var" toast → kullanıcı onaylarsa indir+kur+restart. Otomatik sessiz kurulum yok.
- `createUpdaterArtifacts: true` ile build, imza dosyaları (.sig) otomatik üretilir.

## 4. Release pipeline (Faz 1 hedef durumu)

```
git tag v0.x.y → GitHub Actions:
  1. test + clippy (08'deki zincir)
  2. matrix build: windows-latest / macos-latest / ubuntu-22.04
  3. tauri build (signing env secret'lardan)
  4. draft GitHub Release: installer'lar + .sig + latest.json
  5. release notlarını elle gözden geçir → publish
```

Faz 0'da bunun sadece "windows build + artifact" kısmı CI'da (08 §6) — release töreni yok, `cargo tauri build` lokalde yeterli.

## 5. Uygulama ikonu

**Faz 0: geçici placeholder, özel tasarım sonra.** Geçici ikon: monokrom (temayla uyumlu) — siyah yuvarlatılmış kare zemin üzerine beyaz, tek çizgiden kıvrılan **iplik/labirent motifli "A"** harfi; basit bir SVG olarak çizilir, `tauri icon <svg>` komutu tüm platform formatlarını (ico/icns/png setleri) otomatik üretir. Özel tasarım geldiğinde tek yapılacak şey aynı komutu yeni kaynakla koşmak — başka hiçbir yerde ikon referansı hardcode edilmez.

## 6. Sürümleme

SemVer, `0.x` serisi: kırıcı her şey serbest, `CHANGELOG.md` tutulur (updater release notlarının kaynağı). `1.0` kriteri: P0'ların tamamı + 1 ay günlük kullanımda kritik bug çıkmaması.
