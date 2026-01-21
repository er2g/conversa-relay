import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let db;
let api;
let baseUrl;
let authHeader;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-ai-bridge-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.MEDIA_DIR = path.join(tmpDir, 'media');
  process.env.DB_PATH = path.join(tmpDir, 'database.sqlite');
  process.env.DASHBOARD_USER = 'u';
  process.env.DASHBOARD_PASS = 'p';

  authHeader = `Basic ${Buffer.from('u:p').toString('base64')}`;

  const { default: DB } = await import('../src/db/database.js');
  const { default: APIServer } = await import('../src/api/server.js');

  db = new DB();
  db.initialize();

  const waClient = { getStatus: () => ({ isReady: true, hasQR: false, connectionState: 'ready' }), getQRCode: () => null, logout: async () => {} };
  const sessionManager = { getStats: () => ({ total: 0, active: 0, idle: 0 }), getAllSessions: () => [], getSession: () => null, endSession: async () => {}, killAllSessions: async () => {} };

  api = new APIServer(0, waClient, sessionManager, db);
  await api.start();
  const port = api.server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (api) await api.stop();
  if (db) db.close();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

test('GET /api/media returns 404 (dashboard media endpoint removed)', async () => {
  const res = await fetch(`${baseUrl}/api/media`, {
    headers: { Authorization: authHeader }
  });
  assert.equal(res.status, 404);
});

test('GET /api/media/:id/download returns 404 (dashboard media endpoint removed)', async () => {
  const res = await fetch(`${baseUrl}/api/media/1/download`, {
    headers: { Authorization: authHeader }
  });
  assert.equal(res.status, 404);
});

test('DB last_saved_files upsert + read works', () => {
  const chatId = '12345@c.us';
  const createdAt = new Date().toISOString();
  const abs = path.join(process.env.MEDIA_DIR, '12345_c.us', 'file.txt');
  db.setLastSavedFile({
    chatId,
    messageId: 'msg-1',
    mimetype: 'text/plain',
    sizeBytes: 12,
    absolutePath: abs,
    createdAt
  });

  const row = db.getLastSavedFile(chatId);
  assert.ok(row);
  assert.equal(row.chat_id, chatId);
  assert.equal(row.message_id, 'msg-1');
  assert.equal(row.mimetype, 'text/plain');
  assert.equal(row.size_bytes, 12);
  assert.equal(row.absolute_path, abs);
  assert.equal(row.created_at, createdAt);
});
