import { Response } from 'express';
import db, { pool } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { bookingRulesService } from '../services/bookingRules.service';
import { webhookService } from '../services/webhook.service';
import { emailService } from '../services/email.service';
import { createApprovalToken } from '../services/approvalToken.service';
import { normalizeStringList, serializeStringList } from '../utils/stringList';
import {
  RecurrenceFrequency,
  RecurrenceValidationError,
  addCalendarDays,
  addCalendarMonthsClamped,
  buildZonedDate as buildRecurrenceZonedDate,
  generateRecurrencePlan,
  getDateInTimezone,
  getTimeInTimezone,
} from '../utils/recurrence';
import { validateBookingPayload, validateTemplatePayload } from '../utils/bookingPayload';
import { validateCustomFieldValues } from '../utils/customFields';

export class BookingsController {
  private static readonly DEFAULT_TIMEZONE = 'America/Chicago';

  private getDateStringInTimezone(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find(p => p.type === 'year')?.value || '1970';
    const month = parts.find(p => p.type === 'month')?.value || '01';
    const day = parts.find(p => p.type === 'day')?.value || '01';
    return `${year}-${month}-${day}`;
  }

  private buildZonedDate(dateStr: string, timeStr: string, timezone: string): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hour, minute] = timeStr.split(':').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0));
    const tzOffsetStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(utcDate).find(p => p.type === 'timeZoneName')?.value || '';
    const offsetMatch = tzOffsetStr.match(/GMT([+-])(\d{2}):(\d{2})/);
    let tzOffsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(offsetMatch[2], 10);
      const mins = parseInt(offsetMatch[3], 10);
      tzOffsetMinutes = sign * (hours * 60 + mins);
    }
    return new Date(utcDate.getTime() - tzOffsetMinutes * 60000);
  }

  private async getTimezone(): Promise<string> {
    try {
      const result = await pool.query('SELECT timezone FROM site_config WHERE id = 1');
      const row = result.rows[0] as any;
      return row?.timezone || BookingsController.DEFAULT_TIMEZONE;
    } catch {
      return BookingsController.DEFAULT_TIMEZONE;
    }
  }

  private async validateConfiguredCustomFields(
    value: unknown,
    options: { allowTemplateAttendeeCount?: boolean; enforceRequired?: boolean } = {},
  ): Promise<string | null> {
    const result = await pool.query('SELECT custom_fields FROM site_config WHERE id = 1');
    const config = result.rows[0] as { custom_fields?: unknown } | undefined;
    return validateCustomFieldValues(value, config?.custom_fields, options);
  }

  private async validateConcurrentSeriesLimit(
    userId: number,
    userRole: string,
    seriesCount: number,
    excludeRecurrenceId?: number,
  ): Promise<string | null> {
    const ruleResult = await pool.query(
      `SELECT value FROM booking_rules
       WHERE rule_type = 'max_concurrent_bookings'
         AND is_enabled = 1
         AND (applies_to_roles IS NULL OR instr(applies_to_roles, $1) > 0)
       LIMIT 1`,
      [userRole],
    );
    if (ruleResult.rows.length === 0) return null;
    const max = Number((ruleResult.rows[0] as any).value) || 0;
    if (max <= 0) return null;

    let sql = `SELECT COUNT(*) AS count FROM bookings
      WHERE user_id = $1
        AND status IN ('confirmed', 'pending')
        AND start_time >= CURRENT_TIMESTAMP`;
    const params: any[] = [userId];
    if (excludeRecurrenceId) {
      sql += ' AND (recurrence_id IS NULL OR recurrence_id != $2)';
      params.push(excludeRecurrenceId);
    }
    const countResult = await pool.query(sql, params);
    const existing = Number((countResult.rows[0] as any)?.count || 0);
    return existing + seriesCount > max
      ? `This series would create ${seriesCount} upcoming meetings, exceeding the ${max}-booking concurrent limit (${existing} already scheduled).`
      : null;
  }
  private normalizePublicUrl(url: string | undefined) {
    if (!url) return undefined;
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    if (/localhost|127\.0\.0\.1/i.test(trimmed)) return undefined;
    return trimmed.replace(/\/$/, '');
  }

  private getAppUrl(req?: AuthRequest) {
    const configured = this.normalizePublicUrl(process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL);
    if (configured) return configured;

    if (!req) return undefined;
    const originHeader = req.get('origin');
    const origin = this.normalizePublicUrl(originHeader || undefined);
    if (origin) return origin;
    return undefined;
  }

  private getPublicApiBase(req: AuthRequest) {
    return process.env.PUBLIC_API_URL
      || this.getAppUrl(req)
      || `${req.protocol}://${req.get('host')}`;
  }

  private buildBookingUrl(
    appUrl: string | undefined,
    bookingId: number,
    roomId: number,
    startTime: Date | string
  ) {
    if (!appUrl) return undefined;
    const params = new URLSearchParams({
      room: String(roomId),
      start: new Date(startTime).toISOString(),
      booking: String(bookingId),
    });
    return `${appUrl.replace(/\/$/, '')}/calendar?${params.toString()}`;
  }

  private buildApprovalLinks(baseUrl: string, bookingId: number) {
    const normalized = baseUrl.replace(/\/$/, '');
    const approveToken = createApprovalToken(bookingId, 'approve');
    const rejectToken = createApprovalToken(bookingId, 'reject');
    return {
      approveUrl: `${normalized}/api/approvals/${approveToken}/approve`,
      rejectUrl: `${normalized}/api/approvals/${rejectToken}/reject`,
    };
  }

  private parseEquipment(equipment: any): string[] | undefined {
    const normalized = normalizeStringList(equipment);
    return normalized.length > 0 ? normalized : undefined;
  }

  private parseCustomFields(raw: any): Record<string, any> | undefined {
    if (!raw) return undefined;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return undefined;
    }
  }

  private getDurationMinutes(start: string | Date, end: string | Date): number {
    const s = typeof start === 'string' ? new Date(start) : start;
    const e = typeof end === 'string' ? new Date(end) : end;
    return Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
  }

  private formatRecurrenceDate(dateStr: string): string {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  private buildRecurrenceSummary(recurrence: any): string | undefined {
    if (!recurrence || !recurrence.frequency) return undefined;

    const frequency = String(recurrence.frequency).toLowerCase();
    const interval = Math.max(1, Number(recurrence.interval) || 1);
    const unitMap: Record<string, string> = {
      daily: 'day',
      weekly: 'week',
      monthly: 'month',
    };
    const unit = unitMap[frequency];
    if (!unit) return undefined;

    const cadence = interval === 1 ? `Repeats ${frequency}` : `Repeats every ${interval} ${unit}s`;
    if (recurrence.end_date) {
      return `${cadence} until ${this.formatRecurrenceDate(String(recurrence.end_date))}`;
    }
    if (Number(recurrence.max_occurrences) > 0) {
      return `${cadence} for ${Number(recurrence.max_occurrences)} occurrence(s)`;
    }
    return cadence;
  }

  private async getRoomDetails(roomId: number) {
    const roomRow = await pool.query('SELECT name, building, floor FROM rooms WHERE id = $1', [roomId]);
    if (roomRow.rows.length === 0) {
      return { name: `Room ${roomId}`, building: undefined, floor: undefined };
    }
    const row = roomRow.rows[0] as any;
    return { name: row.name, building: row.building, floor: row.floor };
  }

  private async roomRequiresApproval(roomId: number): Promise<boolean> {
    const roomRow = await pool.query('SELECT requires_approval FROM rooms WHERE id = $1', [roomId]);
    if (roomRow.rows.length === 0) return false;
    return Number((roomRow.rows[0] as any).requires_approval) === 1;
  }

  async getAll(req: AuthRequest, res: Response) {
    try {
      const { room_id, start_date, end_date, status } = req.query;
      const canViewAllPrivateDetails = ['admin', 'room_manager'].includes(req.user!.role);

      // Validate query params
      if (room_id && (isNaN(Number(room_id)) || Number(room_id) < 1)) {
        return res.status(400).json({ error: 'Invalid room_id parameter' });
      }
      if (status && !['confirmed', 'cancelled', 'no_show', 'pending'].includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status parameter' });
      }

      let query = `
        SELECT b.id, b.room_id, b.user_id, b.title, b.start_time, b.end_time,
               b.is_recurring, b.recurrence_id, b.status, b.created_at, b.updated_at,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN b.attendees ELSE NULL END AS attendees,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN b.attendee_count ELSE NULL END AS attendee_count,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN b.equipment ELSE NULL END AS equipment,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN b.notes ELSE NULL END AS notes,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN b.custom_fields ELSE NULL END AS custom_fields,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN b.cancellation_reason ELSE NULL END AS cancellation_reason,
               u.name as organizer_name,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN u.email ELSE NULL END AS organizer_email,
               r.name as room_name, r.building as room_building,
               CASE WHEN b.user_id = $1 OR $2 = 1
                    THEN CASE WHEN EXISTS (SELECT 1 FROM check_ins ci WHERE ci.booking_id = b.id) THEN 1 ELSE 0 END
                    ELSE NULL END AS checked_in,
               CASE WHEN b.user_id = $1 OR $2 = 1 THEN 1 ELSE 0 END AS can_view_private
        FROM bookings b
        LEFT JOIN users u ON b.user_id = u.id
        LEFT JOIN rooms r ON b.room_id = r.id
        WHERE 1=1
      `;
      const params: any[] = [req.user!.id, canViewAllPrivateDetails ? 1 : 0];
      let paramCount = 3;

      if (room_id) {
        query += ` AND b.room_id = $${paramCount++}`;
        params.push(room_id);
      }

      let startParam: string | Date | undefined;
      let endParam: string | Date | undefined;

      if (start_date) {
        const startStr = String(start_date);
        if (startStr.includes('T')) {
          startParam = startStr;
        } else {
          const tz = await this.getTimezone();
          startParam = this.buildZonedDate(startStr, '00:00', tz);
        }
      }

      if (end_date) {
        const endStr = String(end_date);
        if (endStr.includes('T')) {
          endParam = endStr;
        } else {
          const tz = await this.getTimezone();
          endParam = this.buildZonedDate(endStr, '23:59', tz);
        }
      }

      if (startParam) {
        query += ` AND b.end_time >= $${paramCount++}`;
        params.push(startParam);
      }

      if (endParam) {
        query += ` AND b.start_time <= $${paramCount++}`;
        params.push(endParam);
      }

      if (status) {
        query += ` AND b.status = $${paramCount++}`;
        params.push(status);
      }

      query += ' ORDER BY b.start_time ASC';

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error) {
      console.error('Get bookings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async getMyBookings(req: AuthRequest, res: Response) {
    try {
      const scope = String(req.query.scope || 'legacy');
      if (!['legacy', 'upcoming', 'history'].includes(scope)) {
        return res.status(400).json({ error: 'Invalid booking scope' });
      }

      if (scope === 'upcoming') {
        const result = await pool.query(
          `SELECT b.*, r.name as room_name, r.building as room_building,
                  CASE WHEN EXISTS (SELECT 1 FROM check_ins ci WHERE ci.booking_id = b.id) THEN 1 ELSE 0 END AS checked_in
           FROM bookings b
           LEFT JOIN rooms r ON b.room_id = r.id
           WHERE b.user_id = $1
             AND b.status IN ('confirmed', 'pending')
             AND datetime(b.end_time) >= datetime('now')
           ORDER BY b.start_time ASC
           LIMIT 200`,
          [req.user!.id]
        );
        return res.json({ bookings: result.rows, total: result.rows.length, limit: 200, offset: 0, has_more: false });
      }

      if (scope === 'history') {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const where = `b.user_id = $1
          AND (b.status IN ('cancelled', 'no_show') OR datetime(b.end_time) < datetime('now'))`;
        const countResult = await pool.query(`SELECT COUNT(*) AS count FROM bookings b WHERE ${where}`, [req.user!.id]);
        const total = Number((countResult.rows[0] as any)?.count || 0);
        const result = await pool.query(
          `SELECT b.*, r.name as room_name, r.building as room_building,
                  CASE WHEN EXISTS (SELECT 1 FROM check_ins ci WHERE ci.booking_id = b.id) THEN 1 ELSE 0 END AS checked_in
           FROM bookings b
           LEFT JOIN rooms r ON b.room_id = r.id
           WHERE ${where}
           ORDER BY b.start_time DESC
           LIMIT $2 OFFSET $3`,
          [req.user!.id, limit, offset]
        );
        return res.json({
          bookings: result.rows,
          total,
          limit,
          offset,
          has_more: offset + result.rows.length < total,
        });
      }

      // Preserve the legacy array response for older clients while the current UI uses paginated scopes.
      const result = await pool.query(
        `SELECT b.*, r.name as room_name, r.building as room_building,
                CASE WHEN EXISTS (SELECT 1 FROM check_ins ci WHERE ci.booking_id = b.id) THEN 1 ELSE 0 END AS checked_in
         FROM bookings b
         LEFT JOIN rooms r ON b.room_id = r.id
         WHERE b.user_id = $1
         AND b.status IN ('confirmed', 'pending', 'cancelled', 'no_show')
         ORDER BY b.start_time DESC`,
        [req.user!.id]
      );

      return res.json(result.rows);
    } catch (error) {
      console.error('Get my bookings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async create(req: AuthRequest, res: Response) {
    try {
      const {
        room_id,
        title,
        start_time,
        end_time,
        attendees,
        attendee_count,
        equipment,
        notes,
        custom_fields,
        is_recurring,
        recurrence,
      } = req.body;

      const payloadError = validateBookingPayload(req.body);
      if (payloadError) return res.status(400).json({ error: payloadError });
      const customFieldsError = await this.validateConfiguredCustomFields(custom_fields);
      if (customFieldsError) return res.status(400).json({ error: customFieldsError });

      // Validate required fields
      if (!room_id || !title || !start_time || !end_time) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate room_id is a valid number
      if (isNaN(Number(room_id)) || Number(room_id) < 1) {
        return res.status(400).json({ error: 'Invalid room_id' });
      }
      if (attendees !== undefined && !Array.isArray(attendees)) {
        return res.status(400).json({ error: 'Attendees must be an array' });
      }
      const hasAttendeeCount = Object.prototype.hasOwnProperty.call(req.body, 'attendee_count');
      const attendeeCountNumber = attendee_count === null || attendee_count === '' ? null : Number(attendee_count);
      if (hasAttendeeCount && attendeeCountNumber !== null && (!Number.isInteger(attendeeCountNumber) || attendeeCountNumber < 0 || attendeeCountNumber > 100000)) {
        return res.status(400).json({ error: 'Attendee count must be a whole number between 0 and 100000' });
      }

      const activeRoom = await pool.query(
        `SELECT r.id FROM rooms r
         JOIN buildings b ON b.name = r.building
         WHERE r.id = $1 AND r.is_active = 1 AND b.is_active = 1`,
        [Number(room_id)]
      );
      if (activeRoom.rows.length === 0) {
        return res.status(409).json({ error: 'This room or its building is not available for booking' });
      }

      const startTime = new Date(start_time);
      const endTime = new Date(end_time);
      if (!Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime()) || endTime <= startTime) {
        return res.status(400).json({ error: 'Booking start and end times are invalid' });
      }
      const startTimeIso = startTime.toISOString();
      const endTimeIso = endTime.toISOString();

      const tz = await this.getTimezone();
      let recurrencePlan: ReturnType<typeof generateRecurrencePlan> | null = null;

      if (is_recurring !== undefined && typeof is_recurring !== 'boolean') {
        return res.status(400).json({ error: 'is_recurring must be a boolean' });
      }

      if (is_recurring) {
        if (!recurrence || typeof recurrence !== 'object') {
          return res.status(400).json({ error: 'Recurrence details are required' });
        }
        try {
          recurrencePlan = generateRecurrencePlan(startTime, {
            frequency: String(recurrence.frequency || '') as RecurrenceFrequency,
            interval: Number(recurrence.interval),
            endDate: String(recurrence.end_date || ''),
          }, tz);
          if (recurrencePlan.starts.length === 0) {
            return res.status(400).json({ error: 'The recurrence end date must include at least one additional meeting' });
          }
        } catch (error) {
          if (error instanceof RecurrenceValidationError) {
            return res.status(400).json({ error: error.message });
          }
          throw error;
        }
      }

      if (recurrencePlan) {
        try {
          const ruleResult = await pool.query(
            `SELECT value, is_enabled FROM booking_rules
             WHERE rule_type = 'recurrence_limit'`
          );
          const rule = ruleResult.rows[0] as any;
          if (rule && Number(rule.is_enabled) === 1) {
            const maxMonths = Number(rule.value) || 12;
            const maxEndDate = addCalendarMonthsClamped(getDateInTimezone(startTime, tz), maxMonths);
            if (recurrencePlan.endDate > maxEndDate) {
              return res.status(400).json({
                error: `Recurring bookings cannot extend beyond ${maxMonths} month(s) from the start date`,
              });
            }
          }
        } catch {
          // If rule fetch fails, do not block booking creation
        }
      }

      const isPrivileged = ['admin', 'room_manager'].includes(req.user!.role);
      const requiresApproval = await this.roomRequiresApproval(Number(room_id));
      const isAfterHours = await bookingRulesService.isOutsideBusinessHours(startTime, endTime, Number(room_id));
      const shouldBePending = !isPrivileged && requiresApproval && isAfterHours;

      // Validate booking rules
      const violations = await bookingRulesService.validateBooking(
        startTime,
        endTime,
        req.user!.id,
        room_id,
        req.user!.role,
        undefined,
        { skipBusinessHours: shouldBePending || isPrivileged }
      );

      if (violations.length > 0) {
        return res.status(400).json({ error: violations[0].message, violations });
      }

      const duration = endTime.getTime() - startTime.getTime();
      const recurrenceOccurrences: { start: Date; end: Date; status: 'confirmed' | 'pending' }[] = [];
      const recurrenceConflicts: { date: string; message: string }[] = [];

      if (recurrencePlan) {
        const concurrentLimitError = await this.validateConcurrentSeriesLimit(
          req.user!.id,
          req.user!.role,
          recurrencePlan.starts.length + 1,
        );
        if (concurrentLimitError) {
          return res.status(400).json({ error: concurrentLimitError });
        }
        for (const occurrenceStart of recurrencePlan.starts) {
          const occurrenceEnd = new Date(occurrenceStart.getTime() + duration);
          const occurrenceAfterHours = await bookingRulesService.isOutsideBusinessHours(
            occurrenceStart,
            occurrenceEnd,
            Number(room_id),
          );
          const occurrencePending = !isPrivileged && requiresApproval && occurrenceAfterHours;
          const occurrenceViolations = await bookingRulesService.validateBooking(
            occurrenceStart,
            occurrenceEnd,
            req.user!.id,
            Number(room_id),
            req.user!.role,
            undefined,
            { skipBusinessHours: occurrencePending || isPrivileged },
          );
          if (occurrenceViolations.length > 0) {
            recurrenceConflicts.push({
              date: getDateInTimezone(occurrenceStart, tz),
              message: occurrenceViolations[0].message,
            });
          } else {
            recurrenceOccurrences.push({
              start: occurrenceStart,
              end: occurrenceEnd,
              status: occurrencePending ? 'pending' : 'confirmed',
            });
          }
        }

        if (recurrenceConflicts.length > 0) {
          const first = recurrenceConflicts[0];
          return res.status(409).json({
            error: `${recurrenceConflicts.length} meeting date${recurrenceConflicts.length === 1 ? ' is' : 's are'} unavailable. First conflict: ${first.date} — ${first.message}`,
            recurrence_conflicts: recurrenceConflicts.slice(0, 25),
          });
        }
      }

      const attendeesJson = JSON.stringify(attendees || []);
      const attendeeCountValue = hasAttendeeCount ? attendeeCountNumber : (attendees === undefined ? null : attendees.length);
      const equipmentJson = serializeStringList(equipment || []);
      const customFieldsJson = custom_fields ? JSON.stringify(custom_fields) : null;
      const organizerProfile = db.prepare('SELECT department FROM users WHERE id = ?').get(req.user!.id) as { department?: string | null } | undefined;
      const organizerDepartment = organizerProfile?.department?.trim() || null;
      const createBookingAtomically = db.transaction(() => {
        const booking = db.prepare(
          `INSERT INTO bookings (
            room_id, user_id, organizer_department, title, start_time, end_time,
            attendees, attendee_count, equipment, notes, custom_fields, is_recurring, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING *`
        ).get(
          Number(room_id),
          req.user!.id,
          organizerDepartment,
          title,
          startTimeIso,
          endTimeIso,
          attendeesJson,
          attendeeCountValue,
          equipmentJson,
          notes || null,
          customFieldsJson,
          recurrencePlan ? 1 : 0,
          shouldBePending ? 'pending' : 'confirmed',
        ) as any;

        if (!recurrencePlan) return booking;

        const recurrenceInfo = db.prepare(
          `INSERT INTO booking_recurrence (
            original_booking_id, frequency, interval, days_of_week, end_date, max_occurrences
          ) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).get(
          booking.id,
          recurrencePlan.frequency,
          recurrencePlan.interval,
          null,
          recurrencePlan.endDate,
          recurrenceOccurrences.length + 1,
        ) as any;

        db.prepare('UPDATE bookings SET recurrence_id = ? WHERE id = ?').run(recurrenceInfo.id, booking.id);
        booking.recurrence_id = recurrenceInfo.id;

        const insertOccurrence = db.prepare(
          `INSERT INTO bookings (
            room_id, user_id, organizer_department, title, start_time, end_time,
            attendees, attendee_count, equipment, notes, custom_fields, is_recurring, recurrence_id, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        );
        for (const occurrence of recurrenceOccurrences) {
          insertOccurrence.run(
            Number(room_id),
            req.user!.id,
            organizerDepartment,
            title,
            occurrence.start.toISOString(),
            occurrence.end.toISOString(),
            attendeesJson,
            attendeeCountValue,
            equipmentJson,
            notes || null,
            customFieldsJson,
            recurrenceInfo.id,
            occurrence.status,
          );
        }
        booking.recurrence_result = {
          created_count: recurrenceOccurrences.length + 1,
          first_date: getDateInTimezone(startTime, tz),
          end_date: recurrencePlan.endDate,
        };
        return booking;
      });

      const booking = createBookingAtomically();

      // Fire webhook (non-blocking)
      const roomDetails = await this.getRoomDetails(Number(room_id));
      const roomName = roomDetails.name;
      const equipmentList = equipment && equipment.length > 0 ? equipment : undefined;
      const appUrl = this.getAppUrl(req);
      const bookingUrl = this.buildBookingUrl(appUrl, booking.id, Number(room_id), startTimeIso);
      const approvalLinks = shouldBePending
        ? this.buildApprovalLinks(this.getPublicApiBase(req), booking.id)
        : null;
      const eventType: 'booking_pending' | 'booking_created' = shouldBePending ? 'booking_pending' : 'booking_created';
      const durationMinutes = this.getDurationMinutes(startTime, endTime);
      const recurrenceSummary = is_recurring ? this.buildRecurrenceSummary(recurrence) : undefined;
      webhookService.send({
        event: eventType,
        booking_id: booking.id,
        room_id: Number(room_id),
        title: booking.title,
        room: roomName,
        building: roomDetails.building,
        floor: roomDetails.floor,
        organizer: req.user!.email,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        status: booking.status,
        durationMinutes,
        appUrl,
        bookingUrl,
        approveUrl: approvalLinks?.approveUrl,
        rejectUrl: approvalLinks?.rejectUrl,
        equipment: equipmentList,
        notes: notes || undefined,
        custom_fields: custom_fields || undefined,
        recurrence_summary: recurrenceSummary,
      });

      const emailPayload = {
        event: eventType as 'booking_created' | 'booking_pending',
        booking_id: booking.id,
        room_id: Number(room_id),
        title: booking.title,
        room: roomName,
        building: roomDetails.building,
        floor: roomDetails.floor,
        organizer: req.user!.email,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        status: booking.status,
        durationMinutes,
        appUrl,
        bookingUrl,
        approveUrl: approvalLinks?.approveUrl,
        rejectUrl: approvalLinks?.rejectUrl,
        equipment: equipmentList,
        notes: notes || undefined,
        custom_fields: custom_fields || undefined,
        recurrence_summary: recurrenceSummary,
      };

      emailService.send(emailPayload);

      // Notify room managers for ALL bookings
      emailService.notifyRoomManagers(emailPayload);

      res.status(201).json(booking);
    } catch (error) {
      console.error('Create booking error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async update(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { title, attendees, attendee_count, equipment, notes, start_time, end_time, custom_fields, series_scope = 'single' } = req.body;

      const payloadError = validateBookingPayload(req.body, true);
      if (payloadError) return res.status(400).json({ error: payloadError });
      if (Object.prototype.hasOwnProperty.call(req.body, 'custom_fields')) {
        const customFieldsError = await this.validateConfiguredCustomFields(custom_fields);
        if (customFieldsError) return res.status(400).json({ error: customFieldsError });
      }

      if (!['single', 'following'].includes(series_scope)) {
        return res.status(400).json({ error: 'Series scope must be single or following' });
      }

      if (attendees !== undefined && !Array.isArray(attendees)) {
        return res.status(400).json({ error: 'Attendees must be an array' });
      }
      if (equipment !== undefined && !Array.isArray(equipment)) {
        return res.status(400).json({ error: 'Technology selections must be an array' });
      }
      const hasAttendeeCount = Object.prototype.hasOwnProperty.call(req.body, 'attendee_count');
      const attendeeCountNumber = attendee_count === null || attendee_count === '' ? null : Number(attendee_count);
      if (hasAttendeeCount && attendeeCountNumber !== null && (!Number.isInteger(attendeeCountNumber) || attendeeCountNumber < 0 || attendeeCountNumber > 100000)) {
        return res.status(400).json({ error: 'Attendee count must be a whole number between 0 and 100000' });
      }

      // Get existing booking
      const existing = await pool.query(
        `SELECT b.*, u.email AS organizer_email
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
         WHERE b.id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const booking = existing.rows[0] as any;

      // Check permissions
      if (booking.user_id !== req.user!.id && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      if (!['confirmed', 'pending'].includes(booking.status)) {
        return res.status(409).json({ error: `Cannot update a ${booking.status} booking` });
      }

      if (series_scope === 'following' && !booking.recurrence_id) {
        return res.status(400).json({ error: 'This booking is not part of a recurring series' });
      }

      const isPrivileged = ['admin', 'room_manager'].includes(req.user!.role);
      const requiresApproval = await this.roomRequiresApproval(Number(booking.room_id));
      let shouldBePending = false;

      // If time is being changed, validate the new times
      let newStartTime = booking.start_time;
      let newEndTime = booking.end_time;

      if (start_time || end_time) {
        const activeRoom = await pool.query(
          `SELECT r.id FROM rooms r
           JOIN buildings b ON b.name = r.building
           WHERE r.id = $1 AND r.is_active = 1 AND b.is_active = 1`,
          [Number(booking.room_id)]
        );
        if (activeRoom.rows.length === 0) {
          return res.status(409).json({ error: 'This room or its building is not available for booking' });
        }
        newStartTime = start_time ? new Date(start_time) : new Date(booking.start_time);
        newEndTime = end_time ? new Date(end_time) : new Date(booking.end_time);
        if (!Number.isFinite(newStartTime.getTime()) || !Number.isFinite(newEndTime.getTime()) || newEndTime <= newStartTime) {
          return res.status(400).json({ error: 'Booking start and end times are invalid' });
        }

        const isAfterHours = await bookingRulesService.isOutsideBusinessHours(newStartTime, newEndTime, Number(booking.room_id));
        shouldBePending = !isPrivileged && requiresApproval && isAfterHours;

        // Validate booking rules for the new time (excluding current booking from conflict check)
        const violations = await bookingRulesService.validateBooking(
          newStartTime,
          newEndTime,
          req.user!.id,
          booking.room_id,
          req.user!.role,
          booking.id, // Exclude current booking from conflict check
          {
            skipBusinessHours: shouldBePending || isPrivileged,
            excludeRecurrenceId: series_scope === 'following' ? Number(booking.recurrence_id) : undefined,
          }
        );

        if (violations.length > 0) {
          return res.status(400).json({ error: violations[0].message, violations });
        }
      }

      // Update booking status when time changes:
      // - outside business hours + approval required => pending
      // - moved back inside business hours from pending => confirmed
      // - otherwise keep current status
      const hasTimeChange = Boolean(start_time || end_time);
      const shouldAutoConfirm = hasTimeChange && booking.status === 'pending' && !shouldBePending;
      const nextStatus = shouldBePending ? 'pending' : (shouldAutoConfirm ? 'confirmed' : booking.status);

      let updatedBooking: any;
      let affectedCount = 1;
      let affectedBookingIds = [Number(booking.id)];

      if (series_scope === 'following') {
        const seriesResult = await pool.query(
          `SELECT * FROM bookings
           WHERE recurrence_id = $1
             AND status IN ('confirmed', 'pending')
             AND start_time >= $2
           ORDER BY start_time ASC`,
          [booking.recurrence_id, booking.start_time],
        );
        const targets = seriesResult.rows as any[];
        affectedBookingIds = targets.map(target => Number(target.id));
        const recurrenceResult = await pool.query(
          'SELECT frequency, interval FROM booking_recurrence WHERE id = $1',
          [booking.recurrence_id],
        );
        const recurrenceRule = recurrenceResult.rows[0] as any;
        const earlierSeriesResult = await pool.query(
          `SELECT start_time, end_time FROM bookings
           WHERE recurrence_id = $1
             AND status IN ('confirmed', 'pending')
             AND start_time < $2`,
          [booking.recurrence_id, booking.start_time],
        );
        const earlierSeriesBookings = earlierSeriesResult.rows as any[];
        const concurrentLimitError = await this.validateConcurrentSeriesLimit(
          req.user!.id,
          req.user!.role,
          targets.length,
          Number(booking.recurrence_id),
        );
        if (concurrentLimitError) {
          return res.status(400).json({ error: concurrentLimitError });
        }
        const tz = await this.getTimezone();
        const selectedOldDate = getDateInTimezone(new Date(booking.start_time), tz);
        const requestedStart = start_time ? new Date(start_time) : new Date(booking.start_time);
        const requestedEnd = end_time ? new Date(end_time) : new Date(booking.end_time);
        if (!Number.isFinite(requestedStart.getTime()) || !Number.isFinite(requestedEnd.getTime()) || requestedEnd <= requestedStart) {
          return res.status(400).json({ error: 'Booking start and end times are invalid' });
        }
        const selectedNewDate = getDateInTimezone(requestedStart, tz);
        const oldPivot = new Date(`${selectedOldDate}T12:00:00.000Z`);
        const newPivot = new Date(`${selectedNewDate}T12:00:00.000Z`);
        const dayShift = Math.round((newPivot.getTime() - oldPivot.getTime()) / 86_400_000);
        const newLocalTime = getTimeInTimezone(requestedStart, tz);
        const newDuration = requestedEnd.getTime() - requestedStart.getTime();
        const seriesUpdates: { current: any; start: Date; end: Date; status: string }[] = [];
        const seriesConflicts: { date: string; message: string }[] = [];

        for (const [targetIndex, target] of targets.entries()) {
          const targetDate = getDateInTimezone(new Date(target.start_time), tz);
          const shiftedDate = recurrenceRule?.frequency === 'monthly'
            ? addCalendarMonthsClamped(
                selectedNewDate,
                targetIndex * Math.max(1, Number(recurrenceRule.interval) || 1),
                Number(selectedNewDate.slice(8, 10)),
              )
            : addCalendarDays(targetDate, dayShift);
          const candidateStart = buildRecurrenceZonedDate(shiftedDate, newLocalTime, tz);
          const candidateEnd = new Date(candidateStart.getTime() + newDuration);
          const overlapsEarlierSeries = earlierSeriesBookings.some(earlier =>
            candidateStart < new Date(earlier.end_time) && candidateEnd > new Date(earlier.start_time)
          );
          if (overlapsEarlierSeries) {
            seriesConflicts.push({ date: shiftedDate, message: 'This change would overlap an earlier meeting in the same series' });
            continue;
          }
          const afterHours = await bookingRulesService.isOutsideBusinessHours(candidateStart, candidateEnd, Number(target.room_id));
          const pending = !isPrivileged && requiresApproval && afterHours;
          const targetViolations = await bookingRulesService.validateBooking(
            candidateStart,
            candidateEnd,
            req.user!.id,
            Number(target.room_id),
            req.user!.role,
            undefined,
            { skipBusinessHours: pending || isPrivileged, excludeRecurrenceId: Number(booking.recurrence_id) },
          );
          if (targetViolations.length > 0) {
            seriesConflicts.push({ date: shiftedDate, message: targetViolations[0].message });
          } else {
            seriesUpdates.push({ current: target, start: candidateStart, end: candidateEnd, status: pending ? 'pending' : 'confirmed' });
          }
        }

        if (seriesConflicts.length > 0) {
          const first = seriesConflicts[0];
          return res.status(409).json({
            error: `${seriesConflicts.length} meeting date${seriesConflicts.length === 1 ? ' is' : 's are'} unavailable. First conflict: ${first.date} — ${first.message}`,
            recurrence_conflicts: seriesConflicts.slice(0, 25),
          });
        }

        const updateSeries = db.transaction(() => {
          const stmt = db.prepare(
            `UPDATE bookings SET
              title = ?, attendees = ?, attendee_count = ?, equipment = ?, notes = ?, custom_fields = ?,
              start_time = ?, end_time = ?, status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? RETURNING *`
          );
          let selected: any = null;
          for (const update of seriesUpdates) {
            const row = stmt.get(
              title ?? update.current.title,
              attendees === undefined ? update.current.attendees : JSON.stringify(attendees),
              hasAttendeeCount ? attendeeCountNumber : update.current.attendee_count,
              equipment === undefined ? update.current.equipment : serializeStringList(equipment),
              notes === undefined ? update.current.notes : notes,
              custom_fields === undefined ? update.current.custom_fields : JSON.stringify(custom_fields),
              update.start.toISOString(),
              update.end.toISOString(),
              update.status,
              update.current.id,
            ) as any;
            if (Number(update.current.id) === Number(id)) selected = row;
          }
          const seriesStats = db.prepare(
            'SELECT COUNT(*) AS count, MAX(start_time) AS max_start FROM bookings WHERE recurrence_id = ?'
          ).get(booking.recurrence_id) as any;
          if (seriesStats?.max_start) {
            db.prepare('UPDATE booking_recurrence SET end_date = ?, max_occurrences = ? WHERE id = ?').run(
              getDateInTimezone(new Date(seriesStats.max_start), tz),
              Number(seriesStats.count) || seriesUpdates.length,
              booking.recurrence_id,
            );
          }
          return selected;
        });
        updatedBooking = updateSeries();
        affectedCount = seriesUpdates.length;
      } else {
        const result = await pool.query(
          `UPDATE bookings
           SET title = COALESCE($1, title),
               attendees = COALESCE($2, attendees),
               attendee_count = CASE WHEN $3 = 1 THEN $4 ELSE attendee_count END,
               equipment = COALESCE($5, equipment),
               notes = CASE WHEN $6 = 1 THEN $7 ELSE notes END,
               custom_fields = CASE WHEN $8 = 1 THEN $9 ELSE custom_fields END,
               start_time = COALESCE($10, start_time),
               end_time = COALESCE($11, end_time),
               status = COALESCE($12, status),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $13
           RETURNING *`,
          [
            title,
            attendees === undefined ? null : JSON.stringify(attendees),
            hasAttendeeCount ? 1 : 0,
            attendeeCountNumber,
            equipment === undefined ? null : serializeStringList(equipment),
            Object.prototype.hasOwnProperty.call(req.body, 'notes') ? 1 : 0,
            notes,
            Object.prototype.hasOwnProperty.call(req.body, 'custom_fields') ? 1 : 0,
            custom_fields === null ? null : JSON.stringify(custom_fields),
            start_time ? new Date(start_time).toISOString() : null,
            end_time ? new Date(end_time).toISOString() : null,
            nextStatus,
            id
          ]
        );
        updatedBooking = result.rows[0] as any;
      }

      // Fire notifications (non-blocking)
      const roomDetails = await this.getRoomDetails(Number(booking.room_id));
      const roomName = roomDetails.name;
      const appUrl = this.getAppUrl(req);

      // Parse equipment from the updated booking
      const equipmentList = this.parseEquipment(updatedBooking.equipment);
      const prevEquipment = this.parseEquipment(booking.equipment);
      const updatedCustomFields = this.parseCustomFields(updatedBooking.custom_fields);
      const prevCustomFields = this.parseCustomFields(booking.custom_fields);
      const durationMinutes = this.getDurationMinutes(updatedBooking.start_time, updatedBooking.end_time);

      const changes: Record<string, { from: any; to: any }> = {};
      if (booking.title !== updatedBooking.title) changes.title = { from: booking.title, to: updatedBooking.title };
      if (booking.start_time !== updatedBooking.start_time) changes.start_time = { from: booking.start_time, to: updatedBooking.start_time };
      if (booking.end_time !== updatedBooking.end_time) changes.end_time = { from: booking.end_time, to: updatedBooking.end_time };
      if (booking.status !== updatedBooking.status) changes.status = { from: booking.status, to: updatedBooking.status };
      if (JSON.stringify(prevEquipment || []) !== JSON.stringify(equipmentList || [])) {
        changes.equipment = { from: prevEquipment || [], to: equipmentList || [] };
      }
      if ((booking.notes || '') !== (updatedBooking.notes || '')) {
        changes.notes = { from: booking.notes || '', to: updatedBooking.notes || '' };
      }
      if (JSON.stringify(prevCustomFields || {}) !== JSON.stringify(updatedCustomFields || {})) {
        changes.custom_fields = { from: prevCustomFields || {}, to: updatedCustomFields || {} };
      }

      const notificationBookings = affectedBookingIds
        .map(bookingId => db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as any)
        .filter(Boolean);
      for (const notificationBooking of notificationBookings) {
        const targetEquipment = this.parseEquipment(notificationBooking.equipment);
        const targetCustomFields = this.parseCustomFields(notificationBooking.custom_fields);
        const targetDurationMinutes = this.getDurationMinutes(notificationBooking.start_time, notificationBooking.end_time);
        const targetIsPending = notificationBooking.status === 'pending';
        const targetEvent: 'booking_pending' | 'booking_updated' = targetIsPending ? 'booking_pending' : 'booking_updated';
        const targetApprovalLinks = targetIsPending
          ? this.buildApprovalLinks(this.getPublicApiBase(req), notificationBooking.id)
          : null;
        const targetBookingUrl = this.buildBookingUrl(
          appUrl,
          notificationBooking.id,
          Number(booking.room_id),
          notificationBooking.start_time,
        );
        const targetChanges = Number(notificationBooking.id) === Number(updatedBooking.id) && Object.keys(changes).length > 0
          ? changes
          : undefined;
        const emailPayload = {
          event: targetEvent,
          booking_id: notificationBooking.id,
          room_id: Number(booking.room_id),
          title: notificationBooking.title,
          room: roomName,
          building: roomDetails.building,
          floor: roomDetails.floor,
          organizer: booking.organizer_email || req.user!.email,
          startTime: new Date(notificationBooking.start_time).toISOString(),
          endTime: new Date(notificationBooking.end_time).toISOString(),
          status: notificationBooking.status,
          durationMinutes: targetDurationMinutes,
          appUrl,
          bookingUrl: targetBookingUrl,
          approveUrl: targetApprovalLinks?.approveUrl,
          rejectUrl: targetApprovalLinks?.rejectUrl,
          equipment: targetEquipment,
          notes: notificationBooking.notes || undefined,
          custom_fields: targetCustomFields || undefined,
          changes: targetChanges,
        };
        webhookService.send(emailPayload);
        emailService.send(emailPayload);
        emailService.notifyRoomManagers(emailPayload);
      }

      res.json({ ...updatedBooking, affected_count: affectedCount });
    } catch (error) {
      console.error('Update booking error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async cancel(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reason, series_scope = 'single' } = req.body;

      if (!['single', 'following'].includes(series_scope)) {
        return res.status(400).json({ error: 'Series scope must be single or following' });
      }

      // Get existing booking
      const existing = await pool.query(
        `SELECT b.*, u.email AS organizer_email
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
         WHERE b.id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const booking = existing.rows[0] as any;

      // Check permissions
      if (booking.user_id !== req.user!.id && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      if (!['confirmed', 'pending'].includes(booking.status)) {
        return res.status(409).json({ error: `Cannot cancel a ${booking.status} booking` });
      }

      if (series_scope === 'following' && !booking.recurrence_id) {
        return res.status(400).json({ error: 'This booking is not part of a recurring series' });
      }

      const cancellationTargets = series_scope === 'following'
        ? (await pool.query(
            `SELECT * FROM bookings
             WHERE recurrence_id = $1
               AND status IN ('confirmed', 'pending')
               AND start_time >= $2
             ORDER BY start_time ASC`,
            [booking.recurrence_id, booking.start_time],
          )).rows as any[]
        : [booking];

      // Check cancellation notice rule
      const rules = await pool.query(
        `SELECT * FROM booking_rules
         WHERE rule_type = 'min_cancel_notice' AND is_enabled = true`
      );

      if (rules.rows.length > 0) {
        const rule = rules.rows[0] as any;
        const hoursNotice = rule.unit === 'hours' ? rule.value : rule.value / 60;
        const blockedTarget = cancellationTargets.find(target =>
          (new Date(target.start_time).getTime() - Date.now()) / (1000 * 60 * 60) < hoursNotice
        );

        if (blockedTarget && req.user!.role !== 'admin') {
          return res.status(400).json({
            error: `Must cancel at least ${hoursNotice} hours before booking`,
          });
        }
      }

      const cancelledBookings: any[] = [];
      const cancelAtomically = db.transaction(() => {
        const stmt = db.prepare(
          `UPDATE bookings
           SET status = 'cancelled',
               cancelled_at = CURRENT_TIMESTAMP,
               cancellation_reason = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
           RETURNING *`
        );
        let selected: any = null;
        for (const target of cancellationTargets) {
          const row = stmt.get(reason || null, target.id) as any;
          cancelledBookings.push(row);
          if (Number(target.id) === Number(id)) selected = row;
        }
        return selected;
      });
      const cancelledBooking = cancelAtomically();

      // Fire webhook (non-blocking)
      const roomDetails = await this.getRoomDetails(Number(booking.room_id));
      const roomName = roomDetails.name;
      const appUrl = this.getAppUrl(req);
      for (const cancelled of cancelledBookings) {
        const bookingUrl = this.buildBookingUrl(
          appUrl,
          cancelled.id,
          Number(cancelled.room_id),
          cancelled.start_time,
        );
        const emailPayload = {
          event: 'booking_cancelled' as const,
          booking_id: cancelled.id,
          room_id: Number(cancelled.room_id),
          title: cancelled.title,
          room: roomName,
          building: roomDetails.building,
          floor: roomDetails.floor,
          organizer: booking.organizer_email || req.user!.email,
          startTime: new Date(cancelled.start_time).toISOString(),
          endTime: new Date(cancelled.end_time).toISOString(),
          status: 'cancelled',
          durationMinutes: this.getDurationMinutes(cancelled.start_time, cancelled.end_time),
          appUrl,
          bookingUrl,
          reason: reason || 'No reason provided',
          custom_fields: this.parseCustomFields(cancelled.custom_fields) || undefined,
        };
        webhookService.send(emailPayload);
        emailService.send(emailPayload);
        emailService.notifyRoomManagers(emailPayload);
      }

      res.json({ ...cancelledBooking, affected_count: cancellationTargets.length });
    } catch (error) {
      console.error('Cancel booking error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async checkIn(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const bookingId = Number(id);
      if (!Number.isInteger(bookingId) || bookingId < 1) {
        return res.status(400).json({ error: 'Invalid booking id' });
      }

      const result = await pool.query(
        'SELECT * FROM bookings WHERE id = $1',
        [bookingId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const booking = result.rows[0] as any;
      const canCheckIn = Number(booking.user_id) === Number(req.user!.id)
        || ['admin', 'room_manager'].includes(req.user!.role);
      if (!canCheckIn) {
        return res.status(403).json({ error: 'You can only check in to your own bookings' });
      }
      if (booking.status !== 'confirmed') {
        return res.status(409).json({ error: `Cannot check in to a ${booking.status} booking` });
      }

      const ruleResult = await pool.query(
        `SELECT value, is_enabled FROM booking_rules
         WHERE rule_type = 'check_in_grace' LIMIT 1`
      );
      const rule = ruleResult.rows[0] as any;
      if (!rule || Number(rule.is_enabled) !== 1) {
        return res.status(409).json({ error: 'Check-in is not enabled' });
      }

      const graceMinutes = Math.min(240, Math.max(1, Number(rule.value) || 10));
      const earlyMinutes = 15;
      const startMs = new Date(booking.start_time).getTime();
      const endMs = new Date(booking.end_time).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return res.status(409).json({ error: 'Booking has invalid start or end times' });
      }
      const now = Date.now();
      const opensAt = startMs - earlyMinutes * 60_000;
      const closesAt = Math.min(endMs, startMs + graceMinutes * 60_000);
      if (now < opensAt) {
        return res.status(400).json({ error: `Check-in opens ${earlyMinutes} minutes before the booking starts` });
      }
      if (now > closesAt) {
        return res.status(400).json({ error: 'The check-in window has closed' });
      }

      const checkIn = db.prepare(
        `INSERT OR IGNORE INTO check_ins (booking_id, checked_in_by)
         VALUES (?, ?)`
      ).run(bookingId, req.user!.id);
      if (checkIn.changes === 0) {
        return res.status(409).json({ error: 'Already checked in' });
      }

      const created = db.prepare(
        'SELECT booking_id, checked_in_by, checked_in_at FROM check_ins WHERE booking_id = ?'
      ).get(bookingId);
      res.json({ message: 'Checked in successfully', check_in: created });
    } catch (error) {
      console.error('Check-in error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Booking templates (per-user)
  async getTemplates(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query(
        `SELECT * FROM booking_templates WHERE user_id = $1 ORDER BY created_at DESC`,
        [req.user!.id]
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Get templates error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createTemplate(req: AuthRequest, res: Response) {
    try {
      const { name, title, duration_minutes, equipment, notes, custom_fields } = req.body;
      const payloadError = validateTemplatePayload(req.body);
      if (payloadError) return res.status(400).json({ error: payloadError });
      const customFieldsError = await this.validateConfiguredCustomFields(custom_fields, { allowTemplateAttendeeCount: true, enforceRequired: false });
      if (customFieldsError) return res.status(400).json({ error: customFieldsError });
      if (!name || !title) {
        return res.status(400).json({ error: 'Template name and title are required' });
      }
      const duration = Number(duration_minutes) || 60;
      const result = await pool.query(
        `INSERT INTO booking_templates (user_id, name, title, duration_minutes, equipment, notes, custom_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.user!.id,
          name,
          title,
          duration,
          equipment ? JSON.stringify(equipment) : null,
          notes || null,
          custom_fields ? JSON.stringify(custom_fields) : null,
        ]
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create template error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateTemplate(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, title, duration_minutes, equipment, notes, custom_fields } = req.body;
      const payloadError = validateTemplatePayload(req.body, true);
      if (payloadError) return res.status(400).json({ error: payloadError });
      if (Object.prototype.hasOwnProperty.call(req.body, 'custom_fields')) {
        const customFieldsError = await this.validateConfiguredCustomFields(custom_fields, { allowTemplateAttendeeCount: true, enforceRequired: false });
        if (customFieldsError) return res.status(400).json({ error: customFieldsError });
      }

      const existing = await pool.query(
        `SELECT id FROM booking_templates WHERE id = $1 AND user_id = $2`,
        [id, req.user!.id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const duration = duration_minutes !== undefined ? Number(duration_minutes) : null;
      const hasEquipment = Object.prototype.hasOwnProperty.call(req.body, 'equipment');
      const hasNotes = Object.prototype.hasOwnProperty.call(req.body, 'notes');
      const hasCustomFields = Object.prototype.hasOwnProperty.call(req.body, 'custom_fields');
      const result = await pool.query(
        `UPDATE booking_templates
         SET name = COALESCE($1, name),
             title = COALESCE($2, title),
             duration_minutes = COALESCE($3, duration_minutes),
             equipment = CASE WHEN $4 = 1 THEN $5 ELSE equipment END,
             notes = CASE WHEN $6 = 1 THEN $7 ELSE notes END,
             custom_fields = CASE WHEN $8 = 1 THEN $9 ELSE custom_fields END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $10 AND user_id = $11
         RETURNING *`,
        [
          name,
          title,
          duration,
          hasEquipment ? 1 : 0,
          hasEquipment ? JSON.stringify(equipment) : null,
          hasNotes ? 1 : 0,
          notes ?? null,
          hasCustomFields ? 1 : 0,
          custom_fields === null ? null : JSON.stringify(custom_fields),
          id,
          req.user!.id,
        ]
      );
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update template error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteTemplate(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `DELETE FROM booking_templates WHERE id = $1 AND user_id = $2`,
        [id, req.user!.id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json({ message: 'Template deleted' });
    } catch (error) {
      console.error('Delete template error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const bookingsController = new BookingsController();
