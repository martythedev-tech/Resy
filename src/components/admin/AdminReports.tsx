import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3, CalendarCheck2, Clock3, Download, MonitorUp, RefreshCw,
  UserCheck, Users, XCircle,
} from 'lucide-react';
import { api } from '../../config/api';
import { useNotification } from '../../contexts/NotificationContext';
import { csvCell } from '../../utils/csv';

interface ReportRoom {
  roomId: number;
  roomName: string;
  building: string;
  capacity: number;
  isActive: boolean;
  bookingCount: number;
  bookedHours: number;
  checkIns: number;
  noShows: number;
  cancellations: number;
  averageAttendees: number | null;
  uniqueOrganizers: number;
}

interface ReportData {
  range: { startDate: string; endDate: string; days: number; roomId: number | null; timezone: string };
  summary: {
    totalBookings: number;
    activeBookings: number;
    bookedHours: number;
    averageDurationHours: number;
    averageAttendees: number | null;
    attendanceRecordedCount: number;
    uniqueOrganizers: number;
    checkedInCount: number;
    checkInTrackedCount: number;
    checkInEligible: number;
    checkInRate: number | null;
    noShowRate: number | null;
  };
  statusCounts: Record<string, number>;
  rooms: Array<Pick<ReportRoom, 'roomId' | 'roomName' | 'building' | 'capacity' | 'isActive'>>;
  roomUsage: ReportRoom[];
  technologyUsage: Array<{ name: string; requestCount: number }>;
  departmentUsage: Array<{ name: string; bookingCount: number; bookedHours: number }>;
  dailyTrend: Array<{ date: string; bookingCount: number; bookedHours: number }>;
  peakHours: Array<{ hour: number; bookingCount: number }>;
  weekdayUsage: Array<{ label: string; bookingCount: number }>;
  exportRows: Array<{
    bookingId: number; date: string; startTime: string; endTime: string; room: string;
    building: string; status: string; durationHours: number; checkedIn: boolean;
    checkInOutcome?: 'checked_in' | 'no_show' | null;
    attendeeCount: number | null; equipment: string[]; organizer: string; department: string;
  }>;
}

