import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  Archive, CalendarClock, CheckCircle2, Database, HardDrive, Info,
  LockKeyhole, PlayCircle, RefreshCw, Search, ShieldCheck,
} from 'lucide-react';
import { api } from '../../config/api';
import { useNotification } from '../../contexts/NotificationContext';

interface RetentionSummary {
  retention_months: number;
  enabled: boolean;
  backup_retention_days: number;
  cutoff: string;
  eligible_count: number;
  held_count: number;
  anonymized_count: number;
  oldest_eligible_at: string | null;
  database_bytes: number;
  reusable_bytes: number;
}

interface RetentionBooking {
  id: number;
  title: string;
  end_time: string;
  status: string;
  retention_hold: number;
  room_name: string | null;
  organizer_name: string | null;
  organizer_email: string | null;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (value?: string | null) => value
  ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  : 'None';

export const AdminRetention = () => {
  const { success, error } = useNotification();
  const [summary, setSummary] = useState<RetentionSummary | null>(null);
  const [months, setMonths] = useState(36);
  const [backupDays, setBackupDays] = useState(90);
  const [enabled, setEnabled] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RetentionBooking[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getRetentionSummary();
      setSummary(data);
      setMonths(data.retention_months);
      setBackupDays(data.backup_retention_days);
      setEnabled(Boolean(data.enabled));
    } catch (caught: any) {
      error(caught.message || 'Failed to load retention settings');
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = async () => {
    setWorking(true);
    try {
      const data = await api.updateRetentionConfig({
        retention_months: months,
        backup_retention_days: backupDays,
        enabled,
        confirm_backups: enabled ? backupConfirmed : false,
      });
      setSummary(data);
      setBackupConfirmed(false);
      success('Retention settings saved');
    } catch (caught: any) {
      error(caught.message || 'Failed to save retention settings');
    } finally {
      setWorking(false);
    }
  };

  const runNow = async () => {
    setWorking(true);
    try {
      const result = await api.runRetention(true);
      setSummary(result.preview);
      setRunConfirmed(false);
      success(`Anonymized ${result.processed || 0} expired booking record(s)`);
    } catch (caught: any) {
      error(caught.message || 'Retention run failed');
    } finally {
      setWorking(false);
    }
  };

  const searchBookings = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const results = await api.searchRetentionBookings(searchQuery.trim());
      setSearchResults(results);
      setHasSearched(true);
    } catch (caught: any) {
      error(caught.message || 'Booking search failed');
    } finally {
      setSearching(false);
    }
  };

  const setHold = async (bookingId: number, hold: boolean) => {
    setWorking(true);
    try {
      await api.setBookingRetentionHold(bookingId, hold);
      setSearchResults(results => results.map(item => item.id === bookingId ? { ...item, retention_hold: hold ? 1 : 0 } : item));
      await refresh();
      success(`Retention hold ${hold ? 'applied' : 'released'}`);
    } catch (caught: any) {
      error(caught.message || 'Failed to update retention hold');
    } finally {
      setWorking(false);
    }
  };

  if (loading && !summary) {
    return <div className="admin-section"><div className="loading"><span className="loading-indicator" />Loading retention settings…</div></div>;
  }

  const eligibleCount = summary?.eligible_count || 0;
  const automationNeedsConfirmation = enabled && !backupConfirmed;

