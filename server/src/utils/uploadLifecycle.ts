import fs from 'fs/promises';
import path from 'path';
import { getUploadsDir } from '../config/paths';
import { recordOperationalWarning } from '../services/diagnostics.service';

const MANAGED_UPLOAD = /^\/uploads\/(buildings|rooms|branding)\/([^/]+)$/;

export async function removeManagedUpload(url: unknown): Promise<void> {
  if (typeof url !== 'string') return;
  const match = url.match(MANAGED_UPLOAD);
  if (!match) return;

  const root = path.resolve(getUploadsDir());
  const target = path.resolve(root, match[1], path.basename(match[2]));
  if (!target.startsWith(`${root}${path.sep}`)) return;
  try {
    await fs.unlink(target);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      recordOperationalWarning({
        source: 'uploads',
        category: 'cleanup',
        message: 'Failed to remove a replaced managed upload',
        metadata: { upload_type: match[1] },
      }, error);
    }
  }
}

export async function removeUploadedFile(file: any): Promise<void> {
  if (!file?.path) return;
  const root = path.resolve(getUploadsDir());
  const target = path.resolve(String(file.path));
  if (!target.startsWith(`${root}${path.sep}`)) return;
  try {
    await fs.unlink(target);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      recordOperationalWarning({
        source: 'uploads',
        category: 'cleanup',
        message: 'Failed to remove an orphaned managed upload',
      }, error);
    }
  }
}
