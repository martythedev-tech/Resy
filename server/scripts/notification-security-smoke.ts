import assert from 'assert';
import { EmailService, EmailPayload, escapeHtml } from '../src/services/email.service';

assert.equal(escapeHtml(`<script>alert('x')</script>`), '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');

const service = new EmailService() as any;
const payload: EmailPayload = {
  event: 'booking_cancelled',
  booking_id: 42,
  room_id: 7,
  title: '<img src=x onerror=alert(1)>',
  room: 'Boardroom & Lab',
  organizer: 'person@example.com',
  startTime: '2026-10-01T15:00:00.000Z',
  endTime: '2026-10-01T16:00:00.000Z',
  bookingUrl: 'https://example.com/booking/42?value=" onclick="alert(1)',
  notes: '<script>alert(1)</script>',
};

const emailBranding = {
  companyName: 'Acme <Operations>',
  brandTagline: 'Find & book',
  logoSrc: 'https://cdn.example.com/acme-logo.png?size=large&mode=email',
};
const cancellation = service.buildEmail(payload, 'America/Chicago', emailBranding);
assert.equal(cancellation.html.includes('<script>alert(1)</script>'), false);
assert.equal(cancellation.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
assert.equal(cancellation.html.includes('onclick="alert(1)'), false);
assert.equal(cancellation.attachments.length, 1);
assert.equal(cancellation.attachments[0].content.includes('METHOD:CANCEL'), true);
assert.equal(cancellation.attachments[0].content.includes('STATUS:CANCELLED'), true);
assert.equal(cancellation.attachments[0].contentType.includes('method=CANCEL'), true);
assert.equal(cancellation.html.includes('src="https://cdn.example.com/acme-logo.png?size=large&amp;mode=email"'), true);
assert.equal(cancellation.html.includes('alt="Acme &lt;Operations&gt;"'), true);
assert.equal(cancellation.html.includes('>Find &amp; book</span>'), true);
assert.equal(cancellation.html.includes('Sent by Resy'), true);
assert.equal(cancellation.html.includes('Resy · Room booking'), false);

const confirmation = service.buildEmail(
  { ...payload, event: 'booking_created', status: 'confirmed' },
  'America/Chicago',
  { companyName: 'Acme', brandTagline: '' },
);
assert.equal(confirmation.attachments[0].content.includes('METHOD:REQUEST'), true);
assert.equal(confirmation.attachments[0].content.includes('STATUS:CONFIRMED'), true);
assert.equal(confirmation.html.includes('>Acme</span>'), true);
assert.equal(confirmation.html.includes('padding-left:14px'), false);

const inlineLogo = service.buildEmail(
  { ...payload, event: 'booking_created', status: 'confirmed' },
  'America/Chicago',
  {
    companyName: 'Acme',
    brandTagline: 'Book a room',
    logoSrc: 'cid:resy-workspace-logo',
    logoAttachment: { filename: 'logo.png', path: '/tmp/logo.png', cid: 'resy-workspace-logo' },
  },
);
assert.equal(inlineLogo.html.includes('src="cid:resy-workspace-logo"'), true);
assert.equal(inlineLogo.attachments.length, 2);
assert.equal(inlineLogo.attachments[0].cid, 'resy-workspace-logo');
assert.equal(inlineLogo.attachments[1].content.includes('METHOD:REQUEST'), true);

console.log('Notification security smoke tests passed');
