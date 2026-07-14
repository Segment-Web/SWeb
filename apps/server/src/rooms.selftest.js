// Rooms self-test against an in-memory Postgres (pg-mem). Exercises the real
// rooms.handle() HTTP surface end to end: schema creation, room creation,
// membership-scoped access, invite create/redeem and link resolution.
//
// Run: node apps/server/src/rooms.selftest.js

import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import { createRooms } from './rooms.js';

const db = newDb();
const { Pool } = db.adapters.createPg();
const pool = new Pool();

// The rooms schema has FKs into users(id); auth normally owns this table.
await pool.query(`CREATE TABLE users (
  id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, username VARCHAR(24) NOT NULL UNIQUE,
  name VARCHAR(40) NOT NULL, avatar TEXT NOT NULL DEFAULT '', color VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`);
const mkUser = async (username) => {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id,email,username,name,color) VALUES($1,$2,$3,$4,$5)',
    [id, `${username}@t.local`, username, username, '#7c5cff']);
  return { id, username, name: username, color: '#7c5cff' };
};
const owner = await mkUser('owner_u');
const other = await mkUser('other_u');
const third = await mkUser('third_u');

const config = { production: false, allowedOrigins: [], publicUrl: '', roomInviteTtlMs: 3600000 };
const auth = { pool, userFromRequest: async (req) => req._user ?? null };
const rooms = await createRooms(config, auth);

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

// Drive rooms.handle with a mock request/response.
const call = async (method, url, { user = null, body } = {}) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method; req.url = url; req.headers = { origin: '' }; req._user = user;
  let status = 0, payload = '';
  const res = {
    writeHead(code) { status = code; return res; },
    end(chunk) { payload = chunk ? chunk.toString() : ''; },
  };
  const handled = await rooms.handle(req, res);
  return { handled, status, data: payload ? JSON.parse(payload) : null };
};

// Legacy public rooms are seeded and reachable by everyone.
ok(rooms.exists('general'), 'seeded room general exists');
ok(rooms.canAccess(other.id, 'general'), 'public room accessible to any user');

// Unauthenticated is rejected.
const anon = await call('GET', '/api/rooms/mine');
ok(anon.status === 401, 'unauthenticated /mine -> 401');

// Create a private chat.
const created = await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Team' } });
ok(created.status === 201 && created.data.room?.id, 'create chat -> 201 with id');
const roomId = created.data.room.id;
ok(rooms.canAccess(owner.id, roomId), 'owner can access own private room');
ok(!rooms.canAccess(other.id, roomId), 'non-member cannot access private room');

// Create a public channel with a slug and resolve it by link.
const channel = await call('POST', '/api/rooms', { user: owner, body: { type: 'channel', title: 'Dev', slug: 'dev-talk' } });
ok(channel.status === 201 && channel.data.room.slug === 'dev-talk', 'create channel with slug');
const resolvedChannel = await call('GET', '/api/rooms/resolve?path=/c/dev-talk', { user: other });
ok(resolvedChannel.data?.type === 'channel' && resolvedChannel.data.room.slug === 'dev-talk', 'resolve /c/dev-talk');

// Duplicate slug is rejected.
const dup = await call('POST', '/api/rooms', { user: other, body: { type: 'channel', title: 'X', slug: 'dev-talk' } });
ok(dup.status === 409, 'duplicate slug -> 409');

// Invalid slug is rejected.
const badSlug = await call('POST', '/api/rooms', { user: owner, body: { type: 'channel', title: 'X', slug: 'a' } });
ok(badSlug.status === 400, 'invalid slug -> 400');

// Resolve a profile link.
const profile = await call('GET', '/api/rooms/resolve?path=/@owner_u', { user: other });
ok(profile.data?.type === 'profile' && profile.data.user.username === 'owner_u', 'resolve /@owner_u');

// Non-member cannot mint an invite.
const forbidden = await call('POST', '/api/rooms/invite', { user: other, body: { roomId } });
ok(forbidden.status === 403, 'non-member invite -> 403');

// Owner mints an invite; another user redeems it and gains access.
const invite = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId } });
ok(invite.status === 201 && invite.data.token, 'owner mints invite');
const joined = await call('POST', '/api/rooms/join', { user: other, body: { token: invite.data.token } });
ok(joined.status === 200 && joined.data.room?.id === roomId, 'redeem invite -> joined room');
ok(rooms.canAccess(other.id, roomId), 'redeemer now has access');

// Bad invite token is rejected.
const badToken = await call('POST', '/api/rooms/join', { user: other, body: { token: 'nope' } });
ok(badToken.status === 400, 'bad invite token -> 400');

// /mine reflects membership: owner sees the private room, redeemer too.
const ownerMine = await call('GET', '/api/rooms/mine', { user: owner });
ok(ownerMine.data.rooms.some((r) => r.id === roomId), 'owner /mine includes private room');
const otherMine = await call('GET', '/api/rooms/mine', { user: other });
ok(otherMine.data.rooms.some((r) => r.id === roomId), 'redeemer /mine includes joined room');

// --- Encrypted history: append, join-point gating, one-way full visibility ---
const env = (n) => ({ iv: `iv${n}`, ct: `cipher-${n}` });

// Owner appends two envelopes to the private room (seq 1, 2).
const h1 = await call('POST', '/api/rooms/history', { user: owner, body: { roomId, ...env(1) } });
const h2 = await call('POST', '/api/rooms/history', { user: owner, body: { roomId, ...env(2) } });
ok(h1.data.seq === 1 && h2.data.seq === 2, 'history seq increments per room');

// A newly joined member records join_seq = 2, so 'joined' visibility hides 1..2.
const roomForJoin = created.data.room.id;
const invite2 = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId: roomForJoin } });
await call('POST', '/api/rooms/join', { user: third, body: { token: invite2.data.token } });
const thirdAppend = await call('POST', '/api/rooms/history', { user: third, body: { roomId, ...env(3) } });
ok(thirdAppend.data.seq === 3, 'joined member can append (seq 3)');

const thirdView = await call('GET', `/api/rooms/history?roomId=${roomId}`, { user: third });
ok(thirdView.data.envelopes.length === 1 && thirdView.data.envelopes[0].seq === 3, 'joined member sees only post-join history');
const ownerView = await call('GET', `/api/rooms/history?roomId=${roomId}`, { user: owner });
ok(ownerView.data.envelopes.length === 3, 'owner (join_seq 0) sees full history');

// Non-member is denied append and read.
const outAppend = await call('POST', '/api/rooms/history', { user: (await mkUser('outsider_u')), body: { roomId, ...env(9) } });
ok(outAppend.status === 403, 'non-member append -> 403');

// Only the owner can enable full history; it is one-way.
const notOwnerFull = await call('POST', '/api/rooms/history/visibility', { user: third, body: { roomId } });
ok(notOwnerFull.status === 403, 'non-owner cannot enable full history -> 403');
const enableFull = await call('POST', '/api/rooms/history/visibility', { user: owner, body: { roomId } });
ok(enableFull.data.room.historyVisibility === 'full', 'owner enables full history');
const thirdViewFull = await call('GET', `/api/rooms/history?roomId=${roomId}`, { user: third });
ok(thirdViewFull.data.envelopes.length === 3, 'after full is enabled, joined member sees all history');
const enableAgain = await call('POST', '/api/rooms/history/visibility', { user: owner, body: { roomId } });
ok(enableAgain.status === 200 && enableAgain.data.room.historyVisibility === 'full', 'enabling full again is idempotent');

console.log(`\n${pass} ok, ${fail} fail`);
await pool.end();
if (fail) process.exit(1);
