import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'ldapts';
import db from '../config/database';
import { recordOperationalWarning } from './diagnostics.service';

type DirectoryType = 'ad' | 'ldap';
type AppRole = 'user' | 'admin' | 'room_manager';

export interface DirectoryConfig {
  enabled: boolean;
  type: DirectoryType;
  url: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  caCertPath: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
  allowInsecureLdap: boolean;
  allowLocalFallback: boolean;
  syncRoles: boolean;
  syncProfile: boolean;
  allowedGroups: string[];
  adminGroups: string[];
  roomManagerGroups: string[];
}

export interface DirectoryConfigInput {
  enabled?: unknown;
  directory_type?: unknown;
  server_url?: unknown;
  base_dn?: unknown;
  bind_dn?: unknown;
  bind_password?: unknown;
  ca_cert_path?: unknown;
  tls_reject_unauthorized?: unknown;
  allow_insecure_ldap?: unknown;
  allow_local_fallback?: unknown;
  sync_roles?: unknown;
  sync_profile?: unknown;
  allowed_groups?: unknown;
  admin_groups?: unknown;
  room_manager_groups?: unknown;
  timeout_ms?: unknown;
  connect_timeout_ms?: unknown;
}

export interface DirectoryIdentity {
  email: string;
  name: string;
  department: string | null;
  role: AppRole;
  groups: string[];
  userDn: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  const separator = /[;\n]/.test(value) ? /[;\n]/ : /^\s*(cn|ou|dc)=/i.test(value) ? null : ',';
  return (separator ? value.split(separator) : [value])
    .map(v => v.trim())
    .filter(Boolean);
}

function parseStoredList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(item => String(item).trim()).filter(Boolean);
  } catch {
    // Accept newline/semicolon-separated input from the administrator form.
  }
  return value.split(/[;\n]/).map(item => item.trim()).filter(Boolean);
}

function inputBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw new Error('Invalid directory boolean setting');
}

function boundedString(value: unknown, label: string, max: number, required = false): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return result;
}

function encryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required to protect the directory bind password');
  return crypto.createHash('sha256').update(`resy-directory-config:${secret}`).digest();
}

function encryptSecret(value: string): string {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(value: string): string {
  if (!value) return '';
  try {
    const [version, iv, tag, encrypted] = value.split(':');
    if (version !== 'v1' || !iv || !tag || !encrypted) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function loadCaCertificates(inputPath: string): string[] | undefined {
  const resolvedPath = inputPath.trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return undefined;
  }

  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    const certs = fs.readdirSync(resolvedPath)
      .filter(name => /\.(pem|crt|cer)$/i.test(name))
      .sort()
      .map(name => fs.readFileSync(path.join(resolvedPath, name), 'utf8'))
      .filter(Boolean);
    return certs.length ? certs : undefined;
  }

  return [fs.readFileSync(resolvedPath, 'utf8')];
}

function escapeLdapValue(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

function firstAttribute(entry: Record<string, any>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = entry[key];
    if (Array.isArray(value)) {
      const first = value.find(v => typeof v === 'string' && v.trim().length > 0);
      if (first) return String(first);
    } else if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function attributeList(entry: Record<string, any>, key: string): string[] {
  const value = entry[key];
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v)).filter(Boolean);
  }
  return [String(value)];
}

function extractCn(dn: string): string {
  const match = dn.match(/cn=([^,]+)/i);
  return match ? match[1].trim().toLowerCase() : '';
}

export function groupMatches(groupDn: string, configuredToken: string): boolean {
  const token = configuredToken.trim().toLowerCase();
  if (!token) return false;
  const group = groupDn.trim().toLowerCase();
  if (token.includes('=')) {
    return group === token;
  }
  return extractCn(group) === token;
}

function detectRole(groups: string[], adminGroups: string[], roomManagerGroups: string[]): AppRole {
  if (groups.some(g => adminGroups.some(c => groupMatches(g, c)))) {
    return 'admin';
  }
  if (groups.some(g => roomManagerGroups.some(c => groupMatches(g, c)))) {
    return 'room_manager';
  }
  return 'user';
}

function isGroupAllowed(groups: string[], allowedGroups: string[]): boolean {
  if (!allowedGroups.length) {
    return true;
  }
  return groups.some(g => allowedGroups.some(c => groupMatches(g, c)));
}

function isInvalidUserCredentialError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return Number(candidate.code) === 49 || /invalidcredentials/i.test(String(candidate.name || ''));
}

