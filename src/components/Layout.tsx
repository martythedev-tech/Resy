import { ReactNode, useEffect, useMemo, useState } from 'react';
import { NavLink, Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  Building2,
  BarChart3,
  CalendarDays,
  CalendarRange,
  ChevronRight,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { api, getApiOrigin } from '../config/api';
import { applyBrandingToDocument, resolveBrandAssetUrl } from '../utils/branding';
import '../styles/Layout.css';

const ADMIN_GROUPS = [
  { label: 'Spaces', items: [
    { key: 'buildings', label: 'Buildings', adminOnly: false },
    { key: 'rooms', label: 'Rooms', adminOnly: false },
    { key: 'hours', label: 'Business Hours', adminOnly: false },
    { key: 'technology', label: 'Technology', adminOnly: true },
    { key: 'approvals', label: 'Approvals', adminOnly: false },
  ]},
  { label: 'Policies', items: [
    { key: 'rules', label: 'Booking Rules', adminOnly: true },
  ]},
  { label: 'Insights', items: [
    { key: 'reports', label: 'Reports', adminOnly: false },
  ]},
  { label: 'Appearance', items: [
    { key: 'branding', label: 'Branding', adminOnly: true },
  ]},
  { label: 'System', items: [
    { key: 'notifications', label: 'Notifications', adminOnly: true },
    { key: 'directory', label: 'Directory', adminOnly: true },
    { key: 'users', label: 'Users', adminOnly: true },
    { key: 'retention', label: 'Data Retention', adminOnly: true },
    { key: 'diagnostics', label: 'Diagnostics', adminOnly: true },
  ]},
];

const API_BASE = getApiOrigin();
const APP_VERSION = __APP_VERSION__;
const BUILD_ID = __BUILD_ID__;
const RELEASE_CHANNEL = __RELEASE_CHANNEL__;

interface LayoutProps {
  children: ReactNode;
}

interface Branding {
  company_name: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  brand_tagline: string;
  logo_size: 'small' | 'medium' | 'large';
  favicon_url: string | null;
}

export const Layout = ({ children }: LayoutProps) => {
  const { isAuthenticated, logout, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const channelLabel = RELEASE_CHANNEL === 'release' ? 'release' : 'dev';
  const buildLabel = `v${APP_VERSION} [${channelLabel}] (${BUILD_ID})`;

  const isOnAdmin = location.pathname === '/admin';
  const requestedAdminSection = searchParams.get('s') || 'buildings';
  const adminSection = requestedAdminSection === 'email' || requestedAdminSection === 'webhooks'
    ? 'notifications'
    : requestedAdminSection;
  const isFullAdmin = user?.role === 'admin';
  const visibleAdminGroups = useMemo(() => ADMIN_GROUPS
    .map(group => ({
      ...group,
      items: group.items.filter(item => isFullAdmin || !item.adminOnly),
    }))
    .filter(group => group.items.length > 0), [isFullAdmin]);

  useEffect(() => {
    api.getBranding().then(data => {
      setBranding(data);
      applyBrandingToDocument({
        company_name: data.company_name,
        primary_color: data.primary_color,
        accent_color: data.accent_color,
        brand_tagline: data.brand_tagline,
        logo_size: data.logo_size,
        logo_url: resolveBrandAssetUrl(data.logo_url, API_BASE),
        favicon_url: resolveBrandAssetUrl(data.favicon_url, API_BASE),
      }, { theme });
    }).catch(() => {
      // Use defaults if branding fetch fails
    });
  }, [theme]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, location.search]);

  if (!isAuthenticated) {
    return <div>{children}</div>;
  }

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header className="mobile-header">
        <div className="mobile-brand">
          {branding?.logo_url ? (
            <img src={resolveBrandAssetUrl(branding.logo_url, API_BASE)} alt="" className="brand-logo" />
          ) : (
            <span className="brand-mark"><Building2 size={18} /></span>
          )}
          <span>{branding?.company_name || 'Rooms'}</span>
        </div>
        <button
          className="icon-button mobile-menu-button"
          type="button"
          onClick={() => setMobileNavOpen(open => !open)}
          aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileNavOpen}
        >
          {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <aside className={`sidebar${mobileNavOpen ? ' mobile-open' : ''}`}>
        <div className="brand">
          {branding?.logo_url ? (
            <img src={resolveBrandAssetUrl(branding.logo_url, API_BASE)} alt={branding.company_name} className="brand-logo" />
          ) : (
            <span className="brand-mark"><Building2 size={19} /></span>
          )}
          <span className="brand-copy">
            <span className="brand-name">{branding?.company_name || 'Rooms'}</span>
            <span className="brand-kicker">{branding?.brand_tagline ?? 'Room booking'}</span>
          </span>
          <button
            type="button"
            className="sidebar-collapse icon-button"
            onClick={() => setSidebarCollapsed(value => !value)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav className="nav">
          <div className="nav-section-label">Workspace</div>
          <NavLink to="/rooms" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <Building2 className="nav-icon" size={18} />
            <span className="nav-label">Rooms</span>
          </NavLink>
          <NavLink to="/calendar" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <CalendarRange className="nav-icon" size={18} />
            <span className="nav-label">Calendar</span>
          </NavLink>
          <NavLink to="/my-bookings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <CalendarDays className="nav-icon" size={18} />
            <span className="nav-label">My Bookings</span>
          </NavLink>
          {user?.role === 'report_viewer' && (
            <NavLink to="/reports" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <BarChart3 className="nav-icon" size={18} />
              <span className="nav-label">Reports</span>
            </NavLink>
          )}
          {(user?.role === 'admin' || user?.role === 'room_manager') && (
            <>
              <NavLink to="/admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                <Settings2 className="nav-icon" size={18} />
                <span className="nav-label">Admin</span>
              </NavLink>
              {isOnAdmin && (
                <div className="admin-sub-nav">
                  {visibleAdminGroups.map(group => (
                    <div key={group.label} className="admin-sub-group">
                      <div className="admin-sub-group-label">{group.label}</div>
                      {group.items.map(item => (
                        <Link
                          key={item.key}
                          to={`/admin?s=${item.key}`}
                          className={`admin-sub-link${adminSection === item.key ? ' active' : ''}`}
                        >
                          <span>{item.label}</span>
                          {adminSection === item.key && <ChevronRight size={13} />}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="account-card">
            <div className="avatar" aria-hidden="true">{user?.email?.charAt(0).toUpperCase()}</div>
            <div className="user-details">
              <div className="user-email">{user?.email}</div>
              <div className="user-role">
                {user?.role === 'admin' ? 'Administrator' :
                 user?.role === 'room_manager' ? 'Room manager' :
                 user?.role === 'report_viewer' ? 'Reports viewer' : 'Member'}
              </div>
            </div>
            <button onClick={toggleTheme} className="icon-button account-action" title={theme === 'dark' ? 'Use light mode' : 'Use dark mode'} aria-label={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}>
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button onClick={handleLogout} className="icon-button account-action logout-action" title="Log out" aria-label="Log out">
              <LogOut size={17} />
            </button>
          </div>
          <div className="build-info" title={`Build ${BUILD_ID} · Channel ${channelLabel}`}>{buildLabel}</div>
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
};
