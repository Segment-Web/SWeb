// Syntax-check every JavaScript file in the project, including the web client.
//
// A broken edit in apps/web/public once shipped to production because the check
// script only parsed server files: the browser refused the module, no event
// handlers were attached, and the whole app was dead for fresh sessions. Parsing
// everything is cheap and catches that class of bug before it ever deploys.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOTS = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['node_modules', 'data', '.git']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

const files = [];
for (const root of ROOTS) {
  try { for await (const file of walk(root)) files.push(file); } catch { /* absent root */ }
}

const failures = [];
await Promise.all(files.map(async (file) => {
  try { await run(process.execPath, ['--check', file]); }
  catch (error) { failures.push({ file, message: String(error.stderr || error.message).split('\n').slice(0, 3).join('\n') }); }
}));

for (const { file, message } of failures) {
  console.error(`FAIL ${relative('.', file)}\n${message}\n`);
}
console.log(`syntax: ${files.length - failures.length}/${files.length} files parse`);
if (failures.length) process.exit(1);
