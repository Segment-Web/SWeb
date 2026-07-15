// Client history self-test. Verifies the encrypted server-history data path and
// adopt-if-absent key distribution between two clients, against a stubbed store.
//
// Run: node packages/core/history.selftest.js

import { SegmentClient } from './index.js';

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
    list.push({ seq: list.length + 1, iv: body.iv, ct: body.ct });
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

// C, lacking the key, backfills nothing readable.
await C._backfillRoom(roomId);
ok(!C._messageById(roomId, 'm1'), 'client without the key cannot read history');

// Backfill is idempotent: running again adds no duplicate.
await B._backfillRoom(roomId);
ok(B.messages[roomId].filter((m) => m.id === 'm1').length === 1, 'backfill does not duplicate messages');

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
ok(B._messageById(roomId, 'sync-m1')?.reactions?.ok?.includes('A'), 'reactions survive history backfill');
ok(B.messages[roomId].pinnedIds?.[0] === 'sync-m1', 'pinned state survives history backfill');

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
B._applyEvent(roomId, { kind: 'message', message: { id: 'm3', name: 'A', text: 'bye' } }, { name: 'A' });
ok(B._messageById(roomId, 'm3'), 'peer has the message');
B._applyEvent(roomId, { kind: 'delete', id: 'm3' }, { name: 'A' });
ok(!B._messageById(roomId, 'm3'), 'peer removes the message on delete, leaving no trace');

// A backfill cannot bring the erased message back.
A._backfilled.clear();
await A._backfillRoom(roomId);
ok(!A._messageById(roomId, 'm2'), 'backfill cannot resurrect an erased message');

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
