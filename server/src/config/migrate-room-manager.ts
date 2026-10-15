/**
 * Migration: Add room_manager role support
 *
 * This script updates the users table to allow the 'room_manager' role.
 * In SQLite, we need to recreate the table to change CHECK constraints.
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '../../data/conference_rooms.db');

async function migrate() {
  console.log('Starting room_manager role migration...');
  console.log('Database path:', dbPath);

  const db = new Database(dbPath);

  try {
    // Disable foreign key checks during migration
    db.exec('PRAGMA foreign_keys = OFF');

    // Start a transaction
    db.exec('BEGIN TRANSACTION');

    // Create a new users table with the updated CHECK constraint
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

    // Copy all existing data
    db.exec(`
      INSERT INTO users_new (id, email, password_hash, name, role, department, is_active, no_show_count, suspension_until, created_at, updated_at)
      SELECT id, email, password_hash, name, role, department, is_active, no_show_count, suspension_until, created_at, updated_at
      FROM users
    `);

    // Drop the old table
    db.exec('DROP TABLE users');

    // Rename the new table
    db.exec('ALTER TABLE users_new RENAME TO users');

    // Recreate the index
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');

    // Commit the transaction
    db.exec('COMMIT');

    // Re-enable foreign key checks
    db.exec('PRAGMA foreign_keys = ON');

    console.log('Migration completed successfully!');
    console.log('The room_manager role is now available.');

    // Verify the migration
    const result = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as any;
    console.log('\nUpdated table schema:');
    console.log(result.sql);

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
