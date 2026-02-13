import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OutboxDispatcher from '../src/outbox/dispatcher.js';
import {
  ensureOutboxDirs,
  getOutboxPaths,
  normalizeOutboxMessage,
  writeOutboxMessage
} from '../src/outbox/common.js';

let tmpDir;
let outboxPaths;

async function waitFor(checkFn, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (checkFn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Beklenen durum olusmadi');
}

async function clearDir(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => fs.rm(path.join(dirPath, entry.name), { recursive: true, force: true }))
  );
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-ai-outbox-test-'));
  outboxPaths = getOutboxPaths(path.join(tmpDir, 'outbox'));
  await ensureOutboxDirs(outboxPaths);
});

beforeEach(async () => {
  await clearDir(outboxPaths.pendingDir);
  await clearDir(outboxPaths.processedDir);
  await clearDir(outboxPaths.failedDir);
});

after(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('writeOutboxMessage pending klasorune json yazar', async () => {
  const result = await writeOutboxMessage(
    {
      chatId: '905551112233@c.us',
      requestId: 'chat-123',
      type: 'progress',
      text: 'Adim 1 tamamlandi',
      orchestrator: 'codex'
    },
    { outboxPaths }
  );

  const raw = await fs.readFile(result.filePath, 'utf8');
  const payload = JSON.parse(raw);

  assert.equal(payload.chatId, '905551112233@c.us');
  assert.equal(payload.requestId, 'chat-123');
  assert.equal(payload.type, 'progress');
  assert.equal(payload.text, 'Adim 1 tamamlandi');
  assert.equal(payload.orchestrator, 'codex');
});

test('OutboxDispatcher pending dosyayi gonderip processed klasorune tasir', async () => {
  const sent = [];
  const delivered = [];

  await writeOutboxMessage(
    {
      chatId: '905551112233@c.us',
      requestId: 'chat-abc',
      type: 'final',
      text: 'Is tamamlandi',
      orchestrator: 'gemini'
    },
    { outboxPaths }
  );

  const dispatcher = new OutboxDispatcher({
    outboxPaths,
    pollMs: 20,
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    onDelivered: async (payload) => {
      delivered.push(payload);
    }
  });

  await dispatcher.start();
  await waitFor(() => sent.length === 1 && delivered.length === 1);
  await dispatcher.stop();

  assert.equal(sent[0].chatId, '905551112233@c.us');
  assert.equal(sent[0].text, 'Is tamamlandi');
  assert.equal(delivered[0].requestId, 'chat-abc');
  assert.equal(delivered[0].type, 'final');

  const pending = await fs.readdir(outboxPaths.pendingDir);
  const processed = await fs.readdir(outboxPaths.processedDir);
  const failed = await fs.readdir(outboxPaths.failedDir);

  assert.equal(pending.length, 0);
  assert.equal(failed.length, 0);
  assert.equal(processed.length, 1);
});

test('normalizeOutboxMessage chatId ve text zorunlulugunu kontrol eder', () => {
  assert.throws(() => normalizeOutboxMessage({ text: 'x' }), /chatId/);
  assert.throws(() => normalizeOutboxMessage({ chatId: '905551112233@c.us' }), /text/);
});
