import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../config/api';

interface TimezoneContextType {
  timezone: string;
  setTimezone: (tz: string) => void;
  formatTime: (date: Date | string, options?: Intl.DateTimeFormatOptions) => string;
  formatDate: (date: Date | string, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (date: Date | string) => string;
  getLocalHour: (date: Date | string) => number;
  getLocalDate: (date: Date | string) => string; // Returns YYYY-MM-DD in app timezone
}

const TimezoneContext = createContext<TimezoneContextType | undefined>(undefined);

// List of supported timezones (must match backend)
export const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
];

export const TimezoneProvider = ({ children }: { children: ReactNode }) => {
  const [timezone, setTimezone] = useState('America/Chicago'); // Default to Central

  // Fetch timezone from site config on mount
  useEffect(() => {
    api.getBranding()
      .then((config: any) => {
        if (config.timezone) {
          setTimezone(config.timezone);
        }
      })
      .catch(() => {
        // Keep default if fetch fails
      });
  }, []);

  // Format time in app timezone (e.g., "2:30 PM")
  const formatTime = (date: Date | string, options?: Intl.DateTimeFormatOptions): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      ...options,
    });
  };

  // Format date in app timezone (e.g., "Feb 6, 2026")
  const formatDate = (date: Date | string, options?: Intl.DateTimeFormatOptions): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleDateString('en-US', {
      timeZone: timezone,
      ...(options || { month: 'short', day: 'numeric', year: 'numeric' }),
    });
  };

  // Format full date and time in app timezone
  const formatDateTime = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Get the hour (0-23) in app timezone
  const getLocalHour = (date: Date | string): number => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(d);
    const hourPart = parts.find(p => p.type === 'hour');
    return hourPart ? parseInt(hourPart.value, 10) : 0;
  };

  // Get date string (YYYY-MM-DD) in app timezone
  const getLocalDate = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const parts = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD format
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    return parts;
  };

  return (
    <TimezoneContext.Provider
      value={{
        timezone,
        setTimezone,
        formatTime,
        formatDate,
        formatDateTime,
        getLocalHour,
        getLocalDate,
      }}
    >
      {children}
    </TimezoneContext.Provider>
  );
};

export const useTimezone = () => {
  const context = useContext(TimezoneContext);
  if (!context) {
    throw new Error('useTimezone must be used within a TimezoneProvider');
  }
  return context;
};
