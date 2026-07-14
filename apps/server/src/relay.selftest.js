// Relay self-test: two real WebSocket clients exchanging a real encrypted frame
// through the real gateway.
//
// This is the test that was missing when the relay silently dropped every
// encrypted message: its validator demanded string iv/ct while the crypto layer
// emits byte arrays. Typing indicators still relayed, so the app looked alive
// while no chat message ever arrived. Assert delivery, not just validation.
//
// Run: node apps/server/src/relay.selftest.js

import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { SenderKey, SenderKeyView } from '@segment/crypto';
import { MessageType } from '@segment/protocol';
import { attachGateway } from './gateway.js';

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

const ROOM = 'general';
const PRIVATE = 'chat-private';

// Two accounts; the gateway resolves them from the request.
const USERS = {
  'a-token': { id: 'user-a', name: 'Alice', username: 'alice', color: '#111', avatar: '' },
  'b-token': { id: 'user-b', name: 'Bob', username: 'bob', color: '#222', avatar: '' },
  'c-token': { id: 'user-c', name: 'Carol', username: 'carol', color: '#333', avatar: '' },
};
const auth = { userFromRequest: async (req) => USERS[String(req.headers.cookie || '').trim()] || null };
// Alice and Bob share both rooms; Carol only has the public one.
const rooms = {
  exists: (id) => id === ROOM || id === PRIVATE,
  canAccess: (userId, roomId) => roomId === ROOM || userId === 'user-a' || userId === 'user-b',
};
const config = {
  production: false, allowedOrigins: [], publicUrl: '',
  maxConnections: 10, maxConnectionsPerIp: 10, maxWsPayload: 1024 * 1024,
  messagesPerMinute: 1000, heartbeatMs: 30000, trustProxy: false,
};

const server = createServer();
const gateway = attachGateway(server, config, auth, rooms);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}`;

// A tiny client: collects every frame it receives.
const connect = (token) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers: { cookie: token } });
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  ws.on('open', () => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)) }));
  ws.on('error', reject);
});
const settle = () => new Promise((r) => setTimeout(r, 120));
const firstOfType = (inbox, type) => inbox.find((m) => m.type === type);

const alice = await connect('a-token');
const bob = await connect('b-token');
const carol = await connect('c-token');
for (const c of [alice, bob, carol]) c.send({ type: MessageType.Join, bundle: {} });
await settle();

ok(firstOfType(alice.inbox, MessageType.Roster), 'joining yields a roster');
ok(firstOfType(bob.inbox, MessageType.Peer) || firstOfType(alice.inbox, MessageType.Peer), 'peers are announced');

// Alice encrypts a real message with her sender key and relays it.
const senderKey = SenderKey.create();
const exported = senderKey.export();
const frame = await senderKey.encrypt(JSON.stringify({ segment: 'event', kind: 'message', message: { id: 'm1', text: 'ping' } }));
bob.inbox.length = 0;
alice.send({ type: MessageType.Cipher, room: ROOM, n: frame.n, iv: frame.iv, ct: frame.ct });
await settle();

const relayed = firstOfType(bob.inbox, MessageType.Cipher);
ok(Boolean(relayed), 'a real encrypted frame reaches the other client');

// And it must actually decrypt to the original plaintext.
let decrypted = null;
if (relayed) {
  const view = SenderKeyView.from(exported);
  try { decrypted = await view.decrypt({ n: relayed.n, iv: relayed.iv, ct: relayed.ct }); } catch { /* stays null */ }
}
ok(decrypted && JSON.parse(decrypted).message.text === 'ping', 'the relayed frame decrypts to the original message');

// The legacy string-encoded shape must not be accepted (it is not what crypto emits).
bob.inbox.length = 0;
alice.send({ type: MessageType.Cipher, room: ROOM, n: 99, iv: 'aXY=', ct: 'Y2lwaGVy' });
await settle();
ok(!firstOfType(bob.inbox, MessageType.Cipher), 'string-encoded frames are rejected');

// Membership scoping: a private-room frame must not reach a non-member.
carol.inbox.length = 0;
bob.inbox.length = 0;
const priv = await senderKey.encrypt('secret');
alice.send({ type: MessageType.Cipher, room: PRIVATE, n: priv.n, iv: priv.iv, ct: priv.ct });
await settle();
ok(firstOfType(bob.inbox, MessageType.Cipher), 'private-room frame reaches a member');
ok(!firstOfType(carol.inbox, MessageType.Cipher), 'private-room frame does not reach a non-member');

// Typing relays, and the history-key gossip survives the KeyShare hop.
bob.inbox.length = 0;
alice.send({ type: MessageType.Typing, room: ROOM });
await settle();
ok(firstOfType(bob.inbox, MessageType.Typing), 'typing relays');

const bobId = firstOfType(alice.inbox, MessageType.Peer)?.id
  || firstOfType(alice.inbox, MessageType.Roster)?.members?.[0]?.id;
bob.inbox.length = 0;
alice.send({ type: MessageType.KeyShare, to: bobId, box: { ct: [1, 2] }, hist: { [PRIVATE]: new Array(32).fill(7) } });
await settle();
const share = firstOfType(bob.inbox, MessageType.KeyShare);
ok(Boolean(share), 'KeyShare is forwarded');
ok(share?.hist?.[PRIVATE]?.length === 32, 'history-key gossip survives the relay (it used to be stripped)');

for (const c of [alice, bob, carol]) c.ws.close();
gateway.stop();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
