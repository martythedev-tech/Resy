import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/config/migrations';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resy-migrations-'));
try {
  const fresh = new Database(path.join(tempDir, 'fresh.db'));
  runMigrations(fresh);
  fresh.prepare("INSERT INTO users (email, password_hash, name) VALUES ('fresh@example.com', 'hash', 'Fresh User')").run();
  runMigrations(fresh);
  assert.equal((fresh.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count, 1);
  assert.deepEqual(
    fresh.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row: any) => row.version),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok((fresh.prepare('PRAGMA table_info(bookings)').all() as any[]).some(column => column.name === 'organizer_department'));
  fresh.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('reports@example.com', 'hash', 'Reports User', 'report_viewer')").run();
  assert.throws(() => fresh.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('invalid@example.com', 'hash', 'Invalid User', 'invalid')").run());
  fresh.close();

  const legacy = new Database(path.join(tempDir, 'legacy.db'));
  legacy.pragma('foreign_keys = ON');
  const schemaPath = path.join(__dirname, '../src/config/schema-sqlite.sql');
  const legacySchema = fs.readFileSync(schemaPath, 'utf8')
    .replace(/^\s*DROP TABLE IF EXISTS\s+[^;]+;\s*$/gim, '')
    .replace("CHECK (role IN ('user', 'admin', 'room_manager', 'report_viewer'))", "CHECK (role IN ('user', 'admin', 'room_manager'))")
    .replace(/^\s*token_version[^\n]*\n/m, '')
    .replace(/^\s*organizer_department[^\n]*\n/m, '')
    .replace(/\n-- Durable checkpoints for background services\nCREATE TABLE IF NOT EXISTS service_state \([\s\S]*?\n\);\n/, '\n')
    .replace(/\n-- Optional application-managed directory configuration\.[\s\S]*?\n\);\n/, '\n');
  legacy.exec(legacySchema);
  legacy.prepare("INSERT INTO users (email, password_hash, name, department) VALUES ('legacy@example.com', 'hash', 'Legacy User', 'Legacy Operations')").run();
  legacy.prepare("UPDATE users SET directory_role_locked = 1, receives_admin_notifications = 0, must_reset_password = 1 WHERE email = 'legacy@example.com'").run();
  const userId = Number((legacy.prepare("SELECT id FROM users WHERE email = 'legacy@example.com'").get() as any).id);
  legacy.prepare("INSERT INTO buildings (name) VALUES ('Legacy Building')").run();
  legacy.prepare("INSERT INTO rooms (name, building, floor, capacity) VALUES ('Legacy Room', 'Legacy Building', 1, 8)").run();
  const roomId = Number((legacy.prepare("SELECT id FROM rooms WHERE name = 'Legacy Room'").get() as any).id);
  legacy.prepare("INSERT INTO bookings (room_id, user_id, title, start_time, end_time) VALUES (?, ?, 'Preserve Me', '2026-10-01T15:00:00.000Z', '2026-10-01T16:00:00.000Z')").run(roomId, userId);

  runMigrations(legacy);
  assert.equal((legacy.prepare("SELECT COUNT(*) AS count FROM bookings WHERE title = 'Preserve Me'").get() as any).count, 1);
  assert.equal((legacy.prepare("SELECT organizer_department FROM bookings WHERE title = 'Preserve Me'").get() as any).organizer_department, 'Legacy Operations');
  legacy.prepare("UPDATE users SET department = 'New Department' WHERE id = ?").run(userId);
  assert.equal((legacy.prepare("SELECT organizer_department FROM bookings WHERE title = 'Preserve Me'").get() as any).organizer_department, 'Legacy Operations');
  assert.equal((legacy.prepare("SELECT token_version FROM users WHERE email = 'legacy@example.com'").get() as any).token_version, 0);
  const preservedUser = legacy.prepare("SELECT directory_role_locked, receives_admin_notifications, must_reset_password FROM users WHERE email = 'legacy@example.com'").get() as any;
  assert.deepEqual(preservedUser, { directory_role_locked: 1, receives_admin_notifications: 0, must_reset_password: 1 });
  legacy.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('legacy-reports@example.com', 'hash', 'Legacy Reports User', 'report_viewer')").run();
  assert.equal((legacy.prepare('PRAGMA foreign_key_check').all() as any[]).length, 0);
  assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'service_state'").get());
  assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'directory_config'").get());
  assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM directory_config').get() as any).count, 0);
  assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_security_config'").get());
  assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM webhook_security_config').get() as any).count, 0);
  legacy.close();
  console.log('Migration smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
