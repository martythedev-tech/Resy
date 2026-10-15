import { useState, FormEvent, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotification } from '../contexts/NotificationContext';
import { api, getApiOrigin } from '../config/api';
import { ArrowRight, Building2, CalendarCheck2, ShieldCheck } from 'lucide-react';
import '../styles/Login.css';
import { resolveBrandAssetUrl } from '../utils/branding';

const API_BASE = getApiOrigin();
const APP_VERSION = __APP_VERSION__;
const BUILD_ID = __BUILD_ID__;
const RELEASE_CHANNEL = __RELEASE_CHANNEL__;

export const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [branding, setBranding] = useState<{ company_name?: string; logo_url?: string | null } | null>(null);
  const { login } = useAuth();
  const { success, error } = useNotification();
  const navigate = useNavigate();
  const location = useLocation();
  const channelLabel = RELEASE_CHANNEL === 'release' ? 'release' : 'dev';
  const buildLabel = `v${APP_VERSION} [${channelLabel}] (${BUILD_ID})`;

  useEffect(() => {
    const loadBranding = async () => {
      try {
        const data = await api.getBranding();
        setBranding(data);
      } catch {
        setBranding(null);
      }
    };
    loadBranding();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const loggedInUser = await login(email, password);
      if (loggedInUser) {
        success('Welcome back! Logged in successfully.');
        if (loggedInUser.must_reset_password) {
          navigate('/force-password');
        } else {
          const requestedDestination = (location.state as { from?: string } | null)?.from;
          const destination = requestedDestination?.startsWith('/') && !requestedDestination.startsWith('//')
            ? requestedDestination
            : (loggedInUser.role === 'report_viewer' ? '/reports' : '/rooms');
          navigate(destination, { replace: true });
        }
      } else {
        error('Invalid email or password. Please try again.');
      }
    } catch (err) {
      error('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-shell">
        <section className="login-intro" aria-label="About the room booking workspace">
          <div className="login-brand">
            {branding?.logo_url ? (
              <img src={resolveBrandAssetUrl(branding.logo_url, API_BASE)} alt="" className="login-brand-logo" />
            ) : (
              <span className="login-brand-mark"><Building2 size={22} /></span>
            )}
            <span>{branding?.company_name || 'Rooms'}</span>
          </div>
          <div className="login-intro-copy">
            <span className="eyebrow">Workplace scheduling</span>
            <h1>Make space for<br />better work.</h1>
            <p>Find the right room, see what is available, and keep every meeting on schedule.</p>
          </div>
          <div className="login-benefits" aria-hidden="true">
            <span><CalendarCheck2 size={17} /> Live availability</span>
            <span><ShieldCheck size={17} /> Managed booking rules</span>
          </div>
        </section>

        <section className="login-card">
          <div className="login-header">
            <span className="eyebrow">Welcome back</span>
            <h2>Sign in to your workspace</h2>
            <p>Use your organization credentials to continue.</p>
          </div>

          <form onSubmit={handleSubmit} className="login-form">
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                className="input"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="username"
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                className="input"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <button type="submit" className="btn btn-primary login-btn" disabled={loading}>
              <span>{loading ? 'Signing in…' : 'Sign in'}</span>
              {!loading && <ArrowRight size={17} />}
            </button>
          </form>
          <div className="login-build-info" title={`Build ${BUILD_ID} · Channel ${channelLabel}`}>{buildLabel}</div>
        </section>
      </div>
    </div>
  );
};
