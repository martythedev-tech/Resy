import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, Clock3, Database, Mail, Network, RefreshCw, Search, Server } from 'lucide-react';
import { api } from '../../config/api';
import { useNotification } from '../../contexts/NotificationContext';

interface DiagnosticEvent {
  id: number;
  created_at: string;
  severity: 'info' | 'warning' | 'error';
  source: string;
  category: string;
  message: string;
  request_id: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  metadata: Record<string, unknown> | null;
}

interface DiagnosticsSummary {
  api: { status: string; uptime_seconds: number };
  database: { status: string };
  email: { status: string };
  directory: { status: string };
  errors_24h: number;
  warnings_24h: number;
  latest_event_at: string | null;
  retention_days: number;
}

const formatEventTime = (timestamp: string) => {
  const normalized = timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
};

export const AdminDiagnostics = () => {
  const { error } = useNotification();
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState('');
  const [source, setSource] = useState('');
  const [total, setTotal] = useState(0);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    try {
      const [eventsResult, summaryResult] = await Promise.all([
        api.getDiagnostics({
          query: query.trim() || undefined,
          severity: severity || undefined,
          source: source || undefined,
          limit: 100,
        }),
        api.getDiagnosticsSummary(),
      ]);
      setEvents(eventsResult.events || []);
      setTotal(Number(eventsResult.total || 0));
      setSummary(summaryResult);
    } catch (caught: unknown) {
      error(caught instanceof Error ? caught.message : 'Failed to load diagnostics');
    } finally {
      setLoading(false);
    }
  }, [error, query, severity, source]);

  useEffect(() => {
    fetchDiagnostics();
    // Filters are applied explicitly so typing does not issue a request per keystroke.
  }, []);

  const sources = useMemo(() => Array.from(new Set(events.map(item => item.source))).sort(), [events]);
  const healthItems = [
    { label: 'API', icon: Server, status: summary?.api.status || 'checking', detail: summary ? `${Math.floor(summary.api.uptime_seconds / 3600)}h uptime` : 'Loading' },
    { label: 'Database', icon: Database, status: summary?.database.status || 'checking', detail: 'SQLite storage' },
    {
      label: 'Email',
      icon: Mail,
      status: summary?.email.status || 'checking',
      detail: summary?.email.status === 'configured' ? 'Configured · delivery not tested' : 'Outbound notifications',
    },
    {
      label: 'Directory',
      icon: Network,
      status: summary?.directory.status || 'checking',
      detail: summary?.directory.status === 'configured' ? 'Configured · connection not tested' : 'Authentication source',
    },
  ];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    fetchDiagnostics();
  };

  return (
    <div className="admin-section diagnostics-section">
      <div className="diagnostics-health-grid">
        {healthItems.map(item => {
          const Icon = item.icon;
          const healthy = item.status === 'operational' || item.status === 'configured';
          return (
            <div key={item.label} className="diagnostic-health-card card">
              <span className={`health-icon${healthy ? ' healthy' : ''}`}><Icon size={18} /></span>
              <div><span className="health-label">{item.label}</span><span className="health-detail">{item.detail}</span></div>
              <span className={`health-status ${item.status}`}>{item.status}</span>
            </div>
          );
        })}
      </div>

      <div className="diagnostic-summary-row">
        <div><AlertCircle size={16} /><strong>{summary?.errors_24h || 0}</strong><span>errors in 24h</span></div>
        <div><Activity size={16} /><strong>{summary?.warnings_24h || 0}</strong><span>warnings in 24h</span></div>
        <div><Clock3 size={16} /><span>Retained for <strong>{summary?.retention_days || 30} days</strong></span></div>
      </div>

      <div className="diagnostics-panel card">
        <div className="diagnostics-panel-header">
          <div><h3>Operational events</h3><p>Sanitized security, HTTP 500, integration, and background-service events. Rejected sign-ins never store the attempted identity, password, or IP address; routine form validation remains excluded.</p></div>
          <button className="btn btn-secondary" onClick={fetchDiagnostics} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
        <form className="diagnostics-filters" onSubmit={handleSubmit}>
          <div className="diagnostic-search"><Search size={15} /><input className="input" placeholder="Search message, path, or request ID" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <select className="input" aria-label="Severity" value={severity} onChange={event => setSeverity(event.target.value)}>
            <option value="">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option>
          </select>
          <select className="input" aria-label="Source" value={source} onChange={event => setSource(event.target.value)}>
            <option value="">All sources</option>
            {sources.map(sourceName => <option key={sourceName} value={sourceName}>{sourceName}</option>)}
          </select>
          <button className="btn btn-primary" type="submit">Apply</button>
        </form>

        <div className="diagnostics-count">Showing {events.length} of {total} events</div>
        <div className="diagnostics-list">
          {events.map(event => (
            <details key={event.id} className={`diagnostic-event ${event.severity}`}>
              <summary>
                <span className="diagnostic-severity">{event.severity === 'error' ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}</span>
                <span className="diagnostic-message">{event.message}</span>
                <span className="diagnostic-source">{event.source}</span>
                <time dateTime={event.created_at}>{formatEventTime(event.created_at)}</time>
              </summary>
              <div className="diagnostic-event-details">
                <div><span>Category</span><strong>{event.category}</strong></div>
                {event.method && <div><span>Request</span><strong>{event.method} {event.path}</strong></div>}
                {event.status_code && <div><span>Status</span><strong>{event.status_code}</strong></div>}
                {event.request_id && <div><span>Request ID</span><code>{event.request_id}</code></div>}
                {event.metadata && <div><span>Metadata</span><code>{JSON.stringify(event.metadata)}</code></div>}
              </div>
            </details>
          ))}
          {!loading && events.length === 0 && (
            <div className="diagnostics-empty"><CheckCircle2 size={24} /><h3>No matching events</h3><p>The system has no diagnostic events matching these filters.</p></div>
          )}
        </div>
      </div>
    </div>
  );
};
