import { spawn } from 'child_process';
import EventEmitter from 'events';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { paths } from '../paths.js';

class GeminiProcess extends EventEmitter {
  constructor(id, owner) {
    super();
    this.id = id;
    this.owner = owner;
    this.process = null;
    this.state = 'idle';
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.messageCount = 0;
    this.sessionId = null;
    this.sessionLoaded = false;
  }

  getSessionStorePath() {
    return process.env.GEMINI_SESSION_STORE || path.join(paths.dataDir, 'gemini-sessions.json');
  }

  async loadSessionState() {
    if (this.sessionLoaded) return;
    this.sessionLoaded = true;

    try {
      const raw = await fs.readFile(this.getSessionStorePath(), 'utf8');
      const data = JSON.parse(raw);
      const entry = data?.[this.owner];
      if (typeof entry === 'string' && entry.length > 0) {
        this.sessionId = entry;
        return;
      }
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        this.sessionId = entry.id;
      }
    } catch {
      // ignore missing/invalid file
    }
  }

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
      id: sessionId,
      updatedAt: new Date().toISOString()
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmpPath, storePath);
  }

  getInitialInstructions() {
    return (
      process.env.GEMINI_INITIAL_INSTRUCTIONS ||
      [
        'Sen WhatsApp üzerinden erişilen bir asistansın. Türkçe, samimi ve kısa cevap ver.',
        '',
        '## ARKA PLAN GÖREVLERİ',
        '',
        '### Görev Oluşturma',
        'Uzun sürecek işler için (kod yazma, proje oluşturma, dosya düzenleme, analiz vb.) arka plan görevi oluştur:',
        '',
        '```bg-task',
        '{"title": "Kısa başlık", "steps": ["Adım 1", "Adım 2"], "prompt": "Worker için detaylı talimat"}',
        '```',
        '',
        '### Görev Durumu Bilgisi',
        'Mesajın sonunda [ARKA PLAN GÖREVLERİ] bloğu varsa, bunlar kullanıcının aktif görevleridir.',
        'Kullanıcı görev hakkında sorarsa (ne yapıyorsun, bitti mi, durum ne) bu bilgiyi kullanarak cevap ver.',
        'Bu bloğu kullanıcıya aynen gösterme, sadece bilgi olarak kullan ve özetle.',
        '',
        '### Kurallar',
        '- Basit sorulara direkt cevap ver, arka plan kullanma',
        '- Görev başlatırken: önce kısa açıklama, sonra bg-task bloğu',
        '- [ARKA PLAN GÖREVLERİ] bloğunu kullanıcıya gösterme'
      ].join('\n')
    );
  }

  buildPrompt(message, images = [], isNewSession = false) {
    let base = String(message || '').trim();
    if (!base) return '';

    if (images.length) {
      const lines = images.filter(Boolean).map((img) => `- ${img}`);
      if (lines.length) {
        base = `${base}\n\nEk dosyalar (metin olmayan dosyalar olabilir):\n${lines.join('\n')}`;
      }
    }

    if (!isNewSession) return base;

    const instructions = this.getInitialInstructions();
    if (!instructions) return base;

    return `${instructions}\n\nKullanıcı: ${base}\nAsistan:`;
  }

  getIncludeDirectories() {
    const raw = process.env.GEMINI_INCLUDE_DIRS || process.env.GEMINI_INCLUDE_DIRECTORIES || '';
    if (!raw) return [];
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  shouldUseYolo() {
    const yolo = String(process.env.GEMINI_YOLO || '1').toLowerCase().trim();
    return yolo === '1' || yolo === 'true' || yolo === 'yes';
  }

  getApprovalMode() {
    const mode = String(process.env.GEMINI_APPROVAL_MODE || '').trim();
    if (mode) return mode;
    return this.shouldUseYolo() ? 'yolo' : 'auto_edit';
  }

  async runGemini({ message, images = [] }) {
    const geminiBin = process.env.GEMINI_BIN || 'gemini';
    const model = process.env.GEMINI_MODEL || '';
    const outputFormat = process.env.GEMINI_OUTPUT_FORMAT || 'stream-json';
    const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '600000', 10);
    const workdir = process.env.GEMINI_WORKDIR || paths.appRoot;
    const approvalMode = this.getApprovalMode();
    const includeDirs = this.getIncludeDirectories();

    const prompt = this.buildPrompt(message, images, !this.sessionId);
    if (!prompt) {
      this.state = 'idle';
      return '';
    }

    const args = [];
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }
    if (model) {
      args.push('--model', model);
    }
    if (outputFormat) {
      args.push('--output-format', outputFormat);
    }
    if (approvalMode) {
      args.push('--approval-mode', approvalMode);
    }
    if (approvalMode === 'yolo') {
      args.push('--yolo');
    }
    for (const dir of includeDirs) {
      args.push('--include-directories', dir);
    }

    args.push('--', prompt);

    return await new Promise((resolve) => {
      this.process = spawn(geminiBin, args, {
        env: {
          ...process.env
        },
        cwd: workdir
      });

      let stdoutBuf = '';
      let rawStdout = '';
      let stderr = '';
      let assistantText = '';
      let errorText = '';
      let sessionIdFromRun = null;
      const isStreamJson = outputFormat === 'stream-json';

      const handleEvent = (evt) => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'init' && evt.session_id) {
          sessionIdFromRun = String(evt.session_id);
        }
        if (evt.type === 'message' && evt.role === 'assistant') {
          const content = String(evt.content || '');
          if (evt.delta) {
            assistantText += content;
          } else if (content) {
            assistantText = content;
          }
        }
        if (evt.type === 'error') {
          const msg = evt.message || evt.error || evt.detail || '';
          if (msg) {
            errorText = String(msg);
          }
        }
        if (evt.type === 'result' && evt.status && evt.status !== 'success') {
          const msg = evt.error || evt.message || evt.status;
          if (msg) {
            errorText = String(msg);
          }
        }
      };

      this.process.stdout.on('data', (data) => {
        const chunk = data.toString();
        if (!isStreamJson) {
          rawStdout += chunk;
          return;
        }

        stdoutBuf += chunk;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            handleEvent(JSON.parse(trimmed));
          } catch {
            // ignore non-JSON output
          }
        }
      });

      this.process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const finish = async (code) => {
        this.state = 'idle';
        this.process = null;

        if (isStreamJson) {
          const tail = stdoutBuf.trim();
          if (tail.startsWith('{')) {
            try {
              handleEvent(JSON.parse(tail));
            } catch {
              // ignore
            }
          }
        } else if (rawStdout.trim()) {
          if (outputFormat === 'json') {
            try {
              const payload = JSON.parse(rawStdout.trim());
              if (payload && typeof payload === 'object') {
                if (payload.error?.message) {
                  errorText = String(payload.error.message);
                }
                if (payload.response) {
                  assistantText = String(payload.response);
                }
                if (payload.session_id) {
                  sessionIdFromRun = String(payload.session_id);
                }
              }
            } catch {
              assistantText = rawStdout.trim();
            }
          } else {
            assistantText = rawStdout.trim();
          }
        }

        if (!this.sessionId && sessionIdFromRun) {
          this.sessionId = sessionIdFromRun;
          try {
            await this.saveSessionState(sessionIdFromRun);
            logger.info(`Gemini session kaydedildi: ${sessionIdFromRun}`);
          } catch (e) {
            logger.warn(`Gemini session kaydedilemedi: ${e?.message || String(e)}`);
          }
        }

        if (code === 0 && assistantText.trim()) {
          const trimmed = assistantText.trim();
          if (trimmed.length > 3500) {
            resolve(trimmed.substring(0, 3500) + '\n\n... (kısaltıldı)');
            return;
          }
          resolve(trimmed);
          return;
        }

        const errMsg = errorText || stderr || `Hata: ${code}`;
        resolve(`Hata:\n${String(errMsg).trim().substring(0, 800)}`);
      };

      this.process.on('close', (code) => {
        void finish(code);
      });

      this.process.on('error', (error) => {
        this.state = 'idle';
        this.process = null;
        logger.error('Gemini process hatası:', error);
        resolve(`Sistem hatası: ${error.message}`);
      });

      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
            this.state = 'idle';
            resolve('Zaman aşımı.');
          }
        }, timeoutMs);
      }
    });
  }

  async execute(userMessage, options = {}) {
    const message =
      userMessage && typeof userMessage === 'object'
        ? userMessage.message
        : userMessage;

    const imagesFromMessage =
      userMessage && typeof userMessage === 'object' && Array.isArray(userMessage.images)
        ? userMessage.images
        : [];

    const images = Array.isArray(options.images) ? options.images : imagesFromMessage;

    this.lastActivity = new Date();
    this.state = 'executing';
    this.messageCount++;

    await this.loadSessionState();

    logger.info(
      `Gemini komutu [${this.id}]${this.sessionId ? ` (session ${this.sessionId})` : ''}: ${String(message || '').substring(0, 100)}...`
    );

    return await this.runGemini({ message, images });
  }

  getStatus() {
    const uptime = Date.now() - this.createdAt.getTime();
    return {
      id: this.id,
      owner: this.owner,
      state: this.state,
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
}

export default GeminiProcess;
