import assert from 'assert';
import db from '../src/config/database';
import { runMigrations } from '../src/config/migrations';
import { checkInService } from '../src/services/checkIn.service';

runMigrations(db);
db.prepare("INSERT INTO users (email, password_hash, name) VALUES ('checkpoint@example.com', 'hash', 'Checkpoint User')").run();
const userId = Number((db.prepare("SELECT id FROM users WHERE email = 'checkpoint@example.com'").get() as any).id);
db.prepare("INSERT INTO buildings (name) VALUES ('Checkpoint Building')").run();
db.prepare("INSERT INTO rooms (name, building, floor, capacity) VALUES ('Checkpoint Room', 'Checkpoint Building', 1, 8)").run();
const roomId = Number((db.prepare("SELECT id FROM rooms WHERE name = 'Checkpoint Room'").get() as any).id);

const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
db.prepare("INSERT INTO service_state (key, value) VALUES ('no_show_last_cutoff', ?)").run(iso(-90));
const insert = db.prepare("INSERT INTO bookings (room_id, user_id, title, start_time, end_time) VALUES (?, ?, ?, ?, ?)");
insert.run(roomId, userId, 'Before checkpoint', iso(-120), iso(-90));
insert.run(roomId, userId, 'Catch-up candidate', iso(-45), iso(-15));
insert.run(roomId, userId, 'Checked in candidate', iso(-30), iso(0));
const checkedInId = Number((db.prepare("SELECT id FROM bookings WHERE title = 'Checked in candidate'").get() as any).id);
db.prepare('INSERT INTO check_ins (booking_id, checked_in_by) VALUES (?, ?)').run(checkedInId, userId);

(async () => {
  await checkInService.processNoShows();
  const statuses = Object.fromEntries((db.prepare('SELECT title, status FROM bookings').all() as any[]).map(row => [row.title, row.status]));
  assert.equal(statuses['Before checkpoint'], 'confirmed');
  assert.equal(statuses['Catch-up candidate'], 'no_show');
  assert.equal(statuses['Checked in candidate'], 'confirmed');
  const checkpoint = String((db.prepare("SELECT value FROM service_state WHERE key = 'no_show_last_cutoff'").get() as any).value);
  assert.ok(new Date(checkpoint).getTime() > new Date(iso(-20)).getTime());
  console.log('No-show checkpoint smoke tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
