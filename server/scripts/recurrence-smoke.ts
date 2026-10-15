import assert from 'node:assert/strict';
import {
  RecurrenceValidationError,
  buildZonedDate,
  generateRecurrencePlan,
  getDateInTimezone,
  getTimeInTimezone,
} from '../src/utils/recurrence';

const timezone = 'America/Chicago';

const weeklyStart = buildZonedDate('2026-10-30', '09:00', timezone);
const weekly = generateRecurrencePlan(weeklyStart, {
  frequency: 'weekly',
  interval: 1,
  endDate: '2026-11-13',
}, timezone);
assert.deepEqual(weekly.starts.map(date => getDateInTimezone(date, timezone)), ['2026-11-06', '2026-11-13']);
assert.deepEqual(weekly.starts.map(date => getTimeInTimezone(date, timezone)), ['09:00', '09:00']);

const dailyStart = buildZonedDate('2026-01-01', '10:30', timezone);
const daily = generateRecurrencePlan(dailyStart, {
  frequency: 'daily',
  interval: 1,
  endDate: '2026-04-01',
}, timezone);
assert.equal(daily.starts.length, 90, 'daily recurrence must not stop at the former 52-occurrence cap');

const monthlyStart = buildZonedDate('2026-01-31', '14:00', timezone);
const monthly = generateRecurrencePlan(monthlyStart, {
  frequency: 'monthly',
  interval: 1,
  endDate: '2026-04-30',
}, timezone);
assert.deepEqual(monthly.starts.map(date => getDateInTimezone(date, timezone)), [
  '2026-02-28',
  '2026-03-31',
  '2026-04-30',
]);

assert.throws(
  () => generateRecurrencePlan(dailyStart, { frequency: 'daily', interval: 0, endDate: '2026-02-01' }, timezone),
  RecurrenceValidationError,
);
assert.throws(
  () => generateRecurrencePlan(dailyStart, { frequency: 'yearly' as any, interval: 1, endDate: '2026-02-01' }, timezone),
  RecurrenceValidationError,
);
assert.throws(
  () => generateRecurrencePlan(dailyStart, { frequency: 'daily', interval: 1, endDate: '2028-01-01' }, timezone),
  error => error instanceof RecurrenceValidationError && error.message.includes('400'),
  'recurrence amplification ceiling must reject series larger than 400 total meetings',
);

console.log('Recurrence regression checks passed');
