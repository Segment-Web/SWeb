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
import { MessageType, PROTOCOL_VERSION } from '@segment/protocol';
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
  'd-token': { id: 'user-d', name: 'Dana', username: 'dana', color: '#444', avatar: '' },
};
const auth = {
  userFromRequest: async (req) => USERS[String(req.headers.cookie || '').trim()] || null,
  pinDeviceBundle: async (userId, _deviceId, bundle) => {
    if (userId === 'user-c') await new Promise((resolve) => setTimeout(resolve, 80));
    if (userId === 'user-d') throw new Error('DEVICE_LIMIT');
    return bundle;
  },
  consumeDevicePreKey: async () => null,
};
// Alice and Bob share both rooms; Carol only has the public one.
const privateMembers = new Set(['user-a', 'user-b']);
let membershipListener = null;
let privateEpoch = 1;
const rooms = {
  exists: (id) => id === ROOM || id === PRIVATE,
  canAccess: (userId, roomId) => roomId === ROOM || privateMembers.has(userId),
  epoch: (roomId) => roomId === PRIVATE ? privateEpoch : 1,
  epochsFor: (userId) => roomIdEntries(userId),
  ownerId: (roomId) => roomId === PRIVATE ? 'user-a' : '',
  onMembershipChange: (listener) => { membershipListener = listener; return () => { membershipListener = null; }; },
};
const roomIdEntries = (userId) => ({ [ROOM]: 1, ...(privateMembers.has(userId) ? { [PRIVATE]: privateEpoch } : {}) });
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
for (const c of [alice, bob, carol]) c.send({ type: MessageType.Join, version: PROTOCOL_VERSION, bundle: {} });
carol.send({ type: MessageType.Typing, room: ROOM });
await settle();

ok(firstOfType(alice.inbox, MessageType.Roster), 'joining yields a roster');
ok(firstOfType(alice.inbox, MessageType.Typing), 'frames sent after join stay ordered while device pinning waits for the database');
ok(firstOfType(bob.inbox, MessageType.Peer) || firstOfType(alice.inbox, MessageType.Peer), 'peers are announced');
ok(firstOfType(alice.inbox, MessageType.Roster)?.members?.every((member) => member.userId), 'peer records include stable account ids');

// Alice encrypts a real message with her sender key and relays it.
const senderKey = await SenderKey.create();
const exported = await senderKey.export();
const frame = await senderKey.encrypt(JSON.stringify({ segment: 'event', kind: 'message', message: { id: 'm1', text: 'ping' } }));
bob.inbox.length = 0;
alice.send({ type: MessageType.Cipher, room: ROOM, epoch: 1, n: frame.n, iv: frame.iv, ct: frame.ct, sig: frame.sig });
await settle();

const relayed = firstOfType(bob.inbox, MessageType.Cipher);
ok(Boolean(relayed), 'a real encrypted frame reaches the other client');

// And it must actually decrypt to the original plaintext.
let decrypted = null;
if (relayed) {
  const view = SenderKeyView.from(exported);
  try { decrypted = await view.decrypt({ n: relayed.n, iv: relayed.iv, ct: relayed.ct, sig: relayed.sig }); } catch { /* stays null */ }
}
ok(decrypted && JSON.parse(decrypted).message.text === 'ping', 'the relayed frame decrypts to the original message');

// The legacy string-encoded shape must not be accepted (it is not what crypto emits).
bob.inbox.length = 0;
alice.send({ type: MessageType.Cipher, room: ROOM, epoch: 1, n: 99, iv: 'aXY=', ct: 'Y2lwaGVy' });
await settle();
ok(!firstOfType(bob.inbox, MessageType.Cipher), 'string-encoded frames are rejected');

// Membership scoping: a private-room frame must not reach a non-member.
carol.inbox.length = 0;
bob.inbox.length = 0;
const priv = await senderKey.encrypt('secret');
alice.send({ type: MessageType.Cipher, room: PRIVATE, epoch: privateEpoch, n: priv.n, iv: priv.iv, ct: priv.ct, sig: priv.sig });
await settle();
ok(firstOfType(bob.inbox, MessageType.Cipher), 'private-room frame reaches a member');
ok(!firstOfType(carol.inbox, MessageType.Cipher), 'private-room frame does not reach a non-member');

