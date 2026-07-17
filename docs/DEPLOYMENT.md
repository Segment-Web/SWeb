# Production deployment

This guide describes the supported deployment with Docker Compose and an existing HTTPS reverse proxy.

## Requirements

- A Linux server with Docker and Docker Compose.
- A domain with HTTPS configured.
- An SMTP provider with a verified sending domain.
- Ports 80 and 443 handled by the host reverse proxy.

## Configuration

Clone the repository, copy `.env.example` to `.env` and configure at least:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
PUBLIC_URL=https://web.example.com
ALLOWED_ORIGINS=https://web.example.com
TRUST_PROXY=1

POSTGRES_PASSWORD=generate-a-long-random-value
DATABASE_URL=postgresql://segment:generate-a-long-random-value@postgres:5432/segment
AUTH_SECRET=generate-another-long-random-value

SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=provider-user
SMTP_PASS=provider-secret
SMTP_FROM=Segment <support@example.com>
```

Generate secrets with `openssl rand -hex 32`. Never commit `.env`.

Optional room and file settings are documented in `.env.example`. The default file store is `/data/files` inside the application container, backed by the persistent `segment_data` volume.

## Start services

```bash
docker compose up -d --build postgres segment
docker compose ps
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
```

The application is published on `127.0.0.1:3000`. Proxy the public HTTPS host to that address and forward WebSocket upgrade headers. `/healthz` reports the process state; `/readyz` also verifies PostgreSQL connectivity and is used by the container health check.

## Updates

Deploy a reviewed release tag rather than a working branch:

```bash
git fetch origin --tags
git checkout --detach v0.0.1
docker compose up -d --build segment
```

Before changing tags, back up the database and file volume. After deployment, verify `/readyz`, email sign-in, a two-client chat, history reload and an attachment download.

## Backups

Back up both persistent volumes and test restoration regularly:

- `postgres_data` contains accounts, sessions, rooms, memberships and encrypted history envelopes.
- `segment_data` contains encrypted attachment blobs.

Restoring only one volume can leave history references without their attachments.

## Capacity

The default configuration allows 2,000 WebSocket connections and uses a 20-connection PostgreSQL pool. These are safety limits, not a performance guarantee. Validate the real VPS with a staged load test before inviting a large audience. Keep a single Segment application process until shared relay and presence coordination is introduced.

See [SCALING.md](SCALING.md) before moving beyond the first server.
