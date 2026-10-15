import { pool } from '../config/database';
import { differenceInMinutes } from 'date-fns';

export interface RuleViolation {
  rule: string;
  message: string;
}

// Convert any value+unit combo to minutes
function toMinutes(value: number, unit: string): number {
  switch (unit) {
    case 'minutes': return value;
    case 'hours':   return value * 60;
    case 'days':    return value * 60 * 24;
    case 'weeks':   return value * 60 * 24 * 7;
    default:        return value;
  }
}

// Format a minutes value as a friendly string (e.g., 120 → "2 hours")
function fmtDuration(mins: number): string {
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440} day${mins / 1440 !== 1 ? 's' : ''}`;
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60} hour${mins / 60 !== 1 ? 's' : ''}`;
  return `${mins} minute${mins !== 1 ? 's' : ''}`;
}

export class BookingRulesService {
  async validateBooking(
    startTime: Date,
    endTime: Date,
    userId: number,
    roomId: number,
    userRole: string,
    bookingId?: number,
    options?: { skipBusinessHours?: boolean; excludeRecurrenceId?: number }
  ): Promise<RuleViolation[]> {
    const violations: RuleViolation[] = [];

    // Reject bookings in the past
    if (startTime <= new Date()) {
      violations.push({
        rule: 'past_time',
        message: 'Cannot create a booking in the past',
      });
      return violations;
    }

    // Get all active rules
    const rulesResult = await pool.query(
      `SELECT * FROM booking_rules
       WHERE is_enabled = true
       AND (applies_to_roles IS NULL OR instr(applies_to_roles, $1) > 0)`,
      [userRole]
    );

    const rules = rulesResult.rows;

    for (const rule of rules as any[]) {
      switch (rule.rule_type) {
        case 'max_duration':
          await this.checkMaxDuration(startTime, endTime, rule, violations);
          break;
        case 'room_duration_limits':
          await this.checkRoomDuration(startTime, endTime, roomId, violations);
          break;
        case 'buffer_time':
          await this.checkBufferTime(startTime, endTime, roomId, rule, violations, bookingId, options?.excludeRecurrenceId);
          break;
        case 'advance_window':
          await this.checkAdvanceWindow(startTime, rule, violations);
          break;
        case 'advance_window_privileged':
          await this.checkAdvanceWindow(startTime, rule, violations);
          break;
        case 'min_lead_time':
          await this.checkLeadTime(startTime, rule, violations);
          break;
        case 'daily_limit':
          await this.checkDailyLimit(startTime, endTime, userId, rule, violations, bookingId, options?.excludeRecurrenceId);
          break;
        case 'max_concurrent_bookings':
          await this.checkMaxConcurrentBookings(startTime, userId, rule, violations, bookingId, options?.excludeRecurrenceId);
          break;
        case 'max_bookings_per_room_per_day':
          await this.checkMaxBookingsPerRoomPerDay(startTime, roomId, rule, violations, bookingId, options?.excludeRecurrenceId);
          break;
        case 'business_hours':
          if (!options?.skipBusinessHours) {
            await this.checkBusinessHours(startTime, endTime, roomId, violations);
          }
          break;
        case 'after_hours_roles':
          await this.checkAfterHoursRoleRestriction(startTime, endTime, roomId, userRole, violations);
          break;
        case 'min_cancel_notice':
          // This is checked during cancellation
          break;
      }
    }

    // Check for conflicts with existing bookings
    await this.checkConflicts(startTime, endTime, roomId, violations, bookingId, options?.excludeRecurrenceId);

    // Check for holidays
    await this.checkHolidays(startTime, endTime, violations);

    // Check for maintenance windows
    await this.checkMaintenance(startTime, endTime, roomId, violations);

    // Check user suspension
    await this.checkUserSuspension(userId, violations);

    return violations;
  }

