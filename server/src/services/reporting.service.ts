import { normalizeStringList } from '../utils/stringList';

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ReportDateRange {
  startDate: string;
  endDate: string;
  days: number;
}

export const shiftReportDate = (dateString: string, days: number): string => {
  const match = ISO_DATE_PATTERN.exec(dateString);
  if (!match) throw new Error('Invalid report date');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error('Invalid report date');
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const dateInReportTimezone = (date: Date, timezone: string): string => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/** Default to recent history plus upcoming demand so newly created reservations are visible. */
export const getDefaultReportRange = (timezone: string, now = new Date()): ReportDateRange => {
  const today = dateInReportTimezone(now, timezone);
  const startDate = shiftReportDate(today, -29);
  const endDate = shiftReportDate(today, 30);
  return { startDate, endDate, days: 60 };
};

export const validateReportRange = (startDate: string, endDate: string): ReportDateRange | null => {
  try {
    const normalizedStart = shiftReportDate(startDate, 0);
    const normalizedEnd = shiftReportDate(endDate, 0);
    const start = new Date(`${normalizedStart}T00:00:00.000Z`);
    const end = new Date(`${normalizedEnd}T00:00:00.000Z`);
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days < 1 || days > 366) return null;
    return { startDate: normalizedStart, endDate: normalizedEnd, days };
  } catch {
    return null;
  }
};

export interface TechnologyUsageItem {
  name: string;
  requestCount: number;
}

export type CheckInOutcome = 'checked_in' | 'no_show' | null;

/** Only persisted outcomes prove that check-in enforcement applied to a booking. */
export const getCheckInOutcome = (status: unknown, checkedIn: unknown): CheckInOutcome => {
  if (Number(checkedIn) === 1 || checkedIn === true) return 'checked_in';
  if (status === 'no_show') return 'no_show';
  return null;
};

/** Count the number of bookings requesting each technology option. */
export const aggregateTechnologyUsage = (
  bookingEquipment: unknown[],
  configuredOptions: unknown = []
): TechnologyUsageItem[] => {
  const counts = new Map<string, TechnologyUsageItem>();
  const configuredNames = new Map(
    normalizeStringList(configuredOptions).map(name => [name.toLocaleLowerCase(), name])
  );

  for (const rawEquipment of bookingEquipment) {
    for (const name of normalizeStringList(rawEquipment)) {
      const key = name.toLocaleLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.requestCount += 1;
        const configuredName = configuredNames.get(key);
        if (configuredName) {
          existing.name = configuredName;
        } else if (existing.name === existing.name.toLocaleLowerCase() && name !== name.toLocaleLowerCase()) {
          existing.name = name;
        }
      } else {
        counts.set(key, { name: configuredNames.get(key) || name, requestCount: 1 });
      }
    }
  }

  return Array.from(counts.values()).sort(
    (a, b) => b.requestCount - a.requestCount || a.name.localeCompare(b.name)
  );
};
