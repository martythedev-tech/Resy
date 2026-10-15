import assert from 'node:assert/strict';
import fs from 'node:fs';
import db from '../src/config/database';
import { runMigrations } from '../src/config/migrations';
import { directoryAuthService } from '../src/services/directoryAuth.service';

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('DB_PATH is required for the isolated directory configuration smoke test');

try {
  runMigrations(db);
  directoryAuthService.clearStoredConfig();

  process.env.ENABLE_DIRECTORY_AUTH = 'true';
  process.env.DIRECTORY_TYPE = 'ad';
  process.env.DIRECTORY_URL = 'ldaps://environment.example.com:636';
  process.env.DIRECTORY_BASE_DN = 'DC=example,DC=com';
  process.env.DIRECTORY_BIND_DN = 'CN=Environment Bind,OU=Service Accounts,DC=example,DC=com';
  process.env.DIRECTORY_BIND_PASSWORD = 'environment-secret';
  process.env.DIRECTORY_ADMIN_GROUPS = 'CN=Resy-Admins,OU=Groups,DC=example,DC=com';

  assert.equal(directoryAuthService.getConfigSource(), 'environment');
  const environmentConfig = directoryAuthService.getConfig();
  assert.equal(environmentConfig.url, 'ldaps://environment.example.com:636');
  assert.deepEqual(environmentConfig.adminGroups, ['CN=Resy-Admins,OU=Groups,DC=example,DC=com']);

  const applicationConfig = directoryAuthService.buildConfig({
    enabled: false,
    directory_type: 'ad',
    server_url: 'ldaps://application.example.com:636',
    base_dn: 'DC=application,DC=example,DC=com',
    bind_dn: 'CN=Resy Bind,OU=Service Accounts,DC=application,DC=example,DC=com',
    bind_password: 'application-secret',
    allowed_groups: 'Resy-Users',
    admin_groups: 'CN=Resy-Admins,OU=Groups,DC=application,DC=example,DC=com',
    room_manager_groups: 'Resy-Room-Managers\nResy-Facilities',
  });
  directoryAuthService.saveConfig(applicationConfig);

  assert.equal(directoryAuthService.getConfigSource(), 'application');
  const stored = db.prepare('SELECT bind_password_encrypted FROM directory_config WHERE id = 1').get() as any;
  assert.ok(stored.bind_password_encrypted.startsWith('v1:'));
  assert.equal(stored.bind_password_encrypted.includes('application-secret'), false);

  const restored = directoryAuthService.getConfig();
  assert.equal(restored.bindPassword, 'application-secret');
  assert.deepEqual(restored.roomManagerGroups, ['Resy-Room-Managers', 'Resy-Facilities']);

  const passwordPreservingUpdate = directoryAuthService.buildConfig({
    ...applicationConfig,
    bind_password: '',
    base_dn: 'DC=updated,DC=example,DC=com',
  });
  directoryAuthService.saveConfig(passwordPreservingUpdate);
  assert.equal(directoryAuthService.getConfig().bindPassword, 'application-secret');
  assert.equal(directoryAuthService.getConfig().baseDn, 'DC=updated,DC=example,DC=com');

  directoryAuthService.clearStoredConfig();
  assert.equal(directoryAuthService.getConfigSource(), 'environment');
  assert.equal(directoryAuthService.getConfig().bindPassword, 'environment-secret');

  console.log('Directory configuration regression checks passed');
} finally {
  db.close();
  fs.rmSync(dbPath, { force: true });
}
