import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../config/api';
import { useNotification } from '../contexts/NotificationContext';
import { useTimezone } from '../contexts/TimezoneContext';
import { Room } from '../types';
import { BookingModal } from './BookingModal';
import { ViewBookingModal } from './ViewBookingModal';
import { MiniCalendar } from './MiniCalendar';
import { buildDateInTimezone, parseDateOnly, formatDateOnly } from '../utils/date';
import { Building2, CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus, UsersRound } from 'lucide-react';
import '../styles/Calendar.css';

type CalendarViewMode = 'day' | 'week' | 'month';

const parseBusinessHours = (raw: any) => {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.days ? parsed : null;
    } catch {
      return null;
    }
  }
  return raw?.days ? raw : null;
};

export const Calendar = () => {
  const [searchParams] = useSearchParams();
  const linkedBookingId = searchParams.get('booking');
  const linkedStartTime = searchParams.get('start');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState(searchParams.get('room') || '');
  const { timezone, getLocalDate, formatDate, formatTime } = useTimezone();
  const [selectedDate, setSelectedDate] = useState(() => getLocalDate(linkedStartTime || new Date()));
  const [viewMode, setViewMode] = useState<CalendarViewMode>('day');
  const [bookings, setBookings] = useState<any[]>([]);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<{ start: Date; end: Date } | null>(null);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [showViewModal, setShowViewModal] = useState(false);
  const [expandedMonthMore, setExpandedMonthMore] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showEquipment, setShowEquipment] = useState(true);
  const [bookingIntervalEnabled, setBookingIntervalEnabled] = useState(true);
  const [bookingIntervalMinutes, setBookingIntervalMinutes] = useState(30);
  const openedLinkedBooking = useRef(false);
  const notify = useNotification();

  const normalizeCalendarView = (raw: unknown): CalendarViewMode => {
    return raw === 'week' || raw === 'month' ? raw : 'day';
  };

  useEffect(() => {
    api.getSettings().then((s: any) => {
      setShowEquipment(s.show_equipment);
      setViewMode(normalizeCalendarView(s.calendar_default_view));
      if (typeof s.booking_interval_enabled === 'boolean') {
        setBookingIntervalEnabled(s.booking_interval_enabled);
      }
      if (typeof s.booking_interval_minutes === 'number' && [15, 30, 60].includes(s.booking_interval_minutes)) {
        setBookingIntervalMinutes(s.booking_interval_minutes);
      }
    }).catch(() => {});
    api.getRooms().then((data: any[]) => {
      const parsed = data.map((r: any) => ({
        ...r,
        equipment: typeof r.equipment === 'string' ? JSON.parse(r.equipment) : (r.equipment || []),
        business_hours: parseBusinessHours(r.business_hours),
        building_hours: parseBusinessHours(r.building_hours),
      }));
      setRooms(parsed);
      if (!selectedRoomId && parsed.length > 0) {
        setSelectedRoomId(String(parsed[0].id));
      }
    }).catch((err) => notify.error(err.message || 'Failed to load rooms'));
  }, []);

  useEffect(() => {
    if (!selectedRoomId) return;
    const { start, end } = viewMode === 'week'
      ? getWeekRange(selectedDate)
      : viewMode === 'month'
        ? getMonthRange(selectedDate)
        : { start: selectedDate, end: selectedDate };
    api.getBookings({ room_id: selectedRoomId, start_date: start, end_date: end })
      .then((data: any[]) => setBookings(data))
      .catch((err) => notify.error(err.message || 'Failed to load bookings'));
  }, [selectedRoomId, selectedDate, refreshKey, viewMode]);

  useEffect(() => {
    if (linkedStartTime) {
      setSelectedDate(getLocalDate(linkedStartTime));
    }
  }, [linkedStartTime, timezone]);

  useEffect(() => {
    if (openedLinkedBooking.current || !linkedBookingId) return;
    const linkedBooking = bookings.find(booking => String(booking.id) === linkedBookingId);
    if (!linkedBooking) return;
    openedLinkedBooking.current = true;
    setSelectedBooking(linkedBooking);
    setShowViewModal(true);
  }, [bookings, linkedBookingId]);

  const selectedRoom = rooms.find(r => String(r.id) === String(selectedRoomId));
  const isVisibleBooking = (booking: any) => booking?.status === 'confirmed' || booking?.status === 'pending';

  const getLocalDayIndex = (dateStr: string): number => {
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

  // Get minutes since midnight in app timezone for a given date
  const getMinutesSinceMidnight = (date: Date | string): number => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(d);
    const hourPart = parts.find(p => p.type === 'hour');
    const minutePart = parts.find(p => p.type === 'minute');
    const hour = hourPart ? parseInt(hourPart.value, 10) : 0;
    const minute = minutePart ? parseInt(minutePart.value, 10) : 0;
    return hour * 60 + minute;
  };

  const timeSlots = useMemo(() => {
    if (!selectedRoom) return [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    const hours = selectedRoom.business_hours || selectedRoom.building_hours;
    if (!hours || !hours.days) return selectedRoom.requires_approval
      ? [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
      : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    const dayIndex = getLocalDayIndex(selectedDate);
    const dayConfig = hours.days[String(dayIndex)];
    if (!dayConfig || !dayConfig.enabled) {
      return selectedRoom.requires_approval ? [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] : [];
    }
    const [startH] = String(dayConfig.start || '08:00').split(':').map(Number);
    const [endH] = String(dayConfig.end || '18:00').split(':').map(Number);
    const slots: number[] = [];
    for (let h = startH; h < endH; h++) slots.push(h);
    if (!selectedRoom.requires_approval) {
      const baseSlots = slots.length > 0 ? slots : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
      return baseSlots;
    }
    const extended = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    const merged = new Set([...extended, ...slots]);
    const base = Array.from(merged).sort((a, b) => a - b);
    return base;
  }, [selectedRoom, selectedDate, timezone]);

  const visibleSlots = useMemo(() => {
    const base = timeSlots;
    const activeBookings = bookings.filter(isVisibleBooking);
    if (activeBookings.length === 0) return base;

    let minHour = base.length > 0 ? base[0] : 23;
    let maxHour = base.length > 0 ? base[base.length - 1] : 0;
    activeBookings.forEach((booking: any) => {
      const startMinutes = getMinutesSinceMidnight(booking.start_time);
      const endMinutes = getMinutesSinceMidnight(booking.end_time);
      const startHour = Math.floor(startMinutes / 60);
      const endHour = Math.ceil(endMinutes / 60);
      if (startHour < minHour) minHour = startHour;
      if (endHour > maxHour) maxHour = endHour;
    });

    const slots: number[] = [];
    for (let h = minHour; h <= maxHour; h++) slots.push(h);
    return slots;
  }, [timeSlots, bookings, timezone]);

  const formatHour = (hour: number) => {
    if (hour === 12) return '12 PM';
    return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
  };

  const getWeekRange = (dateStr: string) => {
    const date = parseDateOnly(dateStr);
    const day = date.getDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(date);
    monday.setDate(date.getDate() - diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      start: formatDateOnly(monday),
      end: formatDateOnly(sunday),
    };
  };

  const getMonthRange = (dateStr: string) => {
    const date = parseDateOnly(dateStr);
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return {
      start: formatDateOnly(first),
      end: formatDateOnly(last),
    };
  };

  const getWeekDates = (dateStr: string) => {
    const { start } = getWeekRange(dateStr);
    const startDate = parseDateOnly(start);
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      return formatDateOnly(d);
    });
  };

  const weekDates = getWeekDates(selectedDate);

  const contextLabel = useMemo(() => {
    if (viewMode === 'day') {
      return `Day view · ${formatDate(parseDateOnly(selectedDate), {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`;
    }
    if (viewMode === 'week') {
      return `Week view · ${formatDate(parseDateOnly(weekDates[0]), { month: 'short', day: 'numeric', year: 'numeric' })} to ${formatDate(parseDateOnly(weekDates[6]), { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return `Month view · ${formatDate(parseDateOnly(selectedDate), { month: 'long', year: 'numeric' })}`;
  }, [viewMode, selectedDate, weekDates, formatDate]);

  const getMonthGrid = (dateStr: string) => {
    const date = parseDateOnly(dateStr);
    const year = date.getFullYear();
    const month = date.getMonth();
    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const start = new Date(year, month, 1 - startDay);
    return Array.from({ length: 42 }).map((_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  };

  const monthGrid = getMonthGrid(selectedDate);
  const monthKey = selectedDate.slice(0, 7);
  const bookingsByDate = bookings.filter(isVisibleBooking).reduce<Record<string, any[]>>((acc, booking: any) => {
    const date = getLocalDate(booking.start_time);
    if (!acc[date]) acc[date] = [];
    acc[date].push(booking);
    return acc;
  }, {});

  const getBookingForSlot = (hour: number, dateOverride?: string) => {
    const targetDate = dateOverride || selectedDate;
    const slotStart = buildDateInTimezone(targetDate, hour * 60, timezone);
    if (!Number.isFinite(slotStart.getTime())) return undefined;
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

    return bookings.find((booking: any) => {
      if (!isVisibleBooking(booking)) return false;
      const bookingStart = new Date(booking.start_time);
      const bookingEnd = new Date(booking.end_time);
      return bookingStart < slotEnd && bookingEnd > slotStart;
    });
  };

  const getBookingDurationMinutes = (booking: any): number => {
    const start = new Date(booking.start_time).getTime();
    const end = new Date(booking.end_time).getTime();
    return Math.max(0, Math.round((end - start) / 60000));
  };

  const getBookingDisplayName = (booking: any): string => {
    return booking.organizer_name || booking.organizer_email || 'Unknown organizer';
  };

  const getTinyBookingLabel = (booking: any): string => {
    const title = String(booking.title || '').trim();
    if (title.length > 0) return title;
    return getBookingDisplayName(booking);
  };

  const getDefaultDurationMinutes = (room: Room | null): number => {
    const roomMin = Number(room?.min_duration_minutes);
    if (Number.isFinite(roomMin) && roomMin >= 15) return roomMin;
    return 30;
  };

  const getTimeSlotsForDate = (dateStr: string): number[] => {
    if (!selectedRoom) return [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    const hours = selectedRoom.business_hours || selectedRoom.building_hours;
    if (!hours || !hours.days) return selectedRoom.requires_approval
      ? [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
      : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

    const dayIndex = getLocalDayIndex(dateStr);
    const dayConfig = hours.days[String(dayIndex)];
    if (!dayConfig || !dayConfig.enabled) {
      return selectedRoom.requires_approval ? [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] : [];
    }

    const [startH] = String(dayConfig.start || '08:00').split(':').map(Number);
    const [endH] = String(dayConfig.end || '18:00').split(':').map(Number);
    const slots: number[] = [];
    for (let h = startH; h < endH; h++) slots.push(h);
    if (!selectedRoom.requires_approval) return slots;

    const extended = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    return Array.from(new Set([...extended, ...slots])).sort((a, b) => a - b);
  };

  const handleSlotClick = (hour: number, dateOverride?: string) => {
    const targetDate = dateOverride || selectedDate;
    const booking = getBookingForSlot(hour, targetDate);
    if (booking) {
      // Open view/edit modal for existing booking
      setSelectedBooking(booking);
      setShowViewModal(true);
      return;
    }
    if (!selectedRoom) return;
    const defaultDuration = getDefaultDurationMinutes(selectedRoom);
    const start = buildDateInTimezone(targetDate, hour * 60, timezone);
    if (!Number.isFinite(start.getTime())) {
      notify.error('That local time is unavailable because of a daylight-saving time change.');
      return;
    }
    const end = new Date(start.getTime() + defaultDuration * 60 * 1000);
    setSelectedSlot({ start, end });
    setShowBookingModal(true);
  };

  const openBookingForDate = (dateStr: string) => {
    setSelectedDate(dateStr);
    if (!selectedRoom) {
      notify.error('Select a room to book.');
      return;
    }
    const intervalMinutes = bookingIntervalEnabled && [15, 30, 60].includes(bookingIntervalMinutes)
      ? bookingIntervalMinutes
      : 30;
    const dayHours = getTimeSlotsForDate(dateStr);
    if (dayHours.length === 0) {
      notify.error('No available slots on this day.');
      return;
    }
    const minHour = Math.min(...dayHours);
    const maxHour = Math.max(...dayHours);
    const candidates: number[] = [];
    for (let mins = minHour * 60; mins <= maxHour * 60; mins += intervalMinutes) {
      candidates.push(mins);
    }

    const today = getLocalDate(new Date());
    const isToday = dateStr === today;
    const nowMinutes = getMinutesSinceMidnight(new Date());
    const minAllowedMinutes = isToday
      ? Math.ceil(nowMinutes / intervalMinutes) * intervalMinutes
      : Number.NEGATIVE_INFINITY;
    const firstAvailableMinutes = candidates.find(mins =>
      mins >= minAllowedMinutes && !getBookingForSlot(Math.floor(mins / 60), dateStr)
    );
    if (firstAvailableMinutes === undefined) {
      notify.error(isToday ? 'No future available slots today.' : 'No available slots on this day.');
      return;
    }
    const defaultDuration = getDefaultDurationMinutes(selectedRoom);
    const hour = Math.floor(firstAvailableMinutes / 60);
    const minute = firstAvailableMinutes % 60;
    const start = buildDateInTimezone(dateStr, hour * 60 + minute, timezone);
    if (!Number.isFinite(start.getTime())) {
      notify.error('That local time is unavailable because of a daylight-saving time change.');
      return;
    }
    const end = new Date(start.getTime() + defaultDuration * 60 * 1000);
    setSelectedSlot({ start, end });
    setShowBookingModal(true);
  };

  const handleBookingSuccess = () => {
    setShowBookingModal(false);
    setSelectedSlot(null);
    setRefreshKey(k => k + 1);
  };

  const handleViewModalClose = () => {
    setShowViewModal(false);
    setSelectedBooking(null);
  };

  const handleBookingUpdate = () => {
    setShowViewModal(false);
    setSelectedBooking(null);
    setRefreshKey(k => k + 1);
  };

  // Day navigation
  const changeDate = (days: number) => {
    const date = parseDateOnly(selectedDate);
    date.setDate(date.getDate() + days);
    setSelectedDate(formatDateOnly(date));
  };

  const changeWeek = (weeks: number) => {
    const date = parseDateOnly(selectedDate);
    date.setDate(date.getDate() + weeks * 7);
    setSelectedDate(formatDateOnly(date));
  };

  const changeMonth = (months: number) => {
    const date = parseDateOnly(selectedDate);
    date.setMonth(date.getMonth() + months);
    setSelectedDate(formatDateOnly(date));
  };

  return (
    <div className="calendar-view">
      <header className="calendar-page-header">
        <div className="calendar-heading-copy">
          <span className="eyebrow">Schedule</span>
          <h1>Calendar</h1>
          <p className="page-flow">Choose a room and date to review availability and create bookings.</p>
          <p className="page-flow-context">{contextLabel}</p>
        </div>
        <div className="calendar-controls">
          <MiniCalendar
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            roomId={selectedRoomId}
          />
          <div className="view-toggle">
            <button
              type="button"
              className={`btn btn-secondary ${viewMode === 'day' ? 'active' : ''}`}
              onClick={() => setViewMode('day')}
            >
              Day
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${viewMode === 'week' ? 'active' : ''}`}
              onClick={() => setViewMode('week')}
            >
              Week
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${viewMode === 'month' ? 'active' : ''}`}
              onClick={() => setViewMode('month')}
            >
              Month
            </button>
          </div>
          <button
            type="button"
            className="btn btn-secondary today-button"
            onClick={() => setSelectedDate(getLocalDate(new Date()))}
          >
            <CalendarDays size={16} /> Today
          </button>
          <div className="calendar-room-select">
            <Building2 size={16} aria-hidden="true" />
            <label className="visually-hidden" htmlFor="calendar-room">Room</label>
            <select id="calendar-room" className="input" value={selectedRoomId} onChange={(e) => setSelectedRoomId(e.target.value)}>
              {rooms.map(room => (
                <option key={room.id} value={room.id}>{room.name} ({room.building})</option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!selectedRoom) return;
              openBookingForDate(selectedDate);
            }}
          >
            <Plus size={17} /> New Booking
          </button>
        </div>
      </header>

      {selectedRoom && (
        <div className="room-info card">
          <div>
            <h3>{selectedRoom.name}</h3>
            <p className="room-info-meta">
              <span><MapPin size={14} />{selectedRoom.building} · Floor {selectedRoom.floor}</span>
              <span><UsersRound size={14} />{selectedRoom.capacity} people</span>
            </p>
          </div>
          {showEquipment && (
            <div className="equipment-tags">
              {selectedRoom.equipment.map(eq => (
                <span key={eq} className="equipment-tag">{eq}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {viewMode !== 'month' && (
        <div className="week-strip card">
          {weekDates.map(dateStr => {
            const date = parseDateOnly(dateStr);
            const isActive = dateStr === selectedDate;
            return (
              <button
                key={dateStr}
                type="button"
                className={`week-strip-day ${isActive ? 'active' : ''}`}
                onClick={() => setSelectedDate(dateStr)}
              >
                <span className="week-strip-single">
                  {formatDate(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {viewMode === 'month' && (
        <div className="month-grid card">
          <div className="month-header">
            <button className="day-nav-btn" onClick={() => changeMonth(-1)} title="Previous month">
              <ChevronLeft size={17} />
            </button>
            <span className="month-title">
              {formatDate(parseDateOnly(selectedDate), { month: 'long', year: 'numeric' })}
            </span>
            <button className="day-nav-btn" onClick={() => changeMonth(1)} title="Next month">
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="month-weekdays">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <span key={day} className="month-weekday">{day}</span>
            ))}
          </div>
          <div className="month-cells">
            {monthGrid.map(date => {
              const dateStr = formatDateOnly(date);
              const isCurrentMonth = dateStr.startsWith(monthKey);
              const isActive = dateStr === selectedDate;
              const isToday = dateStr === getLocalDate(new Date());
              const isWeekend = date.getDay() === 0 || date.getDay() === 6;
              const dayBookings = (bookingsByDate[dateStr] || []).slice().sort((a, b) => {
                return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
              });
              const count = dayBookings.length;
              const handleMonthDayClick = () => {
                setSelectedDate(dateStr);
              };

              return (
                <div
                  key={dateStr}
                  role="button"
                  tabIndex={0}
                  className={`month-day ${isCurrentMonth ? 'current' : 'muted'} ${isActive ? 'active' : ''} ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''}`}
                  onClick={handleMonthDayClick}
                  onDoubleClick={() => {
                    if (isCurrentMonth) openBookingForDate(dateStr);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleMonthDayClick();
                    }
                  }}
                >
                  <span className="month-day-number">{date.getDate()}</span>
                  {isCurrentMonth && isActive && (
                    <button
                      type="button"
                      className="month-day-book-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        openBookingForDate(dateStr);
                      }}
                    >
                      + Book
                    </button>
                  )}
                  {count > 0 && (
                    <span className="month-day-events">
                      {dayBookings.slice(0, 2).map((booking: any) => (
                        <button
                          key={booking.id}
                          type="button"
                          className="month-event"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedBooking(booking);
                            setShowViewModal(true);
                          }}
                        >
                          <span className="month-event-time">
                            {formatTime(booking.start_time)}
                          </span>
                          <span className="month-event-title">{booking.title}</span>
                        </button>
                      ))}
                      {count > 2 && (
                        <div className="month-more-wrap">
                          <button
                            type="button"
                            className="month-more"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedMonthMore(expandedMonthMore === dateStr ? null : dateStr);
                            }}
                          >
                            +{count - 2} more
                          </button>
                          {expandedMonthMore === dateStr && (
                            <div className="month-more-popover">
                              {dayBookings.slice(2).map((booking: any) => (
                                <div key={booking.id} className="month-more-item">
                                  <span className="month-more-time">
                                    {formatTime(booking.start_time)}
                                  </span>
                                  <span className="month-more-title">{booking.title}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewMode === 'month' ? null : viewMode === 'day' ? (
        <div className="calendar-grid">
          <div className="time-column">
            <div className="time-header">Time</div>
            {timeSlots.map(hour => (
              <div key={hour} className="time-slot">{formatHour(hour)}</div>
            ))}
          </div>

          <div className="schedule-column">
            <div className="schedule-header">
              <button className="day-nav-btn" onClick={() => changeDate(-1)} title="Previous day">
                <ChevronLeft size={17} />
              </button>
              <span className="schedule-date">
                {formatDate(parseDateOnly(selectedDate), {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
              <button className="day-nav-btn" onClick={() => changeDate(1)} title="Next day">
                <ChevronRight size={17} />
              </button>
            </div>
            <div className="schedule-slots-container">
              {/* Render the hour slot backgrounds */}
              {visibleSlots.map(hour => {
                const hasBooking = !!getBookingForSlot(hour);
                return (
                  <button
                    key={hour}
                    type="button"
                    className={`schedule-slot ${hasBooking ? 'has-booking' : 'free'}`}
                    onClick={() => handleSlotClick(hour)}
                    title={hasBooking ? 'Click to view/edit' : 'Click to book'}
                    aria-label={hasBooking ? `View booking at ${formatHour(hour)}` : `Book ${formatHour(hour)}`}
                  />
                );
              })}
              {/* Render positioned booking blocks */}
              {bookings
                .filter((booking: any) => {
                  const bookingDate = getLocalDate(booking.start_time);
                  return bookingDate === selectedDate && isVisibleBooking(booking);
                })
                .map((booking: any) => {
                  const startMinutes = getMinutesSinceMidnight(booking.start_time);
                  const endMinutes = getMinutesSinceMidnight(booking.end_time);
                  const durationMinutes = getBookingDurationMinutes(booking);
                  const startHour = startMinutes / 60;
                  const endHour = endMinutes / 60;

                  // Calculate position relative to the first slot (8 AM)
                  const firstSlotHour = visibleSlots[0];
                  const lastSlotHour = visibleSlots[visibleSlots.length - 1] + 1;

                  // Clamp to visible range
                  const visibleStart = Math.max(startHour, firstSlotHour);
                  const visibleEnd = Math.min(endHour, lastSlotHour);

                  if (visibleStart >= lastSlotHour || visibleEnd <= firstSlotHour) {
                    return null; // Booking is outside visible range
                  }

                  const topPercent = ((visibleStart - firstSlotHour) / visibleSlots.length) * 100;
                  const heightPercent = ((visibleEnd - visibleStart) / visibleSlots.length) * 100;

                  return (
                    <button
                      key={booking.id}
                        className={`booking-block ${durationMinutes < 45 ? 'compact' : ''} ${durationMinutes < 30 ? 'tiny' : ''}`}
                      type="button"
                      style={{
                        top: `${topPercent}%`,
                        height: `${heightPercent}%`,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedBooking(booking);
                        setShowViewModal(true);
                      }}
                      title={`${booking.title} · ${booking.organizer_name || booking.organizer_email || 'Unknown organizer'} - Click to view/edit`}
                      aria-label={`View booking: ${booking.title}`}
                    >
                          <div className="booking-info">
                            {durationMinutes < 45 ? (
                              <span className="booking-compact-text">
                                {durationMinutes < 30
                                  ? getTinyBookingLabel(booking)
                                  : `${booking.title} - ${getBookingDisplayName(booking)}`}
                              </span>
                            ) : (
                              <>
                                <div className="booking-title">{booking.title}</div>
                                <div className="booking-organizer">{getBookingDisplayName(booking)}</div>
                              </>
                            )}
                          </div>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      ) : (
        <div className="calendar-grid week">
          <div className="time-column">
            <div className="time-header">Time</div>
            {visibleSlots.map(hour => (
              <div key={hour} className="time-slot">{formatHour(hour)}</div>
            ))}
          </div>
          <div className="week-columns">
            <div className="schedule-header week-nav">
              <button className="day-nav-btn" onClick={() => changeWeek(-1)} title="Previous week">
                <ChevronLeft size={17} />
              </button>
              <span className="schedule-date">
                {formatDate(parseDateOnly(weekDates[0]), { month: 'short', day: 'numeric', year: 'numeric' })} —{' '}
                {formatDate(parseDateOnly(weekDates[6]), { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <button className="day-nav-btn" onClick={() => changeWeek(1)} title="Next week">
                <ChevronRight size={17} />
              </button>
            </div>
            {weekDates.map(dateStr => {
              const date = parseDateOnly(dateStr);
              return (
                <div key={dateStr} className="schedule-column">
                  <div className="schedule-header week">
                    <span className="schedule-date">
                      {formatDate(date, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <div className="schedule-slots-container">
                    {visibleSlots.map(hour => {
                      const hasBooking = !!getBookingForSlot(hour, dateStr);
                      return (
                        <button
                          key={`${dateStr}-${hour}`}
                          type="button"
                          className={`schedule-slot ${hasBooking ? 'has-booking' : 'free'}`}
                          onClick={() => handleSlotClick(hour, dateStr)}
                          title={hasBooking ? 'Click to view/edit' : 'Click to book'}
                          aria-label={hasBooking ? `View booking at ${formatHour(hour)}` : `Book ${formatHour(hour)}`}
                        />
                      );
                    })}
                    {bookings
                      .filter((booking: any) => {
                        const bookingDate = getLocalDate(booking.start_time);
                        return bookingDate === dateStr && isVisibleBooking(booking);
                      })
                      .map((booking: any) => {
                        const startMinutes = getMinutesSinceMidnight(booking.start_time);
                        const endMinutes = getMinutesSinceMidnight(booking.end_time);
                        const durationMinutes = getBookingDurationMinutes(booking);
                        const startHour = startMinutes / 60;
                        const endHour = endMinutes / 60;

                        const firstSlotHour = visibleSlots[0];
                        const lastSlotHour = visibleSlots[visibleSlots.length - 1] + 1;

                        const visibleStart = Math.max(startHour, firstSlotHour);
                        const visibleEnd = Math.min(endHour, lastSlotHour);

                        if (visibleStart >= lastSlotHour || visibleEnd <= firstSlotHour) {
                          return null;
                        }

                        const topPercent = ((visibleStart - firstSlotHour) / visibleSlots.length) * 100;
                        const heightPercent = ((visibleEnd - visibleStart) / visibleSlots.length) * 100;

                        return (
                          <button
                            key={booking.id}
                            className={`booking-block ${durationMinutes < 45 ? 'compact' : ''} ${durationMinutes < 30 ? 'tiny' : ''}`}
                            type="button"
                            style={{
                              top: `${topPercent}%`,
                              height: `${heightPercent}%`,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedBooking(booking);
                              setShowViewModal(true);
                            }}
                            title={`${booking.title} · ${booking.organizer_name || booking.organizer_email || 'Unknown organizer'} - Click to view/edit`}
                            aria-label={`View booking: ${booking.title}`}
                          >
                            <div className="booking-info">
                              {durationMinutes < 45 ? (
                                <span className="booking-compact-text">
                                  {durationMinutes < 30
                                    ? getTinyBookingLabel(booking)
                                    : `${booking.title} - ${getBookingDisplayName(booking)}`}
                                </span>
                              ) : (
                                <>
                                  <div className="booking-title">{booking.title}</div>
                                  <div className="booking-organizer">{getBookingDisplayName(booking)}</div>
                                </>
                              )}
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showBookingModal && selectedSlot && selectedRoom && (
        <BookingModal
          room={selectedRoom}
          startTime={selectedSlot.start}
          endTime={selectedSlot.end}
          onClose={() => setShowBookingModal(false)}
          onSuccess={handleBookingSuccess}
        />
      )}

      {showViewModal && selectedBooking && selectedRoom && (
        <ViewBookingModal
          booking={selectedBooking}
          room={selectedRoom}
          onClose={handleViewModalClose}
          onUpdate={handleBookingUpdate}
        />
      )}
    </div>
  );
};
