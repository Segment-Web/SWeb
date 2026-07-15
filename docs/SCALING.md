# Scaling

This document defines the supported first-stage topology and the work required beyond it. User counts alone do not determine capacity: concurrent WebSocket connections, messages per second, media throughput and reconnect storms matter more than registered accounts.

## Current target

`v0.0.1` uses one Segment application process, one PostgreSQL instance and one persistent file volume. The configuration is prepared for up to 2,000 WebSocket connections so a deployment can be load-tested around 1,000 concurrent clients without first changing an artificial 500-connection ceiling.

This is not a guarantee that every 2-core, 4 GB VPS will sustain 1,000 active users. Measure CPU, event-loop delay, PostgreSQL latency, outbound bandwidth and disk usage with realistic traffic before opening access.

## Protections already implemented

- A bounded PostgreSQL pool with connection and idle timeouts.
- Indexed session, login-code, registration-token, membership, invitation and history access paths.
- Atomic per-room history counters for concurrent senders.
- Stable event identifiers and idempotent history retries.
- Streamed uploads and downloads instead of buffering entire files in server memory.
- Per-account upload rate limits and per-connection message limits.
- WebSocket backpressure checks, heartbeat cleanup and bounded payload sizes.
- Coalesced presence updates to avoid reconnect storms broadcasting a full roster for every individual connection.
- Separate liveness and PostgreSQL readiness endpoints.
- Container health checks, persistent volumes and documented two-volume backups.
- A frozen pnpm lockfile, delayed adoption of newly published dependencies and an explicit build-script allowlist.
- CI validation on every push and pull request.

## Recommended first production topology

```text
Cloudflare -> Nginx or Caddy -> one Segment container
                                  |-> PostgreSQL
                                  |-> persistent encrypted blob volume
```

Keep PostgreSQL private, expose only the reverse proxy, and monitor disk space. Configure `DATABASE_POOL_MAX` below PostgreSQL's available connection budget. The default of 20 leaves room for administration and maintenance on a small single-instance deployment.

## Before horizontal scaling

Do not start a second Segment application process yet. Room membership caches, connection routing, rate limits and presence are process-local. Multiple independent processes would give incomplete rosters and could fail to deliver direct key exchanges.

Before adding replicas:

1. Move presence, connection routing and rate-limit state to Redis or another shared low-latency store.
2. Add Redis Streams, NATS or PostgreSQL-backed pub/sub for cross-process WebSocket delivery.
3. Replace startup DDL with ordered database migrations.
4. Put PgBouncer in front of PostgreSQL and budget the total pool across every replica.
5. Move encrypted blobs from the VPS volume to S3-compatible object storage such as Cloudflare R2.
6. Store avatars in object storage instead of PostgreSQL rows.
7. Move email delivery and other slow tasks to a retryable job queue.
8. Add Prometheus-compatible metrics, centralized logs and alerts for latency, errors, reconnect rate, pool saturation and disk usage.
9. Version and fingerprint static assets so a CDN can cache them safely.

## Growth checkpoints

### Up to roughly 1,000 concurrent clients

- Keep one application process.
- Load-test reconnect storms as well as steady messaging.
- Watch PostgreSQL query latency and pool wait time.
- Enforce disk alerts and daily backups.
- Move media to object storage early if uploads dominate disk or bandwidth.

### Beyond one application process

- Complete every item in the horizontal-scaling list first.
- Use sticky WebSocket routing only as a temporary aid, not as a substitute for shared state.
- Run failure tests that restart one replica while messages and key exchanges are in flight.

### Large history tables

The `(room_id, seq)` primary key already supports ordered pagination. Consider time-based retention, archival and table partitioning only after query plans and production measurements justify them. Premature partitioning adds operational complexity without helping a small database.
