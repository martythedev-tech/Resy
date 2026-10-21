export function isValidEmail(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 254) return false;
  if (value !== value.trim()) return false;

  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at > 64) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain || domain.length > 253 || !domain.includes('.')) return false;
  for (const character of value) {
    if (character <= ' ' || character === '\u007f') return false;
  }
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;

  return true;
}
