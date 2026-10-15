import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '../../data/conference_rooms.db');
const db = new Database(dbPath);

console.log('Running timezone migration...');

// Check if timezone column exists
const tableInfo = db.prepare("PRAGMA table_info(site_config)").all() as any[];
const hasTimezone = tableInfo.some((col: any) => col.name === 'timezone');

if (hasTimezone) {
  console.log('Timezone column already exists in site_config table.');
} else {
  console.log('Adding timezone column to site_config table...');
  db.exec(`ALTER TABLE site_config ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Chicago'`);
  console.log('Timezone column added successfully.');
}

db.close();
console.log('Migration complete.');