  private async checkMaxDuration(
    startTime: Date,
    endTime: Date,
    rule: any,
    violations: RuleViolation[]
  ) {
    const durationMins = differenceInMinutes(endTime, startTime);
    const maxMins = toMinutes(rule.value, rule.unit);

    if (durationMins > maxMins) {
      violations.push({
        rule: 'max_duration',
        message: `Booking duration (${fmtDuration(durationMins)}) exceeds maximum allowed (${fmtDuration(maxMins)})`,
      });
    }
  }

  private async checkRoomDuration(
    startTime: Date,
    endTime: Date,
    roomId: number,
    violations: RuleViolation[]
  ) {
    const roomResult = await pool.query(
      'SELECT min_duration_minutes, max_duration_minutes FROM rooms WHERE id = $1',
      [roomId]
    );
    if (roomResult.rows.length === 0) return;
    const room = roomResult.rows[0] as any;
    const durationMins = differenceInMinutes(endTime, startTime);
    const minMins = Number(room.min_duration_minutes) || 0;
    const maxMins = Number(room.max_duration_minutes) || 0;
    if (minMins > 0 && durationMins < minMins) {
      violations.push({
        rule: 'room_duration_limits',
        message: `Booking duration must be at least ${fmtDuration(minMins)} for this room`,
      });
    }
    if (maxMins > 0 && durationMins > maxMins) {
      violations.push({
        rule: 'room_duration_limits',
        message: `Booking duration cannot exceed ${fmtDuration(maxMins)} for this room`,
      });
    }
  }

  private async checkBufferTime(
    startTime: Date,
    endTime: Date,
    roomId: number,
    rule: any,
    violations: RuleViolation[],
    excludeBookingId?: number,
    excludeRecurrenceId?: number,
  ) {
    const roomResult = await pool.query(
      'SELECT buffer_minutes FROM rooms WHERE id = $1',
      [roomId]
    );
    const roomBuffer = roomResult.rows.length > 0 ? Number((roomResult.rows[0] as any).buffer_minutes) : NaN;
    const bufferMinutes = Number.isFinite(roomBuffer) && roomBuffer > 0
      ? roomBuffer
      : (Number(rule.value) || 15);

    let query = `
      SELECT * FROM bookings
      WHERE room_id = $1
      AND status IN ('confirmed', 'pending')
      AND (
        (datetime(start_time, '-${bufferMinutes} minutes') < $3 AND start_time > $2)
        OR
        (datetime(end_time, '+${bufferMinutes} minutes') > $2 AND end_time < $3)
      )
    `;

    const params: any[] = [roomId, startTime, endTime];

    if (excludeBookingId) {
      query += ' AND id != $4';
      params.push(excludeBookingId);
    }
    if (excludeRecurrenceId) {
      query += ` AND (recurrence_id IS NULL OR recurrence_id != $${params.length + 1})`;
      params.push(excludeRecurrenceId);
    }

    const result = await pool.query(query, params);

    if (result.rows.length > 0) {
      violations.push({
        rule: 'buffer_time',
        message: `Must have ${bufferMinutes} minute buffer between bookings`,
      });
    }
  }

  private async checkAdvanceWindow(
    startTime: Date,
    rule: any,
    violations: RuleViolation[]
  ) {
    const now = new Date();
    const advanceMs = toMinutes(rule.value, rule.unit) * 60 * 1000;
    const maxAdvanceDate = new Date(now.getTime() + advanceMs);

    if (startTime > maxAdvanceDate) {
      violations.push({
        rule: 'advance_window',
        message: `Cannot book more than ${rule.value} ${rule.unit} in advance`,
      });
    }
  }

  private async checkLeadTime(
    startTime: Date,
    rule: any,
    violations: RuleViolation[]
  ) {
    const now = new Date();
    const leadMs = toMinutes(rule.value, rule.unit) * 60 * 1000;
    const minStart = new Date(now.getTime() + leadMs);
    if (startTime < minStart) {
      violations.push({
        rule: 'min_lead_time',
        message: `Bookings must be made at least ${rule.value} ${rule.unit} in advance`,
      });
    }
  }

