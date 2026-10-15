import db from './database';
import { runMigrations } from './migrations';

export const ensureDatabase = async () => {
  const autoMigrate = String(process.env.AUTO_MIGRATE || '').toLowerCase() === 'true';
  if (!autoMigrate) return;
  runMigrations(db);
  console.log('✅ Database migrations completed successfully');
};