export class DirectoryAuthService {
  private getEnvironmentConfig(): DirectoryConfig {
    return {
      enabled: parseBoolean(process.env.ENABLE_DIRECTORY_AUTH, false),
      type: (String(process.env.DIRECTORY_TYPE || 'ad').toLowerCase() === 'ldap' ? 'ldap' : 'ad'),
      url: String(process.env.DIRECTORY_URL || '').trim(),
      baseDn: String(process.env.DIRECTORY_BASE_DN || '').trim(),
      bindDn: String(process.env.DIRECTORY_BIND_DN || '').trim(),
      bindPassword: String(process.env.DIRECTORY_BIND_PASSWORD || ''),
      caCertPath: String(process.env.DIRECTORY_CA_CERT_PATH || '').trim(),
      timeoutMs: Number(process.env.DIRECTORY_TIMEOUT_MS || 8000),
      connectTimeoutMs: Number(process.env.DIRECTORY_CONNECT_TIMEOUT_MS || 5000),
      tlsRejectUnauthorized: parseBoolean(process.env.DIRECTORY_TLS_REJECT_UNAUTHORIZED, true),
      allowInsecureLdap: parseBoolean(process.env.DIRECTORY_ALLOW_INSECURE_LDAP, false),
      allowLocalFallback: parseBoolean(process.env.DIRECTORY_ALLOW_LOCAL_FALLBACK, true),
      syncRoles: parseBoolean(process.env.DIRECTORY_SYNC_ROLES, true),
      syncProfile: parseBoolean(process.env.DIRECTORY_SYNC_PROFILE, true),
      allowedGroups: parseCsv(process.env.DIRECTORY_ALLOWED_GROUPS),
      adminGroups: parseCsv(process.env.DIRECTORY_ADMIN_GROUPS),
      roomManagerGroups: parseCsv(process.env.DIRECTORY_ROOM_MANAGER_GROUPS),
    };
  }

  private getStoredRow(): any | null {
    try {
      return db.prepare('SELECT * FROM directory_config WHERE id = 1').get() as any || null;
    } catch {
      return null;
    }
  }

  getConfig(): DirectoryConfig {
    const row = this.getStoredRow();
    if (!row) return this.getEnvironmentConfig();
    return {
      enabled: Number(row.is_enabled) === 1,
      type: row.directory_type === 'ldap' ? 'ldap' : 'ad',
      url: String(row.server_url || '').trim(),
      baseDn: String(row.base_dn || '').trim(),
      bindDn: String(row.bind_dn || '').trim(),
      bindPassword: decryptSecret(String(row.bind_password_encrypted || '')),
      caCertPath: String(row.ca_cert_path || '').trim(),
      timeoutMs: Number(row.timeout_ms) || 8000,
      connectTimeoutMs: Number(row.connect_timeout_ms) || 5000,
      tlsRejectUnauthorized: Number(row.tls_reject_unauthorized) === 1,
      allowInsecureLdap: Number(row.allow_insecure_ldap) === 1,
      allowLocalFallback: Number(row.allow_local_fallback) === 1,
      syncRoles: Number(row.sync_roles) === 1,
      syncProfile: Number(row.sync_profile) === 1,
      allowedGroups: parseStoredList(row.allowed_groups),
      adminGroups: parseStoredList(row.admin_groups),
      roomManagerGroups: parseStoredList(row.room_manager_groups),
    };
  }

  getConfigSource(): 'application' | 'environment' {
    return this.getStoredRow() ? 'application' : 'environment';
  }

