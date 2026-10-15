import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resy-uploads-'));
process.env.UPLOADS_DIR = root;

(async () => {
  const { removeManagedUpload, removeUploadedFile } = await import('../src/utils/uploadLifecycle');
  const brandingDir = path.join(root, 'branding');
  fs.mkdirSync(brandingDir, { recursive: true });
  const replaced = path.join(brandingDir, 'replaced.png');
  fs.writeFileSync(replaced, 'test');
  await removeManagedUpload('/uploads/branding/replaced.png');
  assert.equal(fs.existsSync(replaced), false);

  const orphan = path.join(brandingDir, 'orphan.png');
  fs.writeFileSync(orphan, 'test');
  await removeUploadedFile({ path: orphan });
  assert.equal(fs.existsSync(orphan), false);

  const outside = path.join(os.tmpdir(), `resy-outside-${process.pid}.png`);
  fs.writeFileSync(outside, 'keep');
  await removeUploadedFile({ path: outside });
  assert.equal(fs.existsSync(outside), true);
  fs.rmSync(outside, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log('Upload lifecycle smoke tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
