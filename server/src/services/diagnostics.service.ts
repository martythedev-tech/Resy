import { randomUUID } from 'crypto';
import db from '../config/database';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticEventInput {
  severity: DiagnosticSeverity;
  source: string;
  category: string;
  message: string;
  requestId?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  userId?: number | null;
  metadata?: Record<string, unknown> | null;
}

type OperationalEventInput = Omit<DiagnosticEventInput, 'severity'>;

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|credential|webhook|smtp|bind|body/i;
let lastCleanupAt = 0;

const clampRetentionDays = () => {
  const configured = Number(process.env.DIAGNOSTIC_RETENTION_DAYS || 30);
  if (!Number.isFinite(configured)) return 30;
  return Math.min(365, Math.max(1, Math.floor(configured)));
};

const sanitizeMetadata = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return '[truncated]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeMetadata(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .slice(0, 30)
      .map(([key, item]) => [key, sanitizeMetadata(item, depth + 1)]));
  }
  return String(value).slice(0, 500);
};

const cleanupIfNeeded = () => {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = now;
  const retentionDays = clampRetentionDays();
  db.prepare("DELETE FROM diagnostic_events WHERE created_at < datetime('now', ?)")
    .run(`-${retentionDays} days`);
  db.prepare(`DELETE FROM diagnostic_events
    WHERE id NOT IN (SELECT id FROM diagnostic_events ORDER BY id DESC LIMIT 5000)`)
    .run();
};

export const recordDiagnosticEvent = (event: DiagnosticEventInput) => {
  try {
    cleanupIfNeeded();
    const metadata = event.metadata ? JSON.stringify(sanitizeMetadata(event.metadata)) : null;
    db.prepare(`
      INSERT INTO diagnostic_events
        (severity, source, category, message, request_id, method, path, status_code, user_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.severity,
      event.source.slice(0, 64),
      event.category.slice(0, 64),
      event.message.slice(0, 500),
      event.requestId || null,
      event.method?.slice(0, 12) || null,
      event.path?.slice(0, 300) || null,
      event.statusCode || null,
      event.userId || null,
      metadata,
    );
  } catch (error: any) {
    console.error('Diagnostic event write failed:', error?.code || error?.name || 'UNKNOWN');
  }
};

interface SafeErrorIdentity {
  error_name?: string;
  error_code?: string;
}

const safeErrorIdentity = (error: unknown): SafeErrorIdentity => {
  if (!error || typeof error !== 'object') return { error_name: 'UnknownError' };
  const candidate = error as { name?: unknown; code?: unknown };
  const errorName = typeof candidate.name === 'string' ? candidate.name.slice(0, 100) : 'Error';
  const errorCode = typeof candidate.code === 'string' || typeof candidate.code === 'number'
    ? String(candidate.code).slice(0, 100)
    : undefined;
  return errorCode ? { error_name: errorName, error_code: errorCode } : { error_name: errorName };
};

// Operational helpers deliberately retain only an error's name/code. Error
// messages and stacks may contain credentials, addresses, or provider URLs.
export const recordOperationalError = (event: OperationalEventInput, error?: unknown) => {
  const identity = safeErrorIdentity(error);
  console.error(`${event.message}:`, identity.error_code || identity.error_name);
  recordDiagnosticEvent({
    ...event,
    severity: 'error',
    metadata: { ...(event.metadata || {}), ...identity },
  });
};

export const recordOperationalWarning = (event: OperationalEventInput, error?: unknown) => {
  const identity: SafeErrorIdentity = error === undefined ? {} : safeErrorIdentity(error);
  console.warn(`${event.message}${identity.error_code || identity.error_name ? `: ${identity.error_code || identity.error_name}` : ''}`);
  recordDiagnosticEvent({
    ...event,
    severity: 'warning',
    metadata: { ...(event.metadata || {}), ...identity },
  });
};

export const createRequestId = () => randomUUID();

export const getDiagnosticRetentionDays = clampRetentionDays;
