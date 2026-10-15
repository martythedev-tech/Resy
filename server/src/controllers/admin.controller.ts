import { Response } from 'express';
import { pool } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { emailService } from '../services/email.service';
import { webhookService } from '../services/webhook.service';
import { directoryAuthService, DirectoryConfig } from '../services/directoryAuth.service';
import { bookingRetentionService } from '../services/bookingRetention.service';
import { bookingRulesService } from '../services/bookingRules.service';
import { aggregateTechnologyUsage, getCheckInOutcome, getDefaultReportRange, validateReportRange } from '../services/reporting.service';
import { normalizeStringList } from '../utils/stringList';
import bcrypt from 'bcryptjs';
import { validateBuildingPayload, validateRoomPayload } from '../utils/adminPayload';
import { validateWebhookUrl } from '../utils/webhookSecurity';
import { removeManagedUpload, removeUploadedFile } from '../utils/uploadLifecycle';
import { validateCustomFieldSchema } from '../utils/customFields';
import { validateBrandingUrl } from '../utils/brandingUrl';
import { recordOperationalWarning } from '../services/diagnostics.service';
import { webhookPolicyService } from '../services/webhookPolicy.service';

const VALID_TIMEZONES = [
  'America/New_York',    // Eastern
  'America/Chicago',     // Central
  'America/Denver',      // Mountain
  'America/Los_Angeles', // Pacific
  'America/Anchorage',   // Alaska
  'Pacific/Honolulu',    // Hawaii
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

async function removeUnreferencedBrandingUpload(url: unknown): Promise<void> {
  if (typeof url !== 'string' || !url.startsWith('/uploads/branding/')) return;
  const references = await pool.query(
    'SELECT 1 FROM site_config WHERE logo_url = $1 OR favicon_url = $1 LIMIT 1',
    [url]
  );
  if (references.rows.length === 0) await removeManagedUpload(url);
}

function rejectBrandingUpdate(req: AuthRequest, res: Response, field: string, error: string) {
  res.locals.diagnosticRecorded = true;
  recordOperationalWarning({
    source: 'branding',
    category: 'validation',
    message: 'Branding settings update rejected',
    requestId: res.locals.requestId || null,
    method: req.method,
    path: req.path,
    statusCode: 400,
    userId: req.user?.id || null,
    metadata: { field },
  });
  return res.status(400).json({ error });
}

function directoryConfigResponse(config: DirectoryConfig) {
  const configured = directoryAuthService.isConfigured(config);
  return {
    enabled: config.enabled,
    configured,
    config_source: directoryAuthService.getConfigSource(),
    directory_type: config.type,
    server_url: config.url,
    base_dn: config.baseDn,
    bind_dn: config.bindDn,
    has_bind_password: !!config.bindPassword,
    ca_cert_path: config.caCertPath,
    tls_reject_unauthorized: config.tlsRejectUnauthorized,
    allow_insecure_ldap: config.allowInsecureLdap,
    allow_local_fallback: config.allowLocalFallback,
    sync_roles: config.syncRoles,
    sync_profile: config.syncProfile,
    allowed_groups: config.allowedGroups,
    admin_groups: config.adminGroups,
    room_manager_groups: config.roomManagerGroups,
    timeout_ms: config.timeoutMs,
    connect_timeout_ms: config.connectTimeoutMs,
    auth_source: config.enabled && configured ? 'directory' : 'local',
  };
}

export class AdminController {
  async getWebhookPolicy(req: AuthRequest, res: Response) {
    try {
      const policy = await webhookPolicyService.getPolicy();
      res.json({
        allow_internal_destinations: policy.allowInternalDestinations,
        allowed_internal_origins: policy.allowedInternalOrigins,
      });
    } catch (error) {
      console.error('Get webhook policy error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateWebhookPolicy(req: AuthRequest, res: Response) {
    try {
      const policy = webhookPolicyService.normalizePolicy(req.body);
      const saved = await webhookPolicyService.savePolicy(policy);
      res.json({
        allow_internal_destinations: saved.allowInternalDestinations,
        allowed_internal_origins: saved.allowedInternalOrigins,
      });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Invalid webhook security policy' });
    }
  }

  async getDirectoryStatus(req: AuthRequest, res: Response) {
    try {
      res.json(directoryConfigResponse(directoryAuthService.getConfig()));
    } catch (error) {
      console.error('Get directory status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateDirectoryConfig(req: AuthRequest, res: Response) {
    try {
      const config = directoryAuthService.buildConfig(req.body || {});
      if (config.enabled) {
        await directoryAuthService.testConnection(config, false);
      }
      directoryAuthService.saveConfig(config);
      res.json(directoryConfigResponse(directoryAuthService.getConfig()));
    } catch (error: any) {
      const message = error?.message || 'Failed to save directory configuration';
      const isConnectionError = /ECONN|ETIMEDOUT|certificate|bind|socket|TLS|connect/i.test(message);
      if (isConnectionError) {
        res.locals.diagnosticRecorded = true;
        recordOperationalWarning({
          source: 'directory',
          category: 'configuration_test',
          message: 'Directory configuration could not be verified before saving',
          userId: req.user?.id || null,
        }, error);
      }
      res.status(isConnectionError ? 502 : 400).json({ error: message });
    }
  }

  async resetDirectoryConfig(req: AuthRequest, res: Response) {
    try {
      directoryAuthService.clearStoredConfig();
      res.json(directoryConfigResponse(directoryAuthService.getConfig()));
    } catch (error) {
      console.error('Reset directory configuration error:', error);
      res.status(500).json({ error: 'Failed to restore environment configuration' });
    }
  }

  async testDirectoryConnection(req: AuthRequest, res: Response) {
    try {
      const hasDraft = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
      const config = hasDraft
        ? directoryAuthService.buildConfig({ ...req.body, enabled: true })
        : directoryAuthService.getConfig();
      const result = await directoryAuthService.testConnection(config, !hasDraft);
      res.json({
        ok: true,
        host: result.host,
        port: result.port,
        latency_ms: result.latencyMs,
      });
    } catch (error: any) {
      const message = error?.message || 'Directory connection failed';
      const isConfigError = /disabled|incomplete|required|invalid|must be|DIRECTORY_URL|too many|overly long/i.test(message);
      if (!isConfigError) {
        res.locals.diagnosticRecorded = true;
        recordOperationalWarning({
          source: 'directory',
          category: 'connection_test',
          message: 'Directory connection test failed',
          userId: req.user?.id || null,
        }, error);
      }
      res.status(isConfigError ? 400 : 502).json({ error: message });
    }
  }

  // Holidays Management
  async getHolidays(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query(
        `SELECT h.*, u.name as created_by_name
         FROM holidays h
         LEFT JOIN users u ON h.created_by = u.id
         ORDER BY h.date DESC`
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Get holidays error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createHoliday(req: AuthRequest, res: Response) {
    try {
      const { name, date, is_recurring } = req.body;

      if (!name || !date) {
        return res.status(400).json({ error: 'Name and date required' });
      }
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
        return res.status(400).json({ error: 'Holiday name must be between 1 and 100 characters' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return res.status(400).json({ error: 'Holiday date must use YYYY-MM-DD format' });
      }
      const parsedDate = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        return res.status(400).json({ error: 'Holiday date is invalid' });
      }

      const result = await pool.query(
        `INSERT INTO holidays (name, date, is_recurring, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name.trim(), date, is_recurring ? 1 : 0, req.user!.id]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create holiday error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteHoliday(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      const result = await pool.query(
        'DELETE FROM holidays WHERE id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Holiday not found' });
      }

      res.json({ message: 'Holiday deleted' });
    } catch (error) {
      console.error('Delete holiday error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Maintenance Windows
  async getMaintenance(req: AuthRequest, res: Response) {
    try {
      const { room_id } = req.query;

      let query = `
        SELECT m.*, r.name as room_name, r.building, u.name as created_by_name
        FROM maintenance_windows m
        LEFT JOIN rooms r ON m.room_id = r.id
        LEFT JOIN users u ON m.created_by = u.id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (room_id) {
        query += ' AND m.room_id = $1';
        params.push(room_id);
      }

      query += ' ORDER BY m.start_time DESC';

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error) {
      console.error('Get maintenance error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createMaintenance(req: AuthRequest, res: Response) {
    try {
      const { room_id, start_time, end_time, reason } = req.body;

      if (!room_id || !start_time || !end_time || !reason) {
        return res.status(400).json({ error: 'All fields required' });
      }
      const roomId = Number(room_id);
      const startTime = new Date(start_time);
      const endTime = new Date(end_time);
      if (!Number.isInteger(roomId) || roomId < 1) {
        return res.status(400).json({ error: 'Invalid room' });
      }
      if (!Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime()) || endTime <= startTime) {
        return res.status(400).json({ error: 'Maintenance start and end times are invalid' });
      }
      if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
        return res.status(400).json({ error: 'Maintenance reason must be between 1 and 500 characters' });
      }
      const room = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
      if (room.rows.length === 0) {
        return res.status(404).json({ error: 'Room not found' });
      }
      const bookingOverlap = await pool.query(
        `SELECT id FROM bookings
         WHERE room_id = $1 AND status IN ('confirmed', 'pending')
           AND start_time < $3 AND end_time > $2
         LIMIT 1`,
        [roomId, startTime.toISOString(), endTime.toISOString()]
      );
      if (bookingOverlap.rows.length > 0) {
        return res.status(409).json({ error: 'Maintenance window overlaps an active booking' });
      }
      const maintenanceOverlap = await pool.query(
        `SELECT id FROM maintenance_windows
         WHERE room_id = $1 AND start_time < $3 AND end_time > $2
         LIMIT 1`,
        [roomId, startTime.toISOString(), endTime.toISOString()]
      );
      if (maintenanceOverlap.rows.length > 0) {
        return res.status(409).json({ error: 'Maintenance window overlaps existing maintenance' });
      }

      const result = await pool.query(
        `INSERT INTO maintenance_windows (room_id, start_time, end_time, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [roomId, startTime.toISOString(), endTime.toISOString(), reason.trim(), req.user!.id]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create maintenance error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteMaintenance(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      const result = await pool.query(
        'DELETE FROM maintenance_windows WHERE id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Maintenance window not found' });
      }

      res.json({ message: 'Maintenance window deleted' });
    } catch (error) {
      console.error('Delete maintenance error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Booking Rules Management
  async getRules(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query(
        'SELECT * FROM booking_rules ORDER BY rule_type'
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Get rules error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateRule(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { value, unit, is_enabled, description } = req.body;

      const currentRule = await pool.query(
        'SELECT rule_type, value, unit, is_enabled FROM booking_rules WHERE id = $1',
        [id]
      );
      if (currentRule.rows.length === 0) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      const current = currentRule.rows[0] as any;
      const allowedUnitsByRule: Record<string, string[]> = {
        max_duration: ['minutes', 'hours', 'days'],
        buffer_time: ['minutes'],
        advance_window: ['days', 'weeks'],
        advance_window_privileged: ['days', 'weeks'],
        min_lead_time: ['minutes', 'hours'],
        daily_limit: ['hours'],
        check_in_grace: ['minutes'],
        min_cancel_notice: ['minutes', 'hours'],
        no_show_limit: ['count'],
        capacity_warning: ['flag'],
        show_equipment: ['flag'],
        business_hours: ['none'],
        room_duration_limits: ['none'],
        booking_interval: ['minutes'],
        max_concurrent_bookings: ['count'],
        recurrence_limit: ['months'],
        max_bookings_per_room_per_day: ['count'],
        after_hours_roles: ['none'],
      };
      const nextValue = value !== undefined ? Number(value) : Number(current.value);
      const nextUnit = unit !== undefined ? String(unit) : String(current.unit);
      if (!Number.isInteger(nextValue) || nextValue < 0 || nextValue > 100000) {
        return res.status(400).json({ error: 'Rule value must be a whole number between 0 and 100000' });
      }
      const allowedUnits = allowedUnitsByRule[current.rule_type];
      if (allowedUnits && !allowedUnits.includes(nextUnit)) {
        return res.status(400).json({ error: `Invalid unit for ${current.rule_type}` });
      }
      if (is_enabled !== undefined && ![0, 1, false, true].includes(is_enabled)) {
        return res.status(400).json({ error: 'Rule enabled status must be true or false' });
      }
      const nextEnabled = is_enabled === undefined ? Number(current.is_enabled) === 1 : Boolean(is_enabled);
      if (nextEnabled && !['flag', 'none'].includes(nextUnit) && nextValue < 1) {
        return res.status(400).json({ error: 'Enabled rule values must be at least 1' });
      }
      if (description !== undefined && (typeof description !== 'string' || !description.trim() || description.length > 500)) {
        return res.status(400).json({ error: 'Rule description must be between 1 and 500 characters' });
      }
      if (current.rule_type === 'booking_interval') {
        if (![15, 30, 60].includes(nextValue)) {
          return res.status(400).json({ error: 'Booking interval must be 15, 30, or 60 minutes' });
        }
        if (nextUnit !== 'minutes') {
          return res.status(400).json({ error: 'Booking interval unit must be minutes' });
        }
      }

      const result = await pool.query(
        `UPDATE booking_rules
         SET value = COALESCE($1, value),
             unit = COALESCE($2, unit),
             is_enabled = COALESCE($3, is_enabled),
             description = COALESCE($4, description),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING *`,
        [value, unit, is_enabled, description, id]
      );

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update rule error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Analytics
  async getAnalytics(req: AuthRequest, res: Response) {
    try {
      const configResult = await pool.query('SELECT timezone, equipment_options FROM site_config WHERE id = 1');
      const siteConfig = configResult.rows[0] as { timezone?: string; equipment_options?: unknown } | undefined;
      const reportTimezone = siteConfig?.timezone || 'UTC';
      const defaultRange = getDefaultReportRange(reportTimezone);
      const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : defaultRange.startDate;
      const endDate = typeof req.query.end_date === 'string' ? req.query.end_date : defaultRange.endDate;
      const roomId = typeof req.query.room_id === 'string' && req.query.room_id !== '' ? Number(req.query.room_id) : null;

      const validatedRange = validateReportRange(startDate, endDate);
      if (!validatedRange) {
        return res.status(400).json({ error: 'Report dates must be valid YYYY-MM-DD values spanning 1 to 366 days' });
      }
      if (roomId !== null && (!Number.isInteger(roomId) || roomId < 1)) {
        return res.status(400).json({ error: 'Invalid room filter' });
      }

      const start = new Date(`${validatedRange.startDate}T00:00:00.000Z`);
      const end = new Date(`${validatedRange.endDate}T00:00:00.000Z`);
      const rangeDays = validatedRange.days;

      const exclusiveEnd = new Date(end);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      const queryStart = new Date(start);
      queryStart.setUTCDate(queryStart.getUTCDate() - 1);
      const queryEnd = new Date(exclusiveEnd);
      queryEnd.setUTCDate(queryEnd.getUTCDate() + 1);
      const startBound = `${queryStart.toISOString().slice(0, 10)} 00:00:00`;
      const endBound = `${queryEnd.toISOString().slice(0, 10)} 00:00:00`;
      const bookingParams: Array<string | number> = [startBound, endBound];
      const roomClause = roomId === null ? '' : ' AND b.room_id = $3';
      if (roomId !== null) bookingParams.push(roomId);

      const [bookingsResult, roomsResult] = await Promise.all([
        pool.query(
          `SELECT b.id, b.room_id, b.user_id, b.start_time, b.end_time, b.status,
                  b.attendees, b.attendee_count, b.equipment, r.name AS room_name, r.building,
                  r.capacity, u.name AS organizer_name, b.organizer_department AS department,
                  CASE WHEN ci.booking_id IS NULL THEN 0 ELSE 1 END AS checked_in
           FROM bookings b
           JOIN rooms r ON r.id = b.room_id
           LEFT JOIN users u ON u.id = b.user_id
           LEFT JOIN (SELECT booking_id FROM check_ins GROUP BY booking_id) ci ON ci.booking_id = b.id
           WHERE datetime(b.start_time) >= datetime($1)
             AND datetime(b.start_time) < datetime($2)${roomClause}
           ORDER BY datetime(b.start_time) DESC`,
          bookingParams
        ),
        pool.query('SELECT id, name, building, capacity, equipment, is_active FROM rooms ORDER BY building, name'),
      ]);

      const parseArray = (value: unknown): unknown[] => {
        if (Array.isArray(value)) return value;
        if (typeof value !== 'string' || !value.trim()) return [];
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      const round = (value: number, places = 1) => Number(value.toFixed(places));
      const activeStatuses = new Set(['confirmed', 'no_show']);
      const localDateFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: reportTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long', hour: 'numeric', hourCycle: 'h23',
      });
      const getLocalParts = (date: Date) => {
        const parts = Object.fromEntries(localDateFormatter.formatToParts(date).map(part => [part.type, part.value]));
        return {
          date: `${parts.year}-${parts.month}-${parts.day}`,
          weekday: parts.weekday,
          hour: Number(parts.hour) % 24,
        };
      };
      const bookings = (bookingsResult.rows as Array<Record<string, any>>).filter(booking => {
        const date = new Date(booking.start_time);
        if (Number.isNaN(date.getTime())) return false;
        const localDate = getLocalParts(date).date;
        return localDate >= startDate && localDate <= endDate;
      });
      const statusCounts: Record<string, number> = { confirmed: 0, pending: 0, cancelled: 0, no_show: 0 };
      const roomMap = new Map<number, any>();
      const technologyRequests: unknown[] = [];
      const departmentMap = new Map<string, { bookingCount: number; bookedHours: number }>();
      const dayMap = new Map<string, { bookingCount: number; bookedHours: number }>();
      const hourCounts = Array.from({ length: 24 }, () => 0);
      const weekdayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const weekdayCounts = weekdayLabels.map(label => ({ label, bookingCount: 0 }));
      let bookedHours = 0;
      let attendeeTotal = 0;
      let attendeeBookings = 0;
      let checkedInCount = 0;
      let checkInTrackedCount = 0;
      let trackedNoShows = 0;
      const organizerIds = new Set<number>();

      for (const room of roomsResult.rows as Array<Record<string, any>>) {
        roomMap.set(Number(room.id), {
          roomId: Number(room.id), roomName: room.name, building: room.building,
          capacity: Number(room.capacity || 0), isActive: Boolean(room.is_active),
          bookingCount: 0, bookedHours: 0, checkIns: 0, noShows: 0,
          cancellations: 0, attendeeTotal: 0, attendeeBookings: 0, uniqueOrganizers: new Set<number>(),
        });
      }

      const exportRows = bookings.map(booking => {
        const status = String(booking.status || 'confirmed');
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        const startTime = new Date(booking.start_time);
        const endTime = new Date(booking.end_time);
        const durationHours = Math.max(0, (endTime.getTime() - startTime.getTime()) / 3600000);
        const attendees = parseArray(booking.attendees);
        const hasStoredAttendeeCount = booking.attendee_count !== null && booking.attendee_count !== undefined && booking.attendee_count !== '';
        const storedAttendeeCount = Number(booking.attendee_count);
        const attendeeCount: number | null = hasStoredAttendeeCount && Number.isInteger(storedAttendeeCount) && storedAttendeeCount >= 0
          ? storedAttendeeCount
          : attendees.length > 0 ? attendees.length : null;
        const equipment = normalizeStringList(booking.equipment);
        const isActiveBooking = activeStatuses.has(status);
        const checkedIn = Number(booking.checked_in) === 1;
        const checkInOutcome = getCheckInOutcome(status, booking.checked_in);
        const room = roomMap.get(Number(booking.room_id));

        if (isActiveBooking) {
          bookedHours += durationHours;
          if (attendeeCount !== null) {
            attendeeTotal += attendeeCount;
            attendeeBookings += 1;
          }
          if (booking.user_id) organizerIds.add(Number(booking.user_id));
          technologyRequests.push(equipment);

          const localParts = getLocalParts(startTime);
          const day = localParts.date;
          const dayStats = dayMap.get(day) || { bookingCount: 0, bookedHours: 0 };
          dayStats.bookingCount += 1;
          dayStats.bookedHours += durationHours;
          dayMap.set(day, dayStats);

          if (!Number.isNaN(startTime.getTime())) {
            hourCounts[localParts.hour] += 1;
            const weekday = weekdayCounts.find(item => item.label === localParts.weekday);
            if (weekday) weekday.bookingCount += 1;
          }

          const department = String(booking.department || 'Unassigned');
          const departmentStats = departmentMap.get(department) || { bookingCount: 0, bookedHours: 0 };
          departmentStats.bookingCount += 1;
          departmentStats.bookedHours += durationHours;
          departmentMap.set(department, departmentStats);
        }

        if (checkInOutcome === 'checked_in') checkedInCount += 1;
        if (checkInOutcome) checkInTrackedCount += 1;
        if (checkInOutcome === 'no_show') trackedNoShows += 1;
        if (room) {
          if (isActiveBooking) {
            room.bookingCount += 1;
            room.bookedHours += durationHours;
            if (attendeeCount !== null) {
              room.attendeeTotal += attendeeCount;
              room.attendeeBookings += 1;
            }
            if (booking.user_id) room.uniqueOrganizers.add(Number(booking.user_id));
          }
          if (checkInOutcome === 'checked_in') room.checkIns += 1;
          if (status === 'no_show') room.noShows += 1;
          if (status === 'cancelled') room.cancellations += 1;
        }

        return {
          bookingId: Number(booking.id), date: getLocalParts(startTime).date,
          startTime: booking.start_time, endTime: booking.end_time,
          room: booking.room_name, building: booking.building, status,
          durationHours: round(durationHours, 2), checkedIn, checkInOutcome,
          attendeeCount, equipment,
          organizer: booking.organizer_name || 'Anonymized', department: booking.department || 'Unassigned',
        };
      });

      const dailyTrend = Array.from({ length: rangeDays }, (_, offset) => {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + offset);
        const key = date.toISOString().slice(0, 10);
        const item = dayMap.get(key) || { bookingCount: 0, bookedHours: 0 };
        return { date: key, bookingCount: item.bookingCount, bookedHours: round(item.bookedHours) };
      });

      const roomUsage = Array.from(roomMap.values())
        .filter(room => roomId === null || room.roomId === roomId)
        .map(room => ({
          roomId: room.roomId, roomName: room.roomName, building: room.building,
          capacity: room.capacity, isActive: room.isActive,
          bookingCount: room.bookingCount, bookedHours: round(room.bookedHours),
          checkIns: room.checkIns, noShows: room.noShows, cancellations: room.cancellations,
          averageAttendees: room.attendeeBookings ? round(room.attendeeTotal / room.attendeeBookings) : null,
          uniqueOrganizers: room.uniqueOrganizers.size,
        }))
        .sort((a, b) => b.bookedHours - a.bookedHours || b.bookingCount - a.bookingCount);
      const rooms = (roomsResult.rows as Array<Record<string, any>>).map(room => ({
        roomId: Number(room.id), roomName: room.name, building: room.building,
        capacity: Number(room.capacity || 0), isActive: Boolean(room.is_active),
      }));

      res.json({
        range: { startDate, endDate, days: rangeDays, roomId, timezone: reportTimezone },
        summary: {
          totalBookings: bookings.length,
          activeBookings: statusCounts.confirmed + statusCounts.no_show,
          bookedHours: round(bookedHours),
          averageDurationHours: statusCounts.confirmed + statusCounts.no_show ? round(bookedHours / (statusCounts.confirmed + statusCounts.no_show)) : 0,
          averageAttendees: attendeeBookings ? round(attendeeTotal / attendeeBookings) : null,
          attendanceRecordedCount: attendeeBookings,
          uniqueOrganizers: organizerIds.size,
          checkedInCount,
          checkInTrackedCount,
          // Retained for API compatibility; this now means bookings with a persisted outcome.
          checkInEligible: checkInTrackedCount,
          checkInRate: checkInTrackedCount ? round((checkedInCount / checkInTrackedCount) * 100) : null,
          noShowRate: checkInTrackedCount ? round((trackedNoShows / checkInTrackedCount) * 100) : null,
        },
        statusCounts,
        rooms,
        roomUsage,
        technologyUsage: aggregateTechnologyUsage(technologyRequests, siteConfig?.equipment_options),
        departmentUsage: Array.from(departmentMap, ([name, stats]) => ({ name, bookingCount: stats.bookingCount, bookedHours: round(stats.bookedHours) })).sort((a, b) => b.bookedHours - a.bookedHours),
        dailyTrend,
        peakHours: hourCounts.map((bookingCount, hour) => ({ hour, bookingCount })).filter(item => item.bookingCount > 0).sort((a, b) => b.bookingCount - a.bookingCount).slice(0, 6),
        weekdayUsage: weekdayCounts.sort((a, b) => b.bookingCount - a.bookingCount),
        exportRows,
      });
    } catch (error) {
      console.error('Get analytics error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Building Management
  async getBuildings(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query('SELECT * FROM buildings ORDER BY name');
      res.json(result.rows);
    } catch (error) {
      console.error('Get buildings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createBuilding(req: AuthRequest, res: Response) {
    try {
      const { name, description, business_hours } = req.body;
      const payloadError = validateBuildingPayload(req.body);
      if (payloadError) return res.status(400).json({ error: payloadError });

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const result = await pool.query(
        `INSERT INTO buildings (name, description, business_hours)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [name, description || null, business_hours ? JSON.stringify(business_hours) : null]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create building error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateBuilding(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, description, is_active, business_hours } = req.body;
      const payloadError = validateBuildingPayload(req.body, true);
      if (payloadError) return res.status(400).json({ error: payloadError });
      const hasBusinessHours = Object.prototype.hasOwnProperty.call(req.body, 'business_hours');
      if (is_active !== undefined && ![0, 1, false, true].includes(is_active)) {
        return res.status(400).json({ error: 'Building active status must be true or false' });
      }

      // Fetch current name so we can cascade a rename to rooms
      const existing = await pool.query(
        'SELECT name FROM buildings WHERE id = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Building not found' });
      }

      const oldName = (existing.rows[0] as any).name;

      if (is_active === 0 || is_active === false) {
        const activeBookings = await pool.query(
          `SELECT COUNT(*) AS count
           FROM bookings bk
           JOIN rooms r ON r.id = bk.room_id
           WHERE r.building = $1 AND bk.status IN ('confirmed', 'pending')
             AND datetime(bk.end_time) >= datetime('now')`,
          [oldName]
        );
        if (Number((activeBookings.rows[0] as any)?.count || 0) > 0) {
          return res.status(409).json({ error: 'Cancel or reassign active future bookings before deactivating this building' });
        }
      }

      const businessHoursValue = hasBusinessHours
        ? (business_hours ? JSON.stringify(business_hours) : null)
        : undefined;

      const result = await pool.query(
        `UPDATE buildings
         SET name = COALESCE($1, name),
             description = COALESCE($2, description),
             is_active = COALESCE($3, is_active),
             business_hours = ${hasBusinessHours ? '$4' : 'business_hours'},
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ${hasBusinessHours ? '$5' : '$4'}
         RETURNING *`,
        hasBusinessHours
          ? [name, description, is_active, businessHoursValue, id]
          : [name, description, is_active, id]
      );

      // If the name changed, update all rooms that referenced the old name
      if (name && name !== oldName) {
        await pool.query(
          'UPDATE rooms SET building = $1 WHERE building = $2',
          [name, oldName]
        );
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update building error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteBuilding(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      // Check if any rooms reference this building
      const buildingResult = await pool.query('SELECT name, image_url FROM buildings WHERE id = $1', [id]);
      if (buildingResult.rows.length === 0) {
        return res.status(404).json({ error: 'Building not found' });
      }

      const buildingName = (buildingResult.rows[0] as any).name;
      const roomCount = await pool.query(
        'SELECT COUNT(*) as count FROM rooms WHERE building = $1',
        [buildingName]
      );

      if ((roomCount.rows[0] as any).count > 0) {
        return res.status(400).json({ error: 'Cannot delete building with active rooms. Remove rooms first.' });
      }

      await pool.query('DELETE FROM buildings WHERE id = $1', [id]);
      await removeManagedUpload((buildingResult.rows[0] as any).image_url);
      res.json({ message: 'Building deleted' });
    } catch (error) {
      console.error('Delete building error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async uploadBuildingImage(req: AuthRequest, res: Response) {
    const file = (req as any).file;
    let uploadCommitted = false;
    try {
      const { id } = req.params;

      if (!file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const imageUrl = `/uploads/buildings/${file.filename}`;
      const existing = await pool.query('SELECT image_url FROM buildings WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        await removeUploadedFile(file);
        return res.status(404).json({ error: 'Building not found' });
      }

      const result = await pool.query(
        'UPDATE buildings SET image_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [imageUrl, id]
      );

      uploadCommitted = true;
      await removeManagedUpload((existing.rows[0] as any).image_url);
      res.json(result.rows[0]);
    } catch (error) {
      if (!uploadCommitted) await removeUploadedFile(file);
      console.error('Upload building image error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Room Management
  async getRooms(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query('SELECT * FROM rooms ORDER BY building, floor, name');
      res.json(result.rows);
    } catch (error) {
      console.error('Get rooms error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createRoom(req: AuthRequest, res: Response) {
    try {
      const { name, building, floor, capacity, equipment, requires_approval, business_hours, min_duration_minutes, max_duration_minutes, buffer_minutes } = req.body;
      const payloadError = validateRoomPayload(req.body);
      if (payloadError) return res.status(400).json({ error: payloadError });

      if (!name || !building || !floor || !capacity) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!Number.isInteger(Number(floor)) || Number(floor) < 1 || !Number.isInteger(Number(capacity)) || Number(capacity) < 1) {
        return res.status(400).json({ error: 'Floor and capacity must be positive whole numbers' });
      }
      const buildingExists = await pool.query('SELECT id FROM buildings WHERE name = $1', [building]);
      if (buildingExists.rows.length === 0) {
        return res.status(400).json({ error: 'Building does not exist' });
      }

      if (min_duration_minutes && max_duration_minutes && Number(min_duration_minutes) > Number(max_duration_minutes)) {
        return res.status(400).json({ error: 'Minimum duration cannot exceed maximum duration' });
      }
      const result = await pool.query(
        `INSERT INTO rooms (name, building, floor, capacity, equipment, requires_approval, business_hours, min_duration_minutes, max_duration_minutes, buffer_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          name,
          building,
          floor,
          capacity,
          JSON.stringify(equipment || []),
          requires_approval || 0,
          business_hours ? JSON.stringify(business_hours) : null,
          min_duration_minutes ?? null,
          max_duration_minutes ?? null,
          buffer_minutes ?? 15,
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create room error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateRoom(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, building, floor, capacity, equipment, is_active, requires_approval, business_hours, min_duration_minutes, max_duration_minutes, buffer_minutes } = req.body;
      const payloadError = validateRoomPayload(req.body, true);
      if (payloadError) return res.status(400).json({ error: payloadError });
      const hasBusinessHours = Object.prototype.hasOwnProperty.call(req.body, 'business_hours');
      if (is_active !== undefined && ![0, 1, false, true].includes(is_active)) {
        return res.status(400).json({ error: 'Room active status must be true or false' });
      }

      if (min_duration_minutes && max_duration_minutes && Number(min_duration_minutes) > Number(max_duration_minutes)) {
        return res.status(400).json({ error: 'Minimum duration cannot exceed maximum duration' });
      }
      if (floor !== undefined && (!Number.isInteger(Number(floor)) || Number(floor) < 1)) {
        return res.status(400).json({ error: 'Floor must be a positive whole number' });
      }
      if (capacity !== undefined && (!Number.isInteger(Number(capacity)) || Number(capacity) < 1)) {
        return res.status(400).json({ error: 'Capacity must be a positive whole number' });
      }
      if (building !== undefined) {
        const buildingExists = await pool.query('SELECT id FROM buildings WHERE name = $1', [building]);
        if (buildingExists.rows.length === 0) {
          return res.status(400).json({ error: 'Building does not exist' });
        }
      }
      if (is_active === 0 || is_active === false) {
        const activeBookings = await pool.query(
          `SELECT COUNT(*) AS count FROM bookings
           WHERE room_id = $1 AND status IN ('confirmed', 'pending')
             AND datetime(end_time) >= datetime('now')`,
          [id]
        );
        if (Number((activeBookings.rows[0] as any)?.count || 0) > 0) {
          return res.status(409).json({ error: 'Cancel or reassign active future bookings before deactivating this room' });
        }
      }

      const businessHoursValue = hasBusinessHours
        ? (business_hours ? JSON.stringify(business_hours) : null)
        : undefined;

      const result = await pool.query(
        `UPDATE rooms
         SET name = COALESCE($1, name),
             building = COALESCE($2, building),
             floor = COALESCE($3, floor),
             capacity = COALESCE($4, capacity),
             equipment = COALESCE($5, equipment),
             is_active = COALESCE($6, is_active),
             requires_approval = COALESCE($7, requires_approval),
             business_hours = ${hasBusinessHours ? '$8' : 'business_hours'},
             min_duration_minutes = COALESCE(${hasBusinessHours ? '$9' : '$8'}, min_duration_minutes),
             max_duration_minutes = COALESCE(${hasBusinessHours ? '$10' : '$9'}, max_duration_minutes),
             buffer_minutes = COALESCE(${hasBusinessHours ? '$11' : '$10'}, buffer_minutes),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ${hasBusinessHours ? '$12' : '$11'}
         RETURNING *`,
        hasBusinessHours
          ? [
              name,
              building,
              floor,
              capacity,
              equipment ? JSON.stringify(equipment) : null,
              is_active,
              requires_approval,
              businessHoursValue,
              min_duration_minutes ?? null,
              max_duration_minutes ?? null,
              buffer_minutes ?? null,
              id,
            ]
          : [
              name,
              building,
              floor,
              capacity,
              equipment ? JSON.stringify(equipment) : null,
              is_active,
              requires_approval,
              min_duration_minutes ?? null,
              max_duration_minutes ?? null,
              buffer_minutes ?? null,
              id,
            ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Room not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update room error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteRoom(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      const existing = await pool.query('SELECT id, is_active, image_url FROM rooms WHERE id = $1', [id]);

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Room not found' });
      }

      const bookingCount = await pool.query('SELECT COUNT(*) AS count FROM bookings WHERE room_id = $1', [id]);
      if (Number((bookingCount.rows[0] as any)?.count || 0) > 0) {
        const activeBookingCount = await pool.query(
          `SELECT COUNT(*) AS count FROM bookings
           WHERE room_id = $1 AND status IN ('confirmed', 'pending')
             AND datetime(end_time) >= datetime('now')`,
          [id]
        );
        if (Number((activeBookingCount.rows[0] as any)?.count || 0) > 0) {
          return res.status(409).json({ error: 'Cancel or reassign active future bookings before retiring this room' });
        }
        await pool.query('UPDATE rooms SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
        return res.json({ message: 'Room retired to preserve booking history', retired: true });
      }

      await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
      await removeManagedUpload((existing.rows[0] as any).image_url);

      res.json({ message: 'Room deleted' });
    } catch (error) {
      console.error('Delete room error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async uploadRoomImage(req: AuthRequest, res: Response) {
    const file = (req as any).file;
    let uploadCommitted = false;
    try {
      const { id } = req.params;

      if (!file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const imageUrl = `/uploads/rooms/${file.filename}`;
      const existing = await pool.query('SELECT image_url FROM rooms WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        await removeUploadedFile(file);
        return res.status(404).json({ error: 'Room not found' });
      }

      const result = await pool.query(
        'UPDATE rooms SET image_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [imageUrl, id]
      );

      uploadCommitted = true;
      await removeManagedUpload((existing.rows[0] as any).image_url);
      res.json(result.rows[0]);
    } catch (error) {
      if (!uploadCommitted) await removeUploadedFile(file);
      console.error('Upload room image error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Webhook Management
  async getWebhooks(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query('SELECT * FROM webhook_configs ORDER BY created_at DESC');
      res.json(result.rows);
    } catch (error) {
      console.error('Get webhooks error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createWebhook(req: AuthRequest, res: Response) {
    try {
      const { service_type, webhook_url, events } = req.body;

      if (!service_type || !webhook_url) {
        return res.status(400).json({ error: 'service_type and webhook_url are required' });
      }

      if (!['slack', 'teams', 'rocket'].includes(service_type)) {
        return res.status(400).json({ error: 'service_type must be slack, teams, or rocket' });
      }

      // Validate webhook URL (SSRF protection)
      const urlCheck = await validateWebhookUrl(webhook_url, await webhookPolicyService.getPolicy());
      if (!urlCheck.valid) {
        return res.status(400).json({ error: urlCheck.error });
      }

      const result = await pool.query(
        `INSERT INTO webhook_configs (service_type, webhook_url, events)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [service_type, webhook_url, JSON.stringify(events || ['booking_created', 'booking_cancelled', 'no_show'])]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateWebhook(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { webhook_url, is_enabled, events } = req.body;

      // Validate webhook URL if being updated (SSRF protection)
      if (webhook_url) {
        const urlCheck = await validateWebhookUrl(webhook_url, await webhookPolicyService.getPolicy());
        if (!urlCheck.valid) {
          return res.status(400).json({ error: urlCheck.error });
        }
      }

      const result = await pool.query(
        `UPDATE webhook_configs
         SET webhook_url = COALESCE($1, webhook_url),
             is_enabled = COALESCE($2, is_enabled),
             events = COALESCE($3, events),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [webhook_url, is_enabled, events ? JSON.stringify(events) : null, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteWebhook(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      const result = await pool.query('DELETE FROM webhook_configs WHERE id = $1 RETURNING *', [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      res.json({ message: 'Webhook deleted' });
    } catch (error) {
      console.error('Delete webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Email Configuration
  async getEmailConfig(req: AuthRequest, res: Response) {
    try {
      let config = await emailService.getConfig();

      if (!config) {
        await pool.query(
          `INSERT INTO email_config (id, smtp_host, smtp_port, smtp_user, smtp_password, from_email, from_name, is_enabled)
           VALUES (1, '', 587, '', '', '', 'Resy', 0)`
        );
        config = await emailService.getConfig();
      }

      const safe = { ...config, smtp_password: config!.smtp_password ? '••••••••' : '' };
      res.json(safe);
    } catch (error) {
      console.error('Get email config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateEmailConfig(req: AuthRequest, res: Response) {
    try {
      const { smtp_host, smtp_port, smtp_user, smtp_password, from_email, from_name, is_enabled } = req.body;

      const passwordUpdate = smtp_password && smtp_password !== '••••••••' ? smtp_password : null;

      const result = await pool.query(
        `UPDATE email_config
         SET smtp_host = COALESCE($1, smtp_host),
             smtp_port = COALESCE($2, smtp_port),
             smtp_user = COALESCE($3, smtp_user),
             smtp_password = COALESCE($4, smtp_password),
             from_email = COALESCE($5, from_email),
             from_name = COALESCE($6, from_name),
             is_enabled = COALESCE($7, is_enabled),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1
         RETURNING *`,
        [smtp_host, smtp_port, smtp_user, passwordUpdate, from_email, from_name, is_enabled]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Email config not found. Call GET first to initialize.' });
      }

      const config = result.rows[0] as any;
      res.json({ ...config, smtp_password: config.smtp_password ? '••••••••' : '' });
    } catch (error) {
      console.error('Update email config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async testEmail(req: AuthRequest, res: Response) {
    try {
      const { to } = req.body;

      if (!to) {
        return res.status(400).json({ error: 'Recipient email address is required' });
      }

      await emailService.testEmail(to);
      res.json({ message: 'Test email sent successfully' });
    } catch (error: any) {
      res.locals.diagnosticRecorded = true;
      recordOperationalWarning({
        source: 'email',
        category: 'connection_test',
        message: 'SMTP connection or delivery test failed',
        userId: req.user?.id || null,
      }, error);
      res.status(400).json({ error: error.message || 'Failed to send test email' });
    }
  }

  // Valid timezones for the application
  // Site Branding Configuration
  async getSiteConfig(req: AuthRequest, res: Response) {
    try {
      let result: any = await pool.query('SELECT * FROM site_config WHERE id = 1');

      if (result.rows.length === 0) {
        // Initialize with minimal defaults (no equipment options until configured by admin)
        await pool.query(
          `INSERT INTO site_config (id, company_name, primary_color, timezone, calendar_default_view, equipment_options, custom_fields)
           VALUES (1, 'Resy', '#4F46E5', 'America/Chicago', 'day', $1, $2)`,
          [JSON.stringify([]), JSON.stringify([])]
        );
        result = await pool.query('SELECT * FROM site_config WHERE id = 1');
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Get site config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateSiteConfig(req: AuthRequest, res: Response) {
    try {
      const {
        company_name, logo_url, primary_color, accent_color, brand_tagline, logo_size,
        favicon_url, timezone, calendar_default_view, equipment_options, custom_fields,
      } = req.body;
      // Nullable asset columns are returned as null for a new installation. Treat
      // that representation as an empty optional URL when a full form is saved.
      const normalizedLogoUrl = logo_url === null ? '' : logo_url;
      const normalizedFaviconUrl = favicon_url === null ? '' : favicon_url;

      // Validate primary_color is a valid hex color if provided
      if (primary_color && !/^#[0-9A-Fa-f]{6}$/.test(primary_color)) {
        return rejectBrandingUpdate(req, res, 'primary_color', 'Invalid color format. Use hex format like #4F46E5');
      }

      if (accent_color && !/^#[0-9A-Fa-f]{6}$/.test(accent_color)) {
        return rejectBrandingUpdate(req, res, 'accent_color', 'Invalid accent color format. Use hex format like #14B8A6');
      }

      if (brand_tagline !== undefined && (typeof brand_tagline !== 'string' || brand_tagline.trim().length > 40)) {
        return rejectBrandingUpdate(req, res, 'brand_tagline', 'Brand tagline must be 40 characters or fewer');
      }

      if (logo_size !== undefined && !['small', 'medium', 'large'].includes(logo_size)) {
        return rejectBrandingUpdate(req, res, 'logo_size', 'Invalid logo size');
      }

      if (logo_url !== undefined) {
        const error = validateBrandingUrl(normalizedLogoUrl, 'Logo');
        if (error) return rejectBrandingUpdate(req, res, 'logo_url', error);
      }
      if (favicon_url !== undefined) {
        const error = validateBrandingUrl(normalizedFaviconUrl, 'Favicon');
        if (error) return rejectBrandingUpdate(req, res, 'favicon_url', error);
      }

      // Validate timezone if provided
      if (timezone && !VALID_TIMEZONES.includes(timezone)) {
        return rejectBrandingUpdate(req, res, 'timezone', 'Invalid timezone');
      }

      if (calendar_default_view !== undefined && !['day', 'week', 'month'].includes(calendar_default_view)) {
        return rejectBrandingUpdate(req, res, 'calendar_default_view', 'Invalid calendar default view');
      }

      let equipmentOptionsJson: string | null = null;
      if (equipment_options !== undefined) {
        const options = Array.isArray(equipment_options)
          ? equipment_options
          : typeof equipment_options === 'string'
            ? equipment_options.split(',').map((s: string) => s.trim()).filter(Boolean)
            : [];
        equipmentOptionsJson = JSON.stringify(options);
      }

      let customFieldsJson: string | null = null;
      if (custom_fields !== undefined) {
        const error = validateCustomFieldSchema(custom_fields);
        if (error) return rejectBrandingUpdate(req, res, 'custom_fields', error);
        customFieldsJson = JSON.stringify(custom_fields);
      }

      const previous = (normalizedLogoUrl !== undefined || normalizedFaviconUrl !== undefined)
        ? await pool.query('SELECT logo_url, favicon_url FROM site_config WHERE id = 1')
        : { rows: [] };
      const result = await pool.query(
        `UPDATE site_config
         SET company_name = COALESCE($1, company_name),
             logo_url = COALESCE($2, logo_url),
             primary_color = COALESCE($3, primary_color),
             accent_color = COALESCE($4, accent_color),
             brand_tagline = COALESCE($5, brand_tagline),
             logo_size = COALESCE($6, logo_size),
             favicon_url = COALESCE($7, favicon_url),
             timezone = COALESCE($8, timezone),
             calendar_default_view = COALESCE($9, calendar_default_view),
             equipment_options = COALESCE($10, equipment_options),
             custom_fields = COALESCE($11, custom_fields),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1
         RETURNING *`,
        [
          company_name, normalizedLogoUrl, primary_color, accent_color,
          brand_tagline === undefined ? undefined : brand_tagline.trim(), logo_size,
          normalizedFaviconUrl, timezone, calendar_default_view, equipmentOptionsJson, customFieldsJson,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Site config not found. Call GET first to initialize.' });
      }

      const previousConfig = previous.rows[0] as any;
      if (previousConfig && normalizedLogoUrl !== undefined && normalizedLogoUrl !== previousConfig.logo_url) {
        await removeUnreferencedBrandingUpload(previousConfig.logo_url);
      }
      if (previousConfig && normalizedFaviconUrl !== undefined && normalizedFaviconUrl !== previousConfig.favicon_url) {
        await removeUnreferencedBrandingUpload(previousConfig.favicon_url);
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update site config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Booking approvals (after-hours)
  async getPendingBookings(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query(
        `SELECT b.*, r.name as room_name, r.building as room_building, r.floor as room_floor,
                u.email as organizer_email, u.role as organizer_role
         FROM bookings b
         LEFT JOIN rooms r ON b.room_id = r.id
         LEFT JOIN users u ON b.user_id = u.id
         WHERE b.status = 'pending'
         ORDER BY b.start_time ASC`
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Get pending bookings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async approveBooking(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const existing = await pool.query(
        `SELECT b.*, r.name as room_name, r.building as room_building, r.floor as room_floor,
                u.email as organizer_email, u.role as organizer_role
         FROM bookings b
         LEFT JOIN rooms r ON b.room_id = r.id
         LEFT JOIN users u ON b.user_id = u.id
         WHERE b.id = $1`,
        [id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const booking = existing.rows[0] as any;
      if (booking.status !== 'pending') {
        return res.status(409).json({ error: `Booking cannot be approved from status ${booking.status}` });
      }

      const violations = await bookingRulesService.validateBooking(
        new Date(booking.start_time),
        new Date(booking.end_time),
        Number(booking.user_id),
        Number(booking.room_id),
        booking.organizer_role || 'user',
        Number(booking.id),
        { skipBusinessHours: true },
      );
      if (violations.length > 0) {
        return res.status(409).json({
          error: `Booking can no longer be approved: ${violations[0].message}`,
          violations,
        });
      }

      const result = await pool.query(
        `UPDATE bookings
         SET status = 'confirmed',
             approved_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status = 'pending'
         RETURNING *`,
        [req.user!.id, id]
      );
      if (result.rows.length === 0) {
        return res.status(409).json({ error: 'Booking status changed before it could be approved' });
      }
      const updated = result.rows[0] as any;

      const payload = {
        event: 'booking_updated' as const,
        booking_id: updated.id,
        room_id: updated.room_id,
        title: updated.title,
        room: booking.room_name || `Room ${updated.room_id}`,
        building: booking.room_building || undefined,
        floor: booking.room_floor ?? undefined,
        organizer: booking.organizer_email || 'unknown',
        startTime: new Date(updated.start_time).toISOString(),
        endTime: new Date(updated.end_time).toISOString(),
        status: updated.status,
        durationMinutes: Math.max(0, Math.round((new Date(updated.end_time).getTime() - new Date(updated.start_time).getTime()) / 60000)),
        changes: { status: { from: booking.status, to: 'confirmed' } },
      };

      webhookService.send(payload);
      emailService.send(payload);
      emailService.notifyRoomManagers(payload);

      res.json(updated);
    } catch (error) {
      console.error('Approve booking error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async rejectBooking(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const existing = await pool.query(
        `SELECT b.*, r.name as room_name, r.building as room_building, r.floor as room_floor,
                u.email as organizer_email
         FROM bookings b
         LEFT JOIN rooms r ON b.room_id = r.id
         LEFT JOIN users u ON b.user_id = u.id
         WHERE b.id = $1`,
        [id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const booking = existing.rows[0] as any;
      if (booking.status !== 'pending') {
        return res.status(409).json({ error: `Booking cannot be rejected from status ${booking.status}` });
      }

      const result = await pool.query(
        `UPDATE bookings
         SET status = 'cancelled',
             cancellation_reason = $1,
             cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status = 'pending'
         RETURNING *`,
        [reason || 'Rejected by admin', id]
      );
      if (result.rows.length === 0) {
        return res.status(409).json({ error: 'Booking status changed before it could be rejected' });
      }
      const updated = result.rows[0] as any;

      const payload = {
        event: 'booking_cancelled' as const,
        booking_id: updated.id,
        room_id: updated.room_id,
        title: updated.title,
        room: booking.room_name || `Room ${updated.room_id}`,
        building: booking.room_building || undefined,
        floor: booking.room_floor ?? undefined,
        organizer: booking.organizer_email || 'unknown',
        startTime: new Date(updated.start_time).toISOString(),
        endTime: new Date(updated.end_time).toISOString(),
        status: updated.status,
        durationMinutes: Math.max(0, Math.round((new Date(updated.end_time).getTime() - new Date(updated.start_time).getTime()) / 60000)),
        reason: reason || 'Rejected by admin',
      };

      webhookService.send(payload);
      emailService.send(payload);
      emailService.notifyRoomManagers(payload);

      res.json(updated);
    } catch (error) {
      console.error('Reject booking error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async uploadLogo(req: AuthRequest, res: Response) {
    const file = (req as any).file;
    let uploadCommitted = false;
    try {
      if (!file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const logoUrl = `/uploads/branding/${file.filename}`;
      const existing = await pool.query('SELECT logo_url FROM site_config WHERE id = 1');
      if (existing.rows.length === 0) {
        await removeUploadedFile(file);
        return res.status(404).json({ error: 'Site config not found' });
      }

      const result = await pool.query(
        'UPDATE site_config SET logo_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1 RETURNING *',
        [logoUrl]
      );

      uploadCommitted = true;
      await removeUnreferencedBrandingUpload((existing.rows[0] as any).logo_url);
      res.json(result.rows[0]);
    } catch (error) {
      if (!uploadCommitted) await removeUploadedFile(file);
      console.error('Upload logo error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async uploadFavicon(req: AuthRequest, res: Response) {
    const file = (req as any).file;
    let uploadCommitted = false;
    try {
      if (!file) {
        return res.status(400).json({ error: 'No favicon uploaded' });
      }

      const faviconUrl = `/uploads/branding/${file.filename}`;
      const existing = await pool.query('SELECT favicon_url FROM site_config WHERE id = 1');
      if (existing.rows.length === 0) {
        await removeUploadedFile(file);
        return res.status(404).json({ error: 'Site config not found' });
      }
      const result = await pool.query(
        'UPDATE site_config SET favicon_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1 RETURNING *',
        [faviconUrl]
      );

      uploadCommitted = true;
      await removeUnreferencedBrandingUpload((existing.rows[0] as any).favicon_url);
      res.json(result.rows[0]);
    } catch (error) {
      if (!uploadCommitted) await removeUploadedFile(file);
      console.error('Upload favicon error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // User Management
  async getUsers(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query(
        `SELECT id, email, name, role, department, is_active, receives_admin_notifications, must_reset_password, no_show_count, created_at
         FROM users
         ORDER BY created_at DESC`
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async createUser(req: AuthRequest, res: Response) {
    try {
      const {
        email,
        password,
        name,
        department,
        role,
        must_reset_password,
        receives_admin_notifications,
      } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name required' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      if (name.length > 100) {
        return res.status(400).json({ error: 'Name too long (max 100 characters)' });
      }

      if (role && !['user', 'admin', 'room_manager', 'report_viewer'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be user, admin, room_manager, or report_viewer' });
      }

      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
        email.toLowerCase(),
      ]);

      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const password_hash = await bcrypt.hash(password, 12);

      const nextRole = role || 'user';
      const nextReceivesAdminNotifications =
        receives_admin_notifications === undefined
          ? (nextRole === 'admin' || nextRole === 'room_manager' ? 1 : 0)
          : (receives_admin_notifications ? 1 : 0);

      const result = await pool.query(
        `INSERT INTO users (email, password_hash, name, department, role, receives_admin_notifications, must_reset_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email, name, role, department, is_active, receives_admin_notifications, must_reset_password, no_show_count, created_at`,
        [
          email.toLowerCase(),
          password_hash,
          name,
          department || null,
          nextRole,
          nextReceivesAdminNotifications,
          must_reset_password ? 1 : 0,
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create user error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateUser(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { role, is_active, no_show_count, receives_admin_notifications } = req.body;

      // Validate role if provided
      if (role && !['user', 'admin', 'room_manager', 'report_viewer'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be user, admin, room_manager, or report_viewer' });
      }
      if (is_active !== undefined && ![0, 1, false, true].includes(is_active)) {
        return res.status(400).json({ error: 'Active status must be true or false' });
      }

      const target = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
      if (target.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const targetUser = target.rows[0] as any;

      // Prevent admin from demoting themselves
      if (req.user!.id === Number(id) && role && role !== req.user!.role) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }
      if (req.user!.id === Number(id) && (is_active === 0 || is_active === false)) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
      }

      const removesActiveAdmin = targetUser.role === 'admin' && Number(targetUser.is_active) === 1
        && ((role !== undefined && role !== 'admin') || is_active === 0 || is_active === false);
      if (removesActiveAdmin) {
        const remainingAdmins = await pool.query(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != $1",
          [id]
        );
        if (Number((remainingAdmins.rows[0] as any)?.count || 0) === 0) {
          return res.status(409).json({ error: 'Cannot deactivate or demote the last active admin' });
        }
      }

      const result = await pool.query(
        `UPDATE users
         SET role = COALESCE($1, role),
             directory_role_locked = CASE WHEN $1 IS NULL THEN directory_role_locked ELSE 1 END,
             is_active = COALESCE($2, is_active),
             no_show_count = COALESCE($3, no_show_count),
             receives_admin_notifications = COALESCE($4, receives_admin_notifications),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING id, email, name, role, department, is_active, receives_admin_notifications, must_reset_password, no_show_count`,
        [role, is_active, no_show_count, receives_admin_notifications, id]
      );

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async resetUserPassword(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { password } = req.body;

      if (!password || typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const password_hash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `UPDATE users
         SET password_hash = $1,
             must_reset_password = 1,
             token_version = token_version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING id, email, name, role, department, is_active, receives_admin_notifications, must_reset_password, no_show_count`,
        [password_hash, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Reset user password error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async deleteUser(req: AuthRequest, res: Response) {
    try {
      const userId = Number(req.params.id);
      if (!userId || Number.isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      if (req.user!.id === userId) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      const target = await pool.query(
        'SELECT id, email, role, is_active FROM users WHERE id = $1',
        [userId]
      );
      if (target.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const targetUser = target.rows[0] as any;

      if (targetUser.role === 'admin' && targetUser.is_active === 1) {
        const remainingAdmins = await pool.query(
          "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1 AND id != $1",
          [userId]
        );
        const count = Number((remainingAdmins.rows[0] as any)?.count || 0);
        if (count === 0) {
          return res.status(400).json({ error: 'Cannot delete the last active admin' });
        }
      }

      const heldBookings = bookingRetentionService.countHeldForUser(userId);
      if (heldBookings > 0) {
        return res.status(409).json({
          error: `Cannot delete this user while ${heldBookings} booking retention hold${heldBookings === 1 ? ' is' : 's are'} active`,
        });
      }

      await pool.query('BEGIN');
      try {
        const bookingCountResult = await pool.query(
          'SELECT COUNT(*) AS count FROM bookings WHERE user_id = $1',
          [userId]
        );
        const anonymizedBookingsCount = Number((bookingCountResult.rows[0] as any)?.count || 0);
        await pool.query(
          `UPDATE check_ins SET checked_in_by = NULL
           WHERE booking_id IN (SELECT id FROM bookings WHERE user_id = $1)`,
          [userId]
        );
        await pool.query(
          `UPDATE bookings
           SET user_id = NULL,
               title = 'Historical booking',
               attendees = NULL,
               notes = NULL,
               custom_fields = NULL,
               cancellation_reason = NULL,
               approved_by = NULL,
               status = CASE
                 WHEN datetime(end_time) >= datetime('now') AND status IN ('confirmed', 'pending') THEN 'cancelled'
                 ELSE status
               END,
               cancelled_at = CASE
                 WHEN datetime(end_time) >= datetime('now') AND status IN ('confirmed', 'pending') THEN CURRENT_TIMESTAMP
                 ELSE cancelled_at
               END,
               anonymized_at = COALESCE(anonymized_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1`,
          [userId]
        );
        await pool.query('UPDATE bookings SET approved_by = NULL WHERE approved_by = $1', [userId]);
        await pool.query('UPDATE holidays SET created_by = NULL WHERE created_by = $1', [userId]);
        await pool.query('UPDATE maintenance_windows SET created_by = NULL WHERE created_by = $1', [userId]);
        await pool.query('UPDATE check_ins SET checked_in_by = NULL WHERE checked_in_by = $1', [userId]);

        const deleted = await pool.query(
          'DELETE FROM users WHERE id = $1 RETURNING id, email, name, role',
          [userId]
        );
        if (deleted.rows.length === 0) {
          await pool.query('ROLLBACK');
          return res.status(404).json({ error: 'User not found' });
        }

        await pool.query('COMMIT');
        res.json({
          deleted: deleted.rows[0],
          anonymized_bookings_count: anonymizedBookingsCount,
        });
      } catch (txError) {
        await pool.query('ROLLBACK');
        throw txError;
      }
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const adminController = new AdminController();
