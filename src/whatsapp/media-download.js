import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import logger from '../logger.js';

const DEFAULT_MEDIA_HOST = process.env.WHATSAPP_MEDIA_HOST || 'https://mmg.whatsapp.net';
const DEFAULT_ORIGIN = process.env.WHATSAPP_ORIGIN || 'https://web.whatsapp.com';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || '300000', 10);

const KEY_TYPE_MAP = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  ptt: 'Audio',
  document: 'Document',
  sticker: 'Sticker'
};

class StripMacTransform extends Transform {
  constructor(macLength, hmac) {
    super();
    this.macLength = macLength;
    this.hmac = hmac;
    this.tail = Buffer.alloc(0);
    this.mac = null;
  }

  _transform(chunk, _enc, cb) {
    const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    if (data.length <= this.macLength) {
      this.tail = data;
      cb();
      return;
    }

    const cutoff = data.length - this.macLength;
    const body = data.slice(0, cutoff);
    this.tail = data.slice(cutoff);
    if (body.length) {
      this.hmac.update(body);
      this.push(body);
    }
    cb();
  }

  _flush(cb) {
    this.mac = this.tail;
    cb();
  }
}

const safeUnlink = async (path) => {
  try {
    await fs.promises.unlink(path);
  } catch {
    // ignore
  }
};

const toNodeStream = (body) => {
  if (body instanceof Readable) return body;
  if (Readable.fromWeb) return Readable.fromWeb(body);
  return Readable.from(body);
};

const deriveMediaKeys = (mediaKey, keyType) => {
  const info = `WhatsApp ${keyType} Keys`;
  const expandedRaw = crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), Buffer.from(info), 112);
  const expanded = Buffer.isBuffer(expandedRaw) ? expandedRaw : Buffer.from(expandedRaw);
  return {
    iv: expanded.slice(0, 16),
    cipherKey: expanded.slice(16, 48),
    macKey: expanded.slice(48, 80)
  };
};

export const resolveMediaKeyType = (messageType, mimetype) => {
  const normalizedType = String(messageType || '').toLowerCase();
  if (KEY_TYPE_MAP[normalizedType]) return KEY_TYPE_MAP[normalizedType];

  const normalizedMime = String(mimetype || '').toLowerCase();
  if (normalizedMime.startsWith('image/')) return 'Image';
  if (normalizedMime.startsWith('video/')) return 'Video';
  if (normalizedMime.startsWith('audio/')) return 'Audio';
  if (normalizedMime) return 'Document';
  return null;
};

export const normalizeMediaKey = (mediaKey) => {
  if (!mediaKey) return null;
  if (Buffer.isBuffer(mediaKey)) return mediaKey;
  if (mediaKey instanceof Uint8Array) {
    return Buffer.from(mediaKey.buffer, mediaKey.byteOffset, mediaKey.byteLength);
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(mediaKey)) {
    return Buffer.from(mediaKey.buffer, mediaKey.byteOffset || 0, mediaKey.byteLength);
  }
  if (mediaKey instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(mediaKey));
  }

  if (Array.isArray(mediaKey)) {
    return Buffer.from(mediaKey);
  }

  if (typeof mediaKey === 'object') {
    if (mediaKey.type === 'Buffer' && Array.isArray(mediaKey.data)) {
      return Buffer.from(mediaKey.data);
    }
    if (mediaKey.data) {
      const nested = normalizeMediaKey(mediaKey.data);
      if (nested) return nested;
    }
    if (mediaKey.buffer) {
      const nested = normalizeMediaKey(mediaKey.buffer);
      if (nested) return nested;
    }
    if (typeof mediaKey.byteLength === 'number') {
      try {
        return Buffer.from(new Uint8Array(mediaKey));
      } catch {
        // ignore
      }
    }
  }

  if (typeof mediaKey === 'string') {
    const trimmed = mediaKey.trim().replace(/^data:;base64,/, '');
    if (!trimmed) return null;
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return Buffer.from(trimmed, 'hex');
    }
    try {
      return Buffer.from(trimmed, 'base64');
    } catch {
      return null;
    }
  }

  return null;
};

export const buildMediaDownloadUrl = ({ directPath, url }) => {
  const candidate = url || directPath;
  if (!candidate) return null;

  const trimmed = String(candidate).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;

  const base = DEFAULT_MEDIA_HOST.endsWith('/')
    ? DEFAULT_MEDIA_HOST.slice(0, -1)
    : DEFAULT_MEDIA_HOST;
  const pathPart = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${pathPart}`;
};

export const downloadAndDecryptToFile = async ({
  url,
  mediaKey,
  keyType,
  outputPath,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) => {
  if (!url) throw new Error('Medya URL yok');
  if (!keyType) throw new Error('Medya key tipi yok');

  const keyBuffer = normalizeMediaKey(mediaKey);
  if (!keyBuffer || keyBuffer.length < 8) {
    throw new Error('Geçersiz mediaKey');
  }

  const { iv, cipherKey, macKey } = deriveMediaKeys(keyBuffer, keyType);

  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  const tempPath = `${outputPath}.part`;
  let bytesWritten = 0;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Origin: DEFAULT_ORIGIN,
        Referer: `${DEFAULT_ORIGIN}/`,
        Accept: '*/*'
      },
      signal: controller?.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('Boş medya response');
    }

    const hmac = crypto.createHmac('sha256', macKey);
    hmac.update(iv);
    const stripMac = new StripMacTransform(10, hmac);
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytesWritten += chunk.length;
        this.push(chunk);
        cb();
      }
    });

    const bodyStream = toNodeStream(response.body);
    const writeStream = fs.createWriteStream(tempPath);

    await pipeline(bodyStream, stripMac, decipher, counter, writeStream);

    const mac = stripMac.mac || Buffer.alloc(0);
    const digest = hmac.digest().slice(0, 10);
    if (mac.length !== 10 || !crypto.timingSafeEqual(mac, digest)) {
      throw new Error('MAC doğrulama hatası');
    }

    await fs.promises.rename(tempPath, outputPath);
    return { sizeBytes: bytesWritten };
  } catch (error) {
    await safeUnlink(tempPath);
    const message = error?.name === 'AbortError'
      ? 'Medya indirme zaman aşımına uğradı'
      : error?.message || String(error);
    logger.warn(`Direct indirme hatası: ${message}`);
    throw new Error(message);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};
