# Architecture

Segment is a small npm-workspaces monorepo organized into four layers.

```text
apps/web
   ↓ commands / ↑ updates
packages/core
   ↓ shared types
packages/protocol

apps/server ← WebSocket → packages/core
packages/crypto is used by the client core
```

## Packages

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Platform-independent message types, rooms, limits and protocol version. |
| `packages/core` | Connection lifecycle, client state, update events and encryption handshake. No DOM dependency. |
| `packages/crypto` | Segment Secure Layer: the experimental E2EE implementation. |
| `apps/server` | Static file delivery, account API and blind WebSocket ciphertext relay. |
| `apps/web` | Thin browser UI built from independent panels. |

Node resolves shared packages through npm workspaces. The browser resolves the same source files through the import map in `apps/web/public/index.html`; the server exposes them under `/shared/`.

## Core API

`@segment/core` exposes an event-based client. Important events include `connection`, `identity`, `status`, `chats`, `room`, `append` and `typing`. The UI issues commands such as `connect`, `openRoom`, `send` and `notifyTyping`.

Platform storage is injected through an adapter, allowing future clients to reuse the core without depending on browser APIs.

## Panel workspace

A panel implements `{ id, title, mount(body), weight? }` and registers with the panel registry. The workspace stores a split tree rather than a fixed grid. Dropping a panel on an edge creates a split; dropping it in the center swaps panels. Dividers resize adjacent panels in both directions.

This registry is the foundation for future user-installed modifications. Extensions that change shared chat behavior will also require protocol-level capability negotiation.

## Server trust boundary

The server authenticates accounts, serves public prekeys and relays encrypted envelopes. It does not receive plaintext chat messages. It still sees transport metadata and must not be described as metadata-private.

The current server does not persist message history. A future storage layer must store encrypted envelopes only and must define safe replay and key-rotation behavior before being enabled.
