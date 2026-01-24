import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { paths } from '../paths.js';

/**
 * Arka plan görevlerini yöneten sınıf.
 * Her görev ayrı bir AI sürecinde çalışır ve ana oturumu bloklamaz.
 */
class BackgroundTaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map(); // taskId -> TaskInfo
    this.storePath = path.join(paths.dataDir, 'background-tasks.json');
  }

  async loadTasks() {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      const data = JSON.parse(raw);
      for (const [id, task] of Object.entries(data)) {
        // Sadece pending/running olanları yükle, process'i yeniden başlatma
        if (task.status === 'running') {
          task.status = 'interrupted'; // Sistem restart olduysa
        }
        this.tasks.set(id, task);
      }
      logger.info(`${this.tasks.size} arka plan görevi yüklendi`);
    } catch {
      // Dosya yoksa sorun yok
    }
  }

  async saveTasks() {
    const data = {};
    for (const [id, task] of this.tasks) {
      // Process referansını kaydetme
      const { process: _, ...taskData } = task;
      data[id] = taskData;
    }
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(data, null, 2));
  }

  generateTaskId() {
    return crypto.randomBytes(4).toString('hex');
  }

  getDefaultBgInstructions() {
    return [
      'Sen bir arka plan görev asistanısın.',
      'Verilen görevi tamamla ve sonucu özetle.',
      'Kısa ve net cevap ver.',
      'İşlem adımlarını ve sonucu raporla.'
    ].join('\n');
  }

  normalizeOrchestrator(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'default' || raw === 'auto') return null;
    if (raw.startsWith('gemini')) return 'gemini';
    if (raw.startsWith('claude') || raw === 'anthropic') return 'claude';
    if (raw.startsWith('codex') || raw.startsWith('openai') || raw.startsWith('gpt')) return 'codex';
    if (raw === 'sonnet' || raw === 'haiku' || raw === 'opus') return 'claude';
    return null;
  }

  getDefaultOrchestrator() {
    const raw =
      process.env.BG_ORCHESTRATOR ||
      process.env.BACKGROUND_ORCHESTRATOR ||
      process.env.ORCHESTRATOR_TYPE ||
      'codex';
    return this.normalizeOrchestrator(raw) || 'codex';
  }

  appendImageNotes(prompt, images = []) {
    if (!images || images.length === 0) return prompt;
    const lines = images.filter(Boolean).map((img) => `- ${img}`);
    if (lines.length === 0) return prompt;
    return `${prompt}\n\nEk dosyalar (metin olmayan dosyalar olabilir):\n${lines.join('\n')}`;
  }

  getGeminiIncludeDirectories() {
    const raw = process.env.GEMINI_INCLUDE_DIRS || process.env.GEMINI_INCLUDE_DIRECTORIES || '';
    if (!raw) return [];
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  shouldUseGeminiYolo() {
    const yolo = String(process.env.GEMINI_BG_YOLO || process.env.GEMINI_YOLO || '1')
      .toLowerCase()
      .trim();
    return yolo === '1' || yolo === 'true' || yolo === 'yes';
  }

  getGeminiApprovalMode() {
    const mode = String(process.env.GEMINI_BG_APPROVAL_MODE || process.env.GEMINI_APPROVAL_MODE || '')
      .trim();
    if (mode) return mode;
    return this.shouldUseGeminiYolo() ? 'yolo' : 'auto_edit';
  }

  /**
   * Yeni bir arka plan görevi başlat
   */
  async startTask({ owner, description, prompt, images = [], orchestrator, onComplete }) {
    const taskId = this.generateTaskId();
    const selectedOrchestrator =
      this.normalizeOrchestrator(orchestrator) || this.getDefaultOrchestrator();

    const task = {
      id: taskId,
      owner,
      description,
      prompt: prompt.substring(0, 500),
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
      orchestrator: selectedOrchestrator,
      model: null,
      threadId: null,
      process: null
    };

    this.tasks.set(taskId, task);
    await this.saveTasks();

    logger.info(
      `Arka plan görevi başlatıldı [${taskId}] (${selectedOrchestrator}): ${description}`
    );

    const finalize = (() => {
      let finished = false;
      return async ({ status, result, error }) => {
        if (finished) return;
        finished = true;
        task.process = null;
        task.completedAt = new Date().toISOString();
        task.status = status;
        task.result = result ?? task.result;
        task.error = error ?? task.error;

        if (task.status === 'completed' && (!task.result || !task.result.trim())) {
          task.result = 'Görev tamamlandı (çıktı yok)';
        }

        if (task.result && task.result.length > 3500) {
          task.result = task.result.substring(0, 3500) + '\n\n... (kısaltıldı)';
        }

        await this.saveTasks();

        if (onComplete) {
          try {
            await onComplete(task);
          } catch (e) {
            logger.error(`Task callback hatası [${taskId}]:`, e);
          }
        }

        this.emit('taskComplete', task);
      };
    })();

    if (selectedOrchestrator === 'claude') {
      this.startClaudeTask({ task, prompt, images, finalize });
      return task;
    }

    if (selectedOrchestrator === 'gemini') {
      this.startGeminiTask({ task, prompt, images, finalize });
      return task;
    }

    this.startCodexTask({ task, prompt, images, finalize });
    return task;
  }

  startCodexTask({ task, prompt, images, finalize }) {
    const workdir = process.env.CODEX_WORKDIR || paths.appRoot;
    const codexBin = process.env.CODEX_BIN || 'codex';
    const model = process.env.CODEX_MODEL || 'gpt-5.2';
    const reasoningEffort = process.env.CODEX_REASONING_EFFORT || 'high';
    const yolo = (process.env.CODEX_YOLO || '1') !== '0';
    const sandboxMode = process.env.CODEX_SANDBOX || 'workspace-write';
    const timeoutMs = parseInt(process.env.CODEX_BG_TIMEOUT_MS || '1800000', 10); // 30 dakika

    task.model = model;

    const args = [];
    if (yolo) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('-a', 'never');
    }

    args.push('exec');

    if (images && images.length) {
      for (const img of images) {
        if (img) args.push('-i', img);
      }
    }

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

    const proc = spawn(codexBin, args, {
      env: { ...process.env },
      cwd: workdir
    });

    task.process = proc;

    let stderr = '';
    let stdoutBuf = '';
    const messages = [];

    proc.stdout.on('data', (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt?.type === 'thread.started' && typeof evt.thread_id === 'string') {
            task.threadId = evt.thread_id;
          }
          if (evt?.type === 'item.completed' && evt?.item?.type === 'agent_message') {
            const text = String(evt.item.text || '').trim();
            if (text) messages.push(text);
          }
        } catch {
          // ignore
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (stdoutBuf.trim().startsWith('{')) {
        try {
          const evt = JSON.parse(stdoutBuf.trim());
          if (evt?.type === 'item.completed' && evt?.item?.type === 'agent_message') {
            const text = String(evt.item.text || '').trim();
            if (text) messages.push(text);
          }
        } catch {
          // ignore
        }
      }

      if (code === 0) {
        const result = messages.join('\n').trim();
        void finalize({ status: 'completed', result });
        return;
      }

      const errorMsg = stderr.trim() || `Çıkış kodu: ${code}`;
      void finalize({ status: 'failed', error: errorMsg });
    });

    proc.on('error', (error) => {
      void finalize({ status: 'failed', error: error.message });
    });

    const systemPrompt = process.env.CODEX_BG_INSTRUCTIONS || this.getDefaultBgInstructions();
    const fullPrompt = `${systemPrompt}\n\nGörev: ${prompt}\n\nBaşla:`;
    proc.stdin.write(fullPrompt);
    proc.stdin.end();

    setTimeout(() => {
      if (task.process) {
        task.process.kill('SIGTERM');
        void finalize({ status: 'timeout', error: 'Zaman aşımı' });
      }
    }, timeoutMs);
  }

  startClaudeTask({ task, prompt, images, finalize }) {
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const model = process.env.CLAUDE_BG_MODEL || process.env.CLAUDE_MODEL || 'sonnet';
    const timeoutMs = parseInt(
      process.env.CLAUDE_BG_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MS || '600000',
      10
    );
    const workdir = process.env.CLAUDE_WORKDIR || paths.appRoot;
    const systemPrompt = process.env.CLAUDE_BG_INSTRUCTIONS || this.getDefaultBgInstructions();

    task.model = model;

    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--output-format',
      'json',
      '--model',
      model,
      '--system-prompt',
      systemPrompt
    ];

    const proc = spawn(claudeBin, args, {
      env: { ...process.env },
      cwd: workdir
    });

    task.process = proc;

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      let result = '';
      let isError = false;
      let errorMsg = '';

      try {
        const response = JSON.parse(stdout.trim());
        if (response?.type === 'result' && response.result) {
          result = String(response.result);
        }
        if (response?.is_error) {
          isError = true;
          errorMsg = String(response.result || response.error || 'Bilinmeyen hata');
        }
      } catch {
        if (stdout.trim()) result = stdout.trim();
      }

      if (code === 0 && !isError) {
        void finalize({ status: 'completed', result });
        return;
      }

      const finalError = errorMsg || stderr.trim() || `Çıkış kodu: ${code}`;
      void finalize({ status: 'failed', error: finalError });
    });

    proc.on('error', (error) => {
      void finalize({ status: 'failed', error: error.message });
    });

    const taskPrompt = this.appendImageNotes(`Görev: ${prompt}`, images);
    proc.stdin.write(taskPrompt);
    proc.stdin.end();

    setTimeout(() => {
      if (task.process) {
        task.process.kill('SIGTERM');
        void finalize({ status: 'timeout', error: 'Zaman aşımı' });
      }
    }, timeoutMs);
  }

  startGeminiTask({ task, prompt, images, finalize }) {
    const geminiBin = process.env.GEMINI_BIN || 'gemini';
    const model = process.env.GEMINI_BG_MODEL || process.env.GEMINI_MODEL || '';
    const outputFormat =
      process.env.GEMINI_BG_OUTPUT_FORMAT || process.env.GEMINI_OUTPUT_FORMAT || 'stream-json';
    const timeoutMs = parseInt(
      process.env.GEMINI_BG_TIMEOUT_MS || process.env.GEMINI_TIMEOUT_MS || '600000',
      10
    );
    const workdir = process.env.GEMINI_WORKDIR || paths.appRoot;
    const approvalMode = this.getGeminiApprovalMode();
    const includeDirs = this.getGeminiIncludeDirectories();

    task.model = model || null;

    const instructions = process.env.GEMINI_BG_INSTRUCTIONS || this.getDefaultBgInstructions();
    const basePrompt = `${instructions}\n\nGörev: ${prompt}`;
    const fullPrompt = this.appendImageNotes(basePrompt, images);

    const args = [];
    if (model) {
      args.push('--model', model);
    }
    if (outputFormat) {
      args.push('--output-format', outputFormat);
    }
    if (approvalMode && approvalMode !== 'yolo') {
      args.push('--approval-mode', approvalMode);
    }
    if (approvalMode === 'yolo') {
      args.push('--yolo');
    }
    for (const dir of includeDirs) {
      args.push('--include-directories', dir);
    }

    args.push('--', fullPrompt);

    const proc = spawn(geminiBin, args, {
      env: { ...process.env },
      cwd: workdir
    });

    task.process = proc;

    let stdoutBuf = '';
    let rawStdout = '';
    let stderr = '';
    let assistantText = '';
    let errorText = '';
    const isStreamJson = outputFormat === 'stream-json';

    const handleEvent = (evt) => {
      if (!evt || typeof evt !== 'object') return;
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
        if (msg) errorText = String(msg);
      }
      if (evt.type === 'result' && evt.status && evt.status !== 'success') {
        const msg = evt.error || evt.message || evt.status;
        if (msg) errorText = String(msg);
      }
    };

    proc.stdout.on('data', (data) => {
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

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
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
            if (payload?.error?.message) {
              errorText = String(payload.error.message);
            }
            if (payload?.response) {
              assistantText = String(payload.response);
            }
          } catch {
            assistantText = rawStdout.trim();
          }
        } else {
          assistantText = rawStdout.trim();
        }
      }

      if (code === 0 && !errorText) {
        void finalize({ status: 'completed', result: assistantText.trim() });
        return;
      }

      const finalError = errorText || stderr.trim() || `Çıkış kodu: ${code}`;
      void finalize({ status: 'failed', error: finalError });
    });

    proc.on('error', (error) => {
      void finalize({ status: 'failed', error: error.message });
    });

    setTimeout(() => {
      if (task.process) {
        task.process.kill('SIGTERM');
        void finalize({ status: 'timeout', error: 'Zaman aşımı' });
      }
    }, timeoutMs);
  }

  /**
   * Görev durumunu getir
   */
  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  /**
   * Kullanıcının görevlerini listele
   */
  getTasksForOwner(owner) {
    const result = [];
    for (const task of this.tasks.values()) {
      if (task.owner === owner) {
        const { process: _, ...taskData } = task;
        result.push(taskData);
      }
    }
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Aktif görev sayısı
   */
  getActiveTaskCount(owner) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.owner === owner && task.status === 'running') {
        count++;
      }
    }
    return count;
  }

  /**
   * Görevi iptal et
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.process) {
      task.process.kill('SIGTERM');
    }
    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    this.saveTasks();
    return true;
  }

  /**
   * Eski görevleri temizle (24 saatten eski)
   */
  async cleanOldTasks() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running' && new Date(task.createdAt).getTime() < cutoff) {
        this.tasks.delete(id);
      }
    }
    await this.saveTasks();
  }
}

// Singleton instance
export const taskManager = new BackgroundTaskManager();
export default BackgroundTaskManager;
