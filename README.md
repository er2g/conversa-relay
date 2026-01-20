# whatsapp-claude

WhatsApp Web üstünden mesajları alıp Codex’e ileten ve basit bir dashboard/API sunan Node.js uygulaması.

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

## Çalıştırma

```bash
npm run start
```

İlk çalıştırmada QR kod çıkar; WhatsApp’tan taratınca mesajları dinlemeye başlar.

## Fotoğraf desteği

WhatsApp’tan gönderilen fotoğraflar (caption’lı veya captionsız) Codex’e görsel olarak aktarılır.
İstersen limit: `MAX_MEDIA_MB` (varsayılan `8`).

## Güvenlik notu

`data/` ve `config/sessions.json` Git’e alınmaz (session/numara/DB/log içerir). Repo’ya sadece örnek config eklenir.
