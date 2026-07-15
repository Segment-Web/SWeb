# Persistence and rooms

Status: implemented in `v0.0.1`.

## Room model

PostgreSQL stores first-class rooms and their access rules:

- `channel` rooms can be public and resolved through `/c/<slug>`.
- `chat` and `dm` rooms are private and membership-scoped.
- Owners can create invitation links; `/j/<token>` redeems server-side membership.
- `/@<username>` resolves a public account profile.
- Public seeded rooms are available to every authenticated account.

The WebSocket relay checks room membership before forwarding encrypted messages, typing events or key-sharing requests. An owner deleting a private room removes its stored history; a non-owner leaving removes only their membership.

## Encrypted history

The server assigns a monotonically increasing sequence to opaque encrypted envelopes. Each client event has a stable identifier, so retrying the same event returns the original sequence instead of creating a duplicate.

History is paginated and replayed by the client after reload or reconnect. Messages, edits, reactions, poll votes, pins, receipts and deletions use the same durable event stream.

Private rooms default to history from the member's join point. The owner can irreversibly enable full history for all members. Clearing history records a per-member cutoff and does not delete other members' history.

## History keys

Private-room history uses a symmetric key held by authorized clients, never by the server. The key survives same-device reloads in local client storage. Other authorized devices can receive it through an encrypted direct session. Private invitation URLs carry it in the fragment (`#k=...`), which browsers do not send to the web server.

Public channels use a durable public history key. The channel owner publishes the key, while seeded public rooms receive one during server initialization. Public channel content is therefore persistent and readable without server-side plaintext storage.

There is currently no offline recovery-key service. A fresh device needs an online room member or a private invitation containing the history key.

## File storage

The browser encrypts attachment bytes before upload. The server stores opaque, content-addressed blobs on the persistent application volume and returns a reference used by encrypted message history. Identical ciphertext uploads are deduplicated by digest; plaintext equality is not exposed because encryption uses fresh nonces.

`FILE_TTL_MS=0` keeps blobs indefinitely. Operators may set a retention period, but must understand that expired blobs make old attachment references unavailable. Database and file-volume backups must be restored together.

## Trust boundary

The server can authorize accounts, route rooms, order ciphertext and store encrypted data. It cannot decrypt private message bodies or attachment contents, but it still observes metadata including membership, timing, IP addresses and payload sizes.
