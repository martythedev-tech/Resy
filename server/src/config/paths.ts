import path from 'path';

const defaultDataDir = path.resolve(__dirname, '../../data');
const defaultUploadsDir = path.resolve(__dirname, '../../uploads');

export const getDataDir = () => {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : defaultDataDir;
};

export const getDbPath = () => {
  if (process.env.DB_PATH) {
    return path.resolve(process.env.DB_PATH);
  }
  return path.join(getDataDir(), 'conference_rooms.db');
};

export const getUploadsDir = () => {
  return process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : defaultUploadsDir;
};
