import orchestratorManager from './orchestrator-manager.js';
import logger from '../logger.js';

/**
 * Switch Komut İşleyicisi
 *
 * !!switch komutlarını temiz bir şekilde işler.
 */
class SwitchHandler {
  constructor(sessionManager, db, options = {}) {
    this.sessionManager = sessionManager;
    this.db = db;

    // System note ekleme callback'i (handlers.js'den gelecek)
    this.addSystemNote = options.addSystemNote || (() => {});

    // Handoff ayarları - tüm session'ı aktar
    this.handoffConfig = {
      messageLimit: parseInt(process.env.HANDOFF_CONTEXT_LIMIT || '100', 10),
      maxCharsPerLine: parseInt(process.env.HANDOFF_CONTEXT_LINE_CHARS || '500', 10),
      maxTotalChars: parseInt(process.env.HANDOFF_CONTEXT_MAX_CHARS || '15000', 10)
    };
  }

  /**
   * Switch komutu mu kontrol et
   */
  isSwitch(text) {
    const lower = String(text || '').toLowerCase().trim();
    return lower.startsWith('!!switch') || lower.startsWith('!!asistan') || lower.startsWith('!!ai');
  }

  /**
   * Komutu parse et
   */
  parseCommand(text) {
    const trimmed = String(text || '').trim();
    const lower = trimmed.toLowerCase();

    // Komut prefix'ini bul
    let arg = '';
    if (lower.startsWith('!!switch')) {
      arg = trimmed.slice('!!switch'.length).trim();
    } else if (lower.startsWith('!!asistan')) {
      arg = trimmed.slice('!!asistan'.length).trim();
    } else if (lower.startsWith('!!ai')) {
      arg = trimmed.slice('!!ai'.length).trim();
    }

    const argLower = arg.toLowerCase();

    // Komut tipini belirle
    if (!arg || argLower === 'next' || argLower === 'sonraki') {
      return { action: 'cycle' };
    }

    if (argLower === 'list' || argLower === 'liste' || argLower === 'help' || argLower === '?') {
      return { action: 'list' };
    }

    if (argLower === 'default' || argLower === 'varsayilan' || argLower === 'varsayılan') {
      return { action: 'reset' };
    }

    if (argLower === 'status' || argLower === 'durum' || argLower === 'info') {
      return { action: 'status' };
    }

    if (argLower === 'history' || argLower === 'gecmis' || argLower === 'geçmiş') {
      return { action: 'history' };
    }

    // Belirli bir orkestratöre geç
    return { action: 'set', target: arg };
  }

  /**
   * Switch komutunu işle
   */
  async handle(phoneNumber, text) {
    const cmd = this.parseCommand(text);

    switch (cmd.action) {
      case 'cycle':
        return this.handleCycle(phoneNumber);

      case 'list':
        return this.handleList(phoneNumber);

      case 'reset':
        return this.handleReset(phoneNumber);

      case 'status':
        return this.handleStatus(phoneNumber);

      case 'history':
        return this.handleHistory(phoneNumber);

      case 'set':
        return this.handleSet(phoneNumber, cmd.target);

      default:
        return this.handleList(phoneNumber);
    }
  }

  /**
   * Bir sonraki orkestratöre geç
   */
  async handleCycle(phoneNumber) {
    const current = await orchestratorManager.getOrchestrator(phoneNumber);
    const result = await orchestratorManager.cycleToNext(phoneNumber);

    if (!result.success) {
      return `Hata: ${result.error}`;
    }

    if (result.from === result.to) {
      return `Zaten ${this.formatOrchestratorName(result.to)} kullanılıyor.`;
    }

    // Session'ı sonlandır ve handoff note oluştur
    await this.performSwitch(phoneNumber, result.from, result.to);

    const info = orchestratorManager.getOrchestratorInfo(result.to);
    return `Orkestratör değiştirildi: ${this.formatOrchestratorName(result.from)} → ${this.formatOrchestratorName(result.to)}\n\n${info?.description || ''}`;
  }

