import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getUploadsDir } from '../config/paths';

const uploadsDir = getUploadsDir();

// Ensure upload directories exist
['buildings', 'rooms', 'branding'].forEach(dir => {
  fs.mkdirSync(path.join(uploadsDir, dir), { recursive: true });
});

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Determine subdirectory from route
    let subdir = 'rooms';
    if (req.path.includes('buildings')) subdir = 'buildings';
    else if (req.path.includes('logo') || req.path.includes('site-config')) subdir = 'branding';
    cb(null, path.join(uploadsDir, subdir));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (req: any, file: any, cb: any) => {
  // Validate both extension AND MIME type to prevent file type spoofing
  const isFavicon = req.path.includes('favicon');
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (isFavicon) {
    allowedExtensions.push('.ico');
    allowedMimeTypes.push('image/x-icon', 'image/vnd.microsoft.icon');
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype.toLowerCase();

  if (allowedExtensions.includes(ext) && allowedMimeTypes.includes(mime)) {
    cb(null, true);
  } else {
    const formats = isFavicon ? 'ico, jpg, png, gif, webp' : 'jpg, png, gif, webp';
    cb(new Error(`Only image files allowed (${formats}). Invalid file type detected.`));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
