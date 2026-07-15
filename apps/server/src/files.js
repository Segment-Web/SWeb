// Segment file storage: an authenticated, content-addressed blob store on the
// VPS disk. This is the interim backend chosen while storage is tight; because
// uploads are client-encrypted, the store only ever holds opaque bytes and can
// later be swapped for Cloudflare R2 without a protocol change
// (see docs/persistence-and-rooms.md).

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
};

export async function createFiles(config, auth) {
  const dir = config.fileDir;
  const maxBytes = config.fileMaxBytes;
  const ttlMs = config.fileTtlMs;
  await mkdir(dir, { recursive: true });
  const pathFor = (id) => join(dir, id);

  // Stream the request body straight to a temp file while hashing it, so large
  // uploads never sit fully in memory. The final name is the SHA-256 of the
  // (already encrypted) bytes, giving content-addressed dedup: identical
  // uploads collapse to one file. The size cap is enforced mid-stream.
  const put = (req) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    const out = createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (error) => {
      if (failed) return; failed = true;
      req.destroy(); out.destroy();
      unlink(tmp).catch(() => {});
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { fail(Object.assign(new Error('FILE_TOO_LARGE'), { status: 413 })); return; }
      hash.update(chunk);
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('error', fail);
    out.on('error', fail);
    req.on('end', () => {
      if (failed) return;
      out.end(async () => {
        try {
          if (size === 0) { await unlink(tmp).catch(() => {}); return reject(Object.assign(new Error('EMPTY_BODY'), { status: 400 })); }
          const id = hash.digest('hex');
          const target = pathFor(id);
          try { await stat(target); await unlink(tmp).catch(() => {}); } // already stored: drop the temp
          catch { await rename(tmp, target); }
          resolve({ id, size });
        } catch (error) { fail(error); }
      });
    });
  });

  const sweep = async () => {
    if (!ttlMs) return;
    const cutoff = Date.now() - ttlMs;
    let names;
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      if (!HEX64.test(name)) continue;
      try {
        const info = await stat(join(dir, name));
        if (info.mtimeMs < cutoff) await unlink(join(dir, name));
      } catch { /* raced with another sweep or delete */ }
    }
  };
  const timer = setInterval(() => { sweep().catch(() => {}); }, Math.min(ttlMs || 3600000, 3600000));
  timer.unref();

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://segment.local');
    if (!url.pathname.startsWith('/api/files')) return false;
    try {
      if (req.method === 'POST' && config.production) {
        const origin = req.headers.origin;
        const allowed = new Set(config.allowedOrigins);
        if (config.publicUrl) { try { allowed.add(new URL(config.publicUrl).origin); } catch {} }
        if (!origin || !allowed.has(origin)) return json(res, 403, { error: 'ORIGIN_FORBIDDEN' });
      }
      const user = await auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'UNAUTHORIZED' });

      if (req.method === 'POST' && url.pathname === '/api/files') {
        return json(res, 201, await put(req));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const id = url.pathname.slice('/api/files/'.length);
        if (!HEX64.test(id)) return json(res, 404, { error: 'NOT_FOUND' });
        let info;
        try { info = await stat(pathFor(id)); } catch { return json(res, 404, { error: 'NOT_FOUND' }); }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': info.size,
          'Cache-Control': 'private, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        const stream = createReadStream(pathFor(id));
        await new Promise((resolve) => {
          stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.destroy?.(); resolve(); });
          stream.on('data', (chunk) => {
            if (res.write(chunk) === false) { stream.pause(); res.once?.('drain', () => stream.resume()); }
          });
          stream.on('end', () => { res.end(); resolve(); });
        });
        return true;
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'files.request_failed', message: error.message }));
      return json(res, error.status || 500, { error: error.message || 'INTERNAL_ERROR' });
    }
  };

  return { handle, close: () => clearInterval(timer) };
}
