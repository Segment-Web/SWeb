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

Each account publishes an identity key, a signed prekey and one-time prekeys. The initiator verifies the signed prekey, consumes a one-time prekey and derives an X3DH-style shared secret. Direct peer sessions then use root and chain keys. Every message advances its sending chain, direction changes mix in a new ECDH result, and skipped keys support limited out-of-order delivery.

## Live room messages

Each sending device owns a distinct sender-key chain for every room and membership epoch. A sender key is delivered over an encrypted direct session only to peers that the server currently recognizes as members of that room. The encrypted payload binds the room identifier and epoch, and the receiver verifies both against the outer relay frame.

Adding or removing a member advances a persisted room epoch. Every remaining online sender replaces that room's chain; the relay rejects stale-epoch ciphertext and key shares. A removed member is also instructed to erase its local room keys. Sender-key receivers reject replays and excessive counter gaps.

## Durable history

Each room has a separate AES-256-GCM history key. Clients encrypt durable events before storing opaque `{ roomId, seq, eventId, iv, ct }` envelopes on the server. Stable event identifiers make retries idempotent.

Private-room history keys are stored on the device and shared with another currently authorized device through an encrypted direct session. Invitation links do not contain room keys. Membership changes rotate the current history key outside the old room cipher, and history writes tagged with a stale membership epoch are rejected. A newly signed-in device needs an online authorized member; there is no server-held recovery key.

Public channels intentionally expose a durable public history key so any visitor can decrypt public posts. This does not weaken private-room key handling, but public channel history must not be considered confidential.

## Attachments

Clients encrypt files before upload and store only opaque ciphertext in the server file store. The message envelope contains the encrypted file reference and key material needed by authorized clients. The server can observe blob sizes and access timing but not plaintext file contents.

## Server visibility

The server observes accounts, public prekeys, room identifiers, membership, IP addresses, timing, typing events, encrypted-history sizes and encrypted-attachment sizes. TLS/HTTPS remains required in addition to end-to-end encryption.

## Current limitations

- No independent security audit.
- No user-facing key verification or safety-number interface.
- No key-transparency service. Until identity verification exists, the design does not protect against an actively malicious service substituting public identity bundles.
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
