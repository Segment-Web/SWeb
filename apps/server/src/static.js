// Раздача статики: веб-клиент и общие пакеты.
//
// Отдаёт файлы из apps/web/public по `/`, а каталог packages/ — по `/shared/`,
// чтобы браузер импортировал ровно те же исходники @segment/protocol и
// @segment/core, что и Node (единый источник правды, без сборки и дублирования).
// Имена пакетов в браузере разрешает import map в index.html.

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

// Защита от выхода за пределы каталога (path traversal).
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
