// Platform-independent Segment client core. It owns the WebSocket lifecycle,
// chat state, update stream and encrypted session setup without depending on DOM.

import { ROOMS, MessageType, PROTOCOL_VERSION, ChatType } from '@segment/protocol';
import {
  createPreKeyBundle, x3dhInitiate, x3dhRespond, SenderKey, SenderKeyView,
  randomFileKey, sealBytes, openBytes,
} from '@segment/crypto';

const COLORS = ['#7c5cff', '#00d4ff', '#ff5c8a', '#3ddc84', '#ffb347', '#ff6b6b', '#4facfe', '#a166ff'];
const RECONNECT_MS = 1500;
const TYPING_THROTTLE_MS = 1000;

const SAVED_ID = 'saved';
const SAVED_CHAT = { id: SAVED_ID, name: 'Избранное', icon: '⭐', local: true, type: ChatType.Saved, hint: 'заметки — видишь только ты' };

const attachLabel = (m) => {
  const a = m.attachments;
  if (!a?.length) return '';
  if (a.length > 1) return `🖼 ${a.length} вложений`;
  const k = a[0].kind;
  if (k === 'photo') return '📷 Фото';
  if (k === 'video') return '📹 Видео';
  if (k === 'voice') return '🎤 Голосовое';
  if (k === 'circle') return '📹 Видеосообщение';
  return `📎 ${a[0].name || 'Файл'}`;
};
const preview = (m) => {
  const body = m.poll ? `📊 ${m.poll.question}` : (m.text || attachLabel(m));
  return m.name ? `${m.name}: ${body}` : body;
};
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const mid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const parseEnvelope = (text) => {
  try {
    const data = JSON.parse(text);
    if (data?.segment === 'event') return data;
  } catch {}
  return { segment: 'event', kind: 'message', text };
};

export class SegmentClient {
  constructor({ storage } = {}) {
    this.storage = storage;
    this.version = PROTOCOL_VERSION;
    this._listeners = new Map();

    this.chats = [SAVED_CHAT, ...ROOMS];
    this.self = { name: storage.getName(), username: storage.getUsername?.() || '', avatar: storage.getAvatar?.() || '', color: storage.getColor?.() || pickColor() };
    this.currentRoom = null;
    this.messages = Object.fromEntries(this.chats.map((c) => [c.id, []]));
    this.messages[SAVED_ID] = storage.getNotes();
    this.unread = {};
    this.lastText = {};
    this.pinned = new Set(storage.getPinned ? storage.getPinned() : []);
    this.muted = new Set(storage.getMuted?.() || []);
    this.archived = new Set(storage.getArchived?.() || []);
    this.folders = storage.getFolders?.() || [];
    this.unreadDot = new Set();
    this.firstUnread = {};
    this.typing = {};
    this._typingTimers = {};
    this.online = [];

    this.ws = null;
    this._lastTyping = 0;


    this.historyKeys = new Map();   // roomId -> AES key bytes (adopt-if-absent)
    this._backfilled = new Set();   // rooms already backfilled this session
    this.kit = null;
    this.senderKey = null;
    this.myId = null;
    this.peers = new Map();    // id -> { name, color, bundle, ratchet, view, pendingCiphers }
    this._queue = Promise.resolve();
  }

  view() {
    return {
      chats: this.chats,
      messages: this.messages,
      unread: this.unread,
      lastText: this.lastText,
      pinned: this.pinned,
      muted: this.muted,
      archived: this.archived,
      folders: this.folders,
      unreadDot: this.unreadDot,
      firstUnread: this.firstUnread,
      typing: this.typing,
      currentRoom: this.currentRoom,
      self: this.self,
      online: this.online,
    };
  }

  get hasIdentity() { return !!this.self.name; }

  chatById(id) { return this.chats.find((c) => c.id === id); }



  connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    this.ws = new WebSocket(proto + location.host);