  private async checkMaxConcurrentBookings(
    startTime: Date,
    userId: number,
    rule: any,
    violations: RuleViolation[],
    excludeBookingId?: number,
    excludeRecurrenceId?: number,
  ) {
    const now = new Date();
    let query = `
      SELECT COUNT(*) as count FROM bookings
      WHERE user_id = $1
      AND status IN ('confirmed', 'pending')
      AND start_time >= $2
    `;
    const params: any[] = [userId, now];
    if (excludeBookingId) {
      query += ' AND id != $3';
      params.push(excludeBookingId);
    }
    if (excludeRecurrenceId) {
      query += ` AND (recurrence_id IS NULL OR recurrence_id != $${params.length + 1})`;
      params.push(excludeRecurrenceId);
    }
    const result = await pool.query(query, params);
    const count = Number((result.rows[0] as any)?.count || 0);
    const max = Number(rule.value) || 0;
    if (max > 0 && count >= max) {
      violations.push({
        rule: 'max_concurrent_bookings',
        message: `You already have ${count} upcoming bookings. Max allowed is ${max}.`,
      });
    }
  }

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

  private parseBusinessHours(raw: any): any | null {
    if (!raw) return null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && parsed.days) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private getLocalDayMinutes(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const weekday = parts.find(p => p.type === 'weekday')?.value || 'Sun';
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { day: map[weekday] ?? 0, minutes: hour * 60 + minute };
  }

  private async checkBusinessHours(
    startTime: Date,
    endTime: Date,
    roomId: number,
    violations: RuleViolation[]
  ) {
    const timezone = await this.getTimezone();
    const hours = await this.getBusinessHours(roomId);
    if (!hours || !hours.days) return;

    const startLocal = this.getLocalDayMinutes(startTime, timezone);
    const endLocal = this.getLocalDayMinutes(endTime, timezone);

    if (startLocal.day !== endLocal.day) {
      violations.push({
        rule: 'business_hours',
        message: 'Booking must be within a single business day',
      });
      return;
    }

    const dayConfig = hours.days[String(startLocal.day)];
    if (!dayConfig || !dayConfig.enabled) {
      violations.push({
        rule: 'business_hours',
        message: 'Bookings are not allowed on this day',
      });
      return;
    }

    const [startH, startM] = String(dayConfig.start || '00:00').split(':').map(Number);
    const [endH, endM] = String(dayConfig.end || '23:59').split(':').map(Number);
    const dayStart = (startH * 60) + (startM || 0);
    const dayEnd = (endH * 60) + (endM || 0);

    if (startLocal.minutes < dayStart || endLocal.minutes > dayEnd) {
      violations.push({
        rule: 'business_hours',
        message: `Booking must be within business hours (${dayConfig.start}–${dayConfig.end})`,
      });
    }
  }

  async isOutsideBusinessHours(startTime: Date, endTime: Date, roomId: number): Promise<boolean> {
    const timezone = await this.getTimezone();
    const hours = await this.getBusinessHours(roomId);
    if (!hours || !hours.days) return false;

    const startLocal = this.getLocalDayMinutes(startTime, timezone);
    const endLocal = this.getLocalDayMinutes(endTime, timezone);

    if (startLocal.day !== endLocal.day) return true;

    const dayConfig = hours.days[String(startLocal.day)];
    if (!dayConfig || !dayConfig.enabled) return true;

    const [startH, startM] = String(dayConfig.start || '00:00').split(':').map(Number);
    const [endH, endM] = String(dayConfig.end || '23:59').split(':').map(Number);
    const dayStart = (startH * 60) + (startM || 0);
    const dayEnd = (endH * 60) + (endM || 0);

    return startLocal.minutes < dayStart || endLocal.minutes > dayEnd;
  }

  private async checkAfterHoursRoleRestriction(
    startTime: Date,
    endTime: Date,
    roomId: number,
    userRole: string,
    violations: RuleViolation[]
  ) {
    if (['admin', 'room_manager'].includes(userRole)) return;
    const isAfterHours = await this.isOutsideBusinessHours(startTime, endTime, roomId);
    if (isAfterHours) {
      violations.push({
        rule: 'after_hours_roles',
        message: 'Only admins and room managers can book outside business hours',
      });
    }
  }

