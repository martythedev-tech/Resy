# Administrator Docker Runbook

Use an immutable version tag for every deployment. This makes updates and rollbacks repeatable and prevents different administrators from unknowingly testing different builds.

Existing installations that used legacy image, environment, Compose, or volume names must follow [`migrating-to-v3.md`](migrating-to-v3.md) before starting Resy v3.

## First Installation

1. Install Docker Engine with Compose v2.
2. Obtain the tagged source archive or check out the release tag.
3. Create `.env.deploy` outside version control:

```dotenv
COMPOSE_PROJECT_NAME=resy
RESY_IMAGE_TAG=v3.0.0
JWT_SECRET=<set-a-strong-random-secret>
APP_BASE_URL=https://resy.example.com
PUBLIC_APP_URL=https://resy.example.com
CORS_ORIGIN=https://resy.example.com
```

4. Run the guarded first-install path:

```bash
./scripts/deploy-published.sh --env-file .env.deploy --first-install
```

The default persistent volumes are `resy_resy_data` and `resy_resy_uploads`. The repeated name is the normal Compose `<project>_<volume>` format. Never add `-v` to a stop/down command unless permanent data deletion is intended.

## Update

1. Back up the SQLite database and uploads volume.
2. Verify that the backup is readable.
3. Change only `RESY_IMAGE_TAG` in `.env.deploy`.
4. Run:

```bash
./scripts/deploy-published.sh --env-file .env.deploy
```

5. Complete the acceptance checks below.

The preflight refuses an update if the expected volume pair is missing, incomplete, or inconsistent with the active API container.

## Rollback

Set `RESY_IMAGE_TAG` to the previously tested immutable version and rerun the deployment wrapper. If a release introduced an incompatible schema change, restore the matching database and uploads backup before starting the older images.

## Operational Checks

```bash
docker compose --env-file .env.deploy -f docker-compose.deploy.yml ps
docker compose --env-file .env.deploy -f docker-compose.deploy.yml config --images
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs --tail=200 api web
curl -fsS http://127.0.0.1:5000/api/health
```

Expected image names:

- `ghcr.io/martythedev-tech/resy-web:<tag>`
- `ghcr.io/martythedev-tech/resy-api:<tag>`

## Acceptance Checklist

- Both containers are healthy.
- The web application loads through the intended external URL.
- Administrator authentication works.
- Existing buildings, rooms, users, bookings, and settings are present.
- A booking can be created, updated, approved when required, and cancelled.
- Reports and CSV export work for authorized roles.
- Email, webhook, and Directory integrations work if enabled.
- SQLite integrity and foreign-key checks pass.
- Data remains present after a controlled stack restart.

## Directory Group Examples

Use exact CNs or full DNs. Examples:

```dotenv
DIRECTORY_ALLOWED_GROUPS=CN=Resy-Users,OU=Groups,DC=company,DC=com
DIRECTORY_ADMIN_GROUPS=CN=Resy-Admins,OU=Groups,DC=company,DC=com
DIRECTORY_ROOM_MANAGER_GROUPS=CN=Resy-RoomManagers,OU=Groups,DC=company,DC=com
```

Separate multiple full DNs with semicolons. Keep `DIRECTORY_TLS_REJECT_UNAUTHORIZED=true`; mount private CA certificates in `docker/certs/` when needed.

## Reboot Behavior

Set Docker or your service manager to start the Resy stack automatically after reboot. If using systemd, a descriptive local unit name such as `resy-docker.service` is recommended. Confirm both container health and data persistence after testing a restart.
