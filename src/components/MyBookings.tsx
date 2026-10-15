import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarDays, ChevronRight, Clock3, MapPin } from 'lucide-react';
import { api } from '../config/api';
import { useNotification } from '../contexts/NotificationContext';
import { useAuth } from '../contexts/AuthContext';
import { useTimezone } from '../contexts/TimezoneContext';
import { ViewBookingModal } from './ViewBookingModal';
import { Room } from '../types';
import '../styles/MyBookings.css';

interface Booking {
  id: number;
  room_id: number;
  user_id: number;
  title: string;
  start_time: string;
  end_time: string;
  equipment?: string | string[];
  notes?: string;
  status: string;
  room_name?: string;
  room_building?: string;
  organizer_name?: string;
  organizer_email?: string;
}

export const MyBookings = () => {
  const [upcomingBookings, setUpcomingBookings] = useState<Booking[]>([]);
  const [pastBookings, setPastBookings] = useState<Booking[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [showViewModal, setShowViewModal] = useState(false);
  const notify = useNotification();
  const { user } = useAuth();
  const { formatDate, formatTime, getLocalDate } = useTimezone();
  const navigate = useNavigate();

  const fetchBookings = async () => {
    try {
      const [upcoming, history] = await Promise.all([
        api.getMyBookings({ scope: 'upcoming' }),
        api.getMyBookings({ scope: 'history', limit: 10, offset: 0 }),
      ]);
      setUpcomingBookings(upcoming.bookings || []);
      setPastBookings(history.bookings || []);
      setHistoryTotal(Number(history.total || 0));
    } catch (err: any) {
      notify.error(err.message || 'Failed to load bookings');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreHistory = async () => {
    setHistoryLoading(true);
    try {
      const history = await api.getMyBookings({ scope: 'history', limit: 10, offset: pastBookings.length });
      setPastBookings(current => [...current, ...(history.bookings || [])]);
      setHistoryTotal(Number(history.total || 0));
    } catch (err: any) {
      notify.error(err.message || 'Failed to load more booking history');
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchRooms = async () => {
    try {
      const data = await api.getRooms();
      setRooms(data.map((r: any) => ({
        ...r,
        equipment: typeof r.equipment === 'string' ? JSON.parse(r.equipment) : (r.equipment || []),
      })));
    } catch (err) {
      // Rooms are needed for the modal
    }
  };

  useEffect(() => {
    fetchBookings();
    fetchRooms();
  }, []);

  const handleBookingClick = (booking: Booking) => {
    setSelectedBooking(booking);
    setShowViewModal(true);
  };

  const handleModalClose = () => {
    setShowViewModal(false);
    setSelectedBooking(null);
  };

  const handleBookingUpdate = () => {
    setShowViewModal(false);
    setSelectedBooking(null);
    fetchBookings();
  };

  const isToday = (dateStr: string) => {
    return getLocalDate(dateStr) === getLocalDate(new Date());
  };

  const getSelectedRoom = () => {
    if (!selectedBooking) return null;
    return rooms.find(r => r.id === selectedBooking.room_id) || {
      id: selectedBooking.room_id,
      name: selectedBooking.room_name || 'Unknown Room',
      building: selectedBooking.room_building || '',
      floor: 1,
      capacity: 0,
      equipment: [],
      image_url: null,
      is_active: 1,
    };
  };

  if (loading) {
    return (
      <div className="my-bookings">
        <div className="loading"><span className="loading-indicator" />Loading your bookings…</div>
      </div>
    );
  }

  return (
    <div className="my-bookings">
      <header className="bookings-page-header">
        <div className="bookings-heading-copy">
          <span className="eyebrow">Reservations</span>
          <h1>My Bookings</h1>
          <p className="page-flow">Review upcoming reservations and open any booking to edit, cancel, or check details.</p>
        </div>
        {(upcomingBookings.length > 0 || historyTotal > 0) && (
          <div className="bookings-summary" aria-label={`${upcomingBookings.length} upcoming bookings`}>
            <strong>{upcomingBookings.length}</strong><span>upcoming</span>
          </div>
        )}
      </header>

      {upcomingBookings.length === 0 && historyTotal === 0 ? (
        <div className="no-bookings card">
          <div className="no-bookings-icon"><CalendarDays size={26} /></div>
          <h2>No bookings yet</h2>
          <p>You haven’t reserved a room. Open the calendar to find an available time.</p>
          <button className="btn btn-primary" onClick={() => navigate('/calendar')}>Open Calendar <ArrowRight size={16} /></button>
        </div>
      ) : (
        <>
          {upcomingBookings.length > 0 && (
            <div className="bookings-section">
              <h3 className="section-title">Upcoming ({upcomingBookings.length})</h3>
              <div className="bookings-list">
                {upcomingBookings.map(booking => (
                  <button
                    key={booking.id}
                    className={`booking-card card ${isToday(booking.start_time) ? 'today' : ''}`}
                    type="button"
                    onClick={() => handleBookingClick(booking)}
                  >
                    <div className="booking-date-col">
                      <span className="booking-day">
                        {formatDate(booking.start_time, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                      {isToday(booking.start_time) && <span className="today-badge">Today</span>}
                    </div>
                    <div className="booking-details">
                      <div className="booking-title">{booking.title}</div>
                      <div className="booking-meta subtle">
                        <span className="room-name"><MapPin size={13} />{booking.room_name}</span>
                        <span className="time"><Clock3 size={13} />
                          {formatTime(booking.start_time, { hour: 'numeric', minute: '2-digit', hour12: true })} - {formatTime(booking.end_time, { hour: 'numeric', minute: '2-digit', hour12: true })}
                        </span>
                      </div>
                    </div>
                    <div className="booking-status">
                      <span className={`status-badge ${booking.status}`}>
                        {booking.status === 'confirmed' ? 'Confirmed' : booking.status}
                      </span>
                      <ChevronRight className="booking-row-arrow" size={17} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {pastBookings.length > 0 && (
            <div className="bookings-section past">
              <h3 className="section-title">Past ({historyTotal})</h3>
              <div className="bookings-list">
                {pastBookings.map(booking => (
                  <button
                    key={booking.id}
                    className="booking-card card past"
                    type="button"
                    onClick={() => handleBookingClick(booking)}
                  >
                    <div className="booking-date-col">
                      <span className="booking-day">
                        {formatDate(booking.start_time, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                    <div className="booking-details">
                      <div className="booking-title">{booking.title}</div>
                      <div className="booking-meta subtle">
                        <span className="room-name"><MapPin size={13} />{booking.room_name}</span>
                        <span className="time"><Clock3 size={13} />
                          {formatTime(booking.start_time, { hour: 'numeric', minute: '2-digit', hour12: true })} - {formatTime(booking.end_time, { hour: 'numeric', minute: '2-digit', hour12: true })}
                        </span>
                      </div>
                    </div>
                    <div className="booking-status">
                      <span className={`status-badge ${booking.status}`}>
                        {booking.status === 'confirmed' ? 'Completed' : booking.status}
                      </span>
                      <ChevronRight className="booking-row-arrow" size={17} />
                    </div>
                  </button>
                ))}
                {pastBookings.length < historyTotal && (
                  <button className="btn btn-secondary more-bookings" type="button" onClick={loadMoreHistory} disabled={historyLoading}>
                    {historyLoading ? 'Loading…' : `Load more (${historyTotal - pastBookings.length} remaining)`}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {showViewModal && selectedBooking && getSelectedRoom() && (
        <ViewBookingModal
          booking={{
            ...selectedBooking,
            organizer_name: user?.name,
            organizer_email: user?.email,
          }}
          room={getSelectedRoom()!}
          onClose={handleModalClose}
          onUpdate={handleBookingUpdate}
        />
      )}
    </div>
  );
};
