import assert from 'assert';
import { groupMatches } from '../src/services/directoryAuth.service';
import { createPinnedWebhookLookup, isAllowedPrivateWebhookAddress, isBlockedWebhookAddress, normalizeWebhookOrigin, validateWebhookUrl } from '../src/utils/webhookSecurity';

assert.equal(groupMatches('CN=Resy-Admins,OU=Groups,DC=example,DC=com', 'Resy-Admins'), true);
assert.equal(groupMatches('CN=Resy-Admins-Old,OU=Groups,DC=example,DC=com', 'Resy-Admins'), false);
assert.equal(
  groupMatches('CN=Resy-Admins,OU=Groups,DC=example,DC=com', 'CN=Resy-Admins,OU=Groups,DC=example,DC=com'),
  true,
);
assert.equal(
  groupMatches('CN=Resy-Admins,OU=Other,DC=example,DC=com', 'CN=Resy-Admins,OU=Groups,DC=example,DC=com'),
  false,
);

for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
  assert.equal(isBlockedWebhookAddress(address), true, `${address} must be blocked`);
}
for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
  assert.equal(isBlockedWebhookAddress(address), false, `${address} must be allowed`);
}

for (const address of ['10.1.2.3', '172.16.0.1', '192.168.1.1', 'fd00::1']) {
  assert.equal(isAllowedPrivateWebhookAddress(address), true, `${address} must be eligible for explicit allowlisting`);
}
for (const address of ['127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', '8.8.8.8']) {
  assert.equal(isAllowedPrivateWebhookAddress(address), false, `${address} must never be treated as allowlist-eligible private space`);
}

assert.equal(normalizeWebhookOrigin('http://192.168.1.20:3000'), 'http://192.168.1.20:3000');
assert.throws(() => normalizeWebhookOrigin('http://192.168.1.20:3000/hooks/token'));

const pinnedLookup = createPinnedWebhookLookup('192.168.1.20');
pinnedLookup('rocket.internal', {}, (error: Error | null, address: string, family: number) => {
  assert.equal(error, null);
  assert.equal(address, '192.168.1.20');
  assert.equal(family, 4);
});
pinnedLookup('rocket.internal', { all: true }, (error: Error | null, addresses: { address: string; family: number }[]) => {
  assert.equal(error, null);
  assert.deepEqual(addresses, [{ address: '192.168.1.20', family: 4 }]);
});
assert.throws(() => createPinnedWebhookLookup('not-an-ip'));

(async () => {
  const policy = {
    allowInternalDestinations: true,
    allowedInternalOrigins: ['http://192.168.1.20:3000'],
  };
  assert.equal((await validateWebhookUrl('http://192.168.1.20:3000/hooks/token', policy)).valid, true);
  assert.equal((await validateWebhookUrl('http://192.168.1.21:3000/hooks/token', policy)).valid, false);
  assert.equal((await validateWebhookUrl('http://169.254.169.254/latest/meta-data', {
    allowInternalDestinations: true,
    allowedInternalOrigins: ['http://169.254.169.254'],
  })).valid, false);
  console.log('Integration security smoke tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
