import { spawn } from 'child_process';
import EventEmitter from 'events';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { paths } from '../paths.js';

/**
 * Claude Code Process Wrapper
 * WhatsApp kullanıcıları için persistent Claude Code oturumları yönetir
 */
class ClaudeProcess extends EventEmitter {
  constructor(id, owner) {
    super();
    this.id = id;
    this.owner = owner;
    this.process = null;
    this.state = 'idle';
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.messageCount = 0;
    this.sessionId = null; // Claude Code session ID (UUID)
    this.sessionLoaded = false;
  }

  getSessionStorePath() {
    return process.env.CLAUDE_SESSION_STORE || path.join(paths.dataDir, 'claude-sessions.json');
  }

  /**
   * Kullanıcının mevcut Claude session ID'sini yükle
   */
  async loadSessionState() {
    if (this.sessionLoaded) return;
    this.sessionLoaded = true;

    try {
      const raw = await fs.readFile(this.getSessionStorePath(), 'utf8');
      const data = JSON.parse(raw);
      const existing = data?.[this.owner];

      if (typeof existing === 'string' && existing.length > 0) {
        this.sessionId = existing;
        logger.info(`Mevcut Claude session yüklendi: ${this.sessionId}`);
        return;
      }

      if (existing && typeof existing === 'object' && existing.sessionId) {
        this.sessionId = existing.sessionId;
        logger.info(`Mevcut Claude session yüklendi: ${this.sessionId}`);
      }
    } catch {
      // Dosya yoksa veya parse edilemezse yeni session oluşturulacak
    }
  }

  /**
   * Session ID'yi kaydet
   */
  async saveSessionState(sessionId) {
    const storePath = this.getSessionStorePath();
    const dir = path.dirname(storePath);
    const tmpPath = `${storePath}.tmp.${process.pid}`;

    let data = {};
    try {
      const raw = await fs.readFile(storePath, 'utf8');
      data = JSON.parse(raw) || {};
    } catch {
      data = {};
    }

    data[this.owner] = {
      sessionId: sessionId,
      updatedAt: new Date().toISOString()
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmpPath, storePath);
  }

