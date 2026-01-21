import { v4 as uuidv4 } from 'uuid';
import CodexProcess from './process-wrapper.js';
import logger from '../logger.js';
import { maskPhoneLike } from '../utils/redact.js';

class SessionManager {
  constructor(db, maxSessions = 3, timeoutMinutes = 30) {
    this.sessions = new Map(); // phoneNumber -> CodexProcess
    this.db = db;
    this.maxSessions = maxSessions;
    this.timeoutMinutes = timeoutMinutes;

    // Periyodik timeout kontrolü
    this.cleanupInterval = setInterval(() => {
      this.cleanupTimedOutSessions();
    }, 60000);
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
    const session = new CodexProcess(sessionId, phoneNumber);

    session.on('output', (data) => {
      logger.debug(`[${sessionId}] Output: ${data.substring(0, 100)}...`);
    });

    session.on('killed', () => {
      logger.info(`Oturum sonlandırıldı: ${sessionId}`);
    });

    this.sessions.set(phoneNumber, session);

    this.db.createSession(sessionId, phoneNumber);

    logger.info(`Yeni oturum oluşturuldu: ${sessionId} için ${maskPhoneLike(phoneNumber)}`);

    return session;
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
