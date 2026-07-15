// File store self-test: exercises the real files.handle() over a temp dir.
// Covers auth, upload, content-addressed dedup, retrieval, size limit and 404.
//
// Run: node apps/server/src/files.selftest.js

import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFiles } from './files.js';

const dir = await mkdtemp(join(tmpdir(), 'segment-files-'));
const config = { production: false, allowedOrigins: [], publicUrl: '', fileDir: dir, fileMaxBytes: 1024, fileTtlMs: 0 };
const auth = { userFromRequest: async (req) => req._user ?? null };
const files = await createFiles(config, auth);

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

const call = async (method, url, { user = null, body, chunks: rawChunks } = {}) => {
  const chunks = rawChunks
    ? rawChunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))
    : (body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  const req = Readable.from(chunks);
  req.method = method; req.url = url; req.headers = { origin: '' }; req._user = user;
  let status = 0; const parts = []; let jsonMode = true;
  const res = {
    writeHead(code, headers) { status = code; if (headers && headers['Content-Type'] === 'application/octet-stream') jsonMode = false; return res; },
    write(chunk) { if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  };
  await files.handle(req, res);
  const buf = Buffer.concat(parts);
  return { status, data: jsonMode && buf.length ? JSON.parse(buf.toString()) : null, bytes: buf };
};
const user = { id: 'u1' };

// Unauthenticated upload is rejected.
const anon = await call('POST', '/api/files', { body: 'hello' });
ok(anon.status === 401, 'unauthenticated upload -> 401');

// Upload returns a content-addressed id.
const up = await call('POST', '/api/files', { user, body: 'encrypted-blob-A' });
ok(up.status === 201 && /^[0-9a-f]{64}$/.test(up.data.id) && up.data.size === 16, 'upload -> 201 with sha256 id');

// Identical bytes dedup to the same id.
const up2 = await call('POST', '/api/files', { user, body: 'encrypted-blob-A' });
ok(up2.data.id === up.data.id, 'identical upload dedups to same id');

// Different bytes get a different id.
const up3 = await call('POST', '/api/files', { user, body: 'encrypted-blob-B' });
ok(up3.data.id !== up.data.id, 'different upload -> different id');

// Retrieval returns the exact bytes.
const got = await call('GET', `/api/files/${up.data.id}`, { user });
ok(got.status === 200 && got.bytes.toString() === 'encrypted-blob-A', 'retrieve returns exact bytes');

// Unknown id -> 404.
const missing = await call('GET', `/api/files/${'0'.repeat(64)}`, { user });
ok(missing.status === 404, 'unknown id -> 404');

// Malformed id -> 404.
const bad = await call('GET', '/api/files/not-a-hash', { user });
ok(bad.status === 404, 'malformed id -> 404');

// Multi-chunk streamed upload under the cap succeeds and round-trips exactly.
const parts = ['chunk-1-', 'chunk-2-', 'chunk-3'];
const streamed = await call('POST', '/api/files', { user, chunks: parts });
ok(streamed.status === 201 && streamed.data.size === parts.join('').length, 'multi-chunk upload -> 201 correct size');
const streamedBack = await call('GET', `/api/files/${streamed.data.id}`, { user });
ok(streamedBack.bytes.toString() === parts.join(''), 'streamed upload round-trips exactly');

// Oversized upload -> 413 (even when it only exceeds the cap partway through).
const big = await call('POST', '/api/files', { user, chunks: [Buffer.alloc(600, 1), Buffer.alloc(600, 2)] });
ok(big.status === 413, 'oversized streamed upload -> 413');

// Empty upload -> 400.
const empty = await call('POST', '/api/files', { user, body: Buffer.alloc(0) });
ok(empty.status === 400, 'empty upload -> 400');

files.close();
await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