  /**
   * System prompt - Task management ve davranış kuralları
   */
  getSystemPrompt() {
    return process.env.CLAUDE_SYSTEM_PROMPT || `Sen "Claude Code" - WhatsApp üzerinden erişilen güçlü bir AI asistanısın. Kullanıcıyla Türkçe, samimi ama profesyonel iletişim kuruyorsun.

## SEN KİMSİN
- Claude Code (Anthropic) - Sonnet 4.5 modeli
- Sunucu: rammfire.com (Debian 12, 35.234.79.64)
- Çalışma dizini: /opt/whatsapp-claude
- Tam sistem erişimin var (--dangerously-skip-permissions aktif)
- Dosya okuma/yazma, bash komutları çalıştırma, kod yazma yapabilirsin

## YETENEKLERİN
1. **Dosya İşlemleri**: Okuma, yazma, düzenleme, silme
2. **Bash Komutları**: Sistem komutları çalıştırma (git, npm, apt, systemctl vb.)
3. **Kod Yazma**: Her dilde kod yazabilirsin
4. **Web İşlemleri**: curl, wget ile veri çekme
5. **Proje Yönetimi**: Git commit, push, branch işlemleri
6. **Sunucu Yönetimi**: Servis başlatma/durdurma, config düzenleme

## SUNUCU BİLGİLERİ
- Domain: rammfire.com
- Dosya paylaşım dizini: /srv/files/ (web'den erişilebilir)
- FileBrowser: https://rammfire.com (admin paneli)
- Bu WhatsApp bot projesi: /opt/whatsapp-claude

## GÖREV YÖNETİMİ (ÖNEMLİ!)

### Basit İstekler → Direkt Cevap Ver
- Soru-cevap, bilgi alma, kısa açıklamalar
- Tek satırlık kod örnekleri
- Hızlı hesaplamalar

### Karmaşık Görevler → Arka Plan Görevi Oluştur
Aşağıdaki durumlar için MUTLAKA bg-task bloğu kullan:
- Kod yazma/düzenleme (birden fazla dosya)
- Proje oluşturma
- Dosya indirme/işleme
- Git işlemleri (commit, push)
- Uzun sürecek analizler

**KRİTİK:** Kullanıcı "task oluştur", "arka planda yap", "görev oluştur" derse KESİNLİKLE işi kendin yapma! Sadece bg-task bloğu yaz. Blok sisteme gönderilecek, ayrı bir worker işi yapacak.

Not: "orchestrator" alanını mutlaka "codex", "claude" veya "gemini" olarak seç.

Format (bu bloğu AYNEN kullan):
\`\`\`bg-task
{"title": "Görevi özetleyen kısa başlık", "steps": ["Yapılacak adım 1", "Yapılacak adım 2"], "prompt": "Görevi gerçekleştirecek worker için detaylı talimat. Ne yapılacak, hangi dosyalar etkilenecek, nasıl test edilecek hepsini yaz.", "orchestrator": "codex|claude|gemini"}
\`\`\`

### Örnekler:

Kullanıcı: "rammfire.com/test.html sayfası oluştur"
Sen: Hemen yapıyorum!
\`\`\`bg-task
{"title": "test.html sayfası oluşturma", "steps": ["HTML dosyası oluştur", "Temel içerik ekle", "/srv/files/ dizinine kaydet"], "prompt": "/srv/files/test.html dosyası oluştur. Basit bir HTML5 sayfası olsun, 'Test Sayfası' başlığı ve 'Merhaba Dünya' içeriği bulunsun. Dosyayı oluşturduktan sonra rammfire.com/test.html adresinden erişilebilir olacak.", "orchestrator": "codex"}
\`\`\`

Kullanıcı: "projeyi github'a pushla"
Sen: Commit ve push yapıyorum!
\`\`\`bg-task
{"title": "GitHub push", "steps": ["Değişiklikleri kontrol et", "Commit oluştur", "Push yap"], "prompt": "/opt/whatsapp-claude dizininde git status ile değişiklikleri kontrol et. Varsa anlamlı bir commit mesajıyla commit at ve origin main'e pushla.", "orchestrator": "codex"}
\`\`\`

## MESAJ FORMATI
- Kısa ve öz cevaplar (WhatsApp için)
- Kod blokları kısa tut, uzunsa özet ver
- "Yapıyorum", "Hazır", "Tamamlandı" gibi net durumlar bildir

## GÖREV DURUMU
Mesajda [ARKA PLAN GÖREVLERİ] bloğu varsa:
- Bu senin çalışan/tamamlanan görevlerin
- Kullanıcı sorarsa durumu özetle
- Bloğun kendisini gösterme

## ÖNEMLİ
- İstek gelince hemen harekete geç
- "Yapamam" demeden önce düşün - muhtemelen yapabilirsin
- Hata alırsan çözüm öner
- Kullanıcı dosya gönderirse yolu verilir, işleyebilirsin`;
  }

