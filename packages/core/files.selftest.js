// Client file-transport self-test. Verifies that attachments are encrypted,
// uploaded and referenced on send, and fetched + decrypted back on receive,
// against a stubbed blob store. Runs in Node using global crypto.subtle.
//
// Run: node packages/core/files.selftest.js

import { createHash } from 'node:crypto';
import { SegmentClient } from './index.js';

// Force the data-URL fallback in _bytesToUrl so the test can read bytes back;
// in the browser this path returns an opaque blob: URL instead.
if (globalThis.URL) globalThis.URL.createObjectURL = undefined;

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

// In-memory blob store standing in for /api/files.
const store = new Map();
let lastStoredCiphertext = null;
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    const bytes = options.body instanceof Uint8Array ? options.body : new Uint8Array(options.body);
    lastStoredCiphertext = bytes;
    const id = createHash('sha256').update(bytes).digest('hex');
    store.set(id, bytes);
    return { ok: true, status: 201, json: async () => ({ id, size: bytes.length }) };
  }
  const id = url.split('/api/files/')[1];
  const bytes = store.get(id);
  if (!bytes) return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) };
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};

const storageStub = {
  getName: () => 'Tester', getUsername: () => 'tester', getAvatar: () => '', getColor: () => '#7c5cff',
  getNotes: () => [], getGeneral: () => [], getPinned: () => [], getMuted: () => [], getArchived: () => [], getFolders: () => [],
  setNotes: () => {}, setGeneral: () => {},
};
const client = new SegmentClient({ storage: storageStub });

// A binary payload as a data URL, as the UI produces for attachments.
const original = new Uint8Array(5000);
for (let i = 0; i < original.length; i++) original[i] = (i * 13 + 7) & 0xff;
const dataUrl = `data:image/png;base64,${Buffer.from(original).toString('base64')}`;

const bytesOfUrl = (url) => client._dataUrlToBytes(url).bytes;
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Seal + upload produces a reference plus a locally playable url.
const { ref, url: localUrl } = await client._sealDataUrl(dataUrl);
ok(/^[0-9a-f]{64}$/.test(ref.fileId) && ref.key.length === 32 && ref.size === original.length, 'seal returns a valid blob reference');
ok(sameBytes(bytesOfUrl(localUrl), original), 'seal also returns a playable url for the sender');
ok(lastStoredCiphertext && !sameBytes(lastStoredCiphertext, original), 'uploaded bytes are encrypted, not the plaintext');

// Fetch + decrypt reproduces the exact original bytes.
const url = await client._fetchToUrl(ref);
ok(sameBytes(bytesOfUrl(url), original), 'fetch+decrypt reproduces original bytes');

// _toWire uploads attachments and strips inline data from the wire copy.
const event = { kind: 'message', message: { id: 'm1', attachments: [{ kind: 'photo', name: 'p.png', data: dataUrl }] } };
const wire = await client._toWire(event);
const wireAtt = wire.message.attachments[0];
ok(!wireAtt.data && wireAtt.blob?.fileId, 'wire attachment carries a blob ref, not inline data');
const localAtt = event.message.attachments[0];
ok(localAtt.data && sameBytes(bytesOfUrl(localAtt.data), original), 'sender keeps a playable copy of the same bytes');
ok(localAtt.blob?.fileId === wireAtt.blob.fileId, 'sender also keeps the blob ref (so the message can be erased later)');

// A received attachment (ref only) hydrates back to displayable bytes.
const received = { kind: 'photo', name: 'p.png', blob: wireAtt.blob };
await client._hydrateAttachment(received);
ok(received.data && sameBytes(bytesOfUrl(received.data), original), 'received attachment hydrates back to original bytes');

// Poster (video thumbnail) is uploaded and hydrated too.
const poster = `data:image/jpeg;base64,${Buffer.from(original.slice(0, 100)).toString('base64')}`;
const vWire = await client._attachmentToWire({ kind: 'video', data: dataUrl, poster });
ok(vWire.posterBlob?.fileId && !vWire.poster, 'video poster uploaded and stripped');
const vRecv = { kind: 'video', blob: vWire.blob, posterBlob: vWire.posterBlob };
await client._hydrateAttachment(vRecv);
ok(vRecv.poster && vRecv.data, 'video attachment hydrates both body and poster');

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
