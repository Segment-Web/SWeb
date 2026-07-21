// File store self-test: exercises the real files.handle() over a temp dir.
// Covers auth, upload, content-addressed dedup, retrieval, size limit and 404.
//
// Run: node apps/server/src/files.selftest.js

import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';
import { createFiles } from './files.js';

const dir = await mkdtemp(join(tmpdir(), 'segment-files-'));
const config = { production: false, allowedOrigins: [], publicUrl: '', fileDir: dir, fileMaxBytes: 1024, fileTtlMs: 0, fileUploadsPerMinute: 6 };
const auth = { userFromRequest: async (req) => req._user ?? null };
const files = await createFiles(config, auth);

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('ok   ' + label); } else { fail++; console.log('FAIL ' + label); } };

const call = async (method, url, { user = null, body, chunks: rawChunks, stream = null, headers = {} } = {}) => {
  const chunks = rawChunks
    ? rawChunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))
    : (body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  const req = stream || Readable.from(chunks);
  req.method = method; req.url = url; req.headers = { origin: '', ...headers }; req._user = user;
  let status = 0; let responseHeaders = {}; const parts = []; let jsonMode = true;
  const res = {
    writeHead(code, nextHeaders) { status = code; responseHeaders = nextHeaders || {}; if (nextHeaders && nextHeaders['Content-Type'] === 'application/octet-stream') jsonMode = false; return res; },
    write(chunk) { if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  };
  await files.handle(req, res);
  const buf = Buffer.concat(parts);
  return { status, headers: responseHeaders, data: jsonMode && buf.length ? JSON.parse(buf.toString()) : null, bytes: buf };
};
const user = { id: 'u1' };

// Unauthenticated upload is rejected.
const anon = await call('POST', '/api/files', { body: 'hello' });
ok(anon.status === 401, 'unauthenticated upload -> 401');

// Upload returns a random bearer capability, not the physical content hash.
const up = await call('POST', '/api/files', { user, body: 'encrypted-blob-A' });
ok(up.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(up.data.id) && up.data.size === 16, 'upload -> 201 with random capability id');

// Identical bytes dedup physically but receive unlinkable capabilities.
const up2 = await call('POST', '/api/files', { user, body: 'encrypted-blob-A' });
const physicalAfterDedup = (await readdir(dir)).filter((name)=>/^[0-9a-f]{64}$/.test(name));
ok(up2.data.id !== up.data.id && physicalAfterDedup.length===1, 'identical upload dedups without reusing its capability');

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

// Resumable uploads preserve the acknowledged offset and finalize to the same
// content-addressed blob as a one-shot upload.
const resumeUser = { id: 'u2' };
const resume = await call('POST', '/api/files/uploads', { user: resumeUser, headers: { 'upload-length': '12' } });
const resumeId = resume.data.uploadId;
const chunkA = await call('PATCH', `/api/files/uploads/${resumeId}`, { user: resumeUser, body: 'hello-', headers: { 'upload-offset': '0' } });
const head = await call('HEAD', `/api/files/uploads/${resumeId}`, { user: resumeUser });
const chunkB = await call('PATCH', `/api/files/uploads/${resumeId}`, { user: resumeUser, body: 'resume', headers: { 'upload-offset': '6' } });
const complete = await call('POST', `/api/files/uploads/${resumeId}/complete`, { user: resumeUser });
const resumedBack = await call('GET', `/api/files/${complete.data.id}`, { user: resumeUser });
ok(resume.status === 201 && chunkA.data.offset === 6 && head.headers['Upload-Offset'] === '6', 'resumable upload reports its acknowledged offset');
ok(chunkB.data.offset === 12 && complete.status === 201 && resumedBack.bytes.toString() === 'hello-resume', 'resumable upload finalizes and round-trips');

// Cancellation cannot delete a resumable upload while a PATCH still owns its
// file lock. Once the chunk completes, a retry removes both metadata and bytes.
const raceUser = { id: 'u3' };
const race = await call('POST', '/api/files/uploads', { user: raceUser, headers: { 'upload-length': '8' } });
const raceId = race.data.uploadId;
const slowBody = new PassThrough();
const activePatch = call('PATCH', `/api/files/uploads/${raceId}`, { user: raceUser, stream: slowBody, headers: { 'upload-offset': '0' } });
await new Promise((resolve) => setTimeout(resolve, 10));
const busyDelete = await call('DELETE', `/api/files/uploads/${raceId}`, { user: raceUser });
slowBody.end('12345678');
const finishedPatch = await activePatch;
const deletedUpload = await call('DELETE', `/api/files/uploads/${raceId}`, { user: raceUser });
const missingUpload = await call('HEAD', `/api/files/uploads/${raceId}`, { user: raceUser });
const uploadFiles = await readdir(dir);
ok(busyDelete.status === 409 && finishedPatch.status === 200, 'active upload chunk blocks concurrent cancellation');
ok(deletedUpload.status === 200 && missingUpload.status === 404 && !uploadFiles.includes(`.upload-${raceId}`), 'cancellation retry removes upload metadata and temporary bytes');

// The per-account limiter prevents one authenticated client from filling disk.
const limited = await call('POST', '/api/files', { user, body: 'one-upload-too-many' });
ok(limited.status === 429, 'per-user upload rate limit -> 429');

files.close();
await rm(dir, { recursive: true, force: true });

// Database-backed authorization: a blob reference belongs to a room, current
// membership is required to read it, and releasing the final reference removes
// the orphaned ciphertext from disk.
const secureDir = await mkdtemp(join(tmpdir(), 'segment-files-secure-'));
const db = newDb(); const { Pool } = db.adapters.createPg(); const pool = new Pool();
await pool.query('CREATE TABLE users(id UUID PRIMARY KEY); CREATE TABLE rooms(id TEXT PRIMARY KEY);');
const alice = { id:'00000000-0000-4000-8000-000000000001' };
const bob = { id:'00000000-0000-4000-8000-000000000002' };
await pool.query('INSERT INTO users(id) VALUES($1),($2); INSERT INTO rooms(id) VALUES($3),($4);', [alice.id,bob.id,'room-a','room-b']);
const access = new Map([['room-a',new Set([alice.id,bob.id])],['room-b',new Set([alice.id])]]);
const secureAuth = { pool, userFromRequest:async(req)=>req._user??null };
const secureRooms = { canAccess:(userId,roomId)=>Boolean(access.get(roomId)?.has(userId)), ownerId:()=>alice.id, isPublic:(roomId)=>roomId==='room-b' };
const legacyBytes = Buffer.from('legacy-encrypted-blob');
const legacyId = createHash('sha256').update(legacyBytes).digest('hex');
await writeFile(join(secureDir, legacyId), legacyBytes);
const secureFiles = await createFiles({ ...config, fileDir:secureDir, fileUploadsPerMinute:60 }, secureAuth, secureRooms);
await secureFiles.migration;
const secureCall = async (method, url, { user=null, body, headers={} }={}) => {
  const req=Readable.from(body===undefined?[]:[Buffer.isBuffer(body)?body:Buffer.from(body)]); req.method=method; req.url=url; req.headers={ origin:'', ...headers }; req._user=user;
  let status=0; let responseHeaders={}; const parts=[]; let jsonMode=true;
  const res={ writeHead(code,nextHeaders){status=code;responseHeaders=nextHeaders||{};if(nextHeaders?.['Content-Type']==='application/octet-stream')jsonMode=false;return res;}, write(chunk){if(chunk)parts.push(Buffer.from(chunk));return true;}, end(chunk){if(chunk)parts.push(Buffer.from(chunk));} };
  await secureFiles.handle(req,res); const bytes=Buffer.concat(parts);
  return { status, headers:responseHeaders, data:jsonMode&&bytes.length?JSON.parse(bytes.toString()):null, bytes };
};
const legacyImported = await pool.query('SELECT 1 FROM file_blobs WHERE file_id=$1', [legacyId]);
const memberClaim = await secureCall('POST','/api/files/refs/claim',{user:bob,body:JSON.stringify({roomId:'room-a',fileIds:[legacyId]})});
const publicClaim = await secureCall('POST','/api/files/refs/claim',{user:alice,body:JSON.stringify({roomId:'room-b',fileIds:[legacyId]})});
const legacyClaim = await secureCall('POST','/api/files/refs/claim',{user:alice,body:JSON.stringify({roomId:'room-a',fileIds:[legacyId]})});
const legacyRead = await secureCall('GET',`/api/files/${legacyId}?roomId=room-a`,{user:bob});
ok(legacyImported.rowCount===1&&memberClaim.status===403&&publicClaim.status===403&&legacyClaim.data.claimed===1&&legacyRead.bytes.equals(legacyBytes),'legacy claim is temporary, private and owner-only');
const scopedUpload = await secureCall('POST','/api/files?roomId=room-a',{user:alice,body:'room-secret'});
const scopedRead = await secureCall('GET',`/api/files/${scopedUpload.data.id}`,{user:bob});
const guessedHash = createHash('sha256').update('room-secret').digest('hex');
const hashOracle = await secureCall('GET',`/api/files/${guessedHash}?roomId=room-a`,{user:bob});
const forbiddenUpload = await secureCall('POST','/api/files?roomId=room-b',{user:bob,body:'denied'});
ok(scopedUpload.status===201&&/^[A-Za-z0-9_-]{43}$/.test(scopedUpload.data.id)&&scopedRead.bytes.toString()==='room-secret','capability holder reads an encrypted blob');
ok(hashOracle.status===404&&forbiddenUpload.status===403,'physical hashes are not capabilities for new blobs');
// A removed member keeps every capability their decrypted history carried, so
// membership has to be re-checked on each fetch, not only when it was handed out.
access.get('room-a').delete(bob.id);
const revokedRead = await secureCall('GET',`/api/files/${scopedUpload.data.id}`,{user:bob});
access.get('room-a').add(bob.id);
ok(revokedRead.status===403,'a removed member cannot fetch attachments with a retained capability');
await secureCall('DELETE','/api/files/refs',{user:alice,body:JSON.stringify({roomId:'room-a',fileIds:[scopedUpload.data.id]})});
const afterRelease = await secureCall('GET',`/api/files/${scopedUpload.data.id}`,{user:alice});
ok(afterRelease.status===404,'released file reference no longer authorizes a download');
ok(!(await readdir(secureDir)).includes(guessedHash),'releasing the final capability removes the orphan');
secureFiles.close(); await pool.end(); await rm(secureDir,{recursive:true,force:true});
console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
