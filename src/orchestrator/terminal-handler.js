import fs from 'fs/promises';
import path from 'path';
import orchestratorManager from './orchestrator-manager.js';
import logger from '../logger.js';
import { paths } from '../paths.js';

/**
 * Terminal Session Yönetimi
 *
 * Tasarım: Komutlar sadece registry'yi günceller. Çalışan session'a dokunmaz.
 * Terminal geçişi "lazy" olarak gerçekleşir: sıradaki mesaj geldiğinde
 * session'ın terminali aktif terminalden farklıysa, session sonlandırılır
 * ve yeni terminalin state'i yüklenir.
 */
class TerminalHandler {
  constructor(sessionManager, options = {}) {
    this.sessionManager = sessionManager;
    this.addSystemNote = options.addSystemNote || (() => {});
    this.registryPath = path.join(paths.dataDir, 'terminal-sessions.json');
    this.registry = {};
    this.loaded = false;
    this._saveTimer = null;

    this.loadRegistry().catch(() => {});
  }

  // --- Komut tespiti ---

  isTerminalCommand(text) {
    const lower = String(text || '').toLowerCase().trim();
    return (
      lower.startsWith('!!new') ||
      lower.startsWith('!!tlist') ||
      lower.startsWith('!!tchange') ||
      lower.startsWith('!!trename') ||
      lower.startsWith('!!tdelete') ||
      lower === '!!help' || lower === '!!yardim' || lower === '!!yardım'
    );
  }

  // --- Ana router ---

  async handle(phoneNumber, text) {
    await this.loadRegistry();

    const trimmed = String(text || '').trim();
    const lower = trimmed.toLowerCase();

    if (lower === '!!help' || lower === '!!yardim' || lower === '!!yardım') {
      return this.handleHelp(phoneNumber);
    }
    if (lower.startsWith('!!new')) {
      return this.handleNew(phoneNumber, trimmed.slice('!!new'.length).trim());
    }
    if (lower === '!!tlist' || lower.startsWith('!!tlist')) {
      return this.handleList(phoneNumber);
    }
    if (lower.startsWith('!!tchange')) {
      return this.handleChange(phoneNumber, trimmed.slice('!!tchange'.length).trim());
    }
    if (lower.startsWith('!!trename')) {
      return this.handleRename(phoneNumber, trimmed.slice('!!trename'.length).trim());
    }
    if (lower.startsWith('!!tdelete')) {
      return this.handleDelete(phoneNumber, trimmed.slice('!!tdelete'.length).trim());
    }

    return 'Bilinmeyen komut. `!!help` yaz.';
  }

  // --- Komut işleyicileri ---

  async handleNew(phoneNumber, orchestratorArg) {
    // Mevcut session state'ini snapshot al (store dosyasından oku, registry'ye kaydet)
    await this.snapshotActiveSession(phoneNumber);

    // Orkestratör belirle
    let targetOrch = await orchestratorManager.getOrchestrator(phoneNumber);
    if (orchestratorArg) {
      const normalized = orchestratorManager.normalizeType(orchestratorArg);
      if (!normalized) {
        const available = orchestratorManager.getAvailableOrchestrators();
        return `Bilinmeyen orkestratör: "${orchestratorArg}"\nKullanılabilir: ${available.join(', ')}`;
      }
      targetOrch = normalized;
      await orchestratorManager.setOrchestrator(phoneNumber, normalized);
    }

    // Registry'de yeni session oluştur
    const userData = this.ensureUserData(phoneNumber);
    userData.counter = (userData.counter || 0) + 1;
    const key = `t${userData.counter}`;
    const info = orchestratorManager.getOrchestratorInfo(targetOrch);
    const label = `${info?.name || targetOrch} #${userData.counter}`;

    userData.sessions[key] = {
      orchestrator: targetOrch,
      stateData: null,
      label,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    };
    userData.activeKey = key;

    await this.saveRegistry();
    logger.info(`Yeni terminal session: ${key} (${targetOrch}) - ${phoneNumber}`);

    return `Yeni terminal: *${label}* (\`${key}\`)\nOrkestratör: *${info?.name || targetOrch}*`;
  }

  async handleChange(phoneNumber, targetKey) {
    if (!targetKey) {
      return 'Kullanım: `!!tchange <id>` (ör: `!!tchange t1`)\nListe: `!!tlist`';
    }

    const key = targetKey.toLowerCase().trim();
    const userData = this.registry[phoneNumber];

    if (!userData?.sessions?.[key]) {
      return `Session bulunamadı: \`${targetKey}\`\nListe: \`!!tlist\``;
    }

    if (key === userData.activeKey) {
      return `Zaten *${userData.sessions[key].label}* terminalindesin.`;
    }

    // Mevcut state'i snapshot al
    await this.snapshotActiveSession(phoneNumber);

    const target = userData.sessions[key];

    // Orkestratörü ayarla
    await orchestratorManager.setOrchestrator(phoneNumber, target.orchestrator);

    // Sadece registry güncelle — store dosyasına ve session'a dokunma
    // Lazy detection: sıradaki mesajda session değişimi tespit edilecek
    userData.activeKey = key;
    target.lastUsed = new Date().toISOString();
    await this.saveRegistry();

    logger.info(`Terminal session değiştirildi: ${key} (${target.orchestrator}) - ${phoneNumber}`);

    const info = orchestratorManager.getOrchestratorInfo(target.orchestrator);
    const ctx = target.stateData ? 'Önceki konuşmana devam edebilirsin.' : 'Yeni session.';
    return `Terminal: *${target.label}* (\`${key}\`)\nOrkestratör: *${info?.name || target.orchestrator}*\n${ctx}`;
  }

