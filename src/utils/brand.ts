import { useEffect, useState } from 'react';
import type { SiteSettings } from '../types.ts';
import {
  DEFAULT_SITE_SETTINGS,
  fetchRemoteSiteSettings,
  getSiteSettings,
} from './siteConfigManager.ts';

export interface BrandSnapshot {
  siteName: string;
  tagline: string;
  supportEmail: string;
  supportTelegram: string;
  badgeText: string;
}

function toBrandSnapshot(settings?: Partial<SiteSettings> | null): BrandSnapshot {
  const s = settings || {};
  return {
    siteName: s.siteName?.trim() ? s.siteName : DEFAULT_SITE_SETTINGS.siteName,
    tagline: s.siteTagline?.trim() ? s.siteTagline : DEFAULT_SITE_SETTINGS.siteTagline,
    supportEmail: s.supportEmail?.trim() ? s.supportEmail : DEFAULT_SITE_SETTINGS.supportEmail,
    supportTelegram: s.supportTelegram?.trim() ? s.supportTelegram : DEFAULT_SITE_SETTINGS.supportTelegram,
    badgeText: typeof s.badgeText === 'string' ? s.badgeText : DEFAULT_SITE_SETTINGS.badgeText || '',
  };
}

let remoteBrandPromise: Promise<SiteSettings> | null = null;

export function loadBrandOnce(): Promise<SiteSettings> {
  if (!remoteBrandPromise) {
    remoteBrandPromise = fetchRemoteSiteSettings().catch(() => getSiteSettings());
  }
  return remoteBrandPromise;
}

export function resetBrandLoaderForTests(): void {
  remoteBrandPromise = null;
}

export function getBrandSnapshot(): BrandSnapshot {
  return toBrandSnapshot(getSiteSettings());
}

export function applyBrandTokens(text: string, siteName: string): string {
  return text.replace(/\{\{BRAND_NAME\}\}/g, siteName);
}

export function useBrand(): BrandSnapshot {
  const [brand, setBrand] = useState<BrandSnapshot>(() => getBrandSnapshot());

  useEffect(() => {
    let mounted = true;
    setBrand(getBrandSnapshot());

    loadBrandOnce().then((remote) => {
      if (mounted && remote) {
        setBrand(toBrandSnapshot(remote));
      }
    });

    const handleSettingsChange = (ev: Event) => {
      const custom = ev as CustomEvent<SiteSettings>;
      const next = custom?.detail ? toBrandSnapshot(custom.detail) : getBrandSnapshot();
      setBrand(next);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pulsetrade_settings_changed', handleSettingsChange);
    }

    return () => {
      mounted = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pulsetrade_settings_changed', handleSettingsChange);
      }
    };
  }, []);

  return brand;
}
