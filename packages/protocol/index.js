// Shared Segment protocol and the single source of truth for client/server
// communication. This module has no Node or DOM dependency, so every client
// imports the same wire definitions.

// Increase the protocol layer when a wire-format change is incompatible.
// Layer 2 introduced encrypted envelopes and a blind ciphertext relay.
// Layer 3 scopes sender chains to a room membership epoch.
// Layer 4 signs sender-key ciphertexts and binds them to room context with AAD.
export const PROTOCOL_VERSION = 4;

/** Supported chat categories. */
export const ChatType = {
  Saved: 'saved',
  DM: 'dm',
  Chat: 'chat',
  Channel: 'channel',
};

// Seeded public rooms. 'general' was removed: it had no owner, so no history key
// was ever seeded for it and nothing it carried could be stored or erased.
export const ROOMS = [
  { id: 'flood',   name: 'Флудилка', icon: '🌊', type: ChatType.Chat },
  { id: 'memes',   name: 'Мемы',     icon: '🐸', type: ChatType.Channel },
];

/** Rooms retired from ROOMS: purged server-side and from local storage. */
export const RETIRED_ROOM_IDS = ['general'];

export const ROOM_IDS = ROOMS.map((r) => r.id);

/** Limits enforced by the server and surfaced by clients. */
export const LIMITS = {
  name: 24,
  message: 2000,
  history: 50,
  photosAndFilesPerMessage: 100,
  videosPerMessage: 50,
};

/** WebSocket envelope types. */
export const MessageType = {
  Join: 'join',
  Roster: 'roster',
  Peer: 'peer',
  PeerLeft: 'peer-left',
  Presence: 'presence',
  PreKeyRequest: 'prekey-request',
  PreKey: 'prekey',
  PreKeyConsumed: 'prekey-consumed',
  KeyShare: 'keyshare',
  SenderKeyShare: 'sender-key-share',
  HistoryKeyRequest: 'history-key-request',
  HistoryKeyShare: 'history-key-share',
  RoomMembersChanged: 'room-members-changed',
  RoomAccessRevoked: 'room-access-revoked',
  Cipher: 'cipher',
  Ack: 'ack',
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

/** Longest AES-GCM nonce we accept on the wire (the crypto layer emits 12 bytes). */
export const MAX_IV_BYTES = 32;

/**
 * Hard ceiling on one ciphertext body, independent of the socket payload limit.
 * `ct` travels as a JSON array of byte-sized integers, so a frame sized against
 * the raw socket budget (megabytes) costs an order of magnitude more to parse,
 * validate and re-serialise to every room member than its byte count suggests.
 * Attachments upload out-of-band, so a real frame carries only message text and
 * small blob references and stays far below this.
 */
export const MAX_CIPHER_BYTES = 256 * 1024;
const isByteArray = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max
  && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);

/**
 * Validate a ciphertext frame. The crypto layer emits `iv` and `ct` as byte
 * ARRAYS (see `seal`), so the relay must accept arrays — an earlier version
 * demanded strings here and silently dropped every encrypted message while
 * typing indicators still went through. Keep this the single source of truth
 * for the wire shape so the relay and the crypto layer cannot drift apart.
 */
export function isCipherFrame(message, maxCtBytes) {
  const cap = Math.min(Number(maxCtBytes) || MAX_CIPHER_BYTES, MAX_CIPHER_BYTES);
  return Boolean(message)
    && Number.isSafeInteger(message.n) && message.n >= 0
    && isByteArray(message.iv, MAX_IV_BYTES)
    && isByteArray(message.ct, cap)
    && isByteArray(message.sig, 256);
}

/** Convert arbitrary input to a string and enforce a character limit. */
export function clean(value, max) {
  return String(value ?? '').slice(0, max);
}

export function attachmentsWithinLimits(attachments) {
  if (!Array.isArray(attachments)) return true;
  let videos = 0;
  let other = 0;
  for (const item of attachments) {
    if (item?.kind === 'video') videos++;
    else if (item?.kind === 'photo' || item?.kind === 'file') other++;
  }
  return videos <= LIMITS.videosPerMessage && other <= LIMITS.photosAndFilesPerMessage;
}
