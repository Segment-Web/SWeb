// Segment WebSocket gateway: a stateless relay for public keys and E2EE ciphertext.

import { WebSocket, WebSocketServer } from 'ws';
import { MessageType, isValidRoom, clean, LIMITS } from '@segment/protocol';

const publicBundle = (bundle) => bundle && typeof bundle === 'object' ? {
  idDh: bundle.idDh,
  idSign: bundle.idSign,
  spk: bundle.spk,
  spkSig: bundle.spkSig,
} : null;

export function attachGateway(server, config) {
  const clients = new Map();
  const ipCounts = new Map();
  const allowedOrigins = new Set(config.allowedOrigins);
  if (config.publicUrl) {
    try { allowedOrigins.add(new URL(config.publicUrl).origin); } catch { /* validated at deploy time */ }
  }

  const clientIp = (request) => {
    if (config.trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    }
    return request.socket.remoteAddress || 'unknown';
  };

  const wss = new WebSocketServer({
    server,
    maxPayload: config.maxWsPayload,
    perMessageDeflate: false,
    verifyClient: ({ origin, req }, done) => {
      const originAllowed = !config.production || allowedOrigins.size === 0 || allowedOrigins.has(origin);
      const ip = clientIp(req);
      const capacityAvailable = wss.clients.size < config.maxConnections
        && (ipCounts.get(ip) || 0) < config.maxConnectionsPerIp;
      done(originAllowed && capacityAvailable, originAllowed ? 503 : 403);
    },
  });

  const online = () => [...clients.values()].filter((client) => client.name).map(({ name }) => ({ name }));
  const isWritable = (ws) => ws.readyState === WebSocket.OPEN && ws.bufferedAmount < config.maxWsPayload * 2;
  const send = (ws, message) => {
    if (isWritable(ws)) ws.send(JSON.stringify(message));
  };
  const broadcast = (message, except = null) => {
    for (const [ws, client] of clients) {
      if (ws !== except && client.name) send(ws, message);
    }
  };
  const clientById = (id) => [...clients.values()].find((client) => client.id === id);
  const sendTo = (id, message) => {
    for (const [ws, client] of clients) {
      if (client.id === id) { send(ws, message); return; }
    }
  };
  const publicOf = (client) => ({
    id: client.id,
    name: client.name,
    color: client.color,
    bundle: publicBundle(client.bundle),
  });

  wss.on('connection', (ws, request) => {
    const ip = clientIp(request);
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    const client = {
      id: crypto.randomUUID(),
      ip,
      isAlive: true,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
    };
    clients.set(ws, client);
    ws.on('error', () => {});
    ws.on('pong', () => { client.isAlive = true; });

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - client.windowStartedAt >= 60000) {
        client.windowStartedAt = now;
        client.messagesInWindow = 0;
      }
      client.messagesInWindow += 1;
      if (client.messagesInWindow > config.messagesPerMinute) {
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message !== 'object') return;

      if (message.type === MessageType.Join) {
        if (client.name) return;
        client.name = clean(message.name, LIMITS.name) || 'anon';
        client.color = typeof message.color === 'string' ? clean(message.color, 32) : '';
        client.bundle = message.bundle && typeof message.bundle === 'object' ? message.bundle : null;
        const members = [...clients.values()].filter((other) => other.name && other !== client).map(publicOf);
        send(ws, { type: MessageType.Roster, self: { id: client.id }, members, online: online() });
        broadcast({ type: MessageType.Peer, ...publicOf(client), online: online() }, ws);
        broadcast({ type: MessageType.System, text: `${client.name} в чате`, online: online() });
        return;
      }

      if (!client.name) return;
      if (message.type === MessageType.PreKeyRequest) {
        const target = clientById(message.to);
        const opk = target?.bundle?.opks?.length ? target.bundle.opks.shift() : null;
        send(ws, { type: MessageType.PreKey, from: message.to, opk });
        return;
      }
      if (message.type === MessageType.KeyShare && typeof message.to === 'string') {
        sendTo(message.to, { type: MessageType.KeyShare, from: client.id, x3dh: message.x3dh, box: message.box });
        return;
      }
      if (message.type === MessageType.Cipher && isValidRoom(message.room)) {
        broadcast({ type: MessageType.Cipher, from: client.id, room: message.room, n: message.n, iv: message.iv, ct: message.ct }, ws);
        return;
      }
      if (message.type === MessageType.Typing && isValidRoom(message.room)) {
        broadcast({ type: MessageType.Typing, name: client.name, room: message.room }, ws);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      const remaining = (ipCounts.get(ip) || 1) - 1;
      if (remaining > 0) ipCounts.set(ip, remaining); else ipCounts.delete(ip);
      if (client.name) {
        broadcast({ type: MessageType.PeerLeft, id: client.id, online: online() });
        broadcast({ type: MessageType.System, text: `${client.name} вышел`, online: online() });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.isAlive) { ws.terminate(); continue; }
      client.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    stats: () => ({ connections: clients.size, joined: [...clients.values()].filter((client) => client.name).length }),
    stop: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'Server restarting');
      wss.close();
    },
  };
}
