/**
 * Migration: Remove manager role (map to room_manager)
 *
 * Rebuilds users table CHECK constraint to only allow user/admin/room_manager,
 * and maps any existing 'manager' rows to 'room_manager'.
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '../../data/conference_rooms.db');

async function migrate() {
  console.log('Starting manager role removal migration...');
  console.log('Database path:', dbPath);

  const db = new Database(dbPath);

  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'room_manager')),
        department TEXT,
        is_active INTEGER DEFAULT 1,
        no_show_count INTEGER DEFAULT 0,
        suspension_until DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      INSERT INTO users_new (id, email, password_hash, name, role, department, is_active, no_show_count, suspension_until, created_at, updated_at)
      SELECT
        id,
        email,
        password_hash,
        name,
        CASE WHEN role = 'manager' THEN 'room_manager' ELSE role END,
        department,
        is_active,
        no_show_count,
        suspension_until,
        created_at,
        updated_at
      FROM users
    `);

    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    console.log('Migration completed successfully!');
    console.log('manager role removed; users mapped to room_manager.');
  } catch (error) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    console.error('Migration failed:', error);
    throw error;
  } finally {
    db.close();
  }
}

migrate().catch(console.error);
