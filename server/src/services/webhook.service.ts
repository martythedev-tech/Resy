import { pool } from '../config/database';
import { formatNotificationChangeValue, formatNotificationDateTime } from './notificationFormatting';
import { createPinnedWebhookLookup, safeWebhookDestination, validateWebhookUrl } from '../utils/webhookSecurity';
import { recordOperationalError, recordOperationalWarning } from './diagnostics.service';
import { webhookPolicyService } from './webhookPolicy.service';
import http from 'http';
import https from 'https';

export interface WebhookPayload {
  event: 'booking_created' | 'booking_updated' | 'booking_cancelled' | 'no_show' | 'booking_pending';
  booking_id: number;
  room_id: number;
  title: string;
  room: string;
  building?: string;
  floor?: number;
  organizer: string;
  startTime: string;
  endTime: string;
  status?: string;
  durationMinutes?: number;
  timezone?: string;
  appUrl?: string;
  bookingUrl?: string;
  approveUrl?: string;
  rejectUrl?: string;
  reason?: string;
  equipment?: string[];  // IT/AV equipment requested
  notes?: string;
  custom_fields?: Record<string, any>;
  recurrence_summary?: string;
  changes?: Record<string, { from: any; to: any }>;
}

interface DailySummaryPayload {
  event: 'daily_summary';
  date: string;
  timezone: string;
  totalBookings: number;
  rooms: { room: string; building?: string; floor?: number; count: number }[];
  bookings: { title: string; room: string; building?: string; floor?: number; startTime: string; endTime: string; organizer?: string }[];
  appUrl?: string;
}

export class WebhookService {
  private normalizePublicUrl(url: string | undefined) {
    if (!url) return undefined;
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    if (/localhost|127\.0\.0\.1/i.test(trimmed)) return undefined;
    return trimmed.replace(/\/$/, '');
  }

  async send(payload: WebhookPayload) {
    try {
      const result = await pool.query(
        `SELECT * FROM webhook_configs WHERE is_enabled = 1`
      );

      const timezone = await this.getTimezone();

      for (const config of result.rows as any[]) {
        const events: string[] = typeof config.events === 'string'
          ? JSON.parse(config.events)
          : config.events;

        const wantsEvent = events.includes(payload.event);
        const fallbackPending = payload.event === 'booking_pending' && events.includes('booking_created');
        if (!wantsEvent && !fallbackPending) continue;

        try {
          const body = this.formatPayload(config.service_type, payload, timezone);
          await this.postWithRetry(config.webhook_url, body);
        } catch (err) {
          recordOperationalError({
            source: 'webhook',
            category: 'delivery',
            message: 'Booking webhook delivery failed',
            metadata: {
              event: payload.event,
              booking_id: payload.booking_id,
              service_type: config.service_type,
              destination: safeWebhookDestination(config.webhook_url),
            },
          }, err);
        }
      }
    } catch (err) {
      recordOperationalError({
        source: 'webhook',
        category: 'dispatch',
        message: 'Webhook dispatch failed',
        metadata: { event: payload.event, booking_id: payload.booking_id },
      }, err);
    }
  }

  async sendDailySummary() {
    try {
      const result = await pool.query(
        `SELECT * FROM webhook_configs WHERE is_enabled = 1`
      );
      const timezone = await this.getTimezone();
      const summary = await this.buildDailySummary(timezone);
      if (!summary) return;

      for (const config of result.rows as any[]) {
        const events: string[] = typeof config.events === 'string'
          ? JSON.parse(config.events)
          : config.events;

        if (!events.includes('daily_summary')) continue;

        try {
          const body = this.formatDailySummary(config.service_type, summary);
          await this.postWithRetry(config.webhook_url, body);
        } catch (err) {
          recordOperationalError({
            source: 'webhook',
            category: 'daily_summary_delivery',
            message: 'Daily summary webhook delivery failed',
            metadata: {
              service_type: config.service_type,
              destination: safeWebhookDestination(config.webhook_url),
            },
          }, err);
        }
      }
    } catch (err) {
      recordOperationalError({
        source: 'webhook',
        category: 'daily_summary_dispatch',
        message: 'Daily summary webhook dispatch failed',
      }, err);
    }
  }

