# Conversa Relay

Node.js service that receives WhatsApp Web messages and routes them to AI orchestrators (Codex, Claude, Gemini), with dashboard/API support and background task handling.

## Features

- Multi-session WhatsApp Web handling
- Orchestrator routing (`codex`, `claude`, `gemini`)
- Local dashboard and API endpoints
- Background task manager for async jobs
- Media handling with configurable limits

## Requirements

- Node.js 18+ (`20+` recommended for latest integrations)
- Chromium installed (set `CHROMIUM_PATH` when needed)

## Setup

```bash
npm install
cp config/sessions.example.json config/sessions.json
```

Optional environment variables:

- `API_PORT`
- `DATA_DIR`
- `SESSIONS_CONFIG_PATH`
- `DASHBOARD_USER`, `DASHBOARD_PASS`
- `CHROMIUM_PATH`
- `ORCHESTRATOR_TYPE`
- `MAX_MEDIA_MB`, `MAX_IMAGE_MEDIA_MB`, `MAX_DOC_MEDIA_MB`, `MAX_AUDIO_MEDIA_MB`, `MAX_VIDEO_MEDIA_MB`

## Run

```bash
npm run start
```

Development mode:

```bash
npm run dev
```

## Test

```bash
npm test
```

## Project Layout

- `src/`: main application code
- `config/`: runtime configuration
- `public/`: dashboard assets
- `test/`: test suite
