import { pool } from '../config/database';
import { webhookService } from './webhook.service';
import { recordOperationalError, recordOperationalWarning } from './diagnostics.service';

export class DailySummaryService {
  private timer?: NodeJS.Timeout;

  init() {
    this.scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private async scheduleNext() {
    try {
      const timezone = await this.getTimezone();
      const rawTime = (process.env.DAILY_SUMMARY_TIME || '07:00').trim();
      const timeStr = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : '07:00';
      if (timeStr !== rawTime) {
        recordOperationalWarning({
          source: 'scheduler',
          category: 'configuration',
          message: 'Invalid daily summary time; using 07:00',
        });
      }
      const now = new Date();
      const todayStr = this.getDateStringInTimezone(now, timezone);
      let target = this.buildZonedDate(todayStr, timeStr, timezone);

      if (target.getTime() <= now.getTime()) {
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const tomorrowStr = this.getDateStringInTimezone(tomorrow, timezone);
        target = this.buildZonedDate(tomorrowStr, timeStr, timezone);
      }

      const delay = Math.max(target.getTime() - now.getTime(), 60 * 1000);
      this.timer = setTimeout(async () => {
        await webhookService.sendDailySummary();
        this.scheduleNext();
      }, delay);
    } catch (err) {
      recordOperationalError({
        source: 'scheduler',
        category: 'daily_summary',
        message: 'Daily summary scheduling failed; retrying in one hour',
      }, err);
      this.timer = setTimeout(() => this.scheduleNext(), 60 * 60 * 1000);
    }
  }

  private async getTimezone(): Promise<string> {
    try {
      const result = await pool.query('SELECT timezone FROM site_config WHERE id = 1');
      if (result.rows.length > 0 && (result.rows[0] as any).timezone) {
        return (result.rows[0] as any).timezone;
      }
    } catch (error) {
      recordOperationalWarning({
        source: 'scheduler',
        category: 'timezone_fallback',
        message: 'Daily summary scheduler could not load the workspace timezone; using the default',
      }, error);
    }
    return 'America/Chicago';
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
}

export const dailySummaryService = new DailySummaryService();
