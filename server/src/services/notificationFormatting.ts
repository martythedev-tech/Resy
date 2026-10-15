export const formatNotificationDateTime = (isoString: string, timezone: string): string => {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

export const formatNotificationChangeValue = (key: string, value: unknown, timezone: string): string => {
  if ((key === 'start_time' || key === 'end_time') && value) {
    return formatNotificationDateTime(String(value), timezone);
  }
  return value === null || value === undefined || value === '' ? '—' : String(value);
};
