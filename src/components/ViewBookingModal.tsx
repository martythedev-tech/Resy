import { useState, FormEvent, useEffect, useRef, useMemo, useCallback } from 'react';
import { Room } from '../types';
import { api } from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useNotification } from '../contexts/NotificationContext';
import { useTimezone } from '../contexts/TimezoneContext';
import '../styles/ViewBookingModal.css';
import { AlertTriangle, CalendarCheck2, X } from 'lucide-react';
import { buildDateInTimezone } from '../utils/date';
import { UnsavedChangesPrompt } from './UnsavedChangesPrompt';

interface CustomFieldConfig {
  id: string;
  label: string;
  type: 'text' | 'select' | 'checkbox';
  options?: string[];
  required?: boolean;
  helpText?: string;
}

const fmtMinutes = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 12 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
};

const buildDurationOptions = (minMinutes: number, maxMinutes: number) => {
  const options: { value: number; label: string }[] = [];
  const start = Math.max(15, Math.round(minMinutes / 15) * 15);
  const end = Math.max(start, maxMinutes);
  for (let mins = start; mins <= end; mins += 15) {
    const hrs = mins / 60;
    const label = mins < 60 ? `${mins}m` : (mins % 60 === 0 ? `${hrs}h` : `${Math.floor(hrs)}h ${mins % 60}m`);
    options.push({ value: mins, label });
  }
  return options.length > 0 ? options : [{ value: minMinutes, label: `${minMinutes}m` }];
};

const getLocalDayIndex = (dateStr: string, timezone: string): number => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const pivot = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).formatToParts(pivot);
  const weekday = parts.find(p => p.type === 'weekday')?.value || 'Sun';
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? 0;
};

const buildTimeOptions = (startMinutes: number, endMinutes: number, step = 30) => {
  const opts: { value: number; label: string }[] = [];
  for (let mins = startMinutes; mins <= endMinutes; mins += step) {
    opts.push({ value: mins, label: fmtMinutes(mins) });
  }
  return opts;
};

interface Booking {
  id: number;
  room_id: number;
  user_id: number;
  title: string;
  start_time: string;
  end_time: string;
  attendees?: string | string[];
  attendee_count?: number | null;
  equipment?: string | string[];
  notes?: string;
  custom_fields?: any;
  status: string;
  is_recurring?: boolean | number;
  recurrence_id?: number | null;
  organizer_name?: string;
  organizer_email?: string;
  checked_in?: boolean | number;
}

interface ViewBookingModalProps {
  booking: Booking;
  room: Room;
  onClose: () => void;
  onUpdate: () => void;
}

const parseCustomFields = (raw: any): Record<string, any> => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
};

const parseEquipment = (raw: Booking['equipment']): string[] => {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return raw;
};

const getAttendeeCount = (booking: Booking): number | '' => {
  const count = Number(booking.attendee_count);
  if (Number.isInteger(count) && count >= 0 && booking.attendee_count !== null) return count;
  if (!booking.attendees) return '';
  if (Array.isArray(booking.attendees)) return booking.attendees.length;
  try {
    const parsed = JSON.parse(booking.attendees);
    return Array.isArray(parsed) ? parsed.length : '';
  } catch {
    return '';
  }
};

const normalizeRecord = (values: Record<string, any>) => JSON.stringify(
  Object.entries(values)
    .filter(([, value]) => typeof value === 'boolean' ? value : value !== undefined && value !== null && String(value).trim() !== '')
    .sort(([left], [right]) => left.localeCompare(right))
);

const normalizeList = (values: string[]) => JSON.stringify([...values].sort());

