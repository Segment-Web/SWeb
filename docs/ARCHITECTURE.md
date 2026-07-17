# Architecture

Segment is a pnpm workspace split into a browser UI, reusable client core, shared protocol and cryptography packages, and a Node.js server.

```text
apps/web -> packages/core -> packages/protocol
                  |
                  +-> packages/crypto
                  |
                  +-> HTTP and WebSocket -> apps/server -> PostgreSQL
                                                     |
                                                     +-> encrypted blob storage
```

## Packages

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Platform-independent message types, rooms, limits and protocol validation. |
| `packages/core` | Connection lifecycle, client state, reliable delivery, history synchronization and encryption orchestration. |
| `packages/crypto` | Segment Secure Layer direct sessions, sender keys and history/file encryption helpers. |
| `apps/server` | Static delivery, authentication, room membership, encrypted history, encrypted files and WebSocket relay. |
| `apps/web` | Desktop browser UI built from independent panels. |

Node resolves shared packages through the pnpm workspace. The browser resolves the same sources through the import map in `apps/web/public/index.html`; the server exposes them under `/shared/`.

## Client core

`@segment/core` exposes an event-based client used by the browser UI. It owns connection state, the reliable outbox, room state, encrypted history backfill, attachment transport and update application. Platform storage is supplied through an adapter so future clients can reuse the core without browser dependencies.

Every durable client event has a stable identifier. The server acknowledges stored events, and the client retries unacknowledged work without creating duplicate history entries. Per-room history sequence numbers are allocated through an atomic PostgreSQL counter.

## Rooms and access

PostgreSQL stores accounts, sessions, rooms, memberships, invitations and ordered encrypted history envelopes.

- Public channels resolve through `/c/<slug>`.
- Private chats and direct messages are membership-scoped.
- Owners can create invitation links; `/j/<token>` redeems membership.
- `/@<username>` resolves a public account profile.
- Deleting an owned private room removes its stored history; leaving a room removes only that membership.

The WebSocket relay checks membership before forwarding encrypted messages, typing events or key-sharing requests.

## Encrypted history

The server assigns a monotonically increasing sequence to opaque encrypted envelopes. Stable event identifiers make retries idempotent. History is paginated and replayed after reload or reconnect; messages, edits, reactions, poll votes, pins, receipts and deletions use the same durable stream.

Private rooms default to history from a member's join point. Owners can enable full history for all members. Clearing history records a per-member cutoff without deleting history for other members.

Private-room history keys stay with authorized clients. They survive same-device reloads in local storage and can be shared through an encrypted direct session. Private invitation URLs carry the key in the URL fragment, which browsers do not send to the server. Public channels use a durable public history key because their content is intentionally readable.

There is currently no offline recovery-key service. A fresh device needs an online room member or a private invitation containing the history key.

## Attachments

Clients encrypt attachment bytes before upload. The server stores opaque, content-addressed blobs on the persistent application volume and returns references used by encrypted message history. Database and file-volume backups must be restored together.

`FILE_TTL_MS=0` keeps blobs indefinitely. Configuring retention can make old attachment references unavailable.

## Panel workspace

A panel implements `{ id, title, mount(body), weight? }` and registers with the panel registry. The workspace stores a split tree rather than a fixed grid. Edge drops create splits, center drops swap panels and dividers resize adjacent panels.

## Trust boundary

The server does not need plaintext private message bodies or attachment bytes. It authenticates users and can observe metadata including room membership, IP addresses, timing, typing events and payload sizes. Segment must not be described as metadata-private.

The encryption protocol is unaudited. See [encryption.md](encryption.md) for the implemented key model and current limitations.

The current runtime uses one application process. Horizontal scaling requires shared presence and relay coordination. See [SCALING.md](SCALING.md).
