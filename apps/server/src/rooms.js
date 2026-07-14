// Segment rooms: channels, private chats, membership and invite links.
//
// This module owns rooms as first-class database entities and the REST surface
// that creates them, lists them, resolves deep links and redeems invites. It
// keeps a synchronous in-memory access index (hydrated from the database and
// updated on every mutation) so the WebSocket gateway can scope ciphertext relay
// to actual room membership without an async query per message.
//
// It never reads plaintext. Per-room sender-key rotation is a separate follow-up
// gated by docs/persistence-and-rooms.md; this module only decides *who* may
// receive a room's ciphertext, not how it is encrypted.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ChatType, ROOMS, SLUG_RE } from '@segment/protocol';

const ROOM_TYPES = new Set([ChatType.Chat, ChatType.Channel, ChatType.DM]);
const hashToken = (value) => createHash('sha256').update(value).digest('hex');

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
};
const readJson = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); } });
  req.on('error', reject);
});

const publicRoom = (row) => ({ id: row.id, type: row.type, slug: row.slug || '', title: row.title, icon: row.icon || '', isPublic: row.is_public, ownerId: row.owner_id, historyVisibility: row.history_visibility || 'joined' });

export async function createRooms(config, auth) {
  const pool = auth.pool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      type VARCHAR(16) NOT NULL,
      slug VARCHAR(32) UNIQUE,
      title VARCHAR(64) NOT NULL,
      icon VARCHAR(16) NOT NULL DEFAULT '',
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
      history_visibility VARCHAR(16) NOT NULL DEFAULT 'joined',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS history_visibility VARCHAR(16) NOT NULL DEFAULT 'joined';
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL DEFAULT 'member',
      join_seq BIGINT NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, user_id)
    );
    ALTER TABLE room_members ADD COLUMN IF NOT EXISTS join_seq BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);
    CREATE TABLE IF NOT EXISTS room_invites (
      token_hash TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0
    );
    -- Encrypted history envelopes. The server stores opaque ciphertext (encrypted
    -- to the room's history key, which it never holds) plus a monotonic per-room
    -- sequence used for ordering and join-point visibility gating.
    CREATE TABLE IF NOT EXISTS room_history (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      seq BIGINT NOT NULL,
      sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
      iv TEXT NOT NULL,
      ct TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, seq)
    );
  `);

  // Seed the legacy hardcoded rooms as public entities so existing clients keep
  // working. Public rooms need no membership row; everyone may access them.
  for (const room of ROOMS) {
    await pool.query(
      `INSERT INTO rooms(id,type,slug,title,icon,is_public) VALUES($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [room.id, room.type, room.id, room.name, room.icon],
    );
  }

  // In-memory access index for the gateway (single-process authoritative view).
  const publicRooms = new Set();          // roomId
  const members = new Map();              // roomId -> Set<userId>
  const existing = new Set();             // roomId
  const hydrate = async () => {
    publicRooms.clear(); members.clear(); existing.clear();
    for (const row of (await pool.query('SELECT id, is_public FROM rooms')).rows) {
      existing.add(row.id);
      if (row.is_public) publicRooms.add(row.id);
    }
    for (const row of (await pool.query('SELECT room_id, user_id FROM room_members')).rows) {
      if (!members.has(row.room_id)) members.set(row.room_id, new Set());
      members.get(row.room_id).add(row.user_id);
    }
  };
  await hydrate();

  const indexRoom = (row) => { existing.add(row.id); if (row.is_public) publicRooms.add(row.id); };
  const indexMember = (roomId, userId) => {
    if (!members.has(roomId)) members.set(roomId, new Set());
    members.get(roomId).add(userId);
  };

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;

  // Synchronous access decision used by the gateway on every ciphertext frame.
  const exists = (roomId) => existing.has(roomId);
  const canAccess = (userId, roomId) => publicRooms.has(roomId) || Boolean(members.get(roomId)?.has(userId));

  const listForUser = async (userId) => {
    const rows = (await pool.query(
      `SELECT DISTINCT r.* FROM rooms r
       LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = $1
       WHERE r.is_public = TRUE OR m.user_id = $1
       ORDER BY r.created_at`,
      [userId],
    )).rows;
    return rows.map(publicRoom);
  };

  const createRoom = async (owner, { type, title, slug }) => {
    const kind = ROOM_TYPES.has(type) ? type : ChatType.Chat;
    const cleanTitle = String(title || '').trim().slice(0, 64);
    if (!cleanTitle) throw Object.assign(new Error('TITLE_REQUIRED'), { status: 400 });
    const isPublic = kind === ChatType.Channel;
    let cleanSlug = null;
    if (isPublic) {
      cleanSlug = String(slug || '').trim().toLowerCase();
      if (!SLUG_RE.test(cleanSlug)) throw Object.assign(new Error('SLUG_INVALID'), { status: 400 });
      if (await one('SELECT 1 FROM rooms WHERE slug=$1', [cleanSlug])) throw Object.assign(new Error('SLUG_TAKEN'), { status: 409 });
    }
    const id = `${kind}-${randomUUID().slice(0, 8)}`;
    const icon = { [ChatType.DM]: '👤', [ChatType.Chat]: '💬', [ChatType.Channel]: '📢' }[kind];
    const row = await one(
      `INSERT INTO rooms(id,type,slug,title,icon,is_public,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, kind, cleanSlug, cleanTitle, icon, isPublic, owner.id],
    );
    await pool.query('INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,$3)', [id, owner.id, 'owner']);
    indexRoom(row); indexMember(id, owner.id);
    return publicRoom(row);
  };

  const createInvite = async (user, roomId) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const token = randomBytes(24).toString('base64url');
    const ttlMs = config.roomInviteTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    await pool.query(
      `INSERT INTO room_invites(token_hash,room_id,created_by,expires_at,max_uses)
       VALUES($1,$2,$3,NOW()+($4::text)::interval,$5)`,
      [hashToken(token), roomId, user.id, `${ttlMs} milliseconds`, 0],
    );
    return { token };
  };

  const redeemInvite = async (user, token) => {
    const invite = await one(
      'SELECT * FROM room_invites WHERE token_hash=$1 AND expires_at>NOW()',
      [hashToken(String(token || ''))],
    );
    if (!invite) throw Object.assign(new Error('INVITE_INVALID'), { status: 400 });
    if (invite.max_uses > 0 && invite.uses >= invite.max_uses) throw Object.assign(new Error('INVITE_EXHAUSTED'), { status: 410 });
    // Record the join point so 'joined' visibility hides history sent before it.
    await pool.query(
      `INSERT INTO room_members(room_id,user_id,join_seq)
       VALUES($1,$2,(SELECT COALESCE(MAX(seq),0) FROM room_history WHERE room_id=$1))
       ON CONFLICT DO NOTHING`,
      [invite.room_id, user.id],
    );
    await pool.query('UPDATE room_invites SET uses=uses+1 WHERE token_hash=$1', [invite.token_hash]);
    indexMember(invite.room_id, user.id);
    const room = await one('SELECT * FROM rooms WHERE id=$1', [invite.room_id]);
    return room ? publicRoom(room) : null;
  };

  // Append one encrypted history envelope; returns its assigned sequence.
  const appendHistory = async (user, roomId, iv, ct) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    if (typeof iv !== 'string' || iv.length > 256 || typeof ct !== 'string' || !ct.length || ct.length > 2 * 1024 * 1024) {
      throw Object.assign(new Error('ENVELOPE_INVALID'), { status: 400 });
    }
    const row = await one(
      `INSERT INTO room_history(room_id,seq,sender_id,iv,ct)
       VALUES($1,(SELECT COALESCE(MAX(seq),0)+1 FROM room_history WHERE room_id=$1),$2,$3,$4)
       RETURNING seq`,
      [roomId, user.id, iv, ct],
    );
    return { seq: Number(row.seq) };
  };

  // Backfill envelopes the caller may see. 'full' visibility exposes everything;
  // otherwise a member only sees messages after their recorded join point.
  const fetchHistory = async (user, roomId, after, limit) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const room = await one('SELECT history_visibility FROM rooms WHERE id=$1', [roomId]);
    const member = await one('SELECT join_seq FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, user.id]);
    const floor = room?.history_visibility === 'full' ? 0 : Number(member?.join_seq || 0);
    const lower = Math.max(Number(after) || 0, floor);
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const rows = (await pool.query(
      'SELECT seq, sender_id, iv, ct FROM room_history WHERE room_id=$1 AND seq>$2 ORDER BY seq LIMIT $3',
      [roomId, lower, cap],
    )).rows;
    return rows.map((r) => ({ seq: Number(r.seq), senderId: r.sender_id, iv: r.iv, ct: r.ct }));
  };

  // Turn on full-history visibility. One-way: only the owner, only joined -> full.
  const enableFullHistory = async (user, roomId) => {
    const row = await one(
      `UPDATE rooms SET history_visibility='full'
       WHERE id=$1 AND owner_id=$2 AND history_visibility<>'full' RETURNING *`,
      [roomId, user.id],
    );
    if (!row) {
      const room = await one('SELECT * FROM rooms WHERE id=$1', [roomId]);
      if (!room) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      if (room.owner_id !== user.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
      return publicRoom(room); // already 'full' — idempotent
    }
    return publicRoom(row);
  };

  const resolvePath = async (path) => {
    let match;
    if ((match = String(path).match(/^\/@([a-z0-9_]{3,24})$/i))) {
      const user = await one('SELECT id, username, name, color FROM users WHERE username=$1', [match[1].toLowerCase()]);
      return user ? { type: 'profile', user: { id: user.id, username: user.username, name: user.name, color: user.color } } : null;
    }
    if ((match = String(path).match(/^\/c\/([a-z0-9-]{3,32})$/i))) {
      const room = await one('SELECT * FROM rooms WHERE slug=$1 AND is_public=TRUE', [match[1].toLowerCase()]);
      return room ? { type: 'channel', room: publicRoom(room) } : null;
    }
    return null; // invite tokens are redeemed via POST, never resolved by GET
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://segment.local');
    if (!url.pathname.startsWith('/api/rooms')) return false;
    try {
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && config.production) {
        const origin = req.headers.origin;
        const allowed = new Set(config.allowedOrigins);
        if (config.publicUrl) { try { allowed.add(new URL(config.publicUrl).origin); } catch {} }
        if (!origin || !allowed.has(origin)) return json(res, 403, { error: 'ORIGIN_FORBIDDEN' });
      }
      const user = await auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'UNAUTHORIZED' });

      if (req.method === 'GET' && url.pathname === '/api/rooms/mine') {
        return json(res, 200, { rooms: await listForUser(user.id) });
      }
      if (req.method === 'GET' && url.pathname === '/api/rooms/resolve') {
        const target = await resolvePath(url.searchParams.get('path') || '');
        return json(res, target ? 200 : 404, target || { error: 'NOT_FOUND' });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJson(req);
        return json(res, 201, { room: await createRoom(user, body) });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/invite') {
        const body = await readJson(req);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 201, await createInvite(user, String(body.roomId)));
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/join') {
        const body = await readJson(req);
        const room = await redeemInvite(user, body.token);
        return json(res, 200, { room });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/history') {
        const body = await readJson(req, 4 * 1024 * 1024);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 201, await appendHistory(user, String(body.roomId), body.iv, body.ct));
      }
      if (req.method === 'GET' && url.pathname === '/api/rooms/history') {
        const roomId = url.searchParams.get('roomId') || '';
        if (!exists(roomId)) return json(res, 404, { error: 'NOT_FOUND' });
        const envelopes = await fetchHistory(user, roomId, url.searchParams.get('after'), url.searchParams.get('limit'));
        return json(res, 200, { envelopes });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/history/visibility') {
        const body = await readJson(req);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 200, { room: await enableFullHistory(user, String(body.roomId)) });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'rooms.request_failed', message: error.message }));
      return json(res, error.status || 500, { error: error.code === '23505' ? 'SLUG_TAKEN' : (error.message || 'INTERNAL_ERROR') });
    }
  };

  return { handle, exists, canAccess, listForUser, rehydrate: hydrate };
}
