import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import {
  ensureOutboxDirs,
  getOutboxPaths,
  normalizeOutboxMessage,
  writeOutboxMessage
} from './common.js';

class OutboxDispatcher {
  constructor({
    outboxPaths = getOutboxPaths(),
    sendMessage,
    onDelivered = null,
    onFailed = null,
    pollMs = parseInt(process.env.AI_OUTBOX_POLL_MS || '700', 10),
    maxRetries = parseInt(process.env.AI_OUTBOX_MAX_RETRIES || '3', 10)
  } = {}) {
    this.outboxPaths = outboxPaths;
    this.sendMessage = sendMessage;
    this.onDelivered = onDelivered;
    this.onFailed = onFailed;
    this.pollMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 700;
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : 3;
    this.interval = null;
    this.processing = false;
  }

  async start() {
    if (typeof this.sendMessage !== 'function') {
      throw new Error('OutboxDispatcher sendMessage callback gerekli');
    }
    await ensureOutboxDirs(this.outboxPaths);
    if (this.interval) return;

    this.interval = setInterval(() => {
      void this.processPending().catch((error) => {
        logger.error(`Outbox dispatcher dongu hatasi: ${error?.message || String(error)}`);
      });
    }, this.pollMs);

    logger.info(`Outbox dispatcher baslatildi: ${this.outboxPaths.pendingDir}`);
    await this.processPending();
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.processing) {
      const startedAt = Date.now();
      while (this.processing && Date.now() - startedAt < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async processPending() {
    if (this.processing) return;
    this.processing = true;

    try {
      await ensureOutboxDirs(this.outboxPaths);
      const entries = await fs.readdir(this.outboxPaths.pendingDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();

      for (const fileName of files) {
        await this.processFile(fileName);
      }
    } finally {
      this.processing = false;
    }
  }

  async processFile(fileName) {
    const sourcePath = path.join(this.outboxPaths.pendingDir, fileName);
    const processingName = `${fileName}.processing.${process.pid}`;
    const processingPath = path.join(this.outboxPaths.pendingDir, processingName);

    try {
      await fs.rename(sourcePath, processingPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    let rawText = '';
    let envelope = null;

    try {
      rawText = await fs.readFile(processingPath, 'utf8');
      const parsed = JSON.parse(rawText);
      envelope = normalizeOutboxMessage(parsed);
    } catch (error) {
      await this.moveToFailed({
        processingPath,
        originalName: fileName,
        reason: 'parse',
        error,
        envelope,
        rawText
      });
      return;
    }

    try {
      await this.sendMessage(envelope.chatId, envelope.text, envelope);
      await this.markProcessed(processingPath, fileName);
      if (this.onDelivered) {
        await this.onDelivered(envelope);
      }
    } catch (error) {
      await this.retryOrFail({ envelope, processingPath, originalName: fileName, error });
    }
  }

  async markProcessed(processingPath, originalName) {
    const safeName = `${Date.now()}-${originalName}`;
    const targetPath = path.join(this.outboxPaths.processedDir, safeName);
    await fs.rename(processingPath, targetPath);
  }

  async retryOrFail({ envelope, processingPath, originalName, error }) {
    const attempt = Number(envelope?.meta?.attempt || 0) + 1;

    if (attempt <= this.maxRetries) {
      const retryPayload = {
        ...envelope,
        meta: {
          ...(envelope.meta || {}),
          attempt,
          lastError: error?.message || String(error),
          lastAttemptAt: new Date().toISOString()
        }
      };

      await writeOutboxMessage(retryPayload, {
        outboxPaths: this.outboxPaths,
        fallbackChatId: envelope.chatId,
        fallbackRequestId: envelope.requestId,
        fallbackOrchestrator: envelope.orchestrator
      });
      await fs.unlink(processingPath).catch(() => {});
      logger.warn(
        `Outbox gonderim yeniden denenecek (${attempt}/${this.maxRetries}): ${error?.message || String(error)}`
      );
      return;
    }

    await this.moveToFailed({
      processingPath,
      originalName,
      reason: 'send',
      error,
      envelope,
      rawText: JSON.stringify(envelope, null, 2)
    });
  }

  async moveToFailed({ processingPath, originalName, reason, error, envelope, rawText }) {
    const failedPayload = {
      failedAt: new Date().toISOString(),
      reason,
      error: error?.message || String(error),
      envelope: envelope || null,
      raw: String(rawText || '')
    };
    const failedName = `${Date.now()}-${originalName}.failed.json`;
    const failedPath = path.join(this.outboxPaths.failedDir, failedName);

    await fs.writeFile(failedPath, JSON.stringify(failedPayload, null, 2) + '\n', 'utf8');
    await fs.unlink(processingPath).catch(() => {});

    if (this.onFailed) {
      try {
        await this.onFailed({
          reason,
          error: failedPayload.error,
          envelope: envelope || null,
          failedPath
        });
      } catch (callbackError) {
        logger.warn(`Outbox onFailed callback hatasi: ${callbackError?.message || String(callbackError)}`);
      }
    }
  }
}

export default OutboxDispatcher;
