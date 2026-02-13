import { spawn } from 'child_process';
import EventEmitter from 'events';
import fs from 'fs/promises';
import logger from '../logger.js';
import path from 'path';
import { paths } from '../paths.js';
import {
  buildOutboxEnv,
  createOutboxRequestId,
  getOutboxPaths,
  getOutboxPromptInstructions
} from '../outbox/common.js';

class CodexProcess extends EventEmitter {
  constructor(id, owner) {
    super();
    this.id = id;
    this.owner = owner;
    this.process = null;
    this.state = 'idle';
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.messageCount = 0;
    this.threadId = null;
    this.threadLoaded = false;
    this.threadPrimed = false;
    this.lastExecutionMeta = null;
    this.outboxPaths = getOutboxPaths();
  }

  getThreadStorePath() {
    return process.env.CODEX_THREAD_STORE || path.join(paths.dataDir, 'codex-threads.json');
  }

  async loadThreadState() {
    if (this.threadLoaded) return;
    this.threadLoaded = true;

    try {
      const raw = await fs.readFile(this.getThreadStorePath(), 'utf8');
      const data = JSON.parse(raw);
      const existing = data?.[this.owner];

      if (typeof existing === 'string' && existing.length > 0) {
        this.threadId = existing;
        this.threadPrimed = false;
        return;
      }

      if (existing && typeof existing === 'object') {
        if (typeof existing.id === 'string' && existing.id.length > 0) {
          this.threadId = existing.id;
        }
        this.threadPrimed = existing.primed === true;
      }
    } catch {
      // ignore missing/invalid file
    }
  }

