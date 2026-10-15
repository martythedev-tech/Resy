import { useState, useEffect } from 'react';
import { api } from '../config/api';
import { useTimezone } from '../contexts/TimezoneContext';
import { parseDateOnly, formatDateOnly } from '../utils/date';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import '../styles/MiniCalendar.css';

interface MiniCalendarProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  roomId: string;
}

export const MiniCalendar = ({ selectedDate, onSelectDate, roomId }: MiniCalendarProps) => {
  const { getLocalDate } = useTimezone();
  const [viewMonth, setViewMonth] = useState(() => {
    const d = parseDateOnly(selectedDate);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [bookedDays, setBookedDays] = useState<Set<string>>(new Set());
  const [isOpen, setIsOpen] = useState(false);

  // Clear booking dots when room changes (prevents stale data from previous room)
  useEffect(() => {
    setBookedDays(new Set());
  }, [roomId]);

  useEffect(() => {
    const d = parseDateOnly(selectedDate);
    setViewMonth({ year: d.getFullYear(), month: d.getMonth() });
  }, [selectedDate]);

  // Fetch bookings for the month to determine which days have bookings
  useEffect(() => {
    if (!roomId || !isOpen) return;

    const startOfMonth = new Date(viewMonth.year, viewMonth.month, 1);
    const endOfMonth = new Date(viewMonth.year, viewMonth.month + 1, 0);

    const startStr = formatDateOnly(startOfMonth);
    const endStr = formatDateOnly(endOfMonth);

    api.getBookings({
      room_id: roomId,
      start_date: startStr,
      end_date: endStr,
    }).then((bookings: any[]) => {
      const days = new Set<string>();
      // Filter out cancelled/no_show bookings, include confirmed and pending
      const activeBookings = bookings.filter((b: any) =>
        b.status === 'confirmed' || b.status === 'pending'
      );
      activeBookings.forEach(b => {
        // Mark the day of the booking using app timezone
        const localDateStr = getLocalDate(b.start_time);
        days.add(localDateStr);
      });
      setBookedDays(days);
    }).catch(() => {});
  }, [roomId, viewMonth, isOpen]);

  const getDaysInMonth = () => {
    const firstDay = new Date(viewMonth.year, viewMonth.month, 1);
    const lastDay = new Date(viewMonth.year, viewMonth.month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startDayOfWeek = firstDay.getDay();

    const days: (number | null)[] = [];

    // Add empty cells for days before the first of the month
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }

    // Add the days of the month
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i);
    }

    return days;
  };

  const formatMonthYear = () => {
    return new Date(viewMonth.year, viewMonth.month).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  };

  const changeMonth = (delta: number) => {
    setViewMonth(prev => {
      let newMonth = prev.month + delta;
      let newYear = prev.year;
      if (newMonth < 0) {
        newMonth = 11;
        newYear--;
      } else if (newMonth > 11) {
        newMonth = 0;
        newYear++;
      }
      return { year: newYear, month: newMonth };
    });
  };

  const handleDayClick = (day: number) => {
    const dateStr = `${viewMonth.year}-${String(viewMonth.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    onSelectDate(dateStr);
    setIsOpen(false);
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = getDaysInMonth();
  const weekDays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  return (
    <div className="mini-calendar-container">
      <button
        className="mini-calendar-trigger input"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
        aria-label="Choose date"
      >
        <CalendarDays className="trigger-calendar-icon" size={16} />
        <span>{parseDateOnly(selectedDate).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric'
        })}</span>
        <span className="trigger-icon">{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>

      {isOpen && (
        <div className="mini-calendar-dropdown">
          <div className="mini-calendar-header">
            <button className="mini-nav-btn" onClick={() => changeMonth(-1)} type="button" aria-label="Previous month"><ChevronLeft size={15} /></button>
            <span className="mini-month-label">{formatMonthYear()}</span>
            <button className="mini-nav-btn" onClick={() => changeMonth(1)} type="button" aria-label="Next month"><ChevronRight size={15} /></button>
          </div>

          <div className="mini-calendar-weekdays">
            {weekDays.map(d => (
              <div key={d} className="mini-weekday">{d}</div>
            ))}
          </div>

          <div className="mini-calendar-grid">
            {days.map((day, i) => {
              if (day === null) {
                return <div key={`empty-${i}`} className="mini-day empty" />;
              }

              const dateStr = `${viewMonth.year}-${String(viewMonth.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const isSelected = selectedDate === dateStr;
              const isToday = today.getFullYear() === viewMonth.year &&
                              today.getMonth() === viewMonth.month &&
                              today.getDate() === day;
              const hasBooking = bookedDays.has(dateStr);

              return (
                <button
                  key={day}
                  className={`mini-day ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${hasBooking ? 'has-booking' : ''}`}
                  onClick={() => handleDayClick(day)}
                  type="button"
                >
                  {day}
                  {hasBooking && <span className="booking-dot" />}
                </button>
              );
            })}
          </div>

          <div className="mini-calendar-legend">
            <span className="legend-item">
              <span className="booking-dot" /> Has bookings
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
