import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { paths } from '../paths.js';

/**
 * Arka plan görevlerini yöneten sınıf.
 * Her görev ayrı bir Codex thread'inde çalışır ve ana oturumu bloklamaz.
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

  /**
   * Yeni bir arka plan görevi başlat
   */
  async startTask({ owner, description, prompt, images = [], onComplete }) {
    const taskId = this.generateTaskId();
    const workdir = process.env.CODEX_WORKDIR || paths.appRoot;
    const codexBin = process.env.CODEX_BIN || 'codex';
    const model = process.env.CODEX_MODEL || 'gpt-5.2';
    const reasoningEffort = process.env.CODEX_REASONING_EFFORT || 'high';
    const yolo = (process.env.CODEX_YOLO || '1') !== '0';
    const sandboxMode = process.env.CODEX_SANDBOX || 'workspace-write';
    const timeoutMs = parseInt(process.env.CODEX_BG_TIMEOUT_MS || '1800000', 10); // 30 dakika

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
      threadId: null,
      process: null
    };

    this.tasks.set(taskId, task);
    await this.saveTasks();

    logger.info(`Arka plan görevi başlatıldı [${taskId}]: ${description}`);

    // Codex process'i başlat
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
      '-m', model,
      '-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      '-C', workdir,
      '-s', sandboxMode,
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

    proc.on('close', async (code) => {
      // Son satırı flush et
      if (stdoutBuf.trim().startsWith('{')) {
        try {
          const evt = JSON.parse(stdoutBuf.trim());
          if (evt?.type === 'item.completed' && evt?.item?.type === 'agent_message') {
            const text = String(evt.item.text || '').trim();
            if (text) messages.push(text);
          }
        } catch {}
      }

      task.process = null;
      task.completedAt = new Date().toISOString();

      if (code === 0) {
        task.status = 'completed';
        task.result = messages.join('\n').trim() || 'Görev tamamlandı (çıktı yok)';
        if (task.result.length > 3500) {
          task.result = task.result.substring(0, 3500) + '\n\n... (kısaltıldı)';
        }
        logger.info(`Arka plan görevi tamamlandı [${taskId}]`);
      } else {
        task.status = 'failed';
        task.error = stderr.trim() || `Çıkış kodu: ${code}`;
        logger.error(`Arka plan görevi başarısız [${taskId}]: ${task.error}`);
      }

      await this.saveTasks();

      // Callback ile bildir
      if (onComplete) {
        try {
          await onComplete(task);
        } catch (e) {
          logger.error(`Task callback hatası [${taskId}]:`, e);
        }
      }

      this.emit('taskComplete', task);
    });

    proc.on('error', async (error) => {
      task.process = null;
      task.status = 'failed';
      task.error = error.message;
      task.completedAt = new Date().toISOString();
      await this.saveTasks();

      if (onComplete) {
        try {
          await onComplete(task);
        } catch (e) {
          logger.error(`Task callback hatası [${taskId}]:`, e);
        }
      }

      this.emit('taskComplete', task);
    });

    // Prompt'u gönder
    const systemPrompt = process.env.CODEX_BG_INSTRUCTIONS || [
      'Sen bir arka plan görev asistanısın.',
      'Verilen görevi tamamla ve sonucu özetle.',
      'Kısa ve net cevap ver.',
      'İşlem adımlarını ve sonucu raporla.'
    ].join('\n');

    const fullPrompt = `${systemPrompt}\n\nGörev: ${prompt}\n\nBaşla:`;
    proc.stdin.write(fullPrompt);
    proc.stdin.end();

    // Timeout
    setTimeout(() => {
      if (task.process) {
        task.process.kill('SIGTERM');
        task.status = 'timeout';
        task.error = 'Zaman aşımı';
        task.completedAt = new Date().toISOString();
        this.saveTasks();
      }
    }, timeoutMs);

    return task;
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
