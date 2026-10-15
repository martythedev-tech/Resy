import db from './database';

const DEFAULT_EQUIPMENT = [
  'Computer Hookup',
  'Jitsi',
  'Zoom',
  'Whiteboard',
  'Projector',
  'Conference Phone',
  'Screen Sharing',
];

function hasColumn(table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return rows.some(r => r.name === column);
  } catch {
    return false;
  }
}

function migrate() {
  try {
    if (!hasColumn('site_config', 'equipment_options')) {
      db.exec('ALTER TABLE site_config ADD COLUMN equipment_options TEXT DEFAULT NULL');
    }

    const row = db.prepare('SELECT equipment_options FROM site_config WHERE id = 1').get() as any;
    if (!row) {
      db.prepare(
        `INSERT INTO site_config (id, company_name, primary_color, timezone, equipment_options)
         VALUES (1, 'Resy', '#4F46E5', 'America/Chicago', ?)`
      ).run(JSON.stringify(DEFAULT_EQUIPMENT));
    } else if (!row.equipment_options) {
      db.prepare('UPDATE site_config SET equipment_options = ? WHERE id = 1').run(
        JSON.stringify(DEFAULT_EQUIPMENT)
      );
    }

    console.log('✅ Equipment options migration complete');
  } catch (error) {
    console.error('❌ Equipment options migration failed:', error);
    process.exit(1);
  }
}

migrate();
