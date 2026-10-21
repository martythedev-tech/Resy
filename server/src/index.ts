import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import bookingsRoutes from './routes/bookings.routes';
import roomsRoutes from './routes/rooms.routes';
import adminRoutes from './routes/admin.routes';
import approvalRoutes from './routes/approval.routes';
import { checkInService } from './services/checkIn.service';
import { dailySummaryService } from './services/dailySummary.service';
import { pool } from './config/database';
import { getUploadsDir } from './config/paths';
import { ensureDatabase } from './config/dbInit';
import bcrypt from 'bcryptjs';
import {
  createRequestId,
  recordDiagnosticEvent,
  recordOperationalError,
  recordOperationalWarning,
} from './services/diagnostics.service';
import { AuthRequest } from './middleware/auth';
import { bookingRetentionService } from './services/bookingRetention.service';

dotenv.config();

// Fail fast if JWT_SECRET is not configured
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_BRAND_NAME = 'Resy';
const LEGACY_BRAND_NAMES = ['CRB (Conference Room Booking)', 'Conference Room Booking'];

app.disable('x-powered-by');

// Requests normally arrive through the bundled Nginx container. Trust only
// loopback and Docker's default bridge range so forwarded client addresses are
// available to rate limiting without allowing direct LAN clients to spoof them.
app.set('trust proxy', (address: string) => {
  const normalized = address.replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized.startsWith('127.')) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
});

// Middleware
const corsOriginEnv = process.env.CORS_ORIGIN || '';
const allowedOrigins = corsOriginEnv
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins, credentials: true }));
} else {
  // Safe default: allow non-browser clients and same-origin browser requests only.
  app.use(cors((req, callback) => {
    const origin = req.header('Origin');
    if (!origin) {
      callback(null, { origin: true, credentials: false });
      return;
    }

    const forwardedProto = req.header('X-Forwarded-Proto');
    const proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    const host = req.header('Host');
    const sameOrigin = !!host && origin === `${proto}://${host}`;

    callback(null, { origin: sameOrigin, credentials: false });
  }));
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Apply a generous safety ceiling to every API route. Sensitive authentication
// and booking-mutation endpoints also retain their stricter route-level limits.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Correlate server failures without retaining request bodies or credentials.
app.use((req: AuthRequest, res, next) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  res.on('finish', () => {
    if (res.statusCode < 500 || res.locals.diagnosticRecorded || req.path.startsWith('/api/admin/diagnostics')) return;
    const source = req.path.split('/').filter(Boolean).slice(1, 3).join('.') || 'api';
    recordDiagnosticEvent({
      severity: 'error',
      source,
      category: 'http',
      message: `${req.method} ${req.path} returned ${res.statusCode}`,
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      userId: req.user?.id || null,
      metadata: { duration_ms: Date.now() - startedAt },
    });
  });
  next();
});

// Serve uploaded images
const uploadsDir = getUploadsDir();
app.use('/uploads', express.static(uploadsDir));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/approvals', approvalRoutes);

