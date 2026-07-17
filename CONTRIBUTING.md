# Contributing

Contributions to Segment are welcome.

## Reporting issues

Use the repository issue forms instead of opening a blank issue:

- **Bug report** for reproducible errors or unexpected behavior.
- **Feature request** for one focused improvement or new capability.
- **Question or support** when the behavior is unclear and may not be a bug.

Search open and closed issues before submitting. Keep one problem or request per issue and include screenshots or a short recording when they clarify the report. Never post passwords, one-time codes, access tokens, private messages, or personal data.

Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/Segment-Web/SWeb/security/advisories/new).

Maintainers use labels to show the issue type, affected area, current state, and priority. Labels such as `confirmed`, `priority: high`, and `area: messaging` are assigned during triage; reporters do not need to choose them.

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

## Releases and versioning

Segment uses `MAJOR.MINOR.PATCH`, with optional pre-release identifiers such as `0.0.1-beta`.

- `MAJOR` and `MINOR` change only on an explicit instruction from the project owner.
- `PATCH` changes only when a release is explicitly prepared.
- Ordinary commits do not change the product version.

Increasing `MINOR` resets `PATCH` to zero. Increasing `MAJOR` resets both remaining components to zero.

The current version must match in `VERSION`, the root `package.json` and every workspace package. Each published release receives a changelog entry and a matching Git tag such as `v0.0.3`.
