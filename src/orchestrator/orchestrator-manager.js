import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { paths } from '../paths.js';

/**
 * Merkezi Orkestratör Yönetimi
 *
 * Tüm AI orkestratör (claude, codex, gemini) yönetimini tek bir yerde toplar.
 * Kullanıcı tercihlerini kalıcı olarak saklar.
 */
class OrchestratorManager {
  constructor() {
    // Desteklenen orkestratörler ve meta bilgileri
    this.orchestrators = new Map([
      ['claude', {
        name: 'Claude',
        description: 'Anthropic Claude - Genel amaçlı AI',
        aliases: ['anthropic', 'sonnet', 'opus', 'haiku'],
        envModel: 'CLAUDE_MODEL',
        envTimeout: 'CLAUDE_TIMEOUT_MS',
        defaultTimeout: 300000
      }],
      ['codex', {
        name: 'Codex',
        description: 'OpenAI Codex/GPT - Kod ve genel amaçlı',
        aliases: ['openai', 'gpt', 'gpt4', 'gpt5'],
        envModel: 'CODEX_MODEL',
        envTimeout: 'CODEX_TIMEOUT_MS',
        defaultTimeout: 600000
      }],
      ['gemini', {
        name: 'Gemini',
        description: 'Google Gemini - Multimodal AI',
        aliases: ['google', 'bard'],
        envModel: 'GEMINI_MODEL',
        envTimeout: 'GEMINI_TIMEOUT_MS',
        defaultTimeout: 600000
      }]
    ]);

    // Varsayılan orkestratör
    this.defaultOrchestrator = this.normalizeType(process.env.ORCHESTRATOR_TYPE) || 'claude';

    // Kullanıcı tercihleri (memory cache)
    this.userPreferences = new Map();

    // Tercih dosyası yolu
    this.preferencesPath = path.join(paths.dataDir, 'orchestrator-preferences.json');

    // Switch geçmişi (son 10 switch per user)
    this.switchHistory = new Map();

    // Initialization
    this.initialized = false;
    this.initPromise = this.init();
  }

  async init() {
    if (this.initialized) return;

    try {
      await fs.mkdir(path.dirname(this.preferencesPath), { recursive: true });
      await this.loadPreferences();
      this.initialized = true;
      logger.info(`OrchestratorManager başlatıldı. Varsayılan: ${this.defaultOrchestrator}`);
    } catch (err) {
      logger.warn('OrchestratorManager init hatası:', err.message);
      this.initialized = true;
    }
  }

  async ensureInitialized() {
    if (!this.initialized) {
      await this.initPromise;
    }
  }

  /**
   * Tercihleri dosyadan yükle
   */
  async loadPreferences() {
    try {
      const data = await fs.readFile(this.preferencesPath, 'utf8');
      const parsed = JSON.parse(data);

      if (parsed && typeof parsed === 'object') {
        for (const [phone, pref] of Object.entries(parsed)) {
          if (pref && typeof pref === 'object') {
            this.userPreferences.set(phone, {
              orchestrator: this.normalizeType(pref.orchestrator) || this.defaultOrchestrator,
              updatedAt: pref.updatedAt || new Date().toISOString(),
              switchCount: pref.switchCount || 0
            });
          }
        }
      }

      logger.info(`${this.userPreferences.size} kullanıcı tercihi yüklendi`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Tercih dosyası okunamadı:', err.message);
      }
    }
  }

  /**
   * Tercihleri dosyaya kaydet
   */
  async savePreferences() {
    try {
      const data = {};
      for (const [phone, pref] of this.userPreferences) {
        data[phone] = pref;
      }

      await fs.writeFile(
        this.preferencesPath,
        JSON.stringify(data, null, 2) + '\n',
        'utf8'
      );
    } catch (err) {
      logger.error('Tercihler kaydedilemedi:', err.message);
    }
  }

  /**
   * Orkestratör tipini normalize et
   */
  normalizeType(input) {
    if (!input) return null;

    const normalized = String(input).toLowerCase().trim();

    // Direkt eşleşme
    if (this.orchestrators.has(normalized)) {
      return normalized;
    }

    // Alias kontrolü
    for (const [type, meta] of this.orchestrators) {
      if (meta.aliases.includes(normalized)) {
        return type;
      }
    }

    return null;
  }

  /**
   * Desteklenen orkestratör listesi
   */
  getAvailableOrchestrators() {
    return Array.from(this.orchestrators.keys());
  }

  /**
   * Orkestratör detaylarını al
   */
  getOrchestratorInfo(type) {
    return this.orchestrators.get(this.normalizeType(type)) || null;
  }

