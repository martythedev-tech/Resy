import { useState, useEffect, useMemo, useRef, useCallback, FormEvent } from 'react';
import { Room } from '../types';
import { api } from '../config/api';
import { useTimezone } from '../contexts/TimezoneContext';
import { addMonthsClampedDateOnly, buildDateInTimezone, parseDateOnly, formatDateOnly } from '../utils/date';
import { Building2, CalendarRange, Repeat2, X } from 'lucide-react';
import { UnsavedChangesPrompt } from './UnsavedChangesPrompt';
import '../styles/BookingModal.css';

interface CustomFieldConfig {
  id: string;
  label: string;
  type: 'text' | 'select' | 'checkbox';
  options?: string[];
  required?: boolean;
  helpText?: string;
}

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

const fmtMinutes = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 12 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
};

const fmtDuration = (mins: number) => {
  if (mins < 60) return `${mins}m`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const fmtHourMinute = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return fmtMinutes((h || 0) * 60 + (m || 0));
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

const WEEKDAYS = [
  { short: 'S', long: 'Sunday' },
  { short: 'M', long: 'Monday' },
  { short: 'T', long: 'Tuesday' },
  { short: 'W', long: 'Wednesday' },
  { short: 'T', long: 'Thursday' },
  { short: 'F', long: 'Friday' },
  { short: 'S', long: 'Saturday' },
];

const buildTimeOptions = (startMinutes: number, endMinutes: number, step = 30) => {
  const opts: { value: number; label: string }[] = [];
  for (let mins = startMinutes; mins <= endMinutes; mins += step) {
    opts.push({ value: mins, label: fmtMinutes(mins) });
  }
  return opts;
};

const hasMeaningfulCustomFieldValues = (values: Record<string, any>) => Object.values(values).some(value => (
  typeof value === 'boolean' ? value : value !== undefined && value !== null && String(value).trim() !== ''
));

interface BookingModalProps {
  room: Room;
  startTime: Date;
  endTime: Date;
  onClose: () => void;
  onSuccess: () => void;
}

export const BookingModal = ({
  room,
  startTime,
  endTime,
  onClose,
  onSuccess
}: BookingModalProps) => {
  const { timezone, getLocalDate, formatDate } = useTimezone();
  const initialDate = getLocalDate(startTime);
  const initialStartMinutes = (() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(startTime);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '8', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    return hour * 60 + minute;
  })();
  const initialDurationMinutes = Math.min(
    Math.max(30, Math.round((endTime.getTime() - startTime.getTime()) / 60000)),
    120
  );
  const [title, setTitle] = useState('');
  // Initialize date and time from props using app timezone
  const [date, setDate] = useState(initialDate);
  const [startMinutes, setStartMinutes] = useState(initialStartMinutes);
  const [needsITAV, setNeedsITAV] = useState(false);
  const [selectedITAV, setSelectedITAV] = useState<string[]>([]);
  const [itavOptions, setItavOptions] = useState<string[]>([]);
  const [showTechMenu, setShowTechMenu] = useState(false);
  const [notes, setNotes] = useState('');
  const [attendeeCount, setAttendeeCount] = useState<number | ''>('');
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [customFieldsConfig, setCustomFieldsConfig] = useState<CustomFieldConfig[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>({});
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatFrequency, setRepeatFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [repeatInterval, setRepeatInterval] = useState(1);
  const [repeatEndDate, setRepeatEndDate] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [capacityWarningEnabled, setCapacityWarningEnabled] = useState(false);
  const [minLeadTimeMinutes, setMinLeadTimeMinutes] = useState(0);
  const [minLeadTimeEnabled, setMinLeadTimeEnabled] = useState(false);
  const [recurrenceLimitMonths, setRecurrenceLimitMonths] = useState(0);
  const [recurrenceLimitEnabled, setRecurrenceLimitEnabled] = useState(false);
  const [maxRoomBookingsPerDay, setMaxRoomBookingsPerDay] = useState(0);
  const [maxRoomBookingsPerDayEnabled, setMaxRoomBookingsPerDayEnabled] = useState(false);
  const [bufferTimeMinutes, setBufferTimeMinutes] = useState(0);
  const [bufferRuleEnabled, setBufferRuleEnabled] = useState(false);
  const [maxDurationRuleMinutes, setMaxDurationRuleMinutes] = useState(0);
  const [maxDurationRuleEnabled, setMaxDurationRuleEnabled] = useState(false);
  const [roomDurationLimitsEnabled, setRoomDurationLimitsEnabled] = useState(false);
  const [bookingIntervalEnabled, setBookingIntervalEnabled] = useState(true);
  const [bookingIntervalMinutes, setBookingIntervalMinutes] = useState(30);
  const modalRef = useRef<HTMLDivElement>(null);

  const defaultMinDuration = 30;
  const defaultMaxDuration = 120;
  const roomMinDuration = Math.max(15, Number(room.min_duration_minutes) || defaultMinDuration);
  const roomMaxDuration = Math.max(roomMinDuration, Number(room.max_duration_minutes) || defaultMaxDuration);
  const minDuration = roomDurationLimitsEnabled ? roomMinDuration : defaultMinDuration;
  const maxDurationBase = roomDurationLimitsEnabled ? roomMaxDuration : defaultMaxDuration;
  const maxDurationCapped = maxDurationRuleMinutes > 0 ? Math.min(maxDurationBase, maxDurationRuleMinutes) : maxDurationBase;
  const maxDuration = Math.max(minDuration, maxDurationCapped);
  const bufferMinutes = useMemo(() => {
    if (!bufferRuleEnabled) return 0;
    const roomBuffer = Number(room.buffer_minutes);
    if (Number.isFinite(roomBuffer) && roomBuffer > 0) return roomBuffer;
    return Math.max(0, Number(bufferTimeMinutes) || 0);
  }, [bufferRuleEnabled, room.buffer_minutes, bufferTimeMinutes]);

  const [durationMinutes, setDurationMinutes] = useState(initialDurationMinutes);

  // Existing bookings for the selected room + date (minutes-since-midnight in app tz)
  const [existingBookings, setExistingBookings] = useState<{ start: number; end: number; title: string }[]>([]);
  const existingBookingsCount = existingBookings.length;

  const hasUnsavedChanges = title.trim() !== ''
    || notes.trim() !== ''
    || attendeeCount !== ''
    || date !== initialDate
    || startMinutes !== initialStartMinutes
    || durationMinutes !== initialDurationMinutes
    || needsITAV
    || selectedITAV.length > 0
    || templateName.trim() !== ''
    || repeatEnabled
    || hasMeaningfulCustomFieldValues(customFieldValues);

  const requestClose = useCallback(() => {
    if (loading) return;
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [hasUnsavedChanges, loading, onClose]);

  useEffect(() => {
    let cancelled = false;
    api.getSettings().then((s: any) => {
      if (Array.isArray(s.equipment_options)) {
        setItavOptions(s.equipment_options);
      }
      if (typeof s.capacity_warning === 'boolean') {
        setCapacityWarningEnabled(s.capacity_warning);
      }
      if (typeof s.min_lead_time_enabled === 'boolean') {
        setMinLeadTimeEnabled(s.min_lead_time_enabled);
      }
      if (typeof s.min_lead_time_minutes === 'number') {
        setMinLeadTimeMinutes(s.min_lead_time_minutes);
      }
      if (typeof s.recurrence_limit_enabled === 'boolean') {
        setRecurrenceLimitEnabled(s.recurrence_limit_enabled);
      }
      if (typeof s.recurrence_limit_months === 'number') {
        setRecurrenceLimitMonths(s.recurrence_limit_months);
      }
      if (typeof s.max_bookings_per_room_per_day_enabled === 'boolean') {
        setMaxRoomBookingsPerDayEnabled(s.max_bookings_per_room_per_day_enabled);
      }
      if (typeof s.max_bookings_per_room_per_day === 'number') {
        setMaxRoomBookingsPerDay(s.max_bookings_per_room_per_day);
      }
      if (typeof s.buffer_time_enabled === 'boolean') {
        setBufferRuleEnabled(s.buffer_time_enabled);
      }
      if (typeof s.buffer_time_minutes === 'number') {
        setBufferTimeMinutes(s.buffer_time_minutes);
      }
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
    api.getBookingTemplates().then((data: any[]) => {
      if (!cancelled) setTemplates(data);
    }).catch(() => {});
    const fetchAvailability = async () => {
      try {
        const data = await api.getRoomAvailability(String(room.id), date);
        if (cancelled) return;
        const toMinutes = (iso: string): number => {
          const d = new Date(iso);
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false,
          }).formatToParts(d);
          const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
          const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
          return h * 60 + m;
        };
        const bookings = (data.bookings || []).map((b: any) => ({
          start: toMinutes(b.start_time),
          end: toMinutes(b.end_time),
          title: b.title,
        }));
        setExistingBookings(bookings);
      } catch {
        if (!cancelled) setExistingBookings([]);
      }
    };
    fetchAvailability();
    return () => { cancelled = true; };
  }, [date, room.id, timezone]);

  useEffect(() => {
    if (!repeatEnabled) return;
    if (repeatEndDate && repeatEndDate >= date) return;
    const base = parseDateOnly(date);
    base.setDate(base.getDate() + 30);
    const iso = formatDateOnly(base);
    setRepeatEndDate(iso);
  }, [repeatEnabled, repeatEndDate, date]);

  useEffect(() => {
    const node = modalRef.current;
    if (!node) return;

    const focusRoot = node.querySelector<HTMLElement>('[data-unsaved-changes-prompt]') || node;
    const preferredTarget = focusRoot.querySelector<HTMLElement>('[autofocus]');
    const focusables = Array.from(
      focusRoot.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    const focusTarget = preferredTarget || focusables[0];
    if (focusTarget) {
      focusTarget.focus();
    } else {
      node.focus();
    }
  }, [showDiscardConfirm]);

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
        if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
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
  }, [requestClose, showDiscardConfirm]);

  const durationOptions = useMemo(() => buildDurationOptions(minDuration, maxDuration), [minDuration, maxDuration]);
  const timeStepMinutes = useMemo(() => {
    if (bookingIntervalEnabled && [15, 30, 60].includes(bookingIntervalMinutes)) {
      return bookingIntervalMinutes;
    }
    return minDuration <= 15 ? 15 : 30;
  }, [bookingIntervalEnabled, bookingIntervalMinutes, minDuration]);

  const timeOptions = useMemo(() => {
    const requiresApproval = !!room.requires_approval;
    const hours = room.business_hours || room.building_hours;
    const hasConfiguredHours = !!hours?.days;
    if (!hasConfiguredHours) {
      if (requiresApproval) {
        return buildTimeOptions(6 * 60, 22 * 60, timeStepMinutes).map(opt => ({
          ...opt,
          isAfterHours: opt.value < 8 * 60 || opt.value + durationMinutes > 18 * 60,
        }));
      }
      return buildTimeOptions(8 * 60, Math.max(8 * 60, 18 * 60 - durationMinutes), timeStepMinutes)
        .map(opt => ({ ...opt, isAfterHours: false }));
    }
    const dayIndex = getLocalDayIndex(date, timezone);
    const dayConfig = hours?.days?.[String(dayIndex)];
    const dayEnabled = dayConfig ? !!dayConfig.enabled : true;
    const [startH, startM] = String(dayConfig?.start || '08:00').split(':').map(Number);
    const [endH, endM] = String(dayConfig?.end || '18:00').split(':').map(Number);
    const dayStart = (startH * 60) + (startM || 0);
    const dayEnd = (endH * 60) + (endM || 0);

    if (!requiresApproval) {
      if (!dayEnabled) return [];
      const latestStart = Math.max(dayStart, dayEnd - durationMinutes);
      if (latestStart < dayStart) return [];
      return buildTimeOptions(dayStart, latestStart, timeStepMinutes).map(opt => ({ ...opt, isAfterHours: false }));
    }

    const fullOptions = buildTimeOptions(6 * 60, 22 * 60, timeStepMinutes).map(opt => ({
      ...opt,
      isAfterHours: !dayEnabled || opt.value < dayStart || (opt.value + durationMinutes) > dayEnd,
    }));
    return fullOptions;
  }, [date, timezone, room.business_hours, room.building_hours, durationMinutes, room.requires_approval, timeStepMinutes]);

  const isAfterHoursSelection = useMemo(() => {
    const hours = room.business_hours || room.building_hours;
    if (!hours || !hours.days) {
      return startMinutes < 8 * 60 || startMinutes + durationMinutes > 18 * 60;
    }
    const dayIndex = getLocalDayIndex(date, timezone);
    const dayConfig = hours.days[String(dayIndex)];
    if (!dayConfig || !dayConfig.enabled) return true;
    const [startH, startM] = String(dayConfig.start || '08:00').split(':').map(Number);
    const [endH, endM] = String(dayConfig.end || '18:00').split(':').map(Number);
    const dayStart = (startH * 60) + (startM || 0);
    const dayEnd = (endH * 60) + (endM || 0);
    const endMinutes = startMinutes + durationMinutes;
    return startMinutes < dayStart || endMinutes > dayEnd;
  }, [room.business_hours, room.building_hours, date, timezone, startMinutes, durationMinutes]);

  const schedulingSummary = useMemo(() => {
    const hours = room.business_hours || room.building_hours;
    const dayIndex = getLocalDayIndex(date, timezone);
    const dayConfig = hours?.days?.[String(dayIndex)];
    let hoursLabel = 'Not configured';

    if (hours?.days) {
      if (!dayConfig || !dayConfig.enabled) {
        hoursLabel = room.requires_approval ? 'After-hours only (approval required)' : 'Closed for regular booking';
      } else {
        hoursLabel = `${fmtHourMinute(String(dayConfig.start || '08:00'))} - ${fmtHourMinute(String(dayConfig.end || '18:00'))}`;
      }
    }

    const durationLabel = roomDurationLimitsEnabled || maxDurationRuleEnabled
      ? `${fmtDuration(minDuration)} - ${fmtDuration(maxDuration)}`
      : 'Flexible';
    const bufferLabel = bufferRuleEnabled && bufferMinutes > 0 ? fmtDuration(bufferMinutes) : 'off';
    const leadTimeLabel = minLeadTimeEnabled && minLeadTimeMinutes > 0 ? fmtDuration(minLeadTimeMinutes) : 'off';

    return { hoursLabel, durationLabel, bufferLabel, leadTimeLabel };
  }, [room.business_hours, room.building_hours, room.requires_approval, date, timezone, minDuration, maxDuration, bufferRuleEnabled, bufferMinutes, minLeadTimeEnabled, minLeadTimeMinutes, roomDurationLimitsEnabled, maxDurationRuleEnabled]);

  useEffect(() => {
    if (timeOptions.length === 0) return;
    if (!timeOptions.some(opt => opt.value === startMinutes)) {
      const firstAllowed = timeOptions.find(opt => !('isAfterHours' in opt && opt.isAfterHours));
      setStartMinutes((firstAllowed || timeOptions[0]).value);
    }
  }, [timeOptions, startMinutes]);

  useEffect(() => {
    if (durationMinutes < minDuration) {
      setDurationMinutes(minDuration);
    } else if (durationMinutes > maxDuration) {
      setDurationMinutes(maxDuration);
    }
  }, [minDuration, maxDuration, durationMinutes]);

  // Check if a given start time (in minutes) would conflict with any existing booking
  const getConflict = (slotStartMin: number): string | null => {
    const slotEndMin = slotStartMin + durationMinutes;
    for (const bk of existingBookings) {
      const bufferedStart = bk.start - bufferMinutes;
      const bufferedEnd = bk.end + bufferMinutes;
      if (slotStartMin < bufferedEnd && slotEndMin > bufferedStart) {
        return bk.title || 'Booked';
      }
    }
    return null;
  };

  const computedStart = buildDateInTimezone(date, startMinutes, timezone);
  const computedEnd = new Date(computedStart.getTime() + durationMinutes * 60000);

  // Formatted summary
  const summaryDate = useMemo(() => {
    return formatDate(parseDateOnly(date), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }, [date, formatDate]);

  const recurrenceDetails = useMemo(() => {
    const unit = repeatFrequency === 'daily' ? 'day' : repeatFrequency === 'weekly' ? 'week' : 'month';
    const cadence = repeatInterval === 1 ? `Every ${unit}` : `Every ${repeatInterval} ${unit}s`;
    const weekdayIndex = getLocalDayIndex(date, timezone);
    const weekday = WEEKDAYS[weekdayIndex]?.long || 'selected day';
    const monthlyDay = Number(date.split('-')[2]) || 1;
    const pattern = repeatFrequency === 'weekly'
      ? `${cadence} on ${weekday}`
      : repeatFrequency === 'monthly'
        ? `${cadence} on day ${monthlyDay}${monthlyDay > 28 ? " (or the month's last day)" : ''}`
        : cadence;
    const starts = formatDate(parseDateOnly(date), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const ends = repeatEndDate
      ? formatDate(parseDateOnly(repeatEndDate), {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'an end date';

    return {
      unit,
      weekdayIndex,
      starts,
      summary: `${pattern}, from ${fmtMinutes(startMinutes)} to ${fmtMinutes(startMinutes + durationMinutes)}, through ${ends}.`,
    };
  }, [date, durationMinutes, formatDate, repeatEndDate, repeatFrequency, repeatInterval, startMinutes, timezone]);

  const toggleITAV = (option: string) => {
    setSelectedITAV(prev =>
      prev.includes(option) ? prev.filter(o => o !== option) : [...prev, option]
    );
  };

  const applyTemplate = (templateId: number) => {
    const template = templates.find(t => t.id === templateId);
    if (!template) return;
    setSelectedTemplateId(templateId);
    setTitle(template.title || '');
    setNotes(template.notes || '');
    const equipment = template.equipment
      ? (typeof template.equipment === 'string' ? JSON.parse(template.equipment) : template.equipment)
      : [];
    setSelectedITAV(equipment);
    setNeedsITAV(equipment.length > 0);
    if (template.duration_minutes) {
      const duration = Math.min(Math.max(minDuration, Number(template.duration_minutes)), maxDuration);
      setDurationMinutes(duration);
    }
    const customFields = template.custom_fields
      ? (typeof template.custom_fields === 'string' ? JSON.parse(template.custom_fields) : template.custom_fields)
      : {};
    const templateAttendeeCount = Number(customFields.attendee_count);
    setAttendeeCount(Number.isInteger(templateAttendeeCount) && templateAttendeeCount >= 0 ? templateAttendeeCount : '');
    if (customFieldsConfig.length > 0) {
      setCustomFieldValues(prev => ({ ...prev, ...customFields }));
    }
  };

  const handleSaveTemplate = async () => {
    if (!templateName.trim()) {
      setError('Template name is required');
      return;
    }
    try {
      const customFieldsPayload: Record<string, any> = {};
      if (attendeeCount !== '' && Number(attendeeCount) > 0) {
        customFieldsPayload.attendee_count = Number(attendeeCount);
      }
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
      const created = await api.createBookingTemplate({
        name: templateName.trim(),
        title: title.trim(),
        duration_minutes: durationMinutes,
        equipment: needsITAV && selectedITAV.length > 0 ? selectedITAV : undefined,
        notes: notes || undefined,
        custom_fields: Object.keys(customFieldsPayload).length > 0 ? customFieldsPayload : undefined,
      });
      setTemplates(prev => [created, ...prev]);
      setTemplateName('');
      setSelectedTemplateId(created.id);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to save template');
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!Number.isFinite(computedStart.getTime())) {
      setError('That local time does not exist because of a daylight-saving time change');
      return;
    }

    if (!title.trim()) {
      setError('Please enter a meeting title');
      return;
    }

    if (computedStart <= new Date()) {
      setError('Cannot book time slots in the past');
      return;
    }

    if (timeOptions.length === 0) {
      setError('No available business hours for the selected date');
      return;
    }

    if (repeatEnabled && !repeatEndDate) {
      setError('Please choose when the series ends');
      return;
    }

    if (repeatEnabled && repeatEndDate < date) {
      setError('The series end date cannot be before the meeting start date');
      return;
    }

    if (repeatEnabled && recurrenceLimitEnabled && recurrenceLimitMonths > 0 && repeatEndDate) {
      const maxEndDate = addMonthsClampedDateOnly(date, recurrenceLimitMonths);
      if (repeatEndDate > maxEndDate) {
        setError(`Recurring bookings cannot extend beyond ${recurrenceLimitMonths} month(s) from the start date`);
        return;
      }
    }

    if (minLeadTimeEnabled && minLeadTimeMinutes > 0) {
      const now = new Date();
      const minStart = new Date(now.getTime() + minLeadTimeMinutes * 60000);
      if (computedStart < minStart) {
        setError(`Bookings must be made at least ${minLeadTimeMinutes} minute(s) in advance`);
        return;
      }
    }

    if (maxRoomBookingsPerDayEnabled && maxRoomBookingsPerDay > 0 && existingBookingsCount >= maxRoomBookingsPerDay) {
      setError(`This room already has ${existingBookingsCount} booking(s) on that day. Max allowed is ${maxRoomBookingsPerDay}.`);
      return;
    }

    if (needsITAV && selectedITAV.length === 0) {
      setError('Select at least one technology option or uncheck Request Technology');
      return;
    }

    const conflict = getConflict(startMinutes);
    if (conflict) {
      setError(bufferMinutes > 0 ? 'Selected time conflicts with an existing booking (buffer applies).' : 'Selected time conflicts with an existing booking.');
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
        setError(`Please complete the required field: ${missingField.label}`);
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
      await api.createBooking({
        room_id: Number(room.id),
        title,
        start_time: computedStart.toISOString(),
        end_time: computedEnd.toISOString(),
        attendee_count: attendeeCount === '' ? null : Number(attendeeCount),
        notes: notes || undefined,
        equipment: needsITAV && selectedITAV.length > 0 ? selectedITAV : undefined,
        custom_fields: Object.keys(customFieldsPayload).length > 0 ? customFieldsPayload : undefined,
        is_recurring: repeatEnabled,
        recurrence: repeatEnabled ? {
          frequency: repeatFrequency,
          interval: repeatInterval,
          end_date: repeatEndDate || undefined,
        } : undefined,
      });
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create booking');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        ref={modalRef}
        className="modal-content card booking-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="modal-kicker"><Building2 size={13} /> New reservation</span>
            <h2 id="booking-modal-title">Book {room.name}</h2>
            <div className="room-info-strip">
              <span>{room.building}</span>
              <span className="room-info-dot" />
              <span>Floor {room.floor}</span>
              <span className="room-info-dot" />
              <span>Up to {room.capacity}</span>
            </div>
          </div>
          <button type="button" className="close-btn" onClick={requestClose} aria-label="Close booking form"><X size={19} /></button>
        </div>

        {showDiscardConfirm ? (
          <UnsavedChangesPrompt
            id="new-booking-discard"
            onKeepEditing={() => setShowDiscardConfirm(false)}
            onDiscard={onClose}
          />
        ) : (
        <form onSubmit={handleSubmit} className="booking-form">
          <div className="field">
            <label htmlFor="title">Meeting Title</label>
            <input
              id="title"
              type="text"
              className="input"
              placeholder="Team Sync, Client Call, etc."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="attendee-count">Attendees (optional)</label>
            <input
              id="attendee-count"
              type="number"
              min={1}
              className="input"
              placeholder={`Up to ${room.capacity}`}
              value={attendeeCount}
              onChange={(e) => {
                const next = e.target.value === '' ? '' : Math.max(1, Number(e.target.value) || 1);
                setAttendeeCount(next);
              }}
            />
            {capacityWarningEnabled && attendeeCount !== '' && Number(attendeeCount) > Number(room.capacity) && (
              <p className="subtle" style={{ marginTop: '6px', color: 'var(--warning, #f59e0b)' }}>
                Warning: {attendeeCount} exceeds the room capacity of {room.capacity}.
              </p>
            )}
          </div>

          {templates.length > 0 && (
            <div className="field">
              <label>Templates</label>
              <div className="template-select-row">
                <select
                  className="input"
                  value={selectedTemplateId || ''}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (!id) return;
                    applyTemplate(id);
                  }}
                >
                  <option value="">Select a template</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                {selectedTemplateId && (
                  <button
                    type="button"
                    className="btn btn-danger btn-small"
                    onClick={async () => {
                      try {
                        await api.deleteBookingTemplate(selectedTemplateId);
                        setTemplates(prev => prev.filter(t => t.id !== selectedTemplateId));
                        setSelectedTemplateId(null);
                      } catch (err: any) {
                        setError(err.message || 'Failed to delete template');
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="scheduling-section">
            <div className="scheduling-summary">
              <span className="summary-chip">Hours: {schedulingSummary.hoursLabel}</span>
              <span className="summary-chip">Duration: {schedulingSummary.durationLabel}</span>
              <span className="summary-chip">Buffer: {schedulingSummary.bufferLabel}</span>
              <span className="summary-chip">Lead time: {schedulingSummary.leadTimeLabel}</span>
            </div>
            <div className="scheduling-top-row">
              <div className="field">
                <label>Date</label>
                <input
                  type="date"
                  className="input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Duration</label>
                <div className="duration-pills">
                  {durationOptions.map(d => (
                    <button
                      key={d.value}
                      type="button"
                      className={`duration-pill${durationMinutes === d.value ? ' active' : ''}`}
                      onClick={() => setDurationMinutes(d.value)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="field recurrence-field">
              <label>Repeat</label>
              <label className={`checkbox-label recurrence-toggle${repeatEnabled ? ' enabled' : ''}`}>
                <span className="custom-checkbox">
                  <input
                    type="checkbox"
                    checked={repeatEnabled}
                    onChange={(e) => setRepeatEnabled(e.target.checked)}
                  />
                  <span className="checkmark"></span>
                </span>
                <span className="recurrence-toggle-copy">
                  <strong>Repeat this meeting</strong>
                  <small>Create a series using the same room and meeting details.</small>
                </span>
              </label>
              {repeatEnabled && (
                <div className="repeat-config" aria-label="Recurrence details">
                  <div className="recurrence-heading">
                    <span className="recurrence-heading-icon"><CalendarRange size={17} /></span>
                    <span>
                      <strong>Recurrence details</strong>
                      <small>Choose how often this meeting should repeat.</small>
                    </span>
                  </div>

                  <div className="recurrence-pattern-grid">
                    <label className="recurrence-control">
                      <span className="recurrence-control-label">Repeats</span>
                      <select
                        className="input"
                        value={repeatFrequency}
                        onChange={(e) => setRepeatFrequency(e.target.value as 'daily' | 'weekly' | 'monthly')}
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </label>
                    <div className="recurrence-control">
                      <span className="recurrence-control-label">Every</span>
                      <div className="repeat-interval">
                      <input
                        className="input repeat-interval-input"
                        type="number"
                        min={1}
                        max={99}
                        aria-label={`Repeat every number of ${recurrenceDetails.unit}s`}
                        value={repeatInterval}
                        onChange={(e) => setRepeatInterval(Math.min(99, Math.max(1, Number(e.target.value) || 1)))}
                      />
                        <span>{recurrenceDetails.unit}{repeatInterval === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                  </div>

                  {repeatFrequency === 'weekly' && (
                    <div className="recurrence-weekday-row">
                      <span className="recurrence-control-label">On</span>
                      <div className="recurrence-weekdays" aria-label={`Repeats on ${WEEKDAYS[recurrenceDetails.weekdayIndex].long}`}>
                        {WEEKDAYS.map((weekday, index) => (
                          <span
                            key={`${weekday.long}-${index}`}
                            className={`recurrence-weekday${index === recurrenceDetails.weekdayIndex ? ' active' : ''}`}
                            title={weekday.long}
                            aria-hidden={index !== recurrenceDetails.weekdayIndex}
                          >
                            {weekday.short}
                          </span>
                        ))}
                      </div>
                      <small>Uses the weekday of the meeting’s start date.</small>
                    </div>
                  )}

                  <div className="recurrence-dates-grid">
                    <div className="recurrence-date-display">
                      <span className="recurrence-control-label">Starts</span>
                      <strong>{recurrenceDetails.starts}</strong>
                    </div>
                    <label className="recurrence-control">
                      <span className="recurrence-control-label">Ends on</span>
                      <input
                        type="date"
                        className="input"
                        min={date}
                        value={repeatEndDate}
                        onChange={(e) => setRepeatEndDate(e.target.value)}
                      />
                    </label>
                  </div>

                  <div className="recurrence-summary">
                    <Repeat2 size={16} />
                    <span>
                      <strong>Series summary</strong>
                      <small>{recurrenceDetails.summary}</small>
                    </span>
                  </div>

                  {recurrenceLimitEnabled && recurrenceLimitMonths > 0 && (
                    <div className="recurrence-limit-note">
                      This series can extend up to {recurrenceLimitMonths} month{recurrenceLimitMonths === 1 ? '' : 's'} from its start date.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="field">
              <label>Start Time</label>
              <div className="time-slot-grid">
                {timeOptions.length === 0 ? (
                  <div className="subtle" style={{ gridColumn: '1 / -1' }}>
                    No business hours configured for this day.
                  </div>
                ) : (
                  timeOptions.map(opt => {
                    const conflict = getConflict(opt.value);
                    const isAfterHours = 'isAfterHours' in opt && opt.isAfterHours;
                    const approvalRequired = !!room.requires_approval && isAfterHours;
                    const isSelected = startMinutes === opt.value && !conflict;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        className={`time-pill${isSelected ? ' selected' : ''}${conflict ? ' booked' : ''}${approvalRequired ? ' after-hours' : ''}`}
                        disabled={!!conflict}
                        onClick={() => setStartMinutes(opt.value)}
                        title={conflict ? `Unavailable: ${conflict}` : approvalRequired ? 'After-hours (approval required)' : opt.label}
                      >
                        <span className="time-pill-label">{opt.label}</span>
                        {conflict && <span className="time-pill-badge">Booked</span>}
                        {!conflict && approvalRequired && <span className="time-pill-badge">Approval</span>}
                      </button>
                    );
                  })
                )}
              </div>
              {!!room.requires_approval && isAfterHoursSelection && (
                <p className="subtle" style={{ marginTop: '6px' }}>
                  After-hours booking will require approval before confirmation.
                </p>
              )}
            </div>
          </div>

          {(minLeadTimeMinutes > 0 || maxRoomBookingsPerDay > 0 || bufferMinutes > 0 || maxDurationRuleMinutes > 0 || roomDurationLimitsEnabled) && (
            <div className="subtle" style={{ marginTop: '4px' }}>
              {minLeadTimeMinutes > 0 && (
                <div>Bookings must be made at least {minLeadTimeMinutes} minute(s) in advance.</div>
              )}
              {maxRoomBookingsPerDay > 0 && (
                <div>This room allows up to {maxRoomBookingsPerDay} booking(s) per day. Current: {existingBookingsCount}.</div>
              )}
              {bufferMinutes > 0 && (
                <div>Room requires a {bufferMinutes} minute buffer between bookings.</div>
              )}
              {maxDurationRuleMinutes > 0 && (
                <div>Bookings are limited to {maxDurationRuleMinutes} minute(s) max.</div>
              )}
              {roomDurationLimitsEnabled && (
                <div>Room duration limits apply ({roomMinDuration}-{roomMaxDuration} minutes).</div>
              )}
            </div>
          )}

          <div className="field">
            <label className="checkbox-label itav-toggle">
              <span className="custom-checkbox">
                <input
                  type="checkbox"
                  checked={needsITAV}
                  onChange={(e) => {
                    if (itavOptions.length === 0) return;
                    const enabled = e.target.checked;
                    setNeedsITAV(enabled);
                    setShowTechMenu(enabled);
                  }}
                  disabled={itavOptions.length === 0}
                />
                <span className="checkmark"></span>
              </span>
              <span>Request Technology</span>
            </label>
            {itavOptions.length === 0 && (
              <div className="subtle" style={{ marginTop: '8px' }}>
                No technology options configured yet.
              </div>
            )}
            {needsITAV && (
              <div className="resy-tech-dropdown">
                <div className="resy-tech-menu-controls">
                  <span className="resy-tech-selected-count">
                    {selectedITAV.length > 0 ? `${selectedITAV.length} selected` : 'None selected'}
                  </span>
                  <button
                    type="button"
                    className="resy-tech-collapse-btn"
                    onClick={() => setShowTechMenu(prev => !prev)}
                  >
                    {showTechMenu ? 'Done' : 'Edit Technology'}
                  </button>
                </div>
                {showTechMenu && (
                  <div className="resy-tech-menu resy-tech-menu-inline">
                    <div className="resy-tech-menu-header">Select what you need</div>
                    <div className="resy-tech-options">
                      {itavOptions.map(opt => (
                        <label key={opt} className="checkbox-label">
                          <span className="custom-checkbox">
                            <input
                              type="checkbox"
                              checked={selectedITAV.includes(opt)}
                              onChange={() => toggleITAV(opt)}
                            />
                            <span className="checkmark"></span>
                          </span>
                          <span>{opt}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {selectedITAV.length === 0 && (
                  <div className="subtle" style={{ marginTop: '8px', color: 'var(--danger, #dc2626)' }}>
                    Select at least one technology option to submit this booking.
                  </div>
                )}
              </div>
            )}
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
            <label htmlFor="notes">Notes (optional)</label>
            <textarea
              id="notes"
              className="input textarea"
              placeholder="Additional information..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>

          <div className="field">
            <label>Save As Template</label>
            <div className="template-save-row">
              <input
                className="input"
                placeholder="Template name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <button type="button" className="btn btn-secondary" onClick={handleSaveTemplate}>
                Save Template
              </button>
            </div>
            <p className="subtle">Save the current form as a reusable template.</p>
          </div>

          {error && <div className="error-message">{error}</div>}

          <div className="modal-footer">
            <div className="booking-summary">
              {summaryDate} &middot; {fmtMinutes(startMinutes)} &ndash; {fmtMinutes(startMinutes + durationMinutes)}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={requestClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? 'Booking...' : 'Confirm Booking'}
              </button>
            </div>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};