// Typing relays. History keys use a separate room-scoped encrypted route.
bob.inbox.length = 0;
alice.send({ type: MessageType.Typing, room: ROOM });
await settle();
ok(firstOfType(bob.inbox, MessageType.Typing), 'typing relays');

const aliceRoster = firstOfType(alice.inbox, MessageType.Roster);
const peerIdFor = (userId) => aliceRoster?.members?.find((member) => member.userId === userId)?.id
  || alice.inbox.find((message) => message.type === MessageType.Peer && message.userId === userId)?.id;
const bobId = peerIdFor('user-b');
const carolId = peerIdFor('user-c');
bob.inbox.length = 0;
alice.send({ type: MessageType.KeyShare, to: bobId, box: { ct: [1, 2] } });
await settle();
const share = firstOfType(bob.inbox, MessageType.KeyShare);
ok(Boolean(share), 'KeyShare is forwarded');

bob.inbox.length = 0; carol.inbox.length = 0;
alice.send({ type: MessageType.SenderKeyShare, to: bobId, room: PRIVATE, epoch: privateEpoch, box: { ct: [3, 4] } });
alice.send({ type: MessageType.SenderKeyShare, to: carolId, room: PRIVATE, epoch: privateEpoch, box: { ct: [5, 6] } });
await settle();
ok(Boolean(firstOfType(bob.inbox, MessageType.SenderKeyShare)), 'room sender key reaches a current member');
ok(!firstOfType(carol.inbox, MessageType.SenderKeyShare), 'room sender key never reaches a non-member');

bob.inbox.length = 0; carol.inbox.length = 0;
alice.send({ type: MessageType.HistoryKeyRequest, room: PRIVATE, epoch: privateEpoch });
await settle();
const keyRequest = firstOfType(bob.inbox, MessageType.HistoryKeyRequest);
ok(Boolean(keyRequest) && !firstOfType(carol.inbox, MessageType.HistoryKeyRequest), 'history-key request is scoped to room members');
alice.inbox.length = 0;
bob.send({ type: MessageType.HistoryKeyShare, to: keyRequest.from, room: PRIVATE, epoch: privateEpoch, box: { ct: [7, 8] } });
await settle();
ok(Boolean(firstOfType(alice.inbox, MessageType.HistoryKeyShare)), 'encrypted history-key share reaches the requesting member');
alice.inbox.length = 0;
bob.send({ type: MessageType.HistoryKeyShare, to: keyRequest.from, room: PRIVATE, epoch: privateEpoch, rotate: true, box: { ct: [9, 9] } });
await settle();
ok(!firstOfType(alice.inbox, MessageType.HistoryKeyShare), 'non-owner cannot announce a history-key rotation');

// A membership epoch is a server-enforced cryptographic boundary. Once Bob is
// removed, neither an old-epoch ciphertext nor a fresh key share can reach him.
bob.inbox.length = 0; alice.inbox.length = 0;
privateMembers.delete('user-b');
privateEpoch += 1;
membershipListener?.({ roomId: PRIVATE, userId: 'user-b', action: 'left', epoch: privateEpoch });
await settle();
ok(Boolean(firstOfType(bob.inbox, MessageType.RoomAccessRevoked)), 'removed member is told to erase room key state');
const stale = await senderKey.encrypt('stale-after-removal');
alice.send({ type: MessageType.Cipher, room: PRIVATE, epoch: privateEpoch - 1, n: stale.n, iv: stale.iv, ct: stale.ct, sig: stale.sig });
alice.send({ type: MessageType.SenderKeyShare, to: bobId, room: PRIVATE, epoch: privateEpoch, box: { ct: [9] } });
await settle();
ok(!firstOfType(bob.inbox, MessageType.Cipher) && !firstOfType(bob.inbox, MessageType.SenderKeyShare), 'removed member receives neither future ciphertext nor rotated keys');

const dana=await connect('d-token');
const rejected=new Promise((resolve)=>dana.ws.once('close',(code,reason)=>resolve({code,reason:reason.toString()})));
dana.send({type:MessageType.Join,version:PROTOCOL_VERSION,bundle:{}});
const rejectedClose=await rejected;
ok(rejectedClose.code===1008&&rejectedClose.reason==='DEVICE_LIMIT','permanent device rejection has a stable reason for stopping reconnects');

for (const c of [alice, bob, carol]) c.ws.close();
gateway.stop();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
