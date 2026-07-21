// Segment rooms: channels, private chats, membership and invite links.
//
// This module owns rooms as first-class database entities and the REST surface
// that creates them, lists them, resolves deep links and redeems invites. It
// keeps a synchronous in-memory access index (hydrated from the database and
// updated on every mutation) so the WebSocket gateway can scope ciphertext relay
// to actual room membership without an async query per message.
//
// It never reads plaintext. Membership changes are announced to the gateway so
// the room owner can rotate its client-held history key after joins and leaves.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ChatType, ROOMS, RETIRED_ROOM_IDS, SLUG_RE } from '@segment/protocol';

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

const publicRoom = (row) => ({ id: row.id, type: row.type, slug: row.slug || '', title: row.title, icon: row.icon || '', isPublic: row.is_public, ownerId: row.owner_id, historyKey: row.is_public ? (row.history_key || '') : '', historyVisibility: row.history_visibility || 'joined', membershipEpoch: Number(row.membership_epoch || 1) });
const profileFieldVisible = (privacy, field, self, shared) => {
  const scope = privacy && typeof privacy === 'object' ? (privacy[field] || 'everyone') : 'everyone';
  return self || scope === 'everyone' || (scope === 'members' && shared);
};

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
      history_key TEXT,
      history_seq BIGINT NOT NULL DEFAULT 0,
      membership_epoch BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS history_visibility VARCHAR(16) NOT NULL DEFAULT 'joined';
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS history_key TEXT;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS history_seq BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS membership_epoch BIGINT NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL DEFAULT 'member',
      join_seq BIGINT NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, user_id)
    );
    ALTER TABLE room_members ADD COLUMN IF NOT EXISTS join_seq BIGINT NOT NULL DEFAULT 0;
    -- Per-member "clear history": hides everything up to this sequence from THIS
    -- member's backfill without destroying anyone else's copy.
    ALTER TABLE room_members ADD COLUMN IF NOT EXISTS cleared_seq BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);
    CREATE TABLE IF NOT EXISTS room_invites (
      token_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE room_invites ADD COLUMN IF NOT EXISTS id TEXT;
    UPDATE room_invites SET id=token_hash WHERE id IS NULL;
    ALTER TABLE room_invites ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
    ALTER TABLE room_invites ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    UPDATE room_invites SET max_uses=20 WHERE max_uses=0 AND expires_at>NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS room_invites_id_idx ON room_invites(id);
    CREATE INDEX IF NOT EXISTS room_invites_expires_at_idx ON room_invites(expires_at);
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
    ALTER TABLE room_history ADD COLUMN IF NOT EXISTS client_event_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS room_history_event_idx
      ON room_history(room_id, client_event_id) WHERE client_event_id IS NOT NULL;
  `);
  await pool.query("ALTER TABLE room_history ADD COLUMN IF NOT EXISTS key_id VARCHAR(32) NOT NULL DEFAULT ''");

  // Bring the atomic per-room counter forward when upgrading an existing
  // database that already contains history rows.
  for (const row of (await pool.query('SELECT room_id, MAX(seq) AS seq FROM room_history GROUP BY room_id')).rows) {
    await pool.query('UPDATE rooms SET history_seq=GREATEST(history_seq,$2) WHERE id=$1', [row.room_id, row.seq]);
  }

  // Drop retired rooms. ON DELETE CASCADE takes their history, members and
  // invites with them, so the room is gone for everyone, not just for one client.
  if (RETIRED_ROOM_IDS.length) {
    const removed = await pool.query('DELETE FROM rooms WHERE id = ANY($1) RETURNING id', [RETIRED_ROOM_IDS]);
    for (const row of removed.rows) {
      console.log(JSON.stringify({ level: 'info', event: 'rooms.retired', room: row.id }));
    }
  }

  // Seed the legacy hardcoded rooms as public entities so existing clients keep
  // working. Public rooms need no membership row; everyone may access them.
  for (const room of ROOMS) {
    await pool.query(
      `INSERT INTO rooms(id,type,slug,title,icon,is_public) VALUES($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [room.id, room.type, room.id, room.name, room.icon],
    );
  }
  // Seeded public rooms have no owner who could publish a history key. Their
  // content is public by definition, so a server-distributed room key lets every
  // signed-in client decrypt the same durable history without weakening private
  // room keys.
  for (const row of (await pool.query('SELECT id FROM rooms WHERE is_public=TRUE AND owner_id IS NULL AND history_key IS NULL')).rows) {
    await pool.query('UPDATE rooms SET history_key=$2 WHERE id=$1 AND history_key IS NULL', [row.id, randomBytes(32).toString('base64')]);
  }

  // In-memory access index for the gateway (single-process authoritative view).
  const publicRooms = new Set();          // roomId
  const members = new Map();              // roomId -> Set<userId>
  const existing = new Set();             // roomId
  const owners = new Map();                // roomId -> userId
  const epochs = new Map();                // roomId -> membership epoch
  const membershipListeners = new Set();
  const emitMembership = (change) => { for (const listener of membershipListeners) { try { listener(change); } catch {} } };
  const hydrate = async () => {
    publicRooms.clear(); members.clear(); existing.clear(); owners.clear(); epochs.clear();
    for (const row of (await pool.query('SELECT id, is_public, owner_id, membership_epoch FROM rooms')).rows) {
      existing.add(row.id);
      if (row.is_public) publicRooms.add(row.id);
      if (row.owner_id) owners.set(row.id, row.owner_id);
      epochs.set(row.id, Number(row.membership_epoch || 1));
    }
    for (const row of (await pool.query('SELECT room_id, user_id FROM room_members')).rows) {
      if (!members.has(row.room_id)) members.set(row.room_id, new Set());
      members.get(row.room_id).add(row.user_id);
    }
  };
  await hydrate();

  const indexRoom = (row) => { existing.add(row.id); if (row.is_public) publicRooms.add(row.id); if (row.owner_id) owners.set(row.id, row.owner_id); epochs.set(row.id, Number(row.membership_epoch || 1)); };
  const indexMember = (roomId, userId) => {
    if (!members.has(roomId)) members.set(roomId, new Set());
    members.get(roomId).add(userId);
  };

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;

  // Synchronous access decision used by the gateway on every ciphertext frame.
  const exists = (roomId) => existing.has(roomId);
  const canAccess = (userId, roomId) => publicRooms.has(roomId) || Boolean(members.get(roomId)?.has(userId));
  const roomEpoch = (roomId) => epochs.get(roomId) || 1;
  const epochsFor = (userId) => Object.fromEntries([...epochs].filter(([roomId]) => canAccess(userId, roomId)));

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

  const cleanRoomIcon = (value, fallback = '') => String(value || '').trim().slice(0, 16) || fallback;

  const createRoom = async (owner, { type, title, slug, icon: requestedIcon }) => {
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
    const icon = cleanRoomIcon(requestedIcon, { [ChatType.DM]: '👤', [ChatType.Chat]: '💬', [ChatType.Channel]: '📢' }[kind]);
    const row = await one(
      `INSERT INTO rooms(id,type,slug,title,icon,is_public,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, kind, cleanSlug, cleanTitle, icon, isPublic, owner.id],
    );
    await pool.query('INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,$3)', [id, owner.id, 'owner']);
    indexRoom(row); indexMember(id, owner.id);
    return publicRoom(row);
  };

  const updateRoom = async (user, { roomId, title, icon }) => {
    const room = await one('SELECT * FROM rooms WHERE id=$1', [roomId]);
    if (!room) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    if (room.owner_id !== user.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const cleanTitle = title == null ? room.title : String(title).trim().slice(0, 64);
    if (!cleanTitle) throw Object.assign(new Error('TITLE_REQUIRED'), { status: 400 });
    const cleanIcon = icon == null ? room.icon : cleanRoomIcon(icon, room.icon);
    const updated = await one('UPDATE rooms SET title=$2, icon=$3 WHERE id=$1 RETURNING *', [roomId, cleanTitle, cleanIcon]);
    return publicRoom(updated);
  };

  const createInvite = async (user, roomId) => {
    if (owners.get(roomId) !== user.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const token = randomBytes(24).toString('base64url');
    const ttlMs = config.roomInviteTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    const created = await one(
      `INSERT INTO room_invites(token_hash,id,room_id,created_by,expires_at,max_uses)
       VALUES($1,$2,$3,$4,NOW()+($5::text)::interval,$6) RETURNING id,expires_at,max_uses`,
      [hashToken(token), randomUUID(), roomId, user.id, `${ttlMs} milliseconds`, 20],
    );
    return { token, id: created.id, expiresAt: created.expires_at, maxUses: created.max_uses };
  };
  const listInvites = async (user, roomId) => {
    if (owners.get(roomId) !== user.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    return (await pool.query(`SELECT id,expires_at,max_uses,uses,created_at FROM room_invites
      WHERE room_id=$1 AND revoked_at IS NULL AND expires_at>NOW() AND (max_uses=0 OR uses<max_uses)
      ORDER BY created_at DESC`, [roomId])).rows;
  };
  const revokeInvite = async (user, roomId, inviteId) => {
    if (owners.get(roomId) !== user.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const revoked = await pool.query('UPDATE room_invites SET revoked_at=NOW() WHERE id=$1 AND room_id=$2 AND revoked_at IS NULL RETURNING id', [inviteId, roomId]);
    if (!revoked.rowCount) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    return { ok: true };
  };

  const claimPublicHistoryKey = async (user, roomId, key) => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw Object.assign(new Error('KEY_INVALID'), { status: 400 });
    const room = await one('SELECT * FROM rooms WHERE id=$1', [roomId]);
    if (!room) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    if (!room.is_public || room.owner_id !== user.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const updated = await one('UPDATE rooms SET history_key=COALESCE(history_key,$2) WHERE id=$1 RETURNING *', [roomId, key]);
    return publicRoom(updated);
  };

  const redeemInvite = async (user, token) => {
    const tokenHash = hashToken(String(token || ''));
    const connection = await pool.connect();
    let invite; let joined = false; let changedEpoch = 0;
    try {
      await connection.query('BEGIN');
      invite = (await connection.query(
        'SELECT * FROM room_invites WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE',
        [tokenHash],
      )).rows[0] || null;
      if (!invite) throw Object.assign(new Error('INVITE_INVALID'), { status: 400 });
      if (invite.max_uses > 0 && invite.uses >= invite.max_uses) throw Object.assign(new Error('INVITE_EXHAUSTED'), { status: 410 });
      const inserted = await connection.query(
        `INSERT INTO room_members(room_id,user_id,join_seq)
         VALUES($1,$2,(SELECT COALESCE(MAX(seq),0) FROM room_history WHERE room_id=$1))
         ON CONFLICT DO NOTHING RETURNING room_id`,
        [invite.room_id, user.id],
      );
      joined = inserted.rowCount > 0;
      if (joined) {
        await connection.query('UPDATE room_invites SET uses=uses+1 WHERE token_hash=$1', [tokenHash]);
        const changed = (await connection.query('UPDATE rooms SET membership_epoch=membership_epoch+1 WHERE id=$1 RETURNING membership_epoch', [invite.room_id])).rows[0];
        changedEpoch = Number(changed?.membership_epoch || 0);
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { connection.release(); }
    indexMember(invite.room_id, user.id);
    if (joined) epochs.set(invite.room_id, Math.max(roomEpoch(invite.room_id), changedEpoch || roomEpoch(invite.room_id) + 1));
    if (joined) emitMembership({ roomId: invite.room_id, userId: user.id, action: 'joined', epoch: roomEpoch(invite.room_id) });
    const room = await one('SELECT * FROM rooms WHERE id=$1', [invite.room_id]);
    return room ? { ...publicRoom(room), joined } : null;
  };

  // Append one encrypted history envelope; returns its assigned sequence.
  const appendHistory = async (user, roomId, epoch, eventId, iv, ct, keyId = '') => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    if (!Number.isSafeInteger(Number(epoch)) || Number(epoch) !== roomEpoch(roomId)) {
      throw Object.assign(new Error('STALE_ROOM_EPOCH'), { status: 409 });
    }
    if (typeof iv !== 'string' || iv.length > 256 || typeof ct !== 'string' || !ct.length || ct.length > 2 * 1024 * 1024) {
      throw Object.assign(new Error('ENVELOPE_INVALID'), { status: 400 });
    }
    const stableId = typeof eventId === 'string' && /^[A-Za-z0-9_-]{6,96}$/.test(eventId) ? eventId : null;
    if (stableId) {
      const existingEvent = await one('SELECT seq FROM room_history WHERE room_id=$1 AND client_event_id=$2', [roomId, stableId]);
      if (existingEvent) return { seq: Number(existingEvent.seq), duplicate: true };
    }
    const assigned = await one('UPDATE rooms SET history_seq=history_seq+1 WHERE id=$1 RETURNING history_seq', [roomId]);
    if (!assigned) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    try {
      const row = await one(
        `INSERT INTO room_history(room_id,seq,sender_id,client_event_id,iv,ct,key_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING seq`,
        [roomId, assigned.history_seq, user.id, stableId, iv, ct, String(keyId || '').slice(0, 32)],
      );
      return { seq: Number(row.seq), duplicate: false };
    } catch (error) {
      if (error.code === '23505' && stableId) {
        const duplicate = await one('SELECT seq FROM room_history WHERE room_id=$1 AND client_event_id=$2', [roomId, stableId]);
        if (duplicate) return { seq: Number(duplicate.seq), duplicate: true };
      }
      throw error;
    }
  };

  // Backfill envelopes the caller may see. 'full' visibility exposes everything;
  // otherwise a member only sees messages after their recorded join point.
  const fetchHistory = async (user, roomId, after, limit) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const room = await one('SELECT history_visibility FROM rooms WHERE id=$1', [roomId]);
    const member = await one('SELECT join_seq, cleared_seq FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, user.id]);
    // 'full' exposes everything from the start, but a member's own "clear history"
    // always still applies to them.
    const joinFloor = room?.history_visibility === 'full' ? 0 : Number(member?.join_seq || 0);
    const floor = Math.max(joinFloor, Number(member?.cleared_seq || 0));
    const lower = Math.max(Number(after) || 0, floor);
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const sharedIds = new Set((await pool.query(
      `SELECT other.user_id FROM room_members mine JOIN room_members other ON other.room_id=mine.room_id
       WHERE mine.user_id=$1`, [user.id],
    )).rows.map((row) => row.user_id));
    const rows = (await pool.query(
      `SELECT h.seq,h.sender_id,h.iv,h.ct,h.key_id,u.name AS sender_name,u.username AS sender_username,
              u.avatar AS sender_avatar,u.color AS sender_color,u.privacy AS sender_privacy
       FROM room_history h LEFT JOIN users u ON u.id=h.sender_id
       WHERE h.room_id=$1 AND h.seq>$2 ORDER BY h.seq LIMIT $3`,
      [roomId, lower, cap],
    )).rows;
    return rows.map((r) => ({
      seq: Number(r.seq), senderId: r.sender_id, keyId: r.key_id || '', iv: r.iv, ct: r.ct,
      senderName: r.sender_name || '', senderUsername: r.sender_username || '',
      senderAvatar: r.sender_avatar && profileFieldVisible(r.sender_privacy, 'avatar', r.sender_id === user.id, sharedIds.has(r.sender_id))
        ? `/api/auth/avatar/${r.sender_id}` : '', senderColor: r.sender_color || '',
    }));
  };

  // Removing a room means two different things, so say which one happened:
  //  - the owner DELETES it: the row goes, and ON DELETE CASCADE takes the
  //    history, members and invites with it. Gone for everyone, unrecoverable.
  //  - anyone else LEAVES it: only their membership row goes. They lose access
  //    (the relay stops delivering to them, backfill refuses them), while the
  //    other members keep the room and their history.
  // Public rooms have no membership to drop and no owner, so they cannot be
  // removed this way; the client just hides them locally.
  const removeRoom = async (user, roomId) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const room = await one('SELECT owner_id, is_public FROM rooms WHERE id=$1', [roomId]);
    if (!room) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    if (room.is_public) throw Object.assign(new Error('PUBLIC_ROOM'), { status: 400 });

    if (room.owner_id === user.id) {
      await pool.query('DELETE FROM rooms WHERE id=$1', [roomId]);
      existing.delete(roomId); publicRooms.delete(roomId); members.delete(roomId); owners.delete(roomId); epochs.delete(roomId);
      return { deleted: true };
    }
    await pool.query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, user.id]);
    members.get(roomId)?.delete(user.id);
    const changed = await one('UPDATE rooms SET membership_epoch=membership_epoch+1 WHERE id=$1 RETURNING membership_epoch', [roomId]);
    epochs.set(roomId, Math.max(roomEpoch(roomId), Number(changed?.membership_epoch || roomEpoch(roomId) + 1)));
    emitMembership({ roomId, userId: user.id, action: 'left', epoch: roomEpoch(roomId) });
    return { deleted: false, left: true };
  };

  // Erase one stored envelope for good, so a deleted message cannot come back on
  // anyone's next backfill. Allowed for its author, or for the room owner.
  const deleteEnvelope = async (user, roomId, seq) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    if (!Number.isSafeInteger(Number(seq)) || Number(seq) <= 0) throw Object.assign(new Error('SEQ_INVALID'), { status: 400 });
    const room = await one('SELECT owner_id FROM rooms WHERE id=$1', [roomId]);
    const row = await one(
      `DELETE FROM room_history WHERE room_id=$1 AND seq=$2 AND (sender_id=$3 OR $4::boolean)
       RETURNING seq`,
      [roomId, Number(seq), user.id, room?.owner_id === user.id],
    );
    if (!row) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    return { seq: Number(row.seq) };
  };

  // Clear history for the caller only: their future backfills start after the
  // current end of the log. Other members keep their copies.
  const clearHistoryFor = async (user, roomId) => {
    if (!canAccess(user.id, roomId)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    const top = await one('SELECT COALESCE(MAX(seq),0) AS seq FROM room_history WHERE room_id=$1', [roomId]);
    const clearedSeq = Number(top?.seq || 0);
    await pool.query(
      `INSERT INTO room_members(room_id,user_id,join_seq,cleared_seq) VALUES($1,$2,$3,$3)
       ON CONFLICT (room_id,user_id) DO UPDATE SET cleared_seq=EXCLUDED.cleared_seq`,
      [roomId, user.id, clearedSeq],
    );
    indexMember(roomId, user.id);
    return { clearedSeq };
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

  const resolvePath = async (path, viewerId) => {
    let match;
    if ((match = String(path).match(/^\/@([a-z0-9_]{3,24})$/i))) {
      const user = await one('SELECT id, username, name, color, avatar, bio, status, profile_links, profile_meta, privacy FROM users WHERE username=$1', [match[1].toLowerCase()]);
      if (!user) return null;
      const self = user.id === viewerId;
      const shared = self || Boolean(await one(
        `SELECT 1 FROM room_members mine JOIN room_members other ON other.room_id=mine.room_id
         WHERE mine.user_id=$1 AND other.user_id=$2 LIMIT 1`,
        [viewerId, user.id],
      ));
      const privacy = user.privacy && typeof user.privacy === 'object' ? user.privacy : {};
      const visible = (field) => profileFieldVisible(privacy, field, self, shared);
      const profile = user.profile_meta && typeof user.profile_meta === 'object' ? { ...user.profile_meta } : {};
      if (!self) delete profile.publicationArchive;
      return { type: 'profile', user: {
        id: user.id, username: user.username, name: user.name, color: user.color,
        avatar: visible('avatar') ? user.avatar : '', bio: visible('bio') ? user.bio : '',
        status: visible('status') ? user.status : '', links: visible('links') && Array.isArray(user.profile_links) ? user.profile_links : [],
        profile,
      } };
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
        const target = await resolvePath(url.searchParams.get('path') || '', user.id);
        return json(res, target ? 200 : 404, target || { error: 'NOT_FOUND' });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJson(req);
        return json(res, 201, { room: await createRoom(user, body) });
      }
      if (req.method === 'PATCH' && url.pathname === '/api/rooms') {
        const body = await readJson(req);
        return json(res, 200, { room: await updateRoom(user, { ...body, roomId: String(body.roomId || '') }) });
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
        return json(res, 201, await appendHistory(user, String(body.roomId), body.epoch, body.eventId, body.iv, body.ct, body.keyId));
      }
      if (req.method === 'GET' && url.pathname === '/api/rooms/invites') {
        const roomId = String(url.searchParams.get('roomId') || '');
        return json(res, 200, { invites: await listInvites(user, roomId) });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/rooms/invite') {
        const body = await readJson(req);
        return json(res, 200, await revokeInvite(user, String(body.roomId || ''), String(body.inviteId || '')));
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/history/public-key') {
        const body = await readJson(req);
        return json(res, 200, { room: await claimPublicHistoryKey(user, String(body.roomId), body.key) });
      }
      if (req.method === 'GET' && url.pathname === '/api/rooms/history') {
        const roomId = url.searchParams.get('roomId') || '';
        if (!exists(roomId)) return json(res, 404, { error: 'NOT_FOUND' });
        const envelopes = await fetchHistory(user, roomId, url.searchParams.get('after'), url.searchParams.get('limit'));
        return json(res, 200, { envelopes });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/rooms') {
        const body = await readJson(req);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 200, await removeRoom(user, String(body.roomId)));
      }
      if (req.method === 'DELETE' && url.pathname === '/api/rooms/history') {
        const body = await readJson(req);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 200, await deleteEnvelope(user, String(body.roomId), body.seq));
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/history/clear') {
        const body = await readJson(req);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 200, await clearHistoryFor(user, String(body.roomId)));
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms/history/visibility') {
        const body = await readJson(req);
        if (!exists(String(body.roomId))) return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 200, { room: await enableFullHistory(user, String(body.roomId)) });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'rooms.request_failed', message: error.message }));
      const safe = error.code === '23505' ? 'SLUG_TAKEN' : (error.status && /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'INTERNAL_ERROR');
      return json(res, error.status || 500, { error: safe });
    }
  };

  return { handle, exists, canAccess, isPublic: (roomId) => publicRooms.has(roomId), epoch: roomEpoch, epochsFor, ownerId: (roomId) => owners.get(roomId) || '', listForUser, rehydrate: hydrate, onMembershipChange(listener) { membershipListeners.add(listener); return () => membershipListeners.delete(listener); } };
}