  async saveThreadState({ threadId, primed }) {
    const storePath = this.getThreadStorePath();
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
      id: threadId,
      primed: primed === true
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmpPath, storePath);
  }

  normalizeText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  isLowValueResponse(text) {
    const t = this.normalizeText(text);
    if (!t) return true;
    return (
      t === 'tamam' ||
      t === 'tamam.' ||
      t === 'ok' ||
      t === 'ok.' ||
      t === 'anladım' ||
      t === 'anladim' ||
      t === 'peki' ||
      t === 'peki.' ||
      t === 'tamamdır' ||
      t === 'tamamdir'
    );
  }

  shouldRetry(userMessage, response) {
    if (!this.isLowValueResponse(response)) return false;
    const u = this.normalizeText(userMessage);
    if (!u) return false;
    if (u === 'tamam' || u === 'ok' || u === 'peki') return false;
    return u.length >= 6;
  }

  getPrimaryModel() {
    return process.env.CODEX_MODEL || 'gpt-5.3-codex';
  }

  async runCodex({ mode, message, images = [], requestId = null, modelOverride = null }) {
    const model = modelOverride || this.getPrimaryModel();
    const reasoningEffort = process.env.CODEX_REASONING_EFFORT || 'medium';
    const workdir = process.env.CODEX_WORKDIR || paths.appRoot;
    const timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS || '600000', 10);
    const codexBin = process.env.CODEX_BIN || 'codex';
    const yolo = (process.env.CODEX_YOLO || '1') !== '0';
    const sandboxMode = process.env.CODEX_SANDBOX || 'workspace-write';

    const initialInstructions =
      process.env.CODEX_INITIAL_INSTRUCTIONS ||
      [
        'Sen WhatsApp üzerinden erişilen bir asistansın. Türkçe ve samimi ol.',
        '',
        '## ARKA PLAN GÖREVLERİ',
        'Kullanıcı "task oluştur", "arka planda yap", "görev oluştur" gibi bir şey derse KESİNLİKLE işi kendin yapma. Sadece bg-task bloğu oluştur:',
        '```bg-task',
        '{"title": "Başlık", "steps": ["Adım 1", "Adım 2"], "prompt": "Detaylı talimat", "orchestrator": "codex|claude|gemini"}',
        '```',
        'Bu blok sisteme gönderilecek ve ayrı bir worker işi yapacak. Sen sadece bloğu yaz, işi yapma.',
        '[ARKA PLAN GÖREVLERİ] bloğu varsa bunları kullanıcıya aynen gösterme, özetle.',
        '',
        getOutboxPromptInstructions()
      ].join('\n');

    return await new Promise((resolve) => {
      const args = [];
      if (yolo) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('-a', 'never');
      }

      args.push('exec');
      if (mode === 'resume') {
        args.push('resume');
      }

      if (images && images.length) {
        for (const img of images) {
          if (!img) continue;
          args.push('-i', img);
        }
      }

      if (mode === 'resume') {
        args.push(
          '--skip-git-repo-check',
          '--json',
          '-m',
          model,
          '-c',
          `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
          this.threadId,
          '-'
        );
      } else {
        args.push(
          '--skip-git-repo-check',
          '--json',
          '-m',
          model,
          '-c',
          `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
          '-C',
          workdir,
          '-s',
          sandboxMode,
          '-'
        );
      }

      this.process = spawn(codexBin, args, {
        env: {
          ...process.env,
          ...buildOutboxEnv({
            chatId: this.owner,
            requestId,
            orchestrator: 'codex',
            outboxPaths: this.outboxPaths,
            extraEnv: {
              WA_SESSION_ID: this.id
            }
          })
        },
        cwd: workdir
      });

      let stderr = '';
      let threadIdFromRun = null;
      const messages = [];
      const commandOutputs = [];
      let stdoutBuf = '';

      const processEvent = (evt) => {
        if (!evt) return;
        if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
          threadIdFromRun = evt.thread_id;
        }
        if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
          const text = String(evt.item.text || '').trim();
          if (text) messages.push(text);
        }
        // Tool call çıktılarını da yakala (agent_message yoksa fallback olarak kullanılacak)
        if (evt.type === 'item.completed' && evt.item?.type === 'command_execution') {
          const output = String(evt.item.aggregated_output || '').trim();
          const cmd = String(evt.item.command || '').trim();
          if (cmd) commandOutputs.push({ cmd, output, exitCode: evt.item.exit_code });
        }
      };

      this.process.stdout.on('data', (data) => {
        stdoutBuf += data.toString();

        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            processEvent(JSON.parse(trimmed));
          } catch {
            // ignore non-JSON lines
          }
        }
      });

      this.process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const finish = async (code) => {
        this.state = 'idle';
        this.process = null;

        // Flush possible final JSON line
        const tail = stdoutBuf.trim();
        if (tail.startsWith('{')) {
          try {
            processEvent(JSON.parse(tail));
          } catch {
            // ignore
          }
        }

        if (!this.threadId && threadIdFromRun) {
          this.threadId = threadIdFromRun;
          this.threadPrimed = true;
          try {
            await this.saveThreadState({ threadId: threadIdFromRun, primed: true });
            logger.info(`Codex thread kaydedildi: ${threadIdFromRun}`);
          } catch (e) {
            logger.warn(`Codex thread kaydedilemedi: ${e?.message || String(e)}`);
          }
        }

        if (code === 0) {
          const result = messages.join('\n').trim();
          if (!result) {
            if (commandOutputs.length > 0) {
              logger.warn('Codex agent_message donmedi; ham komut ciktisi kullaniciya gonderilmeyecek');
              resolve('');
              return;
            }
            logger.warn('Codex yanıt boş (agent_message yok, tool call yok)');
            resolve('');
            return;
          }
          if (result.length > 3500) {
            resolve(result.substring(0, 3500) + '\n\n... (kısaltıldı)');
            return;
          }
          resolve(result);
          return;
        }

        const errorMsg = (stderr || `Hata: ${code}`).trim();
        resolve(`Hata:\n${errorMsg.substring(0, 800)}`);
      };

      this.process.on('close', (code) => {
        void finish(code);
      });

      this.process.on('error', (error) => {
        this.state = 'idle';
        this.process = null;
        logger.error('Codex process hatası:', error);
        resolve(`Sistem hatası: ${error.message}`);
      });

      const promptToSend =
        mode === 'resume'
          ? message
          : `${initialInstructions}\n\nKullanıcı: ${message}\nAsistan:`;

      this.process.stdin.write(promptToSend);
      this.process.stdin.end();

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

  async ensureThreadPrimed() {
    if (!this.threadId) return;
    if (this.threadPrimed) return;

    const primer =
      process.env.CODEX_THREAD_PRIMER ||
      [
        'Kısa sistem notu:',
        "- Bu sohbeti WhatsApp'ta sürdüreceğiz; bağlamı hatırla.",
        "- Kullanıcı soru sorunca cevap ver; tek kelimelik 'Tamam.' cevabı verme.",
        '- Emin değilsen 1-2 net soru sor.',
        '',
        'Bu mesaja sadece \"OK\" yaz.'
      ].join('\n');

    await this.runCodex({
      mode: 'resume',
      message: primer,
      requestId: this.lastExecutionMeta?.requestId || null,
      modelOverride: this.getPrimaryModel()
    });
    this.threadPrimed = true;
    await this.saveThreadState({ threadId: this.threadId, primed: true });
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
    const requestId = createOutboxRequestId('chat');
    this.lastExecutionMeta = {
      requestId,
      orchestrator: 'codex',
      sessionId: this.id
    };

    await this.loadThreadState();

    logger.info(
      `Codex komutu [${this.id}]${this.threadId ? ` (thread ${this.threadId})` : ''}: ${String(message || '').substring(0, 100)}...`
    );

    const primaryModel = this.getPrimaryModel();

    if (this.threadId) {
      await this.ensureThreadPrimed();
      let response = await this.runCodex({
        mode: 'resume',
        message,
        images,
        requestId,
        modelOverride: primaryModel
      });

      if (this.shouldRetry(message, response)) {
        response = await this.runCodex({
          mode: 'resume',
          message:
            `Önceki cevabın çok kısa/boş. Lütfen kullanıcı mesajına kısa ama açıklayıcı cevap ver; sadece \"Tamam\" yazma.\n\nKullanıcı mesajı: ${message}`,
          images,
          requestId,
          modelOverride: primaryModel
        });
      }

      return response;
    }

    let response = await this.runCodex({
      mode: 'new',
      message,
      images,
      requestId,
      modelOverride: primaryModel
    });

    return response;
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

export default CodexProcess;