  buildConfig(input: DirectoryConfigInput): DirectoryConfig {
    const current = this.getConfig();
    const type = input.directory_type === undefined ? current.type : String(input.directory_type).toLowerCase();
    if (type !== 'ad' && type !== 'ldap') throw new Error('Directory type must be Active Directory or LDAP');
    const enabled = inputBoolean(input.enabled, current.enabled);
    const url = boundedString(input.server_url ?? current.url, 'Server URL', 500, enabled);
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('Server URL must be a valid ldap:// or ldaps:// URL'); }
      if (!['ldap:', 'ldaps:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('Server URL must use ldap:// or ldaps://');
      }
    }
    const bindPasswordInput = typeof input.bind_password === 'string' ? input.bind_password : '';
    const config: DirectoryConfig = {
      enabled,
      type,
      url,
      baseDn: boundedString(input.base_dn ?? current.baseDn, 'Base DN', 1000, enabled),
      bindDn: boundedString(input.bind_dn ?? current.bindDn, 'Bind DN', 1000, enabled),
      bindPassword: bindPasswordInput || current.bindPassword,
      caCertPath: boundedString(input.ca_cert_path ?? current.caCertPath, 'CA certificate path', 1000),
      timeoutMs: Number(input.timeout_ms ?? current.timeoutMs),
      connectTimeoutMs: Number(input.connect_timeout_ms ?? current.connectTimeoutMs),
      tlsRejectUnauthorized: inputBoolean(input.tls_reject_unauthorized, current.tlsRejectUnauthorized),
      allowInsecureLdap: inputBoolean(input.allow_insecure_ldap, current.allowInsecureLdap),
      allowLocalFallback: inputBoolean(input.allow_local_fallback, current.allowLocalFallback),
      syncRoles: inputBoolean(input.sync_roles, current.syncRoles),
      syncProfile: inputBoolean(input.sync_profile, current.syncProfile),
      allowedGroups: input.allowed_groups === undefined ? current.allowedGroups : parseStoredList(input.allowed_groups),
      adminGroups: input.admin_groups === undefined ? current.adminGroups : parseStoredList(input.admin_groups),
      roomManagerGroups: input.room_manager_groups === undefined ? current.roomManagerGroups : parseStoredList(input.room_manager_groups),
    };
    if (enabled && !config.bindPassword) throw new Error('Bind password is required');
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000) {
      throw new Error('Directory timeout must be between 1000 and 60000 milliseconds');
    }
    if (!Number.isInteger(config.connectTimeoutMs) || config.connectTimeoutMs < 1000 || config.connectTimeoutMs > 60000) {
      throw new Error('Connection timeout must be between 1000 and 60000 milliseconds');
    }
    for (const [label, values] of [['Allowed groups', config.allowedGroups], ['Administrator groups', config.adminGroups], ['Room Manager groups', config.roomManagerGroups]] as const) {
      if (values.length > 100 || values.some(value => value.length > 1000)) throw new Error(`${label} contain too many or overly long values`);
    }
    return config;
  }

  saveConfig(config: DirectoryConfig): void {
    db.prepare(`INSERT INTO directory_config (
      id, is_enabled, directory_type, server_url, base_dn, bind_dn, bind_password_encrypted,
      ca_cert_path, tls_reject_unauthorized, allow_insecure_ldap, allow_local_fallback,
      sync_roles, sync_profile, allowed_groups, admin_groups, room_manager_groups,
      timeout_ms, connect_timeout_ms, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      is_enabled=excluded.is_enabled, directory_type=excluded.directory_type,
      server_url=excluded.server_url, base_dn=excluded.base_dn, bind_dn=excluded.bind_dn,
      bind_password_encrypted=excluded.bind_password_encrypted, ca_cert_path=excluded.ca_cert_path,
      tls_reject_unauthorized=excluded.tls_reject_unauthorized,
      allow_insecure_ldap=excluded.allow_insecure_ldap, allow_local_fallback=excluded.allow_local_fallback,
      sync_roles=excluded.sync_roles, sync_profile=excluded.sync_profile,
      allowed_groups=excluded.allowed_groups, admin_groups=excluded.admin_groups,
      room_manager_groups=excluded.room_manager_groups, timeout_ms=excluded.timeout_ms,
      connect_timeout_ms=excluded.connect_timeout_ms, updated_at=CURRENT_TIMESTAMP`).run(
      config.enabled ? 1 : 0, config.type, config.url, config.baseDn, config.bindDn,
      encryptSecret(config.bindPassword), config.caCertPath, config.tlsRejectUnauthorized ? 1 : 0,
      config.allowInsecureLdap ? 1 : 0, config.allowLocalFallback ? 1 : 0,
      config.syncRoles ? 1 : 0, config.syncProfile ? 1 : 0,
      JSON.stringify(config.allowedGroups), JSON.stringify(config.adminGroups), JSON.stringify(config.roomManagerGroups),
      config.timeoutMs, config.connectTimeoutMs
    );
  }

  clearStoredConfig(): void {
    db.prepare('DELETE FROM directory_config WHERE id = 1').run();
  }

  isConfigured(config = this.getConfig()): boolean {
    return !!config.url && !!config.baseDn && !!config.bindDn && !!config.bindPassword;
  }

  private buildUserSearchFilter(identifier: string, type: DirectoryType): string {
    const escapedIdentifier = escapeLdapValue(identifier.toLowerCase());
    const escapedUsername = escapeLdapValue(identifier.split('@')[0].toLowerCase());
    if (type === 'ad') {
      return `(&(objectClass=user)(|(userPrincipalName=${escapedIdentifier})(mail=${escapedIdentifier})(sAMAccountName=${escapedUsername})))`;
    }
    return `(|(mail=${escapedIdentifier})(uid=${escapedUsername})(cn=${escapedUsername}))`;
  }

  private createClient(config: DirectoryConfig): Client {
    const ca = loadCaCertificates(config.caCertPath);
    const tlsOptions = config.url.startsWith('ldaps://')
      ? { rejectUnauthorized: config.tlsRejectUnauthorized, ...(ca ? { ca } : {}) }
      : undefined;

    return new Client({
      url: config.url,
      timeout: config.timeoutMs,
      connectTimeout: config.connectTimeoutMs,
      tlsOptions,
    });
  }

  private async secureClient(client: Client, config: DirectoryConfig): Promise<void> {
    if (!config.url.toLowerCase().startsWith('ldap://') || config.allowInsecureLdap) return;
    const ca = loadCaCertificates(config.caCertPath);
    await client.startTLS({
      rejectUnauthorized: config.tlsRejectUnauthorized,
      ...(ca ? { ca } : {}),
    });
  }

  async testConnection(config = this.getConfig(), requireEnabled = true): Promise<{ host: string; port: number; latencyMs: number }> {
    if (requireEnabled && !config.enabled) {
      throw new Error('Directory authentication is disabled');
    }
    if (!this.isConfigured(config)) {
      throw new Error('Directory configuration is incomplete');
    }

    const parsed = new URL(config.url);
    if (!['ldap:', 'ldaps:'].includes(parsed.protocol)) {
      throw new Error('DIRECTORY_URL must use ldap:// or ldaps://');
    }
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'ldaps:' ? 636 : 389);
    if (!host || !port || Number.isNaN(port)) {
      throw new Error('Invalid directory host or port');
    }

    const startedAt = Date.now();
    const client = this.createClient(config);
    try {
      await this.secureClient(client, config);
      await client.bind(config.bindDn, config.bindPassword);
      await client.search(config.baseDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['dn'],
      });
      return {
        host,
        port,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async authenticate(identifier: string, password: string): Promise<DirectoryIdentity | null> {
    const config = this.getConfig();
    if (!config.enabled || !this.isConfigured(config)) {
      return null;
    }

    if (!password) return null;

    const normalizedIdentifier = identifier.toLowerCase().trim();
    const client = this.createClient(config);
    let phase = 'connect';
    try {
      await this.secureClient(client, config);
      phase = 'service_bind';
      await client.bind(config.bindDn, config.bindPassword);

      phase = 'user_search';
      const filter = this.buildUserSearchFilter(normalizedIdentifier, config.type);
      const search = await client.search(config.baseDn, {
        scope: 'sub',
        filter,
        attributes: ['dn', 'mail', 'userPrincipalName', 'sAMAccountName', 'cn', 'displayName', 'givenName', 'sn', 'department', 'memberOf'],
        sizeLimit: 2,
      });

      if (!search.searchEntries.length) {
        return null;
      }

      const entry = search.searchEntries[0] as Record<string, any>;
      const userDn = firstAttribute(entry, 'dn');
      if (!userDn) {
        return null;
      }

      phase = 'user_bind';
      await client.bind(userDn, password);

      const groups = attributeList(entry, 'memberOf');
      if (!isGroupAllowed(groups, config.allowedGroups)) {
        return null;
      }
      const role = detectRole(groups, config.adminGroups, config.roomManagerGroups);
      const email =
        (firstAttribute(entry, 'mail', 'userPrincipalName') || normalizedIdentifier).toLowerCase();
      const name =
        firstAttribute(entry, 'displayName', 'cn') ||
        `${firstAttribute(entry, 'givenName') || ''} ${firstAttribute(entry, 'sn') || ''}`.trim() ||
        email;
      const department = firstAttribute(entry, 'department');

      return {
        email,
        name,
        department,
        role,
        groups,
        userDn,
      };
    } catch (error) {
      // A rejected user password is routine authentication behavior, not an
      // operational warning. Connection, TLS, service-bind, and search failures
      // indicate a degraded directory integration and belong in Diagnostics.
      if (phase !== 'user_bind' || !isInvalidUserCredentialError(error)) {
        recordOperationalWarning({
          source: 'directory',
          category: 'authentication_service',
          message: 'Directory authentication service failed before credentials could be verified',
          metadata: { phase, directory_type: config.type },
        }, error);
      }
      return null;
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}

export const directoryAuthService = new DirectoryAuthService();