  async handleList(phoneNumber) {
    const userData = this.registry[phoneNumber];
    if (!userData?.sessions || Object.keys(userData.sessions).length === 0) {
      return 'Henüz terminal session yok.\n`!!new` ile oluştur.';
    }

    const lines = ['*Terminal Session\'lar:*\n'];
    for (const [key, s] of Object.entries(userData.sessions)) {
      const active = key === userData.activeKey ? ' ✓' : '';
      const info = orchestratorManager.getOrchestratorInfo(s.orchestrator);
      const state = s.stateData ? '💾' : '🆕';
      const date = new Date(s.createdAt).toLocaleDateString('tr-TR');
      lines.push(`${state} \`${key}\` *${s.label}*${active}`);
      lines.push(`   ${info?.name || s.orchestrator} | ${date}`);
    }

    lines.push('');
    lines.push('`!!tchange <id>` geç | `!!trename <id> <isim>` | `!!tdelete <id>`');
    return lines.join('\n');
  }

  async handleRename(phoneNumber, arg) {
    if (!arg || !arg.includes(' ')) {
      return 'Kullanım: `!!trename <id> <yeni isim>`\nÖrnek: `!!trename t1 Proje X`';
    }

    const spaceIdx = arg.indexOf(' ');
    const key = arg.slice(0, spaceIdx).toLowerCase().trim();
    const newName = arg.slice(spaceIdx + 1).trim();

    if (!newName) return 'Yeni isim boş olamaz.';

    const userData = this.registry[phoneNumber];
    if (!userData?.sessions?.[key]) {
      return `Session bulunamadı: \`${key}\``;
    }

    const old = userData.sessions[key].label;
    userData.sessions[key].label = newName;
    await this.saveRegistry();

    return `\`${key}\`: *${old}* → *${newName}*`;
  }

  async handleDelete(phoneNumber, targetKey) {
    if (!targetKey) {
      return 'Kullanım: `!!tdelete <id>`';
    }

    const key = targetKey.toLowerCase().trim();
    const userData = this.registry[phoneNumber];

    if (!userData?.sessions?.[key]) {
      return `Session bulunamadı: \`${key}\``;
    }

    if (key === userData.activeKey) {
      return 'Aktif session silinemez. Önce `!!tchange` ile başka session\'a geç.';
    }

    const deleted = userData.sessions[key];
    delete userData.sessions[key];
    await this.saveRegistry();

    return `Silindi: *${deleted.label}* (\`${key}\`)`;
  }

  async handleHelp(phoneNumber) {
    const currentOrch = await orchestratorManager.getOrchestrator(phoneNumber);
    const info = orchestratorManager.getOrchestratorInfo(currentOrch);
    const userData = this.registry[phoneNumber];
    const activeSession = userData?.activeKey && userData.sessions?.[userData.activeKey];
    const termLine = activeSession
      ? `Terminal: *${activeSession.label}* (\`${userData.activeKey}\`)`
      : 'Terminal: varsayılan';

    return [
      '*Komutlar:*\n',
      '*Asistan*',
      '`!!switch` sıradakine geç',
      '`!!switch claude|codex|gemini` belirli orkestratör',
      '`!!switch list|status` liste/durum',
      '',
      '*Terminal*',
      '`!!new [orch]` yeni session',
      '`!!tlist` session listesi',
      '`!!tchange <id>` session değiştir',
      '`!!trename <id> <isim>` yeniden adlandır',
      '`!!tdelete <id>` sil',
      '',
      '*Diğer*',
      '`görevler` arka plan görevleri',
      '`son dosya` son kaydedilen dosya',
      '',
      `Orkestratör: *${info?.name || currentOrch}*`,
      termLine
    ].join('\n');
  }

  // --- Lazy terminal geçişi (processOneMessage'dan çağrılır) ---

