# Segment

Segment is an extensible open-source messenger with a panel-based interface and end-to-end encryption.

Current release: **0.0.1-beta** · [Changelog](CHANGELOG.md) · [Versioning](VERSIONING.md)

## Features

- Real-time messaging over WebSocket.
- Email sign-in with one-time codes.
- PostgreSQL-backed accounts and sessions.
- Independent panels that can be moved, resized and rearranged.
- Photo, video, voice message, attachment and pinned-message interfaces.
- An experimental end-to-end encryption layer based on WebCrypto.

The public web client currently supports desktop browsers only.

## Repository layout

```text
packages/protocol  Shared message types, rooms and limits
packages/core      Platform-independent client state and connection logic
packages/crypto    Segment Secure Layer encryption prototype
apps/server        HTTP server and WebSocket ciphertext relay
apps/web           Browser client
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and package boundaries.

## Local development

Requirements:

- Node.js 22.13 or later
- PostgreSQL

```bash
npm install
cp .env.example .env
npm start
```

Open <http://localhost:3000>.

Run the encryption self-test with:

```bash
npm run check
```

## Production deployment

The supported early-beta deployment uses Docker Compose, PostgreSQL and an external HTTPS reverse proxy. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Security status

The encryption layer is a working prototype, not an audited production protocol. The server relays ciphertext but can still observe metadata such as participants, rooms and timing. Message history is not currently persisted on the server.

See [docs/encryption.md](docs/encryption.md) and [SECURITY.md](SECURITY.md).

## License and trademarks

The source code is licensed under [GNU AGPL-3.0-only](LICENSE). The Segment name, logo and visual identity are covered separately by [TRADEMARKS.md](TRADEMARKS.md).

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
