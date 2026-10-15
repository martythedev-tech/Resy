/**
 * Migration: Customization + rules additions
 *
 * Adds business hours and room duration columns, booking custom fields,
 * and inserts new booking rules where missing.
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '../../data/conference_rooms.db');

const defaultBusinessHours = () => ({
  days: {
    0: { enabled: false, start: '08:00', end: '18:00' },
    1: { enabled: true,  start: '08:00', end: '18:00' },
    2: { enabled: true,  start: '08:00', end: '18:00' },
    3: { enabled: true,  start: '08:00', end: '18:00' },
    4: { enabled: true,  start: '08:00', end: '18:00' },
    5: { enabled: true,  start: '08:00', end: '18:00' },
    6: { enabled: false, start: '08:00', end: '18:00' },
  },
});

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return rows.some(r => r.name === column);
}

function ruleExists(db: Database.Database, ruleType: string): boolean {
  const row = db.prepare('SELECT id FROM booking_rules WHERE rule_type = ?').get(ruleType) as any;
  return !!row;
}

async function migrate() {
  console.log('Starting customization + rules migration...');
  console.log('Database path:', dbPath);

  const db = new Database(dbPath);

  try {
    db.exec('BEGIN TRANSACTION');

    // Buildings: business_hours
    if (!columnExists(db, 'buildings', 'business_hours')) {
      db.exec(`ALTER TABLE buildings ADD COLUMN business_hours TEXT`);
      db.prepare(`UPDATE buildings SET business_hours = ? WHERE business_hours IS NULL`).run(
        JSON.stringify(defaultBusinessHours())
      );
    }

    // Rooms: business_hours + min/max duration
    if (!columnExists(db, 'rooms', 'business_hours')) {
      db.exec(`ALTER TABLE rooms ADD COLUMN business_hours TEXT`);
    }
    if (!columnExists(db, 'rooms', 'min_duration_minutes')) {
      db.exec(`ALTER TABLE rooms ADD COLUMN min_duration_minutes INTEGER`);
      db.prepare(`UPDATE rooms SET min_duration_minutes = 30 WHERE min_duration_minutes IS NULL`).run();
    }
    if (!columnExists(db, 'rooms', 'max_duration_minutes')) {
      db.exec(`ALTER TABLE rooms ADD COLUMN max_duration_minutes INTEGER`);
      db.prepare(`UPDATE rooms SET max_duration_minutes = 120 WHERE max_duration_minutes IS NULL`).run();
    }

    // Bookings: custom_fields
    if (!columnExists(db, 'bookings', 'custom_fields')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN custom_fields TEXT`);
    }

    // Site config: custom_fields
    if (!columnExists(db, 'site_config', 'custom_fields')) {
      db.exec(`ALTER TABLE site_config ADD COLUMN custom_fields TEXT`);
    }

    // Rules insert/update
    if (!ruleExists(db, 'advance_window_privileged')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled, applies_to_roles)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('advance_window_privileged', 8, 'weeks', 'Can book up to 8 weeks in advance (admin/room manager)', 1, '["admin","room_manager"]');
    }
    if (!ruleExists(db, 'business_hours')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('business_hours', 0, 'none', 'Limit bookings to configured business hours', 1);
    }
    if (!ruleExists(db, 'room_duration_limits')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('room_duration_limits', 0, 'none', 'Enforce per-room min/max duration limits', 1);
    }
    if (!ruleExists(db, 'booking_interval')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('booking_interval', 30, 'minutes', 'Booking start-time interval in minutes (15, 30, or 60)', 1);
    }
    if (!ruleExists(db, 'max_concurrent_bookings')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('max_concurrent_bookings', 5, 'count', 'Maximum number of future bookings per user', 1);
    }
    if (!ruleExists(db, 'show_equipment')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('show_equipment', 1, 'flag', 'Show technology tags and filters in the UI', 1);
    }
    if (!ruleExists(db, 'min_lead_time')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('min_lead_time', 10, 'minutes', 'Bookings must be made at least 10 minutes in advance', 1);
    }
    if (!ruleExists(db, 'capacity_warning')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('capacity_warning', 1, 'flag', 'Warn when attendee count exceeds room capacity', 1);
    }
    if (!ruleExists(db, 'recurrence_limit')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('recurrence_limit', 12, 'months', 'Limit recurring bookings to 12 months', 1);
    }
    if (!ruleExists(db, 'max_bookings_per_room_per_day')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('max_bookings_per_room_per_day', 10, 'count', 'Maximum bookings per room per day', 0);
    }
    if (!ruleExists(db, 'after_hours_roles')) {
      db.prepare(
        `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
         VALUES (?, ?, ?, ?, ?)`
      ).run('after_hours_roles', 0, 'none', 'Only admins/room managers can book after hours', 0);
    }

    // Update advance_window applies_to_roles to user-only if unset
    db.prepare(
      `UPDATE booking_rules
       SET applies_to_roles = '["user"]'
       WHERE rule_type = 'advance_window' AND (applies_to_roles IS NULL OR applies_to_roles = '')`
    ).run();

    db.exec('COMMIT');
    console.log('Customization + rules migration completed successfully!');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Migration failed:', error);
    throw error;
  } finally {
    db.close();
  }
}

migrate().catch(console.error);
