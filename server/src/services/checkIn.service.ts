import cron from 'node-cron';
import db, { pool } from '../config/database';
import { webhookService } from './webhook.service';
import { emailService } from './email.service';
import { recordOperationalError } from './diagnostics.service';

export class CheckInService {
  private running = false;

  private normalizePublicUrl(url: string | undefined) {
    if (!url) return undefined;
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    if (/localhost|127\.0\.0\.1/i.test(trimmed)) return undefined;
    return trimmed.replace(/\/$/, '');
  }

  init() {
    // Run every minute to check for no-shows
    cron.schedule('* * * * *', async () => {
      await this.processNoShows();
    });

    console.log('✅ Check-in monitoring service started');
  }

  async processNoShows() {
    if (this.running) return;
    this.running = true;
    try {
      // Get booking rules
      const ruleResult = await pool.query(
        `SELECT value FROM booking_rules
         WHERE rule_type = 'check_in_grace' AND is_enabled = true`
      );

      if (ruleResult.rows.length === 0) {
        // Do not retroactively penalize meetings held while check-in enforcement
        // was disabled. Keep the durable cursor at the current time.
        await pool.query(
          `INSERT INTO service_state (key, value, updated_at)
           VALUES ('no_show_last_cutoff', $1, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          [new Date().toISOString()]
        );
        return;
      }

      const graceMinutes = Math.min(240, Math.max(1, Number((ruleResult.rows[0] as any).value) || 10));
      const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString();
      const checkpointResult = await pool.query(
        "SELECT value FROM service_state WHERE key = 'no_show_last_cutoff'"
      );
      if (checkpointResult.rows.length === 0) {
        // First run establishes a safe baseline without retroactively marking
        // old bookings. Later restarts catch up from this durable checkpoint.
        await pool.query(
          "INSERT INTO service_state (key, value) VALUES ('no_show_last_cutoff', $1)",
          [cutoff]
        );
        return;
      }
      const previousCutoff = String((checkpointResult.rows[0] as any).value);
      if (new Date(previousCutoff).getTime() >= new Date(cutoff).getTime()) return;

      // Process the exact interval since the last completed scan. Status and
      // check-in predicates make retries safe if a process stops mid-batch.
      const bookingsToCancel = await pool.query(
        `SELECT b.id, b.user_id, b.title, b.start_time, b.end_time, b.room_id, b.equipment, b.notes, b.custom_fields,
                u.email as user_email, r.name as room_name, r.building as room_building, r.floor as room_floor
         FROM bookings b
         LEFT JOIN check_ins ci ON b.id = ci.booking_id
         LEFT JOIN users u ON b.user_id = u.id
         LEFT JOIN rooms r ON b.room_id = r.id
         WHERE b.status = 'confirmed'
         AND datetime(b.start_time) > datetime($1)
         AND datetime(b.start_time) <= datetime($2)
         AND ci.id IS NULL`
        , [previousCutoff, cutoff]
      );

      // Read the suspension rule once, outside the loop
      const suspensionRuleResult = await pool.query(
        `SELECT value FROM booking_rules
         WHERE rule_type = 'no_show_limit' AND is_enabled = true`
      );
      const noShowLimit = suspensionRuleResult.rows.length > 0
        ? Number((suspensionRuleResult.rows[0] as any).value)
        : null;

      // All DB writes for one no-show are one atomic unit; wrap in a transaction
      // so a crash mid-loop can't leave a booking marked no_show without the
      // corresponding user-count increment (or vice versa).
      const processOneNoShow = db.transaction((bookingId: number, userId: number | null) => {
        const bookingUpdate = db.prepare(
          `UPDATE bookings
           SET status = 'no_show',
               cancellation_reason = 'Auto-cancelled: No check-in within grace period',
               cancelled_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND status = 'confirmed'
             AND NOT EXISTS (SELECT 1 FROM check_ins WHERE booking_id = ?)`
        ).run(bookingId, bookingId);

        if (bookingUpdate.changes === 0) return false;
        if (!userId) return true;

        const userUpdate = db.prepare(
          `UPDATE users
           SET no_show_count = no_show_count + 1
           WHERE id = ?
           RETURNING no_show_count`
        ).get(userId) as any;
        const noShowCount = Number(userUpdate?.no_show_count || 0);

        if (noShowLimit !== null && noShowCount >= noShowLimit) {
          db.prepare(
            `UPDATE users
             SET suspension_until = datetime('now', '+7 days'),
                 no_show_count = 0
             WHERE id = ?`
          ).run(userId);
          console.log(`User ${userId} suspended due to ${noShowCount} no-shows`);
        }
        return true;
      });

      for (const booking of bookingsToCancel.rows as any[]) {
        if (!processOneNoShow(booking.id, booking.user_id)) continue;

        // Fire webhook + email after the transaction commits (network I/O, not DB)
        let equipmentList: string[] | undefined;
        if (booking.equipment) {
          try {
            equipmentList = typeof booking.equipment === 'string' ? JSON.parse(booking.equipment) : booking.equipment;
          } catch {
            equipmentList = undefined;
          }
        }
        let customFields: Record<string, any> | undefined;
        if (booking.custom_fields) {
          try {
            customFields = typeof booking.custom_fields === 'string' ? JSON.parse(booking.custom_fields) : booking.custom_fields;
          } catch {
            customFields = undefined;
          }
        }
        const durationMinutes = Math.max(0, Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 60000));
        const appUrl = this.normalizePublicUrl(process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || undefined);
        const bookingParams = new URLSearchParams({
          room: String(booking.room_id),
          start: new Date(booking.start_time).toISOString(),
          booking: String(booking.id),
        });
        const bookingUrl = appUrl ? `${appUrl}/calendar?${bookingParams.toString()}` : undefined;
        const payload = {
          event: 'no_show' as const,
          booking_id: booking.id,
          room_id: booking.room_id,
          title: booking.title || 'Untitled',
          room: booking.room_name || `Room ${booking.room_id}`,
          building: booking.room_building || undefined,
          floor: booking.room_floor ?? undefined,
          organizer: booking.user_email || `User ${booking.user_id}`,
          startTime: new Date(booking.start_time).toISOString(),
          endTime: new Date(booking.end_time).toISOString(),
          status: 'no_show',
          durationMinutes,
          appUrl,
          bookingUrl,
          equipment: equipmentList,
          notes: booking.notes || undefined,
          custom_fields: customFields || undefined,
          reason: 'No check-in within grace period',
        };
        webhookService.send(payload);
        emailService.send(payload);
        // Notify room managers for ALL no-shows
        emailService.notifyRoomManagers(payload);
      }

      if (bookingsToCancel.rows.length > 0) {
        console.log(`Processed ${bookingsToCancel.rows.length} no-shows`);
      }
      await pool.query(
        `UPDATE service_state SET value = $1, updated_at = CURRENT_TIMESTAMP
         WHERE key = 'no_show_last_cutoff'`,
        [cutoff]
      );
    } catch (error) {
      recordOperationalError({
        source: 'check-in',
        category: 'no_show_processing',
        message: 'Automatic no-show processing failed',
      }, error);
    } finally {
      this.running = false;
    }
  }
}

export const checkInService = new CheckInService();
