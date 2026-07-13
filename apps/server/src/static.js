// Static delivery for the web client and shared packages.
// The browser imports the same protocol and core source files as Node through
// the import map in index.html, avoiding a separate browser copy.

import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(here, '../../web/public');
const SHARED_DIR = join(here, '../../../packages');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Keep normalized paths inside the selected static root.
function safeJoin(base, urlPath) {
  const rel = normalize(urlPath).replace(/^([/\\]|\.\.[/\\])+/, '');
  return join(base, rel);
}

async function sendFile(res, path) {
  try {
    const file = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

export function handleStatic(req, res) {
  const url = req.url.split('?')[0];

  if (url.startsWith('/shared/')) {
    return sendFile(res, safeJoin(SHARED_DIR, url.slice('/shared/'.length)));
  }

  const path = url === '/' ? 'index.html' : url;
  return sendFile(res, safeJoin(WEB_DIR, path));
}
