# WhatsApp AI Bridge

WhatsApp Web üstünden mesajları alıp Codex/Claude/Gemini orkestratörlerine ileten,
arka plan görevleri ve basit bir dashboard/API sunan Node.js uygulaması.

## Kurulum

- Node.js: `>=18` (Gemini CLI için `>=20`)
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
- `ORCHESTRATOR_TYPE` (`claude`, `codex` veya `gemini`)
- `MAX_MEDIA_MB` (genel medya limiti, varsayılan `8`)
- `MAX_IMAGE_MEDIA_MB`, `MAX_DOC_MEDIA_MB`, `MAX_AUDIO_MEDIA_MB`, `MAX_VIDEO_MEDIA_MB`

## Çalıştırma

```bash
npm run start
```

İlk çalıştırmada QR kod çıkar; WhatsApp’tan taratınca mesajları dinlemeye başlar.

## Gemini CLI entegrasyonu

Gemini CLI headless modda çağrılır; interaktif panel açılmaz.

Kurulum:

```bash
sudo npm install -g @google/gemini-cli@latest
```

Temel ayarlar:

- `GEMINI_API_KEY` (Gemini API anahtarı) veya `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GEMINI_MODEL` (opsiyonel model seçimi)
- `GEMINI_YOLO` (`1`/`0`, varsayılan `1`)
- `GEMINI_APPROVAL_MODE` (`default`, `auto_edit`, `yolo`)
- `GEMINI_OUTPUT_FORMAT` (varsayılan `stream-json`)
- `GEMINI_BIN` (gemini binary yolu; varsayılan `gemini`)
- `GEMINI_WORKDIR` (varsayılan proje dizini)
- `GEMINI_INCLUDE_DIRS` (ek klasorler, virgülle ayrılır)
- `GEMINI_SESSION_STORE` (session dosya yolu; varsayılan `data/gemini-sessions.json`)
- `GEMINI_INITIAL_INSTRUCTIONS` (opsiyonel başlangıç talimatı)

Gemini kullanmak için:

```bash
export ORCHESTRATOR_TYPE=gemini
export GEMINI_API_KEY="YOUR_API_KEY"
npm run start
```

Not: Gemini CLI `@file` ile metin dosyalarını prompta dahil eder. Görseller burada yalnızca dosya yolu olarak not edilir.

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
