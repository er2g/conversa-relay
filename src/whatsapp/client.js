import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import logger from '../logger.js';
import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import { paths } from '../paths.js';

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.connectionState = 'disconnected';
  }

  async initialize() {
    logger.info('WhatsApp client başlatılıyor...');

    fs.mkdirSync(paths.dataDir, { recursive: true });
    const sessionDir = process.env.WHATSAPP_SESSION_DIR || path.join(paths.dataDir, 'whatsapp-session');
    const chromiumPath = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: sessionDir
      }),
      puppeteer: {
        headless: true,
        protocolTimeout: parseInt(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || '600000', 10),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        executablePath: chromiumPath
      }
    });

    this.setupEventListeners();

    try {
      await this.client.initialize();
    } catch (error) {
      logger.error('WhatsApp başlatma hatası:', error);
      throw error;
    }
  }

  setupEventListeners() {
    this.client.on('qr', (qr) => {
      this.qrCode = qr;
      this.connectionState = 'waiting_qr';
      logger.info('QR kod oluşturuldu, taratın:');
      qrcode.generate(qr, { small: true });
      this.emit('qr', qr);
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.connectionState = 'connected';
      this.qrCode = null;
      logger.info('WhatsApp bağlantısı hazır!');
      this.emit('ready');
    });

    this.client.on('authenticated', () => {
      logger.info('WhatsApp kimlik doğrulaması başarılı');
      this.connectionState = 'authenticated';
      this.emit('authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      logger.error('WhatsApp kimlik doğrulama hatası:', msg);
      this.connectionState = 'auth_failed';
      this.emit('auth_failure', msg);
    });

    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      this.connectionState = 'disconnected';
      logger.warn('WhatsApp bağlantısı kesildi:', reason);
      this.emit('disconnected', reason);

      // Otomatik yeniden bağlanma
      setTimeout(() => {
        logger.info('Yeniden bağlanmaya çalışılıyor...');
        this.initialize().catch(err => {
          logger.error('Yeniden bağlanma hatası:', err);
        });
      }, 5000);
    });

    this.client.on('message', (message) => {
      this.emit('message', message);
    });

    this.client.on('message_create', (message) => {
      if (message.fromMe) {
        this.emit('message_sent', message);
      }
    });
  }

  async sendMessage(chatId, message) {
    if (!this.isReady) {
      throw new Error('WhatsApp bağlantısı hazır değil');
    }

    try {
      const result = await this.client.sendMessage(chatId, message);
      logger.info(`Mesaj gönderildi: ${chatId}`);
      return result;
    } catch (error) {
      logger.error('Mesaj gönderme hatası:', error);
      throw error;
    }
  }

  async sendMediaMessage(chatId, filePath, caption = '') {
    if (!this.isReady) {
      throw new Error('WhatsApp bağlantısı hazır değil');
    }

    try {
      const media = MessageMedia.fromFilePath(filePath);
      const options = caption ? { caption } : {};
      const result = await this.client.sendMessage(chatId, media, options);
      logger.info(`Medya gönderildi: ${chatId} - ${filePath}`);
      return result;
    } catch (error) {
      logger.error('Medya gönderme hatası:', error);
      throw error;
    }
  }

  async getChats() {
    if (!this.isReady) return [];
    return await this.client.getChats();
  }

  getStatus() {
    return {
      isReady: this.isReady,
      connectionState: this.connectionState,
      hasQR: !!this.qrCode
    };
  }

  getQRCode() {
    return this.qrCode;
  }

  async logout() {
    logger.info('WhatsApp oturumu kapatılıyor...');

    try {
      // Önce client'ı logout yap
      if (this.client) {
        try {
          await this.client.logout();
        } catch (e) {
          logger.warn('Logout hatası (devam ediliyor):', e.message);
        }
        await this.client.destroy();
      }

      // Session dosyalarını sil
      const sessionPath = process.env.WHATSAPP_SESSION_DIR || path.join(paths.dataDir, 'whatsapp-session');
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        logger.info('Session dosyaları silindi');
      }

      // State'i sıfırla
      this.isReady = false;
      this.qrCode = null;
      this.connectionState = 'disconnected';
      this.client = null;

      // Yeniden başlat
      logger.info('WhatsApp yeniden başlatılıyor...');
      await this.initialize();

    } catch (error) {
      logger.error('Logout hatası:', error);
      throw error;
    }
  }

  async destroy() {
    if (this.client) {
      await this.client.destroy();
      this.isReady = false;
      this.connectionState = 'destroyed';
    }
  }
}

export default WhatsAppClient;