  return (
    <div className="admin-section retention-section">
      <section className="retention-explainer card">
        <div className="retention-explainer-icon"><ShieldCheck size={22} /></div>
        <div>
          <span className="eyebrow">Privacy lifecycle</span>
          <h3>Keep useful history without keeping personal details forever</h3>
          <p>Resy never deletes the booking itself. When a completed booking becomes old enough, Resy removes names and free-text details while preserving the room, date, duration, equipment, and status for reporting.</p>
        </div>
      </section>

      <div className="retention-steps" aria-label="Retention workflow">
        <div><span>1</span><strong>Choose a period</strong><small>Detailed history remains visible for this long.</small></div>
        <div><span>2</span><strong>Review the preview</strong><small>See exactly how many records are eligible.</small></div>
        <div><span>3</span><strong>Anonymize safely</strong><small>Run manually or enable the daily schedule after backup confirmation.</small></div>
      </div>

      <div className="diagnostics-health-grid retention-summary-grid">
        <div className="diagnostic-health-card card"><Archive size={19} /><div><span>Ready now</span><strong>{eligibleCount}</strong><small>past the cutoff</small></div></div>
        <div className="diagnostic-health-card card"><LockKeyhole size={19} /><div><span>Protected</span><strong>{summary?.held_count || 0}</strong><small>on retention hold</small></div></div>
        <div className="diagnostic-health-card card"><CheckCircle2 size={19} /><div><span>Completed</span><strong>{summary?.anonymized_count || 0}</strong><small>already anonymized</small></div></div>
        <div className="diagnostic-health-card card"><Database size={19} /><div><span>Database</span><strong>{formatBytes(summary?.database_bytes || 0)}</strong><small>{formatBytes(summary?.reusable_bytes || 0)} reusable</small></div></div>
      </div>

      <div className="retention-grid">
        <section className="admin-form card retention-policy-card">
          <div className="retention-card-heading">
            <div className="retention-heading-icon"><CalendarClock size={18} /></div>
            <div><h3>History policy</h3><p>Choose when personal booking details should be removed.</p></div>
          </div>
          <div className="retention-field-grid">
            <div className="branding-row">
              <label className="branding-label" htmlFor="retention-months">Detailed history</label>
              <div className="input-with-suffix"><input id="retention-months" className="input" type="number" min="1" max="120" value={months} onChange={event => setMonths(Number(event.target.value))} /><span>months</span></div>
              <p className="field-help">Users can see full booking details during this period.</p>
            </div>
            <div className="branding-row">
              <label className="branding-label" htmlFor="backup-days">Backup policy record</label>
              <div className="input-with-suffix"><input id="backup-days" className="input" type="number" min="1" max="3650" value={backupDays} onChange={event => setBackupDays(Number(event.target.value))} /><span>days</span></div>
              <p className="field-help">For documentation only. Resy does not create or delete backup files.</p>
            </div>
          </div>
          <div className="retention-cutoff-note"><Info size={15} /><span>With the current setting, bookings ending before <strong>{formatDate(summary?.cutoff)}</strong> are eligible unless pending or held.</span></div>
        </section>

        <section className="admin-form card retention-automation-card">
          <div className="retention-card-heading">
            <div className="retention-heading-icon"><HardDrive size={18} /></div>
            <div><h3>Automatic cleanup</h3><p>Runs once daily at 2:15 AM server time.</p></div>
            <span className={`retention-status ${enabled ? 'on' : 'off'}`}>{enabled ? 'On' : 'Off'}</span>
          </div>
          <label className="retention-switch-row">
            <span><strong>Enable daily anonymization</strong><small>Processes up to 500 eligible records per run.</small></span>
            <span className="toggle-switch"><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setBackupConfirmed(false); }} /><span className="toggle-slider" /></span>
          </label>
          {enabled && (
            <label className="retention-confirm-box">
              <input type="checkbox" checked={backupConfirmed} onChange={event => setBackupConfirmed(event.target.checked)} />
              <span><strong>Backup confirmed</strong><small>I have verified a current database and uploads backup.</small></span>
            </label>
          )}
          <button className="btn btn-primary" type="button" disabled={working || automationNeedsConfirmation} onClick={save}>Save retention settings</button>
          {automationNeedsConfirmation && <p className="retention-action-hint">Confirm the backup above before saving automation as enabled.</p>}
        </section>
      </div>

      <section className="admin-form card retention-run-card">
        <div className="retention-card-heading">
          <div className="retention-heading-icon"><PlayCircle size={18} /></div>
          <div><h3>Manual cleanup</h3><p>Use this after reviewing the current preview. Automatic cleanup does not need to be enabled.</p></div>
          <button className="btn btn-secondary" type="button" disabled={working || loading} onClick={refresh}><RefreshCw size={14} />Refresh preview</button>
        </div>
        <div className="retention-preview-strip">
          <div><span>Eligible now</span><strong>{eligibleCount}</strong></div>
          <div><span>Oldest eligible booking</span><strong>{formatDate(summary?.oldest_eligible_at)}</strong></div>
          <div><span>Maximum this run</span><strong>{Math.min(eligibleCount, 500)}</strong></div>
        </div>
        {eligibleCount > 0 ? (
          <div className="retention-run-actions">
            <label className="retention-confirm-box"><input type="checkbox" checked={runConfirmed} onChange={event => setRunConfirmed(event.target.checked)} /><span><strong>Ready to run</strong><small>I reviewed the preview and verified a current backup.</small></span></label>
            <button className="btn btn-danger" type="button" disabled={working || !runConfirmed} onClick={runNow}>Anonymize {Math.min(eligibleCount, 500)} eligible record{Math.min(eligibleCount, 500) === 1 ? '' : 's'}</button>
          </div>
        ) : (
          <div className="retention-empty-state"><CheckCircle2 size={17} /><span>No records currently need anonymization.</span></div>
        )}
      </section>

      <section className="admin-form card retention-hold-panel">
        <div className="retention-card-heading">
          <div className="retention-heading-icon"><LockKeyhole size={18} /></div>
          <div><h3>Booking holds</h3><p>Protect a specific booking from both manual and automatic cleanup.</p></div>
        </div>
        <div className="retention-cutoff-note"><Info size={15} /><span>A held booking also prevents its user from being deleted. Search by booking ID, title, organizer, email, or room.</span></div>
        <form className="retention-search" onSubmit={searchBookings}>
          <div className="retention-search-input"><Search size={16} /><input className="input" placeholder="Search bookings" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} aria-label="Search bookings for retention hold" /></div>
          <button className="btn btn-secondary" type="submit" disabled={searching || !searchQuery.trim()}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        {hasSearched && searchResults.length === 0 && <div className="retention-empty-state">No matching active booking records found.</div>}
        {searchResults.length > 0 && (
          <div className="retention-search-results">
            {searchResults.map(booking => (
              <div className="retention-booking-row" key={booking.id}>
                <div className="retention-booking-id">#{booking.id}</div>
                <div className="retention-booking-copy">
                  <strong>{booking.title || 'Untitled booking'}</strong>
                  <span>{booking.room_name || 'Unknown room'} · {formatDate(booking.end_time)}</span>
                  <small>{booking.organizer_name || booking.organizer_email || 'No organizer'} · {booking.status}</small>
                </div>
                <span className={`retention-status ${booking.retention_hold ? 'held' : 'off'}`}>{booking.retention_hold ? 'On hold' : 'Not held'}</span>
                <button className="btn btn-secondary" type="button" disabled={working} onClick={() => setHold(booking.id, !booking.retention_hold)}>{booking.retention_hold ? 'Release hold' : 'Apply hold'}</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
