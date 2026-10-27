# Resy API

Backend API for Resy.

The current supported release is `v3.0.2`. See the repository [`CHANGELOG.md`](../CHANGELOG.md) for release details.

## Runtime Support

Node.js 24 is the canonical production and development runtime. Node.js 22.13.x and Node.js 26.x are also exercised by CI for source compatibility. The package engine range is deliberately bounded to `>=22.13 <23 || >=24 <25 || >=26 <27`; no support is implied for other or future major versions.

Run `nvm use` from the repository root to select Node 24. When changing Node majors or architectures, discard the existing `node_modules` and run a clean install because `better-sqlite3` includes a native binding. Released API containers pin Node 24 and do not depend on the host's Node installation.

## Setup

```bash
npm install
cp .env.example .env
# Set JWT_SECRET and other env values
npm run migrate
npm run seed
npm run dev
```

## Notes

- No default passwords are committed in source.
- `npm run seed` creates seed users with runtime-generated passwords (or values from `SEED_*_PASSWORD` env vars).
- Optional default-admin bootstrap requires explicit env configuration:
  - `ENABLE_DEFAULT_ADMIN=true`
  - `DEFAULT_ADMIN_EMAIL=<email>`
  - `DEFAULT_ADMIN_PASSWORD=<strong-password>`
- Legacy first-login bootstrap is disabled by default and can be explicitly enabled:
  - `ENABLE_FIRST_LOGIN_BOOTSTRAP=true`

## Authentication Endpoints

- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/auth/me`
- `PATCH /api/auth/password`

## Health Endpoint

- `GET /api/health`

## Admin Endpoints

- `GET /api/admin/rules`
- `GET /api/admin/buildings`
- `GET /api/admin/rooms`
- `GET /api/admin/users`
- `GET /api/admin/analytics` (administrators, room managers, and Reports Viewers; optional `start_date`, `end_date`, and `room_id` filters)
- `GET /api/admin/directory/status`
- `POST /api/admin/directory/test`
- `GET /api/admin/diagnostics` (full administrators only)
- `GET /api/admin/diagnostics/summary` (full administrators only)
- `GET /api/admin/retention` (full administrators only)
- `PUT /api/admin/retention` (full administrators only)
- `POST /api/admin/retention/run` (full administrators only)
- `PATCH /api/admin/bookings/:id/retention-hold` (full administrators only)

The analytics response is computed from persisted bookings, check-ins, rooms, organizer snapshots, and configured workspace timezone data. Its default planning range spans the previous and next 30 days; custom inclusive ranges may span 1–366 days. Confirmed and no-show reservations contribute to demand totals, while pending and cancelled records remain visible separately. Check-in and no-show rates are `null` when no persisted outcomes exist rather than reporting a misleading zero-percent rate.

Operational diagnostic events are sanitized and retained for 30 days by default. Configure `DIAGNOSTIC_RETENTION_DAYS` to use a different 1–365 day window.

Booking retention defaults to 36 months with automatic anonymization disabled until an administrator confirms a backup and enables it. Daily runs process at most 500 eligible records. Pending, upcoming, anonymized, and held bookings are excluded. The backup-retention value documents external policy; Resy does not delete backup files.
