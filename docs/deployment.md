# Deployment Guide

This guide covers source and published-image deployments of Resy. For a concise operations checklist, see [`admin-docker-runbook.md`](admin-docker-runbook.md). Existing installations using legacy names must complete [`migrating-to-v3.md`](migrating-to-v3.md) first.

## Requirements

- Node.js 24.x for the canonical source runtime
- npm
- Linux or macOS for source deployments
- Docker with Compose v2 for container deployments

Source compatibility is tested on Node.js 22.13.x, 24.x, and 26.x. Do not reuse `node_modules` between Node major versions; run `npm ci` in both the repository root and `server/` after switching.

## Runtime Configuration

`JWT_SECRET` is required. Generate a strong random value, store it outside the repository, and retain it with database backups. It also protects encrypted Directory credentials.

Common optional settings include:

- `APP_BASE_URL`, `PUBLIC_APP_URL`, and `CORS_ORIGIN`
- `DATA_DIR`, `UPLOADS_DIR`, and `DB_PATH`
- `RESY_WEB_PORT`, `RESY_API_PORT`, and `RESY_API_BIND`
- `ENABLE_DIRECTORY_AUTH` and the `DIRECTORY_*` settings
- `DIAGNOSTIC_RETENTION_DAYS`

See [`../server/.env.example`](../server/.env.example) for the complete API configuration. The API host port binds to `127.0.0.1` by default.

## Source Deployment

```bash
npm ci
npm run build

cd server
npm ci
npm run migrate
npm run start
```

Health check:

```bash
curl -sf http://127.0.0.1:5000/api/health
```

## Local Docker Build

```bash
export JWT_SECRET='<set-a-strong-random-secret>'
docker compose up -d --build
docker compose ps
```

Persistent data is stored in the `resy_data` and `resy_uploads` named volumes. Do not use `docker compose down -v` unless permanent deletion is intended.

## Published Images

Tagged releases publish multi-architecture images to:

- `ghcr.io/martythedev-tech/resy-web:<tag>`
- `ghcr.io/martythedev-tech/resy-api:<tag>`

Create an untracked `.env.deploy` file:

```dotenv
COMPOSE_PROJECT_NAME=resy
RESY_IMAGE_TAG=v3.0.0
JWT_SECRET=<set-a-strong-random-secret>
APP_BASE_URL=https://resy.example.com
PUBLIC_APP_URL=https://resy.example.com
CORS_ORIGIN=https://resy.example.com
```

For a verified first installation:

```bash
./scripts/deploy-published.sh --env-file .env.deploy --first-install
```

For an update or rollback, change only `RESY_IMAGE_TAG` to an immutable version already tested in your environment, then run:

```bash
./scripts/deploy-published.sh --env-file .env.deploy
```

The wrapper validates the Compose configuration, immutable semantic-version tag, project identity, and volume pair before it pulls or recreates containers. A registry login is needed only if the selected package is private.

## Directory TLS

Mount private root/intermediate certificates from `docker/certs/` and set `DIRECTORY_CA_CERT_PATH=/app/certs`. Use `ldaps://` for direct TLS or `ldap://` for StartTLS. Cleartext LDAP requires the explicit and discouraged `DIRECTORY_ALLOW_INSECURE_LDAP=true` override.

## Release Publishing

Pushing a tag matching `v*.*.*` runs `.github/workflows/publish-images.yml`. The workflow builds `linux/amd64` and `linux/arm64` images and publishes a GitHub release containing:

- `resy-<tag>-source.tar.gz`
- `resy-web-<tag>-linux-amd64-docker.tar.gz`
- `resy-api-<tag>-linux-amd64-docker.tar.gz`
- `resy-<tag>-SHA256SUMS.txt`

Before approving a deployment, verify the checksums, take a database and uploads backup, confirm the resolved image tags, run migrations, check SQLite integrity, exercise authentication and booking flows, and verify persistence after a controlled restart.

## Release Build Metadata

```bash
npm run build:release
# or
npm run build:release -- 3.0.0
```

This sets `VITE_APP_VERSION`, `VITE_RELEASE_CHANNEL=release`, and a Git-based build identifier.
