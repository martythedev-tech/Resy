# Migrating To Resy v3

Resy v3 standardizes all public identifiers on `resy`. This is a naming migration, not a destructive data reset. Existing SQLite and upload data can be preserved, but Docker will not automatically associate volumes created under an older Compose project with the new names.

## Identifier Changes

| Legacy identifier | Resy v3 identifier |
| --- | --- |
| `crb-web` | `resy-web` |
| `crb-api` | `resy-api` |
| `CRB_*` application variables | `RESY_*` equivalents |
| Compose project `crb-v2` | `resy` |
| Volumes `crb-v2_crb_data` / `crb-v2_crb_uploads` | `resy_resy_data` / `resy_resy_uploads` |

Directory settings such as `DIRECTORY_*`, public URL settings, and `JWT_SECRET` keep their existing names.

## Before Migrating

1. Record the active image tags, Compose project name, volume names, and runtime environment.
2. Back up both the SQLite data volume and uploads volume.
3. Verify the backups are readable.
4. Preserve the existing `JWT_SECRET`; changing it prevents decryption of stored Directory bind credentials and invalidates existing sessions.
5. Stop the old stack without deleting its volumes. Never use `docker compose down -v` during migration.

## Copy Legacy Volumes

The following example copies data into the v3 default volumes. Replace the two source volume names if your installation used a different Compose project name.

```bash
docker volume create resy_resy_data
docker volume create resy_resy_uploads

docker run --rm \
  -v crb-v2_crb_data:/from:ro \
  -v resy_resy_data:/to \
  alpine sh -c 'cd /from && cp -a . /to/'

docker run --rm \
  -v crb-v2_crb_uploads:/from:ro \
  -v resy_resy_uploads:/to \
  alpine sh -c 'cd /from && cp -a . /to/'
```

Do not delete the legacy volumes until the v3 deployment has passed acceptance checks and a fresh backup has been verified.

## Configure And Start v3

Create `.env.deploy` with the new identifiers:

```dotenv
COMPOSE_PROJECT_NAME=resy
RESY_IMAGE_TAG=v3.0.2
JWT_SECRET=<the-existing-secret>
```

`v3.0.2` is the current supported v3 release. Use a newer immutable release tag if one is documented as supported when performing the migration.

Translate any legacy application variables to their `RESY_*` equivalents, then run the normal update path without `--first-install`:

```bash
./scripts/deploy-published.sh --env-file .env.deploy
```

The preflight should find `resy_resy_data` and `resy_resy_uploads` and refuse to proceed if only one exists.

## Validate

Confirm container health, administrator login, existing record counts, booking and approval flows, uploads, reports, enabled integrations, SQLite integrity, and persistence after a controlled restart. Keep the legacy stack stopped but recoverable until this validation and a new backup are complete.

The server retains a narrow startup migration for the former built-in product display name. It does not overwrite an administrator-customized organization or sender name.
