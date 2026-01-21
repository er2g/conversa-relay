import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import logger from '../logger.js';
import { paths } from '../paths.js';
import { taskManager } from '../background/task-manager.js';
import { maskPhoneLike } from '../utils/redact.js';

const configPath = process.env.SESSIONS_CONFIG_PATH || path.join(paths.configDir, 'sessions.json');

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
      onComplete: async (completedTask) => {
        try {
          let resultText;
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

          await this.replyToMessage(message, resultText);
          this.db.logMessage(from, resultText, 'outgoing');
        } catch (e) {
          logger.error('Görev sonucu gönderme hatası:', e);
        }
      }
    });

    // Kullanıcıya gösterilecek mesaj (AI'ın hazırladığı plan)
    let userMessage = `🚀 *${title}*\n\n`;

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
      lines.push(`${status}`);
      lines.push(`  📝 ${task.description}`);
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
        summary += `- "${task.description}" (${duration}dir çalışıyor)\n`;
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

  async processOneMessage(message) {
    const from = message.from;
    const body = message.body || '';
    const hasMedia = message.hasMedia === true;

    const lowerBody = body.toLowerCase().trim();

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

    // Normal akış - AI karar verecek
    let session = this.sessionManager.getSession(from);
    if (!session) {
      session = await this.sessionManager.createSession(from);
      logger.info(`Yeni oturum oluşturuldu: ${maskPhoneLike(from)}`);
    }

    let images = [];
    let savedMediaInfo = null;

    if (hasMedia) {
      // 1. Önce dosya boyutunu İNDİRMEDEN kontrol et (OOM koruması)
      const preDownloadSize = this.getPreDownloadFileSize(message);
      const mimetypeHint = message?._data?.mimetype || '';
      const mediaTypeHint = this.mediaTypeFromMimetype(mimetypeHint);
      const maxBytes = this.getMaxMediaBytes(mediaTypeHint);

      if (preDownloadSize > 0 && preDownloadSize > maxBytes) {
        throw new Error(
          `Dosya çok büyük (${Math.ceil(preDownloadSize / 1024 / 1024)}MB). En fazla ${Math.ceil(maxBytes / 1024 / 1024)}MB. Dosya indirilmedi.`
        );
      }

      // 2. Şimdi indir
      const media = await message.downloadMedia();
      const mimetype = this.normalizeMimetype(media?.mimetype || '');
      const data = media?.data || '';
      if (!data) {
        throw new Error('Dosya indirilemedi');
      }

      const mediaType = this.mediaTypeFromMimetype(mimetype);
      const actualMaxBytes = this.getMaxMediaBytes(mediaType);
      const estimatedSize = this.estimateBase64Bytes(data);

      // 3. İndirme sonrası boyut kontrolü (metadata eksik olabilir)
      if (estimatedSize > actualMaxBytes) {
        throw new Error(
          `Dosya çok büyük (${Math.ceil(estimatedSize / 1024 / 1024)}MB). En fazla ${Math.ceil(actualMaxBytes / 1024 / 1024)}MB.`
        );
      }

      const chatDirName = this.sanitizePathPart(from);
      const messageId = this.getMessageId(message);
      const createdAtISO = this.getMessageCreatedAtISO(message);
      const originalName = this.getMediaOriginalName(message);
      const storedFilename = this.makeSafeStoredFilename({ originalName, mimetype });

      const preferredRoot = path.resolve(paths.mediaDir);
      const fallbackRoot = path.resolve(paths.dataDir, 'media');

      let baseDir = path.resolve(preferredRoot, chatDirName);
      try {
        await fs.promises.mkdir(baseDir, { recursive: true });
      } catch (e) {
        const code = e?.code || '';
        if (code === 'EACCES' || code === 'EPERM') {
          logger.warn(
            `MEDIA_DIR yazılamıyor (${preferredRoot}). Fallback kullanılıyor: ${fallbackRoot}`
          );
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

      // 4. Streaming ile kaydet (büyük dosyalarda bellek koruması)
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

      this.lastSavedFileByChat.set(from, savedMediaInfo);
      if (this.db?.setLastSavedFile) {
        this.db.setLastSavedFile({
          chatId: from,
          messageId,
          mimetype,
          sizeBytes: actualSize,
          absolutePath,
          createdAt: createdAtISO
        });
      }

      const ack = `Dosya kaydedildi: ${absolutePath} (${mimetype || 'bilinmiyor'}, ${this.formatBytesForUser(actualSize)})`;
      try {
        await this.replyToMessage(message, ack);
        this.db.logMessage(from, ack, 'outgoing');
      } catch (e) {
        logger.warn('Dosya kaydedildi mesajı gönderilemedi:', e?.message || String(e));
      }

      if (mediaType === 'image') {
        images = [absolutePath];
      }
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

    // Aktif görevlerin context'ini ekle
    const taskSummary = this.getActiveTasksSummary(from);
    const prompt = taskSummary ? basePrompt + taskSummary : basePrompt;

    const response = await session.execute(prompt, { images });

    // AI'ın arka plan görevi planı var mı kontrol et
    const taskPlan = this.parseBackgroundTaskPlan(response);
    if (taskPlan) {
      const bgResult = await this.startBackgroundTask(message, taskPlan, images);
      if (bgResult) {
        return bgResult;
      }
      // Limit aşıldıysa normal yanıtı göster
    }

    // Normal yanıt - task plan marker'ını temizle
    return this.cleanResponse(response);
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

      return {
        title: String(json.title),
        steps: Array.isArray(json.steps) ? json.steps.map(String) : [],
        prompt: String(json.prompt)
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
    if (!response) return response;
    return response.replace(/```bg-task\s*\n[\s\S]*?\n```/g, '').trim();
  }

  async runQueue(chatId) {
    const queue = this.getPendingQueue(chatId);

    try {
      while (queue.length) {
        const job = queue.shift();
        if (!job) continue;

        try {
          const result = await this.processOneMessage(job.message);
          if (!result) {
            const txt = 'Hata: Yanıt boş döndü.';
            try {
              await this.replyToMessage(job.message, txt);
              this.db.logMessage(chatId, txt, 'outgoing');
            } catch (sendError) {
              logger.error('Hata mesajı gönderilemedi:', sendError?.message || String(sendError));
            }
            continue;
          }

          if (result.length > 4000) {
            const chunks = this.splitMessage(result, 4000);
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
          } else {
            try {
              await this.replyToMessage(job.message, result);
              this.db.logMessage(chatId, result, 'outgoing');
            } catch (sendError) {
              logger.error('Mesaj gönderilemedi:', sendError?.message || String(sendError));
            }
          }
        } catch (e) {
          const errorMsg = e?.message || String(e);
          const txt = `Hata: ${errorMsg}`;
          try {
            await this.replyToMessage(job.message, txt);
            this.db.logMessage(chatId, txt, 'outgoing');
          } catch (sendError) {
            logger.error('Hata mesajı gönderilemedi:', sendError?.message || String(sendError));
          }
        }
      }
    } finally {
      this.processingQueue.set(chatId, false);
    }
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
  async replyToMessage(originalMessage, text, maxRetries = 3) {
    const chatId = originalMessage.from;
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
