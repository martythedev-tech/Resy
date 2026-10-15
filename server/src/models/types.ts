export interface User {
  id: number;
  email: string;
  password_hash?: string;
  name: string;
  role: 'user' | 'admin' | 'room_manager' | 'report_viewer';
  department?: string;
  is_active: boolean;
  receives_admin_notifications?: boolean;
  no_show_count: number;
  suspension_until?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Room {
  id: number;
  name: string;
  building: string;
  floor: number;
  capacity: number;
  equipment: string[];
  buffer_minutes?: number | null;
  business_hours?: any;
  min_duration_minutes?: number | null;
  max_duration_minutes?: number | null;
  is_active: boolean;
  requires_approval: boolean;
  map_coordinates?: { x: number; y: number };
  created_at: Date;
  updated_at: Date;
}

export interface Booking {
  id: number;
  room_id: number;
  user_id: number | null;
  organizer_department?: string | null;
  title: string;
  start_time: Date;
  end_time: Date;
  attendees: string[];
  attendee_count?: number | null;
  equipment: string[];
  notes?: string;
  custom_fields?: Record<string, any>;
  status: 'confirmed' | 'pending' | 'cancelled' | 'no_show';
  is_recurring: boolean;
  recurrence_id?: number;
  approved_by?: number;
  cancelled_at?: Date;
  cancellation_reason?: string;
  anonymized_at?: Date;
  retention_hold?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BookingRule {
  id: number;
  rule_type: string;
  value: number;
  unit: string;
  description: string;
  is_enabled: boolean;
  applies_to_roles?: string[];
  created_at: Date;
  updated_at: Date;
}

export interface Holiday {
  id: number;
  name: string;
  date: Date;
  is_recurring: boolean;
  created_by: number;
  created_at: Date;
}

export interface MaintenanceWindow {
  id: number;
  room_id: number;
  start_time: Date;
  end_time: Date;
  reason: string;
  created_by: number;
  created_at: Date;
}

export interface CheckIn {
  id: number;
  booking_id: number;
  checked_in_at: Date;
  checked_in_by: number;
}

export interface BookingRecurrence {
  id: number;
  original_booking_id: number;
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  days_of_week?: number[];
  end_date?: Date;
  max_occurrences?: number;
  created_at: Date;
}
