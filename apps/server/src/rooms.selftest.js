// Rooms self-test against an in-memory Postgres (pg-mem). Exercises the real
// rooms.handle() HTTP surface end to end: schema creation, room creation,
// membership-scoped access, invite create/redeem and link resolution.
//
// Run: node apps/server/src/rooms.selftest.js

import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import { createRooms } from './rooms.js';

const db = newDb();
const { Pool } = db.adapters.createPg();
const pool = new Pool();

// The rooms schema has FKs into users(id); auth normally owns this table.
await pool.query(`CREATE TABLE users (
  id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, username VARCHAR(24) NOT NULL UNIQUE,
  name VARCHAR(40) NOT NULL, avatar TEXT NOT NULL DEFAULT '', color VARCHAR(16) NOT NULL,
  bio VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(80) NOT NULL DEFAULT '',
  profile_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  profile_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  privacy JSONB NOT NULL DEFAULT '{"avatar":"everyone","bio":"everyone","status":"everyone","links":"everyone"}'::jsonb,
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
const membershipChanges = [];
rooms.onMembershipChange((change) => membershipChanges.push(change));

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

// Drive rooms.handle with a mock request/response.
const call = async (method, url, { user = null, body } = {}) => {
  if (method === 'POST' && url === '/api/rooms/history' && body?.roomId && body.epoch == null) {
    body = { ...body, epoch: rooms.epoch(body.roomId) };
  }
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

// Legacy public rooms are discoverable but require an explicit subscription.
ok(rooms.exists('flood'), 'seeded public room exists');
ok(!rooms.canAccess(other.id, 'flood'), 'public room is not auto-joined for a new account');
ok(!rooms.exists('general'), 'the retired general room is gone');

// Unauthenticated is rejected.
const anon = await call('GET', '/api/rooms/mine');
ok(anon.status === 401, 'unauthenticated /mine -> 401');

// Create a private chat.
const created = await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Team', icon: '🧩' } });
ok(created.status === 201 && created.data.room?.id, 'create chat -> 201 with id');
ok(created.data.room.icon === '🧩', 'create chat keeps its chosen icon');
const roomId = created.data.room.id;
ok(rooms.canAccess(owner.id, roomId), 'owner can access own private room');
ok(!rooms.canAccess(other.id, roomId), 'non-member cannot access private room');

// Create a public channel with a slug and resolve it by link.
const channel = await call('POST', '/api/rooms', { user: owner, body: { type: 'channel', title: 'Dev', slug: 'dev-talk' } });
ok(channel.status === 201 && channel.data.room.slug === 'dev-talk', 'create channel with slug');
ok(channel.data.room.icon === '📢', 'channel receives its default icon');
const renamedChannel = await call('PATCH', '/api/rooms', { user: owner, body: { roomId: channel.data.room.id, title: 'Development', icon: '🧪' } });
ok(renamedChannel.status === 200 && renamedChannel.data.room.title === 'Development' && renamedChannel.data.room.icon === '🧪', 'owner updates room identity');
const forbiddenRename = await call('PATCH', '/api/rooms', { user: other, body: { roomId: channel.data.room.id, title: 'Hijacked' } });
ok(forbiddenRename.status === 403, 'non-owner cannot update room identity');
const publicKey = Buffer.alloc(32, 7).toString('base64');
const claimedKey = await call('POST', '/api/rooms/history/public-key', { user: owner, body: { roomId: channel.data.room.id, key: publicKey } });
ok(claimedKey.status === 200 && claimedKey.data.room.historyKey === publicKey, 'channel owner publishes its public history key');
const forbiddenKey = await call('POST', '/api/rooms/history/public-key', { user: other, body: { roomId: channel.data.room.id, key: Buffer.alloc(32, 8).toString('base64') } });
ok(forbiddenKey.status === 403, 'non-owner cannot replace a channel history key');
const resolvedChannel = await call('GET', '/api/rooms/resolve?path=/c/dev-talk', { user: other });
ok(resolvedChannel.data?.type === 'channel' && resolvedChannel.data.room.slug === 'dev-talk' && resolvedChannel.data.room.historyKey === publicKey && resolvedChannel.data.room.joined === false, 'resolve /c/dev-talk without silently subscribing');
const subscribed = await call('POST', '/api/rooms/join-public', { user: other, body: { roomId: channel.data.room.id } });
ok(subscribed.status === 200 && subscribed.data.room.joined === true && subscribed.data.room.joinedNow === true, 'subscribe to a public channel');
ok(rooms.canAccess(other.id, channel.data.room.id), 'subscriber gains public-channel access');
const subscribedAgain = await call('POST', '/api/rooms/join-public', { user: other, body: { roomId: channel.data.room.id } });
ok(subscribedAgain.status === 200 && subscribedAgain.data.room.joinedNow === false, 'public subscription is idempotent');
const channelMembers = await call('GET', `/api/rooms/members?roomId=${channel.data.room.id}`, { user: other });
ok(channelMembers.status === 200 && channelMembers.data.count === 2 && channelMembers.data.members.some((member) => member.role === 'owner') && channelMembers.data.members.some((member) => member.me), 'channel returns its real subscriber list');

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

const revokable = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId } });
const inviteList = await call('GET', `/api/rooms/invites?roomId=${roomId}`, { user: owner });
ok(inviteList.status === 200 && inviteList.data.invites.some((item) => item.id === revokable.data.id), 'owner lists active invites');
const hiddenInvites = await call('GET', `/api/rooms/invites?roomId=${roomId}`, { user: other });
ok(hiddenInvites.status === 403, 'non-owner cannot list invites');
const revoked = await call('DELETE', '/api/rooms/invite', { user: owner, body: { roomId, inviteId: revokable.data.id } });
const revokedJoin = await call('POST', '/api/rooms/join', { user: other, body: { token: revokable.data.token } });
ok(revoked.status === 200 && revokedJoin.status === 400, 'revoked invite cannot be redeemed');

// Owner mints an invite; another user redeems it and gains access.
const invite = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId } });
ok(invite.status === 201 && invite.data.token, 'owner mints invite');
const joined = await call('POST', '/api/rooms/join', { user: other, body: { token: invite.data.token } });
ok(joined.status === 200 && joined.data.room?.id === roomId && joined.data.room.joined === true, 'redeem invite -> joined room');
ok(rooms.canAccess(other.id, roomId), 'redeemer now has access');
ok(joined.data.room.membershipEpoch === rooms.epoch(roomId) && membershipChanges.at(-1)?.epoch === rooms.epoch(roomId), 'joining advances the persisted membership epoch');
const membershipEventsAfterJoin = membershipChanges.length;
const joinedAgain = await call('POST', '/api/rooms/join', { user: other, body: { token: invite.data.token } });
const inviteUsage = await pool.query('SELECT uses FROM room_invites WHERE token_hash=$1', [createHash('sha256').update(invite.data.token).digest('hex')]);
ok(joinedAgain.status === 200 && joinedAgain.data.room.joined === false, 'redeeming an invite twice is idempotent');
ok(inviteUsage.rows[0].uses === 1 && membershipChanges.length === membershipEventsAfterJoin, 'duplicate redemption does not consume invite or emit membership change');

// Bad invite token is rejected.
const badToken = await call('POST', '/api/rooms/join', { user: other, body: { token: 'nope' } });
ok(badToken.status === 400, 'bad invite token -> 400');

// /mine reflects membership and never injects unrelated public rooms.
const ownerMine = await call('GET', '/api/rooms/mine', { user: owner });
ok(ownerMine.data.rooms.some((r) => r.id === roomId), 'owner /mine includes private room');
ok(ownerMine.data.rooms.some((r) => r.id === channel.data.room.id && r.role === 'owner'), 'owner /mine includes owned channel');
ok(!ownerMine.data.rooms.some((r) => r.id === 'flood'), 'owner /mine excludes unjoined seeded room');
const otherMine = await call('GET', '/api/rooms/mine', { user: other });
ok(otherMine.data.rooms.some((r) => r.id === roomId), 'redeemer /mine includes joined room');
ok(otherMine.data.rooms.some((r) => r.id === channel.data.room.id && r.subscribers === 2), 'subscriber /mine includes joined channel and real count');
const thirdMine = await call('GET', '/api/rooms/mine', { user: third });
ok(thirdMine.data.rooms.length === 1 && thirdMine.data.rooms[0].type === 'saved', 'new account starts with only its private saved room');

// Retrying the same client event is acknowledged with its original sequence
// instead of inserting a duplicate envelope.
const idemRoom = (await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Idempotency' } })).data.room.id;
const idemBody = { roomId: idemRoom, eventId: 'event-stable-1', iv: 'iv', ct: 'cipher' };
const idemFirst = await call('POST', '/api/rooms/history', { user: owner, body: idemBody });
const idemRetry = await call('POST', '/api/rooms/history', { user: owner, body: idemBody });
const idemHistory = await call('GET', `/api/rooms/history?roomId=${idemRoom}`, { user: owner });
ok(idemFirst.data.seq === idemRetry.data.seq && idemRetry.data.duplicate === true, 'history retry returns the original sequence');
ok(idemHistory.data.envelopes.length === 1, 'history retry does not duplicate the envelope');

// --- Encrypted history: append, join-point gating, one-way full visibility ---
const env = (n) => ({ iv: `iv${n}`, ct: `cipher-${n}` });

const staleEpochAppend = await call('POST', '/api/rooms/history', { user: owner, body: { roomId, epoch: rooms.epoch(roomId) - 1, ...env(0) } });
ok(staleEpochAppend.status === 409, 'history encrypted for a stale membership epoch is rejected');

// Owner appends two envelopes to the private room (seq 1, 2).
const h1 = await call('POST', '/api/rooms/history', { user: owner, body: { roomId, ...env(1) } });
const h2 = await call('POST', '/api/rooms/history', { user: owner, body: { roomId, ...env(2) } });
ok(h1.data.seq === 1 && h2.data.seq === 2, 'history seq increments per room');

// Concurrent appends receive distinct sequences without retrying MAX(seq).
const concurrentRoom = (await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Concurrent' } })).data.room.id;
const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/api/rooms/history', {
  user: owner,
  body: { roomId: concurrentRoom, eventId: `concurrent-${i}`, ...env(i) },
})));
const concurrentSeqs = concurrent.map((result) => result.data.seq);
ok(new Set(concurrentSeqs).size === 20 && Math.min(...concurrentSeqs) === 1 && Math.max(...concurrentSeqs) === 20,
  'concurrent history appends receive unique sequences');

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
await pool.query(`UPDATE users SET avatar='data:image/png;base64,AA==',privacy='{"avatar":"nobody"}'::jsonb WHERE id=$1`, [owner.id]);
const privateAvatarView = await call('GET', `/api/rooms/history?roomId=${roomId}`, { user: third });
ok(privateAvatarView.data.envelopes.filter((envelope) => envelope.senderId === owner.id).every((envelope) => !envelope.senderAvatar), 'history backfill respects avatar privacy');
const enableAgain = await call('POST', '/api/rooms/history/visibility', { user: owner, body: { roomId } });
ok(enableAgain.status === 200 && enableAgain.data.room.historyVisibility === 'full', 'enabling full again is idempotent');

// --- Traceless delete: an erased envelope must never come back on a backfill ---
const delRoom = (await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Del' } })).data.room.id;
const inv3 = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId: delRoom } });
await call('POST', '/api/rooms/join', { user: other, body: { token: inv3.data.token } });
const e1 = await call('POST', '/api/rooms/history', { user: owner, body: { roomId: delRoom, ...env(1) } });
await call('POST', '/api/rooms/history', { user: owner, body: { roomId: delRoom, ...env(2) } });

// A member cannot erase someone else's message.
const foreign = await call('DELETE', '/api/rooms/history', { user: other, body: { roomId: delRoom, seq: e1.data.seq } });
ok(foreign.status === 404, 'cannot erase another user\'s envelope');

// The author can, and it is gone from everyone's backfill.
const erased = await call('DELETE', '/api/rooms/history', { user: owner, body: { roomId: delRoom, seq: e1.data.seq } });
ok(erased.status === 200, 'author erases their own envelope');
const afterErase = await call('GET', `/api/rooms/history?roomId=${delRoom}`, { user: owner });
ok(!afterErase.data.envelopes.some((e) => e.seq === e1.data.seq), 'erased envelope is gone for good');
ok(afterErase.data.envelopes.length === 1, 'the other message survives');

// --- Clear history: per-member, non-destructive for everyone else ---
const clearRoom = (await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Clr' } })).data.room.id;
const inv4 = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId: clearRoom } });
await call('POST', '/api/rooms/join', { user: other, body: { token: inv4.data.token } });
await call('POST', '/api/rooms/history/visibility', { user: owner, body: { roomId: clearRoom } }); // full, so `other` sees all
await call('POST', '/api/rooms/history', { user: owner, body: { roomId: clearRoom, ...env(1) } });
await call('POST', '/api/rooms/history', { user: owner, body: { roomId: clearRoom, ...env(2) } });

ok((await call('GET', `/api/rooms/history?roomId=${clearRoom}`, { user: other })).data.envelopes.length === 2, 'member sees history before clearing');
const cleared = await call('POST', '/api/rooms/history/clear', { user: other, body: { roomId: clearRoom } });
ok(cleared.status === 200 && cleared.data.clearedSeq === 2, 'clear history records the current end of the log');
ok((await call('GET', `/api/rooms/history?roomId=${clearRoom}`, { user: other })).data.envelopes.length === 0, 'history is empty for the member who cleared it');
ok((await call('GET', `/api/rooms/history?roomId=${clearRoom}`, { user: owner })).data.envelopes.length === 2, 'other members keep their history');

// New messages after a clear are still delivered to the member who cleared.
await call('POST', '/api/rooms/history', { user: owner, body: { roomId: clearRoom, ...env(3) } });
ok((await call('GET', `/api/rooms/history?roomId=${clearRoom}`, { user: other })).data.envelopes.length === 1, 'messages sent after a clear still arrive');

// --- Removing a room: owner deletes for everyone, a member only leaves ---
const gone = (await call('POST', '/api/rooms', { user: owner, body: { type: 'chat', title: 'Gone' } })).data.room.id;
const inv5 = await call('POST', '/api/rooms/invite', { user: owner, body: { roomId: gone } });
await call('POST', '/api/rooms/join', { user: other, body: { token: inv5.data.token } });
await call('POST', '/api/rooms/history', { user: owner, body: { roomId: gone, ...env(1) } });

// A member leaving only drops their own membership; the room lives on.
const left = await call('DELETE', '/api/rooms', { user: other, body: { roomId: gone } });
ok(left.status === 200 && left.data.left === true && left.data.deleted === false, 'a member leaves without deleting the room');
ok(!rooms.canAccess(other.id, gone), 'the member who left loses access');
ok(rooms.canAccess(owner.id, gone), 'the room still exists for the owner');
ok((await call('GET', `/api/rooms/history?roomId=${gone}`, { user: other })).status === 403, 'the member who left cannot read its history');

// The owner deleting it takes the room AND its history away for everyone.
const deleted = await call('DELETE', '/api/rooms', { user: owner, body: { roomId: gone } });
ok(deleted.status === 200 && deleted.data.deleted === true, 'the owner deletes the room');
ok(membershipChanges.at(-1)?.action === 'deleted' && membershipChanges.at(-1)?.affectedUserIds.includes(owner.id), 'live members are notified when an owner deletes a room');
ok(!rooms.exists(gone), 'the room is gone');
const leftover = await pool.query('SELECT COUNT(*)::int AS n FROM room_history WHERE room_id=$1', [gone]);
ok(leftover.rows[0].n === 0, 'its history is erased with it — nothing to come back to');
ok(!(await call('GET', '/api/rooms/mine', { user: owner })).data.rooms.some((r) => r.id === gone),
  'a user signing in later does not get the deleted room back');

// A public subscriber can leave without deleting the channel.
const publicLeft = await call('DELETE', '/api/rooms', { user: other, body: { roomId: channel.data.room.id } });
ok(publicLeft.status === 200 && publicLeft.data.left === true && rooms.exists(channel.data.room.id), 'subscriber leaves without deleting the public channel');
ok(!rooms.canAccess(other.id, channel.data.room.id), 'former subscriber loses channel access');

console.log(`\n${pass} ok, ${fail} fail`);
await pool.end();
if (fail) process.exit(1);
