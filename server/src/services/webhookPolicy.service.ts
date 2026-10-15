import { pool } from '../config/database';
import { normalizeWebhookOrigin, WebhookSecurityPolicy } from '../utils/webhookSecurity';

const MAX_INTERNAL_ORIGINS = 25;

function parseStoredOrigins(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export class WebhookPolicyService {
  async getPolicy(): Promise<WebhookSecurityPolicy> {
    const result = await pool.query(
      'SELECT allow_internal_destinations, allowed_internal_origins FROM webhook_security_config WHERE id = 1'
    );
    if (result.rows.length === 0) {
      return { allowInternalDestinations: false, allowedInternalOrigins: [] };
    }
    const row = result.rows[0] as any;
    return {
      allowInternalDestinations: Number(row.allow_internal_destinations) === 1,
      allowedInternalOrigins: parseStoredOrigins(row.allowed_internal_origins),
    };
  }

  normalizePolicy(input: unknown): WebhookSecurityPolicy {
    if (!input || typeof input !== 'object') throw new Error('Webhook security policy is required');
    const body = input as Record<string, unknown>;
    if (typeof body.allow_internal_destinations !== 'boolean') {
      throw new Error('Internal destination setting must be true or false');
    }
    if (!Array.isArray(body.allowed_internal_origins)) {
      throw new Error('Internal destination allowlist must be a list');
    }
    if (body.allowed_internal_origins.length > MAX_INTERNAL_ORIGINS) {
      throw new Error(`Internal destination allowlist cannot contain more than ${MAX_INTERNAL_ORIGINS} origins`);
    }

    const origins = Array.from(new Set(body.allowed_internal_origins.map(value => {
      if (typeof value !== 'string' || value.length > 300) {
        throw new Error('Each internal destination must be a valid origin under 300 characters');
      }
      return normalizeWebhookOrigin(value);
    })));

    if (body.allow_internal_destinations && origins.length === 0) {
      throw new Error('Add at least one internal origin before enabling internal webhook destinations');
    }
    return {
      allowInternalDestinations: body.allow_internal_destinations,
      allowedInternalOrigins: origins,
    };
  }

  async savePolicy(policy: WebhookSecurityPolicy): Promise<WebhookSecurityPolicy> {
    await pool.query(
      `INSERT INTO webhook_security_config
       (id, allow_internal_destinations, allowed_internal_origins, updated_at)
       VALUES (1, $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         allow_internal_destinations = excluded.allow_internal_destinations,
         allowed_internal_origins = excluded.allowed_internal_origins,
         updated_at = CURRENT_TIMESTAMP`,
      [policy.allowInternalDestinations ? 1 : 0, JSON.stringify(policy.allowedInternalOrigins)]
    );
    return policy;
  }
}

export const webhookPolicyService = new WebhookPolicyService();