  /**
   * Belirli bir orkestratöre geç
   */
  async handleSet(phoneNumber, target) {
    const normalized = orchestratorManager.normalizeType(target);

    if (!normalized) {
      const available = orchestratorManager.getAvailableOrchestrators();
      return `Bilinmeyen orkestratör: "${target}"\n\nKullanılabilir seçenekler: ${available.join(', ')}`;
    }

    const current = await orchestratorManager.getOrchestrator(phoneNumber);

    if (normalized === current) {
      return `Zaten ${this.formatOrchestratorName(current)} kullanılıyor.`;
    }

    const result = await orchestratorManager.setOrchestrator(phoneNumber, normalized);

    if (!result.success) {
      return `Hata: ${result.error}`;
    }

    await this.performSwitch(phoneNumber, result.from, result.to);

    const info = orchestratorManager.getOrchestratorInfo(result.to);
    return `Orkestratör değiştirildi: ${this.formatOrchestratorName(result.from)} → ${this.formatOrchestratorName(result.to)}\n\n${info?.description || ''}`;
  }

  /**
   * Varsayılana dön
   */
  async handleReset(phoneNumber) {
    const result = await orchestratorManager.resetToDefault(phoneNumber);

    if (result.from === result.to) {
      return `Zaten varsayılan orkestratör (${this.formatOrchestratorName(result.to)}) kullanılıyor.`;
    }

    await this.performSwitch(phoneNumber, result.from, result.to);

    return `Varsayılan orkestratöre (${this.formatOrchestratorName(result.to)}) dönüldü.`;
  }

  /**
   * Orkestratör listesini göster
   */
  async handleList(phoneNumber) {
    const status = await orchestratorManager.getUserStatus(phoneNumber);
    const lines = ['*Kullanılabilir Orkestratörler:*\n'];

    for (const type of status.available) {
      const info = orchestratorManager.getOrchestratorInfo(type);
      const marker = type === status.current ? ' ✓' : '';
      const defaultMarker = type === status.defaultOrchestrator ? ' (varsayılan)' : '';

      lines.push(`• *${info?.name || type}*${marker}${defaultMarker}`);
      if (info?.description) {
        lines.push(`  ${info.description}`);
      }
    }

    lines.push('\n*Komutlar:*');
    lines.push('• `!!switch` - Sonraki orkestratöre geç');
    lines.push('• `!!switch claude` - Claude\'a geç');
    lines.push('• `!!switch codex` - Codex\'e geç');
    lines.push('• `!!switch gemini` - Gemini\'ye geç');
    lines.push('• `!!switch default` - Varsayılana dön');
    lines.push('• `!!switch status` - Durum bilgisi');

    return lines.join('\n');
  }

