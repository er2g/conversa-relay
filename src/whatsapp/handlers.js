import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import logger from '../logger.js';
import { paths } from '../paths.js';
import { taskManager } from '../background/task-manager.js';
import { maskPhoneLike } from '../utils/redact.js';
import SwitchHandler from '../orchestrator/switch-handler.js';
import TerminalHandler from '../orchestrator/terminal-handler.js';
import orchestratorManager from '../orchestrator/orchestrator-manager.js';
import {
  buildMediaDownloadUrl,
  downloadAndDecryptToFile,
  normalizeMediaKey,
  resolveMediaKeyType
} from './media-download.js';
import {
  getOutboxPaths,
  getOutboxPromptInstructions,
  writeOutboxMessage
} from '../outbox/common.js';

const configPath = process.env.SESSIONS_CONFIG_PATH || path.join(paths.configDir, 'sessions.json');
const NO_RESPONSE = Symbol('no-response');

class MessageHandler {
  constructor(whatsappClient, sessionManager, intentDetector, db) {
    this.wa = whatsappClient;
    this.sessionManager = sessionManager;
    this.db = db;
    this.config = this.loadConfig();
    this.rateLimitMap = new Map();
    this.processingQueue = new Map(); // chatId -> boolean
    this.pendingJobs = new Map(); // chatId -> Job[]
    this.lastSavedFileByChat = new Map(); // chatId -> last file info
    this.systemNotesByChat = new Map(); // chatId -> string[]
    this.aiExecutionMetaByChat = new Map(); // chatId -> execution meta
    this.outboxPaths = getOutboxPaths();

    // Yeni switch handler - addSystemNote callback'i ile
    this.switchHandler = new SwitchHandler(sessionManager, db, {
      addSystemNote: (chatId, note) => this.addSystemNote(chatId, note)
    });

    // Terminal session handler
    this.terminalHandler = new TerminalHandler(sessionManager, {
      addSystemNote: (chatId, note) => this.addSystemNote(chatId, note)
    });
  }

  loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      logger.error('Config yüklenemedi:', error);
      return {
        allowedNumbers: [],
        adminNumbers: [],
        settings: {
          maxConcurrentSessions: 3,
          sessionTimeoutMinutes: 30,
          rateLimit: { messagesPerMinute: 20, cooldownSeconds: 60 }
        }
      };
    }
  }

  normalizeDigits(value) {
    if (!value) return '';
    return String(value).replace(/\D/g, '');
  }

  normalizeTaskOrchestrator(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;

    if (raw === 'default' || raw === 'auto') return null;
    if (raw.startsWith('gemini')) return 'gemini';
    if (raw.startsWith('claude') || raw === 'anthropic') return 'claude';
    if (raw.startsWith('codex') || raw.startsWith('openai') || raw.startsWith('gpt')) return 'codex';
    if (raw === 'sonnet' || raw === 'haiku' || raw === 'opus') return 'claude';

    return null;
  }

  formatMessageTimestampForPrompt(message) {
    const iso = this.getMessageCreatedAtISO(message);
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  }

  buildSwitchHandoffNote(chatId, fromOrchestrator, toOrchestrator) {
    const limit = parseInt(process.env.HANDOFF_CONTEXT_LIMIT || '12', 10);
    const maxCharsPerLine = parseInt(process.env.HANDOFF_CONTEXT_LINE_CHARS || '240', 10);
    const maxTotalChars = parseInt(process.env.HANDOFF_CONTEXT_MAX_CHARS || '2000', 10);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 12;
    const queryLimit = Math.min(60, Math.max(safeLimit * 3, safeLimit));

    let rows = [];
    try {
      rows = this.db?.getMessages?.(chatId, queryLimit) || [];
    } catch {
      rows = [];
    }

    const header = `Orkestrator degisti: ${fromOrchestrator} -> ${toOrchestrator}.`;
    if (!rows.length) {
      return `${header} Sohbet kaydi bulunamadi.`;
    }

    const lines = [];
    let total = header.length + 1;
    const ordered = rows.slice().reverse();
    const incomingOnly = ordered.filter((row) => row?.direction === 'incoming');
    const sourceRows = incomingOnly.length ? incomingOnly : ordered;

    for (const row of sourceRows) {
      let text = String(row?.message || '').trim();
      if (!text) continue;
      const lower = text.toLowerCase().trim();
      if (lower.startsWith('!!switch')) continue;

      text = text.replace(/\s+/g, ' ').trim();
      if (Number.isFinite(maxCharsPerLine) && maxCharsPerLine > 0 && text.length > maxCharsPerLine) {
        text = `${text.slice(0, maxCharsPerLine)}...`;
      }

      const line = `Kullanici: ${text}`;

      if (Number.isFinite(maxTotalChars) && maxTotalChars > 0 && total + line.length + 1 > maxTotalChars) {
        break;
      }

      lines.push(line);
      total += line.length + 1;
      if (lines.length >= safeLimit) break;
    }

    if (lines.length === 0) {
      return `${header} Sohbet kaydi bulunamadi.`;
    }

    return `${header} Gecis ozeti (son ${lines.length} kullanici mesaji):\n${lines.join('\n')}`;
  }

  sanitizePathPart(value) {
    return String(value || '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 64);
  }

  mimeToExt(mimetype) {
    const normalized = this.normalizeMimetype(mimetype);
    switch (normalized) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'application/pdf':
        return 'pdf';
      case 'text/plain':
        return 'txt';
      case 'application/zip':
        return 'zip';
      case 'application/json':
        return 'json';
      case 'audio/mpeg':
        return 'mp3';
      case 'audio/ogg':
        return 'ogg';
      case 'audio/opus':
        return 'opus';
      case 'audio/wav':
        return 'wav';
      case 'video/mp4':
        return 'mp4';
      case 'video/quicktime':
        return 'mov';
      default:
        if (normalized.startsWith('image/')) return 'img';
        if (normalized.startsWith('audio/')) return 'audio';
        if (normalized.startsWith('video/')) return 'video';
        return 'bin';
    }
  }

  normalizeMimetype(mimetype) {
    return String(mimetype || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
  }

  mediaTypeFromMimetype(mimetype) {
    const normalized = this.normalizeMimetype(mimetype);
    if (normalized.startsWith('image/')) return 'image';
    if (normalized.startsWith('audio/')) return 'audio';
    if (normalized.startsWith('video/')) return 'video';
    if (normalized) return 'document';
    return 'other';
  }

  getMaxMediaBytes(mediaType) {
    const fallbackMb = parseInt(process.env.MAX_MEDIA_MB || '8', 10);
    const perTypeMap = {
      image: parseInt(process.env.MAX_IMAGE_MEDIA_MB || '', 10),
      document: parseInt(process.env.MAX_DOC_MEDIA_MB || '', 10),
      audio: parseInt(process.env.MAX_AUDIO_MEDIA_MB || '', 10),
      video: parseInt(process.env.MAX_VIDEO_MEDIA_MB || '', 10),
      other: parseInt(process.env.MAX_OTHER_MEDIA_MB || '', 10)
    };

    const selected = Number.isFinite(perTypeMap[mediaType]) ? perTypeMap[mediaType] : NaN;
    const mb = Number.isFinite(selected) && selected > 0 ? selected : fallbackMb;
    return Math.max(1, mb) * 1024 * 1024;
  }

  estimateBase64Bytes(base64) {
    const s = String(base64 || '');
    const len = s.length;
    if (len === 0) return 0;
    const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    return Math.floor((len * 3) / 4) - padding;
  }

  getMessageId(message) {
    return message?.id?._serialized || message?.id?.id || null;
  }

  getMessageCreatedAtISO(message) {
    const ts = Number(message?.timestamp);
    if (Number.isFinite(ts) && ts > 0) {
      return new Date(ts * 1000).toISOString();
    }
    return new Date().toISOString();
  }

  getMediaOriginalName(message) {
    const candidates = [
      message?._data?.filename,
      message?._data?.fileName,
      message?._data?.mediaData?.filename,
      message?.filename,
      message?.fileName
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  }

  cleanMediaBody(body, originalName) {
    const trimmed = String(body || '').trim();
    if (!trimmed) return '';
    const original = String(originalName || '').trim();
    if (!original) return trimmed;

    const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalize(trimmed) === normalize(original)) {
      return '';
    }

    return trimmed;
  }

  makeSafeStoredFilename({ originalName, mimetype }) {
    const extFromName = originalName ? path.extname(originalName).replace(/^\./, '') : '';
    const safeExtFromName = extFromName && /^[a-zA-Z0-9]{1,8}$/.test(extFromName) ? extFromName : '';
    const ext = safeExtFromName || this.mimeToExt(mimetype);

    const baseFromName = originalName ? path.basename(originalName, path.extname(originalName)) : 'file';
    const safeBase = this.sanitizePathPart(baseFromName).slice(0, 48) || 'file';
    const rand = crypto.randomBytes(6).toString('hex');
    const ts = Date.now();

    return `${ts}-${rand}-${safeBase}.${ext}`;
  }

  formatBytesForUser(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /**
   * Dosya boyutunu indirmeden önce kontrol et
   * WhatsApp message metadata'sından boyut bilgisini al
   */
  getPreDownloadFileSize(message) {
    const candidates = [
      message?._data?.size,
      message?._data?.fileSize,
      message?._data?.mediaData?.size,
      message?.fileSize,
      message?.size
    ];
    for (const c of candidates) {
      const num = Number(c);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  }

  addSystemNote(chatId, text) {
    const note = String(text || '').trim();
    if (!note) return;

    const queue = this.systemNotesByChat.get(chatId) || [];
    queue.push(note);
    if (queue.length > 10) {
      queue.splice(0, queue.length - 10);
    }
    this.systemNotesByChat.set(chatId, queue);
  }

  consumeSystemNotes(chatId) {
    const queue = this.systemNotesByChat.get(chatId);
    if (!queue || queue.length === 0) return [];
    this.systemNotesByChat.delete(chatId);
    return queue;
  }

  formatSystemNotes(notes) {
    if (!notes || notes.length === 0) return '';
    const lines = notes.map((note) => `- ${note}`);
    return `\n\n[SISTEM MESAJLARI]\n${lines.join('\n')}\n[/SISTEM MESAJLARI]\n`;
  }

  buildFeedbackExpectationBlock() {
    return (
      '\n\n[ILETISIM BEKLENTISI]\n' +
      'Kullanici bu andan itibaren senden surec boyunca kisa ve net donutler bekleyebilir.\n' +
      '- Is tek adimlik degilse kisa bir baslangic mesajiyla ise girdigini belirt.\n' +
      '- Isin kritik adimlarinda fazla uzatmadan kisa guncelleme ver.\n' +
      '- Is biter bitmez sonucu toparlayip final mesaji ver.\n' +
      '[/ILETISIM BEKLENTISI]\n'
    );
  }

  setAiExecutionMeta(chatId, meta) {
    if (!chatId) return;
    if (!meta || typeof meta !== 'object') {
      this.aiExecutionMetaByChat.delete(chatId);
      return;
    }
    this.aiExecutionMetaByChat.set(chatId, {
      requestId: meta.requestId || null,
      orchestrator: meta.orchestrator || null,
      sessionId: meta.sessionId || null
    });
  }

  consumeAiExecutionMeta(chatId) {
    if (!chatId) return null;
    const meta = this.aiExecutionMetaByChat.get(chatId) || null;
    this.aiExecutionMetaByChat.delete(chatId);
    return meta;
  }

  async queueOutboxMessage(chatId, text, options = {}) {
    return await writeOutboxMessage(
      {
        chatId,
        requestId: options.requestId || null,
        orchestrator: options.orchestrator || null,
        type: options.type || 'progress',
        text,
        meta: options.meta || undefined
      },
      {
        outboxPaths: this.outboxPaths,
        fallbackChatId: chatId,
        fallbackRequestId: options.requestId || null,
        fallbackOrchestrator: options.orchestrator || null
      }
    );
  }

  getDirectDownloadThresholdBytes() {
    const raw = process.env.DIRECT_MEDIA_MB || process.env.DIRECT_MEDIA_DOWNLOAD_MB || '16';
    const mb = parseInt(raw, 10);
    if (Number.isFinite(mb) && mb > 0) {
      return mb * 1024 * 1024;
    }
    return 16 * 1024 * 1024;
  }

  shouldUseDirectDownload(preDownloadSize) {
    const force = String(process.env.DIRECT_MEDIA_FORCE || '')
      .toLowerCase()
      .trim();
    if (force === '1' || force === 'true' || force === 'yes') {
      return true;
    }
    if (!preDownloadSize || preDownloadSize <= 0) return false;
    return preDownloadSize >= this.getDirectDownloadThresholdBytes();
  }

  getDirectMediaInfo(message) {
    const data = message?._data || {};
    const mediaData = data.mediaData || {};
    return {
      directPath: data.directPath || mediaData.directPath || null,
      url: data.url || mediaData.url || data.clientUrl || mediaData.clientUrl || null,
      mediaKey: data.mediaKey || mediaData.mediaKey || message?.mediaKey || null,
      type: data.type || message?.type || null,
      mimetype: data.mimetype || mediaData.mimetype || null
    };
  }

  async resolveMediaSavePath(chatId, storedFilename) {
    const chatDirName = this.sanitizePathPart(chatId);
    const preferredRoot = path.resolve(paths.mediaDir);
    const fallbackRoot = path.resolve(paths.dataDir, 'media');

    let baseDir = path.resolve(preferredRoot, chatDirName);
    try {
      await fs.promises.mkdir(baseDir, { recursive: true });
    } catch (e) {
      const code = e?.code || '';
      if (code === 'EACCES' || code === 'EPERM') {
        logger.warn(`MEDIA_DIR yazılamıyor (${preferredRoot}). Fallback: ${fallbackRoot}`);
        baseDir = path.resolve(fallbackRoot, chatDirName);
        await fs.promises.mkdir(baseDir, { recursive: true });
      } else {
        throw e;
      }
    }

    const absolutePath = path.resolve(baseDir, storedFilename);
    const basePrefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (!absolutePath.startsWith(basePrefix)) {
      throw new Error('Geçersiz dosya yolu');
    }

    return { baseDir, absolutePath };
  }

  async downloadMediaDirect(message, preDownloadSize, maxBytes) {
    const info = this.getDirectMediaInfo(message);
    const url = buildMediaDownloadUrl({ directPath: info.directPath, url: info.url });
    const mediaKey = normalizeMediaKey(info.mediaKey);

    if (!url || !mediaKey) {
      throw new Error('Direct indirme için medya bilgileri eksik');
    }

    const mimetype = this.normalizeMimetype(info.mimetype || '');
    const mediaType = this.mediaTypeFromMimetype(mimetype);
    const keyType = resolveMediaKeyType(info.type, mimetype);

    if (!keyType) {
      throw new Error('Medya tipi çözülemedi');
    }

    if (preDownloadSize > 0 && preDownloadSize > maxBytes) {
      throw new Error(
        `Dosya çok büyük (${Math.ceil(preDownloadSize / 1024 / 1024)}MB). En fazla ${Math.ceil(maxBytes / 1024 / 1024)}MB.`
      );
    }

    const from = message.from;
    const messageId = this.getMessageId(message);
    const createdAtISO = this.getMessageCreatedAtISO(message);
    const originalName = this.getMediaOriginalName(message);
    const storedFilename = this.makeSafeStoredFilename({ originalName, mimetype });
    const { absolutePath } = await this.resolveMediaSavePath(from, storedFilename);

    logger.info(
      `Direct medya indiriliyor: ${originalName || storedFilename}, ` +
      `tahmini boyut: ${preDownloadSize > 0 ? this.formatBytesForUser(preDownloadSize) : 'bilinmiyor'}`
    );

    const start = Date.now();
    const { sizeBytes } = await downloadAndDecryptToFile({
      url,
      mediaKey,
      keyType,
      outputPath: absolutePath
    });
    const elapsedMs = Date.now() - start;

    logger.info(
      `Direct indirme tamamlandı (${elapsedMs}ms), boyut: ${this.formatBytesForUser(sizeBytes)}`
    );

    return {
      chatId: from,
      mediaType,
      mimetype,
      sizeBytes,
      originalName: originalName || storedFilename,
      absolutePath,
      messageId,
      createdAt: createdAtISO
    };
  }

  async finalizeSavedMedia(message, savedMediaInfo) {
    const chatId = savedMediaInfo.chatId;
    this.lastSavedFileByChat.set(chatId, savedMediaInfo);
    if (this.db?.setLastSavedFile) {
      this.db.setLastSavedFile({
        chatId,
        messageId: savedMediaInfo.messageId,
        mimetype: savedMediaInfo.mimetype,
        sizeBytes: savedMediaInfo.sizeBytes,
        absolutePath: savedMediaInfo.absolutePath,
        createdAt: savedMediaInfo.createdAt
      });
    }

    const ack = `Dosya kaydedildi: ${savedMediaInfo.absolutePath} ` +
      `(${savedMediaInfo.mimetype || 'bilinmiyor'}, ${this.formatBytesForUser(savedMediaInfo.sizeBytes)})`;
    this.addSystemNote(chatId, ack);
    try {
      await this.replyToMessage(message, ack);
      this.db.logMessage(chatId, ack, 'outgoing');
    } catch (e) {
      logger.warn('Dosya kaydedildi mesajı gönderilemedi:', e?.message || String(e));
    }
  }

  /**
   * Büyük dosyaları streaming ile diske kaydet (belleği korur)
   * Küçük dosyalar için normal Buffer kullan
   */
  async saveMediaStreaming(media, absolutePath, estimatedSize) {
    const STREAM_THRESHOLD = 5 * 1024 * 1024; // 5MB üstü streaming (bellek optimizasyonu)
    const data = media?.data || '';

    if (!data) {
      throw new Error('Dosya verisi boş');
    }

    if (estimatedSize > STREAM_THRESHOLD) {
      // Streaming: Base64'ü chunk'lar halinde decode et
      logger.info(`Büyük dosya streaming ile kaydediliyor: ${this.formatBytesForUser(estimatedSize)}`);

      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      const writeStream = fs.createWriteStream(absolutePath);

      try {
        let offset = 0;
        while (offset < data.length) {
          const chunk = data.slice(offset, offset + CHUNK_SIZE);
          const buffer = Buffer.from(chunk, 'base64');

          await new Promise((resolve, reject) => {
            const canContinue = writeStream.write(buffer, (err) => {
              if (err) reject(err);
            });
            if (canContinue) {
              resolve();
            } else {
              writeStream.once('drain', resolve);
            }
          });

          offset += CHUNK_SIZE;

          // Bellek baskısını azalt
          if (global.gc && offset % (10 * CHUNK_SIZE) === 0) {
            global.gc();
          }
        }

        await new Promise((resolve, reject) => {
          writeStream.end((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const stats = await fs.promises.stat(absolutePath);
        return stats.size;
      } catch (e) {
        writeStream.destroy();
        // Hatalı dosyayı temizle
        try { await fs.promises.unlink(absolutePath); } catch {}
        throw e;
      }
    } else {
      // Küçük dosya: Normal Buffer kullan
      const buffer = Buffer.from(data, 'base64');
      await fs.promises.writeFile(absolutePath, buffer);
      return buffer.byteLength;
    }
  }

  isAllowed(chatId, contactNumber) {
    if (chatId.includes('@g.us')) {
      return false;
    }

    const allowed = this.config.allowedNumbers || [];
    const admins = this.config.adminNumbers || [];

    if (allowed.length === 0 || allowed.includes('*')) {
      return true;
    }

    const normalizedChat = String(chatId)
      .replace('@c.us', '')
      .replace('@lid', '')
      .replace('@s.whatsapp.net', '');

    const candidates = new Set([
      chatId,
      normalizedChat,
      this.normalizeDigits(chatId),
      this.normalizeDigits(normalizedChat)
    ]);

    if (contactNumber) {
      candidates.add(contactNumber);
      candidates.add(this.normalizeDigits(contactNumber));
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (allowed.includes(candidate) || admins.includes(candidate)) {
        return true;
      }
    }

    return false;
  }

  checkRateLimit(chatId) {
    const now = Date.now();
    const limit = this.config.settings.rateLimit;

    if (!this.rateLimitMap.has(chatId)) {
      this.rateLimitMap.set(chatId, { count: 1, windowStart: now });
      return true;
    }

    const userData = this.rateLimitMap.get(chatId);
    const windowMs = 60000;

    if (now - userData.windowStart > windowMs) {
      userData.count = 1;
      userData.windowStart = now;
      return true;
    }

    if (userData.count >= limit.messagesPerMinute) {
      return false;
    }

    userData.count++;
    return true;
  }

  getPendingQueue(chatId) {
    if (!this.pendingJobs.has(chatId)) {
      this.pendingJobs.set(chatId, []);
    }
    return this.pendingJobs.get(chatId);
  }

  createJob(message) {
    return {
      id: crypto.randomBytes(4).toString('hex'),
      createdAt: new Date(),
      message
    };
  }

  /**
   * AI'ın hazırladığı plan ile arka plan görevi başlat
   * taskPlan: { title, steps[], prompt }
   */
  async startBackgroundTask(message, taskPlan, images = []) {
    const from = message.from;
    const maxTasks = parseInt(process.env.MAX_BG_TASKS_PER_USER || '3', 10);
    const fallbackOrchestrator =
      taskPlan?.fallbackOrchestrator || this.sessionManager.getOrchestratorType(from);
    const selectedOrchestrator = taskPlan?.orchestrator || fallbackOrchestrator;

    // Aktif görev limiti kontrol
    const activeCount = taskManager.getActiveTaskCount(from);
    if (activeCount >= maxTasks) {
      return null; // Limit aşıldı, normal akışa devam
    }

    const { title, steps, prompt } = taskPlan;
    const description = title || (prompt.length > 50 ? prompt.substring(0, 50) + '...' : prompt);

    // Görevi başlat
    const task = await taskManager.startTask({
      owner: from,
      description,
      prompt,
      images,
      orchestrator: selectedOrchestrator,
      onComplete: async (completedTask) => {
        let resultText = `ℹ️ Görev durumu: ${completedTask.status}`;
        try {
          if (completedTask.status === 'completed') {
            resultText = `✅ *Görev tamamlandı: ${completedTask.description}*\n\n` +
              `${completedTask.result}`;
          } else if (completedTask.status === 'failed') {
            resultText = `❌ *Görev başarısız: ${completedTask.description}*\n\n` +
              `Hata: ${completedTask.error}`;
          } else if (completedTask.status === 'timeout') {
            resultText = `⏰ *Görev zaman aşımı: ${completedTask.description}*`;
          } else {
            resultText = `ℹ️ Görev durumu: ${completedTask.status}`;
          }

          const requestId = completedTask.requestId || `bg-${completedTask.id}`;
          await this.queueOutboxMessage(from, resultText, {
            type: completedTask.status === 'failed' || completedTask.status === 'timeout' ? 'error' : 'final',
            requestId,
            orchestrator: completedTask.orchestrator || null,
            meta: {
              taskId: completedTask.id,
              taskStatus: completedTask.status
            }
          });
          this.addSystemNote(from, resultText);
        } catch (e) {
          logger.error('Görev sonucu gönderme hatası:', e);
          try {
            const fallback = e?.message ? `${resultText}\n\n(Not: outbox kuyruga yazilamadi: ${e.message})` : resultText;
            await this.sendTextToChat(from, fallback);
            this.db.logMessage(from, fallback, 'outgoing');
          } catch (sendErr) {
            logger.error('Görev sonucu fallback gonderilemedi:', sendErr);
          }
        }
      }
    });

    // Kullanıcıya gösterilecek mesaj (AI'ın hazırladığı plan)
    let userMessage = `🚀 *${title}*\n\n`;
    if (selectedOrchestrator) {
      userMessage += `🤖 Orkestratör: ${selectedOrchestrator}\n\n`;
    }

    if (steps && steps.length > 0) {
      userMessage += `📋 Plan:\n`;
      steps.forEach((step, i) => {
        userMessage += `${i + 1}. ${step}\n`;
      });
      userMessage += '\n';
    }

    userMessage += `_Arka planda çalışıyorum, bitince haber vereceğim. Şimdi başka bir şey sorabilirsin!_`;

    return userMessage;
  }

  /**
   * Görev listesi göster
   */
  getTaskListMessage(from) {
    const tasks = taskManager.getTasksForOwner(from);
    if (tasks.length === 0) {
      return 'Henüz hiç arka plan görevin yok.';
    }

    const lines = ['📋 *Arka Plan Görevlerin:*\n'];
    for (const task of tasks.slice(0, 10)) {
      const status = {
        'running': '🔄 Çalışıyor',
        'completed': '✅ Tamamlandı',
        'failed': '❌ Başarısız',
        'timeout': '⏰ Zaman aşımı',
        'cancelled': '🚫 İptal edildi',
        'interrupted': '⚠️ Kesildi'
      }[task.status] || '❓ Bilinmiyor';

      const duration = this.getTaskDuration(task);
      const orchestratorLabel = task.orchestrator
        ? `${task.orchestrator}${task.model ? ` (${task.model})` : ''}`
        : '';
      lines.push(`${status}`);
      lines.push(`  📝 ${task.description}`);
      if (orchestratorLabel) {
        lines.push(`  🤖 ${orchestratorLabel}`);
      }
      lines.push(`  🆔 \`${task.id}\``);
      lines.push(`  ⏱️ ${duration}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  getTaskDuration(task) {
    const start = new Date(task.createdAt);
    const end = task.completedAt ? new Date(task.completedAt) : new Date();
    const diffMs = end - start;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);

    if (diffMin > 0) {
      return `${diffMin} dakika ${diffSec % 60} saniye`;
    }
    return `${diffSec} saniye`;
  }

  /**
   * Aktif görevlerin özetini al (AI'a context olarak verilecek)
   */
  getActiveTasksSummary(from) {
    const tasks = taskManager.getTasksForOwner(from);
    const running = tasks.filter(t => t.status === 'running');
    const recent = tasks.filter(t => t.status === 'completed' &&
      (Date.now() - new Date(t.completedAt).getTime()) < 5 * 60 * 1000); // Son 5 dakika

    if (running.length === 0 && recent.length === 0) {
      return null;
    }

    let summary = '\n\n[ARKA PLAN GÖREVLERİ]\n';

    if (running.length > 0) {
      summary += `Şu an çalışan ${running.length} görev var:\n`;
      for (const task of running) {
        const duration = this.getTaskDuration(task);
        const orch = task.orchestrator ? `, ${task.orchestrator}` : '';
        summary += `- "${task.description}" (${duration}dir çalışıyor${orch})\n`;
      }
    }

    if (recent.length > 0) {
      summary += `Son tamamlanan görevler:\n`;
      for (const task of recent) {
        summary += `- "${task.description}" ✅\n`;
      }
    }

    summary += '[/ARKA PLAN GÖREVLERİ]\n';
    return summary;
  }

  /**
   * Claude execution sırasında outbox'a mesaj atılıp atılmadığını kontrol et
   * Atıldıysa response text'i susutur (çift mesaj önleme)
   */
  async hasOutboxActivity(requestId) {
    if (!requestId) return false;
    const token = String(requestId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 24);
    if (!token || token === 'noreq') return false;

    for (const dir of [this.outboxPaths.pendingDir, this.outboxPaths.processedDir]) {
      try {
        const files = await fs.promises.readdir(dir);
        if (files.some(f => f.includes(token))) return true;
      } catch {
        // dizin henüz yok olabilir
      }
    }
    return false;
  }

  async processOneMessage(message) {
    const from = message.from;
    this.setAiExecutionMeta(from, null);
    let body = message.body || '';
    const hasMedia = message.hasMedia === true;

    const trimmedBody = String(body || '').trim();
    const lowerBody = trimmedBody.toLowerCase();

    // Görev listesi komutu
    if (lowerBody === 'görevler' || lowerBody === 'gorevler' || lowerBody === 'tasks') {
      return this.getTaskListMessage(from);
    }

    // Son kaydedilen dosya komutu
    if (!hasMedia && lowerBody.replace(/\s+/g, ' ') === 'son dosya') {
      const record = this.db?.getLastSavedFile?.(from) || this.lastSavedFileByChat.get(from) || null;
      if (!record) {
        return 'Henüz kaydedilen bir dosya yok.';
      }
      const mimetype = record.mimetype || 'bilinmiyor';
      const size = this.formatBytesForUser(record.size_bytes ?? record.sizeBytes ?? 0);
      const createdAt = record.created_at || record.createdAt || '-';
      const messageId = record.message_id || record.messageId || '-';
      const abs = record.absolute_path || record.absolutePath || '-';
      return `Son dosya: ${abs} (${mimetype}, ${size})\nMesaj: ${messageId}\nTarih: ${createdAt}`;
    }

    // Terminal session komutları (!!new, !!tlist, !!tchange, !!trename, !!tdelete, !!help)
    if (!hasMedia && this.terminalHandler.isTerminalCommand(lowerBody)) {
      return this.terminalHandler.handle(from, trimmedBody);
    }

    // Orkestratör değiştirme komutu (!!switch, !!asistan, !!ai)
    if (!hasMedia && this.switchHandler.isSwitch(lowerBody)) {
      // Switch öncesi aktif terminal session'ı kaydet
      await this.terminalHandler.snapshotActiveSession(from).catch(() => {});
      const response = await this.switchHandler.handle(from, trimmedBody);
      return response;
    }

    // Lazy terminal geçişi: aktif terminal değiştiyse session'ı yenile
    await this.terminalHandler.ensureCorrectTerminal(from);

    // Normal akış - AI karar verecek
    let session = this.sessionManager.getSession(from);
    if (!session) {
      session = await this.sessionManager.createSession(from);
      // Session'a terminal key'ini ata (lazy detection için)
      const termInfo = this.terminalHandler.getActiveLabel(from);
      session._terminalKey = termInfo?.key || null;
      logger.info(`Yeni oturum oluşturuldu: ${maskPhoneLike(from)}`);
    }

    let images = [];
    let savedMediaInfo = null;

    if (hasMedia) {
      // 1. Önce dosya boyutunu İNDİRMEDEN kontrol et (OOM koruması)
      const preDownloadSize = this.getPreDownloadFileSize(message);
      const originalNameHint = this.getMediaOriginalName(message);
      body = this.cleanMediaBody(body, originalNameHint);
      const mimetypeHint = message?._data?.mimetype || '';
      const mediaTypeHint = this.mediaTypeFromMimetype(mimetypeHint);
      const maxBytes = this.getMaxMediaBytes(mediaTypeHint);

      logger.info(`Dosya alınıyor: ${this.getMediaOriginalName(message) || 'bilinmeyen'}, tahmini boyut: ${preDownloadSize > 0 ? this.formatBytesForUser(preDownloadSize) : 'bilinmiyor'}, limit: ${this.formatBytesForUser(maxBytes)}`);

      if (preDownloadSize > 0 && preDownloadSize > maxBytes) {
        throw new Error(
          `Dosya çok büyük (${Math.ceil(preDownloadSize / 1024 / 1024)}MB). En fazla ${Math.ceil(maxBytes / 1024 / 1024)}MB. Dosya indirilmedi.`
        );
      }

      // 2. Büyük dosyalarda direct indirme yolunu dene
      if (this.shouldUseDirectDownload(preDownloadSize)) {
        try {
          savedMediaInfo = await this.downloadMediaDirect(message, preDownloadSize, maxBytes);
        } catch (directErr) {
          logger.warn(
            `Direct indirme başarısız, normal indirme deneniyor: ${directErr?.message || String(directErr)}`
          );
        }
      }

      // 3. Fallback: whatsapp-web.js downloadMedia (base64)
      if (!savedMediaInfo) {
        logger.info('Dosya indiriliyor...');
        const downloadStart = Date.now();
        let media;
        try {
          media = await message.downloadMedia();
          logger.info(
            `Dosya indirildi (${Date.now() - downloadStart}ms), boyut: ` +
            `${media?.data?.length ? this.formatBytesForUser(this.estimateBase64Bytes(media.data)) : 'null'}`
          );
        } catch (downloadErr) {
          logger.error(`Dosya indirme hatası (${Date.now() - downloadStart}ms): ${downloadErr?.message || String(downloadErr)}`);
          throw new Error(`Dosya indirilemedi: ${downloadErr?.message || 'Bilinmeyen hata'}`);
        }
        const mimetype = this.normalizeMimetype(media?.mimetype || '');
        const data = media?.data || '';
        if (!data) {
          throw new Error('Dosya indirilemedi');
        }

        const mediaType = this.mediaTypeFromMimetype(mimetype);
        const actualMaxBytes = this.getMaxMediaBytes(mediaType);
        const estimatedSize = this.estimateBase64Bytes(data);

        // İndirme sonrası boyut kontrolü (metadata eksik olabilir)
        if (estimatedSize > actualMaxBytes) {
          throw new Error(
            `Dosya çok büyük (${Math.ceil(estimatedSize / 1024 / 1024)}MB). En fazla ${Math.ceil(actualMaxBytes / 1024 / 1024)}MB.`
          );
        }

        const messageId = this.getMessageId(message);
        const createdAtISO = this.getMessageCreatedAtISO(message);
        const originalName = this.getMediaOriginalName(message);
        const storedFilename = this.makeSafeStoredFilename({ originalName, mimetype });
        const { absolutePath } = await this.resolveMediaSavePath(from, storedFilename);

        // Streaming ile kaydet (büyük dosyalarda bellek koruması)
        const actualSize = await this.saveMediaStreaming(media, absolutePath, estimatedSize);

        savedMediaInfo = {
          chatId: from,
          messageId,
          mediaType,
          mimetype,
          sizeBytes: actualSize,
          originalName: originalName || storedFilename,
          absolutePath,
          createdAt: createdAtISO
        };
      }

      if (savedMediaInfo) {
        await this.finalizeSavedMedia(message, savedMediaInfo);
        if (savedMediaInfo.mediaType === 'image') {
          images = [savedMediaInfo.absolutePath];
        }
      }

      // Sadece caption varsa AI'a ilet, captionsuz medyalar tetiklemesin
      const trimmedBody = String(body || '').trim();
      if (!trimmedBody) {
        return NO_RESPONSE;
      }
      // Fall through: caption ile AI işlemine devam et (medya zaten indirildi)
    }

    // Temel prompt
    let basePrompt = body;
    if (hasMedia) {
      if (images.length && (!body || body.trim() === '')) {
        basePrompt =
          'Kullanıcı bir görsel gönderdi (açıklama yok). Görseli analiz et ve kısa bir cevap ver; gerekiyorsa 1-2 net soru sor.';
      } else if (images.length) {
        basePrompt = body;
      } else if (savedMediaInfo) {
        const sizeMb = Math.ceil(savedMediaInfo.sizeBytes / 1024 / 1024);
        const metaLine =
          `Kullanıcı bir dosya gönderdi (${savedMediaInfo.mediaType}). ` +
          `Ad: "${savedMediaInfo.originalName}", Tür: ${savedMediaInfo.mimetype || 'bilinmiyor'}, Boyut: ~${sizeMb}MB.`;
        basePrompt = (!body || body.trim() === '') ? metaLine : `${body}\n\n${metaLine}`;
      } else if (!body || body.trim() === '') {
        basePrompt = 'Kullanıcı bir dosya gönderdi (tür bilinmiyor). Kısa bir cevap ver ve gerekiyorsa 1-2 net soru sor.';
      }
    }

    // Sistem mesajlarını ve görev özetini ekle
    const systemNotes = this.consumeSystemNotes(from);
    const systemBlock = this.formatSystemNotes(systemNotes);
    const taskSummary = this.getActiveTasksSummary(from);
    const messageTimestamp = this.formatMessageTimestampForPrompt(message);
    const timestampBlock = `\n\n[MESAJ ZAMANI]\n${messageTimestamp}\n[/MESAJ ZAMANI]\n`;
    const feedbackExpectationBlock = this.buildFeedbackExpectationBlock();
    const outboxInstructions = `\n\n${getOutboxPromptInstructions()}\n`;
    const prompt = `${basePrompt}${timestampBlock}${feedbackExpectationBlock}${systemBlock}${taskSummary || ''}${outboxInstructions}`;

    const response = await session.execute(prompt, { images });
    this.setAiExecutionMeta(from, session?.lastExecutionMeta || null);

    // AI'ın arka plan görevi planı var mı kontrol et
    const taskPlan = this.parseBackgroundTaskPlan(response);
    if (taskPlan) {
      const bgResult = await this.startBackgroundTask(message, taskPlan, images);
      if (bgResult) {
        return bgResult;
      }
      // Limit aşıldıysa normal yanıtı göster
    }

    // Terminal session state'ini otomatik kaydet
    this.terminalHandler.autoSave(from).catch(() => {});

    // Claude outbox'a kendi mesajlarını atmışsa response text'i susutur (çift mesaj önleme)
    const reqId = session?.lastExecutionMeta?.requestId;
    if (reqId && await this.hasOutboxActivity(reqId)) {
      logger.info(`Claude outbox mesajı gönderdi (${reqId.substring(0, 16)}...), response text susturuluyor`);
      return NO_RESPONSE;
    }

    // Fallback: Claude outbox kullanmadıysa response text'i gönder
    const cleaned = this.cleanResponse(response);
    if (cleaned && cleaned.trim()) {
      return cleaned;
    }

    // Eğer yanıt sadece bg-task bloğundan ibaretse cleanResponse() sonucu boş kalabilir.
    if (taskPlan) {
      const maxTasks = parseInt(process.env.MAX_BG_TASKS_PER_USER || '3', 10);
      const activeCount = taskManager.getActiveTaskCount(from);
      if (activeCount >= maxTasks) {
        return (
          `Şu an en fazla ${maxTasks} arka plan görevi aynı anda çalışabiliyor. ` +
          `Mevcut görevleri görmek için "görevler" yazabilirsin; istersen birini iptal etmene de yardım edeyim.`
        );
      }
      return 'Arka plan görev planını aldım ama yanıt metni boş geldi. İstersen sorunu 1 cümleyle tekrar yazar mısın?';
    }

    logger.warn('AI yanıtı boş/temizlenince boş kaldı');
    return 'Cevabım boş geldi. Tekrar dener misin? İstersen `!!switch` ile farklı bir orkestratör deneyebilirsin.';
  }

  /**
   * AI yanıtından arka plan görev planını çıkar
   * Format: ```bg-task\n{json}\n```
   */
  parseBackgroundTaskPlan(response) {
    if (!response) return null;

    // ```bg-task ... ``` bloğunu ara
    const match = response.match(/```bg-task\s*\n([\s\S]*?)\n```/);
    if (!match) return null;

    try {
      const json = JSON.parse(match[1].trim());

      // Zorunlu alanlar
      if (!json.title || !json.prompt) {
        logger.warn('Geçersiz bg-task formatı: title veya prompt eksik');
        return null;
      }

      const orchestrator = this.normalizeTaskOrchestrator(
        json.orchestrator ?? json.model ?? json.ai
      );
      if (!orchestrator) {
        logger.warn('bg-task orkestratör belirtilmedi, varsayılan kullanılacak');
      }

      return {
        title: String(json.title),
        steps: Array.isArray(json.steps) ? json.steps.map(String) : [],
        prompt: String(json.prompt),
        orchestrator
      };
    } catch (e) {
      logger.warn('bg-task JSON parse hatası:', e.message);
      return null;
    }
  }

  /**
   * Yanıttan bg-task bloğunu temizle
   */
  cleanResponse(response) {
    if (response === null || response === undefined) return response;
    return String(response).replace(/```bg-task\s*\n[\s\S]*?\n```/g, '').trim();
  }

  async runQueue(chatId) {
    const queue = this.getPendingQueue(chatId);

    try {
      while (queue.length) {
        const job = queue.shift();
        if (!job) continue;

        try {
          const result = await this.processOneMessage(job.message);
          const executionMeta = this.consumeAiExecutionMeta(chatId);
          if (result === NO_RESPONSE) {
            continue;
          }
          // Bazı edge-case'lerde AI boş string döndürebilir (veya yanıt temizlenince boş kalabilir).
          // Bu durumda generic hata yerine anlamlı bir mesaj dön.
          if (typeof result === 'string' && result.trim() === '') {
            const txt =
              'Cevabım boş geldi (muhtemelen bağlantı/timeout ya da yalnızca bir plan bloğu döndü). ' +
              'Tekrar dener misin? İstersen `!!switch` ile farklı bir orkestratör de deneyebilirsin.';
            try {
              await this.replyToMessage(job.message, txt);
              this.db.logMessage(chatId, txt, 'outgoing');
              this.addSystemNote(chatId, txt);
            } catch (sendError) {
              logger.error('Hata mesajı gönderilemedi:', sendError?.message || String(sendError));
            }
            continue;
          }
          if (result === null || result === undefined) {
            const txt =
              'Cevap alamadım (bağlantı/timeout veya orkestratör tarafında bir aksilik olmuş olabilir). ' +
              'Bir kez daha yazar mısın? İstersen `!!switch` ile farklı bir orkestratör de deneyebiliriz.';
            try {
              await this.replyToMessage(job.message, txt);
              this.db.logMessage(chatId, txt, 'outgoing');
              this.addSystemNote(chatId, txt);
            } catch (sendError) {
              logger.error('Hata mesajı gönderilemedi:', sendError?.message || String(sendError));
            }
            continue;
          }

          // AI yanıtına terminal etiketi ekle
          const tagged = this.addTerminalPrefix(chatId, result);
          const chunks = tagged.length > 4000 ? this.splitMessage(tagged, 4000) : [tagged];

          if (executionMeta?.requestId) {
            try {
              for (let i = 0; i < chunks.length; i++) {
                await this.queueOutboxMessage(chatId, chunks[i], {
                  type: i === chunks.length - 1 ? 'final' : 'progress',
                  requestId: executionMeta.requestId,
                  orchestrator: executionMeta.orchestrator || null,
                  meta: {
                    sessionId: executionMeta.sessionId || null,
                    chunkIndex: i + 1,
                    chunkCount: chunks.length
                  }
                });
              }
              continue;
            } catch (outboxError) {
              logger.error('AI yaniti outboxa yazilamadi:', outboxError?.message || String(outboxError));
            }
          }

          for (let i = 0; i < chunks.length; i++) {
            try {
              await this.replyToMessage(job.message, chunks[i]);
              this.db.logMessage(chatId, chunks[i], 'outgoing');
            } catch (sendError) {
              logger.error('Mesaj chunk gönderilemedi:', sendError?.message || String(sendError));
              break;
            }
            if (i < chunks.length - 1) {
              await this.sleep(500);
            }
          }
        } catch (e) {
          this.consumeAiExecutionMeta(chatId);
          const errorMsg = e?.message || String(e);
          const txt = `Hata: ${errorMsg}`;
          try {
            await this.replyToMessage(job.message, txt);
            this.db.logMessage(chatId, txt, 'outgoing');
            this.addSystemNote(chatId, txt);
          } catch (sendError) {
            logger.error('Hata mesajı gönderilemedi:', sendError?.message || String(sendError));
          }
        }
      }
    } finally {
      this.processingQueue.set(chatId, false);
    }
  }

  /**
   * Mesajın kuyruk-bypass edilecek anında çalışan komut olup olmadığını kontrol et
   */
  isInstantCommand(text) {
    if (!text) return false;
    const lower = String(text).toLowerCase().trim();
    if (this.terminalHandler.isTerminalCommand(lower)) return true;
    if (this.switchHandler.isSwitch(lower)) return true;
    if (lower === 'görevler' || lower === 'gorevler' || lower === 'tasks') return true;
    if (lower.replace(/\s+/g, ' ') === 'son dosya') return true;
    return false;
  }

  /**
   * Terminal etiketi ekle (AI yanıtları için)
   */
  addTerminalPrefix(chatId, text) {
    const info = this.terminalHandler.getActiveLabel(chatId);
    if (!info) return text;
    return `[${info.key}] ${text}`;
  }

  async handleMessage(message) {
    const from = message.from;
    const body = message.body;
    const hasMedia = message.hasMedia === true;

    if (message.fromMe) return;
    if (!hasMedia && (!body || body.trim() === '')) return;

    if (from.includes('@g.us')) return;

    let contactNumber = null;
    try {
      const contact = await message.getContact();
      contactNumber = contact?.number || contact?.id?.user || null;
    } catch {
      // ignore
    }

    if (!this.isAllowed(from, contactNumber)) {
      logger.warn(`Yetkisiz mesaj: ${from}`);
      return;
    }

    logger.info(
      `Mesaj alındı [${from}]${hasMedia ? ' (media)' : ''}: ${String(body || '').substring(0, 100)}`
    );

    const incomingLog = hasMedia
      ? `[media]${body && body.trim() ? ` ${body.trim()}` : ''}`
      : body;
    this.db.logMessage(from, incomingLog, 'incoming');

    // Komutları kuyruk-bypass ile anında işle
    // Terminal tıkansa bile komutlar çalışır
    if (!hasMedia && this.isInstantCommand(body)) {
      try {
        const result = await this.processOneMessage(message);
        if (result && result !== NO_RESPONSE) {
          await this.replyToMessage(message, result);
          this.db.logMessage(from, result, 'outgoing');
        }
      } catch (e) {
        const txt = `Hata: ${e?.message || String(e)}`;
        try {
          await this.replyToMessage(message, txt);
          this.db.logMessage(from, txt, 'outgoing');
        } catch {}
      }
      return;
    }

    // Normal mesajlar kuyruğa eklenir
    const queue = this.getPendingQueue(from);
    const job = this.createJob(message);
    queue.push(job);

    if (this.processingQueue.get(from)) {
      return;
    }

    this.processingQueue.set(from, true);
    this.runQueue(from).catch((error) => {
      logger.error('Kuyruk çalıştırma hatası:', error);
      this.processingQueue.set(from, false);
    });
  }

  /**
   * Mesaj gönderme - retry mekanizması ile
   * Frame detached hatalarında yeniden dener
   */
  async sendTextToChat(chatId, text, maxRetries = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 1. Önce whatsapp-web.js API'yi dene (en stabil)
        const client = this.wa?.client;
        if (client && typeof client.sendMessage === 'function') {
          try {
            await client.sendMessage(chatId, text);
            logger.info(`Mesaj gönderildi -> ${maskPhoneLike(chatId)}`);
            return;
          } catch (sendErr) {
            const errMsg = sendErr?.message || String(sendErr) || 'Bilinmeyen sendMessage hatası';
            logger.warn(`sendMessage hatası (deneme ${attempt}): ${errMsg}`);
            // sendMessage başarısız, fallback'e devam et
          }
        }

        // 2. Fallback: puppeteer page injection
        const page = client?.pupPage;
        if (!page) {
          throw new Error('WhatsApp sayfası hazır değil');
        }

        const result = await page.evaluate(
          async (chatId, text) => {
            try {
              const WWebJS = window.WWebJS;
              if (!WWebJS?.getChat || !WWebJS?.sendMessage) {
                return { success: false, error: 'WWebJS hazır değil', retryable: true };
              }

              const chat = await WWebJS.getChat(chatId, { getAsModel: false });
              if (!chat) {
                return { success: false, error: 'Chat bulunamadı', retryable: false };
              }

              await WWebJS.sendMessage(chat, text, {});
              return { success: true };
            } catch (e) {
              const errMsg = e?.message || String(e) || 'page.evaluate hatası';
              const retryable = errMsg.includes('detached') || errMsg.includes('Target closed');
              return { success: false, error: errMsg, retryable };
            }
          },
          chatId,
          text
        );

        if (result?.success) {
          logger.info(`Mesaj gönderildi -> ${maskPhoneLike(chatId)}`);
          return;
        }

        const evalError = result?.error || 'page.evaluate başarısız';
        lastError = new Error(evalError);

        // Retryable değilse döngüden çık
        if (result?.retryable === false) {
          throw lastError;
        }

        // Retry için devam et
        throw lastError;

      } catch (e) {
        lastError = e;
        const errMsg = e?.message || String(e) || 'Bilinmeyen hata';
        const isRetryable = errMsg.includes('detached') ||
                           errMsg.includes('Target closed') ||
                           errMsg.includes('Session closed') ||
                           errMsg.includes('Protocol error') ||
                           errMsg.includes('WWebJS hazır değil') ||
                           errMsg.includes('sayfası hazır değil');

        if (!isRetryable || attempt >= maxRetries) {
          logger.error(`Mesaj gönderilemedi (deneme ${attempt}/${maxRetries}): ${errMsg}`);
          throw lastError;
        }

        logger.warn(`Mesaj gönderme hatası, yeniden deneniyor (${attempt}/${maxRetries}): ${errMsg}`);

        // Bekleme süresi artarak dene (exponential backoff)
        const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await this.sleep(waitMs);

        // WhatsApp sayfasını yenilemeyi dene
        try {
          const page = this.wa?.client?.pupPage;
          if (page) {
            logger.info('WhatsApp sayfası yenileniyor...');
            await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
            await this.sleep(2000); // Sayfa stabilize olsun
          }
        } catch (reloadErr) {
          logger.warn('Sayfa yenileme başarısız:', reloadErr?.message || String(reloadErr));
        }
      }
    }

    throw lastError || new Error('Mesaj gönderilemedi (maksimum deneme aşıldı)');
  }

  async replyToMessage(originalMessage, text, maxRetries = 3) {
    const chatId = originalMessage.from;
    return await this.sendTextToChat(chatId, text, maxRetries);
  }

  splitMessage(text, maxLength) {
    const chunks = [];
    let current = '';

    const lines = text.split('\n');
    for (const line of lines) {
      if (current.length + line.length + 1 > maxLength) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default MessageHandler;
