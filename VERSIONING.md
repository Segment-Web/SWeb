# Segment versioning

Segment uses `MAJOR.MINOR.PATCH`, with optional pre-release identifiers such as `0.0.1-beta`.

- `MAJOR` changes only on an explicit instruction from the project owner.
- `MINOR` changes only on an explicit instruction from the project owner.
- `PATCH` changes only when a release is explicitly prepared.
- Ordinary commits do not change the product version.

Increasing `MINOR` resets `PATCH` to zero. Increasing `MAJOR` resets both remaining components to zero.

The current version must match in `VERSION`, the root `package.json`, every workspace package and `pnpm-lock.yaml`. Each published release receives a matching changelog entry and Git tag such as `v0.0.1`.
