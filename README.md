# Segment

Segment is an extensible open-source messenger with a panel-based desktop web interface and end-to-end encryption.

Current release: **0.0.5** · [Changelog](CHANGELOG.md) · [Latest release](https://github.com/Segment-Web/SWeb/releases/latest)

## Features

- Real-time messaging over WebSocket with retry and duplicate protection.
- Email sign-in with one-time codes, PostgreSQL-backed accounts and profile setup.
- Persistent chats, channels, encrypted message history and encrypted attachments.
- Private-room invite links and public channel links.
- Encrypted history synchronization between authorized devices.
- Message editing, deletion, reactions, polls, pins, replies and read states.
- Saved Messages with voice messages and video notes.
- Drafts, chat archive and channel view counters.
- Rich-text formatting, spoilers and multi-message selection.
- Photo and video albums, a full-window media viewer and custom video controls.
- Independent panels that can be moved, resized and rearranged.

The public web client currently supports desktop browsers only.

## Repository layout

```text
packages/protocol  Shared message types, rooms and limits
packages/core      Platform-independent client state, sync and connection logic
packages/crypto    Segment Secure Layer encryption implementation
apps/server        Account, room, history and file APIs plus the WebSocket relay
apps/web           Browser client
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package boundaries, rooms and data flow, and [docs/SCALING.md](docs/SCALING.md) for capacity boundaries and the scaling roadmap.

## Local development

Requirements:

- Node.js 22.13 or later
- pnpm 11.13.0 through Corepack
- PostgreSQL

```bash
corepack enable pnpm
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
pnpm start
```

Open <http://localhost:3000>.

Run the complete self-test suite with:

```bash
pnpm check
```

The authentication self-test additionally requires `TEST_DATABASE_URL`:

```bash
TEST_DATABASE_URL=postgresql://segment:segment@localhost:5432/segment_test pnpm test:auth
```

## Production deployment

The supported deployment uses Docker Compose, PostgreSQL, persistent volumes and an HTTPS reverse proxy. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Security status

Segment Secure Layer has not received an independent security audit and must not be treated as production-grade cryptography. The server stores encrypted history envelopes and encrypted attachment blobs, but it can still observe metadata such as accounts, room membership, IP addresses and timing.

See [docs/encryption.md](docs/encryption.md) and [SECURITY.md](SECURITY.md).

## License

The source code is licensed under [GNU AGPL-3.0-only](LICENSE).

Independent modules that interact with Segment solely through its designated
Plugin API may be released under terms of your choice, including proprietary
ones. See the [Segment Plugin Exception](PLUGIN-EXCEPTION.md). The Plugin API
is not published yet, so the exception has no effect until it is.

Themes and comparable data-only assets are not derivative works and need no
exception.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
