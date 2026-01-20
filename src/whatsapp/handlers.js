import fs from 'fs';
import path from 'path';
import logger from '../logger.js';
import { paths } from '../paths.js';
import crypto from 'crypto';

const configPath = process.env.SESSIONS_CONFIG_PATH || path.join(paths.configDir, 'sessions.json');

class MessageHandler {
  constructor(whatsappClient, sessionManager, intentDetector, db) {
    this.wa = whatsappClient;
    this.sessionManager = sessionManager;
    this.db = db;
    this.config = this.loadConfig();
    this.rateLimitMap = new Map();
    this.processingQueue = new Map();
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
    switch (String(mimetype || '').toLowerCase()) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return 'bin';
    }
  }

  isAllowed(chatId, contactNumber) {
    // Grup mesajlarını yoksay (güvenlik için)
    if (chatId.includes('@g.us')) {
      return false;
    }

    const allowed = this.config.allowedNumbers || [];
    const admins = this.config.adminNumbers || [];

    // Whitelist boşsa veya "*" varsa herkese izin ver
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

  async handleMessage(message) {
    const from = message.from;
    const body = message.body;
    const hasMedia = message.hasMedia === true;

    if (message.fromMe) return;
    if (!hasMedia && (!body || body.trim() === '')) return;

    // Grup mesajlarını direkt yoksay
    if (from.includes('@g.us')) return;

    // Kontak bilgisi (LID durumlarında numarayı buradan almak daha güvenli)
    let contactNumber = null;
    try {
      const contact = await message.getContact();
      contactNumber = contact?.number || contact?.id?.user || null;
    } catch {
      // ignore
    }

    // Whitelist kontrolü
    if (!this.isAllowed(from, contactNumber)) {
      logger.warn(`Yetkisiz mesaj: ${from}`);
      return;
    }

    // Rate limit kontrolü
    if (!this.checkRateLimit(from)) {
      await this.replyToMessage(message, 'Yavaş ol biraz, çok hızlı mesaj atıyorsun.');
      return;
    }

    if (this.processingQueue.get(from)) {
      await this.replyToMessage(message, 'Bir önceki mesajın hala işleniyor, biraz bekle...');
      return;
    }

    logger.info(
      `Mesaj alındı [${from}]${hasMedia ? ' (media)' : ''}: ${String(body || '').substring(0, 100)}`
    );

    const incomingLog = hasMedia
      ? `[media]${body && body.trim() ? ` ${body.trim()}` : ''}`
      : body;
    this.db.logMessage(from, incomingLog, 'incoming');

    this.processingQueue.set(from, true);

    try {
      let session = this.sessionManager.getSession(from);

      if (!session) {
        try {
          session = await this.sessionManager.createSession(from);
          logger.info(`Yeni oturum oluşturuldu: ${from}`);
        } catch (error) {
          await this.replyToMessage(
            message,
            `Şu an çok yoğunum, biraz sonra tekrar yaz.\n(${error.message})`
          );
          return;
        }
      }

      let images = [];
      let mediaFilePath = null;

      if (hasMedia) {
        const maxMediaMb = parseInt(process.env.MAX_MEDIA_MB || '8', 10);
        const maxBytes = Math.max(1, maxMediaMb) * 1024 * 1024;

        try {
          const media = await message.downloadMedia();
          const mimetype = media?.mimetype || '';
          const data = media?.data || '';

          if (!data) {
            await this.replyToMessage(message, 'Dosyayı indiremedim, bir daha dener misin?');
            return;
          }

          const buffer = Buffer.from(data, 'base64');
          if (buffer.byteLength > maxBytes) {
            await this.replyToMessage(
              message,
              `Dosya çok büyük (${Math.ceil(buffer.byteLength / 1024 / 1024)}MB). ` +
                `En fazla ${maxMediaMb}MB gönderebilir misin?`
            );
            return;
          }

          const ext = this.mimeToExt(mimetype);
          const dir = path.join(paths.dataDir, 'incoming-media', this.sanitizePathPart(from));
          await fs.promises.mkdir(dir, { recursive: true });
          mediaFilePath = path.join(
            dir,
            `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
          );
          await fs.promises.writeFile(mediaFilePath, buffer);
          images = [mediaFilePath];
        } catch (e) {
          logger.error('Media indirme/kaydetme hatası:', e);
          await this.replyToMessage(message, 'Fotoğrafı alamadım, bir daha yollar mısın?');
          return;
        }
      }

      const prompt =
        hasMedia && (!body || body.trim() === '')
          ? 'Kullanıcı bir görsel gönderdi (açıklama yok). Görseli analiz et ve kısa bir cevap ver; gerekiyorsa 1-2 net soru sor.'
          : body;

      let response;
      try {
        response = await session.execute(prompt, { images });
      } finally {
        if (mediaFilePath) {
          try {
            await fs.promises.unlink(mediaFilePath);
          } catch {
            // ignore
          }
        }
      }

      if (response) {
        if (response.length > 4000) {
          const chunks = this.splitMessage(response, 4000);
          for (let i = 0; i < chunks.length; i++) {
            await this.replyToMessage(message, chunks[i]);
            if (i < chunks.length - 1) {
              await this.sleep(500);
            }
          }
        } else {
          await this.replyToMessage(message, response);
        }

        this.db.logMessage(from, response, 'outgoing');
      }
    } catch (error) {
      logger.error('Mesaj işleme hatası:', error);
      try {
        await this.replyToMessage(
          message,
          `Bir hata oluştu: ${error.message}\nTekrar dener misin?`
        );
      } catch (sendError) {
        logger.error('Hata mesajı gönderilemedi:', sendError.message);
      }
    } finally {
      this.processingQueue.set(from, false);
    }
  }

  async replyToMessage(originalMessage, text) {
    const chatId = originalMessage.from;

    const page = this.wa?.client?.pupPage;
    if (!page) {
      throw new Error('WhatsApp sayfası hazır değil');
    }

    const result = await page.evaluate(
      async (chatId, text) => {
        try {
          const WWebJS = window.WWebJS;
          if (!WWebJS?.getChat || !WWebJS?.sendMessage) {
            return { success: false, error: 'WWebJS hazır değil' };
          }

          const chat = await WWebJS.getChat(chatId, { getAsModel: false });
          if (!chat) {
            return { success: false, error: 'Chat bulunamadı' };
          }

          await WWebJS.sendMessage(chat, text, {});
          return { success: true };
        } catch (e) {
          return { success: false, error: e?.message || String(e) };
        }
      },
      chatId,
      text
    );

    if (!result?.success) {
      throw new Error(result?.error || 'Mesaj gönderilemedi');
    }

    logger.info(`Mesaj gönderildi -> ${chatId}`);
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
