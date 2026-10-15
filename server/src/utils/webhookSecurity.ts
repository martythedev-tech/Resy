import { lookup } from 'dns/promises';
import { isIP } from 'net';

export interface WebhookUrlValidation {
  valid: boolean;
  error?: string;
  url?: URL;
  addresses?: string[];
}

export interface WebhookSecurityPolicy {
  allowInternalDestinations: boolean;
  allowedInternalOrigins: string[];
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(part => part >= 0 && part <= 255) ? parts : null;
}

function parseIpv6(address: string): number[] | null {
  const input = address.toLowerCase().split('%')[0];
  if (isIP(input) !== 6) return null;

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    const segments = half.split(':');
    const words: number[] = [];
    for (const segment of segments) {
      const ipv4 = parseIpv4(segment);
      if (ipv4) {
        words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        words.push(parseInt(segment, 16));
      }
    }
    return words;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(Math.max(0, zeros)).fill(0), ...right];
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

export function isBlockedWebhookAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }

  const ipv6 = parseIpv6(address);
  if (!ipv6) return true;
  const allZero = ipv6.every(word => word === 0);
  const loopback = ipv6.slice(0, 7).every(word => word === 0) && ipv6[7] === 1;
  const mappedIpv4 = ipv6.slice(0, 5).every(word => word === 0) && ipv6[5] === 0xffff;
  if (mappedIpv4) {
    return isBlockedWebhookAddress(`${ipv6[6] >> 8}.${ipv6[6] & 255}.${ipv6[7] >> 8}.${ipv6[7] & 255}`);
  }

  return allZero
    || loopback
    || (ipv6[0] & 0xfe00) === 0xfc00
    || (ipv6[0] & 0xffc0) === 0xfe80
    || (ipv6[0] & 0xff00) === 0xff00
    || (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8)
    || (ipv6[0] === 0x0100 && ipv6.slice(1, 4).every(word => word === 0));
}

export function isAllowedPrivateWebhookAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  const ipv6 = parseIpv6(address);
  return Boolean(ipv6 && (ipv6[0] & 0xfe00) === 0xfc00);
}

export function normalizeWebhookOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Each internal destination must be an HTTP or HTTPS origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Each internal destination must be an HTTP or HTTPS origin without credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Internal allowlist entries must contain only scheme, hostname, and optional port');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost cannot be used as an internal webhook destination');
  }
  return url.origin;
}

export function createPinnedWebhookLookup(address: string) {
  const family = isIP(address);
  if (!family) throw new Error('Validated webhook address is not a valid IP address');

  return (_hostname: string, options: unknown, callback: Function) => {
    const wantsAll = Boolean(options && typeof options === 'object' && (options as { all?: boolean }).all);
    if (wantsAll) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export async function validateWebhookUrl(
  urlString: unknown,
  policy: WebhookSecurityPolicy = { allowInternalDestinations: false, allowedInternalOrigins: [] },
): Promise<WebhookUrlValidation> {
  if (typeof urlString !== 'string' || !urlString.trim()) {
    return { valid: false, error: 'Webhook URL is required' };
  }

  let url: URL;
  try {
    url = new URL(urlString.trim());
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, error: 'Webhook URL must use HTTP or HTTPS' };
  }
  if (url.username || url.password) {
    return { valid: false, error: 'Webhook URLs cannot contain credentials' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { valid: false, error: 'Local webhook destinations are not allowed' };
  }

  try {
    const resolved = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true });
    const addresses = Array.from(new Set(resolved.map(result => result.address)));
    if (!addresses.length) {
      return { valid: false, error: 'Webhook hostname could not be resolved' };
    }
    const blockedAddresses = addresses.filter(isBlockedWebhookAddress);
    if (blockedAddresses.length > 0) {
      const allowedOrigins = policy.allowedInternalOrigins.map(origin => {
        try { return normalizeWebhookOrigin(origin); } catch { return ''; }
      });
      const isExplicitlyAllowed = policy.allowInternalDestinations && allowedOrigins.includes(url.origin);
      const resolvesOnlyToAllowedPrivateSpace = addresses.every(isAllowedPrivateWebhookAddress);
      if (!isExplicitlyAllowed || !resolvesOnlyToAllowedPrivateSpace) {
        return { valid: false, error: 'Webhook destination is private and is not on the internal allowlist' };
      }
      return { valid: true, url, addresses };
    }

    const allowInsecure = String(process.env.ALLOW_INSECURE_WEBHOOKS || '').toLowerCase() === 'true';
    if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
      return { valid: false, error: allowInsecure ? 'URL must use HTTP or HTTPS' : 'Public webhook URLs must use HTTPS' };
    }
    return { valid: true, url, addresses };
  } catch {
    return { valid: false, error: 'Webhook hostname could not be resolved' };
  }
}

export function safeWebhookDestination(urlString: string): string {
  try {
    const url = new URL(urlString);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[invalid webhook URL]';
  }
}