  private async getTimezone(): Promise<string> {
    try {
      const result = await pool.query('SELECT timezone FROM site_config WHERE id = 1');
      if (result.rows.length > 0 && (result.rows[0] as any).timezone) {
        return (result.rows[0] as any).timezone;
      }
    } catch (err) {
      recordOperationalWarning({
        source: 'webhook',
        category: 'timezone_fallback',
        message: 'Webhook service could not load the workspace timezone; using the default',
      }, err);
    }
    return 'America/Chicago'; // default fallback
  }

  private formatPayload(serviceType: string, payload: WebhookPayload, timezone: string) {
    const base = this.buildBasePayload(payload, timezone);
    switch (serviceType) {
      case 'slack':
        return this.formatSlack(payload, timezone, base);
      case 'teams':
        return this.formatTeams(payload, timezone, base);
      case 'rocket':
      default:
        return this.formatRocket(payload, timezone, base);
    }
  }

  private formatDailySummary(serviceType: string, summary: DailySummaryPayload) {
    switch (serviceType) {
      case 'slack':
        return this.formatDailySummarySlack(summary);
      case 'teams':
        return this.formatDailySummaryTeams(summary);
      case 'rocket':
      default:
        return this.formatDailySummaryRocket(summary);
    }
  }

  private getTitle(event: string) {
    switch (event) {
      case 'booking_pending': return 'Approval Needed';
      case 'no_show': return 'No-Show Detected';
      case 'booking_cancelled': return 'Booking Cancelled';
      case 'booking_updated': return 'Booking Updated';
      default: return 'New Booking';
    }
  }

  private getEmoji(event: string) {
    switch (event) {
      case 'booking_pending': return ':hourglass_flowing_sand:';
      case 'no_show': return ':rotating_light:';
      case 'booking_cancelled': return ':no_entry:';
      case 'booking_updated': return ':pencil:';
      default: return ':white_check_mark:';
    }
  }

  private formatTime12h(isoString: string, timezone: string): string {
    return formatNotificationDateTime(isoString, timezone);
  }

  private formatChanges(changes: Record<string, { from: any; to: any }>, timezone: string, bullet = '• ') {
    return Object.entries(changes)
      .map(([key, value]) => {
        const from = formatNotificationChangeValue(key, value.from, timezone);
        const to = formatNotificationChangeValue(key, value.to, timezone);
        return `${bullet}${key.replace(/_/g, ' ')}: ${from} → ${to}`;
      })
      .join('\n');
  }

