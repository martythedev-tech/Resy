export function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
