import db from './database';

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
    if (!hasColumn('users', 'must_reset_password')) {
      db.exec('ALTER TABLE users ADD COLUMN must_reset_password INTEGER DEFAULT 0');
      db.exec('UPDATE users SET must_reset_password = 0 WHERE must_reset_password IS NULL');
    }

    console.log('✅ Password reset migration complete');
  } catch (error) {
    console.error('❌ Password reset migration failed:', error);
    process.exit(1);
  }
}

migrate();