  private async checkMaxBookingsPerRoomPerDay(
    startTime: Date,
    roomId: number,
    rule: any,
    violations: RuleViolation[],
    excludeBookingId?: number,
    excludeRecurrenceId?: number,
  ) {
    const max = Number(rule.value) || 0;
    if (max <= 0) return;
    const timezone = await this.getTimezone();
    const dayStr = this.getDateStringInTimezone(startTime, timezone);
    const dayStart = this.buildZonedDate(dayStr, '00:00', timezone);
    const dayEnd = this.buildZonedDate(dayStr, '23:59', timezone);

    let query = `
      SELECT COUNT(*) as count FROM bookings
      WHERE room_id = $1
      AND status IN ('confirmed', 'pending')
      AND start_time >= $2
      AND start_time <= $3
    `;
    const params: any[] = [roomId, dayStart, dayEnd];
    if (excludeBookingId) {
      query += ' AND id != $4';
      params.push(excludeBookingId);
    }
    if (excludeRecurrenceId) {
      query += ` AND (recurrence_id IS NULL OR recurrence_id != $${params.length + 1})`;
      params.push(excludeRecurrenceId);
    }
    const result = await pool.query(query, params);
    const count = Number((result.rows[0] as any)?.count || 0);
    if (count >= max) {
      violations.push({
        rule: 'max_bookings_per_room_per_day',
        message: `This room already has ${count} booking(s) for that day. Max allowed is ${max}.`,
      });
    }
  }

