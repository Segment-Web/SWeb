// Ядро клиента Segment — аналог TDLib.
//
// Держит всю клиентскую логику: WebSocket-соединение, состояние чатов и поток
// обновлений. С v2 — сквозное шифрование (E2EE): сервер видит только шифртекст.
// Комнаты шифруются схемой sender-key (@segment/crypto): у каждого участника своя
// ratchet-цепочка, её начальное состояние раздаётся остальным по личным
// ECDH-каналам. Ничего не знает про DOM — один код на веб и будущие приложения.
//
// Требует глобальные `WebSocket`, `location` и WebCrypto (браузер, RN, Node 20+).

import { ROOMS, MessageType, PROTOCOL_VERSION, ChatType } from '@segment/protocol';
import {
  createPreKeyBundle, x3dhInitiate, x3dhRespond, SenderKey, SenderKeyView,
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
    this.self = { name: storage.getName(), color: storage.getColor?.() || pickColor() };
    this.currentRoom = null; // изначально ни один чат не выбран — выбирает юзер
    this.messages = Object.fromEntries(this.chats.map((c) => [c.id, []]));
    this.messages[SAVED_ID] = storage.getNotes();
    this.unread = {};
    this.lastText = {};
    const savedGeneral = storage.getGeneral?.() || [];
    if (savedGeneral.length) {
      this.messages.general = savedGeneral;
      const last = savedGeneral[savedGeneral.length - 1];
      if (last) this.lastText.general = last.system ? last.text : preview(last);
    }
    this.pinned = new Set(storage.getPinned ? storage.getPinned() : []);
    this.muted = new Set(storage.getMuted?.() || []);
    this.archived = new Set(storage.getArchived?.() || []);
    this.folders = storage.getFolders?.() || [];
    this.unreadDot = new Set(); // чаты, помеченные «непрочитанным» вручную
    this.firstUnread = {};      // id первого непрочитанного сообщения по чату
    this.typing = {};           // roomId -> имя того, кто печатает (для строки списка)
    this._typingTimers = {};
    this.online = [];

    this.ws = null;
    this._lastTyping = 0;

    // крипта
    this.kit = null;           // prekey-бандл (secret + публичный bundle)
    this.senderKey = null;     // наша sender-key цепочка для комнат
    this.myId = null;          // id соединения (от сервера)
    this.peers = new Map();    // id -> { name, color, bundle, ratchet, view, pendingCiphers }
    this._queue = Promise.resolve(); // строгий порядок обработки серверных сообщений
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

  // ── команды от платформы ──

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
    // обрабатываем строго по очереди — крипта асинхронна, порядок важен
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

  // Создать новый чат/канал. Сервер комнат не знает (слепой ретранслятор),
  // так что чат — это просто согласованный id: кто добавил такой же id, тот и
  // окажется в одной комнате. Возвращает id созданного чата.
  createChat({ name, icon, type } = {}) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const kind = [ChatType.DM, ChatType.Chat, ChatType.Channel].includes(type) ? type : ChatType.Chat;
    const defaultIcon = { [ChatType.DM]: '👤', [ChatType.Chat]: '💬', [ChatType.Channel]: '📢' }[kind];
    const base = clean.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'chat';
    let id = `${kind}-${base}`;
    let n = 1;
    while (this.chatById(id)) id = `${kind}-${base}-${++n}`;

    const chat = { id, name: clean, icon: icon || defaultIcon, type: kind };
    this.chats.push(chat);
    this.messages[id] = [];
    this._emit('chats');
    this.openRoom(id);
    return id;
  }

  // Закрепить/открепить чат — закреплённые всплывают вверх списка.
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

  // Выключить/включить уведомления чата. Сообщения приходят, но бейдж
  // становится приглушённым — считаем, но не «кричим».
  toggleMute(id) {
    if (!this.chatById(id)) return;
    if (this.muted.has(id)) this.muted.delete(id);
    else this.muted.add(id);
    this.storage.setMuted?.([...this.muted]);
    this._emit('chats');
  }

  isMuted(id) { return this.muted.has(id); }

  // Архивировать/вернуть чат из архива.
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

  // Отметить чат прочитанным: снять счётчик и ручную пометку.
  markRead(id) {
    if (!this.chatById(id)) return;
    this.unread[id] = 0;
    this.unreadDot.delete(id);
    delete this.firstUnread[id];
    this._emit('chats');
  }

  // Отметить непрочитанным (точка). Текущий открытый чат так пометить нельзя.
  markUnread(id) {
    if (!this.chatById(id) || id === this.currentRoom) return;
    this.unreadDot.add(id);
    this._emit('chats');
  }

  // Очистить историю чата локально (сервер её и так не хранит).
  clearHistory(id) {
    if (!this.messages[id]) return false;
    this.messages[id] = [];
    delete this.lastText[id];
    this.unread[id] = 0;
    this.unreadDot.delete(id);
    delete this.firstUnread[id];
    if (id === SAVED_ID) this.storage.setNotes([]);
    if (id === 'general') this.storage.setGeneral?.([]);
    if (id === this.currentRoom) this._emit('room', { chat: this.chatById(id), messages: this.messages[id] });
    this._emit('chats');
    return true;
  }

  // Можно ли удалить/переименовать чат (Избранное — нельзя).
  canEditChat(id) {
    const chat = this.chatById(id);
    return !!chat && chat.type !== ChatType.Saved;
  }

  // Переименовать чат/канал (id не меняем — он и есть комната).
  renameChat(id, name) {
    const chat = this.chatById(id);
    const clean = (name || '').trim();
    if (!chat || !clean || chat.type === ChatType.Saved) return false;
    chat.name = clean;
    this._emit('chats');
    if (this.currentRoom === id) this._emit('room', { chat, messages: this.messages[id] });
    return true;
  }

  // Удалить/выйти из чата: локально убираем комнату из списка.
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
    this._emit('room', { chat: this.chatById(id), messages: this.messages[id] });
    this._emit('chats');
    this._emit('status', this._statusText());
    const readIds = this.messages[id]?.filter((m) => !m.system && !m.deleted && m.name !== this.self.name).map((m) => m.id) || [];
    if (readIds.length && id !== SAVED_ID) this.sendEvent(id, { kind: 'receipt', ids: readIds, state: 'read' }, false);
  }

  // Закрыть текущий чат — вернуться к состоянию «ничего не выбрано» (Esc).
  closeRoom() {
    if (!this.currentRoom) return;
    this.currentRoom = null;
    this._emit('room', { chat: null, messages: [] });
    this._emit('chats');
  }

  // Отправка в текущий чат.
  send(text) { return this.sendTo(this.currentRoom, text); }

  // Отправка в конкретный чат — нужно доп-блокам, привязанным к своей комнате.
  async sendTo(roomId, text) {
    const clean = (text || '').trim();
    if (!clean || !roomId || !this.chatById(roomId)) return;

    const message = this._makeMessage(clean);
    this._addMessage(roomId, message); // показываем сразу — с «часиками»
    if (roomId === SAVED_ID) {
      message.status = 'sent';
      this.storage.setNotes(this.messages[SAVED_ID]);
      return;
    }

    await this._ensureCrypto();
    const box = await this.senderKey.encrypt(JSON.stringify({ segment: 'event', kind: 'message', message })); // { n, iv, ct }
    this._send({ type: MessageType.Cipher, room: roomId, n: box.n, iv: box.iv, ct: box.ct });
    this._markSent(roomId, message);
  }

  // Отправка вложений (фото/файлы) с необязательной подписью. Данные каждого
  // вложения (base64 data URL) едут внутри зашифрованного события — сервер их
  // не видит, ровно как и текст.
  async sendAttachments(roomId, attachments, caption = '', replyRef = null) {
    roomId = roomId || this.currentRoom;
    const files = (attachments || []).filter(Boolean);
    if (!files.length || !roomId || !this.chatById(roomId)) return;
    const replyTo = this._replySnapshot(roomId, replyRef);
    const message = this._makeMessage((caption || '').trim(), replyTo, { attachments: files });
    return this.sendEvent(roomId, { kind: 'message', message });
  }

  // Сменить цвет профиля (аватар/имя). Косметика — храним локально.
  setColor(color) {
    if (!color || color === this.self.color) return;
    this.self.color = color;
    this.storage.setColor?.(color);
    this._emit('identity', { name: this.self.name });
  }

  // Сохранить диалог комнаты «Общий» в локальное хранилище (переживёт перезапуск).
  saveDialog(roomId = 'general') {
    if (roomId !== 'general') return;
    this.storage.setGeneral?.(this.messages.general || []);
  }

  // Выйти: стереть личность и локальные данные (перед reload на клиенте).
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
    // сообщения показываем сразу (с «часиками»), реакции/правки — как раньше
    if (local) this._applyEvent(roomId, event, { name: this.self.name, color: this.self.color });
    if (roomId !== SAVED_ID) {
      await this._ensureCrypto();
      const box = await this.senderKey.encrypt(JSON.stringify({ segment: 'event', ...event }));
      this._send({ type: MessageType.Cipher, room: roomId, n: box.n, iv: box.iv, ct: box.ct });
    }
    if (event.kind === 'message' && event.message) this._markSent(roomId, event.message);
  }

  // Создать опрос: вопрос + список вариантов. Голоса храним в самом сообщении.
  sendPoll(roomId, question, options) {
    roomId = roomId || this.currentRoom;
    const q = (question || '').trim();
    const opts = (options || []).map((o) => (o || '').trim()).filter(Boolean);
    if (!q || opts.length < 2 || !this.chatById(roomId)) return false;
    const message = this._makeMessage('', null, { poll: { question: q, options: opts, votes: {} } });
    return this.sendEvent(roomId, { kind: 'message', message });
  }

  // Проголосовать (одиночный выбор). Повторный клик по своему варианту — отмена.
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

  // ── крипта и рукопожатие ──

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
    this.peers.set(m.id, { name: m.name, color: m.color, bundle: m.bundle, pendingCiphers: [] });
  }

  // Меньший id инициирует X3DH (запрашивает одноразовый prekey), больший — ждёт.
  _maybeInitiate(id) {
    if (this.myId != null && this.myId < id) this._send({ type: MessageType.PreKeyRequest, to: id });
  }

  // Инициатор: получил prekey участника → делает X3DH и шлёт ему свой sender-key.
  async _onPreKey(from, opk) {
    const p = this.peers.get(from);
    if (!p || p.ratchet || !p.bundle) return;
    const bundle = { ...p.bundle, opks: opk ? [opk] : [] };
    const { ratchet, x3dh } = await x3dhInitiate(this.kit.secret, bundle);
    p.ratchet = ratchet;
    const box = await ratchet.encrypt(JSON.stringify(this.senderKey.export()));
    this._send({ type: MessageType.KeyShare, to: from, x3dh, box });
  }

  async _onKeyShare(from, x3dh, box) {
    const p = this.peers.get(from);
    if (!p) return;
    if (x3dh && !p.ratchet) {
      // ответчик: устанавливаем сессию из X3DH-заголовка, читаем sender-key,
      // и в ответ по тому же храповику отдаём свой
      p.ratchet = await x3dhRespond(this.kit.secret, x3dh);
      p.view = SenderKeyView.from(JSON.parse(await p.ratchet.decrypt(box)));
      await this._drain(p);
      const reply = await p.ratchet.encrypt(JSON.stringify(this.senderKey.export()));
      this._send({ type: MessageType.KeyShare, to: from, box: reply });
    } else if (p.ratchet) {
      // инициатор получил ответный sender-key
      p.view = SenderKeyView.from(JSON.parse(await p.ratchet.decrypt(box)));
      await this._drain(p);
    }
  }

  async _drain(p) {
    const pend = p.pendingCiphers;
    p.pendingCiphers = [];
    for (const c of pend) await this._decryptCipher(p, c);
  }

  // Участник ушёл → меняем свой sender-key и раздаём новый оставшимся, чтобы
  // ушедший не мог прочитать будущие сообщения (forward secrecy по составу).
  async _onPeerLeft(id) {
    const had = this.peers.delete(id);
    if (!had || !this.senderKey) return;
    this.senderKey = SenderKey.create();
    const state = JSON.stringify(this.senderKey.export());
    for (const [pid, p] of this.peers) {
      if (p.ratchet) this._send({ type: MessageType.KeyShare, to: pid, box: await p.ratchet.encrypt(state) });
    }
  }

  async _onCipher(msg) {
    const p = this.peers.get(msg.from);
    if (!p) return;
    if (!p.view) { p.pendingCiphers.push(msg); return; } // ждём sender-key
    await this._decryptCipher(p, msg);
  }

  async _decryptCipher(p, msg) {
    let text;
    try { text = await p.view.decrypt({ n: msg.n, iv: msg.iv, ct: msg.ct }); } catch { return; }
    const event = parseEnvelope(text);
    this._applyEvent(msg.room, event, { name: p.name, color: p.color });
    if (event.kind === 'message' && event.message?.id) {
      this.sendEvent(msg.room, { kind: 'receipt', ids: [event.message.id], state: msg.room === this.currentRoom ? 'read' : 'delivered' }, false);
    }
  }

  // ── обработка сервера (строго по очереди) ──

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
        await this._onKeyShare(msg.from, msg.x3dh, msg.box);
        break;

      case MessageType.Cipher:
        await this._onCipher(msg);
        break;

      case MessageType.System:
        this.online = msg.online;
        this._addMessage(!this.currentRoom || this.currentRoom === SAVED_ID ? 'general' : this.currentRoom, { system: true, text: msg.text });
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
      if (!this.unread[roomId]) this.firstUnread[roomId] = m.id; // граница «непрочитанного»
      this.unread[roomId] = (this.unread[roomId] || 0) + 1;
    }
    this._emit('append', { roomId, message: m, current, wasEmpty });
    this._emit('chats');
  }

  _makeMessage(text, replyTo = null, extra = {}) {
    return {
      id: mid(),
      name: this.self.name,
      color: this.self.color,
      text: (text || '').trim(),
      ts: Date.now(),
      reactions: {},
      replyTo,
      status: 'sending', // до отправки — часики; после — галочка
      ...extra,
    };
  }

  // Отметить, что в чате кто-то печатает — с авто-сбросом; обновляем список.
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

  // Пометить своё сообщение отправленным и перерисовать чат.
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
      if (author.name && (!message.name || message.name === this.self.name)) {
        message.name = author.name;
        message.color = author.color;
      }
      this._addMessage(roomId, message);
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
      message.deleted = true;
      message.text = 'Сообщение удалено';
      message.reactions = {};
      if (Array.isArray(this.messages[roomId].pinnedIds)) {
        this.messages[roomId].pinnedIds = this.messages[roomId].pinnedIds.filter((id) => id !== message.id);
        this.messages[roomId].pinnedId = this.messages[roomId].pinnedIds.at(-1) || null;
      }
      this.lastText[roomId] = preview(message);
      this._refreshRoom(roomId);
      return;
    }
    if (event.kind === 'poll-vote' && message?.poll) {
      const by = event.by || author.name || 'user';
      if (message.poll.votes[by] === event.option) delete message.poll.votes[by]; // отмена
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

  // ── низкий уровень ──

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
