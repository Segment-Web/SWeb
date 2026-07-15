# Contributing

Contributions to Segment are welcome.

## Setup

1. Fork and clone the repository.
2. Enable the pinned package manager with `corepack enable pnpm && corepack install`.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Copy `.env.example` to `.env` and configure PostgreSQL.
5. Start the project with `pnpm start`.
6. Create a focused branch such as `feature/short-name`.

## Repository areas

- Shared wire formats and limits: `packages/protocol`
- Client state and connection logic: `packages/core`
- Encryption protocol: `packages/crypto`
- Server and WebSocket relay: `apps/server`
- Browser interface: `apps/web/public`

Keep protocol and core code independent from Node-specific and DOM-specific APIs.

## Style

- Use modern JavaScript and ES modules.
- Write all repository text, documentation, comments, commits, pull requests and release notes in English.
- Keep localized user-facing strings in the application localization layer.
- Prefer comments that explain why a decision exists.
- Keep each pull request focused on one feature or fix.
- Include screenshots or recordings for visible interface changes.

Run `pnpm check` before opening a pull request.