const dateInTimezone = (date: Date, timezone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const daysBefore = (dateString: string, days: number) => {
  const date = new Date(`${dateString}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
const daysAfter = (dateString: string, days: number) => daysBefore(dateString, -days);
const formatHours = (value: number) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
const formatHour = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
const formatCheckInOutcome = (row: ReportData['exportRows'][number]) => {
  if (row.checkInOutcome === 'checked_in' || row.checkedIn) return 'Yes';
  if (row.checkInOutcome === 'no_show') return 'No';
  return 'Unknown';
};
const formatCsvDateTime = (value: string, timezone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

export const AdminReports = () => {
  const { success, error } = useNotification();
  const [data, setData] = useState<ReportData | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [roomId, setRoomId] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (range?: { start: string; end: string; room?: string }) => {
    setLoading(true);
    try {
      const report = await api.getReports({
        start_date: range?.start || startDate || undefined,
        end_date: range?.end || endDate || undefined,
        room_id: Number(range?.room || roomId) || undefined,
      });
      setData(report);
      if (!startDate) setStartDate(report.range.startDate);
      if (!endDate) setEndDate(report.range.endDate);
    } catch (caught: unknown) {
      error(caught instanceof Error ? caught.message : 'Failed to load booking reports');
    } finally {
      setLoading(false);
    }
  }, [endDate, error, roomId, startDate]);

  useEffect(() => { load(); }, []);

  const applyPreset = (direction: 'past' | 'upcoming', days: number) => {
    const today = dateInTimezone(new Date(), data?.range.timezone || 'UTC');
    const nextStart = direction === 'past' ? daysBefore(today, days - 1) : today;
    const nextEnd = direction === 'past' ? today : daysAfter(today, days - 1);
    setStartDate(nextStart);
    setEndDate(nextEnd);
    load({ start: nextStart, end: nextEnd, room: roomId });
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    load();
  };

  const exportCsv = () => {
    if (!data?.exportRows.length) {
      error('There are no bookings to export for this report');
      return;
    }
    const timezone = data.range.timezone;
    const headers = ['Booking ID', `Date (${timezone})`, `Start (${timezone})`, `End (${timezone})`, 'Room', 'Building', 'Status', 'Duration Hours', 'Checked In', 'Attendees', 'Technology', 'Organizer', 'Department'];
    const rows = data.exportRows.map(row => [
      row.bookingId, row.date, formatCsvDateTime(row.startTime, timezone), formatCsvDateTime(row.endTime, timezone), row.room, row.building,
      row.status, row.durationHours, formatCheckInOutcome(row), row.attendeeCount ?? '',
      row.equipment.join('; '), row.organizer, row.department,
    ]);
    const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `resy-booking-report-${data.range.startDate}-to-${data.range.endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    success(`Exported ${rows.length} booking record${rows.length === 1 ? '' : 's'}`);
  };

  const allRooms = useMemo(() => {
    return [...(data?.rooms || [])].sort((a, b) => a.building.localeCompare(b.building) || a.roomName.localeCompare(b.roomName));
  }, [data]);
  const topRooms = data?.roomUsage.slice(0, 8) || [];
  const maxRoomHours = Math.max(1, ...topRooms.map(room => room.bookedHours));
  const maxTechnology = Math.max(1, ...(data?.technologyUsage.map(item => item.requestCount) || []));
  const maxDepartmentHours = Math.max(1, ...(data?.departmentUsage.map(item => item.bookedHours) || []));
  const maxDay = Math.max(1, ...(data?.dailyTrend.map(item => item.bookingCount) || []));
  const trackedCheckIns = data?.summary.checkInTrackedCount ?? data?.summary.checkInEligible ?? 0;

  if (loading && !data) {
    return <div className="admin-section"><div className="loading"><span className="loading-indicator" />Building booking report…</div></div>;
  }

  return (
    <div className="admin-section reports-section">
      <section className="reports-toolbar card">
        <div>
          <span className="eyebrow">Decision support</span>
          <h3>Conference room performance</h3>
          <p>Confirmed and no-show reservations contribute to demand totals. Pending and cancelled records remain visible as statuses and in exports.</p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={exportCsv} disabled={!data?.exportRows.length}>
          <Download size={15} /> Export CSV
        </button>
      </section>

      <form className="reports-filters card" onSubmit={applyFilters}>
        <div className="reports-presets" aria-label="Date range presets">
          <button type="button" onClick={() => applyPreset('past', 30)}>Past 30</button>
          <button type="button" onClick={() => applyPreset('past', 90)}>Past 90</button>
          <button type="button" onClick={() => applyPreset('upcoming', 30)}>Next 30</button>
          <button type="button" onClick={() => applyPreset('upcoming', 90)}>Next 90</button>
        </div>
        <label><span>From</span><input className="input" type="date" value={startDate} max={endDate} onChange={event => setStartDate(event.target.value)} /></label>
        <label><span>Through</span><input className="input" type="date" value={endDate} min={startDate} onChange={event => setEndDate(event.target.value)} /></label>
        <label><span>Room</span><select className="input" value={roomId} onChange={event => setRoomId(event.target.value)}><option value="">All rooms</option>{allRooms.map(room => <option key={room.roomId} value={room.roomId}>{room.building} · {room.roomName}</option>)}</select></label>
        <button className="btn btn-primary" type="submit" disabled={loading}>{loading ? 'Loading…' : 'Apply report'}</button>
        <button className="btn btn-secondary reports-refresh" type="button" onClick={() => load()} disabled={loading} aria-label="Refresh report"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
      </form>

      <div className="reports-metric-grid">
        <article className="report-metric card"><span className="report-metric-icon"><CalendarCheck2 size={18} /></span><div><small>Booked demand</small><strong>{data?.summary.activeBookings || 0}</strong><p>{data?.statusCounts.cancelled || 0} cancelled · {data?.statusCounts.pending || 0} pending</p></div></article>
        <article className="report-metric card"><span className="report-metric-icon"><Clock3 size={18} /></span><div><small>Booked time</small><strong>{formatHours(data?.summary.bookedHours || 0)}</strong><p>{formatHours(data?.summary.averageDurationHours || 0)} average</p></div></article>
        <article className="report-metric card"><span className="report-metric-icon"><UserCheck size={18} /></span><div><small>Check-in rate</small><strong>{data?.summary.checkInRate == null ? '—' : `${data.summary.checkInRate}%`}</strong><p>{trackedCheckIns ? `${data?.summary.checkedInCount || 0} of ${trackedCheckIns} tracked outcomes` : 'No tracked outcomes'}</p></div></article>
        <article className="report-metric card"><span className="report-metric-icon warning"><XCircle size={18} /></span><div><small>No-show rate</small><strong>{data?.summary.noShowRate == null ? '—' : `${data.summary.noShowRate}%`}</strong><p>{data?.statusCounts.no_show || 0} no-shows</p></div></article>
        <article className="report-metric card"><span className="report-metric-icon"><Users size={18} /></span><div><small>Attendance</small><strong>{data?.summary.averageAttendees ?? '—'}</strong><p>{data?.summary.attendanceRecordedCount ? `average from ${data.summary.attendanceRecordedCount} booking${data.summary.attendanceRecordedCount === 1 ? '' : 's'}` : 'No attendance recorded'}</p></div></article>
        <article className="report-metric card"><span className="report-metric-icon"><BarChart3 size={18} /></span><div><small>Organizers</small><strong>{data?.summary.uniqueOrganizers || 0}</strong><p>unique bookers</p></div></article>
      </div>

      <div className="reports-chart-grid">
        <section className="report-panel card">
          <div className="report-panel-heading"><div><h3>Room demand</h3><p>Booked hours by conference room</p></div><BarChart3 size={17} /></div>
          <div className="report-bars">
            {topRooms.map(room => <div className="report-bar-row" key={room.roomId}><span title={`${room.building} · ${room.roomName}`}>{room.roomName}<small>{room.building}</small></span><div><i style={{ width: `${(room.bookedHours / maxRoomHours) * 100}%` }} /></div><strong>{formatHours(room.bookedHours)}</strong></div>)}
            {!topRooms.some(room => room.bookingCount > 0) && <div className="report-empty">No room demand in this range.</div>}
          </div>
        </section>

        <section className="report-panel card">
          <div className="report-panel-heading"><div><h3>Technology demand</h3><p>Technology requested on active bookings</p></div><MonitorUp size={17} /></div>
          <div className="report-bars">
            {(data?.technologyUsage.slice(0, 8) || []).map(item => <div className="report-bar-row" key={item.name}><span>{item.name}</span><div><i className="accent" style={{ width: `${(item.requestCount / maxTechnology) * 100}%` }} /></div><strong>{item.requestCount}</strong></div>)}
            {!data?.technologyUsage.length && <div className="report-empty">No technology requests in this range.</div>}
          </div>
        </section>

        <section className="report-panel card">
          <div className="report-panel-heading"><div><h3>Department demand</h3><p>Booked hours by organizer department</p></div><Users size={17} /></div>
          <div className="report-bars">
            {(data?.departmentUsage.slice(0, 8) || []).map(item => <div className="report-bar-row" key={item.name}><span>{item.name}<small>{item.bookingCount} booking{item.bookingCount === 1 ? '' : 's'}</small></span><div><i style={{ width: `${(item.bookedHours / maxDepartmentHours) * 100}%` }} /></div><strong>{formatHours(item.bookedHours)}</strong></div>)}
            {!data?.departmentUsage.length && <div className="report-empty">No department usage in this range.</div>}
          </div>
        </section>
      </div>

      <section className="report-panel card">
        <div className="report-panel-heading"><div><h3>Booking activity</h3><p>Daily reservation volume across the selected period</p></div><span className="report-timezone">{data?.range.timezone}</span></div>
        <div className="report-trend" aria-label="Daily booking volume">
          {data?.dailyTrend.map(item => <div key={item.date} className="report-trend-day" title={`${item.date}: ${item.bookingCount} bookings, ${formatHours(item.bookedHours)}`}><i style={{ height: `${(item.bookingCount / maxDay) * 100}%` }} /><span>{new Date(`${item.date}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div>)}
        </div>
        <div className="report-peak-strip">
          <div><span>Busiest day</span><strong>{data?.weekdayUsage[0]?.bookingCount ? `${data.weekdayUsage[0].label} · ${data.weekdayUsage[0].bookingCount}` : 'No data'}</strong></div>
          <div><span>Peak start time</span><strong>{data?.peakHours[0]?.bookingCount ? `${formatHour(data.peakHours[0].hour)} · ${data.peakHours[0].bookingCount}` : 'No data'}</strong></div>
          <div><span>Pending</span><strong>{data?.statusCounts.pending || 0}</strong></div>
          <div><span>Selected period</span><strong>{data?.range.days || 0} days</strong></div>
        </div>
      </section>

      <section className="report-panel card report-table-panel">
        <div className="report-panel-heading"><div><h3>Room comparison</h3><p>Use attendance and reliability signals to guide room and equipment decisions.</p></div></div>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr><th>Room</th><th>Booked</th><th>Hours</th><th>Check-ins</th><th>No-shows</th><th>Cancelled</th><th>Avg. attendance</th><th>Organizers</th></tr></thead>
            <tbody>{data?.roomUsage.map(room => <tr key={room.roomId}><td><strong>{room.roomName}</strong><span>{room.building} · capacity {room.capacity}</span></td><td>{room.bookingCount}</td><td>{formatHours(room.bookedHours)}</td><td>{room.checkIns}</td><td>{room.noShows}</td><td>{room.cancellations}</td><td>{room.averageAttendees ?? '—'}</td><td>{room.uniqueOrganizers}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
