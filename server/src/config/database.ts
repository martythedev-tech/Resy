import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import * as fs from 'fs';
import path from 'path';
import { getDbPath } from './paths';

dotenv.config();

const dbPath = getDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode — readers never block writers and vice versa
db.pragma('journal_mode = WAL');
// Retry for up to 5 s on SQLITE_BUSY instead of failing immediately
db.pragma('busy_timeout = 5000');
// Enable foreign keys
db.pragma('foreign_keys = ON');

// Helper to convert PostgreSQL-style $1, $2 to SQLite-style ?, ?
// Handles reused placeholders ($2 appearing multiple times) correctly —
// builds the bound-params array in left-to-right appearance order.
function convertQuery(sql: string, params?: any[]): { sql: string; params: any[] } {
  if (!params || params.length === 0) return { sql, params: [] };

  const orderedParams: any[] = [];
  const convertedSql = sql.replace(/\$(\d+)\b/g, (_match, numStr) => {
    orderedParams.push(params[parseInt(numStr, 10) - 1]);
    return '?';
  });

  return { sql: convertedSql, params: orderedParams };
}

// Helper function to mimic PostgreSQL's query interface
export const query = (sql: string, params?: any[]) => {
  try {
    const { sql: convertedSql, params: convertedParams } = convertQuery(sql, params);

    // better-sqlite3 only accepts number | string | bigint | Buffer | null
    const bindParams = convertedParams.map(p => {
      if (p === undefined || p === null) return null;
      if (p instanceof Date) return p.toISOString();
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });

    const upperSql = convertedSql.trim().toUpperCase();
    if (upperSql.startsWith('SELECT') || upperSql.includes('RETURNING')) {
      const stmt = db.prepare(convertedSql);
      const rows = bindParams.length > 0 ? stmt.all(...bindParams) : stmt.all();
      return Promise.resolve({ rows, rowCount: rows.length });
    } else {
      const stmt = db.prepare(convertedSql);
      const info = bindParams.length > 0 ? stmt.run(...bindParams) : stmt.run();
      return Promise.resolve({
        rows: [],
        rowCount: info.changes,
      });
    }
  } catch (error: any) {
    // Log minimal info server-side; don't expose SQL/params in logs (security)
    console.error('Database error:', error.code || 'UNKNOWN');
    try {
      const hasDiagnostics = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'diagnostic_events'"
      ).get();
      if (hasDiagnostics) {
        db.prepare(`INSERT INTO diagnostic_events
          (severity, source, category, message, metadata)
          VALUES ('error', 'database', 'query', 'Database operation failed', ?)`)
          .run(JSON.stringify({
            error_name: String(error?.name || 'Error').slice(0, 100),
            error_code: String(error?.code || 'UNKNOWN').slice(0, 100),
          }));
      }
    } catch {
      // If SQLite itself is unavailable, container logs are the only safe sink.
    }
    return Promise.reject(new Error('Database operation failed'));
  }
};

export const pool = {
  query,
};

export default db;
