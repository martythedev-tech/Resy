import db from './database';
import { runMigrations } from './migrations';

try {
  console.log('🔄 Running database migrations...');
  runMigrations(db);
  console.log('✅ Database migrations completed successfully!');
  process.exit(0);
} catch (error) {
  console.error('❌ Migration failed:', error);
  process.exit(1);
}
