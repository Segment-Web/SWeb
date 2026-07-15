// Segment file storage: an authenticated, content-addressed blob store on the
// VPS disk. This is the interim backend chosen while storage is tight; because
// uploads are client-encrypted, the store only ever holds opaque bytes and can
// later be swapped for Cloudflare R2 without a protocol change
// (see docs/persistence-and-rooms.md).

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
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
  const uploadLimit = config.fileUploadsPerMinute || 60;
  const uploadsByUser = new Map();
  const uploadLocks = new Set();
  await mkdir(dir, { recursive: true });
  const uploadRows = new Map();
  if (auth.pool?.query) await auth.pool.query(`CREATE TABLE IF NOT EXISTS file_uploads (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expected_size BIGINT NOT NULL, received_size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ); CREATE INDEX IF NOT EXISTS file_uploads_updated_idx ON file_uploads(updated_at);`);
  const createUpload = async (row) => {
    if (auth.pool?.query) await auth.pool.query('INSERT INTO file_uploads(id,user_id,expected_size) VALUES($1,$2,$3)', [row.id, row.user_id, row.expected_size]);
    else uploadRows.set(row.id, { ...row, received_size: 0, updated_at: new Date() });
  };
  const findUpload = async (id, userId) => auth.pool?.query
    ? (await auth.pool.query('SELECT * FROM file_uploads WHERE id=$1 AND user_id=$2', [id, userId])).rows[0]
    : (uploadRows.get(id)?.user_id === userId ? uploadRows.get(id) : null);
  const updateUpload = async (id, userId, received) => {
    if (auth.pool?.query) await auth.pool.query('UPDATE file_uploads SET received_size=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3', [received, id, userId]);
    else { const row = await findUpload(id, userId); if (row) { row.received_size = received; row.updated_at = new Date(); } }
  };
  const deleteUpload = async (id, userId = null) => {
    if (auth.pool?.query) await auth.pool.query(`DELETE FROM file_uploads WHERE id=$1${userId ? ' AND user_id=$2' : ''}`, userId ? [id, userId] : [id]);
    else if (!userId || uploadRows.get(id)?.user_id === userId) uploadRows.delete(id);
  };
  const pathFor = (id) => join(dir, id);
  const uploadPath = (id) => join(dir, `.upload-${id}`);
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('CHUNK_TOO_LARGE'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const hashFile = (path) => new Promise((resolve, reject) => {
    const hash = createHash('sha256'); const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')));
  });

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
    const minuteAgo = Date.now() - 60000;
    for (const [userId, requests] of uploadsByUser) {
      const recent = requests.filter((time) => time >= minuteAgo);
      if (recent.length) uploadsByUser.set(userId, recent); else uploadsByUser.delete(userId);
    }
    const staleUploads = auth.pool?.query
      ? (await auth.pool.query("DELETE FROM file_uploads WHERE updated_at < NOW()-INTERVAL '24 hours' RETURNING id")).rows
      : [...uploadRows.values()].filter((row) => Date.now() - new Date(row.updated_at).getTime() > 86400000);
    if (!auth.pool?.query) for (const upload of staleUploads) uploadRows.delete(upload.id);
    for (const upload of staleUploads) await unlink(uploadPath(upload.id)).catch(() => {});
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
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && config.production) {
        const origin = req.headers.origin;
        const allowed = new Set(config.allowedOrigins);
        if (config.publicUrl) { try { allowed.add(new URL(config.publicUrl).origin); } catch {} }
        if (!origin || !allowed.has(origin)) return json(res, 403, { error: 'ORIGIN_FORBIDDEN' });
      }
      const user = await auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'UNAUTHORIZED' });

      if (req.method === 'POST' && url.pathname === '/api/files/uploads') {
        const now = Date.now();
        const recent = (uploadsByUser.get(user.id) || []).filter((time) => now - time < 60000);
        if (recent.length >= uploadLimit) return json(res, 429, { error: 'TOO_MANY_UPLOADS' });
        recent.push(now); uploadsByUser.set(user.id, recent);
        const expected = Number(req.headers['upload-length']);
        if (!Number.isSafeInteger(expected) || expected < 1 || expected > maxBytes) return json(res, 400, { error: 'UPLOAD_LENGTH_INVALID' });
        const id = randomUUID();
        await createUpload({ id, user_id: user.id, expected_size: expected });
        await appendFile(uploadPath(id), Buffer.alloc(0));
        return json(res, 201, { uploadId: id, offset: 0, length: expected });
      }
      const uploadMatch = url.pathname.match(/^\/api\/files\/uploads\/([0-9a-f-]{36})(?:\/(complete))?$/i);
      if (uploadMatch) {
        const id = uploadMatch[1];
        const row = await findUpload(id, user.id);
        if (!row) return json(res, 404, { error: 'UPLOAD_NOT_FOUND' });
        if (req.method === 'HEAD' && !uploadMatch[2]) {
          res.writeHead(204, { 'Upload-Offset': String(row.received_size), 'Upload-Length': String(row.expected_size), 'Cache-Control': 'no-store' }); res.end(); return true;
        }
        if (req.method === 'PATCH' && !uploadMatch[2]) {
          if (uploadLocks.has(id)) return json(res, 409, { error: 'UPLOAD_BUSY', offset: Number(row.received_size) });
          uploadLocks.add(id);
          try {
          const offset = Number(req.headers['upload-offset']);
          if (offset !== Number(row.received_size)) return json(res, 409, { error: 'UPLOAD_OFFSET_MISMATCH', offset: Number(row.received_size) });
          const remaining = Number(row.expected_size) - offset;
          const chunk = await readBody(req, Math.min(4 * 1024 * 1024, remaining));
          if (!chunk.length || chunk.length > remaining) return json(res, 400, { error: 'UPLOAD_CHUNK_INVALID' });
          await appendFile(uploadPath(id), chunk);
          const next = offset + chunk.length;
          await updateUpload(id, user.id, next);
          return json(res, 200, { uploadId: id, offset: next, length: Number(row.expected_size) });
          } finally { uploadLocks.delete(id); }
        }
        if (req.method === 'POST' && uploadMatch[2] === 'complete') {
          if (Number(row.received_size) !== Number(row.expected_size)) return json(res, 409, { error: 'UPLOAD_INCOMPLETE', offset: Number(row.received_size) });
          const tmp = uploadPath(id); const fileId = await hashFile(tmp); const target = pathFor(fileId);
          try { await stat(target); await unlink(tmp).catch(() => {}); } catch { await rename(tmp, target); }
          await deleteUpload(id);
          return json(res, 201, { id: fileId, size: Number(row.received_size) });
        }
        if (req.method === 'DELETE' && !uploadMatch[2]) {
          await deleteUpload(id, user.id);
          await unlink(uploadPath(id)).catch(() => {});
          return json(res, 200, { ok: true });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/files') {
        const now = Date.now();
        const recent = (uploadsByUser.get(user.id) || []).filter((time) => now - time < 60000);
        if (recent.length >= uploadLimit) return json(res, 429, { error: 'TOO_MANY_UPLOADS' });
        recent.push(now);
        uploadsByUser.set(user.id, recent);
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

  return { handle, close: () => { clearInterval(timer); uploadsByUser.clear(); uploadLocks.clear(); } };
}
