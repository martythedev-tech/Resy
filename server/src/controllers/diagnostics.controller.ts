import { Response } from 'express';
import { pool } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { directoryAuthService } from '../services/directoryAuth.service';
import { getDiagnosticRetentionDays } from '../services/diagnostics.service';

const parseMetadata = (raw: unknown) => {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

export class DiagnosticsController {
  async list(req: AuthRequest, res: Response) {
    try {
      const query = String(req.query.query || '').trim().slice(0, 120);
      const severity = String(req.query.severity || '').trim();
      const source = String(req.query.source || '').trim().slice(0, 64);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const params: any[] = [];
      const where: string[] = [];

      if (query) {
        params.push(`%${query}%`);
        where.push(`(message LIKE $${params.length} OR request_id LIKE $${params.length} OR path LIKE $${params.length})`);
      }
      if (['info', 'warning', 'error'].includes(severity)) {
        params.push(severity);
        where.push(`severity = $${params.length}`);
      }
      if (source) {
        params.push(source);
        where.push(`source = $${params.length}`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const countResult = await pool.query(`SELECT COUNT(*) AS count FROM diagnostic_events ${whereSql}`, params);
      const listParams = [...params, limit, offset];
      const result = await pool.query(
        `SELECT id, created_at, severity, source, category, message, request_id, method, path, status_code, user_id, metadata
         FROM diagnostic_events ${whereSql}
         ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        listParams,
      );

      res.json({
        events: result.rows.map((row: any) => ({ ...row, metadata: parseMetadata(row.metadata) })),
        total: Number((countResult.rows[0] as any)?.count || 0),
        limit,
        offset,
        retention_days: getDiagnosticRetentionDays(),
      });
    } catch (error) {
      console.error('Get diagnostics error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async summary(req: AuthRequest, res: Response) {
    try {
      const [errorCounts, latestEvent, emailResult] = await Promise.all([
        pool.query(`SELECT
          SUM(CASE WHEN severity = 'error' AND created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS errors_24h,
          SUM(CASE WHEN severity = 'warning' AND created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS warnings_24h
          FROM diagnostic_events`),
        pool.query('SELECT created_at FROM diagnostic_events ORDER BY id DESC LIMIT 1'),
        pool.query('SELECT is_enabled, smtp_host, from_email FROM email_config WHERE id = 1'),
      ]);
      const directoryConfig = directoryAuthService.getConfig();
      const counts = errorCounts.rows[0] as any;
      const emailConfig = emailResult.rows[0] as any;
      const emailStatus = Number(emailConfig?.is_enabled || 0) !== 1
        ? 'disabled'
        : (emailConfig?.smtp_host && emailConfig?.from_email ? 'configured' : 'attention');

      res.json({
        api: { status: 'operational', uptime_seconds: Math.floor(process.uptime()) },
        database: { status: 'operational' },
        email: { status: emailStatus },
        directory: {
          status: directoryConfig.enabled
            ? (directoryAuthService.isConfigured(directoryConfig) ? 'configured' : 'attention')
            : 'disabled',
        },
        errors_24h: Number(counts?.errors_24h || 0),
        warnings_24h: Number(counts?.warnings_24h || 0),
        latest_event_at: (latestEvent.rows[0] as any)?.created_at || null,
        retention_days: getDiagnosticRetentionDays(),
      });
    } catch (error) {
      console.error('Get diagnostics summary error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const diagnosticsController = new DiagnosticsController();
