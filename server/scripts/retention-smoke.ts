import db from '../src/config/database';
import { bookingRetentionService } from '../src/services/bookingRetention.service';

const fail = (message: string): never => { throw new Error(message); };

db.prepare("INSERT OR IGNORE INTO site_config (id) VALUES (1)").run();
const brandingColumns = new Set((db.prepare('PRAGMA table_info(site_config)').all() as any[]).map(column => column.name));
for (const column of ['accent_color', 'brand_tagline', 'logo_size']) {
  if (!brandingColumns.has(column)) fail(`Missing branding column: ${column}`);
}
const brandingDefaults = db.prepare('SELECT accent_color, brand_tagline, logo_size FROM site_config WHERE id = 1').get() as any;
if (brandingDefaults.accent_color !== '#14B8A6' || brandingDefaults.brand_tagline !== 'Room booking' || brandingDefaults.logo_size !== 'medium') {
  fail(`Unexpected branding defaults: ${JSON.stringify(brandingDefaults)}`);
}
bookingRetentionService.updateConfig({ retention_months: 1, enabled: false, backup_retention_days: 90 });
const endOfMonthPreview = bookingRetentionService.preview(new Date('2026-03-31T15:45:00.000Z'));
if (endOfMonthPreview.cutoff !== '2026-02-28T15:45:00.000Z') {
  fail(`Retention cutoff did not clamp to end of month: ${endOfMonthPreview.cutoff}`);
}
db.prepare("INSERT INTO rooms (name, building, floor, capacity) VALUES ('Retention Room', 'Test', 1, 8)").run();
const user = db.prepare("INSERT INTO users (email, name, department) VALUES ('retention@example.test', 'Retention User', 'Operations') RETURNING id").get() as any;
const insert = db.prepare(
  `INSERT INTO bookings (room_id, user_id, organizer_department, title, start_time, end_time, attendees, notes, custom_fields, status, retention_hold)
   VALUES (1, ?, 'Operations', ?, datetime('now', ?), datetime(datetime('now', ?), '+1 hour'), '["person@example.test"]', 'private note', '{"visitor":"Private"}', ?, ?)
   RETURNING id`
);
const eligible = insert.get(user.id, 'Old eligible', '-48 months', '-48 months', 'confirmed', 0) as any;
const held = insert.get(user.id, 'Old held', '-48 months', '-48 months', 'confirmed', 1) as any;
const pending = insert.get(user.id, 'Old pending', '-48 months', '-48 months', 'pending', 0) as any;
const recent = insert.get(user.id, 'Recent', '-1 month', '-1 month', 'confirmed', 0) as any;
db.prepare('INSERT INTO check_ins (booking_id, checked_in_by) VALUES (?, ?)').run(eligible.id, user.id);

const emailMatches = bookingRetentionService.searchBookings('retention@example.test');
if (emailMatches.length !== 4 || !emailMatches.every((booking: any) => booking.organizer_email === 'retention@example.test')) {
  fail('Retention booking search did not match organizer email');
}
const idMatches = bookingRetentionService.searchBookings(String(eligible.id));
if (!idMatches.some((booking: any) => booking.id === eligible.id)) fail('Retention booking search did not match booking ID');

bookingRetentionService.updateConfig({ retention_months: 36, enabled: false, backup_retention_days: 90 });
const preview = bookingRetentionService.preview();
if (preview.eligible_count !== 1 || preview.held_count !== 1) {
  fail(`Unexpected preview: ${JSON.stringify(preview)}`);
}
const result = bookingRetentionService.runBatch(500, 'manual');
if (result.processed !== 1) fail(`Expected one processed booking, got ${result.processed}`);

const redacted = db.prepare('SELECT * FROM bookings WHERE id = ?').get(eligible.id) as any;
if (redacted.user_id !== null || redacted.title !== 'Historical booking' || redacted.notes !== null || !redacted.anonymized_at) {
  fail('Eligible booking was not fully anonymized');
}
if (!redacted.room_id || !redacted.start_time || !redacted.end_time || redacted.status !== 'confirmed' || redacted.organizer_department !== 'Operations') {
  fail('Non-identifying reporting fields were not retained');
}
const checkIn = db.prepare('SELECT checked_in_by FROM check_ins WHERE booking_id = ?').get(eligible.id) as any;
if (checkIn.checked_in_by !== null) fail('Check-in identity was not anonymized');

for (const [label, id] of [['held', held.id], ['pending', pending.id], ['recent', recent.id]] as const) {
  const row = db.prepare('SELECT user_id, anonymized_at FROM bookings WHERE id = ?').get(id) as any;
  if (row.user_id !== user.id || row.anonymized_at !== null) fail(`${label} booking should not be anonymized`);
}

console.log('[OK] retention preview, search, exclusions, anonymization, branding migration defaults, and reporting-field preservation');
db.close();
