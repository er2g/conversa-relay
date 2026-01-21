import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import logger from '../logger.js';

import { paths } from '../paths.js';

const DB_PATH = process.env.DB_PATH || path.join(paths.dataDir, 'database.sqlite');

class DB {
  constructor() {
    this.db = null;
  }

  initialize() {
    logger.info('Veritabanı başlatılıyor...');

    fs.mkdirSync(paths.dataDir, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');

    this.runMigrations();
    logger.info('Veritabanı hazır');
  }

  runMigrations() {
    // Migrations tablosu
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrations = [
      {
        name: '001_initial',
        sql: `
          -- Mesaj geçmişi
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_number TEXT NOT NULL,
            message TEXT NOT NULL,
            direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone_number);
          CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

          -- Oturum geçmişi
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            phone_number TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number);
          CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

          -- Komut geçmişi
          CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            command TEXT NOT NULL,
            result TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
          );

          CREATE INDEX IF NOT EXISTS idx_commands_session ON commands(session_id);

          -- Sistem metrikleri
          CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            metric_value REAL NOT NULL,
            recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
          CREATE INDEX IF NOT EXISTS idx_metrics_recorded ON metrics(recorded_at);
        `
      },
      {
        name: '002_incoming_media',
        sql: `
          CREATE TABLE IF NOT EXISTS incoming_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            message_id TEXT,
            media_type TEXT NOT NULL CHECK(media_type IN ('document', 'audio', 'video', 'other')),
            mimetype TEXT,
            size_bytes INTEGER NOT NULL,
            original_name TEXT,
            stored_rel_path TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            created_at DATETIME NOT NULL,
            stored_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_incoming_media_chat ON incoming_media(chat_id);
          CREATE INDEX IF NOT EXISTS idx_incoming_media_type ON incoming_media(media_type);
          CREATE INDEX IF NOT EXISTS idx_incoming_media_created ON incoming_media(created_at);
        `
      },
      {
        name: '003_last_saved_files',
        sql: `
          CREATE TABLE IF NOT EXISTS last_saved_files (
            chat_id TEXT PRIMARY KEY,
            message_id TEXT,
            mimetype TEXT,
            size_bytes INTEGER NOT NULL,
            absolute_path TEXT NOT NULL,
            created_at DATETIME NOT NULL,
            saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_last_saved_files_created ON last_saved_files(created_at);
        `
      }
    ];

    const applied = this.db.prepare('SELECT name FROM migrations').all().map(r => r.name);

    for (const migration of migrations) {
      if (!applied.includes(migration.name)) {
        logger.info(`Migration uygulanıyor: ${migration.name}`);
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
      }
    }
  }

  // Mesaj işlemleri
  logMessage(phoneNumber, message, direction) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (phone_number, message, direction)
      VALUES (?, ?, ?)
    `);
    return stmt.run(phoneNumber, message, direction);
  }

  getMessages(phoneNumber, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE phone_number = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(phoneNumber, limit);
  }

  getRecentMessages(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  // Oturum işlemleri
  createSession(id, phoneNumber) {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, phone_number, status)
      VALUES (?, ?, 'active')
    `);
    return stmt.run(id, phoneNumber);
  }

  updateSessionActivity(id) {
    const stmt = this.db.prepare(`
      UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?
    `);
    return stmt.run(id);
  }

  endSession(id) {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'ended', ended_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    return stmt.run(id);
  }

  getActiveSessions() {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE status = 'active'
    `);
    return stmt.all();
  }

  getSessionHistory(phoneNumber, limit = 10) {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE phone_number = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(phoneNumber, limit);
  }

  // Komut işlemleri
  logCommand(sessionId, command) {
    const stmt = this.db.prepare(`
      INSERT INTO commands (session_id, command, status)
      VALUES (?, ?, 'pending')
    `);
    return stmt.run(sessionId, command);
  }

  updateCommandResult(commandId, result, status) {
    const stmt = this.db.prepare(`
      UPDATE commands
      SET result = ?, status = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    return stmt.run(result, status, commandId);
  }

  getSessionCommands(sessionId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM commands
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(sessionId, limit);
  }

  // Metrik işlemleri
  recordMetric(name, value) {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (metric_name, metric_value)
      VALUES (?, ?)
    `);
    return stmt.run(name, value);
  }

  getMetrics(name, hours = 24) {
    const stmt = this.db.prepare(`
      SELECT * FROM metrics
      WHERE metric_name = ?
      AND recorded_at > datetime('now', '-' || ? || ' hours')
      ORDER BY recorded_at ASC
    `);
    return stmt.all(name, hours);
  }

  // Incoming media
  addIncomingMedia({
    chatId,
    messageId = null,
    mediaType,
    mimetype = null,
    sizeBytes,
    originalName = null,
    storedRelPath,
    storedFilename,
    createdAt
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO incoming_media (
        chat_id,
        message_id,
        media_type,
        mimetype,
        size_bytes,
        original_name,
        stored_rel_path,
        stored_filename,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return stmt.run(
      chatId,
      messageId,
      mediaType,
      mimetype,
      sizeBytes,
      originalName,
      storedRelPath,
      storedFilename,
      createdAt
    );
  }

  getIncomingMediaById(id) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM incoming_media
      WHERE id = ?
    `);
    return stmt.get(id) || null;
  }

  listIncomingMedia({ limit = 50, mediaType = null } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));

    if (mediaType && mediaType !== 'all') {
      const stmt = this.db.prepare(`
        SELECT *
        FROM incoming_media
        WHERE media_type = ?
        ORDER BY id DESC
        LIMIT ?
      `);
      return stmt.all(mediaType, safeLimit);
    }

    const stmt = this.db.prepare(`
      SELECT *
      FROM incoming_media
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(safeLimit);
  }

  // Last saved file per chat
  setLastSavedFile({ chatId, messageId = null, mimetype = null, sizeBytes, absolutePath, createdAt }) {
    const stmt = this.db.prepare(`
      INSERT INTO last_saved_files (
        chat_id,
        message_id,
        mimetype,
        size_bytes,
        absolute_path,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        message_id = excluded.message_id,
        mimetype = excluded.mimetype,
        size_bytes = excluded.size_bytes,
        absolute_path = excluded.absolute_path,
        created_at = excluded.created_at,
        saved_at = CURRENT_TIMESTAMP
    `);

    return stmt.run(chatId, messageId, mimetype, sizeBytes, absolutePath, createdAt);
  }

  getLastSavedFile(chatId) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM last_saved_files
      WHERE chat_id = ?
    `);
    return stmt.get(chatId) || null;
  }

  // İstatistikler
  getStats() {
    const totalMessages = this.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
    const todayMessages = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE date(created_at) = date('now')
    `).get().count;
    const totalSessions = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    const activeSessions = this.db.prepare(`
      SELECT COUNT(*) as count FROM sessions WHERE status = 'active'
    `).get().count;

    return {
      totalMessages,
      todayMessages,
      totalSessions,
      activeSessions
    };
  }

  // Temizlik
  cleanup(daysToKeep = 30) {
    const stmt = this.db.prepare(`
      DELETE FROM messages
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(daysToKeep);
    logger.info(`${result.changes} eski mesaj silindi`);
    return result.changes;
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

export default DB;
