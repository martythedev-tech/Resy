# Resy

Resy is a full-stack conference room booking application with calendar scheduling, room policies, approvals, reporting, and administrative controls.

## Features

- JWT authentication and optional LDAP/Active Directory authentication
- Building, room, technology, and business-hours management
- Booking rules, approvals, recurring bookings, holidays, and maintenance blocks
- Check-in, no-show, attendance, utilization, and CSV reporting
- Administrator diagnostics with sanitized operational events
- Email and webhook notifications
- Configurable booking-history retention and anonymization
- Local-build and published-image Docker deployment paths

## Requirements

Node.js 24 is the canonical development and production runtime. CI also tests Node.js 22.13.x and 26.x. The supported engine range is `>=22.13 <23 || >=24 <25 || >=26 <27`.

Run `nvm use` to select Node 24. Install dependencies again after changing Node majors because the API uses a native SQLite module.

## Quick Start

```bash
npm install
cd server && npm install && cd ..

cp server/.env.example server/.env
# Set JWT_SECRET and any other required values.

cd server
npm run migrate
npm run seed
npm run dev
```

In a second terminal:

```bash
npm run dev
```

## Docker

For a local source build:

```bash
export JWT_SECRET='<set-a-strong-random-secret>'
docker compose up -d --build
```

Optional host-port overrides:

```bash
RESY_WEB_PORT=13000 RESY_API_PORT=15000 docker compose up -d --build
```

For registry-based deployments using versioned `resy-web` and `resy-api` images, see [`docs/deployment.md`](docs/deployment.md) and [`docs/admin-docker-runbook.md`](docs/admin-docker-runbook.md). The deployment wrapper performs a fail-closed persistent-volume preflight before changing containers.

Existing installations that used the earlier project identifiers should follow [`docs/migrating-to-v3.md`](docs/migrating-to-v3.md) before starting Resy v3.

## Authentication and Security

- No fixed or default passwords are stored in the repository.
- First-login administrator bootstrap is disabled by default.
- Optional default-administrator bootstrap requires an explicit email and password in the runtime environment.
- The Docker API port binds to `127.0.0.1` by default; browser traffic goes through the web container.
- Directory bind passwords are encrypted in SQLite using a key derived from `JWT_SECRET`; restores must retain the same secret.
- Webhook destinations are subject to scheme, redirect, IP-range, and administrator-managed allowlist controls.

See [`SECURITY.md`](SECURITY.md) to report a vulnerability privately.

## LDAP / Active Directory

Directory authentication supports Active Directory and generic LDAP with direct TLS or StartTLS. Configure it with the `DIRECTORY_*` variables documented in [`server/.env.example`](server/.env.example), or through **Administration → Directory**.

If `DIRECTORY_ALLOWED_GROUPS` is set, only users in an exact matching CN or DN may sign in. `DIRECTORY_ADMIN_GROUPS` and `DIRECTORY_ROOM_MANAGER_GROUPS` control synchronized roles. For environment variables, separate multiple full DNs with semicolons.

For a private certificate authority, place PEM/CRT/CER certificates in `docker/certs/` and keep `DIRECTORY_TLS_REJECT_UNAUTHORIZED=true`.

## Development Checks

```bash
npm run lint
npm run build

cd server
npm run build
npm run test:integration-security
```

Run the authenticated API smoke test against a running instance:

```bash
python3 scripts/smoke-api.py \
  --base http://127.0.0.1:5000 \
  --email <admin-email> \
  --password '<admin-password>'
```

Run the read-only supply-chain scan:

```bash
npm run security:check:supply-chain
```

To include a remote host that you administer:

```bash
bash scripts/check-supply-chain-host.sh <user@host>
```

## Documentation

- [Deployment guide](docs/deployment.md)
- [Administrator Docker runbook](docs/admin-docker-runbook.md)
- [Migration to Resy v3](docs/migrating-to-v3.md)
- [API setup](server/README.md)
- [Changelog](CHANGELOG.md)

## License

Resy is available under the permissive [MIT License](LICENSE). Anyone may use,
copy, modify, publish, distribute, sublicense, or sell the software, including
for commercial purposes, provided the copyright and license notice is retained.
