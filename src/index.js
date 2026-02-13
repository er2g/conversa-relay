import WhatsAppClient from './whatsapp/client.js';
import MessageHandler from './whatsapp/handlers.js';
import SessionManager from './claude/session-manager.js';
import DB from './db/database.js';
import APIServer from './api/server.js';
import logger from './logger.js';
import fs from 'fs';
import path from 'path';
import { paths } from './paths.js';
import { taskManager } from './background/task-manager.js';
import OutboxDispatcher from './outbox/dispatcher.js';
import { ensureOutboxDirs, getOutboxPaths } from './outbox/common.js';

const API_PORT = process.env.API_PORT || 3000;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 3;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 30;
const MAINTENANCE_LOCK = path.join(paths.dataDir, 'maintenance.lock');

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
    this.outboxDispatcher = null;
    this.isShuttingDown = false;
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('WhatsApp AI Bridge Sistemi Başlatılıyor...');
    logger.info('='.repeat(50));

    try {
      await this.waitForMaintenanceClear();

      // Veritabanı başlat
      logger.info('Veritabanı başlatılıyor...');
      this.db = new DB();
      this.db.initialize();

      // Arka plan görev yöneticisi
      logger.info('Arka plan görev yöneticisi başlatılıyor...');
      await taskManager.loadTasks();
      await taskManager.cleanOldTasks();

      // Session manager
      logger.info('Oturum yöneticisi başlatılıyor...');
      this.sessionManager = new SessionManager(this.db, MAX_SESSIONS, SESSION_TIMEOUT);

      const outboxPaths = getOutboxPaths();
      await ensureOutboxDirs(outboxPaths);

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

      this.outboxDispatcher = new OutboxDispatcher({
        outboxPaths,
        sendMessage: async (chatId, text) => {
          await this.messageHandler.sendTextToChat(chatId, text);
        },
        onDelivered: async (payload) => {
          this.db.logMessage(payload.chatId, payload.text, 'outgoing');
          this.apiServer.broadcastMessage(payload.chatId, payload.text, 'outgoing');
        },
        onFailed: async (failed) => {
          logger.error(
            `Outbox mesaji gonderilemedi [${failed.reason}]: ${failed.error}`
          );
        }
      });
      await this.outboxDispatcher.start();

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

  async waitForMaintenanceClear() {
    if (!fs.existsSync(MAINTENANCE_LOCK)) return;

    logger.warn(`Maintenance modu aktif: ${MAINTENANCE_LOCK}`);
    logger.warn('Lock kaldırılana kadar başlatma beklemede.');

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!fs.existsSync(MAINTENANCE_LOCK)) {
          clearInterval(interval);
          logger.info('Maintenance lock kaldırıldı, başlatma devam ediyor...');
          resolve();
        }
      }, 3000);
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

      if (this.outboxDispatcher) {
        await this.outboxDispatcher.stop();
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
