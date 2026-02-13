import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { paths } from '../paths.js';

const DEFAULT_BASE_DIR = process.env.AI_OUTBOX_DIR || path.join(paths.dataDir, 'ai-outbox');
const DEFAULT_VERSION = 1;
const MAX_TEXT_LENGTH = 12000;
const VALID_TYPES = new Set(['start', 'progress', 'final', 'error', 'info']);
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

  const rawText = payload.text ?? payload.message ?? payload.content;
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('text zorunlu');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text cok uzun (${text.length} > ${MAX_TEXT_LENGTH})`);
  }

  const createdAtRaw = payload.createdAt || payload.created_at;
  const createdDate = createdAtRaw ? new Date(createdAtRaw) : new Date();
  const createdAt = Number.isNaN(createdDate.getTime()) ? new Date().toISOString() : createdDate.toISOString();

  const requestId = String((payload.requestId ?? payload.request_id ?? fallbackRequestId) || '').trim() || null;
  const orchestrator = String((payload.orchestrator ?? fallbackOrchestrator) || '').trim() || 'unknown';
  const type = normalizeOutboxType(payload.type);

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
    'Kullaniciyla dogal, samimi ve net bir dille konus.',
    'Kullanici mesaji gelir gelmez, gerekliyse kisa bir ilk donut ver; sohbette senden geri bildirim beklendigini unutma.',
    'Surec birkac adimdan olusuyorsa JSON outbox ile kisa durum mesajlari paylas.',
    'Komut: node scripts/ai-outbox-message.js --type start|progress|final|error --text "mesaj"',
    'Bu komut WA_OUTBOX_DIR/WA_CHAT_ID/WA_REQUEST_ID env degiskenlerini otomatik kullanir.',
    'Kisa rehber:',
    '- Varsayilan davranis: ise baslarken kisa bir baslangic mesaji at.',
    '- Onemli adimlarda 1-2 kisa guncelleme paylas.',
    '- Eger istek tek adimlik ve aninda bitecekse tek final mesaji da kabul edilir.',
    '- Biterken sonucu tek mesajda toparla.',
    'Mini tavsiye 1: Gereksiz teknik detaya bogma.',
    'Mini tavsiye 2: Her guncellemede yeni bilgi ver, tekrar etme.'
  ].join('\n');
}
