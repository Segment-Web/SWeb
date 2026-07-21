// Platform-independent Segment client core. It owns the WebSocket lifecycle,
// chat state, update stream and encrypted session setup without depending on DOM.

import { ROOMS, MessageType, PROTOCOL_VERSION, ChatType, attachmentsWithinLimits } from '@segment/protocol';
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
  const author = m.channelName || m.name;
  return author ? `${author}: ${body}` : body;
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


    this.historyKeys = new Map(Object.entries(storage.getHistoryKeys?.() || {}));
    this.historyKeyArchive = new Map(Object.entries(storage.getHistoryKeyArchive?.() || {}));
    this.historyKeyEpochs = new Map(Object.entries(storage.getHistoryKeyEpochs?.() || {}).map(([roomId, epoch]) => [roomId, Number(epoch) || 0]));
    this._backfilled = new Set();   // rooms already backfilled this session
    this._appliedEvents = new Set();
    this.outbox = Array.isArray(storage.getOutbox?.()) ? storage.getOutbox() : [];
    this.scheduled = Array.isArray(storage.getScheduled?.()) ? storage.getScheduled() : [];
    this._scheduledTimer = setInterval(() => this._flushScheduled(), 10000);
    this._scheduledTimer.unref?.();
    this._flushingOutbox = false;
    this._relayAcks = new Map();
    this._activeUploads = new Map();
    this.kit = null;
    this.senderKeys = new Map(); // roomId -> { epoch, key }
    this._serverRoomEpochs = new Map();
    this._historyRecoveryRooms = new Set();
    this.myId = null;
    this.peers = new Map();    // id -> { identity, ratchet, room views and room queues }
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

    this.ws.onopen = async () => {
      this.peers.clear();
      this.myId = null;
      this._backfilled.clear();
      this._emit('connection', { connected: true });
      if (this.self.name) {
        await this._join();
        this._flushOutbox();
        this._requestMissingHistoryKeys();
        this.preloadRoomHistories();
      }
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
    const padded = base.length >= 3 ? base : `${base ? `${base}-` : 'ch-'}${Math.random().toString(36).slice(2, 8)}`;
    return padded.slice(0, 32).replace(/-+$/g, '') || `ch-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Merge a server room record into local chat state (idempotent by id).
  _addServerRoom(room, { open = false } = {}) {
    if (!room?.id) return null;
    const existing = this.chatById(room.id);
    if (existing) {
      existing.name = room.title || existing.name;
      existing.icon = room.icon || existing.icon;
      existing.type = room.type || existing.type;
      existing.slug = room.slug || existing.slug || '';
      existing.isPublic = Boolean(room.isPublic);
      existing.ownerId = room.ownerId || existing.ownerId;
      existing.historyKey = room.historyKey || existing.historyKey || '';
      existing.historyVisibility = room.historyVisibility || existing.historyVisibility;
      existing.membershipEpoch = Number(this._serverRoomEpochs.get(room.id) || room.membershipEpoch || existing.membershipEpoch || 1);
    } else {
      this.chats.push({
        id: room.id, name: room.title, icon: room.icon || '💬', type: room.type, slug: room.slug || '',
        ownerId: room.ownerId || '', isPublic: Boolean(room.isPublic), historyKey: room.historyKey || '', historyVisibility: room.historyVisibility || 'joined', membershipEpoch: Number(this._serverRoomEpochs.get(room.id) || room.membershipEpoch || 1),
      });
      this.messages[room.id] ||= [];
      this._emit('chats');
    }
    if (room.historyKey) {
      try {
        const key = Array.from(this._unb64(room.historyKey));
        if (key.length === 32) {
          this.historyKeys.set(room.id, key);
          this.historyKeyEpochs.set(room.id, Number(room.membershipEpoch || 1));
          this._persistHistoryKeys();
          this.storage.setHistoryKeyEpochs?.(Object.fromEntries(this.historyKeyEpochs));
        }
      } catch {}
    }
    if (open) this.openRoom(room.id);
    return room.id;
  }

  // Pull the rooms this account belongs to (public + joined) after sign-in.
  async loadRooms() {
    try {
      const { rooms } = await this._roomsApi('GET', '/api/rooms/mine');
      for (const room of rooms || []) {
        this._addServerRoom(room);
        await this._ensureOwnedRoomHistoryKey(room);
        const epoch = Number(this._serverRoomEpochs.get(room.id) || room.membershipEpoch || 1);
        const recoverHistory = this._historyRecoveryRooms.has(room.id)
          && room.ownerId === this.self.id
          && Number(this.historyKeyEpochs.get(room.id) || 0) < epoch;
        await this._advanceRoomEpoch(room.id, epoch, recoverHistory);
      }
      await this.preloadRoomHistories();
    } catch { /* offline or unauthenticated: keep local defaults */ }
  }

  async preloadRoomHistories(concurrency = 3) {
    const roomIds = this.chats
      .filter((chat) => !chat.local && this._historyKey(chat.id) && !this._backfilled.has(chat.id))
      .map((chat) => chat.id);
    let cursor = 0;
    const worker = async () => {
      while (cursor < roomIds.length) {
        const roomId = roomIds[cursor++];
        await this._backfillRoom(roomId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), roomIds.length) }, worker));
  }

  async _ensureOwnedRoomHistoryKey(room) {
    if (!room?.id || room.ownerId !== this.self.id) return;
    const key = this._historyKey(room.id) || this._seedHistoryKey(room.id);
    if (!room.isPublic || room.historyKey) return;
    try {
      const encoded = this._b64(new Uint8Array(key));
      const { room: updated } = await this._roomsApi('POST', '/api/rooms/history/public-key', { roomId: room.id, key: encoded });
      this._addServerRoom(updated);
    } catch {}
  }

  async createChat({ name, icon, type } = {}) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const kind = [ChatType.DM, ChatType.Chat, ChatType.Channel].includes(type) ? type : ChatType.Chat;
    const payload = { type: kind, title: clean, icon: String(icon || '').trim().slice(0, 16) };
    if (kind === ChatType.Channel) payload.slug = this._slugify(clean);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { room } = await this._roomsApi('POST', '/api/rooms', payload);
        this._seedHistoryKey(room.id); // creator seeds the room's history key
        await this._ensureOwnedRoomHistoryKey(room);
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
  async joinByToken(token, encodedKey = '') {
    const { room } = await this._roomsApi('POST', '/api/rooms/join', { token });
    this._serverRoomEpochs.set(room.id, Number(room.membershipEpoch || 1));
    if (encodedKey) {
      try {
        const padded = encodedKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encodedKey.length / 4) * 4, '=');
        const key = Array.from(this._unb64(padded));
        if (key.length === 32) this._adoptHistoryKeys({ [room.id]: key }, { [room.id]: Math.max(1, Number(room.membershipEpoch || 1) - (room.joined ? 1 : 0)) });
      } catch {}
    }
    const roomId = this._addServerRoom(room, { open: true });
    await this._advanceRoomEpoch(room.id, Number(room.membershipEpoch || 1), false);
    return roomId;
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
    return !!chat && chat.type !== ChatType.Saved && (chat.local || chat.ownerId === this.self.id);
  }


  renameChat(id, name) {
    const chat = this.chatById(id);
    const clean = (name || '').trim();
    if (!chat || !clean || !this.canEditChat(id)) return false;
    chat.name = clean;
    if (!chat.local) this._updateServerRoom(id, { title: clean }).catch(() => this._emit('error', { scope: 'updateChat', code: 'UPDATE_FAILED' }));
    this._emit('chats');
    if (this.currentRoom === id) this._emit('room', { chat, messages: this.messages[id] });
    return true;
  }

  async _updateServerRoom(roomId, patch) {
    const { room } = await this._roomsApi('PATCH', '/api/rooms', { roomId, ...patch });
    return this._addServerRoom(room);
  }

  updateChat(id, { name, icon } = {}) {
    const chat = this.chatById(id);
    if (!chat || !this.canEditChat(id)) return false;
    const cleanName = String(name ?? chat.name).trim();
    const cleanIcon = String(icon ?? chat.icon).trim().slice(0, 16) || chat.icon;
    if (!cleanName) return false;
    chat.name = cleanName;
    chat.icon = cleanIcon;
    if (!chat.local) this._updateServerRoom(id, { title: cleanName, icon: cleanIcon }).catch(() => this._emit('error', { scope: 'updateChat', code: 'UPDATE_FAILED' }));
    this._emit('chats');
    if (this.currentRoom === id) this._emit('room', { chat, messages: this.messages[id] });
    return true;
  }


  removeChat(id) {
    const chat = this.chatById(id);
    if (!chat || chat.type === ChatType.Saved) return false;
    // Tell the server too, otherwise the room and its history come straight back
    // on the next sign-in: the owner's delete erases it for everyone, anyone
    // else's just drops their own membership.
    this._removeServerRoom(id);
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
    if (!this._historyKey(id) && id !== SAVED_ID) this._requestHistoryKey(id);
    this._emit('room', { chat: this.chatById(id), messages: this.messages[id] });
    this._emit('chats');
    this._emit('status', this._statusText());
    const readIds = this.messages[id]?.filter((m) => !m.system && !m.deleted && !this._sameAuthor(m, this.self)).map((m) => m.id) || [];
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
    return this.sendEvent(roomId, { kind: 'message', message });
  }

  sendSilent(roomId, text) {
    const clean = (text || '').trim();
    if (!clean || !roomId || !this.chatById(roomId)) return false;
    return this.sendEvent(roomId, { kind: 'message', message: this._makeMessage(clean, null, { silent: true }) });
  }

  scheduleMessage(roomId, text, sendAt, options = {}) {
    const clean = (text || '').trim();
    const when = Number(new Date(sendAt));
    if (!clean || !roomId || !this.chatById(roomId) || !Number.isFinite(when) || when <= Date.now()) return false;
    this.scheduled.push({ id: mid(), roomId, text: clean, sendAt: when, silent: Boolean(options.silent) });
    this.scheduled.sort((a, b) => a.sendAt - b.sendAt);
    this.storage.setScheduled?.(this.scheduled);
    this._emit('scheduled', { roomId, count: this.scheduled.filter((item) => item.roomId === roomId).length });
    return true;
  }

  async _flushScheduled() {
    const due = this.scheduled.filter((item) => item.sendAt <= Date.now());
    if (!due.length) return;
    this.scheduled = this.scheduled.filter((item) => item.sendAt > Date.now());
    this.storage.setScheduled?.(this.scheduled);
    for (const item of due) {
      if (!this.chatById(item.roomId)) continue;
      await this.sendEvent(item.roomId, { kind: 'message', message: this._makeMessage(item.text, null, { silent: item.silent, scheduled: true }) });
    }
  }




  async sendAttachments(roomId, attachments, caption = '', replyRef = null) {
    roomId = roomId || this.currentRoom;
    const files = (attachments || []).filter(Boolean);
    if (!files.length || !attachmentsWithinLimits(files) || !roomId || !this.chatById(roomId)) return false;
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

  forwardMessage(roomId, source = {}, options = {}) {
    const sources = Array.isArray(source.messages) ? source.messages : [source];
    const valid = sources.filter((item) => item && ((item.text || '').trim() || item.attachments?.length || item.poll));
    if (!valid.length) return false;
    return Promise.all(valid.map((item) => {
      const extra = {};
      if (item.attachments?.length) extra.attachments = item.attachments.map((file) => ({ ...file }));
      if (item.poll) extra.poll = structuredClone(item.poll);
      if (options.attribution !== false) extra.forwardFrom = {
        name: item.name || item.fromName || source.fromName || '',
        chatName: item.chatName || item.fromChat || source.fromChat || '',
      };
      return this.sendEvent(roomId, { kind: 'message', message: this._makeMessage((item.text || '').trim(), null, extra) });
    }));
  }

  async sendEvent(roomId, event, local = true) {
    if (!roomId || !this.chatById(roomId) || !event) return;
    const chat = this.chatById(roomId);
    if (event.kind === 'message' && chat.type === ChatType.Channel && chat.ownerId && chat.ownerId !== this.self.id) return false;
    if (event.kind === 'message' && event.message && chat.type === ChatType.Channel) {
      event.message.channelName = chat.name;
      event.message.channelIcon = chat.icon || '';
    }
    event.eventId ||= event.message?.id || mid();
    if (local) this._applyEvent(roomId, event, this.self);
    if (roomId === SAVED_ID) {
      if (event.kind === 'message' && event.message) this._markSent(roomId, event.message);
      this.storage.setNotes(this.messages[SAVED_ID]);
      return true;
    }
    let wire;
    try { wire = await this._toWire(event); }
    catch {
      if (event.kind === 'message' && event.message) {
        event.message.status = 'failed';
        this._refreshRoom(roomId);
      }
      this._emit('error', { scope: 'attachmentUpload', code: 'UPLOAD_FAILED' });
      return false;
    }
    this._queueOutgoing(roomId, wire);
    return this._flushOutbox();
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
    if (!clean || !message || !this._sameAuthor(message, this.self) || message.deleted) return false;
    this.sendEvent(roomId, { kind: 'edit', id: messageId, text: clean });
    return true;
  }

  deleteMessage(roomId, messageId) {
    const message = this._messageById(roomId, messageId);
    const chat = this.chatById(roomId);
    if (!message || message.deleted || (!this._sameAuthor(message, this.self) && chat?.ownerId !== this.self.id)) return false;
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


  _persistHistoryKeys() {
    try { this.storage.setHistoryKeys?.(Object.fromEntries(this.historyKeys)); } catch {}
  }

  _persistOutbox() {
    try { this.storage.setOutbox?.(this.outbox); } catch {}
  }

  _queueOutgoing(roomId, event) {
    if (!event?.eventId || this.outbox.some((item) => item.event?.eventId === event.eventId)) return;
    this.outbox.push({ roomId, event, historyKeyId: this._historyKeyId(this._historyKey(roomId)) });
    this._persistOutbox();
  }

  async _deliverOutgoing(item) {
    const { roomId, event, historyKeyId = '' } = item;
    const historyAck = await this._storeToHistory(roomId, event, historyKeyId);
    await this._ensureCrypto();
    const { epoch, key } = await this._ensureRoomSenderKey(roomId);
    const box = await key.encrypt(JSON.stringify({ segment: 'event', room: roomId, epoch, ...event }));
    const frame = { type: MessageType.Cipher, room: roomId, epoch, eventId: event.eventId, n: box.n, iv: box.iv, ct: box.ct };
    // Private rooms are acknowledged by their durable PostgreSQL history write.
    // Rooms without a history key still require a live relay before dequeueing.
    if (historyAck) this._send(frame);
    else await this._sendWithAck(frame);
    if (event.kind === 'message' && event.message) {
      if (!this._messageById(roomId, event.message.id)) this._applyEvent(roomId, event, this.self);
      this._markSent(roomId, this._messageById(roomId, event.message.id) || event.message);
    }
  }

  async _flushOutbox() {
    if (this._flushingOutbox) return false;
    this._flushingOutbox = true;
    let progressed = false;
    try {
      while (this.outbox.length) {
        const item = this.outbox[0];
        try { await this._deliverOutgoing(item); }
        catch { break; }
        this.outbox.shift();
        this._persistOutbox();
        progressed = true;
      }
    } finally { this._flushingOutbox = false; }
    return progressed;
  }

  _sendWithAck(payload, timeoutMs = 8000) {
    if (!payload?.eventId || this.ws?.readyState !== 1) return Promise.reject(new Error('OFFLINE'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._relayAcks.delete(payload.eventId); reject(new Error('ACK_TIMEOUT')); }, timeoutMs);
      this._relayAcks.set(payload.eventId, () => { clearTimeout(timer); resolve(true); });
      if (!this._send(payload)) {
        clearTimeout(timer);
        this._relayAcks.delete(payload.eventId);
        reject(new Error('OFFLINE'));
      }
    });
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
    const created = await fetch('/api/files/uploads', {
      method: 'POST', credentials: 'same-origin', headers: { 'Upload-Length': String(bytes.length) },
    });
    const session = await created.json().catch(() => ({}));
    if (!created.ok || !session.uploadId) {
      const legacy = await fetch('/api/files', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      const result = await legacy.json().catch(() => ({}));
      if (!legacy.ok || !result.id) throw new Error(result.error || session.error || 'UPLOAD_FAILED');
      return result.id;
    }
    const controller = new AbortController();
    this._activeUploads.set(session.uploadId, controller);
    const chunkSize = 1024 * 1024;
    let offset = Number(session.offset) || 0;
    try {
      while (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + chunkSize);
        let response; let attempts = 0;
        while (attempts++ < 3) {
          try {
            response = await fetch(`/api/files/uploads/${session.uploadId}`, {
              method: 'PATCH', credentials: 'same-origin', signal: controller.signal,
              headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) }, body: bytes.slice(offset, end),
            });
            if (response.ok) break;
            const failure = await response.json().catch(() => ({}));
            if (response.status === 409 && Number.isFinite(failure.offset)) {
              offset = failure.offset;
              response = { ok: true, json: async () => ({ offset }) };
              break;
            }
          } catch (error) { if (error.name === 'AbortError') throw error; }
          if (attempts < 3) await new Promise((resolve) => setTimeout(resolve, attempts * 350));
        }
        if (!response?.ok) throw new Error('UPLOAD_FAILED');
        const progress = await response.json(); offset = progress.offset;
        this._emit('upload', { id: session.uploadId, loaded: offset, total: bytes.length, progress: offset / bytes.length });
      }
      const completed = await fetch(`/api/files/uploads/${session.uploadId}/complete`, { method: 'POST', credentials: 'same-origin', signal: controller.signal });
      const result = await completed.json().catch(() => ({}));
      if (!completed.ok || !result.id) throw new Error(result.error || 'UPLOAD_FAILED');
      this._emit('upload', { id: session.uploadId, loaded: bytes.length, total: bytes.length, progress: 1, complete: true });
      return result.id;
    } finally { this._activeUploads.delete(session.uploadId); }
  }

  async cancelUpload(id) {
    this._activeUploads.get(id)?.abort();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`/api/files/uploads/${id}`, { method: 'DELETE', credentials: 'same-origin' });
        if (response.ok || response.status === 404) return true;
        if (response.status !== 409) return false;
      } catch { /* the aborted PATCH may still be releasing its server lock */ }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    return false;
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
    if (att.data && !att.blob) {
      const { ref, url } = await this._sealDataUrl(att.data);
      wire.blob = ref; delete wire.data;
      att.blob = ref; att.data = url;
    }
    if (att.poster && !att.posterBlob) {
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
    const attachments = await Promise.all(event.message.attachments.map((a) => this._attachmentToWire(a)));
    return { ...event, message: { ...event.message, attachments } };
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
  _historyKeyId(key) { return Array.from(key || []).slice(0, 8).map((value) => value.toString(16).padStart(2, '0')).join(''); }
  _historyKeyFor(roomId, keyId = '') {
    const current = this._historyKey(roomId);
    if (!keyId || this._historyKeyId(current) === keyId) return current;
    return (this.historyKeyArchive.get(roomId) || []).find((key) => this._historyKeyId(key) === keyId) || null;
  }
  _installRotatedHistoryKey(roomId, key, epoch = this._roomEpoch(roomId)) {
    if (!Array.isArray(key) || key.length !== 32) return false;
    const current = this._historyKey(roomId);
    if (current && this._historyKeyId(current) !== this._historyKeyId(key)) {
      const archive = this.historyKeyArchive.get(roomId) || [];
      if (!archive.some((old) => this._historyKeyId(old) === this._historyKeyId(current))) archive.push(current);
      this.historyKeyArchive.set(roomId, archive.slice(-12));
      this.storage.setHistoryKeyArchive?.(Object.fromEntries(this.historyKeyArchive));
    }
    this.historyKeys.set(roomId, key);
    this.historyKeyEpochs.set(roomId, Number(epoch) || 0);
    for (const item of this.outbox) {
      if (item.roomId === roomId) item.historyKeyId = this._historyKeyId(key);
    }
    this._persistOutbox();
    this.storage.setHistoryKeyEpochs?.(Object.fromEntries(this.historyKeyEpochs));
    this._persistHistoryKeys(); return true;
  }

  _seedHistoryKey(roomId) {
    if (!this.historyKeys.has(roomId)) {
      this.historyKeys.set(roomId, randomFileKey());
      this.historyKeyEpochs.set(roomId, this._roomEpoch(roomId));
      this._persistHistoryKeys();
      this.storage.setHistoryKeyEpochs?.(Object.fromEntries(this.historyKeyEpochs));
    }
    return this.historyKeys.get(roomId);
  }

  _adoptHistoryKeys(map, epochs = {}) {
    if (!map || typeof map !== 'object') return;
    let changed = false;
    for (const [roomId, key] of Object.entries(map)) {
      if (!this.historyKeys.has(roomId) && Array.isArray(key) && key.length === 32) {
        this.historyKeys.set(roomId, key);
        if (Number(epochs[roomId]) > 0) this.historyKeyEpochs.set(roomId, Number(epochs[roomId]));
        changed = true;
      }
    }
    if (changed) {
      this._persistHistoryKeys();
      this.storage.setHistoryKeyEpochs?.(Object.fromEntries(this.historyKeyEpochs));
      this._backfilled.clear();
      if (this.currentRoom) this._backfillRoom(this.currentRoom);
      this._flushOutbox();
    }
  }

  historyKeysExport() {
    return Object.fromEntries(this.historyKeys);
  }
  historyKeyArchiveExport() { return Object.fromEntries(this.historyKeyArchive); }

  // Persist one event to server history, encrypted to the room's history key.
  async _storeToHistory(roomId, event, historyKeyId = '') {
    if (roomId === SAVED_ID) return;
    const key = this._historyKeyFor(roomId, historyKeyId) || this._historyKey(roomId);
    if (!key || !event) return null;
    if (Number(this.historyKeyEpochs.get(roomId) || 0) < this._roomEpoch(roomId)) throw new Error('HISTORY_KEY_STALE');
    const clean = event.message ? { ...event, message: { ...event.message } } : event;
    if (clean.message) delete clean.message.status;
    try {
      const { iv, ct } = await sealBytes(key, new TextEncoder().encode(JSON.stringify(clean)));
      const { seq } = await this._roomsApi('POST', '/api/rooms/history', { roomId, epoch: this._roomEpoch(roomId), eventId: event.eventId, keyId: this._historyKeyId(key), iv: this._b64(iv), ct: this._b64(ct) });
      // Remember where this message lives so deleting it can erase it for good.
      const local = event.message?.id ? this._messageById(roomId, event.message.id) : null;
      if (local && seq) local.seq = seq;
      return seq || null;
    } catch { throw new Error('HISTORY_STORE_FAILED'); }
  }

  // Erase a stored envelope so a deleted message cannot return on a backfill.
  async _eraseFromHistory(roomId, message) {
    if (!message?.seq || roomId === SAVED_ID) return;
    try { await this._roomsApi('DELETE', '/api/rooms/history', { roomId, seq: message.seq }); }
    catch { /* not ours to erase, or already gone */ }
  }

  // Delete the room (owner) or leave it (member). Public rooms have neither, so
  // they are simply hidden locally.
  async _removeServerRoom(roomId) {
    const chat = this.chatById(roomId);
    if (!chat || chat.local || !chat.ownerId) return;
    this.historyKeys.delete(roomId);
    this._persistHistoryKeys();
    this._backfilled.delete(roomId);
    try { await this._roomsApi('DELETE', '/api/rooms', { roomId }); }
    catch { /* already gone, or not ours to remove */ }
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
      let after = 0;
      while (true) {
        const { envelopes } = await this._roomsApi('GET', `/api/rooms/history?roomId=${encodeURIComponent(roomId)}&after=${after}&limit=200`);
        const page = envelopes || [];
        for (const env of page) {
          after = Math.max(after, Number(env.seq) || 0);
          let event;
          const preferred = this._historyKeyFor(roomId, env.keyId);
          const candidates = env.keyId ? [preferred] : [preferred, ...(this.historyKeyArchive.get(roomId) || [])];
          for (const envelopeKey of candidates.filter(Boolean)) {
            try {
              const plain = await openBytes(envelopeKey, this._unb64(env.iv), this._unb64(env.ct));
              event = JSON.parse(new TextDecoder().decode(plain)); break;
            } catch {}
          }
          if (!event) continue;
          const id = event?.message?.id;
          if (id) {
            const local = this._messageById(roomId, id);
            if (local) local.seq ||= env.seq;
            else event.message.seq = env.seq;
          }
          this._applyEvent(roomId, event, { id: env.senderId || '', history: true });
        }
        if (page.length < 200) break;
      }
    } catch { this._backfilled.delete(roomId); }
  }

  async _ensureCrypto() {
    if (this.kit) return;
    this.kit = await createPreKeyBundle();
  }

  _roomEpoch(roomId) { return Number(this.chatById(roomId)?.membershipEpoch || this._serverRoomEpochs.get(roomId) || 1); }

  async _ensureRoomSenderKey(roomId) {
    const epoch = this._roomEpoch(roomId);
    let entry = this.senderKeys.get(roomId);
    if (entry?.epoch === epoch) return entry;
    entry = { epoch, key: SenderKey.create() };
    this.senderKeys.set(roomId, entry);
    for (const peerId of this.peers.keys()) await this._shareSenderKeyWith(peerId, roomId);
    return entry;
  }

  async _shareSenderKeyWith(peerId, roomId) {
    const peer = this.peers.get(peerId);
    const entry = this.senderKeys.get(roomId);
    if (!peer?.ratchet || !peer.ready || !entry || entry.epoch !== this._roomEpoch(roomId) || this.ws?.readyState !== 1) return;
    const payload = JSON.stringify({ segment: 'sender-key', roomId, epoch: entry.epoch, state: entry.key.export() });
    const box = await peer.ratchet.encrypt(payload);
    this._send({ type: MessageType.SenderKeyShare, to: peerId, room: roomId, epoch: entry.epoch, box });
  }

  async _shareAllRoomKeysWith(peerId) {
    for (const roomId of this.senderKeys.keys()) await this._shareSenderKeyWith(peerId, roomId);
  }

  async _join() {
    if (!this.self.name) return;
    await this._ensureCrypto();
    this._send({ type: MessageType.Join, version: PROTOCOL_VERSION, name: this.self.name, color: this.self.color, bundle: this.kit.bundle });
    this._emit('identity', { name: this.self.name });
  }

  _addPeer(m) {
    if (this.peers.has(m.id)) return;
    this.peers.set(m.id, { userId: m.userId || '', name: m.name, username: m.username, avatar: m.avatar, color: m.color, bundle: m.bundle, ready: false, views: new Map(), pendingCiphers: new Map() });
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
    const box = await ratchet.encrypt(JSON.stringify({ segment: 'pairwise-ready', version: PROTOCOL_VERSION }));
    this._send({ type: MessageType.KeyShare, to: from, x3dh, box });
    await this._shareAllRoomKeysWith(from);
  }

  async _onKeyShare(from, x3dh, box) {
    const p = this.peers.get(from);
    if (!p) return;
    if (x3dh && !p.ratchet) {
      p.ratchet = await x3dhRespond(this.kit.secret, x3dh);
      const hello = JSON.parse(await p.ratchet.decrypt(box));
      if (hello?.segment !== 'pairwise-ready') { p.ratchet = null; return; }
      p.ready = true;
      const reply = await p.ratchet.encrypt(JSON.stringify({ segment: 'pairwise-ready', version: PROTOCOL_VERSION }));
      this._send({ type: MessageType.KeyShare, to: from, box: reply });
    } else if (p.ratchet) {
      if (p.ready) return;
      const hello = JSON.parse(await p.ratchet.decrypt(box));
      if (hello?.segment !== 'pairwise-ready') return;
      p.ready = true;
    }
    await this._shareAllRoomKeysWith(from);
    this._requestMissingHistoryKeys();
  }

  async _onSenderKeyShare(from, roomId, epoch, box) {
    const peer = this.peers.get(from);
    if (!peer?.ratchet || !peer.ready || !box || epoch !== this._roomEpoch(roomId)) return;
    try {
      const payload = JSON.parse(await peer.ratchet.decrypt(box));
      if (payload?.segment !== 'sender-key' || payload.roomId !== roomId || payload.epoch !== epoch) return;
      peer.views.set(roomId, { epoch, view: SenderKeyView.from(payload.state) });
      await this._drain(peer, roomId);
    } catch {}
  }

  async _drain(p, roomId) {
    const pend = p.pendingCiphers.get(roomId) || [];
    p.pendingCiphers.delete(roomId);
    for (const c of pend) await this._decryptCipher(p, c);
  }



  async _onPeerLeft(id) {
    this.peers.delete(id);
  }

  _requestHistoryKey(roomId) {
    if (!roomId || this.ws?.readyState !== 1) return;
    if (this._historyKey(roomId) && Number(this.historyKeyEpochs.get(roomId) || 0) >= this._roomEpoch(roomId)) return;
    this._send({ type: MessageType.HistoryKeyRequest, room: roomId, epoch: this._roomEpoch(roomId) });
  }

  _requestMissingHistoryKeys() {
    for (const chat of this.chats) {
      if (!chat.local) this._requestHistoryKey(chat.id);
    }
  }

  async _onHistoryKeyRequest(from, roomId, epoch) {
    const key = this._historyKey(roomId);
    const peer = this.peers.get(from);
    if (!key || !peer?.ratchet || !peer.ready || epoch !== this._roomEpoch(roomId)
      || Number(this.historyKeyEpochs.get(roomId) || 0) < epoch) return;
    await this._shareHistoryKeyWith(from, roomId, false);
  }

  async _shareHistoryKeyWith(peerId, roomId, rotate) {
    const peer = this.peers.get(peerId);
    const key = this._historyKey(roomId);
    const epoch = this._roomEpoch(roomId);
    if (!key || !peer?.ratchet || !peer.ready || this.ws?.readyState !== 1) return;
    const box = await peer.ratchet.encrypt(JSON.stringify({ segment: 'history-key', roomId, epoch, key, rotate: Boolean(rotate) }));
    this._send({ type: MessageType.HistoryKeyShare, to: peerId, room: roomId, epoch, box });
  }

  async _onHistoryKeyShare(from, roomId, epoch, box) {
    const peer = this.peers.get(from);
    if (!peer?.ratchet || !peer.ready || !box || epoch !== this._roomEpoch(roomId)) return;
    try {
      const payload = JSON.parse(await peer.ratchet.decrypt(box));
      if (payload?.segment === 'history-key' && payload.roomId === roomId && payload.epoch === epoch) {
        if (payload.rotate || Number(this.historyKeyEpochs.get(roomId) || 0) < epoch) this._installRotatedHistoryKey(roomId, payload.key, epoch);
        else this._adoptHistoryKeys({ [roomId]: payload.key }, { [roomId]: epoch });
        this.preloadRoomHistories();
      }
    } catch {}
  }

  async _rotateRoomHistoryKey(roomId) {
    const chat = this.chatById(roomId);
    if (!chat || chat.ownerId !== this.self.id || this.ws?.readyState !== 1) return;
    const key = Array.from(randomFileKey());
    this._installRotatedHistoryKey(roomId, key, this._roomEpoch(roomId));
    for (const peerId of this.peers.keys()) await this._shareHistoryKeyWith(peerId, roomId, true);
  }

  async _advanceRoomEpoch(roomId, epoch, rotateHistory = false) {
    if (!Number.isSafeInteger(epoch) || epoch < Number(this._serverRoomEpochs.get(roomId) || 0)) return;
    this._serverRoomEpochs.set(roomId, epoch);
    const chat = this.chatById(roomId);
    if (!chat || epoch < this._roomEpoch(roomId)) return;
    const changed = epoch !== this._roomEpoch(roomId);
    chat.membershipEpoch = epoch;
    if (changed || !this.senderKeys.has(roomId)) {
      this.senderKeys.delete(roomId);
      for (const peer of this.peers.values()) {
        peer.views.delete(roomId);
        peer.pendingCiphers.delete(roomId);
      }
      await this._ensureRoomSenderKey(roomId);
    }
    if (rotateHistory) await this._rotateRoomHistoryKey(roomId);
    else if (Number(this.historyKeyEpochs.get(roomId) || 0) < epoch) this._requestHistoryKey(roomId);
  }

  _revokeRoomAccess(roomId) {
    this.senderKeys.delete(roomId);
    this.historyKeys.delete(roomId);
    this.historyKeyArchive.delete(roomId);
    this.historyKeyEpochs.delete(roomId);
    for (const peer of this.peers.values()) {
      peer.views.delete(roomId);
      peer.pendingCiphers.delete(roomId);
    }
    this._persistHistoryKeys();
    this.storage.setHistoryKeyArchive?.(Object.fromEntries(this.historyKeyArchive));
    this.storage.setHistoryKeyEpochs?.(Object.fromEntries(this.historyKeyEpochs));
  }

  async _onCipher(msg) {
    const p = this.peers.get(msg.from);
    if (!p || msg.epoch !== this._roomEpoch(msg.room)) return;
    const entry = p.views.get(msg.room);
    if (!entry || entry.epoch !== msg.epoch) {
      const pending = p.pendingCiphers.get(msg.room) || [];
      if (pending.length < 256) pending.push(msg);
      p.pendingCiphers.set(msg.room, pending);
      return;
    }
    await this._decryptCipher(p, msg);
  }

  async _decryptCipher(p, msg) {
    const entry = p.views.get(msg.room);
    if (!entry || entry.epoch !== msg.epoch) return;
    let text;
    try { text = await entry.view.decrypt({ n: msg.n, iv: msg.iv, ct: msg.ct }); } catch { return; }
    const event = parseEnvelope(text);
    if (event.room !== msg.room || event.epoch !== msg.epoch) return;
    this._applyEvent(msg.room, event, { id: p.userId, name: p.name, username: p.username, avatar: p.avatar, color: p.color });
    if (event.kind === 'message' && event.message?.id) {
      this.sendEvent(msg.room, { kind: 'receipt', ids: [event.message.id], state: msg.room === this.currentRoom ? 'read' : 'delivered' }, false);
    }
  }



  async _onServer(msg) {
    switch (msg.type) {
      case MessageType.Roster:
        this.myId = msg.self.id;
        this.online = msg.online;
        this._serverRoomEpochs = new Map(Object.entries(msg.roomEpochs || {}).map(([roomId, epoch]) => [roomId, Number(epoch) || 1]));
        this._historyRecoveryRooms = new Set(msg.historyRecoveryRooms || []);
        for (const m of msg.members) this._addPeer(m);
        for (const [roomId, epochValue] of Object.entries(msg.roomEpochs || {})) {
          const epoch = Number(epochValue);
          const recoverHistory = (msg.historyRecoveryRooms || []).includes(roomId)
            && this.chatById(roomId)?.ownerId === this.self.id
            && Number(this.historyKeyEpochs.get(roomId) || 0) < epoch;
          await this._advanceRoomEpoch(roomId, epoch, recoverHistory);
        }
        for (const m of msg.members) this._maybeInitiate(m.id);
        this._emit('chats');
        if (this.currentRoom) {
          this._emit('room', { chat: this.chatById(this.currentRoom), messages: this.messages[this.currentRoom] });
        }
        this._emit('status', this._statusText());
        break;

      case MessageType.Peer:
        if (Array.isArray(msg.online)) this.online = msg.online;
        this._addPeer(msg);
        this._maybeInitiate(msg.id);
        this._emit('status', this._statusText());
        break;

      case MessageType.PeerLeft:
        await this._onPeerLeft(msg.id);
        if (Array.isArray(msg.online)) this.online = msg.online;
        this._emit('status', this._statusText());
        break;

      case MessageType.Presence:
        if (Array.isArray(msg.online)) this.online = msg.online;
        this._emit('status', this._statusText());
        break;

      case MessageType.PreKey:
        await this._onPreKey(msg.from, msg.opk);
        break;

      case MessageType.KeyShare:
        await this._onKeyShare(msg.from, msg.x3dh, msg.box);
        break;

      case MessageType.SenderKeyShare:
        await this._onSenderKeyShare(msg.from, msg.room, msg.epoch, msg.box);
        break;

      case MessageType.HistoryKeyRequest:
        await this._onHistoryKeyRequest(msg.from, msg.room, msg.epoch);
        break;

      case MessageType.HistoryKeyShare:
        await this._onHistoryKeyShare(msg.from, msg.room, msg.epoch, msg.box);
        break;

      case MessageType.RoomMembersChanged:
        await this._advanceRoomEpoch(msg.room, msg.epoch, msg.rotateHistory);
        break;

      case MessageType.RoomAccessRevoked:
        this._revokeRoomAccess(msg.room);
        break;

      case MessageType.Ack: {
        const ack = this._relayAcks.get(msg.eventId);
        if (ack) { this._relayAcks.delete(msg.eventId); ack(); }
        break;
      }

      case MessageType.Cipher:
        await this._onCipher(msg);
        break;

      case MessageType.System:
        if (Array.isArray(msg.online)) this.online = msg.online;
        if (this.currentRoom && this.currentRoom !== SAVED_ID) this._addMessage(this.currentRoom, { system: true, text: msg.text });
        this._emit('status', this._statusText());
        break;

      case MessageType.Typing:
        this._setTyping(msg.room, msg.name);
        if (msg.room === this.currentRoom) this._emit('typing', { name: msg.name });
        break;
    }
  }

  _addMessage(roomId, m, { historical = false } = {}) {
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
    if (!historical && !current && !m.system) {
      if (!this.unread[roomId]) this.firstUnread[roomId] = m.id;
      this.unread[roomId] = (this.unread[roomId] || 0) + 1;
    }
    this._emit('append', { roomId, message: m, current, wasEmpty });
    this._emit('chats');
  }

  _makeMessage(text, replyTo = null, extra = {}) {
    return {
      id: mid(),
      authorId: this.self.id || '',
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
      return { id: source.id, name: source.channelName || source.name, text: q.quote && fragment ? fragment : (source.text || ''), quote: Boolean(q.quote) };
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
    if (event.eventId) {
      if (this._appliedEvents.has(event.eventId)) return;
      this._appliedEvents.add(event.eventId);
    }
    if (event.kind === 'message') {
      const message = event.message || this._makeMessage(event.text || '');
      if (!attachmentsWithinLimits(message.attachments)) return;
      if (message.id && this._messageById(roomId, message.id)) return;
      if (author.id) message.authorId = author.id;
      if (author.name) {
        message.name = author.name;
        message.username = author.username || '';
        message.avatar = author.avatar || '';
        message.color = author.color;
      }
      const chat = this.chatById(roomId);
      if (chat?.type === ChatType.Channel) {
        message.channelName = chat.name;
        message.channelIcon = chat.icon || message.channelIcon || '';
      }
      this._addMessage(roomId, message, { historical: author.history === true });
      this._hydrateMessage(roomId, message);
      return;
    }

    if (event.kind === 'receipt') {
      const rank = { sending: 0, sent: 1, delivered: 2, read: 3 };
      let changed = false;
      for (const id of event.ids || []) {
        const receiptMessage = this._messageById(roomId, id);
        if (!receiptMessage || !this._sameAuthor(receiptMessage, this.self)) continue;
        const by = author.username || author.name || '';
        if (by) {
          receiptMessage.receipts ||= {};
          receiptMessage.receipts[by] = event.state;
        }
        if ((rank[event.state] || 0) > (rank[receiptMessage.status] || 0)) { receiptMessage.status = event.state; changed = true; }
        else if (by) changed = true;
      }
      if (changed) this._refreshRoom(roomId);
      return;
    }
    // Protocol v3 never accepts key material from a room event. Membership-key
    // rotation travels only over the room-scoped pairwise control channel.
    if (event.kind === 'history-key-rotate') return;

    const message = this._messageById(roomId, event.id);
    if (event.kind === 'reaction' && message) {
      message.reactions ||= {};
      message.reactions[event.emoji] ||= [];
      const list = message.reactions[event.emoji];
      const actors = this._actorKeys(author, event.by);
      const active = list.some((value) => actors.includes(value));
      message.reactions[event.emoji] = list.filter((value) => !actors.includes(value));
      if (!active) message.reactions[event.emoji].push(actors[0]);
      if (!message.reactions[event.emoji].length) delete message.reactions[event.emoji];
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'edit' && message) {
      if (!this._sameAuthor(message, author)) return;
      message.text = event.text;
      message.edited = Date.now();
      this.lastText[roomId] = preview(message);
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'delete' && message) {
      const chat = this.chatById(roomId);
      if (!this._sameAuthor(message, author) && chat?.ownerId !== author.id) return;
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
      const actors = this._actorKeys(author, event.by);
      const previous = actors.map((actor) => message.poll.votes[actor]).find((value) => value !== undefined);
      for (const actor of actors) delete message.poll.votes[actor];
      if (previous !== event.option) message.poll.votes[actors[0]] = event.option;
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

  _sameAuthor(message, author = {}) {
    if (!message) return false;
    if (message.authorId || author.id) return Boolean(message.authorId && author.id && message.authorId === author.id);
    if (message.username || author.username) return Boolean(message.username && author.username && message.username === author.username);
    return Boolean(message.name && author.name && message.name === author.name);
  }

  _actorKeys(author = {}, legacy = '') {
    const verified = [...new Set([author.id, author.username, author.name].filter(Boolean))];
    return verified.length ? verified : [legacy || 'user'];
  }



  _send(payload) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
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
