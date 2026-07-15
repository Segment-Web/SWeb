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

Every durable client event has a stable identifier. The server acknowledges stored events, and the client retries unacknowledged work without creating duplicate history entries.

Per-room history sequence numbers are allocated through an atomic PostgreSQL counter. Concurrent senders therefore do not contend on `MAX(seq)` scans or generate duplicate sequence numbers.

## Rooms and history

PostgreSQL is authoritative for accounts, sessions, rooms, memberships, invitations and ordered encrypted history envelopes. The WebSocket relay delivers room traffic only to authorized members. HTTP history pagination provides reload and reconnect recovery.

Clients encrypt durable room updates with a per-room history key before upload. Private-room keys are shared between authorized clients through encrypted direct sessions or carried in the URL fragment of a private invitation. Public channels publish a durable public history key because their content is intentionally readable by any visitor.

## Attachments

Clients encrypt attachment bytes before upload. The server stores opaque blobs in the persistent `segment_data` volume and returns content-addressed references. Message history contains only encrypted metadata and blob references; clients fetch and decrypt bytes when rendering media or documents.

## Panel workspace

A panel implements `{ id, title, mount(body), weight? }` and registers with the panel registry. The workspace stores a split tree rather than a fixed grid. Dropping a panel on an edge creates a split, dropping it in the center swaps panels, and dividers resize adjacent panels.

## Server trust boundary

The server never needs plaintext private message bodies or plaintext attachment bytes. It does authenticate users and observe transport metadata, room identifiers, membership, IP addresses, timing and typing events. Segment must not be described as metadata-private.

The encryption protocol is unaudited. See [docs/encryption.md](docs/encryption.md) for the implemented key model and current limitations.

The current runtime is intentionally a single application process. It is sized for the first deployment stage; horizontal scaling requires shared presence and relay coordination. See [docs/SCALING.md](docs/SCALING.md).
