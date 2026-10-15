import { Response } from 'express';
import { pool } from '../config/database';
import { AuthRequest } from '../middleware/auth';
const DEFAULT_TIMEZONE = 'America/Chicago';

const getDateStringInTimezone = (date: Date, timezone: string): string => {
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
};

const buildZonedDate = (dateStr: string, timeStr: string, timezone: string): Date => {
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
};

const getDayRange = (dateStr: string, timezone: string): { start: Date; end: Date } => {
  const start = buildZonedDate(dateStr, '00:00', timezone);
  const end = buildZonedDate(dateStr, '23:59', timezone);
  return { start, end };
};

const getTimezone = async (): Promise<string> => {
  try {
    const result = await pool.query('SELECT timezone FROM site_config WHERE id = 1');
    const row = result.rows[0] as any;
    return row?.timezone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

export class RoomsController {
  async getAll(req: AuthRequest, res: Response) {
    try {
      const { building, min_capacity, equipment } = req.query;

      let query = `SELECT r.*, b.business_hours AS building_hours
                   FROM rooms r
                   JOIN buildings b ON r.building = b.name
                   WHERE r.is_active = 1 AND b.is_active = 1`;
      const params: any[] = [];
      let paramCount = 1;

      if (building) {
        query += ` AND building = $${paramCount++}`;
        params.push(building);
      }

      if (min_capacity) {
        query += ` AND capacity >= $${paramCount++}`;
        params.push(min_capacity);
      }

      if (equipment) {
        query += ` AND instr(equipment, $${paramCount++}) > 0`;
        params.push(equipment);
      }

      query += ' ORDER BY r.building, r.floor, r.name';

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error) {
      console.error('Get rooms error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async getById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `SELECT r.*, b.business_hours AS building_hours
         FROM rooms r
         LEFT JOIN buildings b ON r.building = b.name
         WHERE r.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Room not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Get room error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async getAvailability(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { date } = req.query;

      const timezone = await getTimezone();
      const dateStr = date ? String(date) : getDateStringInTimezone(new Date(), timezone);
      const { start: dayStart, end: dayEnd } = getDayRange(dateStr, timezone);

      // Get all bookings for the room on this day
      const bookingsResult = await pool.query(
        `SELECT start_time, end_time, title, status
         FROM bookings
         WHERE room_id = $1
         AND start_time < $3
         AND end_time > $2
         AND status IN ('confirmed', 'pending')
         ORDER BY start_time`,
        [id, dayStart, dayEnd]
      );

      // Get maintenance windows
      const maintenanceResult = await pool.query(
        `SELECT start_time, end_time, reason
         FROM maintenance_windows
         WHERE room_id = $1
         AND start_time <= $3
         AND end_time >= $2`,
        [id, dayStart, dayEnd]
      );

      res.json({
        date: dateStr,
        bookings: bookingsResult.rows,
        maintenance: maintenanceResult.rows,
      });
    } catch (error) {
      console.error('Get availability error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const roomsController = new RoomsController();
