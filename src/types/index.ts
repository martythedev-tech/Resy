export interface BusinessHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BusinessHours {
  days: Record<string, BusinessHoursDay>;
}

export interface Building {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  business_hours?: BusinessHours | null;
  is_active: number;
}

export interface Room {
  id: number;
  name: string;
  building: string;
  capacity: number;
  equipment: string[];
  floor: number;
  image_url: string | null;
  requires_approval?: number;
  business_hours?: BusinessHours | null;
  building_hours?: BusinessHours | null;
  min_duration_minutes?: number | null;
  max_duration_minutes?: number | null;
  buffer_minutes?: number | null;
  is_active: number;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin' | 'room_manager' | 'report_viewer';
  must_reset_password?: number;
}

export type Theme = 'light' | 'dark';

export interface ThemeColors {
  bg: string;
  panel: string;
  card: string;
  text: string;
  muted: string;
  primary: string;
  primaryHover: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
}