  /**
   * Kullanıcının aktif orkestratörünü al
   */
  async getOrchestrator(phoneNumber) {
    await this.ensureInitialized();

    const pref = this.userPreferences.get(phoneNumber);
    if (pref && pref.orchestrator) {
      return pref.orchestrator;
    }

    return this.defaultOrchestrator;
  }

  /**
   * Kullanıcı tercihini ayarla
   */
  async setOrchestrator(phoneNumber, type) {
    await this.ensureInitialized();

    const normalized = this.normalizeType(type);
    if (!normalized) {
      return { success: false, error: 'Geçersiz orkestratör tipi' };
    }

    const current = await this.getOrchestrator(phoneNumber);
    const pref = this.userPreferences.get(phoneNumber) || {
      orchestrator: this.defaultOrchestrator,
      switchCount: 0
    };

    const oldOrchestrator = pref.orchestrator || current;

    pref.orchestrator = normalized;
    pref.updatedAt = new Date().toISOString();
    pref.switchCount = (pref.switchCount || 0) + 1;

    this.userPreferences.set(phoneNumber, pref);

    // Switch geçmişini güncelle
    this.addToHistory(phoneNumber, oldOrchestrator, normalized);

    // Async kaydet (bloklamadan)
    this.savePreferences().catch(err => {
      logger.warn('Tercih kaydetme hatası:', err.message);
    });

    return {
      success: true,
      from: oldOrchestrator,
      to: normalized,
      switchCount: pref.switchCount
    };
  }

  /**
   * Kullanıcı tercihini sıfırla (varsayılana dön)
   */
  async resetToDefault(phoneNumber) {
    await this.ensureInitialized();

    const current = await this.getOrchestrator(phoneNumber);

    if (this.userPreferences.has(phoneNumber)) {
      this.userPreferences.delete(phoneNumber);

      this.savePreferences().catch(err => {
        logger.warn('Tercih kaydetme hatası:', err.message);
      });
    }

    return {
      success: true,
      from: current,
      to: this.defaultOrchestrator
    };
  }

  /**
   * Bir sonraki orkestratöre geç (cycle)
   */
  async cycleToNext(phoneNumber) {
    await this.ensureInitialized();

    const current = await this.getOrchestrator(phoneNumber);
    const available = this.getAvailableOrchestrators();
    const currentIndex = available.indexOf(current);
    const nextIndex = (currentIndex + 1) % available.length;
    const next = available[nextIndex];

    return this.setOrchestrator(phoneNumber, next);
  }

  /**
   * Switch geçmişine ekle
   */
  addToHistory(phoneNumber, from, to) {
    if (!this.switchHistory.has(phoneNumber)) {
      this.switchHistory.set(phoneNumber, []);
    }

    const history = this.switchHistory.get(phoneNumber);
    history.push({
      from,
      to,
      timestamp: new Date().toISOString()
    });

    // Son 10 switch'i tut
    if (history.length > 10) {
      history.shift();
    }
  }

  /**
   * Switch geçmişini al
   */
  getHistory(phoneNumber) {
    return this.switchHistory.get(phoneNumber) || [];
  }

  /**
   * Kullanıcı durumunu al (debug/info için)
   */
  async getUserStatus(phoneNumber) {
    await this.ensureInitialized();

    const current = await this.getOrchestrator(phoneNumber);
    const pref = this.userPreferences.get(phoneNumber);
    const history = this.getHistory(phoneNumber);
    const info = this.getOrchestratorInfo(current);

    return {
      current,
      currentName: info?.name || current,
      isDefault: current === this.defaultOrchestrator,
      defaultOrchestrator: this.defaultOrchestrator,
      switchCount: pref?.switchCount || 0,
      lastUpdated: pref?.updatedAt || null,
      recentHistory: history.slice(-3),
      available: this.getAvailableOrchestrators()
    };
  }

  /**
   * Tüm istatistikleri al
   */
  getStats() {
    const stats = {
      totalUsers: this.userPreferences.size,
      defaultOrchestrator: this.defaultOrchestrator,
      orchestratorUsage: {}
    };

    for (const type of this.getAvailableOrchestrators()) {
      stats.orchestratorUsage[type] = 0;
    }

    for (const pref of this.userPreferences.values()) {
      const orch = pref.orchestrator || this.defaultOrchestrator;
      stats.orchestratorUsage[orch] = (stats.orchestratorUsage[orch] || 0) + 1;
    }

    return stats;
  }
}

// Singleton instance
const orchestratorManager = new OrchestratorManager();

export default orchestratorManager;
export { OrchestratorManager };
