export type CustomFieldType = 'text' | 'select' | 'checkbox';

export interface CustomFieldDefinition {
  id: string;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  helpText?: string;
}

const MAX_FIELDS = 20;
const ID_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const RESERVED_IDS = new Set(['attendee_count']);

export const parseCustomFieldSchema = (value: unknown): CustomFieldDefinition[] => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed as CustomFieldDefinition[] : [];
  } catch {
    return [];
  }
};

export const validateCustomFieldSchema = (value: unknown): string | null => {
  if (!Array.isArray(value)) return 'Custom field configuration must be an array';
  if (value.length > MAX_FIELDS) return `No more than ${MAX_FIELDS} custom fields may be configured`;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Each custom field must be an object';
    const field = item as Record<string, unknown>;
    if (typeof field.id !== 'string' || !ID_PATTERN.test(field.id) || RESERVED_IDS.has(field.id)) {
      return 'Custom field IDs must use lowercase letters, numbers, or underscores and cannot use reserved names';
    }
    if (ids.has(field.id)) return `Custom field ID ${field.id} is duplicated`;
    ids.add(field.id);
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 100) {
      return `Custom field ${field.id} must have a label between 1 and 100 characters`;
    }
    if (!['text', 'select', 'checkbox'].includes(String(field.type))) return `Custom field ${field.id} has an invalid type`;
    if (field.required !== undefined && typeof field.required !== 'boolean') return `Custom field ${field.id} has an invalid required setting`;
    if (field.helpText !== undefined && (typeof field.helpText !== 'string' || field.helpText.length > 300)) {
      return `Custom field ${field.id} help text cannot exceed 300 characters`;
    }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 50) {
        return `Custom field ${field.id} must have between 1 and 50 options`;
      }
      const options = field.options as unknown[];
      if (options.some(option => typeof option !== 'string' || !option.trim() || option.length > 100)) {
        return `Custom field ${field.id} options must be non-empty text no longer than 100 characters`;
      }
      if (new Set(options).size !== options.length) return `Custom field ${field.id} options must be unique`;
    }
  }
  return null;
};

export const validateCustomFieldValues = (
  value: unknown,
  schemaValue: unknown,
  options: { allowTemplateAttendeeCount?: boolean; enforceRequired?: boolean } = {},
): string | null => {
  if (value === null || value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Custom fields must be an object';
  const values = value as Record<string, unknown>;
  const schema = parseCustomFieldSchema(schemaValue);
  const definitions = new Map(schema.map(field => [field.id, field]));

  for (const key of Object.keys(values)) {
    if (options.allowTemplateAttendeeCount && key === 'attendee_count') {
      const count = Number(values[key]);
      if (!Number.isInteger(count) || count < 0 || count > 100000) return 'Template attendee count must be a whole number between 0 and 100000';
      continue;
    }
    if (!definitions.has(key)) return `Custom field ${key} is not configured`;
  }

  for (const field of schema) {
    const fieldValue = values[field.id];
    const empty = fieldValue === undefined || fieldValue === null || fieldValue === '';
    if (options.enforceRequired !== false && field.required && (empty || (field.type === 'checkbox' && fieldValue !== true))) return `${field.label} is required`;
    if (empty) continue;
    if (field.type === 'text' && (typeof fieldValue !== 'string' || fieldValue.length > 2000)) return `${field.label} must be text no longer than 2000 characters`;
    if (field.type === 'select' && (typeof fieldValue !== 'string' || !field.options?.includes(fieldValue))) return `${field.label} must use a configured option`;
    if (field.type === 'checkbox' && typeof fieldValue !== 'boolean') return `${field.label} must be a checkbox value`;
  }
  return null;
};
