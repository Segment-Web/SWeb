// Segment server entry point: static HTTP delivery and the WebSocket relay.

import { createServer } from 'node:http';
import { handleStatic } from './static.js';
import { attachGateway } from './gateway.js';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { createRooms } from './rooms.js';
import { createFiles } from './files.js';

const config = loadConfig();
const auth = await createAuth(config);
const rooms = await createRooms(config, auth);
const files = await createFiles(config, auth, rooms);
let gateway;

const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.url?.split('?')[0] === '/healthz') {
    const body = JSON.stringify({ ok: true, service: 'segment', connections: gateway?.stats().connections || 0 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.url?.split('?')[0] === '/readyz') {
    try {
      await auth.ready();
      const body = JSON.stringify({ ok: true, service: 'segment' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, service: 'segment' }));
    }
    return;
  }
  if (await auth.handle(req, res)) return;
  if (await rooms.handle(req, res)) return;
  if (await files.handle(req, res)) return;
  handleStatic(req, res);
});
gateway = attachGateway(server, config, auth, rooms);

server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 65000;
server.maxRequestsPerSocket = 1000;

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server.started', host: config.host, port: config.port, production: config.production }));
});

let stopping = false;
const shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', event: 'server.stopping', signal }));
  gateway.stop();
  files.close();
  auth.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), config.shutdownMs).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
