import {
  aggregateTechnologyUsage,
  dateInReportTimezone,
  getCheckInOutcome,
  getDefaultReportRange,
  shiftReportDate,
  validateReportRange,
} from '../src/services/reporting.service';
import { normalizeStringList, serializeStringList } from '../src/utils/stringList';

const fail = (message: string): never => { throw new Error(message); };

const usage = aggregateTechnologyUsage([
  ['Conference Call', 'Zoom'],
  '["Conference Call","Jitsi"]',
  [' conference call ', 'Computer Hookup'],
  ['Zoom', 'zoom', ''],
  null,
], ['Conference Call', 'Zoom', 'Jitsi', 'Computer Hookup']);

const expected = [
  { name: 'Conference Call', requestCount: 3 },
  { name: 'Zoom', requestCount: 2 },
  { name: 'Computer Hookup', requestCount: 1 },
  { name: 'Jitsi', requestCount: 1 },
];

if (JSON.stringify(usage) !== JSON.stringify(expected)) {
  fail(`Unexpected technology usage: ${JSON.stringify(usage)}`);
}

const serialized = serializeStringList([' Zoom ', 'zoom', 'Jitsi', '', 42]);
if (serialized !== '["Zoom","Jitsi"]') fail(`Unexpected serialization: ${serialized}`);
if (JSON.stringify(normalizeStringList(serialized)) !== '["Zoom","Jitsi"]') {
  fail('Serialized technology selections did not round-trip');
}

const fixedNow = new Date('2026-10-07T18:00:00.000Z');
if (dateInReportTimezone(fixedNow, 'America/Chicago') !== '2026-10-07') {
  fail('Report date did not follow the configured workspace timezone');
}
if (dateInReportTimezone(new Date('2026-10-08T01:00:00.000Z'), 'America/Chicago') !== '2026-10-07') {
  fail('Report date crossed into the next UTC day instead of following the workspace timezone');
}

const defaultRange = getDefaultReportRange('America/Chicago', fixedNow);
if (JSON.stringify(defaultRange) !== JSON.stringify({ startDate: '2026-09-08', endDate: '2026-11-06', days: 60 })) {
  fail(`Unexpected default report range: ${JSON.stringify(defaultRange)}`);
}
if (shiftReportDate('2026-10-07', 30) !== '2026-11-06') {
  fail('Upcoming report date shift was incorrect');
}
if (!validateReportRange('2026-10-01', '2026-10-31')) {
  fail('Valid future-inclusive report range was rejected');
}
if (validateReportRange('2026-02-31', '2026-03-05')) {
  fail('Impossible calendar date was accepted');
}
if (validateReportRange('2026-10-31', '2026-10-01')) {
  fail('Reversed report range was accepted');
}
if (validateReportRange('2026-01-01', '2027-01-02')) {
  fail('Report range longer than 366 days was accepted');
}

if (getCheckInOutcome('confirmed', 0) !== null) {
  fail('Untracked confirmed booking was treated as check-in eligible');
}
if (getCheckInOutcome('confirmed', 1) !== 'checked_in') {
  fail('Persisted check-in was not classified as a tracked outcome');
}
if (getCheckInOutcome('cancelled', true) !== 'checked_in') {
  fail('A persisted check-in was discarded after a later cancellation');
}
if (getCheckInOutcome('no_show', 0) !== 'no_show') {
  fail('Persisted no-show was not classified as a tracked outcome');
}

console.log('[OK] technology aggregation, string-list persistence, timezone defaults, upcoming ranges, strict dates, and persisted check-in outcomes');
