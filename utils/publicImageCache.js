import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const inflight = new Map();
const MAX_BYTES = 10 * 1024 * 1024;
const cachePath = (key) => path.join(path.resolve(process.env.PUBLIC_IMAGE_CACHE_DIR),
  `${crypto.createHash('sha256').update(key).digest('hex')}${path.extname(key).toLowerCase()}`);
const eligible = (key) => process.env.PUBLIC_IMAGE_CACHE_DIR && /\.(jpe?g|png|webp|gif|avif)$/i.test(key);
let lastPruned = 0;

async function prune() {
  if (Date.now() - lastPruned < 60000) return;
  lastPruned = Date.now();
  const directory = path.resolve(process.env.PUBLIC_IMAGE_CACHE_DIR);
  const entries = await fs.readdir(directory);
  const files = (await Promise.all(entries.filter((name) => /^[a-f0-9]{64}\./.test(name)).map(async (name) => {
    const file = path.join(directory, name);
    const stat = await fs.stat(file).catch(() => null);
    return stat && { file, ...stat };
  }))).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (total <= 500 * 1024 * 1024 && Date.now() - file.mtimeMs < 3600000) break;
    await fs.unlink(file.file).catch(() => {});
    total -= file.size;
  }
}

export async function invalidatePublicImage(key) {
  if (eligible(key)) await fs.unlink(cachePath(key)).catch(() => {});
}

export async function serveCachedImage(key, getObject, res, next) {
  if (!eligible(key)) return false;
  const target = cachePath(key);
  const stat = await fs.stat(target).catch(() => null);
  const age = stat ? Date.now() - stat.mtimeMs : Infinity;
  let cacheState = 'HIT';
  if (age > 300000) {
    try {
      if (!inflight.has(key)) {
        if (inflight.size >= 4) throw new Error('Image cache download capacity reached');
        const loading = (async () => {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const temporary = `${target}.${crypto.randomUUID()}.tmp`;
          const signal = AbortSignal.timeout(15000);
          const object = await getObject(signal);
          if (object.ContentLength > MAX_BYTES) { object.Body.destroy(); return false; }
          let bytes = 0;
          try {
            await pipeline(object.Body, new Transform({ transform(chunk, encoding, done) {
              bytes += chunk.length;
              done(bytes > MAX_BYTES ? new Error('Image exceeds cache limit') : null, chunk);
            } }), createWriteStream(temporary, { mode: 0o600 }), { signal });
            await fs.rename(temporary, target);
          } finally { await fs.unlink(temporary).catch(() => {}); }
          await prune();
          return true;
        })().finally(() => inflight.delete(key));
        inflight.set(key, loading);
      }
      if (!await inflight.get(key)) return false;
      cacheState = 'MISS';
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        await invalidatePublicImage(key);
        res.status(404).send('File not found');
        return true;
      }
      if (!stat || age > 3600000) throw error;
      cacheState = 'STALE';
    }
  }
  res.setHeader('X-Image-Cache', cacheState);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(target, (error) => { if (error && !res.headersSent) next(error); });
  return true;
}
