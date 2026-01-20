import fs from 'fs';
import path from 'path';
import logger from '../logger.js';
import { paths } from '../paths.js';

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

    if (message.fromMe) return;
    if (!body || body.trim() === '') return;

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

    logger.info(`Mesaj alındı [${from}]: ${body.substring(0, 100)}`);

    this.db.logMessage(from, body, 'incoming');

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

      const response = await session.execute(body);

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
