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

Each sender owns a sender-key chain for group traffic. Sender-key state is delivered only through encrypted direct sessions. Membership-scoped relay checks prevent non-members from receiving private-room frames.

## Durable history

Each room has a separate AES-256-GCM history key. Clients encrypt durable events before storing opaque `{ roomId, seq, eventId, iv, ct }` envelopes on the server. Stable event identifiers make retries idempotent.

Private-room history keys are stored on the device and shared with another authorized device through an encrypted direct session. Private invitation links place the key in the URL fragment, which is not sent in HTTP requests. A newly signed-in device still needs an online authorized member or an invitation containing the key; there is no server-held recovery key.

Public channels intentionally expose a durable public history key so any visitor can decrypt public posts. This does not weaken private-room key handling, but public channel history must not be considered confidential.

## Attachments

Clients encrypt files before upload and store only opaque ciphertext in the server file store. The message envelope contains the encrypted file reference and key material needed by authorized clients. The server can observe blob sizes and access timing but not plaintext file contents.

## Server visibility

The server observes accounts, public prekeys, room identifiers, membership, IP addresses, timing, typing events, encrypted-history sizes and encrypted-attachment sizes. TLS/HTTPS remains required in addition to end-to-end encryption.

## Current limitations

- No independent security audit.
- No user-facing key verification or safety-number interface.
- No offline encrypted key backup or recovery flow.
- No complete multi-device account key-management model.
- No real post-quantum KEM; the test KEM validates integration plumbing only.

## Testing

Run:

```bash
pnpm check
```

The suite covers direct sessions, sender keys, signed-prekey validation, Double Ratchet direction changes, out-of-order delivery, room-scoped relay, encrypted history replay, attachment encryption and reliable retry behavior.
