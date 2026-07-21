// Segment WebSocket gateway: a stateless relay for public keys and E2EE ciphertext.

import { WebSocket, WebSocketServer } from 'ws';
import { MessageType, PROTOCOL_VERSION, isCipherFrame } from '@segment/protocol';

const publicBundle = (bundle) => bundle && typeof bundle === 'object' ? {
  deviceId: bundle.deviceId,
  idDh: bundle.idDh,
  idSign: bundle.idSign,
  spk: bundle.spk,
  spkSig: bundle.spkSig,
} : null;

export function attachGateway(server, config, auth, rooms) {
  const clients = new Map();
  const clientsById = new Map();
  const ipCounts = new Map();
  const allowedOrigins = new Set(config.allowedOrigins);
  if (config.publicUrl) {
    try { allowedOrigins.add(new URL(config.publicUrl).origin); } catch { /* validated at deploy time */ }
  }

  const clientIp = (request) => {
    if (config.trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
        if (chain.length) return chain.at(-1);
      }
    }
    return request.socket.remoteAddress || 'unknown';
  };

  const wss = new WebSocketServer({
    server,
    maxPayload: config.maxWsPayload,
    perMessageDeflate: false,
    verifyClient: async ({ origin, req }, done) => {
      const originAllowed = !config.production || (allowedOrigins.size > 0 && allowedOrigins.has(origin));
      const ip = clientIp(req);
      const capacityAvailable = wss.clients.size < config.maxConnections
        && (ipCounts.get(ip) || 0) < config.maxConnectionsPerIp;
      try {
        const user = originAllowed && capacityAvailable ? await auth.userFromRequest(req) : null;
        req.segmentUser = user;
        done(Boolean(originAllowed && capacityAvailable && user), !originAllowed ? 403 : (!capacityAvailable ? 503 : 401));
      } catch { done(false, 503); }
    },
  });

  const avatarUrl = (client) => client.avatar ? `/api/auth/avatar/${client.userId}` : '';
  const online = () => {
    const users = new Map();
    for (const client of clients.values()) {
      if (client.joined) users.set(client.userId, { name: client.name, username: client.username, avatar: avatarUrl(client) });
    }
    return [...users.values()];
  };
  const isWritable = (ws) => ws.readyState === WebSocket.OPEN && ws.bufferedAmount < config.maxWsPayload * 2;
  const send = (ws, message) => {
    if (isWritable(ws)) ws.send(JSON.stringify(message));
  };
  const broadcast = (message, except = null) => {
    for (const [ws, client] of clients) {
      if (ws !== except && client.joined) send(ws, message);
    }
  };
  let presenceTimer = null;
  const schedulePresence = () => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      broadcast({ type: MessageType.Presence, online: online() });
    }, 250);
    presenceTimer.unref();
  };
  // Deliver only to joined sockets whose user may access the room. Public rooms
  // reach everyone; private rooms reach members only.
  const broadcastRoom = (roomId, message, except = null) => {
    for (const [ws, client] of clients) {
      if (ws !== except && client.joined && rooms.canAccess(client.userId, roomId)) send(ws, message);
    }
  };
  const clientById = (id) => clientsById.get(id)?.client;
  const sendTo = (id, message) => {
    const target = clientsById.get(id);
    if (target) send(target.ws, message);
  };
  const publicOf = (client) => ({
    id: client.id,
    userId: client.userId,
    name: client.name,
    username: client.username,
    avatar: avatarUrl(client),
    color: client.color,
    bundle: publicBundle(client.bundle),
  });
  const offMembership = rooms.onMembershipChange?.((change) => {
    const ownerId = rooms.ownerId?.(change.roomId);
    const ownerSockets = [...clients.entries()].filter(([, client]) => client.joined && client.userId === ownerId).sort((a, b) => a[1].id.localeCompare(b[1].id));
    const epoch = Number(change.epoch || rooms.epoch?.(change.roomId) || 1);
    for (const [ws, client] of clients) {
      if (!client.joined) continue;
      if (client.userId === change.userId && !rooms.canAccess(client.userId, change.roomId)) {
        send(ws, { type: MessageType.RoomAccessRevoked, room: change.roomId, epoch });
        continue;
      }
      if (rooms.canAccess(client.userId, change.roomId)) {
        send(ws, {
          type: MessageType.RoomMembersChanged,
          room: change.roomId,
          action: change.action,
          epoch,
          rotateHistory: ownerSockets[0]?.[0] === ws,
        });
      }
    }
  });
  const offDeviceRemoved = auth.onDeviceRemoved?.(({ userId, deviceId }) => {
    for (const [ws, client] of clients) {
      if (client.userId === userId && client.bundle?.deviceId === deviceId) ws.close(1008, 'DEVICE_REVOKED');
    }
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
      userId: request.segmentUser.id,
      name: request.segmentUser.name,
      username: request.segmentUser.username,
      avatar: request.segmentUser.avatar || '',
      color: request.segmentUser.color,
      queue: Promise.resolve(),
    };
    clients.set(ws, client);
    clientsById.set(client.id, { ws, client });
    ws.on('error', () => {});
    ws.on('pong', () => { client.isAlive = true; });

    ws.on('message', (raw) => {
      client.queue = client.queue.then(async () => {
      try {
      const now = Date.now();
      if (now - client.windowStartedAt >= 60000) {
        client.windowStartedAt = now;
        client.messagesInWindow = 0;
      }
      client.messagesInWindow += 1;
      if (client.messagesInWindow > config.messagesPerMinute) {
        // Transient overload, not a policy decision: close with "try again later"
        // so the client backs off and reconnects instead of staying dead.
        ws.close(1013, 'RATE_LIMIT');
        return;
      }

      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message !== 'object') return;

      if (message.type === MessageType.Join) {
        if (client.joined) return;
        if (message.version !== PROTOCOL_VERSION) {
          ws.close(1002, 'Protocol upgrade required');
          return;
        }
        try {
          client.bundle = await auth.pinDeviceBundle(client.userId, message.bundle?.deviceId, message.bundle);
        } catch (error) {
          ws.close(1008, ['DEVICE_LIMIT','DEVICE_IDENTITY_CHANGED'].includes(error.message) ? error.message : 'DEVICE_REJECTED');
          return;
        }
        client.joined = true;
        const members = [...clients.values()].filter((other) => other.joined && other !== client).map(publicOf);
        const roomEpochs = rooms.epochsFor?.(client.userId) || {};
        const historyRecoveryRooms = Object.keys(roomEpochs).filter((roomId) => {
          if (rooms.ownerId?.(roomId) !== client.userId) return false;
          const ownerSocketIds = [...clients.values()]
            .filter((other) => other.joined && other.userId === client.userId)
            .map((other) => other.id).sort();
          return ownerSocketIds[0] === client.id;
        });
        send(ws, { type: MessageType.Roster, self: { id: client.id }, members, online: online(), roomEpochs, historyRecoveryRooms });
        broadcast({ type: MessageType.Peer, ...publicOf(client) }, ws);
        broadcast({ type: MessageType.System, text: `${client.name} в чате` }, ws);
        schedulePresence();
        return;
      }

      if (!client.joined) return;
      if (message.type === MessageType.PreKeyRequest) {
        const target = clientById(message.to);
        const opk = target ? await auth.consumeDevicePreKey(client.userId, target.userId, target.bundle?.deviceId) : null;
        if (opk && target?.bundle?.opks?.length) target.bundle.opks.shift();
        if (opk && target) sendTo(target.id, { type: MessageType.PreKeyConsumed, opkId: opk.id });
        send(ws, { type: MessageType.PreKey, from: message.to, opk });
        return;
      }
      if (message.type === MessageType.KeyShare && typeof message.to === 'string' && message.to.length < 80 && message.box && typeof message.box === 'object') {
        sendTo(message.to, { type: MessageType.KeyShare, from: client.id, x3dh: message.x3dh, box: message.box });
        return;
      }
      const validRoomEpoch = (roomId, epoch) => Number.isSafeInteger(epoch) && epoch > 0 && epoch === rooms.epoch?.(roomId);
      if (message.type === MessageType.SenderKeyShare && typeof message.to === 'string' && message.box && typeof message.box === 'object'
        && rooms.exists(message.room) && validRoomEpoch(message.room, message.epoch) && rooms.canAccess(client.userId, message.room)) {
        const target = clientsById.get(message.to)?.client;
        if (target && rooms.canAccess(target.userId, message.room)) {
          sendTo(message.to, { type: MessageType.SenderKeyShare, from: client.id, room: message.room, epoch: message.epoch, box: message.box });
        }
        return;
      }
      if (message.type === MessageType.HistoryKeyRequest && rooms.exists(message.room)
        && validRoomEpoch(message.room, message.epoch) && rooms.canAccess(client.userId, message.room)) {
        broadcastRoom(message.room, { type: MessageType.HistoryKeyRequest, from: client.id, room: message.room, epoch: message.epoch }, ws);
        return;
      }
      if (message.type === MessageType.HistoryKeyShare && typeof message.to === 'string' && message.box && typeof message.box === 'object'
        && rooms.exists(message.room) && validRoomEpoch(message.room, message.epoch) && rooms.canAccess(client.userId, message.room)) {
        if (message.rotate === true && rooms.ownerId?.(message.room) !== client.userId) return;
        const target = clientById(message.to);
        if (target && rooms.canAccess(target.userId, message.room)) {
          sendTo(message.to, { type: MessageType.HistoryKeyShare, from: client.id, room: message.room, epoch: message.epoch, rotate: message.rotate === true, box: message.box });
        }
        return;
      }
      if (message.type === MessageType.Cipher && rooms.exists(message.room)
        && validRoomEpoch(message.room, message.epoch)
        && rooms.canAccess(client.userId, message.room)
        && isCipherFrame(message, config.maxWsPayload)) {
        const eventId = typeof message.eventId === 'string' && message.eventId.length <= 96 ? message.eventId : '';
        broadcastRoom(message.room, { type: MessageType.Cipher, from: client.id, room: message.room, epoch: message.epoch, eventId, n: message.n, iv: message.iv, ct: message.ct, sig: message.sig }, ws);
        if (eventId) send(ws, { type: MessageType.Ack, eventId });
        return;
      }
      if (message.type === MessageType.Typing && rooms.exists(message.room) && rooms.canAccess(client.userId, message.room)) {
        broadcastRoom(message.room, { type: MessageType.Typing, name: client.name, room: message.room }, ws);
      }
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'gateway.message_failed', message: error.message }));
      }
      }).catch(() => {});
    });

    ws.on('close', () => {
      clients.delete(ws);
      clientsById.delete(client.id);
      const remaining = (ipCounts.get(ip) || 1) - 1;
      if (remaining > 0) ipCounts.set(ip, remaining); else ipCounts.delete(ip);
      if (client.joined) {
        broadcast({ type: MessageType.PeerLeft, id: client.id });
        broadcast({ type: MessageType.System, text: `${client.name} вышел` });
        schedulePresence();
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
    stats: () => ({ connections: clients.size, joined: [...clients.values()].filter((client) => client.joined).length }),
    stop: () => {
      offMembership?.();
      offDeviceRemoved?.();
      clearInterval(heartbeat);
      if (presenceTimer) clearTimeout(presenceTimer);
      for (const ws of wss.clients) ws.close(1001, 'Server restarting');
      wss.close();
    },
  };
}
