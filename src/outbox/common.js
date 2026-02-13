import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { paths } from '../paths.js';

const DEFAULT_BASE_DIR = process.env.AI_OUTBOX_DIR || path.join(paths.dataDir, 'ai-outbox');
const DEFAULT_VERSION = 1;
const MAX_TEXT_LENGTH = 12000;
const VALID_TYPES = new Set(['start', 'progress', 'final', 'error', 'info', 'media']);
let writeSequence = 0;

function sanitizeToken(value, maxLen = 48) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, maxLen);
}

function compactMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

export function getOutboxPaths(baseDir = DEFAULT_BASE_DIR) {
  const resolvedBase = path.resolve(baseDir);
  return {
    baseDir: resolvedBase,
    pendingDir: path.join(resolvedBase, 'pending'),
    processedDir: path.join(resolvedBase, 'processed'),
    failedDir: path.join(resolvedBase, 'failed')
  };
}

export async function ensureOutboxDirs(outboxPaths = getOutboxPaths()) {
  await fs.mkdir(outboxPaths.pendingDir, { recursive: true });
  await fs.mkdir(outboxPaths.processedDir, { recursive: true });
  await fs.mkdir(outboxPaths.failedDir, { recursive: true });
  return outboxPaths;
}

export function normalizeOutboxType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!type) return 'progress';
  if (VALID_TYPES.has(type)) return type;
  return 'info';
}

export function createOutboxRequestId(prefix = 'req') {
  const safePrefix = sanitizeToken(prefix, 16) || 'req';
  const random = crypto.randomBytes(5).toString('hex');
  return `${safePrefix}-${Date.now()}-${random}`;
}

export function normalizeOutboxMessage(payload = {}, options = {}) {
  const fallbackChatId = options.fallbackChatId || process.env.WA_CHAT_ID || '';
  const fallbackRequestId = options.fallbackRequestId || process.env.WA_REQUEST_ID || '';
  const fallbackOrchestrator =
    options.fallbackOrchestrator ||
    process.env.WA_ORCHESTRATOR ||
    process.env.ORCHESTRATOR_TYPE ||
    'unknown';

  const chatId = String(payload.chatId ?? payload.chat ?? fallbackChatId).trim();
  if (!chatId) {
    throw new Error('chatId zorunlu');
  }

  const type = normalizeOutboxType(payload.type);
  const filePath = payload.filePath ? String(payload.filePath).trim() : null;

  const rawText = payload.text ?? payload.message ?? payload.content;
  const text = String(rawText || '').trim();
  // Media mesajlarında text (caption) opsiyoneldir
  if (!text && type !== 'media') {
    throw new Error('text zorunlu');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text cok uzun (${text.length} > ${MAX_TEXT_LENGTH})`);
  }
  if (type === 'media' && !filePath) {
    throw new Error('media mesajinda filePath zorunlu');
  }

  const createdAtRaw = payload.createdAt || payload.created_at;
  const createdDate = createdAtRaw ? new Date(createdAtRaw) : new Date();
  const createdAt = Number.isNaN(createdDate.getTime()) ? new Date().toISOString() : createdDate.toISOString();

  const requestId = String((payload.requestId ?? payload.request_id ?? fallbackRequestId) || '').trim() || null;
  const orchestrator = String((payload.orchestrator ?? fallbackOrchestrator) || '').trim() || 'unknown';

  const normalized = {
    version: Number(payload.version || DEFAULT_VERSION) || DEFAULT_VERSION,
    id: String(payload.id || payload.messageId || crypto.randomUUID()),
    createdAt,
    chatId,
    requestId,
    orchestrator,
    type,
    text
  };

  if (filePath) {
    normalized.filePath = filePath;
  }

  const meta = compactMeta(payload.meta);
  if (meta) {
    normalized.meta = meta;
  }

  return normalized;
}

export async function writeOutboxMessage(payload = {}, options = {}) {
  const outboxPaths = options.outboxPaths || getOutboxPaths(options.baseDir);
  await ensureOutboxDirs(outboxPaths);

  const envelope = normalizeOutboxMessage(payload, {
    fallbackChatId: options.fallbackChatId,
    fallbackRequestId: options.fallbackRequestId,
    fallbackOrchestrator: options.fallbackOrchestrator
  });

  const createdAtMs = Date.parse(envelope.createdAt);
  const ts = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  const seq = String((writeSequence = (writeSequence + 1) % 100000)).padStart(5, '0');
  const requestToken = sanitizeToken(envelope.requestId || 'noreq', 24) || 'noreq';
  const typeToken = sanitizeToken(envelope.type, 12) || 'info';
  const randomToken = crypto.randomBytes(4).toString('hex');
  const baseName = `${ts}-${seq}-${requestToken}-${typeToken}-${randomToken}`;
  const pendingPath = path.join(outboxPaths.pendingDir, `${baseName}.json`);
  const tempPath = path.join(outboxPaths.pendingDir, `${baseName}.tmp`);

  await fs.writeFile(tempPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  await fs.rename(tempPath, pendingPath);

  return {
    envelope,
    filePath: pendingPath,
    fileName: path.basename(pendingPath)
  };
}

export function buildOutboxEnv({
  chatId,
  requestId,
  orchestrator,
  outboxPaths = getOutboxPaths(),
  extraEnv = {}
} = {}) {
  return {
    ...extraEnv,
    WA_OUTBOX_DIR: outboxPaths.pendingDir,
    WA_CHAT_ID: String(chatId || ''),
    WA_REQUEST_ID: String(requestId || ''),
    WA_ORCHESTRATOR: String(orchestrator || '')
  };
}

export function getOutboxPromptInstructions() {
  return [
    '## CANLI WHATSAPP MESAJ AKISI',
    'TUM iletisim (basit cevaplar dahil) node scripts/ai-outbox-message.js komutuyla yapilir.',
    'Response text kullaniciya GONDERILMEZ - sadece sistem tarafindan loglanir.',
    '',
    'Komut: node scripts/ai-outbox-message.js --type start|progress|final|error --text "mesaj"',
    'Bu komut WA_OUTBOX_DIR/WA_CHAT_ID/WA_REQUEST_ID env degiskenlerini otomatik kullanir.',
    '',
    'Mesaj tipleri:',
    '  start    - Ise baslarken (2+ saniye surecek islerde)',
    '  progress - Ara guncelleme',
    '  final    - Son mesaj (her zaman gonder, ozet ver)',
    '  error    - Hata durumu',
    '',
    'Basit soru icin:',
    '  node scripts/ai-outbox-message.js --type final --text "4"',
    '',
    'Uzun is icin:',
    '  node scripts/ai-outbox-message.js --type start --text "Bakiyorum."',
    '  node scripts/ai-outbox-message.js --type progress --text "Dosyayi yaziyorum."',
    '  node scripts/ai-outbox-message.js --type final --text "Hazir! Dosya gonderildi."',
    '',
    'DOSYA GONDERME (WhatsApp\'a direkt):',
    '  node scripts/ai-outbox-media.js --file /mutlak/dosya/yolu --caption "Aciklama"',
    'Desteklenen: PDF, PNG, JPG, HTML, ZIP, MP4, MP3 vb.',
    'Her zaman link vermek yerine bunu kullan.',
    '',
    'Kurallar:',
    '- Her zaman en az 1 final mesaji gonder.',
    '- Her guncellemede yeni bilgi ver, tekrar etme.',
    '- Kisa ve oz yaz, teknik detaya bogma.'
  ].join('\n');
}