  /**
   * Mevcut session'ın aktif terminale ait olup olmadığını kontrol et.
   * Farklıysa: eski session'ın state'ini kaydeder, session'ı sonlandırır,
   * yeni terminalin state'ini store'a yazar.
   *
   * Return: true = session değişti (yeni session oluşturulmalı), false = aynı
   */
  async ensureCorrectTerminal(phoneNumber) {
    await this.loadRegistry();

    const userData = this.registry[phoneNumber];
    if (!userData?.activeKey) return false;

    const activeKey = userData.activeKey;
    const session = this.sessionManager.getSession(phoneNumber);

    if (!session) {
      // Session yok — store'u aktif terminalin state'i ile hazırla
      const target = userData.sessions[activeKey];
      if (target) {
        await this.writeStoreFile(phoneNumber, target.orchestrator, target.stateData);
      }
      return false; // createSession zaten çağrılacak
    }

    // Session var — doğru terminale mi ait?
    if (session._terminalKey === activeKey) {
      return false; // Aynı terminal, sorun yok
    }

    // Terminal değişmiş! Eski session'ın state'ini eski terminaline kaydet
    const oldKey = session._terminalKey;
    if (oldKey && userData.sessions[oldKey]) {
      const oldState = await this.readStoreFile(phoneNumber, session.orchestratorType);
      if (oldState) {
        userData.sessions[oldKey].stateData = oldState;
        userData.sessions[oldKey].lastUsed = new Date().toISOString();
      }
    }

    // Eski session'ı sonlandır (bu noktada idle olmalı - kuyruk sırayla işliyor)
    await this.sessionManager.endSession(phoneNumber);

    // Yeni terminalin state'ini store'a yaz
    const target = userData.sessions[activeKey];
    if (target) {
      await this.writeStoreFile(phoneNumber, target.orchestrator, target.stateData);
    }

    await this.saveRegistry();

    logger.info(`Lazy terminal geçişi: ${oldKey || '?'} → ${activeKey} (${phoneNumber})`);
    return true;
  }

  // --- State yönetimi ---

  /**
   * Aktif session'ın state'ini store dosyasından okuyup registry'ye kaydet.
   */
  async snapshotActiveSession(phoneNumber) {
    const userData = this.registry[phoneNumber];
    if (!userData?.activeKey || !userData.sessions?.[userData.activeKey]) return;

    const session = userData.sessions[userData.activeKey];
    const orch = session.orchestrator || await orchestratorManager.getOrchestrator(phoneNumber);

    const stateData = await this.readStoreFile(phoneNumber, orch);
    if (stateData) {
      session.stateData = stateData;
      session.lastUsed = new Date().toISOString();
      await this.saveRegistry();
    }
  }

  /**
   * Her AI mesajı sonrası çağrılır — aktif terminal session'ın state'ini günceller.
   * Session'ın _terminalKey'ini de kontrol eder.
   */
  async autoSave(phoneNumber, terminalKey) {
    if (!this.loaded) return;
    const userData = this.registry[phoneNumber];

    // Hangi terminale kaydedileceğini belirle
    const saveKey = terminalKey || userData?.activeKey;
    if (!saveKey || !userData?.sessions?.[saveKey]) return;

    const session = userData.sessions[saveKey];
    const orch = session.orchestrator || await orchestratorManager.getOrchestrator(phoneNumber);
    const stateData = await this.readStoreFile(phoneNumber, orch);

    if (stateData) {
      session.stateData = stateData;
      session.lastUsed = new Date().toISOString();
      this.debouncedSave();
    }
  }

  /**
   * Aktif terminal etiketini döndür
   */
  getActiveLabel(phoneNumber) {
    const userData = this.registry[phoneNumber];
    if (!userData?.activeKey) return null;
    const session = userData.sessions?.[userData.activeKey];
    if (!session) return null;
    return { key: userData.activeKey, label: session.label };
  }

  // --- Store dosyası I/O ---

  getStorePath(orchestratorType) {
    const type = String(orchestratorType || '').toLowerCase().trim();
    if (type === 'claude') return path.join(paths.dataDir, 'claude-sessions.json');
    if (type === 'codex') return path.join(paths.dataDir, 'codex-threads.json');
    if (type === 'gemini') return path.join(paths.dataDir, 'gemini-sessions.json');
    return null;
  }

  async readStoreFile(phoneNumber, orchestratorType) {
    const storePath = this.getStorePath(orchestratorType);
    if (!storePath) return null;
    try {
      const raw = await fs.readFile(storePath, 'utf8');
      const data = JSON.parse(raw);
      return data?.[phoneNumber] || null;
    } catch {
      return null;
    }
  }

  async writeStoreFile(phoneNumber, orchestratorType, stateData) {
    const storePath = this.getStorePath(orchestratorType);
    if (!storePath) return;

    let data = {};
    try {
      const raw = await fs.readFile(storePath, 'utf8');
      data = JSON.parse(raw) || {};
    } catch {
      data = {};
    }

    if (stateData) {
      data[phoneNumber] = stateData;
    } else {
      delete data[phoneNumber];
    }

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(data, null, 2) + '\n');
  }

  // --- Registry I/O ---

  ensureUserData(phoneNumber) {
    if (!this.registry[phoneNumber]) {
      this.registry[phoneNumber] = { activeKey: null, counter: 0, sessions: {} };
    }
    return this.registry[phoneNumber];
  }

  async loadRegistry() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.registry = parsed;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Terminal registry okunamadı:', err.message);
      }
      this.registry = {};
    }
  }

  async saveRegistry() {
    try {
      await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
      await fs.writeFile(this.registryPath, JSON.stringify(this.registry, null, 2) + '\n');
    } catch (err) {
      logger.error('Terminal registry kaydedilemedi:', err.message);
    }
  }

  debouncedSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      await this.saveRegistry();
    }, 2000);
  }
}

export default TerminalHandler;