    this.ws.onopen = () => {
      this.peers.clear();
      this.myId = null;
      this._emit('connection', { connected: true });
      if (this.self.name) this._join();
    };
    this.ws.onclose = () => {
      this._emit('connection', { connected: false });
      setTimeout(() => this.connect(), RECONNECT_MS);
    };

    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this._queue = this._queue.then(() => this._onServer(msg)).catch(() => {});
    };
  }

  setIdentity(name) {
    const clean = (name || '').trim();
    if (!clean) return false;
    this.self.name = clean;
    this.storage.setName(clean);
    this._join();
    return true;
  }




  // REST helper for the rooms service. Rooms must exist server-side for the
  // membership-scoped relay to deliver their ciphertext.
  async _roomsApi(method, path, body) {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'REQUEST_FAILED'), { code: data.error });
    return data;
  }

  _slugify(name) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const padded = base.length >= 3 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    return padded.slice(0, 32).replace(/-+$/g, '') || `ch-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Merge a server room record into local chat state (idempotent by id).
  _addServerRoom(room, { open = false } = {}) {
    if (!room?.id) return null;
    const existing = this.chatById(room.id);
    if (existing) {
      existing.ownerId = room.ownerId || existing.ownerId;
      existing.historyVisibility = room.historyVisibility || existing.historyVisibility;
    } else {
      this.chats.push({
        id: room.id, name: room.title, icon: room.icon || '💬', type: room.type, slug: room.slug || '',
        ownerId: room.ownerId || '', historyVisibility: room.historyVisibility || 'joined',
      });
      this.messages[room.id] ||= [];
      this._emit('chats');
    }
    if (open) this.openRoom(room.id);
    return room.id;
  }

  // Pull the rooms this account belongs to (public + joined) after sign-in.
  async loadRooms() {
    try {
      const { rooms } = await this._roomsApi('GET', '/api/rooms/mine');
      for (const room of rooms || []) this._addServerRoom(room);
    } catch { /* offline or unauthenticated: keep local defaults */ }
  }

  async createChat({ name, icon, type } = {}) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const kind = [ChatType.DM, ChatType.Chat, ChatType.Channel].includes(type) ? type : ChatType.Chat;
    const payload = { type: kind, title: clean };
    if (kind === ChatType.Channel) payload.slug = this._slugify(clean);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { room } = await this._roomsApi('POST', '/api/rooms', payload);
        if (icon) room.icon = icon;
        this._seedHistoryKey(room.id); // creator seeds the room's history key
        return this._addServerRoom(room, { open: true });
      } catch (error) {
        if (error.code === 'SLUG_TAKEN') { payload.slug = this._slugify(clean); continue; }
        this._emit('error', { scope: 'createChat', code: error.code });
        return null;
      }
    }
    return null;
  }

  // Create a shareable invite link for a private room.
  async createInvite(roomId) {
    if (!this.chatById(roomId)) return null;
    const { token } = await this._roomsApi('POST', '/api/rooms/invite', { roomId });
    return `${location.origin}/j/${token}`;
  }

  // Redeem an invite token and open the joined room.
  async joinByToken(token) {
    const { room } = await this._roomsApi('POST', '/api/rooms/join', { token });
    return this._addServerRoom(room, { open: true });
  }

  // Owner-only, one-way: switch a room to full history for all members.
  async enableFullHistory(roomId) {
    if (!this.chatById(roomId)) return null;
    const { room } = await this._roomsApi('POST', '/api/rooms/history/visibility', { roomId });
    return room;
  }

  // Resolve a deep link (/@user, /c/slug) to its target entity.
  async resolveLink(path) {
    try { return await this._roomsApi('GET', `/api/rooms/resolve?path=${encodeURIComponent(path)}`); }
    catch { return null; }
  }


  togglePin(id) {
    if (!this.chatById(id)) return;
    if (this.pinned.has(id)) this.pinned.delete(id);
    else this.pinned.add(id);
    this.storage.setPinned?.([...this.pinned]);
    this._emit('chats');
  }

  reorderPinned(id, beforeId = null) {
    const order = [...this.pinned];
    const from = order.indexOf(id);
    if (from < 0) return;
    order.splice(from, 1);
    const to = beforeId ? order.indexOf(beforeId) : -1;
    order.splice(to < 0 ? order.length : to, 0, id);
    this.pinned = new Set(order);
    this.storage.setPinned?.(order);
    this._emit('chats');
  }

  createFolder(name, chatIds = []) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const folder = { id: `folder-${Date.now().toString(36)}`, name: clean, chats: [...new Set(chatIds)].filter((id) => this.chatById(id)) };
    this.folders.push(folder); this.storage.setFolders?.(this.folders); this._emit('chats'); return folder.id;
  }

  updateFolder(id, chatIds) {
    const folder = this.folders.find((f) => f.id === id); if (!folder) return false;
    folder.chats = [...new Set(chatIds)].filter((chatId) => this.chatById(chatId));
    this.storage.setFolders?.(this.folders); this._emit('chats'); return true;
  }

  renameFolder(id, name) { const f = this.folders.find((x) => x.id === id); const clean = (name || '').trim(); if (!f || !clean) return false; f.name = clean; this.storage.setFolders?.(this.folders); this._emit('chats'); return true; }

  removeFolder(id) { this.folders = this.folders.filter((f) => f.id !== id); this.storage.setFolders?.(this.folders); this._emit('chats'); }



  toggleMute(id) {
    if (!this.chatById(id)) return;
    if (this.muted.has(id)) this.muted.delete(id);
    else this.muted.add(id);
    this.storage.setMuted?.([...this.muted]);
    this._emit('chats');
  }

  isMuted(id) { return this.muted.has(id); }


  toggleArchive(id) {
    const chat = this.chatById(id);
    if (!chat || chat.type === 'saved') return;
    if (this.archived.has(id)) this.archived.delete(id);
    else { this.archived.add(id); this.pinned.delete(id); }
    this.storage.setArchived?.([...this.archived]);
    this.storage.setPinned?.([...this.pinned]);
    this._emit('chats');
  }

  isArchived(id) { return this.archived.has(id); }


  markRead(id) {
    if (!this.chatById(id)) return;
    this.unread[id] = 0;
    this.unreadDot.delete(id);
    delete this.firstUnread[id];
    this._emit('chats');
  }


  markUnread(id) {
    if (!this.chatById(id) || id === this.currentRoom) return;
    this.unreadDot.add(id);
    this._emit('chats');
  }


  clearHistory(id) {
    if (!this.messages[id]) return false;
    this._clearServerHistory(id); // otherwise the next backfill brings it all back
    this.messages[id] = [];
    delete this.lastText[id];
    this.unread[id] = 0;
    this.unreadDot.delete(id);
    delete this.firstUnread[id];
    if (id === SAVED_ID) this.storage.setNotes([]);
    if (id === this.currentRoom) this._emit('room', { chat: this.chatById(id), messages: this.messages[id] });
    this._emit('chats');
    return true;
  }


  canEditChat(id) {
    const chat = this.chatById(id);
    return !!chat && chat.type !== ChatType.Saved;
  }


  renameChat(id, name) {
    const chat = this.chatById(id);
    const clean = (name || '').trim();
    if (!chat || !clean || chat.type === ChatType.Saved) return false;
    chat.name = clean;
    this._emit('chats');
    if (this.currentRoom === id) this._emit('room', { chat, messages: this.messages[id] });
    return true;
  }


  removeChat(id) {
    const chat = this.chatById(id);
    if (!chat || chat.type === ChatType.Saved) return false;
    this.chats = this.chats.filter((c) => c.id !== id);
    delete this.messages[id];
    delete this.unread[id];
    delete this.lastText[id];
    if (this.pinned.delete(id)) this.storage.setPinned?.([...this.pinned]);
    if (this.muted.delete(id)) this.storage.setMuted?.([...this.muted]);
    if (this.archived.delete(id)) this.storage.setArchived?.([...this.archived]);
    this.unreadDot.delete(id);
    delete this.firstUnread[id];
    if (this.currentRoom === id) {
      this.openRoom(this.chats[0]?.id ?? SAVED_ID);
    } else {
      this._emit('chats');
    }
    return true;
  }

  openRoom(id) {
    if (!this.chatById(id)) return;
    this.currentRoom = id;
    this.unread[id] = 0;
    this.unreadDot.delete(id);
    this._backfillRoom(id); // fetch + decrypt any stored history we are missing
    this._emit('room', { chat: this.chatById(id), messages: this.messages[id] });
    this._emit('chats');
    this._emit('status', this._statusText());
    const readIds = this.messages[id]?.filter((m) => !m.system && !m.deleted && m.name !== this.self.name).map((m) => m.id) || [];
    if (readIds.length && id !== SAVED_ID) this.sendEvent(id, { kind: 'receipt', ids: readIds, state: 'read' }, false);
  }


  closeRoom() {
    if (!this.currentRoom) return;
    this.currentRoom = null;
    this._emit('room', { chat: null, messages: [] });
    this._emit('chats');
  }


  send(text) { return this.sendTo(this.currentRoom, text); }


  async sendTo(roomId, text) {
    const clean = (text || '').trim();
    if (!clean || !roomId || !this.chatById(roomId)) return;

    const message = this._makeMessage(clean);
    this._addMessage(roomId, message);
    if (roomId === SAVED_ID) {
      message.status = 'sent';
      this.storage.setNotes(this.messages[SAVED_ID]);
      return;
    }

    await this._ensureCrypto();
    const box = await this.senderKey.encrypt(JSON.stringify({ segment: 'event', kind: 'message', message })); // { n, iv, ct }
    this._send({ type: MessageType.Cipher, room: roomId, n: box.n, iv: box.iv, ct: box.ct });
    this._storeToHistory(roomId, { kind: 'message', message });
    this._markSent(roomId, message);
  }




  async sendAttachments(roomId, attachments, caption = '', replyRef = null) {
    roomId = roomId || this.currentRoom;
    const files = (attachments || []).filter(Boolean);
    if (!files.length || !roomId || !this.chatById(roomId)) return;
    const replyTo = this._replySnapshot(roomId, replyRef);
    const message = this._makeMessage((caption || '').trim(), replyTo, { attachments: files });
    return this.sendEvent(roomId, { kind: 'message', message });
  }


  setColor(color) {
    if (!color || color === this.self.color) return;
    this.self.color = color;
    this.storage.setColor?.(color);
    this._emit('identity', { name: this.self.name });
  }


  logout() {
    this.storage.clear?.();
    this.self.name = '';
    try { this.ws?.close(); } catch {}
  }

  sendReply(roomId, text, replyRef, quote = '') {
    const ref = typeof replyRef === 'object' ? replyRef : { id: replyRef, text: quote, quote: Boolean(quote) };
    return this.sendEvent(roomId, { kind: 'message', message: this._makeMessage(text, this._replySnapshot(roomId, ref)) });
  }

  forwardMessage(roomId, source = {}) {
    const clean = (source.text || '').trim();
    if (!clean) return false;
    return this.sendEvent(roomId, {
      kind: 'message',
      message: this._makeMessage(clean, null, {
        forwardFrom: {
          name: source.name || source.fromName || '',
          chatName: source.chatName || source.fromChat || '',
        },
      }),
    });
  }

  async sendEvent(roomId, event, local = true) {
    if (!roomId || !this.chatById(roomId) || !event) return;

    if (local) this._applyEvent(roomId, event, this.self);
    if (roomId !== SAVED_ID) {
      const wire = await this._toWire(event);
      await this._ensureCrypto();
      const box = await this.senderKey.encrypt(JSON.stringify({ segment: 'event', ...wire }));
      this._send({ type: MessageType.Cipher, room: roomId, n: box.n, iv: box.iv, ct: box.ct });
      if (event.kind === 'message') this._storeToHistory(roomId, wire);
    }
    if (event.kind === 'message' && event.message) this._markSent(roomId, event.message);
  }


  sendPoll(roomId, question, options) {
    roomId = roomId || this.currentRoom;
    const q = (question || '').trim();
    const opts = (options || []).map((o) => (o || '').trim()).filter(Boolean);
    if (!q || opts.length < 2 || !this.chatById(roomId)) return false;
    const message = this._makeMessage('', null, { poll: { question: q, options: opts, votes: {} } });
    return this.sendEvent(roomId, { kind: 'message', message });
  }


  votePoll(roomId, messageId, option) {
    const message = this._messageById(roomId, messageId);
    if (!message?.poll) return;
    return this.sendEvent(roomId, { kind: 'poll-vote', id: messageId, option, by: this.self.name });
  }

  toggleReaction(roomId, messageId, emoji) {
    const message = this._messageById(roomId, messageId);
    if (!message || message.system || message.deleted) return;
    return this.sendEvent(roomId, { kind: 'reaction', id: messageId, emoji, by: this.self.name });
  }

  editMessage(roomId, messageId, text) {
    const clean = (text || '').trim();
    const message = this._messageById(roomId, messageId);
    if (!clean || !message || message.name !== this.self.name || message.deleted) return false;
    this.sendEvent(roomId, { kind: 'edit', id: messageId, text: clean });
    return true;
  }

  deleteMessage(roomId, messageId) {
    const message = this._messageById(roomId, messageId);
    if (!message || message.deleted || (message.name && message.name !== this.self.name)) return false;
    this.sendEvent(roomId, { kind: 'delete', id: messageId });
    this._eraseFromHistory(roomId, message); // otherwise a backfill resurrects it
    return true;
  }

  toggleMessagePin(roomId, messageId) {
    const message = this._messageById(roomId, messageId);
    if (!message || message.deleted) return false;
    const list = this.messages[roomId];
    const current = Array.isArray(list.pinnedIds)
      ? [...list.pinnedIds]
      : (list.pinnedId ? [list.pinnedId] : []);
    const index = current.indexOf(messageId);
    if (index === -1) current.push(messageId);
    else current.splice(index, 1);
    this.sendEvent(roomId, { kind: 'pin-message', ids: current });
    return true;
  }

  reorderMessagePin(roomId, messageId, targetId) {
    const list = this.messages[roomId];
    if (!list) return false;
    const ids = [...(list.pinnedIds || (list.pinnedId ? [list.pinnedId] : []))];
    const from = ids.indexOf(messageId), to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return false;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    this.sendEvent(roomId, { kind: 'pin-message', ids });
    return true;
  }

  notifyTyping() {
    if (!this.currentRoom || this.currentRoom === SAVED_ID) return;
    const now = Date.now();
    if (now - this._lastTyping < TYPING_THROTTLE_MS) return;
    this._lastTyping = now;
    this._send({ type: MessageType.Typing, room: this.currentRoom });
  }



  // ---- File attachments ----
  // Encrypt each attachment client-side, upload the opaque ciphertext to the
  // blob store over HTTP, and carry only a small { fileId, key, iv } reference
  // through the E2EE message. Large files therefore never traverse the
  // WebSocket relay and are not capped by its payload limit.

  _dataUrlToBytes(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(5, comma); // strip leading "data:"
    const mime = meta.split(';')[0] || 'application/octet-stream';
    const body = dataUrl.slice(comma + 1);
    if (meta.includes('base64')) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(body)) };
  }

  _bytesToUrl(bytes, mime) {
    const type = mime || 'application/octet-stream';
    if (typeof URL !== 'undefined' && URL.createObjectURL) {
      return URL.createObjectURL(new Blob([bytes], { type }));
    }
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return `data:${type};base64,${btoa(bin)}`;
  }

  async _uploadBlob(bytes) {
    const response = await fetch('/api/files', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) throw new Error(data.error || 'UPLOAD_FAILED');
    return data.id;
  }

  async _downloadBlob(fileId) {
    const response = await fetch(`/api/files/${fileId}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('DOWNLOAD_FAILED');
    return new Uint8Array(await response.arrayBuffer());
  }

  // Encrypt + upload one data URL. Returns the reference to put on the wire and a
  // playable url for local display: media plays far more reliably (and cheaply)
  // from a blob: url than from a multi-megabyte data: url.
  async _sealDataUrl(dataUrl) {
    const { mime, bytes } = this._dataUrlToBytes(dataUrl);
    const key = randomFileKey();
    const { iv, ct } = await sealBytes(key, bytes);
    const fileId = await this._uploadBlob(ct);
    return { ref: { fileId, key, iv, mime, size: bytes.length }, url: this._bytesToUrl(bytes, mime) };
  }

  async _fetchToUrl(ref) {
    const ct = await this._downloadBlob(ref.fileId);
    const bytes = await openBytes(ref.key, ref.iv, ct);
    return this._bytesToUrl(bytes, ref.mime);
  }

  // Build the wire form (reference only) and, on the way, swap the sender's own
  // inline data url for the same blob: url the receiver will use.
  async _attachmentToWire(att) {
    const wire = { ...att };
    if (att.data) {
      const { ref, url } = await this._sealDataUrl(att.data);
      wire.blob = ref; delete wire.data;
      att.blob = ref; att.data = url;
    }
    if (att.poster) {
      const { ref, url } = await this._sealDataUrl(att.poster);
      wire.posterBlob = ref; delete wire.poster;
      att.posterBlob = ref; att.poster = url;
    }
    return wire;
  }

  async _hydrateAttachment(att) {
    if (att.blob && !att.data) att.data = await this._fetchToUrl(att.blob);
    if (att.posterBlob && !att.poster) att.poster = await this._fetchToUrl(att.posterBlob);
  }

  async _hydrateMessage(roomId, message) {
    const atts = message?.attachments;
    if (!Array.isArray(atts) || !atts.some((a) => a.blob || a.posterBlob)) return;
    try {
      await Promise.all(atts.map((a) => this._hydrateAttachment(a)));
      this._refreshRoom(roomId);
    } catch { /* leave placeholder; opening the media can retry */ }
  }

  // Wire clone of an outgoing event: attachments uploaded, inline data stripped.
  async _toWire(event) {
    if (event.kind !== 'message' || !event.message?.attachments?.length) return event;
    try {
      const attachments = await Promise.all(event.message.attachments.map((a) => this._attachmentToWire(a)));
      return { ...event, message: { ...event.message, attachments } };
    } catch {
      return event; // blob store unavailable: fall back to inline data
    }
  }

  // ---- Encrypted server-side history ----
  // Each room has a symmetric history key held only by members. Events are
  // additionally encrypted to it and stored server-side as opaque envelopes, so
  // a returning device (or the backfill on open) can reconstruct the log. The
  // server never sees the key. Distribution is adopt-if-absent: the room creator
  // seeds the key and it propagates to members over the pairwise key channel;
  // nobody overwrites a key they already hold, so all members converge on one.

  // History envelopes travel as JSON over REST, so bytes are base64 there. (The
  // WebSocket relay instead carries the raw byte arrays the crypto layer emits.)
  _b64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  _unb64(text) {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  _historyKey(roomId) { return this.historyKeys.get(roomId) || null; }

  _seedHistoryKey(roomId) {
    if (!this.historyKeys.has(roomId)) this.historyKeys.set(roomId, randomFileKey());
    return this.historyKeys.get(roomId);
  }

  _adoptHistoryKeys(map) {
    if (!map || typeof map !== 'object') return;
    for (const [roomId, key] of Object.entries(map)) {
      if (!this.historyKeys.has(roomId) && Array.isArray(key) && key.length === 32) this.historyKeys.set(roomId, key);
    }
  }

  historyKeysExport() {
    return Object.fromEntries(this.historyKeys);
  }

  // Persist one event to server history, encrypted to the room's history key.
  async _storeToHistory(roomId, event) {
    if (roomId === SAVED_ID) return;
    const key = this._historyKey(roomId);
    if (!key || !event) return;
    const clean = event.message ? { ...event, message: { ...event.message } } : event;
    if (clean.message) delete clean.message.status;
    try {
      const { iv, ct } = await sealBytes(key, new TextEncoder().encode(JSON.stringify(clean)));
      const { seq } = await this._roomsApi('POST', '/api/rooms/history', { roomId, iv: this._b64(iv), ct: this._b64(ct) });
      // Remember where this message lives so deleting it can erase it for good.
      const local = event.message?.id ? this._messageById(roomId, event.message.id) : null;
      if (local && seq) local.seq = seq;
    } catch { /* offline or no access: live relay still delivered the message */ }
  }

  // Erase a stored envelope so a deleted message cannot return on a backfill.
  async _eraseFromHistory(roomId, message) {
    if (!message?.seq || roomId === SAVED_ID) return;
    try { await this._roomsApi('DELETE', '/api/rooms/history', { roomId, seq: message.seq }); }
    catch { /* not ours to erase, or already gone */ }
  }

  // Clear stored history for this account only; other members keep their copies.
  async _clearServerHistory(roomId) {
    if (roomId === SAVED_ID) return;
    try { await this._roomsApi('POST', '/api/rooms/history/clear', { roomId }); }
    catch { /* offline: local history is cleared regardless */ }
  }

  // Fetch and decrypt stored history for a room, applying events we don't have.
  async _backfillRoom(roomId) {
    if (roomId === SAVED_ID || this._backfilled.has(roomId)) return;
    const key = this._historyKey(roomId);
    if (!key) return;
    this._backfilled.add(roomId);
    try {
      const { envelopes } = await this._roomsApi('GET', `/api/rooms/history?roomId=${encodeURIComponent(roomId)}`);
      for (const env of envelopes || []) {
        let event;
        try {
          const plain = await openBytes(key, this._unb64(env.iv), this._unb64(env.ct));
          event = JSON.parse(new TextDecoder().decode(plain));
        } catch { continue; }
        const id = event?.message?.id;
        if (event?.kind === 'message' && id && !this._messageById(roomId, id)) {
          event.message.seq = env.seq; // so it can be erased for good later
          this._applyEvent(roomId, event, {});
        }
      }
    } catch { this._backfilled.delete(roomId); }
  }

  async _ensureCrypto() {
    if (this.kit) return;
    this.kit = await createPreKeyBundle();
    this.senderKey = SenderKey.create();
  }

  async _join() {
    if (!this.self.name) return;
    await this._ensureCrypto();
    this._send({ type: MessageType.Join, name: this.self.name, color: this.self.color, bundle: this.kit.bundle });
    this._emit('identity', { name: this.self.name });
  }

  _addPeer(m) {
    if (this.peers.has(m.id)) return;
    this.peers.set(m.id, { name: m.name, username: m.username, avatar: m.avatar, color: m.color, bundle: m.bundle, pendingCiphers: [] });
  }


  _maybeInitiate(id) {
    if (this.myId != null && this.myId < id) this._send({ type: MessageType.PreKeyRequest, to: id });
  }


  async _onPreKey(from, opk) {
    const p = this.peers.get(from);
    if (!p || p.ratchet || !p.bundle) return;
    const bundle = { ...p.bundle, opks: opk ? [opk] : [] };
    const { ratchet, x3dh } = await x3dhInitiate(this.kit.secret, bundle);
    p.ratchet = ratchet;
    const box = await ratchet.encrypt(JSON.stringify(this.senderKey.export()));
    this._send({ type: MessageType.KeyShare, to: from, x3dh, box, hist: this.historyKeysExport() });
  }

  async _onKeyShare(from, x3dh, box) {
    const p = this.peers.get(from);
    if (!p) return;
    if (x3dh && !p.ratchet) {


      p.ratchet = await x3dhRespond(this.kit.secret, x3dh);
      p.view = SenderKeyView.from(JSON.parse(await p.ratchet.decrypt(box)));
      await this._drain(p);
      const reply = await p.ratchet.encrypt(JSON.stringify(this.senderKey.export()));
      this._send({ type: MessageType.KeyShare, to: from, box: reply, hist: this.historyKeysExport() });
    } else if (p.ratchet) {

      p.view = SenderKeyView.from(JSON.parse(await p.ratchet.decrypt(box)));
      await this._drain(p);
    }
  }

  async _drain(p) {
    const pend = p.pendingCiphers;
    p.pendingCiphers = [];
    for (const c of pend) await this._decryptCipher(p, c);
  }



  async _onPeerLeft(id) {
    const had = this.peers.delete(id);
    if (!had || !this.senderKey) return;
    this.senderKey = SenderKey.create();
    const state = JSON.stringify(this.senderKey.export());
    for (const [pid, p] of this.peers) {
      if (p.ratchet) this._send({ type: MessageType.KeyShare, to: pid, box: await p.ratchet.encrypt(state), hist: this.historyKeysExport() });
    }
  }

  async _onCipher(msg) {
    const p = this.peers.get(msg.from);
    if (!p) return;
    if (!p.view) { p.pendingCiphers.push(msg); return; }
    await this._decryptCipher(p, msg);
  }

  async _decryptCipher(p, msg) {
    let text;
    try { text = await p.view.decrypt({ n: msg.n, iv: msg.iv, ct: msg.ct }); } catch { return; }
    const event = parseEnvelope(text);
    this._applyEvent(msg.room, event, { name: p.name, username: p.username, avatar: p.avatar, color: p.color });
    if (event.kind === 'message' && event.message?.id) {
      this.sendEvent(msg.room, { kind: 'receipt', ids: [event.message.id], state: msg.room === this.currentRoom ? 'read' : 'delivered' }, false);
    }
  }



  async _onServer(msg) {
    switch (msg.type) {
      case MessageType.Roster:
        this.myId = msg.self.id;
        this.online = msg.online;
        for (const m of msg.members) this._addPeer(m);
        for (const m of msg.members) this._maybeInitiate(m.id);
        this._emit('chats');
        if (this.currentRoom) {
          this._emit('room', { chat: this.chatById(this.currentRoom), messages: this.messages[this.currentRoom] });
        }
        this._emit('status', this._statusText());
        break;

      case MessageType.Peer:
        this.online = msg.online;
        this._addPeer(msg);
        this._maybeInitiate(msg.id);
        this._emit('status', this._statusText());
        break;

      case MessageType.PeerLeft:
        await this._onPeerLeft(msg.id);
        this.online = msg.online;
        this._emit('status', this._statusText());
        break;

      case MessageType.PreKey:
        await this._onPreKey(msg.from, msg.opk);
        break;

      case MessageType.KeyShare:
        this._adoptHistoryKeys(msg.hist);
        await this._onKeyShare(msg.from, msg.x3dh, msg.box);
        break;

      case MessageType.Cipher:
        await this._onCipher(msg);
        break;

      case MessageType.System:
        this.online = msg.online;
        if (this.currentRoom && this.currentRoom !== SAVED_ID) this._addMessage(this.currentRoom, { system: true, text: msg.text });
        this._emit('status', this._statusText());
        break;

      case MessageType.Typing:
        this._setTyping(msg.room, msg.name);
        if (msg.room === this.currentRoom) this._emit('typing', { name: msg.name });
        break;
    }
  }

  _addMessage(roomId, m) {
    const list = this.messages[roomId];
    if (!list || !m) return;
    const wasEmpty = !list.length;
    if (!m.id && !m.system) m.id = mid();
    if (!m.ts) m.ts = Date.now();
    if (!m.system) m.reactions ||= {};
    list.push(m);
    this.lastText[roomId] = m.system ? m.text : preview(m);
    if (!m.system) { delete this.typing[roomId]; clearTimeout(this._typingTimers[roomId]); }
    const current = roomId === this.currentRoom;
    if (!current && !m.system) {
      if (!this.unread[roomId]) this.firstUnread[roomId] = m.id;
      this.unread[roomId] = (this.unread[roomId] || 0) + 1;
    }
    this._emit('append', { roomId, message: m, current, wasEmpty });
    this._emit('chats');
  }

  _makeMessage(text, replyTo = null, extra = {}) {
    return {
      id: mid(),
      name: this.self.name,
      username: this.self.username,
      avatar: this.self.avatar,
      color: this.self.color,
      text: (text || '').trim(),
      ts: Date.now(),
      reactions: {},
      replyTo,
      status: 'sending',
      ...extra,
    };
  }


  _setTyping(roomId, name) {
    if (!roomId || !this.chatById(roomId)) return;
    this.typing[roomId] = name;
    clearTimeout(this._typingTimers[roomId]);
    this._typingTimers[roomId] = setTimeout(() => {
      delete this.typing[roomId];
      this._emit('chats');
    }, 3000);
    this._emit('chats');
  }


  _markSent(roomId, message) {
    if (!message) return;
    message.status = 'sent';
    this._refreshRoom(roomId);
  }

  _messageById(roomId, id) {
    return this.messages[roomId]?.find((m) => m.id === id);
  }

  _replySnapshot(roomId, ref) {
    if (!ref) return null;
    const requested = Array.isArray(ref.quotes) && ref.quotes.length ? ref.quotes : [ref];
    const quotes = requested.slice(0, 8).map((q) => {
      const source = this._messageById(roomId, q.id);
      if (!source || source.deleted) return null;
      const fragment = (q.text || '').trim();
      return { id: source.id, name: source.name, text: q.quote && fragment ? fragment : (source.text || ''), quote: Boolean(q.quote) };
    }).filter(Boolean);
    if (!quotes.length) return null;
    if (quotes.length === 1) return quotes[0];
    return { ...quotes[0], quote: true, quotes };
  }

  _refreshRoom(roomId) {
    if (roomId === SAVED_ID) this.storage.setNotes(this.messages[SAVED_ID]);
    if (roomId === this.currentRoom) this._emit('room', { chat: this.chatById(roomId), messages: this.messages[roomId] });
    this._emit('chats');
  }

  _applyEvent(roomId, event, author = {}) {
    if (!event || !this.messages[roomId]) return;
    if (event.kind === 'message') {
      const message = event.message || this._makeMessage(event.text || '');
      if (author.name) {
        message.name = author.name;
        message.username = author.username || '';
        message.avatar = author.avatar || '';
        message.color = author.color;
      }
      this._addMessage(roomId, message);
      this._hydrateMessage(roomId, message);
      return;
    }

    if (event.kind === 'receipt') {
      const rank = { sending: 0, sent: 1, delivered: 2, read: 3 };
      let changed = false;
      for (const id of event.ids || []) {
        const receiptMessage = this._messageById(roomId, id);
        if (!receiptMessage || receiptMessage.name !== this.self.name) continue;
        if ((rank[event.state] || 0) > (rank[receiptMessage.status] || 0)) { receiptMessage.status = event.state; changed = true; }
      }
      if (changed) this._refreshRoom(roomId);
      return;
    }

    const message = this._messageById(roomId, event.id);
    if (event.kind === 'reaction' && message) {
      message.reactions ||= {};
      message.reactions[event.emoji] ||= [];
      const by = event.by || author.name || 'user';
      const list = message.reactions[event.emoji];
      const i = list.indexOf(by);
      if (i === -1) list.push(by);
      else list.splice(i, 1);
      if (!list.length) delete message.reactions[event.emoji];
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'edit' && message) {
      message.text = event.text;
      message.edited = Date.now();
      this.lastText[roomId] = preview(message);
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'delete' && message) {
      // Traceless: the message is removed outright, not tombstoned. The stored
      // envelope is erased separately (see _eraseFromHistory), so a backfill
      // cannot bring it back either.
      const list = this.messages[roomId];
      const at = list.indexOf(message);
      if (at >= 0) list.splice(at, 1);
      if (Array.isArray(list.pinnedIds)) {
        list.pinnedIds = list.pinnedIds.filter((id) => id !== message.id);
        list.pinnedId = list.pinnedIds.at(-1) || null;
      }
      const last = list[list.length - 1];
      if (last) this.lastText[roomId] = last.system ? last.text : preview(last);
      else delete this.lastText[roomId];
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'poll-vote' && message?.poll) {
      const by = event.by || author.name || 'user';
      if (message.poll.votes[by] === event.option) delete message.poll.votes[by];
      else message.poll.votes[by] = event.option;
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'pin-message') {
      const ids = Array.isArray(event.ids) ? event.ids : (event.id ? [event.id] : []);
      this.messages[roomId].pinnedIds = [...new Set(ids)].filter((id) => {
        const pinned = this._messageById(roomId, id);
        return pinned && !pinned.deleted;
      });
      // pinnedId remains as a compatibility alias for older UI/mods.
      this.messages[roomId].pinnedId = this.messages[roomId].pinnedIds.at(-1) || null;
      this._refreshRoom(roomId);
    }
  }



  _send(payload) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
  }

  _statusText() {
    const c = this.chatById(this.currentRoom);
    if (!c) return '';
    if (c.local) return 'локально — видишь только ты';
    return this.online.length
      ? `онлайн: ${this.online.length} — ${this.online.map((u) => u.name).join(', ')}`
      : 'никого нет :(';
  }

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) for (const cb of set) cb(payload);
  }
}
