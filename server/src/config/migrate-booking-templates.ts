/**
 * Migration: Add booking_templates table
 */
import db from './database';

function tableExists(table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as any;
  return !!row;
}

function migrate() {
  console.log('Starting booking templates migration...');

  if (!tableExists('booking_templates')) {
    db.prepare(`
      CREATE TABLE booking_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        duration_minutes INTEGER DEFAULT 60,
        equipment TEXT,
        notes TEXT,
        custom_fields TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    console.log('Created booking_templates table.');
  }
}

try {
  migrate();
  console.log('Booking templates migration complete.');
} catch (err) {
  console.error('Booking templates migration failed:', err);
  process.exit(1);
}
