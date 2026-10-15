import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

type SqliteDatabase = Database.Database;

const APPLICATION_TABLES = [
  'users', 'buildings', 'rooms', 'booking_rules', 'holidays', 'maintenance_windows',
  'bookings', 'booking_templates', 'booking_recurrence', 'check_ins', 'webhook_configs',
  'email_config', 'site_config', 'diagnostic_events',
  'directory_config',
  'webhook_security_config',
];

function hasTable(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as any[]).some(row => row.name === column);
}

function addColumn(db: SqliteDatabase, table: string, column: string, definition: string) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
}

function addReportViewerRole(db: SqliteDatabase) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql?: string } | undefined;
  if (table?.sql?.includes("'report_viewer'")) return;

  db.exec(`
    CREATE TABLE users_with_report_viewer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'room_manager', 'report_viewer')),
      department TEXT,
      is_active INTEGER DEFAULT 1,
      directory_role_locked INTEGER DEFAULT 0,
      receives_admin_notifications INTEGER DEFAULT 1,
      must_reset_password INTEGER DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      no_show_count INTEGER DEFAULT 0,
      suspension_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users_with_report_viewer (
      id, email, password_hash, name, role, department, is_active,
      directory_role_locked, receives_admin_notifications, must_reset_password,
      token_version, no_show_count, suspension_until, created_at, updated_at
    )
    SELECT
      id, email, password_hash, name, role, department, is_active,
      directory_role_locked, receives_admin_notifications, must_reset_password,
      token_version, no_show_count, suspension_until, created_at, updated_at
    FROM users;
    DROP TABLE users;
    ALTER TABLE users_with_report_viewer RENAME TO users;
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
}

function initializeSchema(db: SqliteDatabase) {
  const existing = APPLICATION_TABLES.filter(table => hasTable(db, table));
  if (existing.length > 0 && !hasTable(db, 'users')) {
    throw new Error(`Database is partially initialized (found ${existing.join(', ')} without users); restore a backup before migrating`);
  }
  if (hasTable(db, 'users')) return;

  const schemaPath = path.join(__dirname, 'schema-sqlite.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8').replace(/^\s*DROP TABLE IF EXISTS\s+[^;]+;\s*$/gim, '');
  db.transaction(() => db.exec(schema))();
}

function legacyCompatibility(db: SqliteDatabase) {
  addColumn(db, 'users', 'receives_admin_notifications', 'INTEGER DEFAULT 1');
  addColumn(db, 'users', 'directory_role_locked', 'INTEGER DEFAULT 0');
  addColumn(db, 'site_config', 'calendar_default_view', "TEXT NOT NULL DEFAULT 'day'");
  addColumn(db, 'site_config', 'accent_color', "TEXT NOT NULL DEFAULT '#14B8A6'");
  addColumn(db, 'site_config', 'brand_tagline', "TEXT NOT NULL DEFAULT 'Room booking'");
  addColumn(db, 'site_config', 'logo_size', "TEXT NOT NULL DEFAULT 'medium'");
  addColumn(db, 'site_config', 'booking_retention_months', 'INTEGER NOT NULL DEFAULT 36');
  addColumn(db, 'site_config', 'booking_retention_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'site_config', 'backup_retention_days', 'INTEGER NOT NULL DEFAULT 90');
  addColumn(db, 'bookings', 'anonymized_at', 'DATETIME');
  addColumn(db, 'bookings', 'retention_hold', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'bookings', 'attendee_count', 'INTEGER CHECK (attendee_count IS NULL OR (attendee_count >= 0 AND attendee_count <= 100000 AND CAST(attendee_count AS INTEGER) = attendee_count))');

  db.exec(`
    UPDATE users SET receives_admin_notifications = 1 WHERE receives_admin_notifications IS NULL;
    UPDATE users SET directory_role_locked = 0 WHERE directory_role_locked IS NULL;
    UPDATE site_config SET calendar_default_view = 'day'
      WHERE calendar_default_view IS NULL OR calendar_default_view NOT IN ('day','week','month');
    UPDATE site_config SET logo_size = 'medium'
      WHERE logo_size IS NULL OR logo_size NOT IN ('small','medium','large');
    UPDATE bookings SET attendee_count = CAST(json_extract(custom_fields, '$.attendee_count') AS INTEGER)
      WHERE attendee_count IS NULL AND custom_fields IS NOT NULL AND json_valid(custom_fields) = 1
        AND CASE WHEN json_valid(custom_fields) = 1 THEN json_type(custom_fields, '$.attendee_count') END IN ('integer', 'real')
        AND CASE WHEN json_valid(custom_fields) = 1 THEN CAST(json_extract(custom_fields, '$.attendee_count') AS INTEGER) = json_extract(custom_fields, '$.attendee_count') ELSE 0 END
        AND CASE WHEN json_valid(custom_fields) = 1 THEN json_extract(custom_fields, '$.attendee_count') BETWEEN 0 AND 100000 ELSE 0 END;
    DELETE FROM check_ins WHERE id NOT IN (SELECT MIN(id) FROM check_ins GROUP BY booking_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_check_ins_booking_unique ON check_ins(booking_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_retention ON bookings(end_time, anonymized_at, retention_hold);
    CREATE TABLE IF NOT EXISTS diagnostic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      request_id TEXT,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      user_id INTEGER,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_diagnostic_events_created_at ON diagnostic_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_diagnostic_events_severity ON diagnostic_events(severity);
    CREATE INDEX IF NOT EXISTS idx_diagnostic_events_source ON diagnostic_events(source);
  `);
}

interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
  requiresForeignKeysOff?: boolean;
}

const migrations: Migration[] = [
  { version: 1, name: 'legacy_compatibility', up: legacyCompatibility },
  {
    version: 2,
    name: 'session_and_job_state',
    up: db => {
      addColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
  {
    version: 3,
    name: 'application_managed_directory_config',
    up: db => {
      db.exec(`CREATE TABLE IF NOT EXISTS directory_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_enabled INTEGER NOT NULL DEFAULT 0,
        directory_type TEXT NOT NULL DEFAULT 'ad' CHECK (directory_type IN ('ad', 'ldap')),
        server_url TEXT NOT NULL DEFAULT '',
        base_dn TEXT NOT NULL DEFAULT '',
        bind_dn TEXT NOT NULL DEFAULT '',
        bind_password_encrypted TEXT NOT NULL DEFAULT '',
        ca_cert_path TEXT NOT NULL DEFAULT '/app/certs',
        tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1,
        allow_insecure_ldap INTEGER NOT NULL DEFAULT 0,
        allow_local_fallback INTEGER NOT NULL DEFAULT 1,
        sync_roles INTEGER NOT NULL DEFAULT 1,
        sync_profile INTEGER NOT NULL DEFAULT 1,
        allowed_groups TEXT NOT NULL DEFAULT '[]',
        admin_groups TEXT NOT NULL DEFAULT '[]',
        room_manager_groups TEXT NOT NULL DEFAULT '[]',
        timeout_ms INTEGER NOT NULL DEFAULT 8000,
        connect_timeout_ms INTEGER NOT NULL DEFAULT 5000,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
  {
    version: 4,
    name: 'application_managed_webhook_security',
    up: db => {
      db.exec(`CREATE TABLE IF NOT EXISTS webhook_security_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        allow_internal_destinations INTEGER NOT NULL DEFAULT 0,
        allowed_internal_origins TEXT NOT NULL DEFAULT '[]',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
  {
    version: 5,
    name: 'report_viewer_role',
    requiresForeignKeysOff: true,
    up: addReportViewerRole,
  },
  {
    version: 6,
    name: 'booking_department_snapshot',
    up: db => {
      addColumn(db, 'bookings', 'organizer_department', 'TEXT');
      db.exec(`
        UPDATE bookings
           SET organizer_department = (
             SELECT department FROM users WHERE users.id = bookings.user_id
           )
         WHERE user_id IS NOT NULL
      `);
    },
  },
];

export function runMigrations(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  initializeSchema(db);

  for (const migration of migrations) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)) continue;
    const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) === 1;
    if (migration.requiresForeignKeysOff && foreignKeysEnabled) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        migration.up(db);
        const foreignKeyViolations = db.pragma('foreign_key_check') as any[];
        if (foreignKeyViolations.length) {
          throw new Error(`Database migration ${migration.version} introduced foreign key violations`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      })();
    } finally {
      if (migration.requiresForeignKeysOff && foreignKeysEnabled) db.pragma('foreign_keys = ON');
    }
  }

  const missing = APPLICATION_TABLES.filter(table => !hasTable(db, table));
  if (missing.length) throw new Error(`Database migration verification failed; missing tables: ${missing.join(', ')}`);
  if (!hasColumn(db, 'users', 'token_version')) throw new Error('Database migration verification failed; users.token_version is missing');
  if (!hasTable(db, 'service_state')) throw new Error('Database migration verification failed; service_state is missing');
  if (!hasTable(db, 'directory_config')) throw new Error('Database migration verification failed; directory_config is missing');
  if (!hasTable(db, 'webhook_security_config')) throw new Error('Database migration verification failed; webhook_security_config is missing');
  if (!hasColumn(db, 'bookings', 'organizer_department')) throw new Error('Database migration verification failed; bookings.organizer_department is missing');
}
