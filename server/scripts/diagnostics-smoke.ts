import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resy-diagnostics-'));
process.env.DB_PATH = path.join(root, 'diagnostics.db');
process.env.JWT_SECRET = 'diagnostics-smoke-secret';

(async () => {
  const [{ default: db }, { runMigrations }, diagnostics] = await Promise.all([
    import('../src/config/database'),
    import('../src/config/migrations'),
    import('../src/services/diagnostics.service'),
  ]);
  runMigrations(db);

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    diagnostics.recordOperationalWarning({
      source: 'scheduler',
      category: 'configuration',
      message: 'Test warning',
      metadata: { retry_minutes: 60, password: 'must-not-persist' },
    });
    diagnostics.recordOperationalError({
      source: 'email',
      category: 'delivery',
      message: 'Test delivery error',
      metadata: { event: 'booking_created', booking_id: 42 },
    }, {
      name: 'NetworkError',
      code: 'ECONNREFUSED',
      message: 'credential-bearing provider message must not persist',
      stack: 'credential-bearing stack must not persist',
    });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  const rows = db.prepare(
    'SELECT severity, source, category, message, metadata FROM diagnostic_events ORDER BY id'
  ).all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].severity, 'warning');
  assert.equal(rows[0].source, 'scheduler');
  assert.deepEqual(JSON.parse(rows[0].metadata), { retry_minutes: 60 });
  assert.equal(rows[1].severity, 'error');
  assert.equal(rows[1].source, 'email');
  const errorMetadata = JSON.parse(rows[1].metadata);
  assert.equal(errorMetadata.booking_id, 42);
  assert.equal(errorMetadata.error_name, 'NetworkError');
  assert.equal(errorMetadata.error_code, 'ECONNREFUSED');
  assert.equal(JSON.stringify(errorMetadata).includes('credential-bearing'), false);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('Diagnostics smoke tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
