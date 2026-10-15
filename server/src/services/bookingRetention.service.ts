import cron from 'node-cron';
import db from '../config/database';
import { recordDiagnosticEvent } from './diagnostics.service';

export interface RetentionConfig {
  retention_months: number;
  enabled: boolean;
  backup_retention_days: number;
}

export interface RetentionPreview extends RetentionConfig {
  cutoff: string;
  eligible_count: number;
  held_count: number;
  anonymized_count: number;
  oldest_eligible_at: string | null;
  database_bytes: number;
  reusable_bytes: number;
}

const clamp = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
};

const cutoffForMonths = (months: number, now = new Date()) => {
  const targetMonth = now.getUTCMonth() - months;
  const targetMonthStart = new Date(Date.UTC(now.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  const cutoff = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth(),
    Math.min(now.getUTCDate(), lastDay),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
  return cutoff.toISOString();
};

export class BookingRetentionService {
  private ensureConfigRow() {
    db.prepare('INSERT OR IGNORE INTO site_config (id) VALUES (1)').run();
  }

  getConfig(): RetentionConfig {
    this.ensureConfigRow();
    const row = db.prepare(
      `SELECT booking_retention_months, booking_retention_enabled, backup_retention_days
       FROM site_config WHERE id = 1`
    ).get() as any;
    return {
      retention_months: clamp(row?.booking_retention_months, 36, 1, 120),
      enabled: Number(row?.booking_retention_enabled || 0) === 1,
      backup_retention_days: clamp(row?.backup_retention_days, 90, 1, 3650),
    };
  }

  updateConfig(input: { retention_months: number; enabled: boolean; backup_retention_days: number }) {
    this.ensureConfigRow();
    const config = {
      retention_months: clamp(input.retention_months, 36, 1, 120),
      enabled: !!input.enabled,
      backup_retention_days: clamp(input.backup_retention_days, 90, 1, 3650),
    };
    db.prepare(
      `UPDATE site_config
       SET booking_retention_months = ?, booking_retention_enabled = ?, backup_retention_days = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`
    ).run(config.retention_months, config.enabled ? 1 : 0, config.backup_retention_days);
    return config;
  }

  preview(now = new Date()): RetentionPreview {
    const config = this.getConfig();
    const cutoff = cutoffForMonths(config.retention_months, now);
    const eligible = db.prepare(
      `SELECT COUNT(*) AS count, MIN(end_time) AS oldest
       FROM bookings
       WHERE anonymized_at IS NULL AND retention_hold = 0
         AND status != 'pending' AND datetime(end_time) < datetime(?)`
    ).get(cutoff) as any;
    const held = db.prepare(
      `SELECT COUNT(*) AS count FROM bookings
       WHERE anonymized_at IS NULL AND retention_hold = 1
         AND datetime(end_time) < datetime(?)`
    ).get(cutoff) as any;
    const anonymized = db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE anonymized_at IS NOT NULL').get() as any;
    const pageCount = Number((db.prepare('PRAGMA page_count').get() as any)?.page_count || 0);
    const pageSize = Number((db.prepare('PRAGMA page_size').get() as any)?.page_size || 0);
    const freePages = Number((db.prepare('PRAGMA freelist_count').get() as any)?.freelist_count || 0);
    return {
      ...config,
      cutoff,
      eligible_count: Number(eligible?.count || 0),
      held_count: Number(held?.count || 0),
      anonymized_count: Number(anonymized?.count || 0),
      oldest_eligible_at: eligible?.oldest || null,
      database_bytes: pageCount * pageSize,
      reusable_bytes: freePages * pageSize,
    };
  }

  runBatch(limit = 500, source: 'manual' | 'scheduled' = 'manual') {
    const config = this.getConfig();
    if (source === 'scheduled' && !config.enabled) return { processed: 0, skipped: 'disabled' };
    const cutoff = cutoffForMonths(config.retention_months);
    const safeLimit = clamp(limit, 500, 1, 500);
    const ids = (db.prepare(
      `SELECT id FROM bookings
       WHERE anonymized_at IS NULL AND retention_hold = 0
         AND status != 'pending' AND datetime(end_time) < datetime(?)
       ORDER BY end_time ASC LIMIT ?`
    ).all(cutoff, safeLimit) as any[]).map(row => Number(row.id));

    if (ids.length === 0) return { processed: 0, cutoff };
    const placeholders = ids.map(() => '?').join(',');
    const anonymize = db.transaction(() => {
      db.prepare(`UPDATE check_ins SET checked_in_by = NULL WHERE booking_id IN (${placeholders})`).run(...ids);
      db.prepare(
        `UPDATE bookings
         SET user_id = NULL,
             title = 'Historical booking',
             attendees = NULL,
             notes = NULL,
             custom_fields = NULL,
             cancellation_reason = NULL,
             approved_by = NULL,
             anonymized_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders})`
      ).run(...ids);
    });
    anonymize();
    db.pragma('wal_checkpoint(PASSIVE)');
    db.pragma('optimize');
    recordDiagnosticEvent({
      severity: 'info',
      source: 'retention',
      category: 'booking_anonymization',
      message: `Anonymized ${ids.length} expired booking record(s)`,
      metadata: { source, count: ids.length, retention_months: config.retention_months },
    });
    return { processed: ids.length, cutoff };
  }

  setHold(bookingId: number, hold: boolean) {
    return db.prepare(
      `UPDATE bookings SET retention_hold = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND anonymized_at IS NULL
       RETURNING id, retention_hold`
    ).get(hold ? 1 : 0, bookingId) as any;
  }

  searchBookings(query: string, limit = 20) {
    const normalized = query.trim();
    if (!normalized) return [];
    const safeLimit = clamp(limit, 20, 1, 50);
    const pattern = `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
    return db.prepare(
      `SELECT b.id, b.title, b.end_time, b.status, b.retention_hold, b.anonymized_at,
              r.name AS room_name, u.name AS organizer_name, u.email AS organizer_email
       FROM bookings b
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.anonymized_at IS NULL
         AND (CAST(b.id AS TEXT) = ? OR b.title LIKE ? ESCAPE '\\'
              OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
              OR r.name LIKE ? ESCAPE '\\')
       ORDER BY b.retention_hold DESC, datetime(b.end_time) DESC
       LIMIT ?`
    ).all(normalized, pattern, pattern, pattern, pattern, safeLimit) as any[];
  }

  countHeldForUser(userId: number) {
    const row = db.prepare(
      'SELECT COUNT(*) AS count FROM bookings WHERE user_id = ? AND retention_hold = 1'
    ).get(userId) as any;
    return Number(row?.count || 0);
  }

  init() {
    cron.schedule('15 2 * * *', () => {
      try {
        this.runBatch(500, 'scheduled');
      } catch (error: any) {
        console.error('Booking retention job failed:', error?.code || error?.name || 'UNKNOWN');
        recordDiagnosticEvent({
          severity: 'error', source: 'retention', category: 'scheduled_cleanup',
          message: 'Scheduled booking retention job failed',
        });
      }
    });
    console.log('✅ Booking retention service scheduled');
  }
}

export const bookingRetentionService = new BookingRetentionService();
