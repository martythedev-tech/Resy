import assert from 'node:assert/strict';
import { validateBrandingUrl } from '../src/utils/brandingUrl';
import { validateCustomFieldSchema, validateCustomFieldValues } from '../src/utils/customFields';

const schema = [
  { id: 'meeting_type', label: 'Meeting type', type: 'select', options: ['Internal', 'External'], required: true },
  { id: 'confirmed', label: 'Confirmed', type: 'checkbox' },
];

assert.equal(validateCustomFieldSchema(schema), null);
assert.match(validateCustomFieldSchema([{ ...schema[0], id: 'attendee_count' }]) || '', /reserved/i);
assert.match(validateCustomFieldSchema([{ ...schema[0], options: ['Internal', 'Internal'] }]) || '', /unique/i);
assert.equal(validateCustomFieldValues({ meeting_type: 'Internal', confirmed: false }, schema), null);
assert.match(validateCustomFieldValues({}, schema) || '', /required/i);
assert.match(validateCustomFieldValues({ meeting_type: 'Other' }, schema) || '', /configured option/i);
assert.match(validateCustomFieldValues({ meeting_type: 'Internal', surprise: 'value' }, schema) || '', /not configured/i);
assert.equal(validateCustomFieldValues({ attendee_count: 8 }, [], { allowTemplateAttendeeCount: true, enforceRequired: false }), null);

assert.equal(validateBrandingUrl('', 'Logo'), null);
assert.equal(validateBrandingUrl('/uploads/branding/logo.png', 'Logo'), null);
assert.equal(validateBrandingUrl('https://cdn.example.com/logo.png', 'Logo'), null);
assert.match(validateBrandingUrl('http://cdn.example.com/logo.png', 'Logo') || '', /HTTPS/);
assert.match(validateBrandingUrl('javascript:alert(1)', 'Logo') || '', /HTTPS/);

console.log('Configuration policy regression checks passed');
