// Wire-contract self-test: the frames the crypto layer actually produces must be
// the frames the relay accepts.
//
// This exists because the relay once demanded `iv`/`ct` as strings while the
// crypto layer emitted byte arrays. Every encrypted message was silently dropped
// by the server, yet typing indicators (which are not encrypted) still arrived —
// so the app looked alive while no chat message ever got through.
//
// Run: node packages/protocol/selftest.js

import { SenderKey, DoubleRatchet, createPreKeyBundle, x3dhInitiate } from '@segment/crypto';
import { isCipherFrame, MAX_IV_BYTES, parseLink, SLUG_RE } from './index.js';

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

const MAX_CT = 16 * 1024 * 1024;

// A real sender-key frame (group rooms) must satisfy the relay's validator.
const sender = SenderKey.create();
const frame = await sender.encrypt('hello');
ok(isCipherFrame(frame, MAX_CT), 'real SenderKey frame is accepted by the relay validator');
ok(Array.isArray(frame.iv) && Array.isArray(frame.ct), 'crypto emits iv/ct as byte arrays, not strings');

// Sequence numbers keep advancing and stay valid.
const second = await sender.encrypt('again');
ok(second.n === frame.n + 1 && isCipherFrame(second, MAX_CT), 'subsequent frames stay valid');

// Pairwise ratchet frames are a DIFFERENT shape: {header, iv, ct} with no
// sequence number. They ride inside KeyShare.box and are never relayed as Cipher
// frames, so they must not be judged by isCipherFrame — but they do use the same
// byte-array encoding for iv/ct.
const bob = await createPreKeyBundle(1);
const { ratchet } = await x3dhInitiate((await createPreKeyBundle(1)).secret, { ...bob.bundle, opks: [bob.bundle.opks[0]] });
ok(ratchet instanceof DoubleRatchet, 'x3dh yields a ratchet');
const ratchetFrame = await ratchet.encrypt('direct');
ok(Array.isArray(ratchetFrame.iv) && Array.isArray(ratchetFrame.ct), 'ratchet frame also encodes iv/ct as byte arrays');
ok(ratchetFrame.header !== undefined && ratchetFrame.n === undefined, 'ratchet frame carries a header and no sequence (it travels in KeyShare)');

// Rejections.
ok(!isCipherFrame({ n: 0, iv: 'aXY=', ct: 'Y3Q=' }, MAX_CT), 'string iv/ct are rejected');
ok(!isCipherFrame({ n: -1, iv: [1], ct: [1] }, MAX_CT), 'negative sequence is rejected');
ok(!isCipherFrame({ n: 0, iv: [], ct: [1] }, MAX_CT), 'empty iv is rejected');
ok(!isCipherFrame({ n: 0, iv: new Array(MAX_IV_BYTES + 1).fill(0), ct: [1] }, MAX_CT), 'oversized iv is rejected');
ok(!isCipherFrame({ n: 0, iv: [1], ct: [1, 2, 3] }, 2), 'oversized ct is rejected');
ok(!isCipherFrame(null, MAX_CT), 'null frame is rejected');

// Link helpers.
ok(parseLink('/@Alice')?.username === 'alice', 'parseLink lowercases a profile');
ok(parseLink('/c/dev-talk')?.slug === 'dev-talk', 'parseLink reads a channel slug');
ok(parseLink('/nope') === null, 'parseLink rejects an unknown path');
ok(SLUG_RE.test('dev-talk') && !SLUG_RE.test('-bad'), 'slug rule accepts valid and rejects invalid');

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
