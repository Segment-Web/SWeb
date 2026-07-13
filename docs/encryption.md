# Segment Secure Layer

Segment Secure Layer is an experimental end-to-end encryption protocol built with standard WebCrypto primitives.

> This is a working prototype and has not received an independent security audit. Do not treat it as production-grade cryptography.

## Goals

- Keep plaintext messages away from the relay server.
- Provide a reusable browser and Node implementation.
- Provide forward secrecy for message chains.
- Provide post-compromise recovery through a Double Ratchet design.
- Support asynchronous session setup with signed and one-time prekeys.

## Primitives

- AES-256-GCM for authenticated encryption.
- ECDH P-256 for classical key agreement.
- ECDSA P-256 for signed prekeys.
- HKDF-SHA-256 for root, chain and message-key derivation.

No custom cryptographic primitive is implemented.

## Session setup

Each account publishes an identity key, a signed prekey and a set of one-time prekeys. The initiator verifies the signed prekey, consumes one one-time prekey and derives an X3DH-style shared secret. The first encrypted message carries the public handshake header required by the recipient.

## Double Ratchet

Direct peer channels use root and chain keys. Every message advances its sending chain. Direction changes mix in a new ECDH result. Skipped message keys allow limited out-of-order delivery.

## Group messages

Each sender owns a sender-key chain. Sender-key state is shared only through encrypted direct sessions. Membership changes rotate room key material so a removed participant cannot decrypt future messages.

## Post-quantum extension point

The code defines an optional KEM interface for a future hybrid handshake. No real ML-KEM implementation is currently bundled because WebCrypto does not expose one. The mock KEM used by the self-test validates integration plumbing only and provides no security.

## Server visibility

The relay receives encrypted envelopes rather than plaintext message bodies. It still observes account, room, membership, IP, timing and typing metadata. Authentication and public prekey records are also server-side.

## Current limitations

- No independent audit.
- No persisted server-side message history.
- No multi-device key model.
- No recovery or key-verification interface.
- No real post-quantum KEM.

## Testing

Run:

```bash
npm run check
```

The self-test covers direct sessions, sender keys, X3DH-style setup, Double Ratchet direction changes, out-of-order messages, signed-prekey rejection and hybrid KEM plumbing.