  private formatSummaryDate(dateStr: string, timezone: string): string {
    const date = new Date(`${dateStr}T12:00:00Z`);
    return date.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  private formatSlack(p: WebhookPayload, timezone: string, base: any) {
    const startFormatted = this.formatTime12h(p.startTime, timezone);
    const endFormatted = this.formatTime12h(p.endTime, timezone);
    const fields = [
      { type: 'mrkdwn', text: `*Booking ID:*\n${p.booking_id}` },
      { type: 'mrkdwn', text: `*Room:*\n${p.room}` },
      ...(p.building ? [{ type: 'mrkdwn', text: `*Building:*\n${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}` }] : []),
      { type: 'mrkdwn', text: `*Organizer:*\n${p.organizer}` },
      { type: 'mrkdwn', text: `*Date / time:*\n${startFormatted} – ${endFormatted} (${timezone})` },
      { type: 'mrkdwn', text: `*Booking:*\n${p.title}` },
    ];
    if (p.durationMinutes) {
      fields.push({ type: 'mrkdwn', text: `*Duration:*\n${p.durationMinutes} min` });
    }
    if (p.recurrence_summary) {
      fields.push({ type: 'mrkdwn', text: `*Recurrence:*\n${p.recurrence_summary}` });
    }
    if (p.status) {
      fields.push({ type: 'mrkdwn', text: `*Status:*\n${p.status}` });
    }
    if (p.equipment && p.equipment.length > 0) {
      fields.push({ type: 'mrkdwn', text: `*Technology Setup:*\n${p.equipment.join(', ')}` });
    }
    if (p.notes) fields.push({ type: 'mrkdwn', text: `*Notes:*\n${p.notes}` });
    if (p.custom_fields && Object.keys(p.custom_fields).length > 0) {
      const customLines = Object.entries(p.custom_fields)
        .filter(([, value]) => value !== undefined && value !== '' && value !== false)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === true ? 'Yes' : v}`)
        .join('\n');
      if (customLines) fields.push({ type: 'mrkdwn', text: `*Details:*\n${customLines}` });
    }
    if (p.reason) fields.push({ type: 'mrkdwn', text: `*Reason:*\n${p.reason}` });
    if (p.changes && Object.keys(p.changes).length > 0) {
      const diffLines = this.formatChanges(p.changes, timezone);
      fields.push({ type: 'mrkdwn', text: `*Changes:*\n${diffLines}` });
    }
    if (p.approveUrl || p.rejectUrl) {
      const links = [p.approveUrl ? `Approve: ${p.approveUrl}` : null, p.rejectUrl ? `Reject: ${p.rejectUrl}` : null].filter(Boolean).join('\n');
      fields.push({ type: 'mrkdwn', text: `*Approval Links:*\n${links}` });
    }
    if (p.bookingUrl) fields.push({ type: 'mrkdwn', text: `*Link:*\n${p.bookingUrl}` });

    return {
      ...base,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${this.getEmoji(p.event)} ${this.getTitle(p.event)}` } },
        { type: 'section', fields },
      ],
    };
  }

  private formatTeams(p: WebhookPayload, timezone: string, base: any) {
    const startFormatted = this.formatTime12h(p.startTime, timezone);
    const endFormatted = this.formatTime12h(p.endTime, timezone);
    const colors: Record<string, string> = { no_show: 'DC2626', booking_cancelled: 'EA580C', booking_created: '4F46E5', booking_updated: '7C3AED', booking_pending: 'F59E0B' };
    const facts = [
      { name: 'Booking ID', value: String(p.booking_id) },
      { name: 'Room', value: p.room },
      ...(p.building ? [{ name: 'Building', value: `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}` }] : []),
      { name: 'Organizer', value: p.organizer },
      { name: 'Date / time', value: `${startFormatted} – ${endFormatted} (${timezone})` },
      { name: 'Booking', value: p.title },
    ];
    if (p.durationMinutes) facts.push({ name: 'Duration', value: `${p.durationMinutes} min` });
    if (p.recurrence_summary) facts.push({ name: 'Recurrence', value: p.recurrence_summary });
    if (p.status) facts.push({ name: 'Status', value: p.status });
    if (p.equipment && p.equipment.length > 0) {
      facts.push({ name: 'Technology Setup', value: p.equipment.join(', ') });
    }
    if (p.notes) facts.push({ name: 'Notes', value: p.notes });
    if (p.custom_fields && Object.keys(p.custom_fields).length > 0) {
      const customLines = Object.entries(p.custom_fields)
        .filter(([, value]) => value !== undefined && value !== '' && value !== false)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === true ? 'Yes' : v}`)
        .join('\n');
      if (customLines) facts.push({ name: 'Details', value: customLines });
    }
    if (p.reason) facts.push({ name: 'Reason', value: p.reason });
    if (p.changes && Object.keys(p.changes).length > 0) {
      const diffLines = this.formatChanges(p.changes, timezone, '');
      facts.push({ name: 'Changes', value: diffLines });
    }
    if (p.approveUrl) facts.push({ name: 'Approve', value: p.approveUrl });
    if (p.rejectUrl) facts.push({ name: 'Reject', value: p.rejectUrl });
    if (p.bookingUrl) facts.push({ name: 'Link', value: p.bookingUrl });

    return {
      ...base,
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: colors[p.event] || '4F46E5',
      summary: this.getTitle(p.event),
      sections: [{ activityTitle: this.getTitle(p.event), facts }],
    };
  }

  private formatRocket(p: WebhookPayload, timezone: string, base: any) {
    const emojis: Record<string, string> = { no_show: '🚨', booking_cancelled: '🚫', booking_created: '✅', booking_updated: '✏️', booking_pending: '⏳' };
    const colors: Record<string, string> = { no_show: '#DC2626', booking_cancelled: '#EA580C', booking_created: '#4F46E5', booking_updated: '#7C3AED', booking_pending: '#F59E0B' };
    const startFormatted = this.formatTime12h(p.startTime, timezone);
    const endFormatted = this.formatTime12h(p.endTime, timezone);

    let text = `*Meeting:* ${p.title}\n`;
    text += `*Booking ID:* ${p.booking_id}\n`;
    text += `*Room:* ${p.room}\n`;
    if (p.building) text += `*Building:* ${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}\n`;
    text += `*Organizer:* ${p.organizer}\n`;
    text += `*Date / time:* ${startFormatted} – ${endFormatted} (${timezone})`;
    if (p.durationMinutes) text += `\n*Duration:* ${p.durationMinutes} min`;
    if (p.recurrence_summary) text += `\n*Recurrence:* ${p.recurrence_summary}`;
    if (p.status) text += `\n*Status:* ${p.status}`;
    if (p.equipment && p.equipment.length > 0) {
      text += `\n*Technology:* ${p.equipment.join(', ')}`;
    }
    if (p.notes) text += `\n*Notes:* ${p.notes}`;
    if (p.custom_fields && Object.keys(p.custom_fields).length > 0) {
      const customLines = Object.entries(p.custom_fields)
        .filter(([, value]) => value !== undefined && value !== '' && value !== false)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === true ? 'Yes' : v}`)
        .join('\n');
      if (customLines) text += `\n*Details:*\n${customLines}`;
    }
    if (p.reason) text += `\n*Reason:* ${p.reason}`;
    if (p.changes && Object.keys(p.changes).length > 0) {
      text += `\n*Changes:*\n${this.formatChanges(p.changes, timezone)}`;
    }
    const actions = [];
    if (p.approveUrl) {
      actions.push({
        type: 'button',
        text: 'Approve',
        url: p.approveUrl,
        style: 'primary',
      });
    }
    if (p.rejectUrl) {
      actions.push({
        type: 'button',
        text: 'Reject',
        url: p.rejectUrl,
        style: 'danger',
      });
    }
    if (p.bookingUrl) text += `\n*View booking:* ${p.bookingUrl}`;

    return {
      ...base,
      text: `${emojis[p.event] || '✅'} ${this.getTitle(p.event)}: ${p.title}`,
      attachments: [{
        color: colors[p.event] || '#4F46E5',
        title: `${emojis[p.event] || '✅'} ${this.getTitle(p.event)}`,
        text,
        ...(actions.length > 0 ? { actions } : {}),
      }],
    };
  }

  private buildBasePayload(p: WebhookPayload, timezone: string) {
    return {
      event: p.event,
      booking_id: p.booking_id,
      room_id: p.room_id,
      title: p.title,
      room: p.room,
      building: p.building,
      floor: p.floor,
      organizer: p.organizer,
      start_time_iso: p.startTime,
      end_time_iso: p.endTime,
      start_time_local: this.formatTime12h(p.startTime, timezone),
      end_time_local: this.formatTime12h(p.endTime, timezone),
      timezone,
      status: p.status,
      duration_minutes: p.durationMinutes,
      recurrence_summary: p.recurrence_summary,
      equipment: p.equipment,
      notes: p.notes,
      custom_fields: p.custom_fields,
      reason: p.reason,
      changes: p.changes,
      app_url: p.appUrl,
      booking_url: p.bookingUrl,
      approve_url: p.approveUrl,
      reject_url: p.rejectUrl,
    };
  }

  private async buildDailySummary(timezone: string): Promise<DailySummaryPayload | null> {
    const dateStr = this.getDateStringInTimezone(new Date(), timezone);
    const { start, end } = this.getDayRange(dateStr, timezone);
    const appUrl = this.normalizePublicUrl(process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || undefined);

    const bookingsResult = await pool.query(
      `SELECT b.*, r.name as room_name, r.building as room_building, r.floor as room_floor, u.email as organizer_email
       FROM bookings b
       LEFT JOIN rooms r ON b.room_id = r.id
       LEFT JOIN users u ON b.user_id = u.id
       WHERE b.start_time >= $1
       AND b.start_time <= $2
       AND b.status IN ('confirmed', 'pending')
       ORDER BY b.start_time ASC`,
      [start, end]
    );

    const bookings = (bookingsResult.rows as any[]).map(row => ({
      title: row.title,
      room: row.room_name || `Room ${row.room_id}`,
      building: row.room_building || undefined,
      floor: row.room_floor ?? undefined,
      startTime: new Date(row.start_time).toISOString(),
      endTime: new Date(row.end_time).toISOString(),
      organizer: row.organizer_email || undefined,
    }));

    const roomMap = new Map<string, { room: string; building?: string; floor?: number; count: number }>();
    bookings.forEach(b => {
      const key = `${b.room}__${b.building || ''}__${b.floor ?? ''}`;
      const existing = roomMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        roomMap.set(key, { room: b.room, building: b.building, floor: b.floor, count: 1 });
      }
    });

    const rooms = Array.from(roomMap.values()).sort((a, b) => b.count - a.count);

    return {
      event: 'daily_summary',
      date: dateStr,
      timezone,
      totalBookings: bookings.length,
      rooms,
      bookings,
      appUrl,
    };
  }

  private getDateStringInTimezone(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find(p => p.type === 'year')?.value || '1970';
    const month = parts.find(p => p.type === 'month')?.value || '01';
    const day = parts.find(p => p.type === 'day')?.value || '01';
    return `${year}-${month}-${day}`;
  }

  private getDayRange(dateStr: string, timezone: string): { start: Date; end: Date } {
    const start = this.buildZonedDate(dateStr, '00:00', timezone);
    const end = this.buildZonedDate(dateStr, '23:59', timezone);
    return { start, end };
  }

  private buildZonedDate(dateStr: string, timeStr: string, timezone: string): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hour, minute] = timeStr.split(':').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0));
    const tzOffsetStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(utcDate).find(p => p.type === 'timeZoneName')?.value || '';
    const offsetMatch = tzOffsetStr.match(/GMT([+-])(\d{2}):(\d{2})/);
    let tzOffsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(offsetMatch[2], 10);
      const mins = parseInt(offsetMatch[3], 10);
      tzOffsetMinutes = sign * (hours * 60 + mins);
    }
    return new Date(utcDate.getTime() - tzOffsetMinutes * 60000);
  }

  private formatDailySummarySlack(summary: DailySummaryPayload) {
    const title = `Daily Summary — ${this.formatSummaryDate(summary.date, summary.timezone)}`;
    const topRooms = summary.rooms.slice(0, 6)
      .map(r => `• ${r.room}${r.building ? ` (${r.building})` : ''}: ${r.count}`)
      .join('\n') || 'No bookings today';
    const maxItems = 12;
    const bookingLines = summary.bookings.slice(0, maxItems).map(b => {
      const time = `${this.formatTime12h(b.startTime, summary.timezone)}–${this.formatTime12h(b.endTime, summary.timezone)}`;
      return `• ${time} · ${b.room} — ${b.title}`;
    }).join('\n') || 'No bookings scheduled';
    const appLine = summary.appUrl ? `*Open App:*\n${summary.appUrl}` : '';

    return {
      text: title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Total Bookings:*\n${summary.totalBookings}` },
            { type: 'mrkdwn', text: `*Timezone:*\n${summary.timezone}` },
          ],
        },
        { type: 'section', text: { type: 'mrkdwn', text: `*Top Rooms:*\n${topRooms}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Schedule (first ${maxItems}):*\n${bookingLines}` } },
        ...(appLine ? [{ type: 'section', text: { type: 'mrkdwn', text: appLine } }] : []),
      ],
    };
  }

  private formatDailySummaryTeams(summary: DailySummaryPayload) {
    const title = `Daily Summary — ${this.formatSummaryDate(summary.date, summary.timezone)}`;
    const topRooms = summary.rooms.slice(0, 6)
      .map(r => `${r.room}${r.building ? ` (${r.building})` : ''}: ${r.count}`)
      .join('\n') || 'No bookings today';
    const maxItems = 12;
    const bookingLines = summary.bookings.slice(0, maxItems).map(b => {
      const time = `${this.formatTime12h(b.startTime, summary.timezone)}–${this.formatTime12h(b.endTime, summary.timezone)}`;
      return `${time} · ${b.room} — ${b.title}`;
    }).join('\n') || 'No bookings scheduled';

    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: '0076D7',
      summary: title,
      sections: [{
        activityTitle: title,
        facts: [
          { name: 'Total Bookings', value: String(summary.totalBookings) },
          { name: 'Timezone', value: summary.timezone },
          { name: 'Top Rooms', value: topRooms },
          { name: `Schedule (first ${maxItems})`, value: bookingLines },
          ...(summary.appUrl ? [{ name: 'Open App', value: summary.appUrl }] : []),
        ],
      }],
    };
  }

  private formatDailySummaryRocket(summary: DailySummaryPayload) {
    const title = `Daily Summary — ${this.formatSummaryDate(summary.date, summary.timezone)}`;
    const topRooms = summary.rooms.slice(0, 6)
      .map(r => `• ${r.room}${r.building ? ` (${r.building})` : ''}: ${r.count}`)
      .join('\n') || 'No bookings today';
    const maxItems = 12;
    const bookingLines = summary.bookings.slice(0, maxItems).map(b => {
      const time = `${this.formatTime12h(b.startTime, summary.timezone)}–${this.formatTime12h(b.endTime, summary.timezone)}`;
      return `• ${time} · ${b.room} — ${b.title}`;
    }).join('\n') || 'No bookings scheduled';
    const appLine = summary.appUrl ? `\n*Open App:* ${summary.appUrl}` : '';

    return {
      text: `📋 *${title}*\n\n*Total Bookings:* ${summary.totalBookings}\n*Timezone:* ${summary.timezone}${appLine}\n\n*Top Rooms:*\n${topRooms}\n\n*Schedule (first ${maxItems}):*\n${bookingLines}`,
    };
  }

  private async postWithRetry(url: string, body: any) {
    const maxAttempts = 3;
    const baseDelay = 500;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Resolve and validate on every attempt so stored URLs, DNS changes, and
        // retries cannot silently redirect delivery into a private network.
        const policy = await webhookPolicyService.getPolicy();
        const destination = await validateWebhookUrl(url, policy);
        if (!destination.valid) {
          throw new Error(destination.error || 'Unsafe webhook destination');
        }
        const status = await this.postJsonToValidatedAddress(destination.url!, destination.addresses![0], body);
        if (status >= 200 && status < 300) return;
        if (status >= 300 && status < 400) {
          throw new Error('Webhook redirects are not allowed');
        }
        if (attempt === maxAttempts) {
          throw new Error(`Webhook failed with status ${status}`);
        }
      } catch (err) {
        if (attempt === maxAttempts) throw err;
      }
      await new Promise(r => setTimeout(r, baseDelay * attempt));
    }
  }

  private postJsonToValidatedAddress(url: URL, address: string, body: any): Promise<number> {
    const payload = JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        // Pin the connection to the public address that was just validated.
        // TLS still verifies the certificate against the URL hostname.
        lookup: createPinnedWebhookLookup(address) as any,
      }, response => {
        response.resume();
        resolve(response.statusCode || 0);
      });
      request.setTimeout(5000, () => request.destroy(new Error('Webhook request timed out')));
      request.on('error', reject);
      request.end(payload);
    });
  }
}

export const webhookService = new WebhookService();
