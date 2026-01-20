import WhatsAppClient from './whatsapp/client.js';
import MessageHandler from './whatsapp/handlers.js';
import SessionManager from './claude/session-manager.js';
import DB from './db/database.js';
import APIServer from './api/server.js';
import logger from './logger.js';
import fs from 'fs';
import path from 'path';
import { paths } from './paths.js';

const API_PORT = process.env.API_PORT || 3000;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 3;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 30;

// Conversations dizinini oluştur
const conversationsDir = path.join(paths.dataDir, 'conversations');
if (!fs.existsSync(conversationsDir)) {
  fs.mkdirSync(conversationsDir, { recursive: true });
}

class WhatsAppCodexApp {
  constructor() {
    this.db = null;
    this.waClient = null;
    this.sessionManager = null;
    this.messageHandler = null;
    this.apiServer = null;
    this.isShuttingDown = false;
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('WhatsApp Codex Sistemi Başlatılıyor...');
    logger.info('='.repeat(50));

    try {
      // Veritabanı başlat
      logger.info('Veritabanı başlatılıyor...');
      this.db = new DB();
      this.db.initialize();

      // Session manager
      logger.info('Oturum yöneticisi başlatılıyor...');
      this.sessionManager = new SessionManager(this.db, MAX_SESSIONS, SESSION_TIMEOUT);

      // WhatsApp client
      logger.info('WhatsApp client başlatılıyor...');
      this.waClient = new WhatsAppClient();

      // Message handler (artık intent detector yok - her şey Codex'e gidiyor)
      this.messageHandler = new MessageHandler(
        this.waClient,
        this.sessionManager,
        null, // intentDetector artık kullanılmıyor
        this.db
      );

      // API server
      logger.info('API server başlatılıyor...');
      this.apiServer = new APIServer(
        API_PORT,
        this.waClient,
        this.sessionManager,
        this.db
      );

      // Event handlers
      this.setupEventHandlers();

      // Servisleri başlat
      await this.apiServer.start();
      await this.waClient.initialize();

      logger.info('='.repeat(50));
      logger.info('Sistem hazır!');
      logger.info(`Dashboard: https://rammfire.com/claude`);
      logger.info('='.repeat(50));

    } catch (error) {
      logger.error('Başlatma hatası:', error);
      await this.shutdown();
      process.exit(1);
    }
  }

  setupEventHandlers() {
    // WhatsApp mesaj geldiğinde
    this.waClient.on('message', async (message) => {
      try {
        await this.messageHandler.handleMessage(message);
        // Dashboard'a bildir
        this.apiServer.broadcastMessage(
          message.from,
          message.body,
          'incoming'
        );
      } catch (error) {
        logger.error('Mesaj işleme hatası:', error);
      }
    });

    // WhatsApp bağlantı durumu
    this.waClient.on('ready', () => {
      logger.info('WhatsApp hazır, mesaj bekleniyor...');
    });

    this.waClient.on('disconnected', (reason) => {
      logger.warn('WhatsApp bağlantısı kesildi:', reason);
    });

    // Process signals
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    process.on('uncaughtException', (error) => {
      logger.error('Yakalanmamış hata:', error);
      this.shutdown();
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('İşlenmeyen promise reddi:', reason);
    });
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Sistem kapatılıyor...');

    try {
      if (this.sessionManager) {
        this.sessionManager.destroy();
      }

      if (this.apiServer) {
        await this.apiServer.stop();
      }

      if (this.waClient) {
        await this.waClient.destroy();
      }

      if (this.db) {
        this.db.close();
      }

      logger.info('Sistem düzgün şekilde kapatıldı');
      process.exit(0);
    } catch (error) {
      logger.error('Kapatma hatası:', error);
      process.exit(1);
    }
  }
}

// Uygulamayı başlat
const app = new WhatsAppCodexApp();
app.start().catch((error) => {
  logger.error('Uygulama başlatılamadı:', error);
  process.exit(1);
});
