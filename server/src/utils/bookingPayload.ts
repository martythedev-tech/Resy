const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 5000;
const MAX_ATTENDEES = 100;
const MAX_EQUIPMENT = 50;
const MAX_CUSTOM_FIELDS = 50;
const MAX_CUSTOM_FIELDS_BYTES = 16 * 1024;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const validateStringList = (
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number,
): string | null => {
  if (!Array.isArray(value)) return `${label} must be an array`;
  if (value.length > maxItems) return `${label} cannot contain more than ${maxItems} items`;
  if (value.some(item => typeof item !== 'string' || !item.trim() || item.length > maxItemLength)) {
    return `${label} must contain non-empty text values no longer than ${maxItemLength} characters`;
  }
  return null;
};

export const validateCustomFields = (value: unknown): string | null => {
  if (value === null) return null;
  if (!isPlainObject(value)) return 'Custom fields must be an object';
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_FIELDS) return `Custom fields cannot contain more than ${MAX_CUSTOM_FIELDS} values`;
  for (const [key, fieldValue] of entries) {
    if (!key.trim() || key.length > 100) return 'Custom field names must be between 1 and 100 characters';
    if (typeof fieldValue === 'string' && fieldValue.length > 2000) return `Custom field ${key} is too long`;
    if (fieldValue !== null && !['string', 'number', 'boolean'].includes(typeof fieldValue)) {
      return `Custom field ${key} must be a text, number, checkbox, or empty value`;
    }
    if (typeof fieldValue === 'number' && !Number.isFinite(fieldValue)) return `Custom field ${key} must be finite`;
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CUSTOM_FIELDS_BYTES) {
    return `Custom fields cannot exceed ${MAX_CUSTOM_FIELDS_BYTES / 1024} KB`;
  }
  return null;
};

export const validateBookingPayload = (body: Record<string, any>, partial = false): string | null => {
  if ((!partial || Object.prototype.hasOwnProperty.call(body, 'title'))
      && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > MAX_TITLE_LENGTH)) {
    return `Title must be between 1 and ${MAX_TITLE_LENGTH} characters`;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notes')
      && body.notes !== null
      && (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LENGTH)) {
    return `Notes cannot exceed ${MAX_NOTES_LENGTH} characters`;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'attendees')) {
    const error = validateStringList(body.attendees, 'Attendees', MAX_ATTENDEES, 254);
    if (error) return error;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'equipment')) {
    const error = validateStringList(body.equipment, 'Technology selections', MAX_EQUIPMENT, 100);
    if (error) return error;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'custom_fields')) {
    const error = validateCustomFields(body.custom_fields);
    if (error) return error;
  }
  return null;
};

export const validateTemplatePayload = (body: Record<string, any>, partial = false): string | null => {
  if ((!partial || Object.prototype.hasOwnProperty.call(body, 'name'))
      && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)) {
    return 'Template name must be between 1 and 100 characters';
  }
  const bookingError = validateBookingPayload(body, partial);
  if (bookingError) return bookingError;
  if (Object.prototype.hasOwnProperty.call(body, 'duration_minutes')) {
    const duration = Number(body.duration_minutes);
    if (!Number.isInteger(duration) || duration < 15 || duration > 1440) {
      return 'Template duration must be a whole number between 15 and 1440 minutes';
    }
  }
  return null;
};
