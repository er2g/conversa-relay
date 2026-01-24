import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import ClaudeProcess from './claude-process.js';
import CodexProcess from './process-wrapper.js';
import GeminiProcess from '../gemini/gemini-process.js';
import orchestratorManager from '../orchestrator/orchestrator-manager.js';
import logger from '../logger.js';
import { maskPhoneLike } from '../utils/redact.js';
import { paths } from '../paths.js';

class SessionManager {
  constructor(db, maxSessions = 3, timeoutMinutes = 30) {
    this.sessions = new Map(); // phoneNumber -> ClaudeProcess | CodexProcess | GeminiProcess
    this.db = db;
    this.maxSessions = maxSessions;
    this.timeoutMinutes = timeoutMinutes;

    // Periyodik timeout kontrolü
    this.cleanupInterval = setInterval(() => {
      this.cleanupTimedOutSessions();
    }, 60000);

    const defaultOrch = orchestratorManager.defaultOrchestrator;
    logger.info(`Session Manager başlatıldı - Varsayılan Orkestratör: ${defaultOrch.toUpperCase()}`);
  }

  async createSession(phoneNumber) {
    if (this.sessions.has(phoneNumber)) {
      throw new Error('Bu numara için zaten bir oturum var');
    }

    if (this.sessions.size >= this.maxSessions) {
      const oldestIdle = this.findOldestIdleSession();
      if (oldestIdle) {
        logger.info(`Kapasite dolduğu için eski oturum kapatılıyor: ${oldestIdle.id}`);
        await this.endSession(oldestIdle.owner);
      } else {
        throw new Error(
          `Maksimum oturum sayısına (${this.maxSessions}) ulaşıldı. Tüm oturumlar aktif.`
        );
      }
    }

    const sessionId = uuidv4().substring(0, 8);

    // OrchestratorManager'dan kullanıcının tercih ettiği orkestratörü al
    const orchestratorType = await orchestratorManager.getOrchestrator(phoneNumber);

    let session;
    if (orchestratorType === 'codex') {
      session = new CodexProcess(sessionId, phoneNumber);
    } else if (orchestratorType === 'gemini') {
      session = new GeminiProcess(sessionId, phoneNumber);
    } else {
      session = new ClaudeProcess(sessionId, phoneNumber);
    }
    session.orchestratorType = orchestratorType;

    session.on('output', (data) => {
      logger.debug(`[${sessionId}] Output: ${data.substring(0, 100)}...`);
    });

    session.on('killed', () => {
      logger.info(`Oturum sonlandırıldı: ${sessionId}`);
    });

    this.sessions.set(phoneNumber, session);

    this.db.createSession(sessionId, phoneNumber);

    logger.info(`Yeni oturum oluşturuldu: ${sessionId} için ${maskPhoneLike(phoneNumber)} (${orchestratorType})`);

    return session;
  }

  // Orkestratör yönetimi artık OrchestratorManager üzerinden yapılıyor
  // Bu metodlar geriye uyumluluk için korunuyor

  getAvailableOrchestrators() {
    return orchestratorManager.getAvailableOrchestrators();
  }

  async getOrchestratorType(phoneNumber) {
    return orchestratorManager.getOrchestrator(phoneNumber);
  }

  async getNextOrchestratorType(phoneNumber) {
    const list = this.getAvailableOrchestrators();
    const current = await this.getOrchestratorType(phoneNumber);
    const idx = list.indexOf(current);
    if (idx === -1) return list[0];
    return list[(idx + 1) % list.length];
  }

  async setOrchestratorOverride(phoneNumber, type) {
    const result = await orchestratorManager.setOrchestrator(phoneNumber, type);
    return result.success;
  }

  async clearOrchestratorOverride(phoneNumber) {
    await orchestratorManager.resetToDefault(phoneNumber);
  }

  get orchestratorType() {
    return orchestratorManager.defaultOrchestrator;
  }

  getClaudeSessionStorePath() {
    return process.env.CLAUDE_SESSION_STORE || path.join(paths.dataDir, 'claude-sessions.json');
  }

  getCodexThreadStorePath() {
    return process.env.CODEX_THREAD_STORE || path.join(paths.dataDir, 'codex-threads.json');
  }

  getGeminiSessionStorePath() {
    return process.env.GEMINI_SESSION_STORE || path.join(paths.dataDir, 'gemini-sessions.json');
  }

  async resetStoredState(phoneNumber, orchestratorType) {
    const type = String(orchestratorType || '').toLowerCase().trim();
    let storePath = null;
    if (type === 'claude') storePath = this.getClaudeSessionStorePath();
    if (type === 'codex') storePath = this.getCodexThreadStorePath();
    if (type === 'gemini') storePath = this.getGeminiSessionStorePath();
    if (!storePath) return false;

    try {
      const raw = await fs.readFile(storePath, 'utf8');
      const data = JSON.parse(raw) || {};
      if (data && Object.prototype.hasOwnProperty.call(data, phoneNumber)) {
        delete data[phoneNumber];
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await fs.writeFile(storePath, JSON.stringify(data, null, 2) + '\n');
        return true;
      }
    } catch {
      // ignore missing/invalid file
    }
    return false;
  }

  getSession(phoneNumber) {
    return this.sessions.get(phoneNumber);
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      owner: s.owner,
      state: s.state,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity
    }));
  }

  findOldestIdleSession() {
    let oldest = null;
    let oldestTime = Date.now();

    for (const session of this.sessions.values()) {
      if (session.isIdle() && session.lastActivity.getTime() < oldestTime) {
        oldest = session;
        oldestTime = session.lastActivity.getTime();
      }
    }

    return oldest;
  }

  async endSession(phoneNumber) {
    const session = this.sessions.get(phoneNumber);

    if (!session) {
      return false;
    }

    session.kill();
    this.sessions.delete(phoneNumber);

    this.db.endSession(session.id);

    logger.info(`Oturum kapatıldı: ${session.id}`);
    return true;
  }

  async killAllSessions() {
    for (const [phoneNumber, session] of this.sessions) {
      session.kill();
      this.db.endSession(session.id);
    }
    this.sessions.clear();
    logger.info('Tüm oturumlar kapatıldı');
  }

  cleanupTimedOutSessions() {
    for (const [phoneNumber, session] of this.sessions) {
      if (session.isTimedOut(this.timeoutMinutes)) {
        logger.info(`Timeout nedeniyle oturum kapatılıyor: ${session.id}`);
        session.kill();
        this.sessions.delete(phoneNumber);
        this.db.endSession(session.id);
      }
    }
  }

  getStats() {
    const sessions = this.getAllSessions();
    const activeSessions = sessions.filter((s) => s.state !== 'idle').length;
    const idleSessions = sessions.filter((s) => s.state === 'idle').length;

    return {
      total: sessions.length,
      active: activeSessions,
      idle: idleSessions,
      maxSessions: this.maxSessions,
      available: this.maxSessions - sessions.length
    };
  }

  updateSessionActivity(phoneNumber) {
    const session = this.sessions.get(phoneNumber);
    if (session) {
      session.lastActivity = new Date();
      this.db.updateSessionActivity(session.id);
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.killAllSessions();
  }
}

export default SessionManager;