  /**
   * Claude Code CLI'yi çalıştır
   */
  async runClaude({ message, images = [], isNewSession = false }) {
    const model = process.env.CLAUDE_MODEL || 'sonnet';
    const workdir = process.env.CLAUDE_WORKDIR || paths.appRoot;
    const timeoutMs = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 dakika
    const claudeBin = process.env.CLAUDE_BIN || 'claude';

    return await new Promise((resolve) => {
      const args = [
        '--dangerously-skip-permissions',
        '--print',
        '--output-format', 'json',
        '--model', model
      ];

      // Session yönetimi
      if (this.sessionId && !isNewSession) {
        // Mevcut session'a devam et
        args.push('--resume', this.sessionId);
      } else {
        // Yeni session oluştur - system prompt ile
        args.push('--system-prompt', this.getSystemPrompt());
      }

      this.state = 'executing';

      logger.info(`Claude komutu başlatılıyor [${this.id}]${this.sessionId ? ` session=${this.sessionId.substring(0, 8)}...` : ' (yeni)'}`);

      this.process = spawn(claudeBin, args, {
        env: { ...process.env },
        cwd: workdir
      });

      let stdout = '';
      let stderr = '';

      this.process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      this.process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const finish = async (code) => {
        this.state = 'idle';
        this.process = null;

        let result = '';
        let sessionIdFromRun = null;

        // JSON output'u parse et
        try {
          const response = JSON.parse(stdout.trim());

          if (response.type === 'result' && response.result) {
            result = response.result;
          }

          if (response.session_id) {
            sessionIdFromRun = response.session_id;
          }

          // Hata kontrolü
          if (response.is_error) {
            logger.error(`Claude API hatası: ${response.result || 'Bilinmeyen hata'}`);
          }
        } catch (e) {
          // JSON parse edilemezse raw output kullan
          if (stdout.trim()) {
            result = stdout.trim();
          }
        }

        // Session ID'yi güncelle ve kaydet
        if (sessionIdFromRun) {
          this.sessionId = sessionIdFromRun;
          try {
            await this.saveSessionState(this.sessionId);
            logger.info(`Claude session kaydedildi: ${this.sessionId.substring(0, 8)}...`);
          } catch (e) {
            logger.warn(`Claude session kaydedilemedi: ${e?.message || String(e)}`);
          }
        }

        if (result) {
          // WhatsApp için uzunluk limiti
          if (result.length > 3500) {
            resolve(result.substring(0, 3500) + '\n\n... (devamı kısaltıldı)');
            return;
          }
          resolve(result);
          return;
        }

        if (code !== 0) {
          const errorMsg = (stderr || `Hata kodu: ${code}`).trim();
          logger.error(`Claude hatası: ${errorMsg.substring(0, 200)}`);
          resolve('Bir hata oluştu. Lütfen tekrar dene.');
          return;
        }

        resolve('');
      };

      this.process.on('close', (code) => {
        void finish(code);
      });

      this.process.on('error', (error) => {
        this.state = 'idle';
        this.process = null;
        logger.error('Claude process hatası:', error);
        resolve(`Sistem hatası: ${error.message}`);
      });

      // Mesajı gönder
      let fullMessage = message;

      // Görseller varsa belirt
      if (images && images.length > 0) {
        fullMessage += `\n\n[Gönderilen görseller: ${images.join(', ')}]`;
      }

      this.process.stdin.write(fullMessage);
      this.process.stdin.end();

      // Timeout
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
            this.state = 'idle';
            resolve('İstek zaman aşımına uğradı. Lütfen tekrar dene.');
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * Kullanıcı mesajını işle
   */
  async execute(userMessage, options = {}) {
    const message = typeof userMessage === 'object' ? userMessage.message : userMessage;
    const images = Array.isArray(options.images) ? options.images : [];

    this.lastActivity = new Date();
    this.state = 'executing';
    this.messageCount++;

    // Session'ı yükle
    await this.loadSessionState();

    const isNewSession = !this.sessionId;

    logger.info(
      `Claude komutu [${this.id}]${this.sessionId ? ` (session ${this.sessionId.substring(0, 8)}...)` : ' (yeni session)'}: ${String(message || '').substring(0, 100)}...`
    );

    const response = await this.runClaude({ message, images, isNewSession });

    // Boş cevap kontrolü
    if (!response || response.trim() === '') {
      return 'Cevap oluşturulamadı. Lütfen tekrar dene.';
    }

    return response;
  }

  getStatus() {
    const uptime = Date.now() - this.createdAt.getTime();
    return {
      id: this.id,
      owner: this.owner,
      state: this.state,
      sessionId: this.sessionId,
      createdAt: this.createdAt.toISOString(),
      lastActivity: this.lastActivity.toISOString(),
      uptime: this.formatUptime(uptime),
      messageCount: this.messageCount
    };
  }

  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}sa ${minutes % 60}dk`;
    if (minutes > 0) return `${minutes}dk ${seconds % 60}sn`;
    return `${seconds}sn`;
  }

  isIdle() {
    return this.state === 'idle';
  }

  isTimedOut(timeoutMinutes = 30) {
    return Date.now() - this.lastActivity.getTime() > timeoutMinutes * 60 * 1000;
  }

  kill() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.state = 'killed';
  }

  /**
   * Session'ı sıfırla (yeni konuşma başlat)
   */
  async resetSession() {
    this.sessionId = null;
    this.sessionLoaded = false;

    // Storage'dan da sil
    try {
      const storePath = this.getSessionStorePath();
      const raw = await fs.readFile(storePath, 'utf8');
      const data = JSON.parse(raw) || {};
      delete data[this.owner];
      await fs.writeFile(storePath, JSON.stringify(data, null, 2) + '\n');
      logger.info(`Claude session sıfırlandı: ${this.owner}`);
    } catch {
      // ignore
    }
  }
}

export default ClaudeProcess;
