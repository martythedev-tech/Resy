import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  Ban, BriefcaseBusiness, Building2, CalendarCheck2, CalendarClock, CalendarRange, CheckCircle2,
  Clock3, DoorOpen, Gauge, Grid3X3, Hourglass, MonitorUp, MoonStar, Palette, Repeat2,
  ScanLine, SlidersHorizontal, TimerReset, UserMinus, Users,
  type LucideIcon,
} from 'lucide-react';
import { api, getApiOrigin } from '../config/api';
import { useTheme } from '../contexts/ThemeContext';
import { applyBrandingToDocument, resolveBrandAssetUrl } from '../utils/branding';
import { useNotification } from '../contexts/NotificationContext';
import { TIMEZONES } from '../contexts/TimezoneContext';
import { Building, Room, BusinessHours, BusinessHoursDay } from '../types';
import { AdminActionDialog, AdminDialogState } from './admin/AdminActionDialog';
import { AdminDiagnostics } from './admin/AdminDiagnostics';
import { AdminRetention } from './admin/AdminRetention';
import { AdminReports } from './admin/AdminReports';
import '../styles/AdminPanel.css';

const API_BASE = getApiOrigin();
const APP_VERSION = __APP_VERSION__;
const BUILD_ID = __BUILD_ID__;
const RELEASE_CHANNEL = __RELEASE_CHANNEL__;

interface NewRoomForm {
  name: string;
  building: string;
  floor: number;
  capacity: number;
  equipment: string[];
  min_duration_minutes: number | null;
  max_duration_minutes: number | null;
  buffer_minutes: number | null;
  requires_approval: number;
}

interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  department: string | null;
  is_active: number;
  receives_admin_notifications: number;
  must_reset_password?: number;
  no_show_count: number;
  created_at: string;
}

interface DirectoryStatus {
  enabled: boolean;
  configured: boolean;
  config_source: 'application' | 'environment';
  directory_type: 'ad' | 'ldap';
  server_url: string;
  base_dn: string;
  bind_dn: string;
  has_bind_password: boolean;
  ca_cert_path: string;
  tls_reject_unauthorized: boolean;
  allow_insecure_ldap: boolean;
  allow_local_fallback: boolean;
  sync_roles: boolean;
  sync_profile: boolean;
  allowed_groups: string[];
  admin_groups: string[];
  room_manager_groups: string[];
  timeout_ms: number;
  connect_timeout_ms: number;
  auth_source: 'local' | 'directory';
}

interface DirectoryForm {
  enabled: boolean;
  directory_type: 'ad' | 'ldap';
  server_url: string;
  base_dn: string;
  bind_dn: string;
  bind_password: string;
  ca_cert_path: string;
  tls_reject_unauthorized: boolean;
  allow_insecure_ldap: boolean;
  allow_local_fallback: boolean;
  sync_roles: boolean;
  sync_profile: boolean;
  allowed_groups: string;
  admin_groups: string;
  room_manager_groups: string;
  timeout_ms: number;
  connect_timeout_ms: number;
}

const EMPTY_DIRECTORY_FORM: DirectoryForm = {
  enabled: false,
  directory_type: 'ad',
  server_url: '',
  base_dn: '',
  bind_dn: '',
  bind_password: '',
  ca_cert_path: '/app/certs',
  tls_reject_unauthorized: true,
  allow_insecure_ldap: false,
  allow_local_fallback: true,
  sync_roles: true,
  sync_profile: true,
  allowed_groups: '',
  admin_groups: '',
  room_manager_groups: '',
  timeout_ms: 8000,
  connect_timeout_ms: 5000,
};

type CalendarDefaultView = 'day' | 'week' | 'month';

type AdminSection = 'buildings' | 'rooms' | 'hours' | 'technology' | 'rules' | 'approvals' | 'reports' | 'branding' | 'notifications' | 'directory' | 'users' | 'retention' | 'diagnostics';

const ADMIN_SECTION_META: Record<AdminSection, { title: string; description: string }> = {
  buildings: { title: 'Buildings', description: 'Create and manage buildings that contain conference rooms.' },
  rooms: { title: 'Rooms', description: 'Create rooms, tune room-level limits, and set approval requirements.' },
  hours: { title: 'Business Hours', description: 'Define building defaults and optional room-level overrides.' },
  technology: { title: 'Technology', description: 'Manage shared equipment options for rooms and booking forms.' },
  rules: { title: 'Booking Rules', description: 'Configure guardrails that control booking behavior across the app.' },
  approvals: { title: 'After-Hours Approvals', description: 'Review and process pending approvals for restricted rooms.' },
  reports: { title: 'Reports', description: 'Turn booking history into room, attendance, and technology planning insights.' },
  branding: { title: 'Branding', description: 'Customize company branding, timezone, and custom booking fields.' },
  notifications: { title: 'Notification Delivery', description: 'Choose email, webhooks, or both, and configure how booking updates are delivered.' },
  directory: { title: 'Directory Integration', description: 'Configure LDAP/Active Directory settings and review current directory status.' },
  users: { title: 'Users', description: 'Manage local users, roles, activation, and password reset behavior.' },
  retention: { title: 'Data Retention', description: 'Preview, configure, and safely anonymize expired booking records.' },
  diagnostics: { title: 'System Diagnostics', description: 'Monitor service health and search sanitized operational events.' },
};

const RULE_META: Record<string, { label: string; icon: LucideIcon; description: string; allowedUnits: string[]; group: string }> = {
  max_duration:            { label: 'Maximum booking length', icon: Clock3, group: 'Time and scheduling', allowedUnits: ['minutes', 'hours', 'days'], description: 'Longest duration permitted for a single booking.' },
  buffer_time:             { label: 'Buffer between bookings', icon: TimerReset, group: 'Time and scheduling', allowedUnits: ['minutes'], description: 'Required reset time between consecutive bookings.' },
  advance_window:          { label: 'Advance window for users', icon: CalendarRange, group: 'Time and scheduling', allowedUnits: ['days', 'weeks'], description: 'How far ahead standard users may reserve a room.' },
  advance_window_privileged: { label: 'Advance window for managers', icon: CalendarClock, group: 'Time and scheduling', allowedUnits: ['days', 'weeks'], description: 'How far ahead administrators and room managers may book.' },
  min_lead_time:           { label: 'Minimum lead time', icon: Hourglass, group: 'Time and scheduling', allowedUnits: ['minutes', 'hours'], description: 'Minimum notice required before a booking can start.' },
  booking_interval:        { label: 'Booking interval', icon: Grid3X3, group: 'Time and scheduling', allowedUnits: ['minutes'], description: 'Permitted start-time increments on the calendar.' },
  recurrence_limit:        { label: 'Recurring series limit', icon: Repeat2, group: 'Time and scheduling', allowedUnits: ['months'], description: 'Maximum time span allowed for a recurring series.' },
  daily_limit:             { label: 'Daily time limit', icon: Gauge, group: 'Usage limits', allowedUnits: ['hours'], description: 'Maximum total room time a user may book each day.' },
  max_concurrent_bookings: { label: 'Upcoming booking limit', icon: CalendarCheck2, group: 'Usage limits', allowedUnits: ['count'], description: 'Maximum number of active upcoming bookings per user.' },
  max_bookings_per_room_per_day: { label: 'Room daily booking limit', icon: BriefcaseBusiness, group: 'Usage limits', allowedUnits: ['count'], description: 'Maximum number of bookings a room can accept per day.' },
  no_show_limit:           { label: 'No-show suspension threshold', icon: UserMinus, group: 'Usage limits', allowedUnits: ['count'], description: 'Number of no-shows allowed before account suspension.' },
  check_in_grace:          { label: 'Check-in grace period', icon: ScanLine, group: 'Attendance and access', allowedUnits: ['minutes'], description: 'Time available to check in before automatic cancellation.' },
  min_cancel_notice:       { label: 'Cancellation notice', icon: Ban, group: 'Attendance and access', allowedUnits: ['minutes', 'hours'], description: 'Minimum notice required when cancelling a booking.' },
  capacity_warning:        { label: 'Capacity warning', icon: Users, group: 'Room experience', allowedUnits: [], description: 'Warn when attendee count exceeds room capacity without blocking submission.' },
  show_equipment:          { label: 'Technology filters', icon: MonitorUp, group: 'Room experience', allowedUnits: [], description: 'Show room technology tags and filters throughout the workspace.' },
  business_hours:          { label: 'Business-hour enforcement', icon: BriefcaseBusiness, group: 'Room experience', allowedUnits: [], description: 'Apply configured business hours to room availability.' },
  room_duration_limits:    { label: 'Room-specific duration limits', icon: SlidersHorizontal, group: 'Room experience', allowedUnits: [], description: 'Apply the minimum and maximum durations configured on each room.' },
  after_hours_roles:       { label: 'After-hours role restriction', icon: MoonStar, group: 'Attendance and access', allowedUnits: [], description: 'Restrict after-hours booking to administrators and room managers.' },
};

const RULE_GROUPS = ['Time and scheduling', 'Usage limits', 'Attendance and access', 'Room experience'];

const BRAND_PRESETS = [
  { name: 'Indigo + teal', primary: '#4F46E5', accent: '#14B8A6' },
  { name: 'Navy + blue', primary: '#1E3A8A', accent: '#0EA5E9' },
  { name: 'Forest + gold', primary: '#166534', accent: '#CA8A04' },
  { name: 'Plum + rose', primary: '#7E22CE', accent: '#E11D48' },
  { name: 'Slate + cyan', primary: '#334155', accent: '#0891B2' },
];

type CustomFieldType = 'text' | 'select' | 'checkbox';

interface CustomFieldConfig {
  id: string;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  helpText?: string;
}

const buildDefaultBusinessHours = (): BusinessHours => ({
  days: {
    '0': { enabled: false, start: '08:00', end: '18:00' },
    '1': { enabled: true, start: '08:00', end: '18:00' },
    '2': { enabled: true, start: '08:00', end: '18:00' },
    '3': { enabled: true, start: '08:00', end: '18:00' },
    '4': { enabled: true, start: '08:00', end: '18:00' },
    '5': { enabled: true, start: '08:00', end: '18:00' },
    '6': { enabled: false, start: '08:00', end: '18:00' },
  },
});

const normalizeBusinessHours = (raw: any): BusinessHours | null => {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.days) return parsed;
    } catch {
      return null;
    }
  }
  if (raw?.days) return raw;
  return null;
};

const normalizeCustomFields = (raw: any): CustomFieldConfig[] => {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
};

const BUSINESS_DAYS: { key: string; label: string }[] = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
];

