// Точка входа сервера Segment: HTTP (статика) + WebSocket (чат).

import { createServer } from 'node:http';
import { handleStatic } from './static.js';
import { attachGateway } from './gateway.js';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';

const config = loadConfig();
const auth = await createAuth(config);
let gateway;

const server = createServer(async (req, res) => {
  if (req.url?.split('?')[0] === '/healthz') {
    const body = JSON.stringify({ ok: true, service: 'segment', connections: gateway?.stats().connections || 0 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (await auth.handle(req, res)) return;
  handleStatic(req, res);
});
gateway = attachGateway(server, config, auth);

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server.started', host: config.host, port: config.port, production: config.production }));
});

let stopping = false;
const shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', event: 'server.stopping', signal }));
  gateway.stop();
  auth.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), config.shutdownMs).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
