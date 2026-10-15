export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

export interface RecurrencePlanInput {
  frequency: RecurrenceFrequency;
  interval: number;
  endDate: string;
}

export interface RecurrencePlan {
  frequency: RecurrenceFrequency;
  interval: number;
  endDate: string;
  starts: Date[];
}

export class RecurrenceValidationError extends Error {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// The normal administrative limit is twelve months. Four hundred meetings
// safely covers a daily leap-year series without allowing a single request to
// amplify a large payload into thousands of database rows.
export const MAX_RECURRENCE_OCCURRENCES = 400;

const dateParts = (dateStr: string) => {
  const match = DATE_RE.exec(dateStr);
  if (!match) throw new RecurrenceValidationError('Recurrence end date must use YYYY-MM-DD format');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RecurrenceValidationError('Recurrence end date is invalid');
  }
  return { year, month, day };
};

const formatDateParts = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export const getDateInTimezone = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return `${parts.find(part => part.type === 'year')?.value}-${parts.find(part => part.type === 'month')?.value}-${parts.find(part => part.type === 'day')?.value}`;
};

export const getTimeInTimezone = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return `${parts.find(part => part.type === 'hour')?.value}:${parts.find(part => part.type === 'minute')?.value}`;
};

const getOffsetMinutes = (instant: Date, timezone: string): number => {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant).find(part => part.type === 'timeZoneName')?.value || '';
  if (name === 'GMT' || name === 'UTC') return 0;
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) throw new RecurrenceValidationError(`Unsupported timezone offset for ${timezone}`);
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

export const buildZonedDate = (dateStr: string, timeStr: string, timezone: string): Date => {
  const { year, month, day } = dateParts(dateStr);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!timeMatch) throw new RecurrenceValidationError('Recurrence start time is invalid');
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) throw new RecurrenceValidationError('Recurrence start time is invalid');

  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(wallClockUtc);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = new Date(wallClockUtc - getOffsetMinutes(candidate, timezone) * 60_000);
    if (next.getTime() === candidate.getTime()) break;
    candidate = next;
  }

  if (getDateInTimezone(candidate, timezone) !== dateStr || getTimeInTimezone(candidate, timezone) !== timeStr) {
    throw new RecurrenceValidationError(`The local time ${timeStr} does not exist on ${dateStr} in ${timezone}`);
  }
  return candidate;
};

export const addCalendarDays = (dateStr: string, amount: number): string => {
  const { year, month, day } = dateParts(dateStr);
  const result = new Date(Date.UTC(year, month - 1, day + amount, 12));
  return formatDateParts(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
};

export const addCalendarMonthsClamped = (dateStr: string, amount: number, anchorDay?: number): string => {
  const { year, month, day } = dateParts(dateStr);
  const monthIndex = (month - 1) + amount;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0, 12)).getUTCDate();
  return formatDateParts(targetYear, targetMonthIndex + 1, Math.min(anchorDay || day, lastDay));
};

export const generateRecurrencePlan = (
  originalStart: Date,
  input: RecurrencePlanInput,
  timezone: string,
): RecurrencePlan => {
  if (!['daily', 'weekly', 'monthly'].includes(input.frequency)) {
    throw new RecurrenceValidationError('Recurrence frequency must be daily, weekly, or monthly');
  }
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 99) {
    throw new RecurrenceValidationError('Recurrence interval must be a whole number between 1 and 99');
  }
  dateParts(input.endDate);

  const startDate = getDateInTimezone(originalStart, timezone);
  const startTime = getTimeInTimezone(originalStart, timezone);
  if (input.endDate < startDate) {
    throw new RecurrenceValidationError('Recurrence end date cannot be before the meeting start date');
  }

  const starts: Date[] = [];
  const anchorDay = dateParts(startDate).day;
  for (let index = 1; ; index++) {
    const occurrenceDate = input.frequency === 'monthly'
      ? addCalendarMonthsClamped(startDate, input.interval * index, anchorDay)
      : addCalendarDays(startDate, (input.frequency === 'weekly' ? 7 : 1) * input.interval * index);
    if (occurrenceDate > input.endDate) break;
    starts.push(buildZonedDate(occurrenceDate, startTime, timezone));
    if (starts.length >= MAX_RECURRENCE_OCCURRENCES) {
      throw new RecurrenceValidationError(`A recurring series cannot exceed ${MAX_RECURRENCE_OCCURRENCES} meetings`);
    }
  }

  return { ...input, starts };
};