const BusinessHoursEditor = ({
  value,
  onChange,
}: {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
}) => {
  const updateDay = (dayKey: string, updates: Partial<BusinessHoursDay>) => {
    const next = {
      ...value,
      days: {
        ...value.days,
        [dayKey]: {
          ...(value.days?.[dayKey] || { enabled: false, start: '08:00', end: '18:00' }),
          ...updates,
        },
      },
    };
    onChange(next);
  };

  return (
    <div className="business-hours-grid">
      <div className="business-hours-header" aria-hidden="true">
        <span>Day</span>
        <span>Available hours</span>
        <span>Status</span>
      </div>
      {BUSINESS_DAYS.map(day => {
        const dayConfig = value.days?.[day.key] || { enabled: false, start: '08:00', end: '18:00' };
        return (
          <div key={day.key} className="business-hours-row">
            <label className="day-toggle">
              <input
                type="checkbox"
                checked={!!dayConfig.enabled}
                onChange={(e) => updateDay(day.key, { enabled: e.target.checked })}
              />
              <span>{day.label}</span>
            </label>
            <div className="day-time-inputs">
              <input
                type="time"
                className="input"
                value={dayConfig.start || '08:00'}
                disabled={!dayConfig.enabled}
                onChange={(e) => updateDay(day.key, { start: e.target.value })}
              />
              <span className="day-time-sep">to</span>
              <input
                type="time"
                className="input"
                value={dayConfig.end || '18:00'}
                disabled={!dayConfig.enabled}
                onChange={(e) => updateDay(day.key, { end: e.target.value })}
              />
            </div>
            <span className={`day-status ${dayConfig.enabled ? 'open' : ''}`}>
              {dayConfig.enabled ? 'Open' : 'Closed'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export const AdminPanel = () => {
  const { theme } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('s') || 'buildings';
  const normalizedTab = requestedTab === 'email' || requestedTab === 'webhooks'
    ? 'notifications'
    : requestedTab;
  const tab: AdminSection = normalizedTab in ADMIN_SECTION_META ? normalizedTab as AdminSection : 'buildings';
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const { success, error } = useNotification();
  const [newUser, setNewUser] = useState({
    name: '',
    email: '',
    department: '',
    role: 'user',
    password: '',
    requirePasswordReset: true,
    receivesAdminNotifications: false,
  });
  const [userSearch, setUserSearch] = useState('');
  const sectionMeta = ADMIN_SECTION_META[tab];
  const channelLabel = RELEASE_CHANNEL === 'release' ? 'release' : 'dev';
  const buildLabel = `v${APP_VERSION} [${channelLabel}] (${BUILD_ID})`;

  // Building form
  const [newBuilding, setNewBuilding] = useState({
    name: '',
    description: '',
  });
  const [editingBuilding, setEditingBuilding] = useState<Building | null>(null);

  // Room form
  const [newRoom, setNewRoom] = useState<NewRoomForm>({
    name: '',
    building: '',
    floor: 1,
    capacity: 8,
    equipment: [] as string[],
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    buffer_minutes: 15,
    requires_approval: 0,
  });
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [hoursBuildingId, setHoursBuildingId] = useState<number | null>(null);
  const [hoursRoomId, setHoursRoomId] = useState<number | null>(null);
  const [hoursBuildingDraft, setHoursBuildingDraft] = useState<BusinessHours>(buildDefaultBusinessHours());
  const [hoursRoomDraft, setHoursRoomDraft] = useState<BusinessHours>(buildDefaultBusinessHours());
  const [hoursRoomOverride, setHoursRoomOverride] = useState(false);
  const [hoursBuildingEnabled, setHoursBuildingEnabled] = useState(true);

  // Email config state
  const [emailConfig, setEmailConfig] = useState({
    smtp_host: '', smtp_port: 587, smtp_user: '', smtp_password: '',
    from_email: '', from_name: 'Resy', is_enabled: 0,
  });
  const [emailTestTo, setEmailTestTo] = useState('');
  const [emailTestLoading, setEmailTestLoading] = useState(false);

  // Webhook state
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [newWebhook, setNewWebhook] = useState({ service_type: 'slack', webhook_url: '', events: ['booking_created'] });
  const [editingWebhook, setEditingWebhook] = useState<any | null>(null);
  const [webhookPolicy, setWebhookPolicy] = useState({
    allow_internal_destinations: false,
    allowed_internal_origins: [] as string[],
  });
  const [internalOriginInput, setInternalOriginInput] = useState('');
  const [webhookPolicySaving, setWebhookPolicySaving] = useState(false);
  const [notificationRecipientSearch, setNotificationRecipientSearch] = useState('');

  // Rules state
  const [rules, setRules] = useState<any[]>([]);
  const [pendingBookings, setPendingBookings] = useState<any[]>([]);

  // Branding state
  const [siteConfig, setSiteConfig] = useState({
    company_name: 'Resy',
    logo_url: '',
    primary_color: '#4F46E5',
    accent_color: '#14B8A6',
    brand_tagline: 'Room booking',
    logo_size: 'medium' as 'small' | 'medium' | 'large',
    favicon_url: '',
    timezone: 'America/Chicago',
    calendar_default_view: 'day' as CalendarDefaultView,
    equipment_options: [] as string[],
    custom_fields: [] as CustomFieldConfig[],
  });
  const [equipmentOptionsInput, setEquipmentOptionsInput] = useState('');
  const [equipmentMenuOpen, setEquipmentMenuOpen] = useState<null | { mode: 'create' | 'edit'; roomId?: number }>(null);
  const [equipmentMenuRect, setEquipmentMenuRect] = useState<{ top: number; left: number; width: number; maxHeight: number; placement: 'above' | 'below'; bottom: number } | null>(null);
  const [equipmentMenuAnchor, setEquipmentMenuAnchor] = useState<HTMLElement | null>(null);
  const equipmentMenuRef = useRef<HTMLDivElement>(null);
  const [directoryStatus, setDirectoryStatus] = useState<DirectoryStatus | null>(null);
  const [directoryForm, setDirectoryForm] = useState<DirectoryForm>(EMPTY_DIRECTORY_FORM);
  const [directoryTestLoading, setDirectoryTestLoading] = useState(false);
  const [directorySaveLoading, setDirectorySaveLoading] = useState(false);
  const [adminDialog, setAdminDialog] = useState<AdminDialogState | null>(null);
  const [adminDialogValue, setAdminDialogValue] = useState('');
  const [adminDialogLoading, setAdminDialogLoading] = useState(false);

  const openAdminDialog = (dialog: AdminDialogState) => {
    setAdminDialogValue('');
    setAdminDialog(dialog);
  };

  const confirmAdminDialog = async () => {
    if (!adminDialog) return;
    if (adminDialog.input?.required && !adminDialogValue.trim()) {
      error(`${adminDialog.input.label} is required`);
      return;
    }
    setAdminDialogLoading(true);
    try {
      const result = await adminDialog.onConfirm(adminDialogValue.trim());
      if (result !== false) setAdminDialog(null);
    } finally {
      setAdminDialogLoading(false);
    }
  };

  const getAnchorRect = (anchor: HTMLElement | null) => {
    try {
      return anchor?.getBoundingClientRect?.() ?? null;
    } catch {
      return null;
    }
  };

  const closeEquipmentMenu = () => {
    setEquipmentMenuOpen(null);
    setEquipmentMenuAnchor(null);
    setEquipmentMenuRect(null);
  };

  const openEquipmentMenu = (anchor: HTMLElement | null, mode: 'create' | 'edit', roomId?: number) => {
    if (!anchor) return;
    const rect = getAnchorRect(anchor);
    if (!rect) return;
    setEquipmentMenuAnchor(anchor);
    setEquipmentMenuRect(buildMenuRect(rect));
    setEquipmentMenuOpen({ mode, roomId });
  };

  const buildMenuRect = (rect: DOMRect) => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - 16);
    const spaceAbove = Math.max(0, rect.top - 16);
    const placement: 'above' | 'below' = spaceBelow < 240 && spaceAbove > spaceBelow ? 'above' : 'below';
    const maxHeight = placement === 'above' ? spaceAbove : spaceBelow;
    return {
      top: rect.bottom + 8,
      left: rect.left,
      width: rect.width,
      maxHeight,
      placement,
      bottom: viewportHeight - rect.top + 8,
    };
  };

  const equipmentOptions = siteConfig.equipment_options || [];
  const hasBuildings = buildings.length > 0;
  const hasRooms = rooms.length > 0;
  const hasEquipmentOptions = equipmentOptions.length > 0;
  const isSpacesSetupComplete = hasBuildings && hasRooms && hasEquipmentOptions;

  const goToAdminSection = (section: AdminSection) => {
    setSearchParams({ s: section });
  };

  const fetchBuildings = async () => {
    try {
      const data = await api.getBuildings();
      setBuildings(data.map((b: any) => ({
        ...b,
        business_hours: normalizeBusinessHours(b.business_hours),
      })));
    } catch (e) {
      error('Failed to load buildings');
    }
  };

  const fetchRooms = async () => {
    try {
      const data = await api.getAdminRooms();
      setRooms(data.map((r: any) => ({
        ...r,
        equipment: typeof r.equipment === 'string' ? JSON.parse(r.equipment) : (r.equipment || []),
        business_hours: normalizeBusinessHours(r.business_hours),
        min_duration_minutes: r.min_duration_minutes ?? null,
        max_duration_minutes: r.max_duration_minutes ?? null,
        buffer_minutes: r.buffer_minutes ?? 15,
        requires_approval: r.requires_approval ?? 0,
      })));
    } catch (e) {
      error('Failed to load rooms');
    }
  };

  const fetchWebhooks = async () => {
    try {
      const data = await api.getWebhooks();
      setWebhooks(data.map((w: any) => ({
        ...w,
        events: typeof w.events === 'string' ? JSON.parse(w.events) : (w.events || []),
      })));
    } catch (e) {
      error('Failed to load webhooks');
    }
  };

  const fetchWebhookPolicy = async () => {
    try {
      const data = await api.getWebhookPolicy();
      const origins = Array.isArray(data.allowed_internal_origins) ? data.allowed_internal_origins : [];
      setWebhookPolicy({
        allow_internal_destinations: !!data.allow_internal_destinations,
        allowed_internal_origins: origins,
      });
      setInternalOriginInput(origins.join('\n'));
    } catch (e) {
      error('Failed to load internal webhook policy');
    }
  };

  const fetchEmailConfig = async () => {
    try {
      const data = await api.getEmailConfig();
      setEmailConfig(data);
    } catch (e) {
      error('Failed to load email config');
    }
  };

  const fetchRules = async () => {
    try {
      const data = await api.getBookingRules();
      setRules(data);
    } catch (e) {
      error('Failed to load rules');
    }
  };

  const fetchPendingBookings = async () => {
    try {
      const data = await api.getPendingBookings();
      setPendingBookings(data);
    } catch (e) {
      error('Failed to load pending approvals');
    }
  };

  const fetchSiteConfig = async () => {
    try {
      const data = await api.getSiteConfig();
      const options = (() => {
        if (Array.isArray(data.equipment_options)) return data.equipment_options;
        if (typeof data.equipment_options === 'string') {
          try { return JSON.parse(data.equipment_options); } catch { return []; }
        }
        return [];
      })();
      const customFields = normalizeCustomFields(data.custom_fields);
      const calendarDefaultView: CalendarDefaultView = data.calendar_default_view === 'week' || data.calendar_default_view === 'month'
        ? data.calendar_default_view
        : 'day';
      setSiteConfig({
        ...data,
        logo_url: typeof data.logo_url === 'string' ? data.logo_url : '',
        favicon_url: typeof data.favicon_url === 'string' ? data.favicon_url : '',
        calendar_default_view: calendarDefaultView,
        equipment_options: options,
        custom_fields: customFields,
      });
      setEquipmentOptionsInput(options.join('\n'));
      applyBrandingToDocument({
        company_name: data.company_name,
        primary_color: data.primary_color,
        accent_color: data.accent_color,
        brand_tagline: data.brand_tagline,
        logo_size: data.logo_size,
        logo_url: resolveBrandAssetUrl(data.logo_url, API_BASE),
        favicon_url: resolveBrandAssetUrl(data.favicon_url, API_BASE),
      }, { theme });
    } catch (e) {
      error('Failed to load site config');
    }
  };

  useEffect(() => {
    if (!equipmentMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const withinTrigger = equipmentMenuAnchor?.contains(target);
      const withinMenu = target.closest('.admin-tech-menu');
      if (!withinTrigger && !withinMenu) {
        closeEquipmentMenu();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [equipmentMenuOpen, equipmentMenuAnchor]);

  const fetchUsers = async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (e) {
      error('Failed to load users');
    }
  };

  const fetchDirectoryStatus = async () => {
    try {
      const data = await api.getDirectoryStatus() as DirectoryStatus;
      setDirectoryStatus(data);
      setDirectoryForm({
        enabled: !!data.enabled,
        directory_type: data.directory_type === 'ldap' ? 'ldap' : 'ad',
        server_url: data.server_url || '',
        base_dn: data.base_dn || '',
        bind_dn: data.bind_dn || '',
        bind_password: '',
        ca_cert_path: data.ca_cert_path || '/app/certs',
        tls_reject_unauthorized: data.tls_reject_unauthorized !== false,
        allow_insecure_ldap: !!data.allow_insecure_ldap,
        allow_local_fallback: data.allow_local_fallback !== false,
        sync_roles: data.sync_roles !== false,
        sync_profile: data.sync_profile !== false,
        allowed_groups: (data.allowed_groups || []).join('\n'),
        admin_groups: (data.admin_groups || []).join('\n'),
        room_manager_groups: (data.room_manager_groups || []).join('\n'),
        timeout_ms: Number(data.timeout_ms) || 8000,
        connect_timeout_ms: Number(data.connect_timeout_ms) || 5000,
      });
    } catch (e) {
      error('Failed to load directory status');
    }
  };

  const handleCreateUser = async () => {
    if (!newUser.name.trim() || !newUser.email.trim() || !newUser.password) {
      error('Name, email, and password are required');
      return;
    }
    try {
      await api.createUser({
        name: newUser.name.trim(),
        email: newUser.email.trim(),
        department: newUser.department.trim() || undefined,
        role: newUser.role,
        password: newUser.password,
        must_reset_password: newUser.requirePasswordReset,
        receives_admin_notifications: newUser.receivesAdminNotifications,
      });
      setNewUser({
        name: '',
        email: '',
        department: '',
        role: 'user',
        password: '',
        requirePasswordReset: true,
        receivesAdminNotifications: false,
      });
      await fetchUsers();
      success('User created');
    } catch (e: any) {
      error(e.message || 'Failed to create user');
    }
  };

  const handleResetUserPassword = (id: number) => {
    openAdminDialog({
      title: 'Reset user password',
      description: 'Set a temporary password. The user can be required to replace it after signing in.',
      confirmLabel: 'Reset Password',
      input: { label: 'Temporary password', placeholder: 'Minimum 8 characters', type: 'password', required: true },
      onConfirm: async (tempPassword) => {
        if (tempPassword.length < 8) { error('Password must be at least 8 characters'); return false; }
        try {
          await api.resetUserPassword(id, tempPassword);
          await fetchUsers();
          success('Password reset');
        } catch (e: any) {
          error(e.message || 'Failed to reset password');
          return false;
        }
      },
    });
  };

  const handleToggleAdminNotifications = async (userId: number, enabled: boolean) => {
    try {
      await api.updateUser(userId, { receives_admin_notifications: enabled ? 1 : 0 });
      await fetchUsers();
      success('Administrative email preference updated');
    } catch (e: any) {
      error(e.message || 'Failed to update administrative email preference');
    }
  };

  useEffect(() => {
    if (tab === 'buildings') {
      fetchBuildings();
    }
    if (tab === 'rooms') {
      fetchBuildings();
      fetchRooms();
    }
    if (tab === 'hours') {
      fetchBuildings();
      fetchRooms();
    }
    if (tab === 'rules') {
      fetchRules();
    }
    if (tab === 'approvals') {
      fetchPendingBookings();
    }
    if (tab === 'branding' || tab === 'rooms' || tab === 'technology') {
      fetchSiteConfig();
    }
    if (tab === 'notifications') {
      fetchEmailConfig();
      fetchWebhooks();
      fetchWebhookPolicy();
      fetchUsers();
    }
    if (tab === 'users') {
      fetchUsers();
    }
    if (tab === 'directory') {
      fetchDirectoryStatus();
    }
  }, [tab]);

  useEffect(() => {
    if (!equipmentMenuOpen) return;
    const updateRect = () => {
      if (!equipmentMenuAnchor) {
        closeEquipmentMenu();
        return;
      }
      const rect = getAnchorRect(equipmentMenuAnchor);
      if (!rect) {
        closeEquipmentMenu();
        return;
      }
      setEquipmentMenuRect(buildMenuRect(rect));
    };
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [equipmentMenuAnchor, equipmentMenuOpen]);

  useEffect(() => {
    if (buildings.length === 0) return;
    if (!hoursBuildingId) {
      setHoursBuildingId(buildings[0].id);
      return;
    }
    const nextBuilding = buildings.find(b => b.id === hoursBuildingId);
    if (nextBuilding) {
      const normalized = normalizeBusinessHours(nextBuilding.business_hours);
      setHoursBuildingEnabled(!!normalized);
      setHoursBuildingDraft(normalized || buildDefaultBusinessHours());
    }
  }, [buildings, hoursBuildingId]);

  const selectedBuilding = buildings.find(b => b.id === hoursBuildingId) || null;
  const roomsInSelectedBuilding = selectedBuilding
    ? rooms.filter(r => r.building === selectedBuilding.name)
    : [];

  useEffect(() => {
    if (!selectedBuilding) return;
    if (roomsInSelectedBuilding.length === 0) {
      setHoursRoomId(null);
      return;
    }
    if (!hoursRoomId || !roomsInSelectedBuilding.some(r => r.id === hoursRoomId)) {
      setHoursRoomId(roomsInSelectedBuilding[0].id);
    }
  }, [selectedBuilding, roomsInSelectedBuilding, hoursRoomId]);

  useEffect(() => {
    if (!hoursRoomId) return;
    const room = rooms.find(r => r.id === hoursRoomId);
    if (!room) return;
    const normalized = normalizeBusinessHours(room.business_hours);
    if (normalized) {
      setHoursRoomOverride(true);
      setHoursRoomDraft(normalized);
    } else {
      setHoursRoomOverride(false);
      setHoursRoomDraft(normalizeBusinessHours(room.building_hours) || buildDefaultBusinessHours());
    }
  }, [hoursRoomId, rooms]);

  // --- Building handlers ---
  const handleCreateBuilding = async () => {
    if (!newBuilding.name.trim()) return;
    try {
      await api.createBuilding({
        name: newBuilding.name,
        description: newBuilding.description,
      });
      setNewBuilding({ name: '', description: '' });
      await fetchBuildings();
      success('Building created');
    } catch (e: any) {
      error(e.message || 'Failed to create building');
    }
  };

  const handleUpdateBuilding = async () => {
    if (!editingBuilding) return;
    try {
      await api.updateBuilding(editingBuilding.id, {
        name: editingBuilding.name,
        description: editingBuilding.description || '',
      });
      setEditingBuilding(null);
      await fetchBuildings();
      success('Building updated');
    } catch (e: any) {
      error(e.message || 'Failed to update building');
    }
  };

  const handleDeleteBuilding = (id: number) => {
    openAdminDialog({
      title: 'Delete building?', description: 'Rooms must be removed before their building can be deleted.', confirmLabel: 'Delete Building', tone: 'danger',
      onConfirm: async () => {
        try { await api.deleteBuilding(id); await fetchBuildings(); success('Building deleted'); }
        catch (e: any) { error(e.message || 'Failed to delete building'); return false; }
      },
    });
  };

  const handleBuildingImageUpload = async (id: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadBuildingImage(id, file);
      await fetchBuildings();
      success('Building image updated');
    } catch (e: any) {
      error(e.message || 'Upload failed');
    }
  };

  // --- Room handlers ---
  const handleCreateRoom = async () => {
    if (!newRoom.name.trim() || !newRoom.building) return;
    try {
      await api.createRoom({
        ...newRoom,
        equipment: newRoom.equipment,
        buffer_minutes: newRoom.buffer_minutes ?? undefined,
      });
      setNewRoom({
        name: '',
        building: '',
        floor: 1,
        capacity: 8,
        equipment: [],
        min_duration_minutes: 30,
        max_duration_minutes: 120,
        buffer_minutes: 15,
        requires_approval: 0,
      });
      await fetchRooms();
      success('Room created');
    } catch (e: any) {
      error(e.message || 'Failed to create room');
    }
  };

  const handleUpdateRoom = async () => {
    if (!editingRoom) return;
    try {
      await api.updateRoom(Number(editingRoom.id), {
        name: editingRoom.name,
        building: editingRoom.building,
        floor: editingRoom.floor,
        capacity: editingRoom.capacity,
        equipment: editingRoom.equipment,
        is_active: editingRoom.is_active,
        min_duration_minutes: editingRoom.min_duration_minutes ?? null,
        max_duration_minutes: editingRoom.max_duration_minutes ?? null,
        buffer_minutes: editingRoom.buffer_minutes ?? null,
        requires_approval: editingRoom.requires_approval ?? 0,
      });
      setEditingRoom(null);
      await fetchRooms();
      success('Room updated');
    } catch (e: any) {
      error(e.message || 'Failed to update room');
    }
  };

  const handleDeleteRoom = (id: number) => {
    openAdminDialog({
      title: 'Delete room?', description: 'This is permanent and may affect bookings associated with this room.', confirmLabel: 'Delete Room', tone: 'danger',
      onConfirm: async () => {
        try { await api.deleteRoom(id); await fetchRooms(); success('Room deleted'); }
        catch (e: any) { error(e.message || 'Failed to delete room'); return false; }
      },
    });
  };

  const handleRoomImageUpload = async (id: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadRoomImage(id, file);
      await fetchRooms();
      success('Room image updated');
    } catch (e: any) {
      error(e.message || 'Upload failed');
    }
  };

  // --- Webhook helpers ---
  const ALL_EVENTS = ['booking_created', 'booking_pending', 'booking_updated', 'booking_cancelled', 'no_show', 'daily_summary'];

  const toggleEvent = (events: string[], evt: string) =>
    events.includes(evt) ? events.filter(e => e !== evt) : [...events, evt];

  const handleCreateWebhook = async () => {
    if (!newWebhook.webhook_url.trim() || newWebhook.events.length === 0) return;
    try {
      await api.createWebhook(newWebhook);
      setNewWebhook({ service_type: 'slack', webhook_url: '', events: ['booking_created'] });
      await fetchWebhooks();
      success('Webhook created');
    } catch (e: any) {
      error(e.message || 'Failed to create webhook');
    }
  };

  const handleUpdateWebhook = async () => {
    if (!editingWebhook) return;
    try {
      await api.updateWebhook(editingWebhook.id, {
        webhook_url: editingWebhook.webhook_url,
        is_enabled: !!editingWebhook.is_enabled,
        events: editingWebhook.events,
      });
      setEditingWebhook(null);
      await fetchWebhooks();
      success('Webhook updated');
    } catch (e: any) {
      error(e.message || 'Failed to update webhook');
    }
  };

  const handleDeleteWebhook = (id: number) => {
    openAdminDialog({
      title: 'Delete webhook?', description: 'Notifications will no longer be delivered to this integration.', confirmLabel: 'Delete Webhook', tone: 'danger',
      onConfirm: async () => {
        try { await api.deleteWebhook(id); await fetchWebhooks(); success('Webhook deleted'); }
        catch (e: any) { error(e.message || 'Failed to delete webhook'); return false; }
      },
    });
  };

  const handleSaveWebhookPolicy = async () => {
    const origins = internalOriginInput.split('\n').map(value => value.trim()).filter(Boolean);
    setWebhookPolicySaving(true);
    try {
      const saved = await api.updateWebhookPolicy({
        allow_internal_destinations: webhookPolicy.allow_internal_destinations,
        allowed_internal_origins: origins,
      });
      setWebhookPolicy({
        allow_internal_destinations: !!saved.allow_internal_destinations,
        allowed_internal_origins: saved.allowed_internal_origins || [],
      });
      setInternalOriginInput((saved.allowed_internal_origins || []).join('\n'));
      success('Internal webhook policy saved');
    } catch (e: any) {
      error(e.message || 'Failed to save internal webhook policy');
    } finally {
      setWebhookPolicySaving(false);
    }
  };

  // --- Rules handlers ---
  const handleToggleRule = async (id: number, currentEnabled: number) => {
    try {
      await api.updateRule(String(id), { is_enabled: currentEnabled ? false : true });
      await fetchRules();
      success('Rule updated');
    } catch (e: any) {
      error(e.message || 'Failed to update rule');
    }
  };

  const handleRuleValueChange = async (id: number, newValue: number) => {
    if (isNaN(newValue) || newValue < 0) return;
    try {
      await api.updateRule(String(id), { value: newValue });
      await fetchRules();
    } catch (e: any) {
      error(e.message || 'Failed to update rule');
    }
  };

  const handleRuleUnitChange = async (id: number, newUnit: string) => {
    try {
      await api.updateRule(String(id), { unit: newUnit });
      await fetchRules();
    } catch (e: any) {
      error(e.message || 'Failed to update rule');
    }
  };

  // --- Email config handlers ---
  const handleUpdateEmailConfig = async () => {
    try {
      await api.updateEmailConfig(emailConfig);
      await fetchEmailConfig();
      success('Email config saved');
    } catch (e: any) {
      error(e.message || 'Failed to save email config');
    }
  };

  const handleTestEmail = async () => {
    if (!emailTestTo.trim()) return;
    setEmailTestLoading(true);
    try {
      await api.testEmail(emailTestTo);
      success('Test email sent successfully');
    } catch (e: any) {
      error(e.message || 'Test email failed');
    } finally {
      setEmailTestLoading(false);
    }
  };

  // --- Branding handlers ---
  const sanitizeCustomFields = (fields: CustomFieldConfig[]): CustomFieldConfig[] => {
    const used = new Set<string>();
    return fields.map((field, idx) => {
      const label = (field.label || '').trim() || `Field ${idx + 1}`;
      let baseId = (field.id || '').trim();
      if (!baseId) {
        baseId = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
      }
      if (!baseId) baseId = `field_${idx + 1}`;
      let id = baseId;
      let counter = 2;
      while (used.has(id)) {
        id = `${baseId}_${counter++}`;
      }
      used.add(id);
      const type = field.type || 'text';
      const options = type === 'select'
        ? (field.options || []).map(opt => opt.trim()).filter(Boolean)
        : undefined;
      return {
        id,
        label,
        type,
        options,
        required: !!field.required,
        helpText: field.helpText?.trim() || undefined,
      };
    });
  };

  const handleUpdateSiteConfig = async () => {
    try {
      const parsedOptions = equipmentOptionsInput
        .split(/\r?\n|,/)
        .map(s => s.trim())
        .filter(Boolean);
      const normalizedFields = sanitizeCustomFields(siteConfig.custom_fields || []);
      await api.updateSiteConfig({ ...siteConfig, equipment_options: parsedOptions, custom_fields: normalizedFields });
      applyBrandingToDocument({
        company_name: siteConfig.company_name,
        primary_color: siteConfig.primary_color,
        accent_color: siteConfig.accent_color,
        brand_tagline: siteConfig.brand_tagline,
        logo_size: siteConfig.logo_size,
        logo_url: resolveBrandAssetUrl(siteConfig.logo_url, API_BASE),
        favicon_url: resolveBrandAssetUrl(siteConfig.favicon_url, API_BASE),
      }, { theme });
      await fetchSiteConfig();
      success('Branding settings saved');
    } catch (e: any) {
      error(e.message || 'Failed to save branding');
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadLogo(file);
      await fetchSiteConfig();
      success('Logo uploaded');
    } catch (e: any) {
      error(e.message || 'Upload failed');
    }
  };

  const handleFaviconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await api.uploadFavicon(file);
      await fetchSiteConfig();
      success('Browser tab icon uploaded');
    } catch (e: any) {
      error(e.message || 'Favicon upload failed');
    } finally {
      input.value = '';
    }
  };

  const addCustomField = () => {
    setSiteConfig(prev => ({
      ...prev,
      custom_fields: [
        ...(prev.custom_fields || []),
        { id: '', label: '', type: 'text', required: false } as CustomFieldConfig,
      ],
    }));
  };

  const updateCustomField = (index: number, updates: Partial<CustomFieldConfig>) => {
    setSiteConfig(prev => {
      const next = [...(prev.custom_fields || [])];
      next[index] = { ...next[index], ...updates };
      return { ...prev, custom_fields: next };
    });
  };

  const removeCustomField = (index: number) => {
    setSiteConfig(prev => {
      const next = [...(prev.custom_fields || [])];
      next.splice(index, 1);
      return { ...prev, custom_fields: next };
    });
  };

  // --- User handlers ---
  const handleUpdateUserRole = async (userId: number, newRole: string) => {
    try {
      await api.updateUser(userId, { role: newRole });
      await fetchUsers();
      success('User role updated');
    } catch (e: any) {
      error(e.message || 'Failed to update user');
    }
  };

  const handleToggleUserActive = async (userId: number, currentActive: number) => {
    try {
      await api.updateUser(userId, { is_active: currentActive ? 0 : 1 });
      await fetchUsers();
      success('User status updated');
    } catch (e: any) {
      error(e.message || 'Failed to update user');
    }
  };

  const handleResetNoShowCount = async (userId: number) => {
    try {
      await api.updateUser(userId, { no_show_count: 0 });
      await fetchUsers();
      success('No-show count reset');
    } catch (e: any) {
      error(e.message || 'Failed to reset no-show count');
    }
  };

  const handleDeleteUser = (user: User) => {
    openAdminDialog({
      title: `Delete ${user.name}?`,
      description: `This permanently removes ${user.email}. Their booking records will be anonymized; future active bookings will be cancelled. Users with held records cannot be deleted until the hold is released.`,
      confirmLabel: 'Delete User', tone: 'danger',
      onConfirm: async () => {
        try {
          const result = await api.deleteUser(user.id);
          await fetchUsers();
          const bookingCount = Number(result?.anonymized_bookings_count || 0);
          success(`User deleted. Anonymized ${bookingCount} booking${bookingCount === 1 ? '' : 's'}.`);
        } catch (e: any) { error(e.message || 'Failed to delete user'); return false; }
      },
    });
  };

  const handleTestDirectoryConnection = async () => {
    setDirectoryTestLoading(true);
    try {
      const result = await api.testDirectoryConnection(directoryForm);
      success(`Directory connection OK (${result.host}:${result.port}, ${result.latency_ms}ms)`);
    } catch (e: any) {
      error(e.message || 'Directory connection failed');
    } finally {
      setDirectoryTestLoading(false);
    }
  };

  const handleSaveDirectoryConfig = async () => {
    setDirectorySaveLoading(true);
    try {
      await api.updateDirectoryConfig(directoryForm);
      await fetchDirectoryStatus();
      success(directoryForm.enabled ? 'Directory configuration saved and connection verified' : 'Directory configuration saved');
    } catch (e: any) {
      error(e.message || 'Failed to save directory configuration');
    } finally {
      setDirectorySaveLoading(false);
    }
  };

  const handleResetDirectoryConfig = () => {
    openAdminDialog({
      title: 'Restore environment configuration?',
      description: 'This removes the application-managed Directory settings and immediately restores the values supplied to the API container through environment variables.',
      confirmLabel: 'Restore environment settings',
      onConfirm: async () => {
        try {
          await api.resetDirectoryConfig();
          await fetchDirectoryStatus();
          success('Environment Directory configuration restored');
        } catch (e: any) {
          error(e.message || 'Failed to restore environment configuration');
          return false;
        }
      },
    });
  };

  const handleApproveBooking = async (id: number) => {
    try {
      await api.approveBooking(id);
      await fetchPendingBookings();
      success('Booking approved');
    } catch (e: any) {
      error(e.message || 'Failed to approve booking');
    }
  };

  const handleRejectBooking = (id: number) => {
    openAdminDialog({
      title: 'Reject booking?', description: 'You can include a reason that will be shared with the organizer.', confirmLabel: 'Reject Booking', tone: 'danger',
      input: { label: 'Reason (optional)', placeholder: 'Explain why this request cannot be approved' },
      onConfirm: async (reason) => {
        try { await api.rejectBooking(id, reason || undefined); await fetchPendingBookings(); success('Booking rejected'); }
        catch (e: any) { error(e.message || 'Failed to reject booking'); return false; }
      },
    });
  };

  const handleSaveBuildingHours = async () => {
    if (!selectedBuilding) return;
    try {
      await api.updateBuilding(selectedBuilding.id, {
        business_hours: hoursBuildingEnabled ? hoursBuildingDraft : null,
      });
      await fetchBuildings();
      success('Building business hours updated');
    } catch (e: any) {
      error(e.message || 'Failed to update building hours');
    }
  };

  const handleSaveRoomHours = async () => {
    if (!hoursRoomId) return;
    try {
      await api.updateRoom(hoursRoomId, { business_hours: hoursRoomOverride ? hoursRoomDraft : null });
      await fetchRooms();
      success('Room business hours updated');
    } catch (e: any) {
      error(e.message || 'Failed to update room hours');
    }
  };

  const toggleEquipmentSelection = (current: string[], option: string) => {
    if (current.includes(option)) {
      return current.filter(item => item !== option);
    }
    return [...current, option];
  };

  const notificationRecipients = users.filter(user => user.role === 'admin' || user.role === 'room_manager');
  const notificationRecipientQuery = notificationRecipientSearch.trim().toLowerCase();
  const filteredNotificationRecipients = notificationRecipients.filter(user => !notificationRecipientQuery
    || user.name.toLowerCase().includes(notificationRecipientQuery)
    || user.email.toLowerCase().includes(notificationRecipientQuery)
    || user.role.toLowerCase().includes(notificationRecipientQuery));
  const selectedNotificationRecipientCount = notificationRecipients.filter(user =>
    user.is_active && user.receives_admin_notifications
  ).length;

  return (
    <div className="admin-panel">
      <div className="admin-overview card">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>{sectionMeta.title}</h1>
          <p className="subtle">{sectionMeta.description}</p>
        </div>
        <div className="admin-build-info" title={`Build ${BUILD_ID} · Channel ${channelLabel}`}>
          {buildLabel}
        </div>
      </div>

      {tab === 'buildings' && (
        <div className="admin-section">
          {/* Create Building */}
          <div className="admin-form card">
            <h3>Add Building</h3>
            <div className="form-row">
              <input className="input" placeholder="Building name" value={newBuilding.name}
                onChange={e => setNewBuilding({ ...newBuilding, name: e.target.value })} />
              <input className="input" placeholder="Description (optional)" value={newBuilding.description}
                onChange={e => setNewBuilding({ ...newBuilding, description: e.target.value })} />
              <button className="btn btn-primary" onClick={handleCreateBuilding}>Create</button>
            </div>
            <p className="subtle" style={{ marginTop: '8px' }}>
              Business hours are configured in{' '}
              <button
                type="button"
                className="inline-link-btn"
                onClick={() => goToAdminSection('hours')}
              >
                Spaces to Business Hours
              </button>.
            </p>
          </div>

          {/* Building List */}
          <div className="item-grid">
            {buildings.map(b => (
              <div key={b.id} className={`item-card card${editingBuilding?.id === b.id ? ' editing' : ''}`}>
                <div className="item-image-area">
                  {b.image_url ? (
                    <img src={`${API_BASE}${b.image_url}`} alt={b.name} className="item-image" />
                  ) : (
                    <div className="item-image-placeholder">🏢</div>
                  )}
                  <input type="file" accept="image/*" className="visually-hidden"
                    id={`bimg-${b.id}`} onChange={e => handleBuildingImageUpload(b.id, e)} />
                  <label htmlFor={`bimg-${b.id}`} className="upload-label">Upload Photo</label>
                </div>

                {editingBuilding?.id === b.id ? (
                  <div className="edit-form">
                    <input className="input" value={editingBuilding.name}
                      onChange={e => setEditingBuilding({ ...editingBuilding, name: e.target.value })} />
                    <input className="input" value={editingBuilding.description || ''}
                      onChange={e => setEditingBuilding({ ...editingBuilding, description: e.target.value })} />
                    <div className="edit-actions">
                      <button className="btn btn-primary" onClick={handleUpdateBuilding}>Save</button>
                      <button className="btn btn-secondary" onClick={() => setEditingBuilding(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="item-info">
                    <h4>{b.name}</h4>
                    <p className="subtle">{b.description || 'No description'}</p>
                    <div className="item-actions">
                      <button className="btn btn-secondary" onClick={() => setEditingBuilding(b)}>Edit</button>
                      <button className="btn btn-danger" onClick={() => handleDeleteBuilding(b.id)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'rooms' && (
        <div className="admin-section">
          <div className="admin-form card setup-guide">
            <h3>Spaces Setup</h3>
            <p className="subtle">Recommended order: Buildings, Technology, then Rooms. Rooms can be created first and updated later.</p>
            <div className="setup-guide-steps">
              <div className={`setup-step${hasBuildings ? ' complete' : ''}`}>
                <span className="setup-step-status">{hasBuildings ? 'Done' : 'Pending'}</span>
                <div>
                  <strong>1. Create at least one building</strong>
                  <p className="subtle">Rooms must be assigned to a building.</p>
                </div>
                {!hasBuildings && <button className="btn btn-secondary btn-small" onClick={() => goToAdminSection('buildings')}>Go to Buildings</button>}
              </div>
              <div className={`setup-step${hasEquipmentOptions ? ' complete' : ''}`}>
                <span className="setup-step-status">{hasEquipmentOptions ? 'Done' : 'Pending'}</span>
                <div>
                  <strong>2. Configure technology options</strong>
                  <p className="subtle">These options power the room Technology picker and booking filters.</p>
                </div>
                {!hasEquipmentOptions && <button className="btn btn-secondary btn-small" onClick={() => goToAdminSection('technology')}>Go to Technology</button>}
              </div>
              <div className={`setup-step${hasRooms ? ' complete' : ''}`}>
                <span className="setup-step-status">{hasRooms ? 'Done' : 'Pending'}</span>
                <div>
                  <strong>3. Create rooms</strong>
                  <p className="subtle">Set capacity, optional room limits, and approval behavior.</p>
                </div>
              </div>
            </div>
            <p className="setup-guide-summary">
              {isSpacesSetupComplete
                ? 'Setup complete. You can fine-tune rooms, hours, and booking rules.'
                : 'Continue the setup steps above to avoid missing dependencies.'}
            </p>
          </div>

          {/* Create Room */}
          <div className="admin-form card">
            <h3>Add Room</h3>
            <div className="room-form-stack">
              <div className="room-row">
                <div className="room-field">
                  <label className="field-label">Room name</label>
                  <input className="input" placeholder="Room name" aria-label="Room name" value={newRoom.name}
                    onChange={e => setNewRoom({ ...newRoom, name: e.target.value })} />
                </div>
                <div className="room-field">
                  <label className="field-label">Building</label>
                  <select className="input" aria-label="Building" value={newRoom.building}
                    onChange={e => setNewRoom({ ...newRoom, building: e.target.value })}>
                    <option value="">Select building</option>
                    {buildings.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="room-row">
                <div className="room-field room-field-sm">
                  <label className="field-label">Floor</label>
                  <input className="input" type="number" placeholder="1" aria-label="Floor" value={newRoom.floor}
                    onChange={e => setNewRoom({ ...newRoom, floor: Number(e.target.value) })} />
                </div>
                <div className="room-field room-field-sm">
                  <label className="field-label">Capacity</label>
                  <input className="input" type="number" placeholder="8" aria-label="Capacity" value={newRoom.capacity}
                    onChange={e => setNewRoom({ ...newRoom, capacity: Number(e.target.value) })} />
                </div>
                <div className="room-field room-field-sm">
                  <label className="field-label">Min (mins)</label>
                  <input className="input" type="number" placeholder="30" aria-label="Minimum duration minutes" value={newRoom.min_duration_minutes ?? ''}
                    title="Minimum booking minutes"
                    onChange={e => setNewRoom({ ...newRoom, min_duration_minutes: e.target.value ? Number(e.target.value) : null })} />
                </div>
                <div className="room-field room-field-sm">
                  <label className="field-label">Max (mins)</label>
                  <input className="input" type="number" placeholder="120" aria-label="Maximum duration minutes" value={newRoom.max_duration_minutes ?? ''}
                    title="Maximum booking minutes"
                    onChange={e => setNewRoom({ ...newRoom, max_duration_minutes: e.target.value ? Number(e.target.value) : null })} />
                </div>
                <div className="room-field room-field-sm">
                  <label className="field-label">Buffer (mins)</label>
                  <input className="input" type="number" placeholder="15" aria-label="Buffer minutes" value={newRoom.buffer_minutes ?? ''}
                    title="Buffer minutes between bookings"
                    onChange={e => setNewRoom({ ...newRoom, buffer_minutes: e.target.value ? Number(e.target.value) : null })} />
                </div>
              </div>
              <div className="room-row">
                <div className="room-field room-field-full">
                  <label className="field-label">Technology</label>
                  <p className="field-help">Optional while creating a room. Configure options in Technology.</p>
                  <div className="admin-tech-dropdown" ref={equipmentMenuRef}>
                    <button
                      type="button"
                      className={`admin-tech-trigger${equipmentMenuOpen?.mode === 'create' ? ' open' : ''}`}
                      aria-expanded={equipmentMenuOpen?.mode === 'create'}
                      onClick={(e) => {
                        if (equipmentOptions.length === 0) return;
                        if (equipmentMenuOpen?.mode === 'create') {
                          closeEquipmentMenu();
                          return;
                        }
                        openEquipmentMenu(e.currentTarget as HTMLElement | null, 'create');
                      }}
                      disabled={equipmentOptions.length === 0}
                    >
                      <span className="admin-tech-label">Technology</span>
                      <span className="admin-tech-summary">
                        {equipmentOptions.length === 0
                          ? 'No options configured'
                          : (newRoom.equipment.length > 0 ? `${newRoom.equipment.length} selected` : 'Select options')}
                      </span>
                      <span className="admin-tech-chevron">▾</span>
                    </button>
                  </div>
                  {equipmentMenuOpen?.mode === 'create' && equipmentMenuRect && createPortal(
                    <div
                      className="admin-tech-menu"
                      style={{
                        top: equipmentMenuRect.placement === 'below' ? `${equipmentMenuRect.top}px` : undefined,
                        bottom: equipmentMenuRect.placement === 'above' ? `${equipmentMenuRect.bottom}px` : undefined,
                        left: `${equipmentMenuRect.left}px`,
                        width: `${equipmentMenuRect.width}px`,
                        maxHeight: `${equipmentMenuRect.maxHeight}px`,
                        overflowY: 'auto',
                      }}
                    >
                      <div className="admin-tech-menu-header">Assign equipment</div>
                      <div className="admin-tech-options">
                        {equipmentOptions.map(opt => (
                          <button
                            key={opt}
                            type="button"
                            className={`tech-option-btn${newRoom.equipment.includes(opt) ? ' active' : ''}`}
                            onClick={() => setNewRoom({
                              ...newRoom,
                              equipment: toggleEquipmentSelection(newRoom.equipment, opt),
                            })}
                            aria-pressed={newRoom.equipment.includes(opt)}
                          >
                            <span className="tech-option-check">✓</span>
                            <span className="tech-option-text">{opt}</span>
                          </button>
                        ))}
                      </div>
                    </div>,
                    document.body
                  )}
                </div>
              </div>
            </div>
            <div className="form-row">
              <button className="btn btn-primary" onClick={handleCreateRoom}>Create</button>
            </div>
            {equipmentOptions.length === 0 && (
              <div className="setup-inline-warning">
                <p className="subtle">
                  No technology options configured yet. Rooms can still be created, then updated later.
                </p>
                <button className="btn btn-secondary btn-small" onClick={() => goToAdminSection('technology')}>Configure Technology</button>
              </div>
            )}
            <label className="event-label" style={{ marginTop: '10px' }}>
              <input
                type="checkbox"
                checked={!!newRoom.requires_approval}
                onChange={(e) => setNewRoom({ ...newRoom, requires_approval: e.target.checked ? 1 : 0 })}
              />
              Require approval for after-hours bookings
            </label>
          </div>

          {/* Room List */}
          <div className="item-grid">
            {rooms.map(r => (
              <div
                key={r.id}
                className={`item-card card${editingRoom?.id === r.id ? ' editing' : ''}`}
              >
                <div className="item-image-area">
                  {r.image_url ? (
                    <img src={`${API_BASE}${r.image_url}`} alt={r.name} className="item-image" />
                  ) : (
                    <div className="item-image-placeholder">🏛️</div>
                  )}
                  <input type="file" accept="image/*" className="visually-hidden"
                    id={`rimg-${r.id}`} onChange={e => handleRoomImageUpload(r.id, e)} />
                  <label htmlFor={`rimg-${r.id}`} className="upload-label">Upload Photo</label>
                </div>

                {editingRoom?.id === r.id ? (
                  <div className="edit-form">
                    <input className="input" value={editingRoom.name}
                      onChange={e => setEditingRoom({ ...editingRoom, name: e.target.value })} />
                    <select className="input" value={editingRoom.building}
                      onChange={e => setEditingRoom({ ...editingRoom, building: e.target.value })}>
                      {buildings.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                    </select>
                    <div className="room-form-stack room-edit-stack">
                      <div className="room-row">
                        <div className="room-field room-field-sm">
                          <label className="field-label">Floor</label>
                          <input className="input" type="number" placeholder="Floor" aria-label="Floor" value={editingRoom.floor}
                            onChange={e => setEditingRoom({ ...editingRoom, floor: Number(e.target.value) })} />
                        </div>
                        <div className="room-field room-field-sm">
                          <label className="field-label">Capacity</label>
                          <input className="input" type="number" placeholder="Capacity" aria-label="Capacity" value={editingRoom.capacity}
                            onChange={e => setEditingRoom({ ...editingRoom, capacity: Number(e.target.value) })} />
                        </div>
                        <div className="room-field room-field-sm">
                          <label className="field-label">Min (mins)</label>
                          <input className="input" type="number" placeholder="Min" aria-label="Minimum duration minutes" value={editingRoom.min_duration_minutes ?? ''}
                            title="Minimum booking minutes"
                            onChange={e => setEditingRoom({
                              ...editingRoom,
                              min_duration_minutes: e.target.value ? Number(e.target.value) : null,
                            })} />
                        </div>
                        <div className="room-field room-field-sm">
                          <label className="field-label">Max (mins)</label>
                          <input className="input" type="number" placeholder="Max" aria-label="Maximum duration minutes" value={editingRoom.max_duration_minutes ?? ''}
                            title="Maximum booking minutes"
                            onChange={e => setEditingRoom({
                              ...editingRoom,
                              max_duration_minutes: e.target.value ? Number(e.target.value) : null,
                            })} />
                        </div>
                        <div className="room-field room-field-sm">
                          <label className="field-label">Buffer (mins)</label>
                          <input className="input" type="number" placeholder="Buffer" aria-label="Buffer minutes" value={editingRoom.buffer_minutes ?? ''}
                            title="Buffer minutes between bookings"
                            onChange={e => setEditingRoom({
                              ...editingRoom,
                              buffer_minutes: e.target.value ? Number(e.target.value) : null,
                            })} />
                        </div>
                      </div>
                    </div>
                    <label className="event-label">
                      <input
                        type="checkbox"
                        checked={!!editingRoom.requires_approval}
                        onChange={(e) => setEditingRoom({
                          ...editingRoom,
                          requires_approval: e.target.checked ? 1 : 0,
                        })}
                      />
                      Require approval for after-hours bookings
                    </label>
                    <div className="admin-tech-dropdown" ref={equipmentMenuRef}>
                    <button
                      type="button"
                      className={`admin-tech-trigger${equipmentMenuOpen?.mode === 'edit' && equipmentMenuOpen.roomId === editingRoom.id ? ' open' : ''}`}
                      aria-expanded={equipmentMenuOpen?.mode === 'edit' && equipmentMenuOpen.roomId === editingRoom.id}
                      onClick={(e) => {
                        if (equipmentOptions.length === 0) return;
                        if (equipmentMenuOpen?.mode === 'edit' && equipmentMenuOpen.roomId === editingRoom.id) {
                          closeEquipmentMenu();
                          return;
                        }
                        openEquipmentMenu(e.currentTarget as HTMLElement | null, 'edit', editingRoom.id);
                      }}
                        disabled={equipmentOptions.length === 0}
                      >
                        <span className="admin-tech-label">Technology</span>
                        <span className="admin-tech-summary">
                          {equipmentOptions.length === 0
                            ? 'No options configured'
                            : (editingRoom.equipment.length > 0 ? `${editingRoom.equipment.length} selected` : 'Select options')}
                        </span>
                        <span className="admin-tech-chevron">▾</span>
                      </button>
                    </div>
                    {equipmentMenuOpen?.mode === 'edit' && equipmentMenuOpen.roomId === editingRoom.id && equipmentMenuRect && createPortal(
                    <div
                      className="admin-tech-menu"
                      style={{
                        top: equipmentMenuRect.placement === 'below' ? `${equipmentMenuRect.top}px` : undefined,
                        bottom: equipmentMenuRect.placement === 'above' ? `${equipmentMenuRect.bottom}px` : undefined,
                        left: `${equipmentMenuRect.left}px`,
                        width: `${equipmentMenuRect.width}px`,
                        maxHeight: `${equipmentMenuRect.maxHeight}px`,
                        overflowY: 'auto',
                      }}
                    >
                        <div className="admin-tech-menu-header">Assign equipment</div>
                        <div className="admin-tech-options">
                          {equipmentOptions.map(opt => (
                            <button
                              key={opt}
                              type="button"
                              className={`tech-option-btn${editingRoom.equipment.includes(opt) ? ' active' : ''}`}
                              onClick={() => setEditingRoom({
                                ...editingRoom,
                                equipment: toggleEquipmentSelection(editingRoom.equipment, opt),
                              })}
                              aria-pressed={editingRoom.equipment.includes(opt)}
                            >
                              <span className="tech-option-check">✓</span>
                              <span className="tech-option-text">{opt}</span>
                            </button>
                          ))}
                        </div>
                      </div>,
                      document.body
                    )}
                    <div className="edit-actions">
                      <button className="btn btn-primary" onClick={handleUpdateRoom}>Save</button>
                      <button className="btn btn-secondary" onClick={() => setEditingRoom(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="item-info">
                    <h4>{r.name}</h4>
                    <p className="subtle">{r.building} · Floor {r.floor} · {r.capacity} seats</p>
                    <div className="equipment-tags">
                      {r.equipment.map(eq => <span key={eq} className="equipment-tag">{eq}</span>)}
                    </div>
                    <div className="item-actions">
                      <button className="btn btn-secondary" onClick={() => setEditingRoom(r)}>Edit</button>
                      <button className="btn btn-danger" onClick={() => handleDeleteRoom(r.id)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'hours' && (
        <div className="admin-section hours-section">
          <div className="hours-overview card">
            <div className="hours-overview-icon"><BriefcaseBusiness size={21} /></div>
            <div>
              <span className="eyebrow">Availability policy</span>
              <h3>Set predictable hours, then handle exceptions by room</h3>
              <p>Building schedules provide the default. Add a room override only when that space follows a different timetable.</p>
            </div>
            <div className="hours-overview-stats">
              <span><strong>{buildings.length}</strong> buildings</span>
              <span><strong>{rooms.length}</strong> rooms</span>
            </div>
          </div>
          <div className="admin-hours-layout">
            <section className="admin-form card admin-hours-card">
              <div className="hours-card-heading">
                <span className="hours-heading-icon"><Building2 size={18} /></span>
                <div><h3>Building hours</h3><p>Set the schedule inherited by every room in this building.</p></div>
                <span className="hours-card-badge">Default</span>
              </div>
              <div className="hours-field">
                <label className="branding-label" htmlFor="hours-building">Building</label>
                <select
                  id="hours-building"
                  className="input"
                  value={hoursBuildingId ?? ''}
                  onChange={(e) => setHoursBuildingId(e.target.value ? Number(e.target.value) : null)}
                  disabled={buildings.length === 0}
                >
                  {buildings.length === 0 && <option value="">No buildings yet</option>}
                  {buildings.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              {selectedBuilding && (
                <div className="hours-schedule-block">
                  <label className="hours-switch-row">
                    <span><strong>Enforce business hours</strong><small>Bookings outside this schedule follow your approval rules.</small></span>
                    <input
                      type="checkbox"
                      checked={hoursBuildingEnabled}
                      onChange={(e) => setHoursBuildingEnabled(e.target.checked)}
                    />
                  </label>
                  {hoursBuildingEnabled ? (
                    <BusinessHoursEditor
                      value={hoursBuildingDraft}
                      onChange={setHoursBuildingDraft}
                    />
                  ) : (
                    <div className="hours-empty-state"><Clock3 size={16} /><span>This building currently allows bookings at any time.</span></div>
                  )}
                </div>
              )}
              <div className="hours-card-actions">
                <button className="btn btn-primary" disabled={!selectedBuilding} onClick={handleSaveBuildingHours}>
                  Save building hours
                </button>
              </div>
            </section>

            <section className="admin-form card admin-hours-card">
              <div className="hours-card-heading">
                <span className="hours-heading-icon"><DoorOpen size={18} /></span>
                <div><h3>Room overrides</h3><p>Give one room a different schedule without changing its building.</p></div>
                <span className="hours-card-badge optional">Optional</span>
              </div>
              <div className="hours-field">
                <label className="branding-label" htmlFor="hours-room">Room in {selectedBuilding?.name || 'selected building'}</label>
                <select
                  id="hours-room"
                  className="input"
                  value={hoursRoomId ?? ''}
                  onChange={(e) => setHoursRoomId(e.target.value ? Number(e.target.value) : null)}
                  disabled={roomsInSelectedBuilding.length === 0}
                >
                  {roomsInSelectedBuilding.length === 0 && <option value="">No rooms in this building</option>}
                  {roomsInSelectedBuilding.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div className="hours-schedule-block">
                <label className={`hours-switch-row ${!hoursRoomId ? 'disabled' : ''}`}>
                  <span><strong>Use a room-specific schedule</strong><small>When off, this room continues to inherit its building hours.</small></span>
                  <input
                    type="checkbox"
                    checked={hoursRoomOverride}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setHoursRoomOverride(enabled);
                      if (enabled && hoursRoomId) {
                        const room = rooms.find(r => r.id === hoursRoomId);
                        setHoursRoomDraft(normalizeBusinessHours(room?.business_hours) || hoursBuildingDraft);
                      }
                    }}
                    disabled={!hoursRoomId}
                  />
                </label>
                {hoursRoomId && hoursRoomOverride && (
                  <BusinessHoursEditor
                    value={hoursRoomDraft}
                    onChange={setHoursRoomDraft}
                  />
                )}
                {hoursRoomId && !hoursRoomOverride && (
                  <div className="hours-empty-state"><CheckCircle2 size={16} /><span>This room is using the building schedule.</span></div>
                )}
                {!hoursRoomId && <div className="hours-empty-state"><DoorOpen size={16} /><span>Select a room to review or change its schedule.</span></div>}
              </div>
              <div className="hours-card-actions">
                <button className="btn btn-primary" disabled={!hoursRoomId} onClick={handleSaveRoomHours}>
                  Save room override
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      {tab === 'rules' && (
        <div className="admin-section rules-section">
          <div className="rules-overview card">
            <div><span className="eyebrow">Policy overview</span><h3>{rules.filter(rule => rule.is_enabled).length} of {rules.length} rules active</h3><p>Changes apply immediately. Numeric values save when you leave the field or press Enter.</p></div>
            <div className="rules-overview-status"><CheckCircle2 size={18} /><span>Policy engine online</span></div>
          </div>
          <div className="rule-groups">
            {[...RULE_GROUPS, 'Other'].map(group => {
              const groupRules = rules.filter(rule => (RULE_META[rule.rule_type]?.group || 'Other') === group);
              if (groupRules.length === 0) return null;
              return (
                <section className="rule-group" key={group}>
                  <div className="rule-group-heading"><div><h3>{group}</h3><p>{groupRules.filter(rule => rule.is_enabled).length} active · {groupRules.length} total</p></div></div>
                  <div className="rules-list">
                    {groupRules.map((rule: any) => {
                      const meta = RULE_META[rule.rule_type] || {
                        label: rule.rule_type.replace(/_/g, ' '),
                        icon: SlidersHorizontal,
                        description: rule.description,
                        allowedUnits: [rule.unit],
                        group: 'Other',
                      };
                      const RuleIcon = meta.icon;
                      const showValueInput = meta.allowedUnits.length > 0 && rule.value !== null && rule.value !== undefined;
                      return (
                        <div key={rule.id} className={`rule-card card ${rule.is_enabled ? 'enabled' : 'disabled'}`}>
                          <div className="rule-header">
                            <div className="rule-title-row">
                              <span className="rule-icon"><RuleIcon size={17} /></span>
                              <div><span className="rule-label">{meta.label}</span><span className={`rule-state ${rule.is_enabled ? 'active' : ''}`}>{rule.is_enabled ? 'Active' : 'Off'}</span></div>
                            </div>
                            <label className="toggle-switch" aria-label={`${rule.is_enabled ? 'Disable' : 'Enable'} ${meta.label}`}>
                              <input type="checkbox" checked={!!rule.is_enabled} onChange={() => handleToggleRule(rule.id, rule.is_enabled)} />
                              <span className="toggle-slider" />
                            </label>
                          </div>
                          <p className="rule-desc">{meta.description}</p>
                          {showValueInput && (
                            <div className="rule-edit-area">
                              <span className="rule-value-label">Policy value</span>
                              {rule.rule_type === 'booking_interval' ? (
                                <select className="input rule-value-input" value={String(rule.value)} onChange={(e) => handleRuleValueChange(rule.id, Number(e.target.value))}>
                                  <option value="15">15</option><option value="30">30</option><option value="60">60</option>
                                </select>
                              ) : (
                                <input type="number" className="input rule-value-input" value={rule.value} min={1}
                                  onChange={(e) => { const v = Number(e.target.value); setRules(prev => prev.map(r => r.id === rule.id ? { ...r, value: v } : r)); }}
                                  onBlur={(e) => handleRuleValueChange(rule.id, Number(e.target.value))}
                                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                              )}
                              {meta.allowedUnits.length > 1 ? (
                                <select className="input rule-unit-select" value={rule.unit} onChange={(e) => handleRuleUnitChange(rule.id, e.target.value)}>
                                  {meta.allowedUnits.map(unit => <option key={unit} value={unit}>{unit}</option>)}
                                </select>
                              ) : <span className="rule-unit-label">{rule.unit}</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'approvals' && (
        <div className="admin-section">
          <div className="admin-form card">
            <h3>After-Hours Approvals</h3>
            <p className="subtle" style={{ marginBottom: '1rem' }}>
              Bookings outside business hours appear here when a room requires approval.
            </p>
            {pendingBookings.length === 0 ? (
              <p className="subtle">No pending approvals.</p>
            ) : (
              <div className="approvals-list">
                {pendingBookings.map((b: any) => (
                  <div key={b.id} className="approval-card">
                    <div className="approval-info">
                      <div className="approval-title">{b.title || 'Untitled Booking'}</div>
                      <div className="approval-meta subtle">
                        {b.room_name || `Room ${b.room_id}`} · {b.room_building || 'Unknown building'}
                        {b.room_floor !== undefined ? ` · Floor ${b.room_floor}` : ''}
                      </div>
                      <div className="approval-meta">
                        {new Date(b.start_time).toLocaleString()} — {new Date(b.end_time).toLocaleString()}
                      </div>
                      <div className="approval-meta subtle">
                        Organizer: {b.organizer_email || 'Unknown'}
                      </div>
                    </div>
                    <div className="approval-actions">
                      <button className="btn btn-primary" onClick={() => handleApproveBooking(b.id)}>Approve</button>
                      <button className="btn btn-danger" onClick={() => handleRejectBooking(b.id)}>Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'branding' && (
        <div className="admin-section branding-section">
          <div className="branding-workspace">
            <aside className="branding-preview card">
              <div className="branding-preview-label"><Palette size={15} />Live preview</div>
              <div className="branding-preview-shell">
                <div className="branding-preview-sidebar">
                  <div className="branding-preview-brand">
                    {siteConfig.logo_url ? <img src={resolveBrandAssetUrl(siteConfig.logo_url, API_BASE)} alt="" className={`branding-preview-logo ${siteConfig.logo_size}`} /> : <span className="branding-preview-mark" style={{ background: siteConfig.primary_color }}>{(siteConfig.company_name || 'C').slice(0, 1).toUpperCase()}</span>}
                    <span><strong>{siteConfig.company_name || 'Your organization'}</strong><small>{siteConfig.brand_tagline || ' '}</small></span>
                  </div>
                  <div className="branding-preview-nav active" style={{ color: siteConfig.primary_color }}><span style={{ background: siteConfig.primary_color }} />Rooms</div>
                  <div className="branding-preview-nav"><span />Calendar</div>
                  <div className="branding-preview-nav"><span />My Bookings</div>
                </div>
                <div className="branding-preview-content">
                  <span className="eyebrow" style={{ color: siteConfig.accent_color }}>Workspace preview</span>
                  <strong>Conference rooms</strong>
                  <p>Your colors, identity, and logo appear throughout Resy.</p>
                  <button type="button" style={{ background: siteConfig.primary_color }}>Book a room</button>
                </div>
              </div>
              <p>Preview is illustrative. Save to apply branding for all users.</p>
            </aside>

            <div className="branding-settings">
              <section className="admin-form card branding-card">
                <div className="branding-card-heading"><div><h3>Identity</h3><p>Name the workspace and control how it appears in navigation.</p></div></div>
                <div className="branding-field-grid">
                  <div className="branding-row"><label className="branding-label">Organization name</label><input className="input" maxLength={80} placeholder="Resy" value={siteConfig.company_name} onChange={e => setSiteConfig({ ...siteConfig, company_name: e.target.value })} /></div>
                  <div className="branding-row"><label className="branding-label">Navigation tagline</label><input className="input" maxLength={40} placeholder="Room booking" value={siteConfig.brand_tagline} onChange={e => setSiteConfig({ ...siteConfig, brand_tagline: e.target.value })} /><p className="field-help">Short supporting text shown under the organization name.</p></div>
                </div>
                <div className="branding-row">
                  <label className="branding-label">Logo</label>
                  <div className="logo-upload-area">
                    {siteConfig.logo_url ? <img src={resolveBrandAssetUrl(siteConfig.logo_url, API_BASE)} alt="Current logo" className="logo-preview" /> : <div className="logo-placeholder">No logo uploaded</div>}
                    <div className="branding-inline-actions">
                      <input type="file" accept="image/*" id="logo-upload" className="visually-hidden" onChange={handleLogoUpload} />
                      <label htmlFor="logo-upload" className="btn btn-secondary">{siteConfig.logo_url ? 'Replace logo' : 'Upload logo'}</label>
                      {siteConfig.logo_url && <button type="button" className="btn btn-secondary" onClick={() => setSiteConfig({ ...siteConfig, logo_url: '' })}>Remove</button>}
                    </div>
                  </div>
                  <details className="favicon-url-option">
                    <summary>Use an externally hosted logo instead</summary>
                    <input className="input" aria-label="External logo URL" placeholder="https://example.com/logo.png" value={siteConfig.logo_url?.startsWith('https://') ? siteConfig.logo_url : ''} onChange={e => setSiteConfig({ ...siteConfig, logo_url: e.target.value })} />
                  </details>
                </div>
                <div className="branding-row"><label className="branding-label">Logo size</label><div className="segmented-control">{(['small', 'medium', 'large'] as const).map(size => <button type="button" key={size} className={siteConfig.logo_size === size ? 'active' : ''} onClick={() => setSiteConfig({ ...siteConfig, logo_size: size })}>{size}</button>)}</div></div>
                <div className="branding-row">
                  <label className="branding-label">Browser tab icon</label>
                  <div className="favicon-upload-area">
                    <div className="favicon-preview-shell">
                      {siteConfig.favicon_url
                        ? <img src={resolveBrandAssetUrl(siteConfig.favicon_url, API_BASE)} alt="Current browser tab icon" className="favicon-preview" />
                        : <span className="favicon-placeholder">R</span>}
                      <span><strong>{siteConfig.favicon_url ? 'Current favicon' : 'No favicon uploaded'}</strong><small>Shown beside the page title in browser tabs.</small></span>
                    </div>
                    <div className="branding-inline-actions">
                      <input type="file" accept=".ico,.png,.jpg,.jpeg,.gif,.webp,image/x-icon,image/vnd.microsoft.icon,image/png,image/jpeg,image/gif,image/webp" id="favicon-upload" className="visually-hidden" onChange={handleFaviconUpload} />
                      <label htmlFor="favicon-upload" className="btn btn-secondary">{siteConfig.favicon_url ? 'Replace favicon' : 'Upload favicon'}</label>
                      {siteConfig.favicon_url && <button type="button" className="btn btn-secondary" onClick={() => setSiteConfig({ ...siteConfig, favicon_url: '' })}>Remove</button>}
                    </div>
                  </div>
                  <p className="field-help">ICO, PNG, JPG, GIF, or WebP. A square image at 32×32 pixels or larger works best.</p>
                  <details className="favicon-url-option">
                    <summary>Use an externally hosted icon instead</summary>
                    <input className="input" aria-label="External favicon URL" placeholder="https://example.com/favicon.ico" value={siteConfig.favicon_url?.startsWith('http') ? siteConfig.favicon_url : ''} onChange={e => setSiteConfig({ ...siteConfig, favicon_url: e.target.value })} />
                  </details>
                </div>
              </section>

              <section className="admin-form card branding-card">
                <div className="branding-card-heading"><div><h3>Color system</h3><p>Use a primary action color and a supporting accent for visual depth.</p></div></div>
                <div className="brand-presets">
                  {BRAND_PRESETS.map(preset => <button type="button" key={preset.name} title={preset.name} className={siteConfig.primary_color === preset.primary && siteConfig.accent_color === preset.accent ? 'active' : ''} onClick={() => setSiteConfig({ ...siteConfig, primary_color: preset.primary, accent_color: preset.accent })}><span style={{ background: preset.primary }} /><span style={{ background: preset.accent }} /><small>{preset.name}</small></button>)}
                </div>
                <div className="branding-field-grid">
                  <div className="branding-row"><label className="branding-label">Primary color</label><div className="color-input-row"><label className="color-wheel-control" title="Open primary color wheel"><input type="color" className="color-picker" aria-label="Open primary color wheel" value={siteConfig.primary_color} onChange={e => setSiteConfig({ ...siteConfig, primary_color: e.target.value })} /><span className="color-wheel-preview" style={{ backgroundColor: siteConfig.primary_color }} /></label><input className="input color-hex" aria-label="Primary color hex value" value={siteConfig.primary_color} onChange={e => setSiteConfig({ ...siteConfig, primary_color: e.target.value })} /></div><p className="field-help">Choose any shade from the color wheel or enter a hex value. Used for buttons, navigation, links, and focus states.</p></div>
                  <div className="branding-row"><label className="branding-label">Accent color</label><div className="color-input-row"><label className="color-wheel-control" title="Open accent color wheel"><input type="color" className="color-picker" aria-label="Open accent color wheel" value={siteConfig.accent_color} onChange={e => setSiteConfig({ ...siteConfig, accent_color: e.target.value })} /><span className="color-wheel-preview" style={{ backgroundColor: siteConfig.accent_color }} /></label><input className="input color-hex" aria-label="Accent color hex value" value={siteConfig.accent_color} onChange={e => setSiteConfig({ ...siteConfig, accent_color: e.target.value })} /></div><p className="field-help">Choose any shade from the color wheel or enter a hex value. Used for supporting highlights and page atmosphere.</p></div>
                </div>
              </section>

              <section className="admin-form card branding-card">
                <div className="branding-card-heading"><div><h3>Workspace defaults</h3><p>Set organization-wide display behavior.</p></div></div>
                <div className="branding-field-grid">
                  <div className="branding-row"><label className="branding-label">Application timezone</label><select className="input" value={siteConfig.timezone || 'America/Chicago'} onChange={e => setSiteConfig({ ...siteConfig, timezone: e.target.value })}>{TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}</select><p className="field-help">All booking times are displayed in this timezone.</p></div>
                  <div className="branding-row"><label className="branding-label">Default calendar view</label><select className="input" value={siteConfig.calendar_default_view || 'day'} onChange={e => setSiteConfig({ ...siteConfig, calendar_default_view: e.target.value as CalendarDefaultView })}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select><p className="field-help">Initial view when users open Calendar.</p></div>
                </div>
              </section>

              <section className="admin-form card branding-card">
                <div className="branding-card-heading"><div><h3>Custom booking fields</h3><p>Collect organization-specific information during booking.</p></div><button className="btn btn-secondary" type="button" onClick={addCustomField}>Add field</button></div>
                <div className="custom-fields-list">
                  {siteConfig.custom_fields.length === 0 && <div className="branding-empty"><strong>No custom fields</strong><span>Add a field when bookings need information beyond the standard form.</span></div>}
                  {siteConfig.custom_fields.map((field, idx) => (
                    <div key={`${field.id || 'field'}-${idx}`} className="custom-field-card">
                      <div className="custom-field-row">
                        <input className="input" placeholder="Field label" value={field.label} onChange={(e) => updateCustomField(idx, { label: e.target.value })} />
                        <select className="input" value={field.type || 'text'} onChange={(e) => updateCustomField(idx, { type: e.target.value as CustomFieldType })}><option value="text">Text</option><option value="select">Dropdown</option><option value="checkbox">Checkbox</option></select>
                        <label className="event-label custom-required"><input type="checkbox" checked={!!field.required} onChange={(e) => updateCustomField(idx, { required: e.target.checked })} />Required</label>
                        <button type="button" className="btn btn-danger btn-small" onClick={() => removeCustomField(idx)}>Remove</button>
                      </div>
                      {field.type === 'select' && <textarea className="input textarea" placeholder="Dropdown options (one per line)" value={(field.options || []).join('\n')} onChange={(e) => updateCustomField(idx, { options: e.target.value.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean) })} rows={3} />}
                      <input className="input" placeholder="Help text (optional)" value={field.helpText || ''} onChange={(e) => updateCustomField(idx, { helpText: e.target.value })} />
                    </div>
                  ))}
                </div>
              </section>

              <div className="branding-actions card"><div><strong>Apply organization branding</strong><span>Changes become visible to every user after saving.</span></div><button className="btn btn-primary" onClick={handleUpdateSiteConfig}>Save branding</button></div>
            </div>
          </div>
        </div>
      )}

      {tab === 'technology' && (
        <div className="admin-section">
          <div className="admin-form card">
            <h3>Technology Options</h3>
            <p className="subtle" style={{ marginBottom: '1rem' }}>
              Configure the equipment list used in room setup and booking filters.
            </p>
            <textarea
              className="input textarea"
              placeholder="One per line (e.g., Zoom, Projector, Whiteboard)"
              value={equipmentOptionsInput}
              onChange={e => setEquipmentOptionsInput(e.target.value)}
              rows={6}
            />
            <p className="subtle" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
              These options appear in room setup and on the booking form.
            </p>
            <div className="edit-actions" style={{ marginTop: '16px' }}>
              <button className="btn btn-primary" onClick={handleUpdateSiteConfig}>Save</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'notifications' && (
        <div className="admin-section notification-delivery-section">
          <section className="admin-form card notification-settings-card">
            <div className="notification-section-heading">
              <div>
                <span className="notification-section-kicker">Administrative Email</span>
                <h3>Email delivery and recipients</h3>
                <p className="subtle">Send organizer messages and optional administrative copies through SMTP.</p>
              </div>
              <span className={`status-badge ${emailConfig.is_enabled ? 'enabled' : 'disabled'}`}>
                {emailConfig.is_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="email-config-grid">
              <div className="email-config-row">
                <label className="email-config-label">SMTP Host</label>
                <input className="input" placeholder="smtp.example.com" value={emailConfig.smtp_host}
                  onChange={e => setEmailConfig({ ...emailConfig, smtp_host: e.target.value })} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">SMTP Port</label>
                <input className="input" type="number" value={emailConfig.smtp_port}
                  onChange={e => setEmailConfig({ ...emailConfig, smtp_port: Number(e.target.value) })} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">SMTP User</label>
                <input className="input" placeholder="user@example.com" value={emailConfig.smtp_user}
                  onChange={e => setEmailConfig({ ...emailConfig, smtp_user: e.target.value })} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">SMTP Password</label>
                <input className="input" type="password" placeholder="••••••••" value={emailConfig.smtp_password}
                  onChange={e => setEmailConfig({ ...emailConfig, smtp_password: e.target.value })} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">From Email</label>
                <input className="input" placeholder="noreply@example.com" value={emailConfig.from_email}
                  onChange={e => setEmailConfig({ ...emailConfig, from_email: e.target.value })} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">From Name</label>
                <input className="input" placeholder="Resy" value={emailConfig.from_name}
                  onChange={e => setEmailConfig({ ...emailConfig, from_name: e.target.value })} />
              </div>
              <div className="email-config-row">
                <label className="event-label">
                  <input type="checkbox" checked={!!emailConfig.is_enabled}
                    onChange={e => setEmailConfig({ ...emailConfig, is_enabled: e.target.checked ? 1 : 0 })} />
                  Enable email delivery
                </label>
              </div>
              <div className="email-config-actions">
                <button className="btn btn-primary" onClick={handleUpdateEmailConfig}>Save</button>
                <div className="email-test-row">
                  <input className="input email-test-input" type="email" placeholder="test@example.com"
                    value={emailTestTo} onChange={e => setEmailTestTo(e.target.value)} />
                  <button className="btn btn-secondary" onClick={handleTestEmail} disabled={emailTestLoading}>
                    {emailTestLoading ? 'Sending...' : 'Test Email'}
                  </button>
                </div>
              </div>
            </div>
            <div className="notification-subsection">
              <div className="notification-subsection-heading">
                <div>
                  <h4>Administrative email recipients</h4>
                  <p className="subtle">Choose which active Administrators and Room Managers receive copies of booking activity.</p>
                </div>
                <span className="notification-recipient-count">
                  {selectedNotificationRecipientCount} selected
                </span>
              </div>
              <input
                className="input notification-recipient-search"
                placeholder="Search administrators and room managers"
                value={notificationRecipientSearch}
                onChange={event => setNotificationRecipientSearch(event.target.value)}
              />
              <div className="notification-recipient-list">
                {filteredNotificationRecipients.map(user => (
                    <label key={user.id} className={`notification-recipient-row${user.is_active ? '' : ' is-inactive'}`}>
                      <span className="notification-recipient-identity">
                        <strong>{user.name}</strong>
                        <span>{user.email}</span>
                      </span>
                      <span className="notification-recipient-meta">
                        <span className="role-badge">{user.role === 'admin' ? 'Administrator' : 'Room Manager'}</span>
                        {!user.is_active && <span className="status-badge disabled">Inactive</span>}
                        <input
                          type="checkbox"
                          checked={Boolean(user.receives_admin_notifications)}
                          disabled={!user.is_active}
                          onChange={event => handleToggleAdminNotifications(user.id, event.target.checked)}
                          aria-label={`Send administrative booking emails to ${user.name}`}
                        />
                      </span>
                    </label>
                  ))}
                {filteredNotificationRecipients.length === 0 && (
                  <div className="notification-empty-state">
                    {notificationRecipients.length === 0
                      ? 'No Administrators or Room Managers are available.'
                      : 'No recipients match this search.'}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="admin-form card notification-settings-card">
            <div className="notification-section-heading">
              <div>
                <span className="notification-section-kicker">Shared Channels</span>
                <h3>Webhook delivery</h3>
                <p className="subtle">Post once to a shared Slack, Teams, or Rocket.Chat destination. Channel membership is managed in that service.</p>
              </div>
              <span className={`status-badge ${webhooks.some(webhook => webhook.is_enabled) ? 'enabled' : 'disabled'}`}>
                {webhooks.some(webhook => webhook.is_enabled)
                  ? `${webhooks.filter(webhook => webhook.is_enabled).length} active`
                  : 'Disabled'}
              </span>
            </div>
            <div className="notification-subsection webhook-create-section">
              <h4>Add destination</h4>
              <div className="webhook-form-grid">
                <select className="input" value={newWebhook.service_type}
                  onChange={e => setNewWebhook({ ...newWebhook, service_type: e.target.value })}>
                  <option value="slack">Slack</option>
                  <option value="teams">Microsoft Teams</option>
                  <option value="rocket">Rocket.Chat</option>
                </select>
                <input className="input" placeholder="Webhook URL" value={newWebhook.webhook_url}
                  onChange={e => setNewWebhook({ ...newWebhook, webhook_url: e.target.value })} />
                <button className="btn btn-primary" onClick={handleCreateWebhook}>Add Webhook</button>
              </div>
              <div className="event-checkboxes notification-event-grid">
                {ALL_EVENTS.map(evt => (
                  <label key={evt} className="event-label">
                    <input type="checkbox" checked={newWebhook.events.includes(evt)}
                      onChange={() => setNewWebhook({ ...newWebhook, events: toggleEvent(newWebhook.events, evt) })} />
                    {evt.replace(/_/g, ' ')}
                  </label>
                ))}
              </div>
            </div>
            <div className="webhook-list compact-webhook-list">
              {webhooks.length === 0 && <div className="notification-empty-state">No webhook destinations configured.</div>}
              {webhooks.map((w: any) => (
                <div key={w.id} className="webhook-card">
                  {editingWebhook?.id === w.id ? (
                    <div className="edit-form">
                      <div className="webhook-edit-header">
                        <span className={`service-badge service-${editingWebhook.service_type}`}>
                          {editingWebhook.service_type}
                        </span>
                      </div>
                      <input className="input" value={editingWebhook.webhook_url}
                        onChange={e => setEditingWebhook({ ...editingWebhook, webhook_url: e.target.value })} />
                      <div className="event-checkboxes notification-event-grid">
                        {ALL_EVENTS.map(evt => (
                          <label key={evt} className="event-label">
                            <input type="checkbox" checked={editingWebhook.events.includes(evt)}
                              onChange={() => setEditingWebhook({ ...editingWebhook, events: toggleEvent(editingWebhook.events, evt) })} />
                            {evt.replace(/_/g, ' ')}
                          </label>
                        ))}
                      </div>
                      <label className="event-label">
                        <input type="checkbox" checked={!!editingWebhook.is_enabled}
                          onChange={e => setEditingWebhook({ ...editingWebhook, is_enabled: e.target.checked })} />
                        Enabled
                      </label>
                      <div className="edit-actions">
                        <button className="btn btn-primary" onClick={handleUpdateWebhook}>Save</button>
                        <button className="btn btn-secondary" onClick={() => setEditingWebhook(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="webhook-info">
                      <div className="webhook-header">
                        <span className={`service-badge service-${w.service_type}`}>{w.service_type}</span>
                        <span className={`status-badge ${w.is_enabled ? 'enabled' : 'disabled'}`}>
                          {w.is_enabled ? 'Active' : 'Disabled'}
                        </span>
                      </div>
                      <p className="webhook-url subtle">{w.webhook_url}</p>
                      <div className="event-tags">
                        {w.events.map((e: string) => <span key={e} className="equipment-tag">{e.replace(/_/g, ' ')}</span>)}
                      </div>
                      <div className="item-actions">
                        <button className="btn btn-secondary" onClick={() => setEditingWebhook({ ...w })}>Edit</button>
                        <button className="btn btn-danger" onClick={() => handleDeleteWebhook(w.id)}>Delete</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="admin-form card notification-settings-card">
            <div className="notification-section-heading">
              <div>
                <span className="notification-section-kicker">Advanced</span>
                <h3>Internal destination policy</h3>
                <p className="subtle">Permit specific private-network webhook origins without opening access to the rest of the internal network.</p>
              </div>
              <span className={`status-badge ${webhookPolicy.allow_internal_destinations ? 'enabled' : 'disabled'}`}>
                {webhookPolicy.allow_internal_destinations ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <label className="event-label internal-webhook-toggle">
              <input
                type="checkbox"
                checked={webhookPolicy.allow_internal_destinations}
                onChange={event => setWebhookPolicy(current => ({
                  ...current,
                  allow_internal_destinations: event.target.checked,
                }))}
              />
              Enable internal webhook destinations
            </label>
            <div className="field compact-policy-field">
              <label htmlFor="internal-webhook-origins">Allowed internal origins</label>
              <textarea
                id="internal-webhook-origins"
                className="input textarea"
                rows={3}
                value={internalOriginInput}
                onChange={event => setInternalOriginInput(event.target.value)}
                placeholder={'http://rocket.internal:3000\nhttps://chat.example.internal'}
              />
              <p className="subtle">One exact origin per line. Include only the scheme, hostname or IP, and optional port—not the webhook path or token.</p>
            </div>
            <div className="notification-policy-footer">
              <p className="subtle">Loopback, link-local, metadata, redirects, and unlisted destinations remain blocked.</p>
              <button className="btn btn-secondary" onClick={handleSaveWebhookPolicy} disabled={webhookPolicySaving}>
                {webhookPolicySaving ? 'Saving...' : 'Save Internal Policy'}
              </button>
            </div>
          </section>
        </div>
      )}

      {tab === 'directory' && (
        <div className="admin-section">
          <form className="admin-form card" onSubmit={(event) => { event.preventDefault(); handleSaveDirectoryConfig(); }}>
            <h3>Active Directory / LDAP</h3>
            <p className="subtle" style={{ marginBottom: '1rem' }}>
              Configure directory authentication here or restore values supplied through the API container environment.
            </p>
            {directoryStatus ? (
              <>
                <div className="directory-status-row">
                  <span className={`status-badge ${directoryStatus.enabled ? 'enabled' : 'disabled'}`}>
                    {directoryStatus.enabled ? 'Directory Auth Enabled' : 'Directory Auth Disabled'}
                  </span>
                  <span className={`status-badge ${directoryStatus.configured ? 'enabled' : 'warning'}`}>
                    {directoryStatus.configured ? 'Config Complete' : 'Config Incomplete'}
                  </span>
                  <span className={`status-badge ${directoryStatus.auth_source === 'directory' ? 'enabled' : 'disabled'}`}>
                    Auth Source: {directoryStatus.auth_source === 'directory' ? 'Directory' : 'Local'}
                  </span>
                  <span className="status-badge disabled">
                    Config: {directoryStatus.config_source === 'application' ? 'Managed in Resy' : 'Environment'}
                  </span>
                </div>
                <div className="directory-source-note">
                  {directoryStatus.config_source === 'environment' ? (
                    <>
                      <strong>Currently using environment variables.</strong>{' '}
                      Saving this form creates an encrypted Resy-managed override. Environment values remain available and can be restored later.
                    </>
                  ) : (
                    <>
                      <strong>Currently managed in Resy.</strong>{' '}
                      These saved values override the API container environment. Use Restore Environment Settings to remove the override.
                    </>
                  )}
                </div>
              </>
            ) : (
              <p className="subtle">Loading directory status...</p>
            )}
            <div className="email-config-grid">
              <div className="email-config-row">
                <label className="email-config-label">Directory Type</label>
                <select className="input" value={directoryForm.directory_type} onChange={(event) => setDirectoryForm(current => ({ ...current, directory_type: event.target.value as 'ad' | 'ldap' }))}>
                  <option value="ad">Active Directory</option>
                  <option value="ldap">Generic LDAP</option>
                </select>
              </div>
              <div className="email-config-row">
                <label className="email-config-label">Server URL</label>
                <input className="input" placeholder="ldaps://dc.company.com:636" value={directoryForm.server_url} onChange={(event) => setDirectoryForm(current => ({ ...current, server_url: event.target.value }))} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">Base DN</label>
                <input className="input" placeholder="DC=company,DC=com" value={directoryForm.base_dn} onChange={(event) => setDirectoryForm(current => ({ ...current, base_dn: event.target.value }))} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">Bind User</label>
                <input className="input" autoComplete="off" placeholder="CN=svc_ldap,OU=Service Accounts,DC=company,DC=com" value={directoryForm.bind_dn} onChange={(event) => setDirectoryForm(current => ({ ...current, bind_dn: event.target.value }))} />
              </div>
              <div className="email-config-row">
                <label className="email-config-label">Bind Password</label>
                <input className="input" type="password" autoComplete="new-password" placeholder={directoryStatus?.has_bind_password ? 'Configured — leave blank to keep it' : 'Enter bind password'} value={directoryForm.bind_password} onChange={(event) => setDirectoryForm(current => ({ ...current, bind_password: event.target.value }))} />
              </div>
              <div className="email-config-row">
                <label className="event-label directory-checkbox">
                  <input type="checkbox" checked={directoryForm.enabled} onChange={(event) => setDirectoryForm(current => ({ ...current, enabled: event.target.checked }))} />
                  Enable Directory Login
                </label>
              </div>
              <div className="email-config-row">
                <label className="email-config-label">CA Certificate Path</label>
                <input className="input" placeholder="/app/certs" value={directoryForm.ca_cert_path} onChange={(event) => setDirectoryForm(current => ({ ...current, ca_cert_path: event.target.value }))} />
                <span className="subtle directory-help">Private CA certificates must be mounted into the API container at this path.</span>
              </div>
              <div className="email-config-row">
                <label className="email-config-label">Allowed Login Groups</label>
                <textarea className="input directory-groups-input" rows={3} placeholder="One exact group CN or full DN per line (optional)" value={directoryForm.allowed_groups} onChange={(event) => setDirectoryForm(current => ({ ...current, allowed_groups: event.target.value }))} />
                <span className="subtle directory-help">Optional access gate. Leave blank to allow any directory user found under the Base DN.</span>
              </div>
              <div className={`email-config-row directory-role-field ${directoryForm.sync_roles ? '' : 'is-disabled'}`}>
                <label className="email-config-label">Administrator Groups</label>
                <textarea className="input directory-groups-input" rows={3} disabled={!directoryForm.sync_roles} placeholder="One exact group CN or full DN per line (optional)" value={directoryForm.admin_groups} onChange={(event) => setDirectoryForm(current => ({ ...current, admin_groups: event.target.value }))} />
                <span className="subtle directory-help">Used only when AD group role mapping is enabled.</span>
              </div>
              <div className={`email-config-row directory-role-field ${directoryForm.sync_roles ? '' : 'is-disabled'}`}>
                <label className="email-config-label">Room Manager Groups</label>
                <textarea className="input directory-groups-input" rows={3} disabled={!directoryForm.sync_roles} placeholder="One exact group CN or full DN per line (optional)" value={directoryForm.room_manager_groups} onChange={(event) => setDirectoryForm(current => ({ ...current, room_manager_groups: event.target.value }))} />
                <span className="subtle directory-help">Used only when AD group role mapping is enabled.</span>
              </div>
              <div className="directory-options-grid">
                <label className="event-label directory-checkbox">
                  <input type="checkbox" checked={directoryForm.tls_reject_unauthorized} onChange={(event) => setDirectoryForm(current => ({ ...current, tls_reject_unauthorized: event.target.checked }))} />
                  Verify TLS certificates
                </label>
                <label className="event-label directory-checkbox">
                  <input type="checkbox" checked={directoryForm.allow_local_fallback} onChange={(event) => setDirectoryForm(current => ({ ...current, allow_local_fallback: event.target.checked }))} />
                  Allow local-account fallback
                </label>
                <div className="directory-option">
                  <label className="event-label directory-checkbox">
                    <input type="checkbox" checked={directoryForm.sync_profile} onChange={(event) => setDirectoryForm(current => ({ ...current, sync_profile: event.target.checked }))} />
                    Refresh profile information from AD at every login
                  </label>
                  <span className="subtle directory-option-help">
                    Updates display name (displayName) and department (department). New directory users are initialized with these values either way.
                  </span>
                </div>
                <div className="directory-option">
                  <label className="event-label directory-checkbox">
                    <input type="checkbox" checked={directoryForm.sync_roles} onChange={(event) => setDirectoryForm(current => ({ ...current, sync_roles: event.target.checked }))} />
                    Map roles from AD groups
                  </label>
                  <span className="subtle directory-option-help">
                    When off, new directory users start as User and roles are managed in Admin → Users.
                  </span>
                </div>
                {directoryForm.server_url.trim().toLowerCase().startsWith('ldap://') && (
                  <label className="event-label directory-checkbox directory-warning-option">
                    <input type="checkbox" checked={directoryForm.allow_insecure_ldap} onChange={(event) => setDirectoryForm(current => ({ ...current, allow_insecure_ldap: event.target.checked }))} />
                    Allow cleartext LDAP (not recommended)
                  </label>
                )}
              </div>
              <p className="subtle directory-safety-note">
                Enabling Directory Login verifies the connection before saving. Keep local-account fallback enabled until an AD administrator has successfully signed in.
              </p>
              <div className="email-config-actions directory-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={directoryTestLoading || directorySaveLoading}
                  onClick={handleTestDirectoryConnection}
                >
                  {directoryTestLoading ? 'Checking...' : 'Check Connection'}
                </button>
                <button type="submit" className="btn btn-primary" disabled={directorySaveLoading || directoryTestLoading}>
                  {directorySaveLoading ? 'Saving...' : 'Save Directory Settings'}
                </button>
                {directoryStatus?.config_source === 'application' && (
                  <button type="button" className="btn btn-secondary" disabled={directorySaveLoading || directoryTestLoading} onClick={handleResetDirectoryConfig}>
                    Restore Environment Settings
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      )}

      {tab === 'users' && (
        <div className="admin-section">
          <div className="admin-form card">
            <h3>User Management</h3>
            <p className="subtle" style={{ marginBottom: '1rem' }}>
              Manage user roles and permissions. Room Manager access is workspace-wide, including all rooms and approvals. Reports Viewers can open and export Reports without administrative access. Existing administrative email recipients are managed under Notifications.
            </p>
            <div className="user-create card">
              <div className="user-create-header">
                <div>
                  <h4>Create Local User</h4>
                  <p className="subtle">Local accounts are available even when LDAP is disabled.</p>
                </div>
                <button className="btn btn-primary" onClick={handleCreateUser}>
                  Create User
                </button>
              </div>
              <div className="user-create-grid">
                <div className="user-create-row">
                  <label className="user-create-label">Full Name</label>
                  <input
                    className="input"
                    placeholder="Jane Doe"
                    value={newUser.name}
                    onChange={e => setNewUser({ ...newUser, name: e.target.value })}
                  />
                </div>
                <div className="user-create-row">
                  <label className="user-create-label">Email</label>
                  <input
                    className="input"
                    type="email"
                    placeholder="jane@company.com"
                    value={newUser.email}
                    onChange={e => setNewUser({ ...newUser, email: e.target.value })}
                  />
                </div>
                <div className="user-create-row">
                  <label className="user-create-label">Department (optional)</label>
                  <input
                    className="input"
                    placeholder="Operations"
                    value={newUser.department}
                    onChange={e => setNewUser({ ...newUser, department: e.target.value })}
                  />
                </div>
                <div className="user-create-row">
                  <label className="user-create-label">Role</label>
                  <select
                    className="input"
                    value={newUser.role}
                    onChange={e => {
                      const role = e.target.value;
                      const wasPrivileged = newUser.role === 'admin' || newUser.role === 'room_manager';
                      const isPrivileged = role === 'admin' || role === 'room_manager';
                      setNewUser({
                        ...newUser,
                        role,
                        receivesAdminNotifications: isPrivileged
                          ? (wasPrivileged ? newUser.receivesAdminNotifications : true)
                          : false,
                      });
                    }}
                  >
                    <option value="user">User</option>
                    <option value="room_manager">Room Manager</option>
                    <option value="report_viewer">Reports Viewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="user-create-row">
                  <label className="user-create-label">Temporary Password</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Minimum 8 characters"
                    value={newUser.password}
                    onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                  />
                </div>
                <div className="user-create-row">
                  <label className="event-label">
                    <input
                      type="checkbox"
                      checked={newUser.requirePasswordReset}
                      onChange={e => setNewUser({ ...newUser, requirePasswordReset: e.target.checked })}
                    />
                    Require password change on first login
                  </label>
                </div>
                <div className="user-create-row">
                  <label className="event-label">
                    <input
                      type="checkbox"
                      checked={newUser.receivesAdminNotifications}
                      disabled={newUser.role !== 'admin' && newUser.role !== 'room_manager'}
                      onChange={e => setNewUser({ ...newUser, receivesAdminNotifications: e.target.checked })}
                    />
                    Receive administrative booking emails
                  </label>
                </div>
              </div>
            </div>
            <div className="user-search">
              <input
                className="input"
                placeholder="Search users by name, email, or role"
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
              />
            </div>
            <div className="users-list">
              {users
                .filter(user => {
                  if (!userSearch.trim()) return true;
                  const q = userSearch.toLowerCase();
                  return (
                    user.name.toLowerCase().includes(q) ||
                    user.email.toLowerCase().includes(q) ||
                    user.role.toLowerCase().includes(q)
                  );
                })
                .map(user => (
                <div key={user.id} className="user-card card">
                  <div className="user-info">
                    <div className="user-header">
                      <span className="user-name">{user.name}</span>
                      <span className={`status-badge ${user.is_active ? 'enabled' : 'disabled'}`}>
                        {user.is_active ? 'Active' : 'Inactive'}
                      </span>
                      {user.must_reset_password ? (
                        <span className="status-badge warning">Password Reset Required</span>
                      ) : null}
                    </div>
                    <p className="user-email subtle">{user.email}</p>
                    {user.department && <p className="user-dept subtle">Department: {user.department}</p>}
                    <div className="user-stats">
                      <span className="user-stat">No-shows: {user.no_show_count}</span>
                      <span className="user-stat">Joined: {new Date(user.created_at).toLocaleDateString()}</span>
                      {(user.role === 'admin' || user.role === 'room_manager') && (
                        <span className="user-stat">
                          Admin email: {user.receives_admin_notifications ? 'On' : 'Off'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="user-actions">
                    <div className="user-role-row">
                      <label className="user-role-label">Role:</label>
                      <select
                        className="input user-role-select"
                        value={user.role}
                        onChange={e => handleUpdateUserRole(user.id, e.target.value)}
                      >
                        <option value="user">User</option>
                        <option value="room_manager">Room Manager</option>
                        <option value="report_viewer">Reports Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div className="user-btn-row">
                      <button
                        className={`btn ${user.is_active ? 'btn-danger' : 'btn-primary'}`}
                        onClick={() => handleToggleUserActive(user.id, user.is_active)}
                      >
                        {user.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button className="btn btn-secondary" onClick={() => handleResetUserPassword(user.id)}>
                        Reset Password
                      </button>
                      {user.no_show_count > 0 && (
                        <button className="btn btn-secondary" onClick={() => handleResetNoShowCount(user.id)}>
                          Reset No-Shows
                        </button>
                      )}
                      <button className="btn btn-danger" onClick={() => handleDeleteUser(user)}>
                        Delete User
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'retention' && <AdminRetention />}
      {tab === 'diagnostics' && <AdminDiagnostics />}
      {tab === 'reports' && <AdminReports />}

      {adminDialog && (
        <AdminActionDialog
          dialog={adminDialog}
          value={adminDialogValue}
          loading={adminDialogLoading}
          onValueChange={setAdminDialogValue}
          onCancel={() => setAdminDialog(null)}
          onConfirm={confirmAdminDialog}
        />
      )}
    </div>
  );
};
