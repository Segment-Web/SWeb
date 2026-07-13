// Общий протокол Segment.
//
// Единственный источник правды о том, как общаются клиент и сервер.
// Этот файл платформонезависим (никаких зависимостей от Node или DOM),
// поэтому его импортируют и сервер, и веб-клиент, и любые будущие
// приложения (мобильные, десктоп) — чтобы не расходились форматы сообщений.

// Версия протокола («layer» в терминах Telegram). Повышай при несовместимых
// изменениях формата сообщений, чтобы клиент и сервер могли договориться.
// v2 — E2EE: сервер стал слепым ретранслятором шифртекста.
export const PROTOCOL_VERSION = 2;

/** Публичные комнаты чата. Локальные чаты (напр. «Избранное») клиент добавляет сам. */
/** Типы чатов: заметки, личка, групповой чат, канал (вещание). */
export const ChatType = {
  Saved: 'saved',
  DM: 'dm',
  Chat: 'chat',
  Channel: 'channel',
};

export const ROOMS = [
  { id: 'general', name: 'Общий',    icon: '💬', type: ChatType.Chat },
  { id: 'flood',   name: 'Флудилка', icon: '🌊', type: ChatType.Chat },
  { id: 'memes',   name: 'Мемы',     icon: '🐸', type: ChatType.Channel },
];

export const ROOM_IDS = ROOMS.map((r) => r.id);

/** Ограничения, которые обязан соблюдать сервер и стоит подсказывать клиенту. */
export const LIMITS = {
  name: 24,       // максимум символов в имени
  message: 2000,  // максимум символов в сообщении
  history: 50,    // сколько последних сообщений на комнату хранит сервер
};

/** Типы сообщений в WebSocket-канале (в поле `type`). */
export const MessageType = {
  Join: 'join',           // клиент → сервер: имя, цвет, публичный ключ
  Roster: 'roster',       // сервер → новичку: свой id + участники (с их pub)
  Peer: 'peer',           // сервер → остальным: новый участник (id, bundle, …)
  PeerLeft: 'peer-left',  // сервер → остальным: участник ушёл
  PreKeyRequest: 'prekey-request', // клиент → сервер: дай одноразовый prekey участника
  PreKey: 'prekey',       // сервер → клиенту: одноразовый prekey участника (для X3DH)
  KeyShare: 'keyshare',   // клиент → клиенту (через сервер): X3DH-заголовок + шифртекст sender-key
  Cipher: 'cipher',       // клиент → всем: зашифрованное сообщение в комнату
  Typing: 'typing',       // в обе стороны: «печатает…»
  System: 'system',       // сервер → клиент: «зашёл/вышел», список онлайна
};

export function isValidRoom(id) {
  return ROOM_IDS.includes(id);
}

/** Приводит произвольный ввод к строке и обрезает до лимита. */
export function clean(value, max) {
  return String(value ?? '').slice(0, max);
}
