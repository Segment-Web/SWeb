// Shared Segment protocol and the single source of truth for client/server
// communication. This module has no Node or DOM dependency, so every client
// imports the same wire definitions.

// Increase the protocol layer when a wire-format change is incompatible.
// Layer 2 introduced encrypted envelopes and a blind ciphertext relay.
export const PROTOCOL_VERSION = 2;

/** Supported chat categories. */
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

/** Limits enforced by the server and surfaced by clients. */
export const LIMITS = {
  name: 24,
  message: 2000,
  history: 50,
};

/** WebSocket envelope types. */
export const MessageType = {
  Join: 'join',
  Roster: 'roster',
  Peer: 'peer',
  PeerLeft: 'peer-left',
  PreKeyRequest: 'prekey-request',
  PreKey: 'prekey',
  KeyShare: 'keyshare',
  Cipher: 'cipher',
  Typing: 'typing',
  System: 'system',
};

export function isValidRoom(id) {
  return ROOM_IDS.includes(id);
}

/** Convert arbitrary input to a string and enforce a character limit. */
export function clean(value, max) {
  return String(value ?? '').slice(0, max);
}
