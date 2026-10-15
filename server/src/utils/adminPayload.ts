const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const validateBusinessHours = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Business hours must be an object';
  const days = (value as any).days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return 'Business hours must define days';
  for (const [key, rawDay] of Object.entries(days)) {
    if (!/^[0-6]$/.test(key) || !rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) {
      return 'Business hours contain an invalid day';
    }
    const day = rawDay as any;
    if (typeof day.enabled !== 'boolean') return 'Each business-hours day must specify whether it is enabled';
    if (!day.enabled) continue;
    if (!TIME_RE.test(String(day.start || '')) || !TIME_RE.test(String(day.end || ''))) {
      return 'Business-hours times must use HH:MM';
    }
    if (day.start >= day.end) return 'Business-hours end time must be after its start time';
  }
  return null;
};

const validateOptionalText = (value: unknown, label: string, max: number, allowEmpty = true): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) {
    return `${label} must be ${allowEmpty ? `no longer than ${max}` : `between 1 and ${max}`} characters`;
  }
  return null;
};

export const validateBuildingPayload = (body: Record<string, any>, partial = false): string | null => {
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'name')) {
    const error = validateOptionalText(body.name, 'Building name', 100, false);
    if (error) return error;
  }
  const descriptionError = validateOptionalText(body.description, 'Building description', 1000);
  if (descriptionError) return descriptionError;
  if (Object.prototype.hasOwnProperty.call(body, 'business_hours')) {
    const hoursError = validateBusinessHours(body.business_hours);
    if (hoursError) return hoursError;
  }
  return null;
};

export const validateRoomPayload = (body: Record<string, any>, partial = false): string | null => {
  for (const [key, label] of [['name', 'Room name'], ['building', 'Building']] as const) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, key)) {
      const error = validateOptionalText(body[key], label, 100, false);
      if (error) return error;
    }
  }
  const integerBounds: Array<[string, string, number, number]> = [
    ['floor', 'Floor', 1, 1000],
    ['capacity', 'Capacity', 1, 100000],
    ['min_duration_minutes', 'Minimum duration', 15, 1440],
    ['max_duration_minutes', 'Maximum duration', 15, 1440],
    ['buffer_minutes', 'Buffer', 0, 1440],
  ];
  for (const [key, label, min, max] of integerBounds) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === null) continue;
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < min || value > max) return `${label} must be a whole number between ${min} and ${max}`;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'equipment')) {
    if (!Array.isArray(body.equipment) || body.equipment.length > 100
        || body.equipment.some((item: unknown) => typeof item !== 'string' || !item.trim() || item.length > 100)) {
      return 'Room equipment must contain at most 100 non-empty values of 100 characters or fewer';
    }
  }
  for (const key of ['requires_approval', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(body, key) && ![0, 1, false, true].includes(body[key])) {
      return `${key === 'is_active' ? 'Room active' : 'Approval-required'} status must be true or false`;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'business_hours')) {
    const hoursError = validateBusinessHours(body.business_hours);
    if (hoursError) return hoursError;
  }
  const minDuration = body.min_duration_minutes === null || body.min_duration_minutes === undefined ? null : Number(body.min_duration_minutes);
  const maxDuration = body.max_duration_minutes === null || body.max_duration_minutes === undefined ? null : Number(body.max_duration_minutes);
  if (minDuration !== null && maxDuration !== null && minDuration > maxDuration) {
    return 'Minimum duration cannot exceed maximum duration';
  }
  return null;
};
