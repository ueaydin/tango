# YouTube Tango Overlay

YouTube'da çalan tango şarkısını otomatik tanıyan ve sayfanın sağ üst köşesinde
orkestra, kantor, yıl, besteci, söz yazarı ve diğer bilgileri gösteren Chrome
eklentisi. Tamamen offline çalışır — eklenti paketine gömülü El Recodo
veritabanında fuzzy eşleştirme yapar.

## Özellikler

- ~16.858 kayıtlık El Recodo tango veritabanı eklenti içine gömülür
- [Fuse.js](https://www.fusejs.io/) ile yazım farklılıklarına dayanıklı eşleştirme
- Shadow DOM ile sayfa CSS'inden tam izole overlay kart
- Sürüklenebilir kart, kapatma butonu, fade-in animasyonu
- YouTube SPA gezinmelerinde kart otomatik günceller
- Popup üzerinden eklentiyi aç/kapa ve eşleşme hassasiyeti ayarı
- Manifest V3 uyumlu, hiç remote kod yok, strict CSP

## Dosya Yapısı

```
tango/
├── tango-overlay/               # Chrome'a yüklenecek eklenti klasörü
│   ├── manifest.json
│   ├── content.js               # YouTube'a enjekte olan ana script
│   ├── overlay.css              # Shadow DOM içine giren stiller
│   ├── popup.html / popup.js / popup.css
│   ├── lib/fuse.min.js          # Fuse.js v7 (Apache 2.0)
│   ├── data/tango_database.json # scripts/xlsx_to_json.py çıktısı
│   └── icons/icon{16,48,128}.png
├── scripts/
│   └── xlsx_to_json.py          # XLSX veya CSV → JSON dönüştürücü
├── el_recodo_Tüm Kayıtlar.xlsx  # Kaynak veritabanı
└── README.md
```

## Kurulum

### 1. Veritabanını JSON'a çevir (tek seferlik)

El Recodo kaydı XLSX formatında. Eklenti JSON okuduğu için önce dönüştürülmeli:

```bash
# openpyxl kurulu değilse:
pip install openpyxl

# Varsayılan girdi: el_recodo_Tüm Kayıtlar.xlsx
python3 scripts/xlsx_to_json.py

# Veya özel yol:
python3 scripts/xlsx_to_json.py path/to/baska.xlsx
python3 scripts/xlsx_to_json.py path/to/baska.csv
python3 scripts/xlsx_to_json.py input.xlsx -o out/custom.json
```

Script, `tango-overlay/data/tango_database.json` dosyasını üretir (~6 MB).
Bu dosya Git'e commit edilir, böylece eklentiyi indiren kişi dönüştürme
adımını tekrar çalıştırmak zorunda kalmaz.

### 2. Chrome'a yükle

1. Chrome → `chrome://extensions/`
2. Sağ üstten "Developer mode" açık konumda olsun
3. "Load unpacked" → `tango-overlay/` klasörünü seç
4. Eklenti listede görünmeli, hata yok

### 3. Kullan

Herhangi bir YouTube tango videosu aç (örn. Canaro "Poema"). Kart 0.5-1 sn
içinde sağ üst köşede belirir.

- **Sürükle**: Kart başlığından tut, istediğin yere taşı (pozisyon kalıcı)
- **Kapat**: X butonu — sadece mevcut video için gizler
- **Ayarlar**: Toolbar ikonuna tıkla → hassasiyeti değiştir, aç/kapa

## Nasıl Çalışıyor

1. **Content script** (`content.js`) her `youtube.com/watch*` sayfasına enjekte
   olur. `manifest.json`'daki `content_scripts` üzerinden `lib/fuse.min.js`
   önce yüklenir, `Fuse` global olarak erişilebilir hale gelir.

2. **Veritabanı yükleme**: İlk çağrıda
   `chrome.runtime.getURL("data/tango_database.json")` ile fetch edilir, Fuse
   indeksi kurulur. İndeks runtime'da oluşturulur (~200-500ms, 16k kayıt için
   tek seferlik).

3. **Başlık okuma**: Üç kaynak sırayla denenir:
   - `h1.ytd-watch-metadata yt-formatted-string` (YouTube ana başlık)
   - `document.title`
   - `meta[property="og:title"]`

4. **Normalizasyon**: Başlık NFD unicode decomposition → combining mark
   kaldırma → lowercase → harf/rakam/boşluk dışını temizle. Aynı algoritma
   Python scriptinde veritabanını önceden normalize eder (`_n_title`,
   `_n_orchestra`, `_n_singer` alanları). Bu sayede aksanlı harfler
   ve İspanyolca/Türkçe karakterler sorun çıkarmaz.

