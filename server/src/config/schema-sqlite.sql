-- SQLite Schema for Resy

-- Drop existing tables if they exist
DROP TABLE IF EXISTS check_ins;
DROP TABLE IF EXISTS booking_recurrence;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS booking_templates;
DROP TABLE IF EXISTS holidays;
DROP TABLE IF EXISTS maintenance_windows;
DROP TABLE IF EXISTS booking_rules;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS buildings;
DROP TABLE IF EXISTS users;

-- Users table
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'room_manager', 'report_viewer')),
    department TEXT,
    is_active INTEGER DEFAULT 1,
    directory_role_locked INTEGER DEFAULT 0,
    receives_admin_notifications INTEGER DEFAULT 1,
    must_reset_password INTEGER DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 0,
    no_show_count INTEGER DEFAULT 0,
    suspension_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Buildings table
CREATE TABLE buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    image_url TEXT,
    business_hours TEXT, -- JSON stored as text
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Rooms table
CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    building TEXT NOT NULL,
    floor INTEGER NOT NULL,
    capacity INTEGER NOT NULL,
    equipment TEXT, -- JSON array stored as text
    buffer_minutes INTEGER DEFAULT 15, -- per-room buffer between bookings
    business_hours TEXT, -- JSON stored as text (overrides building hours if set)
    min_duration_minutes INTEGER, -- per-room minimum booking duration
    max_duration_minutes INTEGER, -- per-room maximum booking duration
    image_url TEXT,
    is_active INTEGER DEFAULT 1,
    requires_approval INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Booking rules table
CREATE TABLE booking_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL,
    value INTEGER NOT NULL,
    unit TEXT NOT NULL,
    description TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    applies_to_roles TEXT, -- JSON array stored as text
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Holidays table
CREATE TABLE holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date DATE NOT NULL,
    is_recurring INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Maintenance windows table
CREATE TABLE maintenance_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    reason TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bookings table
CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    organizer_department TEXT, -- booking-time snapshot for stable historical reporting
    title TEXT NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    attendees TEXT, -- JSON array stored as text
    attendee_count INTEGER CHECK (attendee_count IS NULL OR (attendee_count >= 0 AND attendee_count <= 100000 AND CAST(attendee_count AS INTEGER) = attendee_count)),
    equipment TEXT, -- JSON array stored as text
    notes TEXT,
    custom_fields TEXT, -- JSON stored as text
    status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending', 'cancelled', 'no_show')),
    is_recurring INTEGER DEFAULT 0,
    recurrence_id INTEGER,
    approved_by INTEGER REFERENCES users(id),
    cancelled_at DATETIME,
    cancellation_reason TEXT,
    anonymized_at DATETIME,
    retention_hold INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Booking templates (per-user)
CREATE TABLE booking_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    equipment TEXT, -- JSON array stored as text
    notes TEXT,
    custom_fields TEXT, -- JSON stored as text
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Booking recurrence table
CREATE TABLE booking_recurrence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    interval INTEGER DEFAULT 1,
    days_of_week TEXT, -- JSON array stored as text
    end_date DATE,
    max_occurrences INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Check-ins table
CREATE TABLE check_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    checked_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    checked_in_by INTEGER REFERENCES users(id)
);

-- Webhook integrations
CREATE TABLE IF NOT EXISTS webhook_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL CHECK (service_type IN ('slack', 'teams', 'rocket')),
    webhook_url TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    events TEXT NOT NULL DEFAULT '["booking_created","booking_updated","booking_cancelled","no_show"]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Optional application-managed policy for explicitly allowed internal webhook origins.
CREATE TABLE IF NOT EXISTS webhook_security_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    allow_internal_destinations INTEGER NOT NULL DEFAULT 0,
    allowed_internal_origins TEXT NOT NULL DEFAULT '[]',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Email configuration (singleton row, id is always 1)
CREATE TABLE IF NOT EXISTS email_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    smtp_host TEXT NOT NULL DEFAULT '',
    smtp_port INTEGER NOT NULL DEFAULT 587,
    smtp_user TEXT NOT NULL DEFAULT '',
    smtp_password TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT 'Resy',
    is_enabled INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Site branding configuration (singleton row, id is always 1)
CREATE TABLE IF NOT EXISTS site_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name TEXT NOT NULL DEFAULT 'Resy',
    logo_url TEXT DEFAULT NULL,
    primary_color TEXT NOT NULL DEFAULT '#4F46E5',
    accent_color TEXT NOT NULL DEFAULT '#14B8A6',
    brand_tagline TEXT NOT NULL DEFAULT 'Room booking',
    logo_size TEXT NOT NULL DEFAULT 'medium',
    favicon_url TEXT DEFAULT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Chicago',
    calendar_default_view TEXT NOT NULL DEFAULT 'day',
    booking_retention_months INTEGER NOT NULL DEFAULT 36,
    booking_retention_enabled INTEGER NOT NULL DEFAULT 0,
    backup_retention_days INTEGER NOT NULL DEFAULT 90,
    equipment_options TEXT DEFAULT NULL,
    custom_fields TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sanitized, bounded operational events for Admin diagnostics
