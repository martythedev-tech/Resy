# Changelog

All notable public changes to Resy are documented here.

## 3.0.1 - 2026-10-21

- Added global API rate limiting and strengthened email-address validation.
- Confined Directory CA certificate loading to the configured certificate directory and blocked path traversal and symlink escapes.
- Restricted custom favicon URLs to valid HTTP and HTTPS addresses.
- Published a complete, sanitized backend environment template.
- Updated ten application dependencies, development dependencies, and GitHub Actions, including `express-rate-limit`, `ldapts`, `nodemailer`, `dotenv`, ESLint, and `docker/build-push-action`.
- Added CodeQL scanning and strengthened protected-branch policy; the release has no database migration or configuration-breaking changes.

## 3.0.0 - 2026-10-15

- Published the first clean public Resy source release.
- Licensed Resy under the permissive MIT License for public and commercial reuse.
- Standardized package, container-image, release-asset, environment-variable, Compose-project, and persistent-volume names on `resy`.
- Included room scheduling, approvals, recurring bookings, reporting, Directory authentication, notifications, diagnostics, data retention, and Docker deployment support.
- Added a migration guide for installations using legacy project identifiers.