export const ViewBookingModal = ({
  booking,
  room,
  onClose,
  onUpdate
}: ViewBookingModalProps) => {
  const { user } = useAuth();
  const notify = useNotification();
  const { timezone, getLocalDate, formatTime } = useTimezone();
  const [maxDurationRuleMinutes, setMaxDurationRuleMinutes] = useState(0);
  const [maxDurationRuleEnabled, setMaxDurationRuleEnabled] = useState(false);
  const [roomDurationLimitsEnabled, setRoomDurationLimitsEnabled] = useState(false);
  const [bookingIntervalEnabled, setBookingIntervalEnabled] = useState(true);
  const [bookingIntervalMinutes, setBookingIntervalMinutes] = useState(30);
  const [checkInEnabled, setCheckInEnabled] = useState(false);
  const [checkInGraceMinutes, setCheckInGraceMinutes] = useState(10);
  const [checkInEarlyMinutes, setCheckInEarlyMinutes] = useState(15);

  const defaultMinDuration = 30;
  const defaultMaxDuration = 120;
  const roomMinDuration = Math.max(15, Number(room.min_duration_minutes) || defaultMinDuration);
  const roomMaxDuration = Math.max(roomMinDuration, Number(room.max_duration_minutes) || defaultMaxDuration);
  const minDuration = roomDurationLimitsEnabled ? roomMinDuration : defaultMinDuration;
  const maxDurationBase = roomDurationLimitsEnabled ? roomMaxDuration : defaultMaxDuration;
  const maxDurationCapped = maxDurationRuleEnabled && maxDurationRuleMinutes > 0
    ? Math.min(maxDurationBase, maxDurationRuleMinutes)
    : maxDurationBase;
  const maxDuration = Math.max(minDuration, maxDurationCapped);

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(booking.title);
  const [notes, setNotes] = useState(booking.notes || '');
  const [attendeeCount, setAttendeeCount] = useState<number | ''>(() => getAttendeeCount(booking));
  const [selectedEquipment, setSelectedEquipment] = useState<string[]>(() => parseEquipment(booking.equipment));
  const [itavOptions, setItavOptions] = useState<string[]>([]);
  const [showTechMenu, setShowTechMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasCheckedIn, setHasCheckedIn] = useState(booking.checked_in === true || Number(booking.checked_in) === 1);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [discardAction, setDiscardAction] = useState<'close' | 'exit-edit' | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [seriesScope, setSeriesScope] = useState<'single' | 'following'>('single');
  const [customFieldsConfig, setCustomFieldsConfig] = useState<CustomFieldConfig[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>(
    () => parseCustomFields(booking.custom_fields)
  );
  const modalRef = useRef<HTMLDivElement>(null);
  const techMenuRef = useRef<HTMLDivElement>(null);
  const bookingCustomFields = useMemo(() => parseCustomFields(booking.custom_fields), [booking.custom_fields]);

  useEffect(() => {
    api.getSettings().then((s: any) => {
      if (typeof s.max_duration_enabled === 'boolean') {
        setMaxDurationRuleEnabled(s.max_duration_enabled);
      }
      if (typeof s.max_duration_minutes === 'number') {
        setMaxDurationRuleMinutes(s.max_duration_minutes);
      }
      if (typeof s.room_duration_limits_enabled === 'boolean') {
        setRoomDurationLimitsEnabled(s.room_duration_limits_enabled);
      }
      if (typeof s.booking_interval_enabled === 'boolean') {
        setBookingIntervalEnabled(s.booking_interval_enabled);
      }
      if (typeof s.booking_interval_minutes === 'number' && [15, 30, 60].includes(s.booking_interval_minutes)) {
        setBookingIntervalMinutes(s.booking_interval_minutes);
      }
      if (typeof s.check_in_enabled === 'boolean') setCheckInEnabled(s.check_in_enabled);
      if (typeof s.check_in_grace_minutes === 'number') setCheckInGraceMinutes(s.check_in_grace_minutes);
      if (typeof s.check_in_early_minutes === 'number') setCheckInEarlyMinutes(s.check_in_early_minutes);
      if (Array.isArray(s.equipment_options)) {
        setItavOptions(s.equipment_options);
      }
      if (Array.isArray(s.custom_fields)) {
        setCustomFieldsConfig(s.custom_fields);
        setCustomFieldValues(prev => {
          const next: Record<string, any> = {};
          s.custom_fields.forEach((field: CustomFieldConfig) => {
            if (prev[field.id] !== undefined) {
              next[field.id] = prev[field.id];
              return;
            }
            next[field.id] = field.type === 'checkbox' ? false : '';
          });
          return next;
        });
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setHasCheckedIn(booking.checked_in === true || Number(booking.checked_in) === 1);
  }, [booking.checked_in]);

  useEffect(() => {
    if (!showTechMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (techMenuRef.current && !techMenuRef.current.contains(target)) {
        setShowTechMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTechMenu]);

  // Helper to get time parts in app timezone
  const getTimeParts = (dateStr: string): { hour: number; minute: number } => {
    const d = new Date(dateStr);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(d);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    return { hour, minute };
  };

  // Date/time editing state
  const bookingStart = new Date(booking.start_time);
  const bookingEnd = new Date(booking.end_time);
  const initialDuration = Math.round((bookingEnd.getTime() - bookingStart.getTime()) / 60000);

  const [editDate, setEditDate] = useState(() => getLocalDate(booking.start_time));
  const [editStartMinutes, setEditStartMinutes] = useState(() => {
    const { hour, minute } = getTimeParts(booking.start_time);
    return hour * 60 + minute;
  });
  const [editDuration, setEditDuration] = useState(initialDuration);

  const initialEditDate = getLocalDate(booking.start_time);
  const initialEditTimeParts = getTimeParts(booking.start_time);
  const initialEditStartMinutes = initialEditTimeParts.hour * 60 + initialEditTimeParts.minute;
  const editHasUnsavedChanges = isEditing && (
    title !== booking.title
    || notes !== (booking.notes || '')
    || attendeeCount !== getAttendeeCount(booking)
    || normalizeList(selectedEquipment) !== normalizeList(parseEquipment(booking.equipment))
    || normalizeRecord(customFieldValues) !== normalizeRecord(parseCustomFields(booking.custom_fields))
    || editDate !== initialEditDate
    || editStartMinutes !== initialEditStartMinutes
    || editDuration !== initialDuration
    || (Boolean(booking.recurrence_id || booking.is_recurring) && seriesScope !== 'single')
  );
  const cancelHasUnsavedChanges = showCancelConfirm && (cancelReason.trim() !== '' || seriesScope !== 'single');

  const requestClose = useCallback(() => {
    if (loading) return;
    if (editHasUnsavedChanges || cancelHasUnsavedChanges) {
      setDiscardAction('close');
      return;
    }
    onClose();
  }, [cancelHasUnsavedChanges, editHasUnsavedChanges, loading, onClose]);

  const requestExitEdit = () => {
    if (loading) return;
    if (editHasUnsavedChanges) {
      setDiscardAction('exit-edit');
      return;
    }
    setIsEditing(false);
  };

  const confirmDiscard = () => {
    const action = discardAction;
    setDiscardAction(null);
    if (action === 'close') {
      onClose();
    } else if (action === 'exit-edit') {
      setIsEditing(false);
    }
  };

  // Computed new times based on edits
  const computedStart = buildDateInTimezone(editDate, editStartMinutes, timezone);
  const computedEnd = new Date(computedStart.getTime() + editDuration * 60000);

  const durationOptions = useMemo(() => buildDurationOptions(minDuration, maxDuration), [minDuration, maxDuration]);
  const timeStepMinutes = useMemo(() => {
    if (bookingIntervalEnabled && [15, 30, 60].includes(bookingIntervalMinutes)) {
      return bookingIntervalMinutes;
    }
    return minDuration <= 15 ? 15 : 30;
  }, [bookingIntervalEnabled, bookingIntervalMinutes, minDuration]);

  const timeOptions = useMemo(() => {
    const hours = room.business_hours || room.building_hours;
    if (!hours || !hours.days) {
      return room.requires_approval
        ? buildTimeOptions(6 * 60, 22 * 60, timeStepMinutes)
        : buildTimeOptions(8 * 60, Math.max(8 * 60, 18 * 60 - editDuration), timeStepMinutes);
    }
    const dayIndex = getLocalDayIndex(editDate, timezone);
    const dayConfig = hours.days[String(dayIndex)];
    if (!dayConfig || !dayConfig.enabled) {
      return room.requires_approval ? buildTimeOptions(6 * 60, 22 * 60, timeStepMinutes) : [];
    }
    const [startH, startM] = String(dayConfig.start || '08:00').split(':').map(Number);
    const [endH, endM] = String(dayConfig.end || '18:00').split(':').map(Number);
    const start = (startH * 60) + (startM || 0);
    const end = (endH * 60) + (endM || 0);
    const latestStart = Math.max(start, end - editDuration);
    if (latestStart < start) return [];
    const baseOptions = buildTimeOptions(start, latestStart, timeStepMinutes);
    if (!room.requires_approval) return baseOptions;
    const afterHoursOptions = buildTimeOptions(6 * 60, 22 * 60, timeStepMinutes);
    const merged = new Map(afterHoursOptions.map(opt => [opt.value, opt]));
    baseOptions.forEach(opt => merged.set(opt.value, opt));
    return Array.from(merged.values()).sort((a, b) => a.value - b.value);
  }, [editDate, timezone, room.business_hours, room.building_hours, editDuration, room.requires_approval, timeStepMinutes]);

  const isAfterHoursSelection = useMemo(() => {
    const hours = room.business_hours || room.building_hours;
    if (!hours || !hours.days) {
      return editStartMinutes < 8 * 60 || editStartMinutes + editDuration > 18 * 60;
    }
    const dayIndex = getLocalDayIndex(editDate, timezone);
    const dayConfig = hours.days[String(dayIndex)];
    if (!dayConfig || !dayConfig.enabled) return true;
    const [startH, startM] = String(dayConfig.start || '08:00').split(':').map(Number);
    const [endH, endM] = String(dayConfig.end || '18:00').split(':').map(Number);
    const dayStart = (startH * 60) + (startM || 0);
    const dayEnd = (endH * 60) + (endM || 0);
    const endMinutes = editStartMinutes + editDuration;
    return editStartMinutes < dayStart || endMinutes > dayEnd;
  }, [room.business_hours, room.building_hours, editDate, timezone, editStartMinutes, editDuration]);

  useEffect(() => {
    if (timeOptions.length > 0 && !timeOptions.some(opt => opt.value === editStartMinutes)) {
      setEditStartMinutes(timeOptions[0].value);
    }
  }, [timeOptions, editStartMinutes]);

  useEffect(() => {
    if (editDuration < minDuration) {
      setEditDuration(minDuration);
    } else if (editDuration > maxDuration) {
      setEditDuration(maxDuration);
    }
  }, [editDuration, minDuration, maxDuration]);

  // Reset edit fields when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setTitle(booking.title);
      setNotes(booking.notes || '');
      setEditDate(getLocalDate(booking.start_time));
      const { hour, minute } = getTimeParts(booking.start_time);
      setEditStartMinutes(hour * 60 + minute);
      setEditDuration(Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 60000));
      setAttendeeCount(getAttendeeCount(booking));
      setSelectedEquipment(parseEquipment(booking.equipment));
      setCustomFieldValues(parseCustomFields(booking.custom_fields));
    }
  }, [isEditing, booking.title, booking.notes, booking.start_time, booking.end_time, booking.attendee_count, booking.attendees, booking.equipment, booking.custom_fields]);

  useEffect(() => {
    const node = modalRef.current;
    if (!node) return;

    const focusRoot = node.querySelector<HTMLElement>('[data-unsaved-changes-prompt]') || node;
    const focusables = Array.from(
      focusRoot.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      node.focus();
    }
  }, [discardAction]);

  useEffect(() => {
    const node = modalRef.current;
    if (!node) return;

    const getFocusable = () => {
      const focusRoot = node.querySelector<HTMLElement>('[data-unsaved-changes-prompt]') || node;
      return Array.from(
        focusRoot.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (discardAction) {
          setDiscardAction(null);
        } else {
          requestClose();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [discardAction, requestClose]);

  const isOwner = user?.id === booking.user_id;
  const isAdmin = user?.role === 'admin';
  const canCheckInActor = isOwner || isAdmin || user?.role === 'room_manager';
  const canModify = isOwner || isAdmin;
  const isRecurring = Boolean(booking.recurrence_id || booking.is_recurring);

  const startDate = new Date(booking.start_time);
  const endDate = new Date(booking.end_time);
  const isPast = endDate < new Date();
  const isTerminal = booking.status === 'cancelled' || booking.status === 'no_show';
  const checkInOpensAt = startDate.getTime() - checkInEarlyMinutes * 60_000;
  const checkInClosesAt = Math.min(endDate.getTime(), startDate.getTime() + checkInGraceMinutes * 60_000);
  const isBeforeCheckIn = currentTime < checkInOpensAt;
  const isAfterCheckIn = currentTime > checkInClosesAt;
  const canCheckInNow = checkInEnabled && canCheckInActor && booking.status === 'confirmed'
    && !hasCheckedIn && !isBeforeCheckIn && !isAfterCheckIn;
  const statusLabel = booking.status === 'no_show'
    ? 'No-show'
    : booking.status.charAt(0).toUpperCase() + booking.status.slice(1);

  const formatDuration = () => {
    const mins = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return remainingMins ? `${hrs}h ${remainingMins}m` : `${hrs}h`;
  };

  const toggleEquipment = (item: string) => {
    setSelectedEquipment(prev =>
      prev.includes(item) ? prev.filter(e => e !== item) : [...prev, item]
    );
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!Number.isFinite(computedStart.getTime())) {
      notify.error('That local time does not exist because of a daylight-saving time change');
      return;
    }
    if (!title.trim()) {
      notify.error('Title is required');
      return;
    }

    // Validate time is not in the past
    if (computedStart <= new Date()) {
      notify.error('Cannot set booking time in the past');
      return;
    }

    if (timeOptions.length === 0) {
      notify.error('No available business hours for the selected date');
      return;
    }

    if (customFieldsConfig.length > 0) {
      const missingField = customFieldsConfig.find(field => {
        if (!field.required) return false;
        const value = customFieldValues[field.id];
        if (field.type === 'checkbox') return !value;
        return value === undefined || String(value).trim() === '';
      });
      if (missingField) {
        notify.error(`Please complete the required field: ${missingField.label}`);
        return;
      }
    }

    setLoading(true);
    try {
      const customFieldsPayload: Record<string, any> = {};
      customFieldsConfig.forEach(field => {
        const value = customFieldValues[field.id];
        if (field.type === 'checkbox') {
          if (value) customFieldsPayload[field.id] = true;
          return;
        }
        if (value !== undefined && String(value).trim() !== '') {
          customFieldsPayload[field.id] = value;
        }
      });
      const result = await api.updateBooking(String(booking.id), {
        title,
        attendee_count: attendeeCount === '' ? null : Number(attendeeCount),
        notes,
        equipment: selectedEquipment,
        start_time: computedStart.toISOString(),
        end_time: computedEnd.toISOString(),
        custom_fields: customFieldsPayload,
        series_scope: isRecurring ? seriesScope : 'single',
      });
      const affected = Number(result?.affected_count) || 1;
      notify.success(affected > 1 ? `${affected} meetings updated` : 'Booking updated');
      onUpdate();
    } catch (err: any) {
      notify.error(err.message || 'Failed to update booking');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    setLoading(true);
    try {
      const result = await api.cancelBooking(
        String(booking.id),
        cancelReason || undefined,
        isRecurring ? seriesScope : 'single',
      );
      const affected = Number(result?.affected_count) || 1;
      notify.success(affected > 1 ? `${affected} meetings cancelled` : 'Booking cancelled');
      onUpdate();
    } catch (err: any) {
      notify.error(err.message || 'Failed to cancel booking');
    } finally {
      setLoading(false);
    }
  };

  const handleCheckIn = async () => {
    setLoading(true);
    try {
      await api.checkInBooking(String(booking.id));
      setHasCheckedIn(true);
      notify.success('Checked in successfully');
      onUpdate();
    } catch (err: any) {
      notify.error(err.message || 'Failed to check in');
    } finally {
      setLoading(false);
    }
  };

  const equipment = (() => {
    if (!booking.equipment) return [];
    if (typeof booking.equipment === 'string') {
      try { return JSON.parse(booking.equipment); } catch { return []; }
    }
    return booking.equipment;
  })();

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        ref={modalRef}
        className="modal-content card view-booking-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="view-booking-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="modal-kicker"><CalendarCheck2 size={13} /> Reservation</span>
            <h2 id="view-booking-title">{isEditing ? 'Edit booking' : 'Booking details'}</h2>
          </div>
          <button type="button" className="close-btn" onClick={requestClose} aria-label="Close booking details"><X size={19} /></button>
        </div>

        {discardAction ? (
          <UnsavedChangesPrompt
            id="edit-booking-discard"
            onKeepEditing={() => setDiscardAction(null)}
            onDiscard={confirmDiscard}
          />
        ) : showCancelConfirm ? (
          <div className="cancel-confirm">
            <div className="cancel-confirm-heading"><span><AlertTriangle size={20} /></span><div><h3>Cancel this booking?</h3><p>This will release the room for other people.</p></div></div>
            {isRecurring && (
              <div className="series-scope-field">
                <span className="series-scope-label">Cancel</span>
                <div className="series-scope-options">
                  <label className={`series-scope-option${seriesScope === 'single' ? ' selected' : ''}`}>
                    <input type="radio" name="cancel-series-scope" value="single" checked={seriesScope === 'single'} onChange={() => setSeriesScope('single')} />
                    <span><strong>This meeting only</strong><small>Keep the rest of the series.</small></span>
                  </label>
                  <label className={`series-scope-option${seriesScope === 'following' ? ' selected' : ''}`}>
                    <input type="radio" name="cancel-series-scope" value="following" checked={seriesScope === 'following'} onChange={() => setSeriesScope('following')} />
                    <span><strong>This and following meetings</strong><small>Cancel this meeting and every later meeting in the series.</small></span>
                  </label>
                </div>
              </div>
            )}
            <div className="field">
              <label>Reason (optional)</label>
              <textarea
                className="input textarea"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Why are you cancelling?"
                rows={2}
              />
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowCancelConfirm(false)}
                disabled={loading}
              >
                Go Back
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleCancel}
                disabled={loading}
              >
                {loading ? 'Cancelling...' : 'Confirm Cancel'}
              </button>
            </div>
          </div>
        ) : isEditing ? (
          <form onSubmit={handleSave} className="booking-form">
            {isRecurring && (
              <div className="series-scope-field">
                <span className="series-scope-label">Apply changes to</span>
                <div className="series-scope-options">
                  <label className={`series-scope-option${seriesScope === 'single' ? ' selected' : ''}`}>
                    <input type="radio" name="edit-series-scope" value="single" checked={seriesScope === 'single'} onChange={() => setSeriesScope('single')} />
                    <span><strong>This meeting only</strong><small>Leave other meetings unchanged.</small></span>
                  </label>
                  <label className={`series-scope-option${seriesScope === 'following' ? ' selected' : ''}`}>
                    <input type="radio" name="edit-series-scope" value="following" checked={seriesScope === 'following'} onChange={() => setSeriesScope('following')} />
                    <span><strong>This and following meetings</strong><small>Update this meeting and every later meeting in the series.</small></span>
                  </label>
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="edit-title">Meeting Title *</label>
              <input
                id="edit-title"
                type="text"
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="edit-attendee-count">Number of Attendees</label>
              <input
                id="edit-attendee-count"
                type="number"
                className="input"
                min="0"
                max="100000"
                step="1"
                value={attendeeCount}
                onChange={(e) => setAttendeeCount(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="Optional"
              />
            </div>

            <div className="booking-time-info edit-mode">
              <div className="view-info-row">
                <span className="view-info-label">Room</span>
                <span className="view-info-value">{room.name}</span>
              </div>
              <div className="time-edit-grid">
                <div className="field compact">
                  <label>Date</label>
                  <input
                    type="date"
                    className="input"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                  />
                </div>
                <div className="field compact">
                  <label>Start Time</label>
                  <select
                    className="input"
                    value={editStartMinutes}
                    onChange={(e) => setEditStartMinutes(Number(e.target.value))}
                  >
                    {timeOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {timeOptions.length === 0 && (
                    <p className="subtle">No business hours configured for this day.</p>
                  )}
                  {!!room.requires_approval && isAfterHoursSelection && (
                    <p className="subtle">After-hours bookings require approval.</p>
                  )}
                </div>
                <div className="field compact">
                  <label>Duration</label>
                  <select
                    className="input"
                    value={editDuration}
                    onChange={(e) => setEditDuration(Number(e.target.value))}
                  >
                    {durationOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="field">
              <label>Technology</label>
              <div className="tech-dropdown" ref={techMenuRef}>
                <button
                  type="button"
                  className={`tech-trigger${showTechMenu ? ' open' : ''}`}
                  onClick={() => {
                    if (itavOptions.length === 0) return;
                    setShowTechMenu(prev => !prev);
                  }}
                  disabled={itavOptions.length === 0}
                >
                  <span className="tech-label">Technology</span>
                  <span className="tech-summary">
                    {itavOptions.length === 0
                      ? 'No options configured'
                      : (selectedEquipment.length > 0 ? `${selectedEquipment.length} selected` : 'Select options')}
                  </span>
                  <span className="tech-chevron">▾</span>
                </button>
                {showTechMenu && (
                  <div className="tech-menu">
                    <div className="tech-menu-header">Select what you need</div>
                    <div className="tech-options">
                      {itavOptions.map(item => (
                        <label key={item} className="checkbox-label">
                          <span className="custom-checkbox">
                            <input
                              type="checkbox"
                              checked={selectedEquipment.includes(item)}
                              onChange={() => toggleEquipment(item)}
                            />
                            <span className="checkmark"></span>
                          </span>
                          <span>{item}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {customFieldsConfig.length > 0 && (
              <div className="field">
                <label>Additional Details</label>
                <div className="custom-field-inputs">
                  {customFieldsConfig.map(field => (
                    <div key={field.id} className="custom-field-input">
                      <div className="custom-field-label">
                        <span>{field.label}</span>
                        {field.required && <span className="required-pill">Required</span>}
                      </div>
                      {field.type === 'select' ? (
                        <select
                          className="input"
                          value={customFieldValues[field.id] || ''}
                          onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                        >
                          <option value="">Select...</option>
                          {(field.options || []).map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      ) : field.type === 'checkbox' ? (
                        <label className="checkbox-label">
                          <span className="custom-checkbox">
                            <input
                              type="checkbox"
                              checked={!!customFieldValues[field.id]}
                              onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.checked }))}
                            />
                            <span className="checkmark"></span>
                          </span>
                          <span>{field.helpText || 'Yes'}</span>
                        </label>
                      ) : (
                        <input
                          className="input"
                          placeholder={field.helpText || 'Enter value'}
                          value={customFieldValues[field.id] || ''}
                          onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                        />
                      )}
                      {field.type !== 'checkbox' && field.helpText && (
                        <p className="subtle">{field.helpText}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="field">
              <label htmlFor="edit-notes">Notes</label>
              <textarea
                id="edit-notes"
                className="input textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={requestExitEdit}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        ) : (
          <div className="view-booking-details">
            <div className="booking-title-display">{booking.title}</div>

            <div className="view-booking-meta">
              <div className="view-info-row">
                <span className="view-info-label">Room</span>
                <span className="view-info-value">{room.name}</span>
              </div>
              <div className="view-info-row">
                <span className="view-info-label">Building</span>
                <span className="view-info-value">{room.building} · Floor {room.floor}</span>
              </div>
              <div className="view-info-row">
                <span className="view-info-label">Date</span>
                <span className="view-info-value">{startDate.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
              </div>
              <div className="view-info-row">
                <span className="view-info-label">Time</span>
                <span className="view-info-value">
                  {formatTime(startDate)} - {formatTime(endDate)}
                  <span className="duration-badge">{formatDuration()}</span>
                </span>
              </div>
              <div className="view-info-row">
                <span className="view-info-label">Organizer</span>
                <span className="view-info-value">{booking.organizer_name || booking.organizer_email || 'Unknown'}</span>
              </div>
              {booking.attendee_count !== null && booking.attendee_count !== undefined && (
                <div className="view-info-row">
                  <span className="view-info-label">Attendees</span>
                  <span className="view-info-value">{booking.attendee_count}</span>
                </div>
              )}
              <div className="view-info-row">
                <span className="view-info-label">Status</span>
                <span className="view-info-value">
                  <span className={`view-booking-status ${booking.status}`}>{statusLabel}</span>
                </span>
              </div>
              {equipment.length > 0 && (
                <div className="view-info-row">
                  <span className="view-info-label">Technology</span>
                  <span className="view-info-value view-equipment-list">
                    {equipment.map((eq: string) => (
                      <span key={eq} className="view-equipment-tag">{eq}</span>
                    ))}
                  </span>
                </div>
              )}
              {customFieldsConfig.length > 0 && customFieldsConfig
                .map(field => {
                  const value = bookingCustomFields[field.id];
                  if (field.type === 'checkbox') {
                    return value ? { label: field.label, value: 'Yes' } : null;
                  }
                  if (value === undefined || String(value).trim() === '') return null;
                  return { label: field.label, value: String(value) };
                })
                .filter(Boolean)
                .map((entry: any) => (
                  <div key={entry.label} className="view-info-row">
                    <span className="view-info-label">{entry.label}</span>
                    <span className="view-info-value">{entry.value}</span>
                  </div>
                ))}
              {booking.notes && (
                <div className="view-info-row view-notes-row">
                  <span className="view-info-label">Notes</span>
                  <span className="view-info-value">{booking.notes}</span>
                </div>
              )}
            </div>

            {checkInEnabled && canCheckInActor && booking.status === 'confirmed' && (
              <div className={`check-in-panel${hasCheckedIn ? ' complete' : ''}`}>
                <div>
                  <strong>{hasCheckedIn ? 'Checked in' : 'Meeting check-in'}</strong>
                  <span>
                    {hasCheckedIn
                      ? 'Attendance has been recorded for this booking.'
                      : isBeforeCheckIn
                        ? `Opens ${checkInEarlyMinutes} minutes before the meeting.`
                        : isAfterCheckIn
                          ? 'The check-in window has closed.'
                          : `Check in within ${checkInGraceMinutes} minutes after the start time.`}
                  </span>
                </div>
                {!hasCheckedIn && (
                  <button type="button" className="btn btn-primary" onClick={handleCheckIn} disabled={!canCheckInNow || loading}>
                    {loading ? 'Checking in...' : 'Check In'}
                  </button>
                )}
              </div>
            )}

            {canModify && !isPast && !isTerminal && (
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  onClick={() => {
                    setSeriesScope('single');
                    setShowCancelConfirm(true);
                  }}
                >
                  Cancel Booking
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setSeriesScope('single');
                    setIsEditing(true);
                  }}
                >
                  Edit Booking
                </button>
              </div>
            )}

            {isTerminal && (
              <div className={`inactive-booking-notice ${booking.status}`}>
                {booking.status === 'cancelled'
                  ? 'This booking has been cancelled and is no longer active.'
                  : 'This booking was marked as a no-show and is no longer active.'}
              </div>
            )}

            {isPast && !isTerminal && (
              <div className="past-booking-notice">
                This booking has already ended
              </div>
            )}

            {!canModify && !isPast && !isTerminal && (
              <div className="not-owner-notice">
                Only the organizer or an admin can modify this booking
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
