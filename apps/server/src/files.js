// Segment file storage: an authenticated, content-addressed blob store on the
// VPS disk. This is the interim backend chosen while storage is tight; because
// uploads are client-encrypted, the store only ever holds opaque bytes and can
// later be swapped for Cloudflare R2 without a protocol change
// (see docs/persistence-and-rooms.md).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
};

export async function createFiles(config, auth, rooms = null) {
  const dir = config.fileDir;
  const maxBytes = config.fileMaxBytes;
  const ttlMs = config.fileTtlMs;
  const uploadLimit = config.fileUploadsPerMinute || 60;
  const accountQuotaBytes = 2 * 1024 * 1024 * 1024;
  const uploadsByUser = new Map();
  const claimsByUser = new Map();
  const uploadLocks = new Set();
  await mkdir(dir, { recursive: true });
  const uploadRows = new Map();
  const capabilityRows = new Map();
  if (auth.pool?.query) await auth.pool.query(`CREATE TABLE IF NOT EXISTS file_uploads (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT,
    expected_size BIGINT NOT NULL, received_size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS room_id TEXT;
  CREATE INDEX IF NOT EXISTS file_uploads_updated_idx ON file_uploads(updated_at);
  CREATE TABLE IF NOT EXISTS file_refs (
    file_id CHAR(64) NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(file_id,room_id)
  );
  CREATE TABLE IF NOT EXISTS file_blobs (
    file_id CHAR(64) PRIMARY KEY,
    size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unreferenced_until TIMESTAMPTZ
  );
  ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS unreferenced_until TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS file_capabilities (
    capability_id TEXT PRIMARY KEY,
    file_id CHAR(64) NOT NULL REFERENCES file_blobs(file_id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS file_migrations (
    name TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS file_refs_uploader_idx ON file_refs(uploader_id);
  CREATE INDEX IF NOT EXISTS file_capabilities_uploader_idx ON file_capabilities(uploader_id);
  CREATE INDEX IF NOT EXISTS file_capabilities_file_idx ON file_capabilities(file_id);`);
  const migrateLegacyBlobs = async () => {
    if (!auth.pool?.query || (await auth.pool.query("SELECT 1 FROM file_migrations WHERE name='legacy-blobs-v1'")).rowCount) return;
    const names = (await readdir(dir)).filter((name) => HEX64.test(name));
    for (let offset = 0; offset < names.length; offset += 250) {
      const chunk = names.slice(offset, offset + 250);
      const rows = (await Promise.all(chunk.map(async (fileId) => {
        try { return { fileId, size: (await stat(join(dir, fileId))).size }; } catch { return null; }
      }))).filter(Boolean);
      if (!rows.length) continue;
      const values = rows.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2},NOW()+INTERVAL '30 days')`).join(',');
      await auth.pool.query(`INSERT INTO file_blobs(file_id,size,unreferenced_until) VALUES${values} ON CONFLICT(file_id) DO NOTHING`, rows.flatMap((row) => [row.fileId, row.size]));
    }
    await auth.pool.query("INSERT INTO file_migrations(name) VALUES('legacy-blobs-v1') ON CONFLICT(name) DO NOTHING");
  };
  let migrationResolve;
  const migration = new Promise((resolve) => { migrationResolve = resolve; });
  setImmediate(() => migrateLegacyBlobs().catch((error) => {
    console.error(JSON.stringify({ level:'error', event:'files.legacy_migration_failed', message:error.message }));
  }).finally(migrationResolve));
  const createUpload = async (row) => {
    if (auth.pool?.query) await auth.pool.query('INSERT INTO file_uploads(id,user_id,room_id,expected_size) VALUES($1,$2,$3,$4)', [row.id, row.user_id, row.room_id, row.expected_size]);
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
  const quotaUsed = async (userId) => {
    if (!auth.pool?.query) return 0;
    const row = (await auth.pool.query(`SELECT
      COALESCE((SELECT SUM(size) FROM file_capabilities WHERE uploader_id=$1),0)
      + COALESCE((SELECT SUM(size) FROM file_refs WHERE uploader_id=$1),0) AS size`, [userId])).rows[0];
    return Number(row?.size || 0);
  };
  const createCapability = async ({ fileId, roomId, uploaderId, size }) => {
    const capabilityId = randomBytes(32).toString('base64url');
    if (auth.pool?.query) await auth.pool.query(`INSERT INTO file_capabilities(capability_id,file_id,room_id,uploader_id,size)
      VALUES($1,$2,$3,$4,$5)`, [capabilityId, fileId, roomId, uploaderId, size]);
    else capabilityRows.set(capabilityId, { file_id:fileId, room_id:roomId, uploader_id:uploaderId, size });
    return capabilityId;
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
  const deleteOrphanBlobs = async (candidateIds = null) => {
    if (!auth.pool?.query) return;
    if (candidateIds && !candidateIds.length) return;
    let orphanIds;
    if (candidateIds) {
      const placeholders = candidateIds.map((_, index) => `$${index + 1}`).join(',');
      const blobs = (await auth.pool.query(`SELECT file_id FROM file_blobs WHERE file_id IN (${placeholders})
        AND (unreferenced_until IS NULL OR unreferenced_until<NOW())`, candidateIds)).rows.map((row) => String(row.file_id).trim());
      const referenced = new Set((await auth.pool.query(`SELECT file_id FROM file_refs WHERE file_id IN (${placeholders})
        UNION SELECT file_id FROM file_capabilities WHERE file_id IN (${placeholders})`, candidateIds)).rows.map((row) => String(row.file_id).trim()));
      orphanIds = blobs.filter((fileId) => !referenced.has(fileId));
    } else {
      orphanIds = (await auth.pool.query(`SELECT b.file_id FROM file_blobs b
        LEFT JOIN file_refs r ON r.file_id=b.file_id
        LEFT JOIN file_capabilities c ON c.file_id=b.file_id
        WHERE r.file_id IS NULL AND c.file_id IS NULL
          AND (b.unreferenced_until IS NULL OR b.unreferenced_until<NOW())`)).rows.map((row) => String(row.file_id).trim());
    }
    if (!orphanIds.length) return;
    const placeholders = orphanIds.map((_, index) => `$${index + 1}`).join(',');
    const removed = await auth.pool.query(`DELETE FROM file_blobs WHERE file_id IN (${placeholders}) RETURNING file_id`, orphanIds);
    await Promise.all(removed.rows.map(async (row) => {
      try { await unlink(pathFor(String(row.file_id).trim())); }
      catch (error) { if (error.code !== 'ENOENT') console.error(JSON.stringify({ level:'error', event:'files.orphan_unlink_failed', message:error.message })); }
    }));
  };

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
          let created = false;
          try { await stat(target); await unlink(tmp).catch(() => {}); } // already stored: drop the temp
          catch { await rename(tmp, target); created = true; }
          resolve({ id, size, created });
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
    for (const [userId, requests] of claimsByUser) {
      const recent = requests.filter((time) => Date.now() - time < 3600000);
      if (recent.length) claimsByUser.set(userId, recent); else claimsByUser.delete(userId);
    }
    const staleUploads = auth.pool?.query
      ? (await auth.pool.query("DELETE FROM file_uploads WHERE updated_at < NOW()-INTERVAL '24 hours' RETURNING id")).rows
      : [...uploadRows.values()].filter((row) => Date.now() - new Date(row.updated_at).getTime() > 86400000);
    if (!auth.pool?.query) for (const upload of staleUploads) uploadRows.delete(upload.id);
    for (const upload of staleUploads) await unlink(uploadPath(upload.id)).catch(() => {});
    await deleteOrphanBlobs();
    // Database-backed blobs are retained strictly by capabilities/references.
    // A wall-clock TTL must never delete a still-referenced attachment.
    if (!ttlMs || auth.pool?.query) return;
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
        const roomId = String(req.headers['upload-room'] || '');
        if (rooms && (!roomId || !rooms.canAccess(user.id, roomId))) return json(res, 403, { error: 'ROOM_FORBIDDEN' });
        if (auth.pool?.query) {
          const used = await quotaUsed(user.id);
          if (used + expected > accountQuotaBytes) return json(res, 413, { error: 'STORAGE_QUOTA_EXCEEDED' });
        }
        const id = randomUUID();
        await createUpload({ id, user_id: user.id, room_id: roomId, expected_size: expected });
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
          if (uploadLocks.has(id)) return json(res, 409, { error: 'UPLOAD_BUSY', offset: Number(row.received_size) });
          uploadLocks.add(id);
          try {
            const current = await findUpload(id, user.id);
            if (!current) return json(res, 404, { error: 'UPLOAD_NOT_FOUND' });
            if (Number(current.received_size) !== Number(current.expected_size)) return json(res, 409, { error: 'UPLOAD_INCOMPLETE', offset: Number(current.received_size) });
            const tmp = uploadPath(id); const fileId = await hashFile(tmp); const target = pathFor(fileId);
            if (auth.pool?.query) {
              const used = await quotaUsed(user.id);
              if (used + Number(current.received_size) > accountQuotaBytes) {
                await deleteUpload(id); await unlink(tmp).catch(() => {});
                return json(res, 413, { error: 'STORAGE_QUOTA_EXCEEDED' });
              }
            }
            try { await stat(target); await unlink(tmp).catch(() => {}); } catch { await rename(tmp, target); }
            if (auth.pool?.query) await auth.pool.query("INSERT INTO file_blobs(file_id,size,unreferenced_until) VALUES($1,$2,NOW()+INTERVAL '1 hour') ON CONFLICT(file_id) DO NOTHING", [fileId, Number(current.received_size)]);
            const capabilityId = await createCapability({ fileId, roomId:current.room_id, uploaderId:user.id, size:Number(current.received_size) });
            if (auth.pool?.query) await auth.pool.query('UPDATE file_blobs SET unreferenced_until=NULL WHERE file_id=$1', [fileId]);
            await deleteUpload(id);
            return json(res, 201, { id: capabilityId, size: Number(current.received_size) });
          } finally { uploadLocks.delete(id); }
        }
        if (req.method === 'DELETE' && !uploadMatch[2]) {
          if (uploadLocks.has(id)) return json(res, 409, { error: 'UPLOAD_BUSY', offset: Number(row.received_size) });
          uploadLocks.add(id);
          try {
            await deleteUpload(id, user.id);
            await unlink(uploadPath(id)).catch(() => {});
            return json(res, 200, { ok: true });
          } finally { uploadLocks.delete(id); }
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/files') {
        const roomId = String(url.searchParams.get('roomId') || '');
        if (rooms && (!roomId || !rooms.canAccess(user.id, roomId))) return json(res, 403, { error: 'ROOM_FORBIDDEN' });
        if (auth.pool?.query) {
          const incoming = Number(req.headers['content-length'] || 0);
          const used = await quotaUsed(user.id);
          if (incoming > 0 && used + incoming > accountQuotaBytes) return json(res, 413, { error: 'STORAGE_QUOTA_EXCEEDED' });
        }
        const now = Date.now();
        const recent = (uploadsByUser.get(user.id) || []).filter((time) => now - time < 60000);
        if (recent.length >= uploadLimit) return json(res, 429, { error: 'TOO_MANY_UPLOADS' });
        recent.push(now);
        uploadsByUser.set(user.id, recent);
        const stored = await put(req);
        if (auth.pool?.query) {
          const used = await quotaUsed(user.id);
          if (used + stored.size > accountQuotaBytes) {
            if (stored.created) await unlink(pathFor(stored.id)).catch(() => {});
            return json(res, 413, { error: 'STORAGE_QUOTA_EXCEEDED' });
          }
        }
        if (auth.pool?.query) await auth.pool.query("INSERT INTO file_blobs(file_id,size,unreferenced_until) VALUES($1,$2,NOW()+INTERVAL '1 hour') ON CONFLICT(file_id) DO NOTHING", [stored.id, stored.size]);
        const capabilityId = await createCapability({ fileId:stored.id, roomId, uploaderId:user.id, size:stored.size });
        if (auth.pool?.query) await auth.pool.query('UPDATE file_blobs SET unreferenced_until=NULL WHERE file_id=$1', [stored.id]);
        return json(res, 201, { id: capabilityId, size: stored.size });
      }
      if (req.method === 'POST' && url.pathname === '/api/files/refs/claim') {
        const body = await readBody(req, 64 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'INVALID_JSON' }); }
        const roomId = String(parsed.roomId || '');
        const ids = [...new Set(Array.isArray(parsed.fileIds) ? parsed.fileIds.map(String).filter((id) => HEX64.test(id)) : [])].slice(0, 200);
        const claims = (claimsByUser.get(user.id) || []).filter((time) => Date.now() - time < 3600000);
        if (claims.length >= 20) return json(res, 429, { error: 'TOO_MANY_CLAIMS' });
        if (!ids.length || !rooms || rooms.ownerId?.(roomId) !== user.id || rooms.isPublic?.(roomId)) return json(res, 403, { error: 'ROOM_FORBIDDEN' });
        claims.push(Date.now()); claimsByUser.set(user.id, claims);
        if (auth.pool?.query) {
          const placeholders = ids.map((_, index) => `$${index + 3}`).join(',');
          const inserted = await auth.pool.query(`INSERT INTO file_refs(file_id,room_id,uploader_id,size)
            SELECT file_id,$1,$2,size FROM file_blobs
            WHERE file_id IN (${placeholders}) AND unreferenced_until>NOW()
            ON CONFLICT(file_id,room_id) DO NOTHING RETURNING file_id`, [roomId, user.id, ...ids]);
          const claimed = inserted.rows.map((row) => String(row.file_id).trim());
          if (claimed.length) {
            const claimedPlaceholders = claimed.map((_, index) => `$${index + 1}`).join(',');
            await auth.pool.query(`UPDATE file_blobs SET unreferenced_until=NULL WHERE file_id IN (${claimedPlaceholders})`, claimed);
          }
          return json(res, 200, { ok: true, claimed: claimed.length });
        }
        return json(res, 200, { ok: true, claimed: 0 });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/files/refs') {
        const body = await readBody(req, 64 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'INVALID_JSON' }); }
        const roomId = String(parsed.roomId || '');
        const ids = [...new Set(Array.isArray(parsed.fileIds) ? parsed.fileIds.map(String).filter((id) => HEX64.test(id) || CAPABILITY.test(id)) : [])].slice(0, 200);
        if (!ids.length || (rooms && !rooms.canAccess(user.id, roomId))) return json(res, 403, { error: 'ROOM_FORBIDDEN' });
        if (auth.pool?.query) {
          const owner = rooms?.ownerId?.(roomId) === user.id;
          const caps = ids.filter((id) => CAPABILITY.test(id));
          const legacyIds = ids.filter((id) => HEX64.test(id));
          const physical = [];
          if (caps.length) {
            const placeholders = caps.map((_, index) => `$${index + 4}`).join(',');
            const removed = await auth.pool.query(`DELETE FROM file_capabilities WHERE room_id=$1
              AND (uploader_id=$2 OR $3::boolean) AND capability_id IN (${placeholders}) RETURNING file_id`, [roomId, user.id, owner, ...caps]);
            physical.push(...removed.rows.map((row) => String(row.file_id).trim()));
          }
          if (legacyIds.length) {
            await auth.pool.query('DELETE FROM file_refs WHERE room_id=$1 AND file_id=ANY($2) AND (uploader_id=$3 OR $4::boolean)', [roomId, legacyIds, user.id, owner]);
            physical.push(...legacyIds);
          }
          await deleteOrphanBlobs([...new Set(physical)]);
        } else {
          for (const id of ids) capabilityRows.delete(id);
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const id = url.pathname.slice('/api/files/'.length);
        if (!HEX64.test(id) && !CAPABILITY.test(id)) return json(res, 404, { error: 'NOT_FOUND' });
        let fileId = id;
        if (CAPABILITY.test(id)) {
          const capability = auth.pool?.query
            ? (await auth.pool.query('SELECT file_id,room_id FROM file_capabilities WHERE capability_id=$1', [id])).rows[0]
            : capabilityRows.get(id);
          if (!capability) return json(res, 404, { error: 'NOT_FOUND' });
          // Holding the capability proves the caller once decrypted an envelope
          // carrying it, but membership can be revoked afterwards. Re-check it so
          // a removed member cannot keep fetching attachments they never opened.
          if (rooms && !rooms.canAccess(user.id, String(capability.room_id || ''))) return json(res, 403, { error: 'ROOM_FORBIDDEN' });
          fileId = String(capability.file_id).trim();
        } else {
          const roomId = String(url.searchParams.get('roomId') || '');
          if (rooms && (!roomId || !rooms.canAccess(user.id, roomId))) return json(res, 403, { error: 'ROOM_FORBIDDEN' });
          if (auth.pool?.query) {
            const ref = await auth.pool.query('SELECT 1 FROM file_refs WHERE file_id=$1 AND room_id=$2', [id, roomId]);
            if (!ref.rowCount) return json(res, 404, { error: 'NOT_FOUND' });
          }
        }
        let info;
        try { info = await stat(pathFor(fileId)); } catch { return json(res, 404, { error: 'NOT_FOUND' }); }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': info.size,
          'Cache-Control': 'private, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        const stream = createReadStream(pathFor(fileId));
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
      const safe = error.status && /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'INTERNAL_ERROR';
      return json(res, error.status || 500, { error: safe });
    }
  };

  return { handle, migration, close: () => { clearInterval(timer); uploadsByUser.clear(); claimsByUser.clear(); uploadLocks.clear(); } };
}