5. **Fuzzy search**: Fuse.js normalize edilmiş başlıkta `_n_title` (0.6
   ağırlık), `_n_orchestra` (0.25), `_n_singer` (0.15) alanlarında arar.
   Threshold varsayılan 0.4 (popup üzerinden 0.1–0.7 arası ayarlanabilir).
   Başlıkta yıl geçiyorsa, o yıla yakın kayıtlara hafif skor bonusu verilir.

6. **Kart render**: Shadow DOM host oluşturulur (`attachShadow({mode:'open'})`),
   `overlay.css` runtime'da fetch edilip `<style>` olarak enjekte edilir.
   Sayfa CSS'i karta, kart CSS'i de sayfaya sızmaz.

7. **SPA navigation**: YouTube sayfada URL'yi tam reload etmeden değiştirir.
   Üç ayrı mekanizma dinlenir:
   - `yt-navigate-finish` event (YouTube'un kendi SPA eventi)
   - `location.href` fark gözeten MutationObserver (fallback)
   - `<title>` element MutationObserver (video başlığı geç geliyorsa)

   Tüm tetiklemeler 300-500ms debounce ile birleştirilir.

## Popup Ayarları

| Ayar | Davranış |
|---|---|
| Etkinleştir toggle | Kapalıyken content script yeni kart göstermez, mevcutu gizler |
| Hassasiyet slider (0.1–0.7) | Fuse threshold'u. Düşük = daha kesin, yüksek = daha esnek eşleşme |
| Kart pozisyonunu sıfırla | Sürüklemeyle değiştirilen pozisyonu varsayılana (sağ üst) döndürür |
| Bu sayfada yeniden çalıştır | Aktif YouTube sekmesinde eşleştirmeyi yeniden tetikler (kapat butonuyla gizlenmiş kartı geri getirmek için kullanışlı) |

Ayarlar `chrome.storage.sync` üzerinden saklanır, cihazlar arası senkronize olur.

## Veritabanını Güncelleme

`el_recodo_Tüm Kayıtlar.xlsx` dosyasını güncelle veya yeni bir XLSX/CSV ile
değiştir, sonra:

```bash
python3 scripts/xlsx_to_json.py
```

Ardından Chrome'da eklentiyi yeniden yükle (`chrome://extensions` → yenile
ikonu). Content script'in önbelleği yoktur — her sayfa yüklemede tekrar fetch
eder, yeni veriyi hemen kullanır.

### Kolon Haritası

XLSX kolonları Türkçe, JSON anahtarları İngilizce:

| XLSX | JSON | Açıklama |
|---|---|---|
| Kayıt No | `id` | ERT-00001 vb. |
| Başlık | `title` | |
| Tarz | `genre` | küçük harfe çevrilir (tango/vals/milonga) |
| Orkestra | `orchestra` | |
| Şarkıcı | `singer` | boşsa "Instrumental" |
| Besteci | `composer` | |
| Yazar | `lyricist` | |
| Yıl | `year` | int |
| Tarih | `date` | |
| Etiket | `label` | plak (Odeon, Columbia…) |
| Süre | `duration` | mm:ss |
| Duygular/Etiketler | `tags` | |
| Dinlemek /10 | `listen_rating` | float |
| Dans /10 | `dance_rating` | float |

Ek olarak her kayıta `_n_title`, `_n_orchestra`, `_n_singer` (önceden normalize
edilmiş) alanları eklenir — Fuse.js bu alanlarda arar.

CSV kullanıyorsan, aynı Türkçe header isimlerini kullan.

## Manifest V3 Uyumu

- `manifest_version: 3`
- Background service worker **yok** (gereksiz; tüm mantık content script'te)
- `host_permissions`: sadece `*://*.youtube.com/*`
- `permissions`: sadece `storage`
- Tüm JS ve veri lokal — remote script fetch/eval yok
- `content_security_policy.extension_pages`: `script-src 'self'; object-src 'self'`
- `web_accessible_resources`: sadece `data/tango_database.json` ve `overlay.css`

## Bilinen Sınırlamalar

- Sadece `youtube.com/watch*` URL'lerinde aktif; Shorts / embed'lerde çalışmaz.
- Başlığın formatı çok alışılmadıksa (örn. sadece video ID, sadece emoji) eşleşme bulunamayabilir — bu normal, kart sessizce gizli kalır.
- Otomatik oynatmada YouTube başlığı bazen 500ms gecikmeyle güncellenir; `<title>` MutationObserver bunu yakalar ama çok kısa sürede iki video arka arkaya geçerse tek bir eşleşme atlanabilir.
- Veritabanı ağırlıklı olarak 1920-1960 arası altın çağ tangolarını içerir; modern nuevo tango (Piazzolla sonrası) kayıtları sınırlıdır.

## Lisans / Atıf

- Fuse.js v7 — Apache License 2.0 (© Kiro Risk)
- El Recodo tango veritabanı — kaynak: [el-recodo.com](https://www.el-recodo.com/)
