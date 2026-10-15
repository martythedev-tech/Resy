import nodemailer, { Transporter } from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';
import { getUploadsDir } from '../config/paths';
import { formatNotificationChangeValue, formatNotificationDateTime } from './notificationFormatting';
import { recordOperationalError, recordOperationalWarning } from './diagnostics.service';

export interface EmailPayload {
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
  equipment?: string[];  // Technology equipment requested
  notes?: string;        // Meeting notes
  custom_fields?: Record<string, any>;
  recurrence_summary?: string;
  changes?: Record<string, { from: any; to: any }>;
}

export interface EmailConfig {
  id: number;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  from_email: string;
  from_name: string;
  is_enabled: number;
}

export interface EmailBranding {
  companyName: string;
  brandTagline: string;
  logoSrc?: string;
  logoAttachment?: { filename: string; path: string; cid: string };
}

type BrandedEmailPayload = EmailPayload & { emailBranding: EmailBranding };

const DEFAULT_EMAIL_BRANDING: EmailBranding = {
  companyName: 'Resy',
  brandTagline: 'Room booking',
};

const EMAIL_LOGO_CID = 'resy-workspace-logo';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class EmailService {
  async send(payload: EmailPayload) {
    try {
      const config = await this.getConfig();
      if (!config || !config.is_enabled) return;
      if (!config.smtp_host || !config.from_email) return;

      const [timezone, emailBranding] = await Promise.all([this.getTimezone(), this.getEmailBranding()]);
      const transporter = this.createTransporter(config);
      const { subject, html, text, attachments } = this.buildEmail(payload, timezone, emailBranding);

      await transporter.sendMail({
        from: `"${config.from_name}" <${config.from_email}>`,
        to: payload.organizer,
        subject,
        html,
        text,
        attachments,
      });
    } catch (err) {
      recordOperationalError({
        source: 'email',
        category: 'delivery',
        message: 'Booking email delivery failed',
        metadata: { event: payload.event, booking_id: payload.booking_id },
      }, err);
    }
  }

  async getConfig(): Promise<EmailConfig | null> {
    const result = await pool.query('SELECT * FROM email_config WHERE id = 1');
    return (result.rows[0] as EmailConfig) || null;
  }

  async testEmail(toAddress: string): Promise<void> {
    const config = await this.getConfig();
    if (!config || !config.smtp_host) {
      throw new Error('SMTP not configured');
    }

    const transporter = this.createTransporter(config);
    await transporter.verify();
    const emailBranding = await this.getEmailBranding();

    await transporter.sendMail({
      from: `"${config.from_name}" <${config.from_email}>`,
      to: toAddress,
      subject: `${emailBranding.companyName} — SMTP Test`,
      html: this.wrapTemplate('#4F46E5', '&#9989;', 'SMTP Test Successful', `
        <tr>
          <td style="padding:16px 0; font-size:14px; color:#333; text-align:center;">
            Your email configuration is working correctly.
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0; font-size:13px; color:#999; text-align:center;">
            Sent from: ${escapeHtml(config.from_email)}
          </td>
        </tr>
      `, emailBranding),
      attachments: this.getBrandingAttachments(emailBranding),
    });
  }

  private createTransporter(config: EmailConfig): Transporter {
    return nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_port === 465,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_password,
      },
    });
  }

  private buildEmail(
    payload: EmailPayload,
    timezone: string,
    emailBranding: EmailBranding = DEFAULT_EMAIL_BRANDING,
  ): { subject: string; html: string; text: string; attachments: any[] } {
    const brandedPayload: BrandedEmailPayload = { ...payload, emailBranding };
    const brandingAttachments = this.getBrandingAttachments(emailBranding);
    const confirmedInvite = payload.status === 'confirmed' ? [this.buildIcsAttachment(payload)] : [];
    switch (payload.event) {
      case 'booking_created':
        return {
          subject: `Booking Confirmed: ${payload.title}`,
          html: this.templateCreated(brandedPayload, timezone),
          text: this.textCreated(payload, timezone),
          attachments: [...brandingAttachments, ...confirmedInvite],
        };
      case 'booking_pending':
        return {
          subject: `Booking Pending Approval: ${payload.title}`,
          html: this.templatePending(brandedPayload, timezone),
          text: this.textPending(payload, timezone),
          attachments: brandingAttachments,
        };
      case 'booking_updated':
        return {
          subject: `Booking Updated: ${payload.title}`,
          html: this.templateUpdated(brandedPayload, timezone),
          text: this.textUpdated(payload, timezone),
          attachments: [...brandingAttachments, ...confirmedInvite],
        };
      case 'booking_cancelled':
        return {
          subject: `Booking Cancelled: ${payload.title}`,
          html: this.templateCancelled(brandedPayload, timezone),
          text: this.textCancelled(payload, timezone),
          attachments: [...brandingAttachments, this.buildIcsAttachment(payload, true)],
        };
      case 'no_show':
        return {
          subject: `No-Show Recorded: ${payload.title}`,
          html: this.templateNoShow(brandedPayload, timezone),
          text: this.textNoShow(payload, timezone),
          attachments: brandingAttachments,
        };
    }
  }

  private wrapTemplate(
    headerColor: string,
    icon: string,
    headline: string,
    bodyHtml: string,
    emailBranding: EmailBranding = DEFAULT_EMAIL_BRANDING,
  ): string {
    const companyName = emailBranding.companyName.trim() || DEFAULT_EMAIL_BRANDING.companyName;
    const brandTagline = emailBranding.brandTagline.trim();
    const identityHtml = emailBranding.logoSrc
      ? `<img src="${escapeHtml(emailBranding.logoSrc)}" alt="${escapeHtml(companyName)}" style="display:block; max-width:170px; max-height:34px; width:auto; height:auto; object-fit:contain;" />`
      : `<span style="font-weight:700;">${escapeHtml(companyName)}</span>`;
    const taglineHtml = brandTagline
      ? `<span style="font-weight:700; letter-spacing:1.4px; text-transform:uppercase;">${escapeHtml(brandTagline)}</span>`
      : '';
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
      </head>
      <body style="margin:0; padding:0; background:#F4F6FB; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; color:#172033;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F4F6FB;">
          <tr><td style="padding:32px 16px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                   style="max-width:600px; margin:0 auto; background:#FFFFFF; border:1px solid #E4E8F0; border-radius:18px; overflow:hidden; box-shadow:0 12px 32px rgba(23,32,51,0.08);">
              <tr>
                <td style="background:${headerColor}; padding:22px 28px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                      <td style="color:rgba(255,255,255,0.82); font-size:12px;">
                        <table role="presentation" cellspacing="0" cellpadding="0">
                          <tr>
                            <td style="vertical-align:middle;">${identityHtml}</td>
                            ${taglineHtml ? `<td style="padding-left:14px; vertical-align:middle;">${taglineHtml}</td>` : ''}
                          </tr>
                        </table>
                      </td>
                      <td width="44" align="right"><span style="display:inline-block; width:40px; height:40px; line-height:40px; border-radius:12px; background:rgba(255,255,255,0.16); text-align:center; font-size:22px;">${icon}</span></td>
                    </tr>
                  </table>
                  <h1 style="margin:18px 0 2px; color:#FFFFFF; font-size:24px; line-height:1.25; font-weight:700; letter-spacing:-0.3px;">${headline}</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:28px;">
                  <table role="presentation" cellspacing="0" cellpadding="0" align="left" style="width:100%; max-width:100%; table-layout:fixed;">
                    ${bodyHtml}
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:18px 28px; border-top:1px solid #E8EBF2; background:#FAFBFD; text-align:center;">
                  <span style="font-size:12px; color:#788398;">Sent by Resy</span>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `;
  }

  private detailRow(label: string, value: string, trustedHtml = false): string {
    const safeValue = trustedHtml ? value : escapeHtml(value);
    return `
      <tr>
        <td style="padding:7px 12px 7px 0; font-size:12px; color:#788398; width:112px; vertical-align:top; white-space:nowrap; text-align:left; line-height:1.45; font-weight:600;">${escapeHtml(label)}</td>
        <td style="padding:7px 0; font-size:14px; color:#172033; vertical-align:top; text-align:left; line-height:1.45; font-weight:500; overflow-wrap:anywhere;">${safeValue}</td>
      </tr>
    `;
  }

  private bookingLinkRow(url: string): string {
    return this.detailRow('Link', `<a href="${escapeHtml(url)}" style="color:#4F46E5; font-weight:600;">View Booking</a>`, true);
  }

  private formatCustomFieldLabel(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private formatCustomFields(customFields?: Record<string, any>): string {
    if (!customFields || Object.keys(customFields).length === 0) return '';
    const lines = Object.entries(customFields)
      .filter(([, value]) => value !== undefined && value !== '' && value !== false)
      .map(([key, value]) => `${escapeHtml(this.formatCustomFieldLabel(key))}: ${escapeHtml(value === true ? 'Yes' : value)}`);
    if (lines.length === 0) return '';
    return this.detailRow('Details', lines.join('<br/>'), true);
  }

  private async getTimezone(): Promise<string> {
    try {
      const result = await pool.query('SELECT timezone FROM site_config WHERE id = 1');
      if (result.rows.length > 0 && (result.rows[0] as any).timezone) {
        return (result.rows[0] as any).timezone;
      }
    } catch (err) {
      recordOperationalWarning({
        source: 'email',
        category: 'timezone_fallback',
        message: 'Email service could not load the workspace timezone; using the default',
      }, err);
    }
    return 'America/Chicago'; // default fallback
  }

  private async getEmailBranding(): Promise<EmailBranding> {
    try {
      const result = await pool.query('SELECT company_name, brand_tagline, logo_url FROM site_config WHERE id = 1');
      if (result.rows.length > 0) {
        const row = result.rows[0] as any;
        const branding: EmailBranding = {
          companyName: typeof row.company_name === 'string' && row.company_name.trim()
            ? row.company_name.trim()
            : DEFAULT_EMAIL_BRANDING.companyName,
          brandTagline: typeof row.brand_tagline === 'string'
            ? row.brand_tagline.trim()
            : DEFAULT_EMAIL_BRANDING.brandTagline,
        };
        const logoUrl = typeof row.logo_url === 'string' ? row.logo_url.trim() : '';
        if (/^https:\/\//i.test(logoUrl)) {
          branding.logoSrc = logoUrl;
        } else if (/^\/uploads\/branding\/[A-Za-z0-9._-]+$/.test(logoUrl)) {
          const filename = path.basename(logoUrl);
          const logoPath = path.join(getUploadsDir(), 'branding', filename);
          if (fs.existsSync(logoPath) && fs.statSync(logoPath).isFile()) {
            branding.logoSrc = `cid:${EMAIL_LOGO_CID}`;
            branding.logoAttachment = { filename, path: logoPath, cid: EMAIL_LOGO_CID };
          }
        }
        return branding;
      }
    } catch (err) {
      recordOperationalWarning({
        source: 'email',
        category: 'branding_fallback',
        message: 'Email service could not load workspace branding; using defaults',
      }, err);
    }
    return DEFAULT_EMAIL_BRANDING;
  }

  private getBrandingAttachments(emailBranding: EmailBranding): any[] {
    return emailBranding.logoAttachment ? [emailBranding.logoAttachment] : [];
  }

  private formatTime12h(isoString: string, timezone: string): string {
    return formatNotificationDateTime(isoString, timezone);
  }

  private formatChangeValue(key: string, value: any, timezone: string): string {
    return formatNotificationChangeValue(key, value, timezone);
  }

  private formatChanges(
    changes: Record<string, { from: any; to: any }>,
    timezone: string,
    separator: string
  ): string {
    return Object.entries(changes)
      .map(([key, value]) => {
        const from = this.formatChangeValue(key, value.from, timezone);
        const to = this.formatChangeValue(key, value.to, timezone);
        return `${key}: ${from} → ${to}`;
      })
      .join(separator);
  }

  private formatChangesHtml(changes: Record<string, { from: any; to: any }>, timezone: string): string {
    return Object.entries(changes)
      .map(([key, value]) => {
        const from = this.formatChangeValue(key, value.from, timezone);
        const to = this.formatChangeValue(key, value.to, timezone);
        return `${escapeHtml(key)}: ${escapeHtml(from)} → ${escapeHtml(to)}`;
      })
      .join('<br/>');
  }

  private templateCreated(p: BrandedEmailPayload, timezone: string): string {
    const timeFormatted = `${this.formatTime12h(p.startTime, timezone)} – ${this.formatTime12h(p.endTime, timezone)} (${timezone})`;
    let body = this.detailRow('Room', p.room) +
      (p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : '') +
      this.detailRow('Date / time', timeFormatted) +
      this.detailRow('Meeting', p.title);
    body += this.detailRow('Booking ID', String(p.booking_id));
    if (p.recurrence_summary) {
      body += this.detailRow('Recurrence', p.recurrence_summary);
    }
    if (p.equipment && p.equipment.length > 0) {
      body += this.detailRow('Technology', p.equipment.join(', '));
    }
    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }
    return this.wrapTemplate('#4F46E5', '&#10004;', 'Booking Confirmed', body, p.emailBranding);
  }

  private templatePending(p: BrandedEmailPayload, timezone: string): string {
    const timeFormatted = `${this.formatTime12h(p.startTime, timezone)} – ${this.formatTime12h(p.endTime, timezone)} (${timezone})`;
    let body = this.detailRow('Room', p.room) +
      (p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : '') +
      this.detailRow('Date / time', timeFormatted) +
      this.detailRow('Meeting', p.title);
    body += this.detailRow('Booking ID', String(p.booking_id));
    if (p.recurrence_summary) {
      body += this.detailRow('Recurrence', p.recurrence_summary);
    }
    body += this.detailRow('Status', 'Pending approval');
    if (p.equipment && p.equipment.length > 0) {
      body += this.detailRow('Technology', p.equipment.join(', '));
    }
    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }
    return this.wrapTemplate('#F59E0B', '&#9203;', 'Booking Pending Approval', body, p.emailBranding);
  }

  private templateUpdated(p: BrandedEmailPayload, timezone: string): string {
    const timeFormatted = `${this.formatTime12h(p.startTime, timezone)} – ${this.formatTime12h(p.endTime, timezone)} (${timezone})`;
    let body = this.detailRow('Room', p.room) +
      (p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : '') +
      this.detailRow('Date / time', timeFormatted) +
      this.detailRow('Meeting', p.title);
    body += this.detailRow('Booking ID', String(p.booking_id));
    if (p.recurrence_summary) {
      body += this.detailRow('Recurrence', p.recurrence_summary);
    }
    if (p.equipment && p.equipment.length > 0) {
      body += this.detailRow('Technology', p.equipment.join(', '));
    }
    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.changes && Object.keys(p.changes).length > 0) {
      const diff = this.formatChangesHtml(p.changes, timezone);
      body += this.detailRow('Changes', diff, true);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }
    return this.wrapTemplate('#7C3AED', '&#9998;', 'Booking Updated', body, p.emailBranding);
  }

  private templateCancelled(p: BrandedEmailPayload, timezone: string): string {
    const timeFormatted = `${this.formatTime12h(p.startTime, timezone)} – ${this.formatTime12h(p.endTime, timezone)} (${timezone})`;
    return this.wrapTemplate(
      '#EA580C',
      '&#10007;',
      'Booking Cancelled',
      this.detailRow('Room', p.room) +
      (p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : '') +
      this.detailRow('Date / time', timeFormatted) +
      this.detailRow('Meeting', p.title) +
      this.detailRow('Booking ID', String(p.booking_id)) +
      (p.equipment && p.equipment.length > 0 ? this.detailRow('Technology', p.equipment.join(', ')) : '') +
      (p.notes ? this.detailRow('Notes', p.notes) : '') +
      (p.reason ? this.detailRow('Reason', p.reason) : '') +
      (p.custom_fields ? this.formatCustomFields(p.custom_fields) : '') +
      (p.bookingUrl ? this.bookingLinkRow(p.bookingUrl) : ''),
      p.emailBranding,
    );
  }

  private templateNoShow(p: BrandedEmailPayload, timezone: string): string {
    const timeFormatted = `${this.formatTime12h(p.startTime, timezone)} – ${this.formatTime12h(p.endTime, timezone)} (${timezone})`;
    return this.wrapTemplate(
      '#DC2626',
      '&#9888;',
      'No-Show Recorded',
      this.detailRow('Room', p.room) +
      (p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : '') +
      this.detailRow('Date / time', timeFormatted) +
      this.detailRow('Meeting', p.title) +
      this.detailRow('Booking ID', String(p.booking_id)) +
      (p.equipment && p.equipment.length > 0 ? this.detailRow('Technology', p.equipment.join(', ')) : '') +
      (p.notes ? this.detailRow('Notes', p.notes) : '') +
      this.detailRow('Reason', p.reason || 'No check-in within grace period') +
      (p.custom_fields ? this.formatCustomFields(p.custom_fields) : '') +
      (p.bookingUrl ? this.bookingLinkRow(p.bookingUrl) : ''),
      p.emailBranding,
    );
  }

  /**
   * Send notifications to all room managers AND admins who have notification delivery enabled.
   */
  async notifyRoomManagers(payload: EmailPayload) {
    try {
      const config = await this.getConfig();
      if (!config || !config.is_enabled) return;
      if (!config.smtp_host || !config.from_email) return;

      // Get all room managers AND admins who opted into administrative booking notifications.
      const result = await pool.query(
        `SELECT email, name, role
         FROM users
         WHERE (role = 'room_manager' OR role = 'admin')
           AND is_active = 1
           AND COALESCE(receives_admin_notifications, 1) = 1`
      );

      if (result.rows.length === 0) return;

      const [timezone, emailBranding] = await Promise.all([this.getTimezone(), this.getEmailBranding()]);
      const transporter = this.createTransporter(config);

      // Build subject and template based on event type
      const { subject, html, attachments } = this.buildRoomManagerEmail(payload, timezone, emailBranding);

      // Send email to each room manager and admin
      for (const user of result.rows as any[]) {
        try {
          await transporter.sendMail({
            from: `"${config.from_name}" <${config.from_email}>`,
            to: user.email,
            subject,
            html: html.replace('{{managerName}}', escapeHtml(user.name || '')),
            attachments,
          });
        } catch (err) {
          recordOperationalError({
            source: 'email',
            category: 'administrative_delivery',
            message: 'Administrative booking email delivery failed',
            metadata: { event: payload.event, booking_id: payload.booking_id, recipient_role: user.role },
          }, err);
        }
      }
    } catch (err) {
      recordOperationalError({
        source: 'email',
        category: 'administrative_dispatch',
        message: 'Administrative booking notification dispatch failed',
        metadata: { event: payload.event, booking_id: payload.booking_id },
      }, err);
    }
  }

  private buildRoomManagerEmail(
    payload: EmailPayload,
    timezone: string,
    emailBranding: EmailBranding = DEFAULT_EMAIL_BRANDING,
  ): { subject: string; html: string; attachments: any[] } {
    const brandedPayload: BrandedEmailPayload = { ...payload, emailBranding };
    const attachments = this.getBrandingAttachments(emailBranding);
    const timeFormatted = `${this.formatTime12h(payload.startTime, timezone)} – ${this.formatTime12h(payload.endTime, timezone)} (${timezone})`;

    switch (payload.event) {
      case 'booking_created':
        return {
          subject: `New Booking: ${payload.room} - ${payload.title}`,
          html: this.templateRoomManagerCreated(brandedPayload, timeFormatted),
          attachments,
        };
      case 'booking_pending':
        return {
          subject: `Approval Needed: ${payload.room} - ${payload.title}`,
          html: this.templateRoomManagerPending(brandedPayload, timeFormatted),
          attachments,
        };
      case 'booking_updated':
        return {
          subject: `Booking Updated: ${payload.room} - ${payload.title}`,
          html: this.templateRoomManagerUpdated(brandedPayload, timeFormatted, timezone),
          attachments,
        };
      case 'booking_cancelled':
        return {
          subject: `Booking Cancelled: ${payload.room} - ${payload.title}`,
          html: this.templateRoomManagerCancelled(brandedPayload, timeFormatted),
          attachments,
        };
      case 'no_show':
        return {
          subject: `No-Show: ${payload.room} - ${payload.title}`,
          html: this.templateRoomManagerNoShow(brandedPayload, timeFormatted),
          attachments,
        };
    }
  }

  private templateRoomManagerCreated(p: BrandedEmailPayload, timeFormatted: string): string {
    let body = `
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          Hi {{managerName}},
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          A new booking has been created:
        </td>
      </tr>
      ${this.detailRow('Room', p.room)}
      ${p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : ''}
      ${this.detailRow('Date / time', timeFormatted)}
      ${this.detailRow('Meeting', p.title)}
      ${this.detailRow('Organizer', p.organizer)}
      ${this.detailRow('Booking ID', String(p.booking_id))}
      ${p.recurrence_summary ? this.detailRow('Recurrence', p.recurrence_summary) : ''}
    `;

    if (p.equipment && p.equipment.length > 0) {
      const equipmentHtml = p.equipment.map(eq =>
        `<li style="padding:4px 0; color:#333;">${escapeHtml(eq)}</li>`
      ).join('');
      body += `
        <tr>
          <td colspan="2" style="padding:16px 0 8px;">
            <strong style="font-size:13px; color:#e65100; text-transform:uppercase; letter-spacing:0.5px;">
              &#128736; Technology Setup Required:
            </strong>
            <ul style="margin:8px 0; padding-left:20px;">
              ${equipmentHtml}
            </ul>
          </td>
        </tr>
      `;
    }

    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }

    return this.wrapTemplate('#4F46E5', '&#128197;', 'New Booking', body, p.emailBranding);
  }

  private templateRoomManagerPending(p: BrandedEmailPayload, timeFormatted: string): string {
    let body = `
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          Hi {{managerName}},
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          This booking requires approval:
        </td>
      </tr>
      ${this.detailRow('Room', p.room)}
      ${p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : ''}
      ${this.detailRow('Date / time', timeFormatted)}
      ${this.detailRow('Meeting', p.title)}
      ${this.detailRow('Organizer', p.organizer)}
      ${this.detailRow('Booking ID', String(p.booking_id))}
      ${p.recurrence_summary ? this.detailRow('Recurrence', p.recurrence_summary) : ''}
    `;

    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.equipment && p.equipment.length > 0) {
      body += this.detailRow('Technology', p.equipment.join(', '));
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }

    if (p.approveUrl || p.rejectUrl) {
      body += `
        <tr>
          <td colspan="2" style="padding:18px 0; text-align:center;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto; text-align:center;">
              <tr>
                ${p.approveUrl ? `
                <td style="padding-right:6px;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#16a34a" style="border-radius:10px;">
                        <a href="${escapeHtml(p.approveUrl)}" style="display:inline-block; width:140px; text-align:center; padding:12px 10px; color:#fff; text-decoration:none; border-radius:10px; font-size:13px; font-weight:600;">
                          Approve
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>` : ''}
                ${p.rejectUrl ? `
                <td style="padding-left:6px;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#dc2626" style="border-radius:10px;">
                        <a href="${escapeHtml(p.rejectUrl)}" style="display:inline-block; width:140px; text-align:center; padding:12px 10px; color:#fff; text-decoration:none; border-radius:10px; font-size:13px; font-weight:600;">
                          Reject
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>` : ''}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding:0 0 12px; font-size:12px; color:#6b7280;">
            Approval links expire after 48 hours.
          </td>
        </tr>
      `;
    }

    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }

    return this.wrapTemplate('#F59E0B', '&#9203;', 'Approval Required', body, p.emailBranding);
  }

  private templateRoomManagerUpdated(p: BrandedEmailPayload, timeFormatted: string, timezone: string): string {
    let body = `
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          Hi {{managerName}},
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          A booking has been updated:
        </td>
      </tr>
      ${this.detailRow('Room', p.room)}
      ${p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : ''}
      ${this.detailRow('Date / time', timeFormatted)}
      ${this.detailRow('Meeting', p.title)}
      ${this.detailRow('Organizer', p.organizer)}
      ${this.detailRow('Booking ID', String(p.booking_id))}
      ${p.recurrence_summary ? this.detailRow('Recurrence', p.recurrence_summary) : ''}
    `;

    if (p.equipment && p.equipment.length > 0) {
      const equipmentHtml = p.equipment.map(eq =>
        `<li style="padding:4px 0; color:#333;">${escapeHtml(eq)}</li>`
      ).join('');
      body += `
        <tr>
          <td colspan="2" style="padding:16px 0 8px;">
            <strong style="font-size:13px; color:#e65100; text-transform:uppercase; letter-spacing:0.5px;">
              &#128736; Technology Setup Required:
            </strong>
            <ul style="margin:8px 0; padding-left:20px;">
              ${equipmentHtml}
            </ul>
          </td>
        </tr>
      `;
    }

    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.changes && Object.keys(p.changes).length > 0) {
      const diff = this.formatChangesHtml(p.changes, timezone);
      body += this.detailRow('Changes', diff, true);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }

    return this.wrapTemplate('#7C3AED', '&#9998;', 'Booking Updated', body, p.emailBranding);
  }

  private templateRoomManagerCancelled(p: BrandedEmailPayload, timeFormatted: string): string {
    let body = `
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          Hi {{managerName}},
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          A booking has been cancelled:
        </td>
      </tr>
      ${this.detailRow('Room', p.room)}
      ${p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : ''}
      ${this.detailRow('Date / time', timeFormatted)}
      ${this.detailRow('Meeting', p.title)}
      ${this.detailRow('Organizer', p.organizer)}
      ${this.detailRow('Booking ID', String(p.booking_id))}
      ${p.recurrence_summary ? this.detailRow('Recurrence', p.recurrence_summary) : ''}
      ${p.reason ? this.detailRow('Reason', p.reason) : ''}
    `;

    if (p.equipment && p.equipment.length > 0) {
      body += this.detailRow('Technology', p.equipment.join(', '));
    }
    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }

    return this.wrapTemplate('#EA580C', '&#10007;', 'Booking Cancelled', body, p.emailBranding);
  }

  private templateRoomManagerNoShow(p: BrandedEmailPayload, timeFormatted: string): string {
    let body = `
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          Hi {{managerName}},
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 16px; font-size:14px; color:#333;">
          A no-show has been recorded:
        </td>
      </tr>
      ${this.detailRow('Room', p.room)}
      ${p.building ? this.detailRow('Building', `${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}`) : ''}
      ${this.detailRow('Date / time', timeFormatted)}
      ${this.detailRow('Meeting', p.title)}
      ${this.detailRow('Organizer', p.organizer)}
      ${this.detailRow('Booking ID', String(p.booking_id))}
      ${p.recurrence_summary ? this.detailRow('Recurrence', p.recurrence_summary) : ''}
      ${this.detailRow('Status', 'Auto-cancelled due to no check-in')}
      ${this.detailRow('Reason', p.reason || 'No check-in within grace period')}
    `;

    if (p.equipment && p.equipment.length > 0) {
      body += this.detailRow('Technology', p.equipment.join(', '));
    }
    if (p.notes) {
      body += this.detailRow('Notes', p.notes);
    }
    if (p.custom_fields) {
      body += this.formatCustomFields(p.custom_fields);
    }
    if (p.bookingUrl) {
      body += this.bookingLinkRow(p.bookingUrl);
    }

    return this.wrapTemplate('#DC2626', '&#9888;', 'No-Show Recorded', body, p.emailBranding);
  }

  private buildIcsAttachment(p: EmailPayload, isCancelled = false) {
    // Keep the legacy UID namespace stable so updates and cancellations continue
    // to match calendar events created before the product rename.
    const uid = `booking-${p.booking_id}@resy`;
    const dtStart = this.formatIcsDate(p.startTime);
    const dtEnd = this.formatIcsDate(p.endTime);
    const status = isCancelled ? 'CANCELLED' : 'CONFIRMED';
    const summary = this.escapeIcsText(p.title);
    const location = this.escapeIcsText(p.building ? `${p.room}, ${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}` : p.room);
    const description = this.escapeIcsText([
      `Organizer: ${p.organizer}`,
      `Booking ID: ${p.booking_id}`,
      p.recurrence_summary ? `Recurrence: ${p.recurrence_summary}` : '',
      p.notes ? `Notes: ${p.notes}` : '',
      p.equipment && p.equipment.length > 0 ? `Technology: ${p.equipment.join(', ')}` : '',
      p.bookingUrl ? `Link: ${p.bookingUrl}` : '',
    ].filter(Boolean).join('\n'));

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Resy//EN',
      'CALSCALE:GREGORIAN',
      `METHOD:${isCancelled ? 'CANCEL' : 'REQUEST'}`,
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${this.formatIcsDate(new Date().toISOString())}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${summary}`,
      `LOCATION:${location}`,
      `DESCRIPTION:${description}`,
      `STATUS:${status}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    return {
      filename: 'booking.ics',
      content: ics,
      contentType: `text/calendar; method=${isCancelled ? 'CANCEL' : 'REQUEST'}; charset=UTF-8`,
    };
  }

  private formatIcsDate(isoString: string): string {
    const d = new Date(isoString);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }

  private escapeIcsText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  private textBase(p: EmailPayload, timezone: string) {
    const time = `${this.formatTime12h(p.startTime, timezone)} - ${this.formatTime12h(p.endTime, timezone)} (${timezone})`;
    const customFields = p.custom_fields && Object.keys(p.custom_fields).length > 0
      ? `Details: ${Object.entries(p.custom_fields)
          .filter(([, value]) => value !== undefined && value !== '' && value !== false)
          .map(([k, v]) => `${this.formatCustomFieldLabel(k)}: ${v === true ? 'Yes' : v}`)
          .join(', ')}`
      : '';
    const lines = [
      `Booking ID: ${p.booking_id}`,
      `Room: ${p.room}`,
      p.building ? `Building: ${p.building}${p.floor !== undefined ? ` (Floor ${p.floor})` : ''}` : '',
      `Date / time: ${time}`,
      `Meeting: ${p.title}`,
      p.recurrence_summary ? `Recurrence: ${p.recurrence_summary}` : '',
      p.equipment && p.equipment.length > 0 ? `Technology: ${p.equipment.join(', ')}` : '',
      p.notes ? `Notes: ${p.notes}` : '',
      customFields,
      p.reason ? `Reason: ${p.reason}` : '',
      p.bookingUrl ? `Link: ${p.bookingUrl}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private textCreated(p: EmailPayload, timezone: string): string {
    return `Booking Confirmed\n\n${this.textBase(p, timezone)}`;
  }

  private textPending(p: EmailPayload, timezone: string): string {
    return `Booking Pending Approval\n\n${this.textBase(p, timezone)}`;
  }

  private textUpdated(p: EmailPayload, timezone: string): string {
    const diff = p.changes && Object.keys(p.changes).length > 0
      ? `\nChanges:\n${this.formatChanges(p.changes, timezone, '\n').split('\n').map(line => `- ${line}`).join('\n')}`
      : '';
    return `Booking Updated\n\n${this.textBase(p, timezone)}${diff}`;
  }

  private textCancelled(p: EmailPayload, timezone: string): string {
    return `Booking Cancelled\n\n${this.textBase(p, timezone)}`;
  }

  private textNoShow(p: EmailPayload, timezone: string): string {
    return `No-Show Recorded\n\n${this.textBase(p, timezone)}`;
  }
}

export const emailService = new EmailService();