// Public settings (no auth required)
app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT rule_type, value, unit, is_enabled FROM booking_rules WHERE rule_type IN ('show_equipment','capacity_warning','min_lead_time','recurrence_limit','max_bookings_per_room_per_day','buffer_time','max_duration','room_duration_limits','booking_interval','check_in_grace')"
    );
    const showEquipmentRow = (result.rows.find((r: any) => r.rule_type === 'show_equipment') as any) || null;
    const capacityWarningRow = (result.rows.find((r: any) => r.rule_type === 'capacity_warning') as any) || null;
    const minLeadTimeRow = (result.rows.find((r: any) => r.rule_type === 'min_lead_time') as any) || null;
    const recurrenceLimitRow = (result.rows.find((r: any) => r.rule_type === 'recurrence_limit') as any) || null;
    const maxRoomBookingsRow = (result.rows.find((r: any) => r.rule_type === 'max_bookings_per_room_per_day') as any) || null;
    const bufferTimeRow = (result.rows.find((r: any) => r.rule_type === 'buffer_time') as any) || null;
    const maxDurationRow = (result.rows.find((r: any) => r.rule_type === 'max_duration') as any) || null;
    const roomDurationLimitsRow = (result.rows.find((r: any) => r.rule_type === 'room_duration_limits') as any) || null;
    const bookingIntervalRow = (result.rows.find((r: any) => r.rule_type === 'booking_interval') as any) || null;
    const checkInGraceRow = (result.rows.find((r: any) => r.rule_type === 'check_in_grace') as any) || null;
    const normalizeInterval = (raw: any): number => {
      const value = Number(raw);
      return [15, 30, 60].includes(value) ? value : 30;
    };
    const toMinutes = (value: number, unit: string) => {
      switch (unit) {
        case 'minutes': return value;
        case 'hours': return value * 60;
        case 'days': return value * 60 * 24;
        case 'weeks': return value * 60 * 24 * 7;
        default: return value;
      }
    };
    const site = await pool.query('SELECT equipment_options, custom_fields, calendar_default_view FROM site_config WHERE id = 1');
    const siteRow = site.rows[0] as any;
    const parsedOptions = siteRow?.equipment_options
      ? (() => { try { return JSON.parse(siteRow.equipment_options as string); } catch { return []; } })()
      : [];
    const equipmentOptions = Array.isArray(parsedOptions) ? parsedOptions : [];
    const parsedFields = siteRow?.custom_fields
      ? (() => { try { return JSON.parse(siteRow.custom_fields as string); } catch { return []; } })()
      : [];
    const customFields = Array.isArray(parsedFields) ? parsedFields : [];
    const calendarDefaultView = siteRow?.calendar_default_view === 'week' || siteRow?.calendar_default_view === 'month'
      ? siteRow.calendar_default_view
      : 'day';
    res.json({
      show_equipment: showEquipmentRow ? showEquipmentRow.is_enabled === 1 : true,
      capacity_warning: capacityWarningRow ? capacityWarningRow.is_enabled === 1 : false,
      min_lead_time_enabled: minLeadTimeRow ? minLeadTimeRow.is_enabled === 1 : false,
      min_lead_time_minutes: minLeadTimeRow && minLeadTimeRow.is_enabled === 1 ? Number(minLeadTimeRow.value) || 0 : 0,
      recurrence_limit_enabled: recurrenceLimitRow ? recurrenceLimitRow.is_enabled === 1 : false,
      recurrence_limit_months: recurrenceLimitRow && recurrenceLimitRow.is_enabled === 1 ? Number(recurrenceLimitRow.value) || 0 : 0,
      max_bookings_per_room_per_day_enabled: maxRoomBookingsRow ? maxRoomBookingsRow.is_enabled === 1 : false,
      max_bookings_per_room_per_day: maxRoomBookingsRow && maxRoomBookingsRow.is_enabled === 1 ? Number(maxRoomBookingsRow.value) || 0 : 0,
      buffer_time_enabled: bufferTimeRow ? bufferTimeRow.is_enabled === 1 : false,
      buffer_time_minutes: bufferTimeRow && bufferTimeRow.is_enabled === 1 ? Number(bufferTimeRow.value) || 0 : 0,
      max_duration_enabled: maxDurationRow ? maxDurationRow.is_enabled === 1 : false,
      max_duration_minutes: maxDurationRow && maxDurationRow.is_enabled === 1 ? toMinutes(Number(maxDurationRow.value) || 0, String(maxDurationRow.unit || 'minutes')) : 0,
      room_duration_limits_enabled: roomDurationLimitsRow ? roomDurationLimitsRow.is_enabled === 1 : false,
      booking_interval_enabled: bookingIntervalRow ? bookingIntervalRow.is_enabled === 1 : true,
      booking_interval_minutes: normalizeInterval(bookingIntervalRow?.value),
      check_in_enabled: checkInGraceRow ? checkInGraceRow.is_enabled === 1 : false,
      check_in_grace_minutes: checkInGraceRow && checkInGraceRow.is_enabled === 1
        ? Math.min(240, Math.max(1, Number(checkInGraceRow.value) || 10))
        : 10,
      check_in_early_minutes: 15,
      calendar_default_view: calendarDefaultView,
      equipment_options: equipmentOptions,
      custom_fields: customFields,
    });
  } catch {
    res.json({
      show_equipment: true,
      capacity_warning: false,
      min_lead_time_enabled: false,
      min_lead_time_minutes: 0,
      recurrence_limit_enabled: false,
      recurrence_limit_months: 0,
      max_bookings_per_room_per_day_enabled: false,
      max_bookings_per_room_per_day: 0,
      buffer_time_enabled: false,
      buffer_time_minutes: 0,
      max_duration_enabled: false,
      max_duration_minutes: 0,
      room_duration_limits_enabled: false,
      booking_interval_enabled: true,
      booking_interval_minutes: 30,
      check_in_enabled: false,
      check_in_grace_minutes: 10,
      check_in_early_minutes: 15,
      calendar_default_view: 'day',
      equipment_options: [],
      custom_fields: [],
    });
  }
});

