// Client history self-test. Verifies the encrypted server-history data path and
// adopt-if-absent key distribution between two clients, against a stubbed store.
//
// Run: node packages/core/history.selftest.js

import { SegmentClient } from './index.js';
import { SenderKeyView } from '@segment/crypto';

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

// In-memory stand-in for /api/rooms/history (no visibility gating needed here).
const store = new Map(); // roomId -> [{ seq, iv, ct }]
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes('/api/rooms/history') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    // Mirror the real server's contract: envelopes are base64 STRINGS. Rejecting
    // anything else here keeps the client from drifting back to raw byte arrays,
    // which the server would 400 and the client would swallow silently.
    if (typeof body.iv !== 'string' || typeof body.ct !== 'string') {
      return { ok: false, status: 400, json: async () => ({ error: 'ENVELOPE_INVALID' }) };
    }
    const list = store.get(body.roomId) || [];
    list.push({ seq: list.length + 1, senderId: 'user-a', keyId: body.keyId || '', iv: body.iv, ct: body.ct });
    store.set(body.roomId, list);
    return { ok: true, status: 201, json: async () => ({ seq: list.length }) };
  }
  if (u.includes('/api/rooms/history') && options.method === 'DELETE') {
    const body = JSON.parse(options.body);
    const list = store.get(body.roomId) || [];
    const at = list.findIndex((e) => e.seq === body.seq);
    if (at < 0) return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) };
    list.splice(at, 1); // erased for good, exactly as the server does
    return { ok: true, status: 200, json: async () => ({ seq: body.seq }) };
  }
  if (u.includes('/api/rooms/history')) {
    const roomId = new URL(u, 'http://x').searchParams.get('roomId');
    return { ok: true, status: 200, json: async () => ({ envelopes: store.get(roomId) || [] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const mkStorage = () => ({
  getName: () => 'U', getUsername: () => 'u', getAvatar: () => '', getColor: () => '#7c5cff',
  getNotes: () => [], getGeneral: () => [], getPinned: () => [], getMuted: () => [], getArchived: () => [], getFolders: () => [],
  setNotes: () => {}, setGeneral: () => {},
});
const roomId = 'chat-abc';
const A = new SegmentClient({ storage: mkStorage() });
const B = new SegmentClient({ storage: mkStorage() });
const C = new SegmentClient({ storage: mkStorage() });
ok(/^[a-z0-9-]{3,32}$/.test(A._slugify('Новости')), 'channel slug remains valid for a non-Latin title');
Object.assign(A.self, { id: 'user-a', name: 'A', username: 'alice' });
Object.assign(B.self, { id: 'user-b', name: 'B', username: 'bob' });
Object.assign(C.self, { id: 'user-c', name: 'C', username: 'carol' });
for (const cl of [A, B, C]) cl._addServerRoom({ id: roomId, title: 'R', type: 'chat', icon: '💬' });

// A creates the room and seeds its history key.
A._seedHistoryKey(roomId);
ok(A._historyKey(roomId)?.length === 32, 'creator seeds a 32-byte history key');

// Gossip: B adopts A's key (adopt-if-absent). C stays without it.
B._adoptHistoryKeys(A.historyKeysExport());
ok(JSON.stringify(B._historyKey(roomId)) === JSON.stringify(A._historyKey(roomId)), 'peer adopts the creator key over gossip');

// adopt-if-absent must not overwrite a key already held.
const bKey = B._historyKey(roomId);
B._adoptHistoryKeys({ [roomId]: A._seedHistoryKey('other') && Array(32).fill(9) });
ok(B._historyKey(roomId) === bKey, 'adopt does not overwrite an existing key');

// A stores a message to history; stored bytes are ciphertext, not plaintext.
await A._storeToHistory(roomId, { kind: 'message', message: { id: 'm1', name: 'A', text: 'secret-hello' } });
const stored = store.get(roomId)[0];
ok(stored && !atob(stored.ct).includes('secret-hello'), 'stored envelope is encrypted, not plaintext');

// B backfills and decrypts A's message.
await B._backfillRoom(roomId);
ok(B._messageById(roomId, 'm1')?.text === 'secret-hello', 'peer backfills and decrypts stored history');
ok(!B.unread[roomId], 'history preload does not mark old messages as unread');

// C, lacking the key, backfills nothing readable.
await C._backfillRoom(roomId);
ok(!C._messageById(roomId, 'm1'), 'client without the key cannot read history');

// Backfill is idempotent: running again adds no duplicate.
await B._backfillRoom(roomId);
ok(B.messages[roomId].filter((m) => m.id === 'm1').length === 1, 'backfill does not duplicate messages');

// Startup preloading hydrates unopened rooms so the chat list can show the
// latest message without counting historical messages as new activity.
const preloadRoom = 'chat-preload';
for (const cl of [A, B]) cl._addServerRoom({ id: preloadRoom, title: 'Preload', type: 'chat', icon: 'P' });
A._seedHistoryKey(preloadRoom); B._adoptHistoryKeys(A.historyKeysExport());
await A._storeToHistory(preloadRoom, { kind: 'message', message: { id: 'preloaded-message', name: 'A', text: 'visible before open' } });
await B.preloadRoomHistories();
ok(B._messageById(preloadRoom, 'preloaded-message')?.text === 'visible before open', 'startup preload hydrates unopened rooms');
ok(B.lastText[preloadRoom]?.includes('visible before open') && !B.unread[preloadRoom], 'startup preload updates the preview without unread noise');

// History keys survive a client restart on the same device.
let persistedKeys = {};
const persistentStorage = {
  ...mkStorage(),
  getHistoryKeys: () => persistedKeys,
  setHistoryKeys: (keys) => { persistedKeys = structuredClone(keys); },
};
const persistentA = new SegmentClient({ storage: persistentStorage });
persistentA._seedHistoryKey('persisted-room');
const persistentReload = new SegmentClient({ storage: persistentStorage });
ok(JSON.stringify(persistentReload._historyKey('persisted-room')) === JSON.stringify(persistentA._historyKey('persisted-room')), 'history key survives a same-device reload');

// Key rotation keeps new members/leavers on a fresh key while retaining the
// bounded old-key archive needed to decrypt pre-rotation envelopes.
const rotateRoom = 'chat-rotate';
for (const cl of [A, B]) cl._addServerRoom({ id: rotateRoom, title: 'Rotate', type: 'chat', icon: 'R' });
A._seedHistoryKey(rotateRoom); B._adoptHistoryKeys(A.historyKeysExport());
await A._storeToHistory(rotateRoom, { kind: 'message', message: { id: 'before-rotate', name: 'A', text: 'before rotation' } });
const rotatedKey = Array(32).fill(17); A._installRotatedHistoryKey(rotateRoom, rotatedKey); B._installRotatedHistoryKey(rotateRoom, rotatedKey);
await A._storeToHistory(rotateRoom, { kind: 'message', message: { id: 'after-rotate', name: 'A', text: 'after rotation' } });
await B._backfillRoom(rotateRoom);
ok(B._messageById(rotateRoom, 'before-rotate')?.text === 'before rotation', 'pre-rotation history remains decryptable');
ok(B._messageById(rotateRoom, 'after-rotate')?.text === 'after rotation', 'post-rotation history uses the new key');

// Mutations are history events too, so another device reconstructs current
// state rather than only the original message.
store.clear();
A._backfilled.clear(); B._backfilled.clear();
A._appliedEvents.clear(); B._appliedEvents.clear();
A.messages[roomId] = []; B.messages[roomId] = [];
A.self.name = 'A'; B.self.name = 'A';
await A.sendEvent(roomId, { kind: 'message', message: { id: 'sync-m1', name: 'A', text: 'before', status: 'sending' } });
await A.sendEvent(roomId, { kind: 'edit', id: 'sync-m1', text: 'after' });
await A.sendEvent(roomId, { kind: 'reaction', id: 'sync-m1', emoji: 'ok', by: 'A' });
await A.sendEvent(roomId, { kind: 'pin-message', ids: ['sync-m1'] });
await B._backfillRoom(roomId);
ok(B._messageById(roomId, 'sync-m1')?.text === 'after', 'message edits survive history backfill');
ok(B._messageById(roomId, 'sync-m1')?.reactions?.ok?.includes('user-a'), 'reactions survive history backfill');
ok(B.messages[roomId].pinnedIds?.[0] === 'sync-m1', 'pinned state survives history backfill');

// Attachment references are part of the encrypted history event, so media does
// not disappear after a reload even though the file bytes live in blob storage.
store.clear();
A._backfilled.clear(); B._backfilled.clear();
A._appliedEvents.clear(); B._appliedEvents.clear();
A.messages[roomId] = []; B.messages[roomId] = [];
const photoRef = { fileId: 'a'.repeat(64), key: Array(32).fill(3), iv: Array(12).fill(4), mime: 'image/png', size: 123 };
await A.sendEvent(roomId, { kind: 'message', message: { id: 'photo-m1', name: 'A', text: '', attachments: [{ kind: 'photo', name: 'photo.png', blob: photoRef }] } });
await B._backfillRoom(roomId);
ok(B._messageById(roomId, 'photo-m1')?.attachments?.[0]?.blob?.fileId === photoRef.fileId, 'photo reference survives history backfill');

// Public channels install their shared public history key and display posts as
// the channel while retaining the encrypted sender identity internally.
const channelId = 'channel-public';
const channelKey = Array(32).fill(5);
const channelKeyB64 = btoa(String.fromCharCode(...channelKey));
A._addServerRoom({ id: channelId, title: 'News', type: 'channel', icon: 'N', isPublic: true, historyKey: channelKeyB64 });
B._addServerRoom({ id: channelId, title: 'News', type: 'channel', icon: 'N', isPublic: true, historyKey: channelKeyB64 });
ok(JSON.stringify(A._historyKey(channelId)) === JSON.stringify(channelKey), 'public channel installs its durable history key');
store.clear();
A._backfilled.clear(); B._backfilled.clear();
A._appliedEvents.clear(); B._appliedEvents.clear();
A.messages[channelId] = []; B.messages[channelId] = [];
await A.sendEvent(channelId, { eventId: 'channel-post-1', kind: 'message', message: { id: 'channel-post-1', name: 'A', text: 'Update', attachments: [{ kind: 'photo', name: 'channel.png', blob: photoRef }] } });
ok(A._messageById(channelId, 'channel-post-1')?.channelName === 'News', 'channel post is displayed under the channel identity');
await B._backfillRoom(channelId);
ok(B._messageById(channelId, 'channel-post-1')?.attachments?.[0]?.blob?.fileId === photoRef.fileId, 'public channel photo survives a simulated reload');

// --- Traceless delete: gone from the view AND unrecoverable from history ---
store.clear();
A._backfilled.clear(); B._backfilled.clear();
A.messages[roomId] = []; B.messages[roomId] = [];
A.self.name = 'A';

// A sends a message; it lands in history with a seq.
await A.sendEvent(roomId, { kind: 'message', message: { id: 'm2', name: 'A', text: 'oops' } });
await new Promise((r) => setTimeout(r, 20)); // history is written fire-and-forget
const sent = A._messageById(roomId, 'm2');
ok(sent?.seq === 1, 'sent message remembers where it lives in history');
ok(store.get(roomId).length === 1, 'message is stored in history');

// Deleting removes it outright — no "deleted" tombstone left behind.
ok(A.deleteMessage(roomId, 'm2') === true, 'author may delete their message');
ok(!A._messageById(roomId, 'm2'), 'deleted message is removed from the view, not tombstoned');
await new Promise((r) => setTimeout(r, 10)); // let the erase request settle
ok(store.get(roomId).length === 1, 'original envelope is erased while the delete event remains for device sync');

// A peer receiving the delete event drops it entirely too.
B._applyEvent(roomId, { kind: 'message', message: { id: 'm3', name: 'A', text: 'bye' } }, { id: 'user-a', name: 'A', username: 'alice' });
ok(B._messageById(roomId, 'm3'), 'peer has the message');
B._applyEvent(roomId, { kind: 'delete', id: 'm3' }, { id: 'user-a', name: 'A', username: 'alice' });
ok(!B._messageById(roomId, 'm3'), 'peer removes the message on delete, leaving no trace');

// Authenticated event authorship is authoritative. A room member cannot edit,
// delete or rotate keys on behalf of another account, and reaction ownership
// cannot be forged through the event payload's display name.
const secureRoom = 'chat-secure-events';
for (const cl of [A, B]) cl._addServerRoom({ id: secureRoom, title: 'Secure', type: 'chat', icon: 'S', ownerId: 'user-a' });
A._seedHistoryKey(secureRoom); B._adoptHistoryKeys(A.historyKeysExport());
B._applyEvent(secureRoom, { kind: 'message', message: { id: 'owned', text: 'original' } }, { id: 'user-a', name: 'A', username: 'alice' });
B._applyEvent(secureRoom, { kind: 'edit', id: 'owned', text: 'forged' }, { id: 'user-b', name: 'B', username: 'bob' });
B._applyEvent(secureRoom, { kind: 'delete', id: 'owned' }, { id: 'user-b', name: 'B', username: 'bob' });
ok(B._messageById(secureRoom, 'owned')?.text === 'original', 'non-author cannot edit or delete another account message');
B._applyEvent(secureRoom, { kind: 'reaction', id: 'owned', emoji: 'ok', by: 'A' }, { id: 'user-b', name: 'B', username: 'bob' });
ok(B._messageById(secureRoom, 'owned')?.reactions?.ok?.includes('user-b') && !B._messageById(secureRoom, 'owned')?.reactions?.ok?.includes('A'), 'reaction actor cannot be spoofed by payload');
const secureKeyBefore = JSON.stringify(B._historyKey(secureRoom));
B._applyEvent(secureRoom, { kind: 'history-key-rotate', key: Array(32).fill(22) }, { id: 'user-b', name: 'B' });
ok(JSON.stringify(B._historyKey(secureRoom)) === secureKeyBefore, 'non-owner cannot rotate room history key');
B._applyEvent(secureRoom, { kind: 'history-key-rotate', key: Array(32).fill(23) }, { id: 'user-a', name: 'A' });
ok(JSON.stringify(B._historyKey(secureRoom)) === secureKeyBefore, 'room events cannot carry history key material, even from the owner');

// Membership changes never publish a fresh history key inside a room event
// encrypted under the key that the removed member already knows.
const raceRoom = 'chat-rotation-race';
A._addServerRoom({ id: raceRoom, title: 'Race', type: 'chat', icon: 'R', ownerId: 'user-a' });
A._seedHistoryKey(raceRoom);
const oldRaceKeyId = A._historyKeyId(A._historyKey(raceRoom));
A.ws = { readyState: 1, send: () => {} };
await A._rotateRoomHistoryKey(raceRoom);
const queuedRotation = A.outbox.find((item) => item.roomId === raceRoom && item.event.kind === 'history-key-rotate');
ok(!queuedRotation, 'fresh history key is never wrapped in an old room event');
ok(A._historyKeyId(A._historyKey(raceRoom)) !== oldRaceKeyId, 'owner immediately adopts a fresh history key');

// Sender chains are isolated by room and replaced at every membership epoch.
const roomA = 'chat-key-scope-a', roomB = 'chat-key-scope-b';
A._addServerRoom({ id: roomA, title: 'A', type: 'chat', membershipEpoch: 1 });
A._addServerRoom({ id: roomB, title: 'B', type: 'chat', membershipEpoch: 1 });
const senderA = await A._ensureRoomSenderKey(roomA);
const senderB = await A._ensureRoomSenderKey(roomB);
ok(JSON.stringify(senderA.key.export()) !== JSON.stringify(senderB.key.export()), 'different rooms use different sender chains');
const formerMemberView = SenderKeyView.from(senderA.key.export());
await A._advanceRoomEpoch(roomA, 2, false);
const rotatedSenderA = await A._ensureRoomSenderKey(roomA);
const futureCipher = await rotatedSenderA.key.encrypt('future private message');
let formerMemberRead = false;
try { await formerMemberView.decrypt(futureCipher); formerMemberRead = true; } catch {}
ok(!formerMemberRead, 'a former member sender view cannot decrypt the next membership epoch');

// A backfill cannot bring the erased message back.
A._backfilled.clear();
await A._backfillRoom(roomId);
ok(!A._messageById(roomId, 'm2'), 'backfill cannot resurrect an erased message');

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
