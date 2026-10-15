import { safeStorage } from '../utils/storage';

export const getApiBaseUrl = () => import.meta.env.VITE_API_URL || '/api';

export const getApiOrigin = () => {
  const base = getApiBaseUrl();
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return base.replace(/\/api\/?$/, '');
  }
  return window.location.origin;
};

const API_BASE_URL = getApiBaseUrl();

const cleanParams = (params?: Record<string, any>): Record<string, string> => {
  if (!params) return {};
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
};

let memoryToken: string | null = null;

const getAuthToken = () => {
  return safeStorage.getItem('auth_token') || memoryToken;
};

export const api = {
  async request(endpoint: string, options: RequestInit = {}) {
    const token = getAuthToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
      cache: options.cache ?? 'no-store',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      if (response.status === 401) {
        memoryToken = null;
        safeStorage.removeItem('auth_token');
        safeStorage.removeItem('user');
        window.dispatchEvent(new Event('auth-expired'));
      }
      throw new Error(error.error || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  },

  // Auth endpoints
  async login(email: string, password: string) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data.token) {
      memoryToken = data.token;
      safeStorage.setItem('auth_token', data.token);
      safeStorage.setItem('user', JSON.stringify(data.user));
    }
    return data;
  },

  async register(email: string, password: string, name: string, department?: string) {
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, department }),
    });
    if (data.token) {
      memoryToken = data.token;
      safeStorage.setItem('auth_token', data.token);
      safeStorage.setItem('user', JSON.stringify(data.user));
    }
    return data;
  },

  async getMe() {
    return this.request('/auth/me');
  },

  logout() {
    memoryToken = null;
    safeStorage.removeItem('auth_token');
    safeStorage.removeItem('user');
  },

  // Rooms endpoints
  async getRooms(params?: { building?: string; min_capacity?: number; equipment?: string }) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    return this.request(`/rooms${query ? `?${query}` : ''}`);
  },

  async getRoom(id: string) {
    return this.request(`/rooms/${id}`);
  },

  async getRoomAvailability(id: string, date?: string) {
    const query = date ? `?date=${date}` : '';
    return this.request(`/rooms/${id}/availability${query}`);
  },

  // Bookings endpoints
  async getBookings(params?: { room_id?: string; start_date?: string; end_date?: string; status?: string }) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    return this.request(`/bookings${query ? `?${query}` : ''}`);
  },

  async getMyBookings(params?: { scope?: 'upcoming' | 'history'; limit?: number; offset?: number }) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    return this.request(`/bookings/my-bookings${query ? `?${query}` : ''}`);
  },

  async createBooking(booking: {
    room_id: number;
    title: string;
    start_time: string;
    end_time: string;
    attendees?: string[];
    attendee_count?: number | null;
    equipment?: string[];
    notes?: string;
    custom_fields?: Record<string, any>;
    is_recurring?: boolean;
    recurrence?: any;
  }) {
    return this.request('/bookings', {
      method: 'POST',
      body: JSON.stringify(booking),
    });
  },

  async getBookingTemplates() {
    return this.request('/bookings/templates');
  },

  async createBookingTemplate(template: {
    name: string;
    title: string;
    duration_minutes: number;
    equipment?: string[];
    notes?: string;
    custom_fields?: Record<string, any>;
  }) {
    return this.request('/bookings/templates', {
      method: 'POST',
      body: JSON.stringify(template),
    });
  },

  async updateBookingTemplate(id: number, updates: {
    name?: string;
    title?: string;
    duration_minutes?: number;
    equipment?: string[];
    notes?: string;
    custom_fields?: Record<string, any>;
  }) {
    return this.request(`/bookings/templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteBookingTemplate(id: number) {
    return this.request(`/bookings/templates/${id}`, {
      method: 'DELETE',
    });
  },

  async updateBooking(id: string, updates: Partial<{
    title: string;
    attendees: string[];
    attendee_count: number | null;
    equipment: string[];
    notes: string;
    custom_fields: Record<string, any>;
    start_time: string;
    end_time: string;
    series_scope: 'single' | 'following';
  }>) {
    return this.request(`/bookings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async cancelBooking(id: string, reason?: string, seriesScope: 'single' | 'following' = 'single') {
    return this.request(`/bookings/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason, series_scope: seriesScope }),
    });
  },

  async checkInBooking(id: string) {
    return this.request(`/bookings/${id}/check-in`, {
      method: 'POST',
    });
  },

  // Admin endpoints

  async getBookingRules() {
    return this.request('/admin/rules');
  },

  async updateRule(id: string, updates: Partial<{ value: number; unit: string; is_enabled: boolean; description: string }>) {
    return this.request(`/admin/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async getReports(params?: { start_date?: string; end_date?: string; room_id?: number }) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    return this.request(`/admin/analytics${query ? `?${query}` : ''}`);
  },

  // Building endpoints
  async getBuildings() {
    return this.request('/admin/buildings');
  },

  async createBuilding(building: { name: string; description?: string; business_hours?: any }) {
    return this.request('/admin/buildings', {
      method: 'POST',
      body: JSON.stringify(building),
    });
  },

  async updateBuilding(id: number, updates: Partial<{ name: string; description: string; is_active: number; business_hours?: any }>) {
    return this.request(`/admin/buildings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteBuilding(id: number) {
    return this.request(`/admin/buildings/${id}`, {
      method: 'DELETE',
    });
  },

  async uploadBuildingImage(id: number, file: File) {
    const formData = new FormData();
    formData.append('image', file);
    const token = safeStorage.getItem('auth_token');
    const response = await fetch(`${API_BASE_URL}/admin/buildings/${id}/image`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error);
    }
    return response.json();
  },

  // Room admin endpoints
  async getAdminRooms() {
    return this.request('/admin/rooms');
  },

  async deleteRoom(id: number) {
    return this.request(`/admin/rooms/${id}`, {
      method: 'DELETE',
    });
  },

  async uploadRoomImage(id: number, file: File) {
    const formData = new FormData();
    formData.append('image', file);
    const token = safeStorage.getItem('auth_token');
    const response = await fetch(`${API_BASE_URL}/admin/rooms/${id}/image`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error);
    }
    return response.json();
  },

  async createRoom(room: {
    name: string;
    building: string;
    floor: number;
    capacity: number;
    equipment?: string[];
    business_hours?: any;
    min_duration_minutes?: number | null;
    max_duration_minutes?: number | null;
    buffer_minutes?: number | null;
    requires_approval?: number;
  }) {
    return this.request('/admin/rooms', {
      method: 'POST',
      body: JSON.stringify(room),
    });
  },

  async updateRoom(id: number, updates: {
    name?: string;
    building?: string;
    floor?: number;
    capacity?: number;
    equipment?: string[];
    is_active?: number;
    business_hours?: any;
    min_duration_minutes?: number | null;
    max_duration_minutes?: number | null;
    buffer_minutes?: number | null;
    requires_approval?: number;
  }) {
    return this.request(`/admin/rooms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  // Webhook endpoints
  async getWebhookPolicy() {
    return this.request('/admin/webhook-policy');
  },

  async updateWebhookPolicy(policy: { allow_internal_destinations: boolean; allowed_internal_origins: string[] }) {
    return this.request('/admin/webhook-policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    });
  },

  async getWebhooks() {
    return this.request('/admin/webhooks');
  },

  async createWebhook(webhook: { service_type: string; webhook_url: string; events: string[] }) {
    return this.request('/admin/webhooks', {
      method: 'POST',
      body: JSON.stringify(webhook),
    });
  },

  async updateWebhook(id: number, updates: Partial<{ webhook_url: string; is_enabled: boolean; events: string[] }>) {
    return this.request(`/admin/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteWebhook(id: number) {
    return this.request(`/admin/webhooks/${id}`, {
      method: 'DELETE',
    });
  },

  // Email config endpoints
  async getEmailConfig() {
    return this.request('/admin/email-config');
  },

  async updateEmailConfig(config: {
    smtp_host: string;
    smtp_port: number;
    smtp_user: string;
    smtp_password: string;
    from_email: string;
    from_name: string;
    is_enabled: number;
  }) {
    return this.request('/admin/email-config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async testEmail(to: string) {
    return this.request('/admin/email-config/test', {
      method: 'POST',
      body: JSON.stringify({ to }),
    });
  },

  // Public settings
  async getSettings() {
    return this.request('/settings');
  },

  // Public branding (no auth required)
  async getBranding() {
    return this.request('/branding');
  },

  // Site config (admin)
  async getSiteConfig() {
    return this.request('/admin/site-config');
  },

  async getRetentionSummary() {
    return this.request('/admin/retention');
  },

  async updateRetentionConfig(config: {
    retention_months: number;
    backup_retention_days: number;
    enabled: boolean;
    confirm_backups: boolean;
  }) {
    return this.request('/admin/retention', { method: 'PUT', body: JSON.stringify(config) });
  },

  async runRetention(confirm: boolean) {
    return this.request('/admin/retention/run', { method: 'POST', body: JSON.stringify({ confirm }) });
  },

  async searchRetentionBookings(query: string) {
    return this.request(`/admin/retention/bookings?q=${encodeURIComponent(query)}`);
  },

  async setBookingRetentionHold(id: number, hold: boolean) {
    return this.request(`/admin/bookings/${id}/retention-hold`, { method: 'PATCH', body: JSON.stringify({ hold }) });
  },

  async updateSiteConfig(config: {
    company_name?: string;
    logo_url?: string | null;
    primary_color?: string;
    accent_color?: string;
    brand_tagline?: string;
    logo_size?: 'small' | 'medium' | 'large';
    favicon_url?: string | null;
    timezone?: string;
    calendar_default_view?: 'day' | 'week' | 'month';
    equipment_options?: string[];
    custom_fields?: any[];
  }) {
    return this.request('/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async uploadLogo(file: File) {
    const formData = new FormData();
    formData.append('logo', file);
    const token = safeStorage.getItem('auth_token');
    const response = await fetch(`${API_BASE_URL}/admin/site-config/logo`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error);
    }
    return response.json();
  },

  async uploadFavicon(file: File) {
    const formData = new FormData();
    formData.append('favicon', file);
    const token = safeStorage.getItem('auth_token');
    const response = await fetch(`${API_BASE_URL}/admin/site-config/favicon`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error);
    }
    return response.json();
  },

  // User management (admin)
  async getUsers() {
    return this.request('/admin/users');
  },

  async updateUser(
    id: number,
    updates: {
      role?: string;
      is_active?: number;
      no_show_count?: number;
      receives_admin_notifications?: number;
    }
  ) {
    return this.request(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async getPendingBookings() {
    return this.request('/admin/bookings/pending');
  },

  async approveBooking(id: number) {
    return this.request(`/admin/bookings/${id}/approve`, { method: 'POST' });
  },

  async rejectBooking(id: number, reason?: string) {
    return this.request(`/admin/bookings/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async createUser(user: {
    email: string;
    password: string;
    name: string;
    department?: string;
    role?: string;
    must_reset_password?: boolean;
    receives_admin_notifications?: boolean;
  }) {
    return this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify(user),
    });
  },

  async resetUserPassword(id: number, password: string) {
    return this.request(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  async deleteUser(id: number) {
    return this.request(`/admin/users/${id}`, {
      method: 'DELETE',
    });
  },

  async getDirectoryStatus() {
    return this.request('/admin/directory/status');
  },

  async updateDirectoryConfig(config: object) {
    return this.request('/admin/directory/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async resetDirectoryConfig() {
    return this.request('/admin/directory/config', { method: 'DELETE' });
  },

  async testDirectoryConnection(config?: object) {
    return this.request('/admin/directory/test', {
      method: 'POST',
      ...(config ? { body: JSON.stringify(config) } : {}),
    });
  },

  async getDiagnostics(params?: { query?: string; severity?: string; source?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    return this.request(`/admin/diagnostics${query ? `?${query}` : ''}`);
  },

  async getDiagnosticsSummary() {
    return this.request('/admin/diagnostics/summary');
  },

  async changePassword(currentPassword: string, newPassword: string) {
    const data = await this.request('/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (data.token) {
      memoryToken = data.token;
      safeStorage.setItem('auth_token', data.token);
      safeStorage.setItem('user', JSON.stringify(data.user));
    }
    return data;
  },
};
