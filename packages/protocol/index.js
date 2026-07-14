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

/** Shape a room slug: lowercase, url-safe, 3..32 chars. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/** Client/link routing prefixes for profiles, channels and invites. */
export const LINK = {
  profile: (username) => `/@${username}`,
  channel: (slug) => `/c/${slug}`,
  invite: (token) => `/j/${token}`,
};

/**
 * Parse an in-app deep link into a typed reference, or null.
 * Accepts absolute paths and full URLs on any host.
 */
export function parseLink(input) {
  let path = String(input ?? '').trim();
  if (!path) return null;
  try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname; } catch { return null; }
  let match;
  if ((match = path.match(/^\/@([a-z0-9_]{3,24})$/i))) return { type: 'profile', username: match[1].toLowerCase() };
  if ((match = path.match(/^\/c\/([a-z0-9-]{3,32})$/i))) return { type: 'channel', slug: match[1].toLowerCase() };
  if ((match = path.match(/^\/j\/([A-Za-z0-9_-]{16,64})$/))) return { type: 'invite', token: match[1] };
  return null;
}

export function isValidRoom(id) {
  return ROOM_IDS.includes(id);
}

/** Convert arbitrary input to a string and enforce a character limit. */
export function clean(value, max) {
  return String(value ?? '').slice(0, max);
}
