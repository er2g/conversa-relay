import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import logger from '../logger.js';
import { paths } from '../paths.js';

class APIServer {
  constructor(port, waClient, sessionManager, db) {
    this.port = port;
    this.waClient = waClient;
    this.sessionManager = sessionManager;
    this.db = db;

    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.clients = new Set();
    this._broadcastInterval = null;

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupMiddleware() {
    // Basic Auth
    const authUser = process.env.DASHBOARD_USER || 'admin';
    const authPass = process.env.DASHBOARD_PASS || 'claude2024';

    this.app.use((req, res, next) => {
      // Health check bypass
      if (req.path === '/health') {
        return next();
      }

      const auth = req.headers.authorization;

      if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp Codex Dashboard"');
        return res.status(401).send('Authentication required');
      }

      const credentials = Buffer.from(auth.slice(6), 'base64').toString();
      const [user, pass] = credentials.split(':');

      if (user !== authUser || pass !== authPass) {
        return res.status(401).send('Invalid credentials');
      }

      next();
    });

    this.app.use(express.json());
    this.app.use(express.static(paths.publicDir));
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        whatsapp: this.waClient.getStatus(),
        sessions: this.sessionManager.getStats(),
        uptime: process.uptime()
      });
    });

    // WhatsApp durumu
    this.app.get('/api/whatsapp/status', (req, res) => {
      res.json(this.waClient.getStatus());
    });

    // QR kod (JSON)
    this.app.get('/api/whatsapp/qr', (req, res) => {
      const qr = this.waClient.getQRCode();
      if (qr) {
        res.json({ qr });
      } else {
        res.status(404).json({ error: 'QR kod mevcut değil' });
      }
    });

    // WhatsApp oturumunu sıfırla (logout)
    this.app.post('/api/whatsapp/logout', async (req, res) => {
      try {
        logger.info('WhatsApp oturumu sıfırlanıyor...');
        await this.waClient.logout();
        res.json({ success: true, message: 'Oturum sıfırlandı, yeni QR kod bekleniyor' });
      } catch (error) {
        logger.error('Logout hatası:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // QR kod (resim olarak)
    this.app.get('/api/whatsapp/qr.png', async (req, res) => {
      const qr = this.waClient.getQRCode();
      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
          const base64Data = qrImage.replace(/^data:image\/png;base64,/, '');
          const imgBuffer = Buffer.from(base64Data, 'base64');
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'no-store');
          res.send(imgBuffer);
        } catch (error) {
          res.status(500).json({ error: 'QR oluşturulamadı' });
        }
      } else {
        res.status(404).json({ error: 'QR kod mevcut değil' });
      }
    });

    // Oturumlar
    this.app.get('/api/sessions', (req, res) => {
      res.json({
        sessions: this.sessionManager.getAllSessions(),
        stats: this.sessionManager.getStats()
      });
    });

    // Oturum detayı
    this.app.get('/api/sessions/:phone', (req, res) => {
      const session = this.sessionManager.getSession(req.params.phone);
      if (session) {
        res.json(session.getStatus());
      } else {
        res.status(404).json({ error: 'Oturum bulunamadı' });
      }
    });

    // Oturum sonlandır
    this.app.delete('/api/sessions/:phone', async (req, res) => {
      try {
        await this.sessionManager.endSession(req.params.phone);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Tüm oturumları sonlandır
    this.app.delete('/api/sessions', async (req, res) => {
      try {
        await this.sessionManager.killAllSessions();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Mesaj geçmişi
    this.app.get('/api/messages', (req, res) => {
      const limit = parseInt(req.query.limit) || 100;
      res.json(this.db.getRecentMessages(limit));
    });

    // Belirli numara için mesajlar
    this.app.get('/api/messages/:phone', (req, res) => {
      const limit = parseInt(req.query.limit) || 50;
      res.json(this.db.getMessages(req.params.phone, limit));
    });

    // İstatistikler
    this.app.get('/api/stats', (req, res) => {
      const dbStats = this.db.getStats();
      const sessionStats = this.sessionManager.getStats();
      const memUsage = process.memoryUsage();

      res.json({
        database: dbStats,
        sessions: sessionStats,
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024)
        },
        uptime: process.uptime()
      });
    });

    // Log dosyasını oku
    this.app.get('/api/logs', (req, res) => {
      const logFile = path.join(paths.logDir, 'combined.log');
      const lines = parseInt(req.query.lines) || 100;

      try {
        if (fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf8');
          const logLines = content.split('\n').slice(-lines);
          res.json({ logs: logLines });
        } else {
          res.json({ logs: [] });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Config reload
    this.app.post('/api/config/reload', (req, res) => {
      try {
        // Config yeniden yüklenebilir olmalı
        res.json({ success: true, message: 'Config reloaded' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Dashboard ana sayfa
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(paths.publicDir, 'index.html'));
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      logger.info('Yeni WebSocket bağlantısı');
      this.clients.add(ws);

      // İlk bağlantıda mevcut durumu gönder
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          whatsapp: this.waClient.getStatus(),
          sessions: this.sessionManager.getAllSessions(),
          stats: this.db.getStats()
        }
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('WebSocket bağlantısı kapandı');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket hatası:', error);
        this.clients.delete(ws);
      });
    });

    // Periyodik güncelleme gönder
    this._broadcastInterval = setInterval(() => {
      this.broadcast({
        type: 'update',
        data: {
          whatsapp: this.waClient.getStatus(),
          sessions: this.sessionManager.getAllSessions(),
          stats: this.db.getStats()
        }
      });
    }, 5000);
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }

  broadcastMessage(phoneNumber, message, direction) {
    this.broadcast({
      type: 'message',
      data: {
        phoneNumber,
        message,
        direction,
        timestamp: new Date().toISOString()
      }
    });
  }

  broadcastSessionUpdate(session, action) {
    this.broadcast({
      type: 'session_update',
      data: {
        action, // 'created', 'ended', 'updated'
        session: session ? session.getStatus() : null
      }
    });
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        logger.info(`API server ${this.port} portunda çalışıyor`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this._broadcastInterval) {
        clearInterval(this._broadcastInterval);
        this._broadcastInterval = null;
      }
      this.wss.close();
      this.server.close(() => {
        logger.info('API server kapatıldı');
        resolve();
      });
    });
  }
}

export default APIServer;
