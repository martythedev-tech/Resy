import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '../../data/conference_rooms.db');
const db = new Database(dbPath);

// Get the configured timezone from site_config
const siteConfig = db.prepare('SELECT timezone FROM site_config WHERE id = 1').get() as { timezone: string } | undefined;
const timezone = siteConfig?.timezone || 'America/Chicago';

console.log('Fixing booking times for timezone:', timezone);
console.log('This script corrects bookings that were created before timezone support was added.');
console.log('');

// Calculate timezone offset in minutes
function getTimezoneOffset(tz: string): number {
  const now = new Date();
  const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  return (utcDate.getTime() - tzDate.getTime()) / 60000; // Positive if behind UTC (e.g., +360 for UTC-6)
}

const offsetMinutes = getTimezoneOffset(timezone);
const offsetHours = offsetMinutes / 60;
console.log(`Timezone offset: ${offsetHours >= 0 ? '+' : ''}${offsetHours} hours from UTC`);
console.log('');

// Get all bookings
const bookings = db.prepare(`
  SELECT id, title, start_time, end_time, room_id
  FROM bookings
  WHERE status IN ('confirmed', 'pending')
`).all() as Array<{
  id: number;
  title: string;
  start_time: string;
  end_time: string;
  room_id: number;
}>;

console.log(`Found ${bookings.length} active bookings to analyze.`);
console.log('');

// Analyze and fix bookings
let fixed = 0;
let skipped = 0;

const updateStmt = db.prepare(`
  UPDATE bookings
  SET start_time = ?, end_time = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const fixBookings = db.transaction(() => {
  for (const booking of bookings) {
    const startUtc = new Date(booking.start_time);
    const endUtc = new Date(booking.end_time);

    // Get the hour in the app timezone (what it currently displays as)
    const startInTz = new Date(startUtc.getTime() - offsetMinutes * 60000);
    const startHour = startInTz.getUTCHours();

    // If the booking displays outside business hours (before 8 AM or after 8 PM),
    // it's likely a pre-timezone booking that needs fixing
    if (startHour < 8 || startHour >= 20) {
      // These bookings were stored with local time as UTC
      // To fix: add the timezone offset to shift them to correct UTC
      const newStartUtc = new Date(startUtc.getTime() + offsetMinutes * 60000);
      const newEndUtc = new Date(endUtc.getTime() + offsetMinutes * 60000);

      console.log(`Fixing: "${booking.title}" (ID: ${booking.id})`);
      console.log(`  Old: ${booking.start_time} -> ${booking.end_time}`);
      console.log(`  New: ${newStartUtc.toISOString()} -> ${newEndUtc.toISOString()}`);
      console.log(`  (Shifted by ${offsetHours} hours)`);
      console.log('');

      updateStmt.run(newStartUtc.toISOString(), newEndUtc.toISOString(), booking.id);
      fixed++;
    } else {
      // Booking displays within business hours - likely created correctly
      skipped++;
    }
  }
});

fixBookings();

console.log('='.repeat(50));
console.log(`Fixed: ${fixed} bookings`);
console.log(`Skipped: ${skipped} bookings (already correct)`);
console.log('');
console.log('Migration complete.');

db.close();
