# Production deployment

This guide describes the supported early-beta deployment with Docker Compose and an existing HTTPS reverse proxy.

## Requirements

- A Linux server with Docker and Docker Compose.
- A domain with HTTPS configured.
- An SMTP provider and verified sending domain.
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
SMTP_FROM=noreply@example.com
```

Generate secrets with `openssl rand -hex 32`. Never commit `.env`.

## Start services

```bash
docker compose up -d --build postgres segment
docker compose ps
curl http://127.0.0.1:3000/healthz
```

The application binds to `127.0.0.1:3000`. Proxy the public HTTPS host to that address and forward WebSocket upgrade headers.

## Updates

Deploy a reviewed release tag rather than an unreviewed working branch:

```bash
git fetch origin --tags
git checkout --detach v0.0.1-beta
docker compose up -d --build segment
```

Verify `/healthz`, email sign-in and a two-client chat after each deployment.

## Backups

Back up the PostgreSQL volume regularly and test restoration. The database stores accounts and sessions. Message history is not currently persisted by the server.
