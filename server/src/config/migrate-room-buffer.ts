/**
 * Migration: Add per-room buffer minutes
 * - Adds rooms.buffer_minutes column if missing
 * - Sets default to 15 minutes for existing rows
 */
import db from './database';

function columnExists(table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return info.some(col => col.name === column);
}

function migrate() {
  console.log('Starting room buffer migration...');

  if (!columnExists('rooms', 'buffer_minutes')) {
    db.prepare('ALTER TABLE rooms ADD COLUMN buffer_minutes INTEGER DEFAULT 15').run();
    console.log('Added rooms.buffer_minutes column.');
  }

  db.prepare('UPDATE rooms SET buffer_minutes = 15 WHERE buffer_minutes IS NULL').run();
  console.log('Room buffer defaults applied (15 minutes).');
}

try {
  migrate();
  console.log('Room buffer migration complete.');
} catch (err) {
  console.error('Room buffer migration failed:', err);
  process.exit(1);
}
