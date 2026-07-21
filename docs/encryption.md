# Segment Secure Layer

Segment Secure Layer is an experimental end-to-end encryption protocol built with standard WebCrypto primitives.

> This implementation has not received an independent security audit. Do not treat it as production-grade cryptography.

## Goals

- Keep plaintext private messages and attachments away from the server.
- Provide forward secrecy for live message chains.
- Provide post-compromise recovery through a Double Ratchet design.
- Support asynchronous session setup with signed and one-time prekeys.
- Preserve encrypted room history across reloads and authorized devices.

## Primitives

- AES-256-GCM for authenticated encryption.
- ECDH P-256 for classical key agreement.
- ECDSA P-256 for signed prekeys.
- HKDF-SHA-256 for root, chain and message-key derivation.

No custom cryptographic primitive is implemented.

## Direct sessions

Each device creates a persistent, non-extractable WebCrypto identity key, a signed prekey and one-time prekeys. The authenticated service pins a device's first identity bundle, limits an account to five active devices and refuses silent replacement for the same device identifier. Users can list and revoke cryptographic devices; revocation closes an active relay connection and prevents that device identifier from registering again. One-time prekeys are reconciled and replenished by the owning device after reconnect, including when consumption happened while it was offline, and their issue is rate-limited per requester/target pair. Clients keep encrypted first-seen device sets per account, refuse an unexpected key replacement and warn when a known account presents a new device. The initiator verifies the signed prekey and the responder rejects an X3DH identity that does not match the pinned peer bundle. Direct peer sessions then use root and chain keys. Every message advances its sending chain, direction changes mix in a new ECDH result, and skipped keys support bounded out-of-order delivery.

## Live room messages

Each sending device owns a distinct sender-key chain and ECDSA signing key for every room and membership epoch. A sender key is delivered over an encrypted direct session only to peers that the server currently recognizes as members of that room. Every ciphertext signs and authenticates the room identifier, epoch, sender identifier, message counter, nonce and ciphertext. The same context is AES-GCM additional authenticated data, so transplanting ciphertext between rooms or epochs fails in the cryptographic layer.

Adding or removing a member advances a persisted room epoch. Every remaining online sender replaces that room's chain; the relay rejects stale-epoch ciphertext and key shares. A removed member is also instructed to erase its local room keys. Sender-key receivers reject replays and excessive counter gaps.

## Durable history

Each room has a separate AES-256-GCM history key. Clients encrypt durable events before storing opaque `{ roomId, seq, eventId, iv, ct }` envelopes on the server. Stable event identifiers make retries idempotent.

Private-room history keys are stored on the device and shared with another currently authorized device through an encrypted direct session. Invitation links do not contain room keys. Membership changes rotate the current history key outside the old room cipher, and history writes tagged with a stale membership epoch are rejected. A newly signed-in device needs an online authorized member; there is no server-held recovery key.

Public channels intentionally expose a durable public history key so any visitor can decrypt public posts. This does not weaken private-room key handling, but public channel history must not be considered confidential.

## Attachments

Clients encrypt files before upload and store only opaque ciphertext in the server file store. A new upload receives a random 256-bit bearer capability which is carried, together with the file key, only inside the encrypted message envelope. Physical SHA-256 identifiers remain private storage details and cannot download a new blob. Deleting an attachment revokes its capability; blobs with no remaining capabilities are collected. Uploads count against a per-account storage quota. A temporary, rate-limited legacy migration path accepts old hash references only from the owner of a private room during the migration grace period. The server can observe blob sizes and access timing but not plaintext file contents.

## Server visibility

The server observes accounts, public prekeys, room identifiers, membership, IP addresses, timing, typing events, encrypted-history sizes and encrypted-attachment sizes. TLS/HTTPS remains required in addition to end-to-end encryption.

## Current limitations

- No independent security audit.
- A basic per-device safety-number view is available from a peer profile, but there is no verified-contact state or key-transparency log yet.
- No key-transparency service. TOFU does not protect first contact from an actively malicious service substituting public identity bundles.
- No offline encrypted key backup or recovery flow.
- No complete multi-device account key-management model.
- This is not an implementation of MLS (RFC 9420), and it does not claim MLS security guarantees.
- No real post-quantum KEM; the test KEM validates integration plumbing only.

## Testing

Run:

```bash
pnpm check
```

The suite covers direct sessions, room-and-epoch-scoped sender keys, membership removal, stale-epoch rejection, sender-key replay/skip limits, signed-prekey validation, Double Ratchet direction changes, out-of-order delivery, encrypted history replay, attachment encryption and reliable retry behavior.