CREATE TABLE IF NOT EXISTS diagnostic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    request_id TEXT,
    method TEXT,
    path TEXT,
    status_code INTEGER,
    user_id INTEGER,
    metadata TEXT
);

-- Durable checkpoints for background services
CREATE TABLE IF NOT EXISTS service_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Optional application-managed directory configuration. No row is inserted by
-- default so existing environment-based installations remain authoritative.
CREATE TABLE IF NOT EXISTS directory_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_enabled INTEGER NOT NULL DEFAULT 0,
    directory_type TEXT NOT NULL DEFAULT 'ad' CHECK (directory_type IN ('ad', 'ldap')),
    server_url TEXT NOT NULL DEFAULT '',
    base_dn TEXT NOT NULL DEFAULT '',
    bind_dn TEXT NOT NULL DEFAULT '',
    bind_password_encrypted TEXT NOT NULL DEFAULT '',
    ca_cert_path TEXT NOT NULL DEFAULT '/app/certs',
    tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1,
    allow_insecure_ldap INTEGER NOT NULL DEFAULT 0,
    allow_local_fallback INTEGER NOT NULL DEFAULT 1,
    sync_roles INTEGER NOT NULL DEFAULT 1,
    sync_profile INTEGER NOT NULL DEFAULT 1,
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    admin_groups TEXT NOT NULL DEFAULT '[]',
    room_manager_groups TEXT NOT NULL DEFAULT '[]',
    timeout_ms INTEGER NOT NULL DEFAULT 8000,
    connect_timeout_ms INTEGER NOT NULL DEFAULT 5000,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_bookings_room_time ON bookings(room_id, start_time, end_time);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_start_time ON bookings(start_time);
CREATE INDEX idx_bookings_retention ON bookings(end_time, anonymized_at, retention_hold);
CREATE UNIQUE INDEX idx_check_ins_booking_unique ON check_ins(booking_id);
CREATE INDEX idx_holidays_date ON holidays(date);
CREATE INDEX idx_maintenance_room_time ON maintenance_windows(room_id, start_time, end_time);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_diagnostic_events_created_at ON diagnostic_events(created_at);
CREATE INDEX idx_diagnostic_events_severity ON diagnostic_events(severity);
CREATE INDEX idx_diagnostic_events_source ON diagnostic_events(source);

-- Insert default booking rules
INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled, applies_to_roles) VALUES
('max_duration', 2, 'hours', 'Maximum booking duration is 2 hours', 1, NULL),
('buffer_time', 15, 'minutes', '15-minute buffer between bookings', 1, NULL),
('advance_window', 2, 'weeks', 'Can book up to 2 weeks in advance (users)', 1, '["user"]'),
('advance_window_privileged', 8, 'weeks', 'Can book up to 8 weeks in advance (admin/room manager)', 1, '["admin","room_manager"]'),
('min_lead_time', 10, 'minutes', 'Bookings must be made at least 10 minutes in advance', 1, NULL),
('daily_limit', 4, 'hours', 'Maximum 4 hours of bookings per day per user', 1, NULL),
('check_in_grace', 10, 'minutes', 'Must check in within 10 minutes or booking auto-cancels', 1, NULL),
('min_cancel_notice', 2, 'hours', 'Must cancel at least 2 hours before booking', 1, NULL),
('no_show_limit', 3, 'count', 'After 3 no-shows, user suspended for 1 week', 1, NULL),
('capacity_warning', 1, 'flag', 'Warn when attendee count exceeds room capacity', 1, NULL),
('show_equipment', 1, 'flag', 'Show technology tags and filters in the UI', 1, NULL),
('business_hours', 0, 'none', 'Limit bookings to configured business hours', 1, NULL),
('room_duration_limits', 0, 'none', 'Enforce per-room min/max duration limits', 1, NULL),
('booking_interval', 30, 'minutes', 'Booking start-time interval in minutes (15, 30, or 60)', 1, NULL),
('max_concurrent_bookings', 5, 'count', 'Maximum number of future bookings per user', 1, NULL),
('recurrence_limit', 12, 'months', 'Limit recurring bookings to 12 months', 1, NULL),
('max_bookings_per_room_per_day', 10, 'count', 'Maximum bookings per room per day', 0, NULL),
('after_hours_roles', 0, 'none', 'Only admins/room managers can book after hours', 0, NULL);