  /**
   * Durum bilgisini göster
   */
  async handleStatus(phoneNumber) {
    const status = await orchestratorManager.getUserStatus(phoneNumber);
    const lines = ['*Orkestratör Durumu:*\n'];

    lines.push(`Aktif: *${status.currentName}*`);
    lines.push(`Varsayılan: ${status.defaultOrchestrator}`);
    lines.push(`Toplam switch: ${status.switchCount}`);

    if (status.lastUpdated) {
      const date = new Date(status.lastUpdated);
      lines.push(`Son değişiklik: ${date.toLocaleString('tr-TR')}`);
    }

    if (status.recentHistory.length > 0) {
      lines.push('\n*Son Değişiklikler:*');
      for (const h of status.recentHistory) {
        const date = new Date(h.timestamp);
        lines.push(`• ${h.from} → ${h.to} (${date.toLocaleTimeString('tr-TR')})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Switch geçmişini göster
   */
  async handleHistory(phoneNumber) {
    const history = orchestratorManager.getHistory(phoneNumber);

    if (history.length === 0) {
      return 'Henüz orkestratör değişikliği yapılmamış.';
    }

    const lines = ['*Orkestratör Geçmişi:*\n'];

    for (const h of history.slice().reverse()) {
      const date = new Date(h.timestamp);
      lines.push(`• ${h.from} → ${h.to}`);
      lines.push(`  ${date.toLocaleString('tr-TR')}`);
    }

    return lines.join('\n');
  }

  /**
   * Switch işlemini gerçekleştir (session sonlandır + handoff)
   */
  async performSwitch(phoneNumber, fromOrchestrator, toOrchestrator) {
    try {
      // Mevcut session'ı sonlandır (memory'den)
      if (this.sessionManager) {
        await this.sessionManager.endSession(phoneNumber);
      }

      // YENİ orkestratörün eski session state'ini SİL
      // Böylece temiz başlar ve handoff note'u ana bilgi kaynağı olarak kullanır
      // Aksi halde eski session resume edilir ve handoff note görmezden gelinir
      await this.clearOrchestratorState(phoneNumber, toOrchestrator);

      // Handoff note oluştur
      const handoffNote = this.buildHandoffNote(phoneNumber, fromOrchestrator, toOrchestrator);

      // Handoff note'u system notes'a ekle (yeni session'a aktarılacak)
      if (this.addSystemNote && typeof this.addSystemNote === 'function') {
        this.addSystemNote(phoneNumber, handoffNote);
        logger.info(`Handoff note eklendi: ${phoneNumber}`);
      }

      logger.info(`Orkestratör switch: ${phoneNumber} - ${fromOrchestrator} → ${toOrchestrator}`);

      return handoffNote;
    } catch (err) {
      logger.error('Switch işlemi hatası:', err.message);
      throw err;
    }
  }

  /**
   * Orkestratör state dosyasını temizle
   */
  async clearOrchestratorState(phoneNumber, orchestratorType) {
    if (this.sessionManager?.resetStoredState) {
      await this.sessionManager.resetStoredState(phoneNumber, orchestratorType);
    }
  }

  /**
   * Handoff note oluştur
   */
  buildHandoffNote(phoneNumber, fromOrchestrator, toOrchestrator) {
    const { messageLimit, maxCharsPerLine, maxTotalChars } = this.handoffConfig;

    let rows = [];
    try {
      if (this.db?.getMessages) {
        rows = this.db.getMessages(phoneNumber, Math.max(messageLimit * 3, 30)) || [];
      }
    } catch {
      rows = [];
    }

    if (!rows.length) {
      return `ÖNEMLİ BAĞLAM: Kullanıcı ${fromOrchestrator} asistanından sana (${toOrchestrator}) geçiş yaptı. Önceki sohbet kaydı bulunamadı. Kendinizi tanıtın ve devam edin.`;
    }

    const lines = [];
    let total = 200; // Header için rezerv

    // rows zaten DESC sıralı (yeniden eskiye) - dokunma
    // İlk N mesajı al (en yeniler)
    for (const row of rows) {
      let text = String(row?.message || '').trim();
      if (!text) continue;

      // Switch komutlarını atla
      const lower = text.toLowerCase();
      if (lower.startsWith('!!switch') || lower.startsWith('!!asistan') || lower.startsWith('!!ai')) {
        continue;
      }

      // Orkestratör değişim mesajlarını atla
      if (lower.includes('orkestratör değiştirildi')) {
        continue;
      }

      // Satırı temizle ve kısalt
      text = text.replace(/\s+/g, ' ').trim();
      if (text.length > maxCharsPerLine) {
        text = text.slice(0, maxCharsPerLine) + '...';
      }

      const prefix = row.direction === 'incoming' ? 'Kullanıcı' : 'Asistan';
      const line = `${prefix}: ${text}`;

      if (total + line.length + 1 > maxTotalChars) {
        break;
      }

      lines.push(line);
      total += line.length + 1;

      if (lines.length >= messageLimit) {
        break;
      }
    }

    if (lines.length === 0) {
      return `ÖNEMLİ BAĞLAM: Kullanıcı ${fromOrchestrator} asistanından sana (${toOrchestrator}) geçiş yaptı. Önceki sohbet özeti oluşturulamadı. Kendinizi tanıtın ve devam edin.`;
    }

    // Mesajları kronolojik sıraya çevir (eskiden yeniye)
    const chronological = lines.reverse();

    return `ÖNEMLİ BAĞLAM: Kullanıcı ${fromOrchestrator} asistanından sana (${toOrchestrator}) geçiş yaptı. Aşağıda önceki sohbetin özeti var. BU BİLGİLERİ HATIRLA ve sohbete kaldığı yerden devam et:

--- ÖNCEKİ SOHBET (${chronological.length} mesaj) ---
${chronological.join('\n')}
--- SOHBET SONU ---

Şimdi kullanıcının yeni mesajına cevap ver. Önceki konuşmayı biliyormuş gibi davran.`;
  }

  /**
   * Orkestratör adını formatla
   */
  formatOrchestratorName(type) {
    const info = orchestratorManager.getOrchestratorInfo(type);
    return info?.name || type;
  }
}

export default SwitchHandler;
