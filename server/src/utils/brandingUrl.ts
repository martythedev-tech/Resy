const MANAGED_BRANDING_PATH = /^\/uploads\/branding\/[A-Za-z0-9._-]+$/;

export const validateBrandingUrl = (value: unknown, label: string): string | null => {
  if (typeof value !== 'string') return `${label} URL must be text`;
  const trimmed = value.trim();
  if (!trimmed || MANAGED_BRANDING_PATH.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid');
    return null;
  } catch {
    return `${label} URL must be HTTPS or an uploaded branding file`;
  }
};
