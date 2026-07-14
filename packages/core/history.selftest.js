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

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