  private async getBusinessHours(roomId: number) {
    const result = await pool.query(
      `SELECT r.business_hours AS room_hours, b.business_hours AS building_hours
       FROM rooms r
       LEFT JOIN buildings b ON r.building = b.name
       WHERE r.id = $1`,
      [roomId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    const roomHours = this.parseBusinessHours(row.room_hours);
    const buildingHours = this.parseBusinessHours(row.building_hours);
    if (roomHours || buildingHours) return roomHours || buildingHours;
    // Default hours when none are configured
    const defaultDay = { enabled: true, start: '08:00', end: '18:00' };
    return { days: { 0: defaultDay, 1: defaultDay, 2: defaultDay, 3: defaultDay, 4: defaultDay, 5: defaultDay, 6: defaultDay } };
  }

  private async checkDailyLimit(
    startTime: Date,
    endTime: Date,
    userId: number,
    rule: any,
    violations: RuleViolation[],
    excludeBookingId?: number,
    excludeRecurrenceId?: number,
  ) {
    const timezone = await this.getTimezone();
    const dayStr = this.getDateStringInTimezone(startTime, timezone);
    const dayStart = this.buildZonedDate(dayStr, '00:00', timezone);
    const dayEnd = this.buildZonedDate(dayStr, '23:59', timezone);

    let query = `
      SELECT start_time, end_time FROM bookings
      WHERE user_id = $1
      AND status IN ('confirmed', 'pending')
      AND start_time >= $2
      AND start_time <= $3
    `;

    const params: any[] = [userId, dayStart, dayEnd];

    if (excludeBookingId) {
      query += ' AND id != $4';
      params.push(excludeBookingId);
    }
    if (excludeRecurrenceId) {
      query += ` AND (recurrence_id IS NULL OR recurrence_id != $${params.length + 1})`;
      params.push(excludeRecurrenceId);
    }

    const result = await pool.query(query, params);

    let totalMinutes = 0;
    for (const booking of result.rows as any[]) {
      totalMinutes += differenceInMinutes(
        new Date(booking.end_time),
        new Date(booking.start_time)
      );
    }

    // Add new booking duration
    totalMinutes += differenceInMinutes(endTime, startTime);

    const maxMins = toMinutes(rule.value, rule.unit);

    if (totalMinutes > maxMins) {
      violations.push({
        rule: 'daily_limit',
        message: `Daily limit exceeded. Total: ${fmtDuration(totalMinutes)}, Max: ${fmtDuration(maxMins)}`,
      });
    }
  }

  private async getTimezone(): Promise<string> {
    try {
      const result = await pool.query('SELECT timezone FROM site_config WHERE id = 1');
      if (result.rows.length > 0 && (result.rows[0] as any).timezone) {
        return (result.rows[0] as any).timezone;
      }
    } catch (err) {
      // table may not exist yet
    }
    return 'America/Chicago';
  }

  private formatTime12h(isoString: string, timezone: string): string {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  private async checkConflicts(
    startTime: Date,
    endTime: Date,
    roomId: number,
    violations: RuleViolation[],
    excludeBookingId?: number,
    excludeRecurrenceId?: number,
  ) {
    let query = `
      SELECT b.start_time, b.end_time, b.title, u.name as organizer_name
      FROM bookings b
      LEFT JOIN users u ON b.user_id = u.id
      WHERE b.room_id = $1
      AND b.status IN ('confirmed', 'pending')
      AND (
        (b.start_time < $3 AND b.end_time > $2)
      )
    `;

    const params: any[] = [roomId, startTime, endTime];

    if (excludeBookingId) {
      query += ' AND b.id != $4';
      params.push(excludeBookingId);
    }
    if (excludeRecurrenceId) {
      query += ` AND (b.recurrence_id IS NULL OR b.recurrence_id != $${params.length + 1})`;
      params.push(excludeRecurrenceId);
    }

    const result = await pool.query(query, params);

    if (result.rows.length > 0) {
      const conflict = result.rows[0] as any;
      const tz = await this.getTimezone();
      const from = this.formatTime12h(conflict.start_time, tz);
      const to = this.formatTime12h(conflict.end_time, tz);
      const who = conflict.organizer_name || 'someone';
      violations.push({
        rule: 'conflict',
        message: `This room is already booked from ${from} to ${to} by ${who}`,
      });
    }
  }

  private async checkHolidays(
    startTime: Date,
    endTime: Date,
    violations: RuleViolation[]
  ) {
    const timezone = await this.getTimezone();
    const startDate = this.getDateStringInTimezone(startTime, timezone);
    const endDate = this.getDateStringInTimezone(endTime, timezone);
    const startMonthDay = startDate.slice(5);
    const endMonthDay = endDate.slice(5);
    const recurringClause = startMonthDay <= endMonthDay
      ? `(is_recurring = 1 AND strftime('%m-%d', date) BETWEEN $3 AND $4)`
      : `(is_recurring = 1 AND (strftime('%m-%d', date) >= $3 OR strftime('%m-%d', date) <= $4))`;
    const result = await pool.query(
      `SELECT name FROM holidays
       WHERE (is_recurring = 0 AND date >= date($1) AND date <= date($2))
          OR ${recurringClause}
       LIMIT 1`,
      [startDate, endDate, startMonthDay, endMonthDay]
    );

    if (result.rows.length > 0) {
      violations.push({
        rule: 'holiday',
        message: `Cannot book on holiday: ${(result.rows[0] as any).name}`,
      });
    }
  }

  private async checkMaintenance(
    startTime: Date,
    endTime: Date,
    roomId: number,
    violations: RuleViolation[]
  ) {
    const result = await pool.query(
      `SELECT reason FROM maintenance_windows
       WHERE room_id = $1
       AND start_time < $3
       AND end_time > $2`,
      [roomId, startTime, endTime]
    );

    if (result.rows.length > 0) {
      violations.push({
        rule: 'maintenance',
        message: `Room unavailable: ${(result.rows[0] as any).reason}`,
      });
    }
  }

  private async checkUserSuspension(userId: number, violations: RuleViolation[]) {
    const result = await pool.query(
      `SELECT suspension_until, no_show_count FROM users
       WHERE id = $1 AND suspension_until > CURRENT_TIMESTAMP`,
      [userId]
    );

    if (result.rows.length > 0) {
      violations.push({
        rule: 'suspension',
        message: `Account suspended until ${new Date(
          (result.rows[0] as any).suspension_until
        ).toLocaleDateString()} due to no-shows`,
      });
    }
  }
}

export const bookingRulesService = new BookingRulesService();
