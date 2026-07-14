// Segment file storage: an authenticated, content-addressed blob store on the
// VPS disk. This is the interim backend chosen while storage is tight; because
// uploads are client-encrypted, the store only ever holds opaque bytes and can
// later be swapped for Cloudflare R2 without a protocol change
// (see docs/persistence-and-rooms.md).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(Object.assign(new Error('FILE_TOO_LARGE'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
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

  // Content-addressed by SHA-256 of the (already encrypted) bytes: identical
  // uploads dedupe to one file on disk.
  const put = async (bytes) => {
    const id = createHash('sha256').update(bytes).digest('hex');
    const target = pathFor(id);
    try { await stat(target); } catch { await writeFile(target, bytes); }
    return { id, size: bytes.length };
  };

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
        const bytes = await readBody(req, maxBytes);
        if (!bytes.length) return json(res, 400, { error: 'EMPTY_BODY' });
        return json(res, 201, await put(bytes));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const id = url.pathname.slice('/api/files/'.length);
        if (!HEX64.test(id)) return json(res, 404, { error: 'NOT_FOUND' });
        let bytes;
        try { bytes = await readFile(pathFor(id)); } catch { return json(res, 404, { error: 'NOT_FOUND' }); }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(bytes);
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