// Public branding (no auth required - needed for login page)
app.get('/api/branding', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT company_name, logo_url, primary_color, accent_color, brand_tagline, logo_size,
              favicon_url, timezone FROM site_config WHERE id = 1`
    );
    if (result.rows.length === 0) {
      // Return defaults if not configured
      res.json({
        company_name: DEFAULT_BRAND_NAME,
        logo_url: null,
        primary_color: '#4F46E5',
        accent_color: '#14B8A6',
        brand_tagline: 'Room booking',
        logo_size: 'medium',
        favicon_url: null,
        timezone: 'America/Chicago',
      });
    } else {
      const row = result.rows[0] as any;
      res.json({
        company_name: row.company_name || DEFAULT_BRAND_NAME,
        logo_url: row.logo_url || null,
        primary_color: row.primary_color || '#4F46E5',
        accent_color: row.accent_color || '#14B8A6',
        brand_tagline: row.brand_tagline ?? 'Room booking',
        logo_size: ['small', 'medium', 'large'].includes(row.logo_size) ? row.logo_size : 'medium',
        favicon_url: row.favicon_url || null,
        timezone: row.timezone || 'America/Chicago',
      });
    }
  } catch {
    res.json({
      company_name: DEFAULT_BRAND_NAME,
      logo_url: null,
      primary_color: '#4F46E5',
      accent_color: '#14B8A6',
      brand_tagline: 'Room booking',
      logo_size: 'medium',
      favicon_url: null,
      timezone: 'America/Chicago',
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler - return generic messages to clients
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Log full error server-side only
  console.error('Error:', err.code || err.name || 'UNKNOWN');
  res.locals.diagnosticRecorded = true;
  recordDiagnosticEvent({
    severity: 'error',
    source: 'api',
    category: 'unhandled',
    message: `Unhandled ${err.code || err.name || 'application error'}`,
    requestId: res.locals.requestId || null,
    method: req.method,
    path: req.path,
    statusCode: err.status || 500,
  });

  // Return generic error to client (don't expose internals)
  const status = err.status || 500;
  const message = status === 400 ? err.message : 'An error occurred';
  res.status(status).json({ error: message });
});

const startServer = async () => {
  await ensureDatabase();
  await ensureSystemRules();
  await ensureBrandingDefaults();
  await initDefaultAdmin();

  app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on ${HOST}:${PORT}`);
    console.log(`📡 API listening on ${HOST}:${PORT}`);
    console.log(`🏥 Health endpoint ready on ${HOST}:${PORT}`);
    recordDiagnosticEvent({ severity: 'info', source: 'system', category: 'lifecycle', message: 'API server started' });

    // Start background services only after the database is ready and the server is listening.
    checkInService.init();
    dailySummaryService.init();
    bookingRetentionService.init();
  });
};

startServer().catch(error => {
  recordOperationalError({
    source: 'system',
    category: 'startup',
    message: 'API server startup failed',
  }, error);
  process.exit(1);
});

async function initDefaultAdmin() {
  try {
    const enabled = String(process.env.ENABLE_DEFAULT_ADMIN || '').toLowerCase() === 'true';
    if (!enabled) return;

    const adminEmail = (process.env.DEFAULT_ADMIN_EMAIL || 'admin@company.com').toLowerCase();
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || '';
    if (!adminPassword) {
      recordOperationalWarning({
        source: 'system',
        category: 'bootstrap_configuration',
        message: 'Default administrator bootstrap was enabled without a password and was skipped',
      });
      return;
    }

    const existing = await pool.query('SELECT COUNT(*) as count FROM users');
    const count = Number((existing.rows[0] as any)?.count || 0);
    if (count > 0) return;

    const password_hash = await bcrypt.hash(adminPassword, 12);
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role, must_reset_password)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminEmail, password_hash, 'Admin', 'admin', 1]
    );
    console.log('✅ Default admin account created (must reset password on first login)');
  } catch (err) {
    recordOperationalError({
      source: 'system',
      category: 'bootstrap',
      message: 'Default administrator bootstrap failed',
    }, err);
  }
}

async function ensureSystemRules() {
  try {
    const existing = await pool.query(
      "SELECT id FROM booking_rules WHERE rule_type = 'booking_interval' LIMIT 1"
    );
    if (existing.rows.length > 0) return;

    await pool.query(
      `INSERT INTO booking_rules (rule_type, value, unit, description, is_enabled)
       VALUES ($1, $2, $3, $4, $5)`,
      ['booking_interval', 30, 'minutes', 'Booking start-time interval in minutes (15, 30, or 60)', 1]
    );
    console.log('✅ Added missing booking_interval rule');
  } catch (err) {
    recordOperationalError({
      source: 'system',
      category: 'startup_configuration',
      message: 'Failed to ensure the default booking interval rule',
    }, err);
  }
}

async function ensureBrandingDefaults() {
  try {
    await pool.query(
      `UPDATE site_config
       SET company_name = $1
       WHERE id = 1 AND (company_name IS NULL OR company_name = '' OR company_name IN ($2, $3))`,
      [DEFAULT_BRAND_NAME, ...LEGACY_BRAND_NAMES]
    );
    await pool.query(
      `UPDATE email_config
       SET from_name = $1
       WHERE id = 1 AND (from_name IS NULL OR from_name = '' OR from_name IN ($2, $3))`,
      [DEFAULT_BRAND_NAME, ...LEGACY_BRAND_NAMES]
    );
  } catch (err) {
    recordOperationalError({
      source: 'system',
      category: 'startup_configuration',
      message: 'Failed to ensure branding defaults',
    }, err);
  }
}

export default app;
