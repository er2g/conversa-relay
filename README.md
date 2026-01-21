# WhatsApp AI Bridge

WhatsApp Web üstünden mesajları alıp Codex/Claude orkestratörlerine ileten,
arka plan görevleri ve basit bir dashboard/API sunan Node.js uygulaması.

## Kurulum

- Node.js: `>=18`
- Chromium: Linux’ta genelde `/usr/bin/chromium` (değilse `CHROMIUM_PATH` ile ayarla)

```bash
npm install
```

## Konfigürasyon

- `config/sessions.example.json` dosyasını kopyala:

```bash
cp config/sessions.example.json config/sessions.json
```

İstersen şu env’leri ayarla:

- `API_PORT` (varsayılan `3000`)
- `DATA_DIR` (varsayılan proje içi `./data`)
- `SESSIONS_CONFIG_PATH` (varsayılan `./config/sessions.json`)
- `DASHBOARD_USER` / `DASHBOARD_PASS` (dashboard basic auth)
- `CHROMIUM_PATH` (varsayılan `/usr/bin/chromium`)
- `ORCHESTRATOR_TYPE` (`claude` veya `codex`)
- `MAX_MEDIA_MB` (genel medya limiti, varsayılan `8`)
- `MAX_IMAGE_MEDIA_MB`, `MAX_DOC_MEDIA_MB`, `MAX_AUDIO_MEDIA_MB`, `MAX_VIDEO_MEDIA_MB`

## Çalıştırma

```bash
npm run start
```

İlk çalıştırmada QR kod çıkar; WhatsApp’tan taratınca mesajları dinlemeye başlar.

## Fotoğraf desteği

WhatsApp’tan gönderilen fotoğraflar (caption’lı veya captionsız) orkestratöre görsel olarak aktarılır.

## Medya indirimi (buyuk dosyalar)

Buyuk dosyalarda base64 yerine direct indirme + decrypt yolu kullanilir (daha hizli ve stabil).
Medya dosyalari `data/media/<chatId>` altina kaydedilir.

Istege bagli ayarlar:

- `DIRECT_MEDIA_MB` (direct indirme esigi, varsayilan `16`)
- `DIRECT_MEDIA_FORCE=1` (tum medya dosyalarinda direct indirmeyi zorla)
- `MEDIA_DOWNLOAD_TIMEOUT_MS` (direct indirme timeout, varsayilan `300000`)
- `PUPPETEER_PROTOCOL_TIMEOUT_MS` (puppeteer timeout, varsayilan `600000`)
- `WHATSAPP_MEDIA_HOST` (varsayilan `https://mmg.whatsapp.net`)

## Sistem mesajlari ve AI tetikleme

- Medya mesajlari AI'yi tetiklemez; dosya bilgisi sistem notu olarak kaydedilir.
- Medya caption'i varsa "Medya notu" olarak saklanir.
- Kullanici bir sonraki mesaj attiginda son sistem notlari prompta eklenir.

## Güvenlik notu

`data/` ve `config/sessions.json` Git’e alınmaz (session/numara/DB/log içerir). Repo’ya sadece örnek config eklenir.
