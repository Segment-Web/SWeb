# Persistence, rooms and key management design

Status: draft / decision record. No production behaviour depends on this document
yet. It exists because both "save message history" and "real channels/chats with
membership" require a deliberate key-management design before any ciphertext is
stored or any relay is scoped per room. The current invariant is explicit:

> Do not add naive offline ciphertext replay. Current sender-key and session
> regeneration requires a deliberate replay/key design first.

## 1. Why the two features share one problem

Segment is end-to-end encrypted. The server never sees plaintext. Group rooms use
**per-sender sender keys**; direct sessions use X3DH + a Double Ratchet. Today a
single global sender key is regenerated whenever any participant leaves
(`SegmentClient._onPeerLeft`). Two consequences:

1. **History cannot be replayed naively.** A returning or new device has fresh
   keys and cannot decrypt ciphertext produced under a previous sender key. Storing
   envelopes on the server does not make them readable again.
2. **Per-room membership changes the key model.** Once a room is a real entity with
   its own member set, the sender key must rotate per room on that room's
   membership changes, not globally. Otherwise a member of room A rotating on leave
   silently breaks room B.

So the storage question ("where do bytes live") is secondary. The primary question
is **which key decrypts a given envelope, and how does an authorised device obtain
that key**.

## 2. Key model options for history

### Option B1 — per-room history key, escrowed to members
- Each room has a symmetric `historyKey` (AES-256-GCM) known only to current
  members, distinct from the live sender/ratchet keys.
- On send, the client additionally encrypts the message body to `historyKey` and
  uploads that envelope to the server for storage.
- On join / new device, the client obtains `historyKey` from another online member
  over the existing authenticated pairwise ratchet (the same channel already used
  for `KeyShare`).
- Rotation: on member removal, rotate `historyKey`; older history stays readable to
  members who held the previous key, new members see only history from their join
  point forward (forward-secrecy-friendly default).
- Server stores opaque `{roomId, seq, iv, ct}` and never holds `historyKey`.

Trade-off: requires at least one online member (or an offline escrow, see B3) for a
brand-new device to bootstrap history.

### Option B2 — device-local only (no server history)
- No server storage. Each device keeps its own decrypted history in IndexedDB.
- Zero key work, zero server cost, server stays fully blind.
- No multi-device sync; cache clear loses history.
- Recommended as the immediate UX win while B1 is built.

### Option B3 — key backup ("recovery key")
- User holds a high-entropy recovery secret (shown once, à la Signal PIN / Element
  key backup). `historyKey`s are wrapped under a key derived from it and stored
  server-side as opaque blobs.
- Lets a new device with no online peers restore history.
- Adds a real recovery UX and the risk surface of a server-side (encrypted) backup.
- Defer until after B1.

## 3. Recommended sequence

1. **B2 now** — device-local history. Independent of everything below.
2. **Rooms as entities** — membership, invites, links (does not require reading
   plaintext; see §4). Ships without touching the sender-key crypto by keeping the
   relay membership-scoped but otherwise unchanged.
3. **Per-room sender-key rotation** — move rotation from global to per-room on that
   room's membership events. Gated by this document.
4. **B1** — per-room `historyKey` + server envelope store.
5. **B3** — optional recovery backup.

## 4. Rooms as entities — what does NOT need the key design

Making channels/chats first-class does not require the server to read plaintext:

- `rooms(id, type, slug, title, owner_id, created_at)` — a `channel` is public and
  discoverable by slug; a `chat` / `dm` is private and reached by invite.
- `room_members(room_id, user_id, role, joined_at)` — authoritative membership.
- `room_invites(token_hash, room_id, expires_at, max_uses, uses)` — invite links.
- The relay filters `Cipher` / `Typing` delivery to sockets whose user is a member
  of `message.room`, instead of broadcasting to everyone joined.

This is safe to ship first and is the prerequisite for links. The only crypto-
sensitive follow-up is step 3 (per-room rotation), which this document gates.

## 5. Link scheme

- `/@<username>` — user profile. `username` is already unique.
- `/c/<slug>` — public channel.
- `/j/<token>` — one invite redemption into a private chat/dm/channel.

Resolution is a server endpoint returning the target entity (or 404). Links never
carry secrets in query strings; the invite token is a path segment redeemed via
POST, then discarded client-side.

## 6. File storage

Chosen interim: **VPS disk** behind an authenticated endpoint, storing opaque
client-encrypted blobs. Constraints and future migration (Cloudflare R2, presigned
uploads, content-hash dedup, TTL expiry) are tracked in `PROJECT_CONTEXT.local.md`.
Because bodies are client-encrypted, the store is a blind blob bucket regardless of
backend, so moving disk → R2 later is a backend swap, not a protocol change.
