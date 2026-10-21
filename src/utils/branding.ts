import { safeStorage } from './storage';
import { Theme } from '../types';

const BRANDING_STORAGE_KEY = 'app-branding';
const DEFAULT_PRIMARY = '#4F46E5';
const DEFAULT_ACCENT = '#14B8A6';

export interface StoredBranding {
  company_name?: string;
  primary_color?: string;
  accent_color?: string;
  brand_tagline?: string;
  logo_size?: 'small' | 'medium' | 'large';
  logo_url?: string | null;
  favicon_url?: string | null;
}

export const resolveBrandAssetUrl = (value: string | null | undefined, apiOrigin: string): string => {
  const trimmed = value?.trim() || '';
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return `${apiOrigin}${trimmed}`;
  return '';
};

const resolveSafeDocumentAssetUrl = (value: string): string => {
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeHex = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash : null;
};

export const hexToRgb = (hex: string): string => {
  const normalized = normalizeHex(hex);
  if (!normalized) return '79, 70, 229';

  return `${parseInt(normalized.slice(1, 3), 16)}, ${parseInt(normalized.slice(3, 5), 16)}, ${parseInt(normalized.slice(5, 7), 16)}`;
};

const shiftHex = (hex: string, amount: number): string => {
  const normalized = normalizeHex(hex) || DEFAULT_PRIMARY;
  const channels = [1, 3, 5].map(offset => parseInt(normalized.slice(offset, offset + 2), 16));
  const shifted = channels.map(channel => clamp(Math.round(channel + amount), 0, 255));
  return `#${shifted.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
};

const hexChannels = (hex: string): [number, number, number] => {
  const normalized = normalizeHex(hex) || DEFAULT_PRIMARY;
  return [1, 3, 5].map(offset => parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number];
};

const relativeLuminance = (hex: string): number => {
  const channels = hexChannels(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
};

const contrastRatio = (first: string, second: string): number => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

const mixHex = (from: string, to: string, amount: number): string => {
  const fromChannels = hexChannels(from);
  const toChannels = hexChannels(to);
  const mixed = fromChannels.map((channel, index) => Math.round(channel + ((toChannels[index] - channel) * amount)));
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
};

const getContrastText = (background: string): string => (
  contrastRatio('#ffffff', background) >= contrastRatio('#101828', background) ? '#ffffff' : '#101828'
);

const getReadablePrimary = (primaryColor: string, theme: Theme): string => {
  const surface = theme === 'dark' ? '#1a2233' : '#ffffff';
  if (contrastRatio(primaryColor, surface) >= 4.5) return primaryColor;

  const target = theme === 'dark' ? '#ffffff' : '#101828';
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixHex(primaryColor, target, step / 20);
    if (contrastRatio(candidate, surface) >= 4.5) return candidate;
  }
  return target;
};

const getPrimaryHover = (primaryColor: string, theme: Theme): string => (
  theme === 'dark' ? shiftHex(primaryColor, 20) : shiftHex(primaryColor, -20)
);

export const loadStoredBranding = (): StoredBranding | null => {
  const raw = safeStorage.getItem(BRANDING_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredBranding;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

export const applyBrandingToDocument = (
  branding: StoredBranding | null | undefined,
  options?: { theme?: Theme; persist?: boolean },
) => {
  if (typeof document === 'undefined' || !branding) return;

  const root = document.documentElement;
  const primaryColor = normalizeHex(branding.primary_color) || DEFAULT_PRIMARY;
  const accentColor = normalizeHex(branding.accent_color) || DEFAULT_ACCENT;
  const logoSize = branding.logo_size === 'small' || branding.logo_size === 'large' ? branding.logo_size : 'medium';
  const theme = options?.theme ?? ((root.getAttribute('data-theme') as Theme | null) || 'dark');

  root.style.setProperty('--primary', primaryColor);
  root.style.setProperty('--primary-rgb', hexToRgb(primaryColor));
  root.style.setProperty('--primaryHover', getPrimaryHover(primaryColor, theme));
  root.style.setProperty('--primary-contrast', getContrastText(primaryColor));
  root.style.setProperty('--primary-readable', getReadablePrimary(primaryColor, theme));
  root.style.setProperty('--brand-accent', accentColor);
  root.style.setProperty('--brand-accent-rgb', hexToRgb(accentColor));
  root.style.setProperty('--brand-logo-size', logoSize === 'small' ? '30px' : logoSize === 'large' ? '44px' : '36px');

  if (branding.company_name?.trim()) {
    document.title = branding.company_name.trim();
  }

  const existingFavicon = document.querySelector("link[data-resy-favicon]") as HTMLLinkElement | null;
  if (branding.favicon_url?.trim()) {
    const href = resolveSafeDocumentAssetUrl(branding.favicon_url.trim());
    if (!href) {
      existingFavicon?.remove();
    } else {
      const link = existingFavicon || document.createElement('link');
      const extension = href.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        ico: 'image/x-icon',
        png: 'image/png',
        gif: 'image/gif',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      };
      link.rel = 'icon';
      link.href = href;
      link.dataset.resyFavicon = 'true';
      if (extension && mimeTypes[extension]) link.type = mimeTypes[extension];
      else link.removeAttribute('type');
      document.head.appendChild(link);
    }
  } else if (existingFavicon) {
    existingFavicon.remove();
  }

  if (options?.persist !== false) {
    safeStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify({
      company_name: branding.company_name?.trim() || '',
      primary_color: primaryColor,
      accent_color: accentColor,
      brand_tagline: branding.brand_tagline ?? 'Room booking',
      logo_size: logoSize,
      logo_url: branding.logo_url || '',
      favicon_url: branding.favicon_url || '',
    }));
  }
};
