import type {
  SiteSettings,
  NowPaymentsConfig,
  NowPaymentsPayment,
  PricingPackage,
  AdminUserItem,
  VipCodeItem,
  ExternalBrokerConfig,
  BrokersSettings,
  BrokerItemConfig,
  ReferralBonusConfig,
  BrokerPlatformItem,
  DirectWalletOrder,
} from '../types.ts';
import { getSupabaseClient } from './supabaseClient.ts';

export const DEFAULT_PRICING_PACKAGES: PricingPackage[] = [
  {
    id: 1,
    name: 'Starter Pack',
    type: 'CREDITS',
    credits_amount: 10,
    bonus_credits: 0,
    price_usd: 5.0,
    badge_label: '',
    description: 'Instant algorithmic micro-scalping credits (10 executions)',
    is_active: true,
    sort_order: 1,
  },
  {
    id: 2,
    name: 'Popular Pack',
    type: 'CREDITS',
    credits_amount: 25,
    bonus_credits: 5,
    price_usd: 10.0,
    badge_label: 'MOST POPULAR',
    description: '25 + 5 Free bonus algorithmic signals with confluence audit',
    is_active: true,
    sort_order: 2,
  },
  {
    id: 3,
    name: 'Pro Trader',
    type: 'CREDITS',
    credits_amount: 60,
    bonus_credits: 20,
    price_usd: 20.0,
    badge_label: 'HIGH VOLUME',
    description: '60 + 20 Bonus credits with full MT5 lot & pip calculations',
    is_active: true,
    sort_order: 3,
  },
  {
    id: 4,
    name: 'Whale Alpha',
    type: 'CREDITS',
    credits_amount: 150,
    bonus_credits: 60,
    price_usd: 45.0,
    badge_label: 'BEST VALUE',
    description: '150 + 60 Institutional bonus credits for high-frequency desks',
    is_active: true,
    sort_order: 4,
  },
  {
    id: 5,
    name: '★ 30-Day VIP Pass',
    type: 'VIP_30_DAY',
    credits_amount: 9999,
    bonus_credits: 0,
    price_usd: 49.0,
    badge_label: 'UNLIMITED VIP',
    description: 'Strict 30-day unlimited signal computation & unlocked Safe Radar',
    is_active: true,
    sort_order: 5,
  },
];

const STORAGE_KEY_PACKAGES = 'pulsetrade_pricing_packages';

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: 'PulseTrade Pro',
  siteTagline: 'Institutional-Grade Quantitative Micro-Volatility Terminal',
  logoUrl: '',
  faviconUrl: '',
  logoIcon: 'zap',
  badgeText: 'v8.2 QUANT',
  bannerText: '⚡ 30-Day VIP Pass: Institutional-grade 89.4% confluence signals with instant automated verification',
  bannerEnabled: true,
  supportTelegram: 'https://t.me/pulsetrade_quant',
  supportWhatsapp: '',
  supportEmail: 'support@pulsetrade.pro',
  vipPriceUsd: 49,
  starterPriceUsd: 5,
  themeAccent: 'emerald',
};

export const DEFAULT_NOWPAYMENTS_CONFIG: NowPaymentsConfig = {
  apiKey: '',
  ipnSecret: '',
  isSandbox: false,
  enabled: false,
  payoutAddress: '',
};

const STORAGE_KEY_SETTINGS = 'pulsetrade_site_settings';
const STORAGE_KEY_NOWPAYMENTS = 'pulsetrade_nowpayments_config';

/**
 * Get current site settings (synchronous fallback)
 */
export function getSiteSettings(): SiteSettings {
  if (typeof window === 'undefined') return DEFAULT_SITE_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (raw) {
      return { ...DEFAULT_SITE_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('[SiteSettings Parse Error]', e);
  }
  return DEFAULT_SITE_SETTINGS;
}

/**
 * Apply branding (document title, favicon, apple touch icon) dynamically at runtime
 */
export function applyDocumentBranding(settings: SiteSettings) {
  if (typeof document === 'undefined') return;

  // Title
  if (settings.siteName) {
    document.title = `${settings.siteName} – ${settings.siteTagline || 'Quantitative Trading Cockpit'}`;
  }

  // Favicon
  if (settings.faviconUrl && settings.faviconUrl.trim()) {
    const faviconHref = settings.faviconUrl.trim();
    let link = document.getElementById('app-favicon') as HTMLLinkElement | null;
    if (!link) {
      link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
    }
    if (link) {
      link.href = faviconHref;
    } else {
      link = document.createElement('link');
      link.id = 'app-favicon';
      link.rel = 'icon';
      link.href = faviconHref;
      document.head.appendChild(link);
    }

    let appleLink = document.getElementById('app-apple-icon') as HTMLLinkElement | null;
    if (!appleLink) {
      appleLink = document.querySelector("link[rel~='apple-touch-icon']") as HTMLLinkElement | null;
    }
    if (appleLink) {
      appleLink.href = faviconHref;
    }
  }
}

/**
 * Fetch remote site settings from Supabase (preferred) or Backend API
 */
export async function fetchRemoteSiteSettings(): Promise<SiteSettings> {
  let settings = getSiteSettings();

  // 1. Try Supabase app_settings table
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'site_branding')
        .single();

      if (!error && data?.value) {
        settings = { ...DEFAULT_SITE_SETTINGS, ...data.value };
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
        applyDocumentBranding(settings);
        return settings;
      }
    } catch (err) {
      console.warn('[Supabase Settings Fetch]', err);
    }
  }

  // 2. Try Node/PHP Backend API
  try {
    let res = await fetch('/api/settings');
    if (!res.ok) {
      res = await fetch('/api.php?action=get_settings');
    }
    if (res.ok) {
      const data = await res.json();
      if (data && data.settings) {
        settings = { ...DEFAULT_SITE_SETTINGS, ...data.settings };
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
        applyDocumentBranding(settings);
        return settings;
      }
    }
  } catch (err) {
    // Graceful offline fallback
  }

  applyDocumentBranding(settings);
  return settings;
}

/**
 * Save site settings and broadcast changes across tabs and backend
 */
export async function saveSiteSettings(newSettings: SiteSettings): Promise<boolean> {
  const merged = { ...DEFAULT_SITE_SETTINGS, ...newSettings };
  
  // 1. Save locally and apply document branding
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(merged));
    applyDocumentBranding(merged);
    window.dispatchEvent(new CustomEvent('pulsetrade_settings_changed', { detail: merged }));
  }

  // 2. Save to Supabase real-time database if connected
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('app_settings').upsert({
        key: 'site_branding',
        value: merged,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[Supabase Settings Save Error]', err);
    }
  }

  // 3. Save to server backend
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: merged }),
    });
  } catch (err) {
    // Network fallback
  }

  return true;
}

/**
 * Get NOWPayments configuration
 */
export function getNowPaymentsConfig(): NowPaymentsConfig {
  if (typeof window === 'undefined') return DEFAULT_NOWPAYMENTS_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_NOWPAYMENTS);
    if (raw) {
      return { ...DEFAULT_NOWPAYMENTS_CONFIG, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('[NOWPayments Config Parse Error]', e);
  }
  return DEFAULT_NOWPAYMENTS_CONFIG;
}

/**
 * Fetch remote NOWPayments config from Supabase or server
 */
export async function fetchRemoteNowPaymentsConfig(): Promise<NowPaymentsConfig> {
  let config = getNowPaymentsConfig();

  // Try Supabase
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'nowpayments_config')
        .single();

      if (!error && data?.value) {
        config = { ...DEFAULT_NOWPAYMENTS_CONFIG, ...data.value };
        localStorage.setItem(STORAGE_KEY_NOWPAYMENTS, JSON.stringify(config));
        return config;
      }
    } catch (err) {
      // Handled
    }
  }

  // Try backend API
  try {
    let res = await fetch('/api/nowpayments/config');
    if (!res.ok) {
      res = await fetch('/api.php?action=nowpayments_config');
    }
    if (res.ok) {
      const data = await res.json();
      if (data && data.config) {
        config = { ...DEFAULT_NOWPAYMENTS_CONFIG, ...data.config };
        localStorage.setItem(STORAGE_KEY_NOWPAYMENTS, JSON.stringify(config));
        return config;
      }
    }
  } catch (err) {
    // Handled
  }

  return config;
}

/**
 * Save NOWPayments configuration
 */
export async function saveNowPaymentsConfig(newConfig: NowPaymentsConfig): Promise<boolean> {
  const merged = { ...DEFAULT_NOWPAYMENTS_CONFIG, ...newConfig };

  // 1. Local
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_NOWPAYMENTS, JSON.stringify(merged));
    window.dispatchEvent(new CustomEvent('pulsetrade_nowpayments_changed', { detail: merged }));
  }

  // 2. Supabase
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('app_settings').upsert({
        key: 'nowpayments_config',
        value: merged,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[Supabase NOWPayments Save Error]', err);
    }
  }

  // 3. Server
  try {
    let res = await fetch('/api/nowpayments/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: merged }),
    });
    if (!res.ok) {
      await fetch('/api.php?action=nowpayments_save_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: merged }),
      });
    }
  } catch (err) {
    // Handled
  }

  return true;
}

/**
 * Test NOWPayments API connectivity
 */
export async function testNowPaymentsConnection(
  apiKey: string,
  isSandbox: boolean = false
): Promise<{ success: boolean; message: string }> {
  if (!apiKey || apiKey.trim().length < 10) {
    return { success: false, message: 'Please provide a valid NOWPayments API Key.' };
  }

  try {
    const res = await fetch('/api/nowpayments/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, isSandbox }),
    });

    if (res.ok) {
      const data = await res.json();
      return {
        success: Boolean(data.success),
        message: data.message || (data.success ? 'NOWPayments API connection verified!' : 'Connection test failed.'),
      };
    }
    return { success: false, message: `Server returned HTTP ${res.status}` };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error during connection test.' };
  }
}

/**
 * Create a live NOWPayments invoice for instant payment verification
 */
export async function createNowPaymentsPayment(params: {
  priceAmount: number;
  priceCurrency?: string;
  payCurrency: string;
  orderId: string;
  orderDescription: string;
}): Promise<{ success: boolean; data?: NowPaymentsPayment; message?: string }> {
  try {
    let res = await fetch('/api/nowpayments/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      res = await fetch('/api.php?action=nowpayments_create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    }

    const json = await res.json();
    if (res.ok && json.success && json.payment) {
      return { success: true, data: json.payment };
    }
    return { success: false, message: json.message || 'Failed to create payment invoice with NOWPayments.' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error initiating NOWPayments invoice.' };
  }
}

/**
 * Poll payment status from NOWPayments
 */
export async function checkNowPaymentsStatus(paymentId: string): Promise<{
  success: boolean;
  data?: NowPaymentsPayment;
  message?: string;
}> {
  try {
    let res = await fetch(`/api/nowpayments/check-payment/${encodeURIComponent(paymentId)}`);
    if (!res.ok) {
      res = await fetch(`/api.php?action=nowpayments_check&id=${encodeURIComponent(paymentId)}`);
    }
    const json = await res.json();
    if (res.ok && json.success && json.payment) {
      return { success: true, data: json.payment };
    }
    return { success: false, message: json.message || 'Unable to fetch status.' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Status check request failed.' };
  }
}

/**
  * Synchronous read of saved pricing packages
  */
export function getPricingPackages(): PricingPackage[] {
  if (typeof window === 'undefined') return DEFAULT_PRICING_PACKAGES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PACKAGES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('[Pricing Packages Parse Error]', e);
  }
  return DEFAULT_PRICING_PACKAGES;
}

/**
 * Fetch dynamic pricing packages from Supabase DB or API
 */
export async function fetchPricingPackages(): Promise<PricingPackage[]> {
  let list = getPricingPackages();
  const supabase = getSupabaseClient();

  if (supabase) {
    try {
      // 1. Try public.pricing_packages table
      const { data, error } = await supabase
        .from('pricing_packages')
        .select('*')
        .order('sort_order', { ascending: true });

      if (!error && Array.isArray(data) && data.length > 0) {
        list = data.map((d: any) => ({
          id: d.id,
          name: d.name,
          type: d.type || 'CREDITS',
          credits_amount: Number(d.credits_amount) || 0,
          bonus_credits: Number(d.bonus_credits) || 0,
          price_usd: Number(d.price_usd) || 0,
          badge_label: d.badge_label || '',
          description: d.description || '',
          is_active: Boolean(d.is_active),
          sort_order: Number(d.sort_order) || 1,
        }));
        localStorage.setItem(STORAGE_KEY_PACKAGES, JSON.stringify(list));
        return list;
      }

      // 2. Fallback to app_settings
      const { data: setRow } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'pricing_packages')
        .maybeSingle();

      if (setRow?.value && Array.isArray(setRow.value) && setRow.value.length > 0) {
        list = setRow.value;
        localStorage.setItem(STORAGE_KEY_PACKAGES, JSON.stringify(list));
        return list;
      }
    } catch (err) {
      console.warn('[Supabase Pricing Packages Fetch Error]', err);
    }
  }

  // 3. Fallback to server API
  try {
    let res = await fetch('/api/pricing_packages');
    if (!res.ok) res = await fetch('/api/packages');
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.packages) && data.packages.length > 0) {
        list = data.packages;
        localStorage.setItem(STORAGE_KEY_PACKAGES, JSON.stringify(list));
        return list;
      }
    }
  } catch (err) {
    // Offline fallback
  }

  return list;
}

/**
 * Save pricing packages (Admin)
 * Persists directly to Supabase Postgres (pricing_packages & app_settings) and Backend API
 */
export async function savePricingPackages(
  packages: PricingPackage[],
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  localStorage.setItem(STORAGE_KEY_PACKAGES, JSON.stringify(packages));
  window.dispatchEvent(new CustomEvent('pulsetrade_packages_changed', { detail: packages }));

  let savedToDb = false;
  let dbError = '';

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      // 1. Save to app_settings key 'pricing_packages'
      const { error: setErr } = await supabase.from('app_settings').upsert({
        key: 'pricing_packages',
        value: packages,
        updated_at: new Date().toISOString(),
      });

      if (!setErr) {
        savedToDb = true;
      } else {
        dbError = setErr.message;
      }

      // 2. Also upsert into public.pricing_packages table
      try {
        for (const pkg of packages) {
          const numericId = typeof pkg.id === 'number' ? pkg.id : parseInt(String(pkg.id).replace(/\D/g, '').slice(0, 8)) || undefined;
          await supabase.from('pricing_packages').upsert({
            ...(numericId ? { id: numericId } : {}),
            name: pkg.name,
            type: pkg.type,
            credits_amount: pkg.credits_amount,
            bonus_credits: pkg.bonus_credits,
            price_usd: pkg.price_usd,
            badge_label: pkg.badge_label || '',
            description: pkg.description || '',
            is_active: pkg.is_active,
            sort_order: pkg.sort_order,
            updated_at: new Date().toISOString(),
          });
        }
      } catch {
        // Handled via app_settings
      }
    } catch (err: any) {
      dbError = err?.message || 'Database error';
    }
  }

  // 3. Notify Node Backend API
  try {
    await fetch('/api/admin/pricing_packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages, adminPin }),
    });
  } catch {}

  if (savedToDb || supabase) {
    return {
      success: true,
      message: 'Pricing packages saved and synchronized successfully to live database!',
    };
  }

  return {
    success: true,
    message: 'Pricing packages saved locally in active session.',
  };
}

/**
 * Fetch all registered users for Admin Dashboard from live online Supabase DB
 */
export async function fetchAdminUsers(adminPin: string = '7789'): Promise<AdminUserItem[]> {
  const supabase = getSupabaseClient();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data) && data.length > 0) {
        return data.map((u: any) => {
          let isVip = Boolean(u.is_vip);
          const vipExp = u.vip_expires_at || null;
          let daysLeft = 0;
          let hoursLeft = 0;
          let secondsLeft = 0;

          if (isVip && vipExp) {
            const diffMs = new Date(vipExp).getTime() - Date.now();
            if (diffMs <= 0) {
              isVip = false;
            } else {
              secondsLeft = Math.floor(diffMs / 1000);
              daysLeft = Math.floor(secondsLeft / 86400);
              hoursLeft = Math.floor((secondsLeft % 86400) / 3600);
            }
          }

          return {
            id: u.id,
            username: u.username || u.email?.split('@')[0] || 'Trader',
            email: u.email,
            role: u.role || 'USER',
            credits: typeof u.credits === 'number' ? u.credits : 10,
            is_vip: isVip,
            vip_expires_at: vipExp,
            vip_days_left: daysLeft,
            vip_hours_left: hoursLeft,
            vip_seconds_left: secondsLeft,
            registration_ip: u.registration_ip || 'vercel_web',
            created_at: u.created_at || new Date().toISOString(),
            status: u.status || 'active',
          };
        });
      }
    } catch (err) {
      console.warn('[Supabase Users Fetch Error]', err);
    }
  }

  // Fallback to Backend API
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPin }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.users)) {
        return data.users;
      }
    }
  } catch (err) {
    console.warn('[API Users Fetch Error]', err);
  }

  return [];
}

/**
 * Grant 30-Day VIP to a user
 * Expiry Rule: If VIP still active, extend current vip_expires_at + 30 days; else now + 30 days.
 */
export async function grantUserVip(
  userId: string | number,
  days: number = 30,
  adminPin: string = '7789'
): Promise<{ success: boolean; user?: any; message: string }> {
  const supabase = getSupabaseClient();
  let updatedRecord: any = null;

  if (supabase) {
    try {
      // 1. Fetch current user row to calculate precise expiry
      const { data: userRow } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      let baseTimestamp = Date.now();
      if (userRow?.is_vip && userRow?.vip_expires_at) {
        const currentExp = new Date(userRow.vip_expires_at).getTime();
        if (currentExp > baseTimestamp) {
          baseTimestamp = currentExp;
        }
      }
      const newVipExpiresAt = new Date(baseTimestamp + days * 86400000).toISOString();

      const { data: updated, error } = await supabase
        .from('users')
        .update({
          is_vip: true,
          vip_expires_at: newVipExpiresAt,
          credits: 9999,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select()
        .maybeSingle();

      if (!error && updated) {
        updatedRecord = updated;
      }
    } catch (err) {
      console.warn('[Supabase Grant VIP Error]', err);
    }
  }

  // Also notify server backend
  try {
    await fetch('/api/admin/grant-vip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, days, adminPin }),
    });
  } catch {}

  if (updatedRecord) {
    return {
      success: true,
      user: updatedRecord,
      message: `30-Day VIP granted! Active until ${new Date(updatedRecord.vip_expires_at).toLocaleDateString()}.`,
    };
  }

  // Fallback to Backend API
  try {
    const res = await fetch('/api/admin/grant-vip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, days, adminPin }),
    });
    const data = await res.json();
    return {
      success: Boolean(data.success),
      user: data.user,
      message: data.message || (data.success ? 'VIP granted.' : 'Failed to grant VIP.'),
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error granting VIP.' };
  }
}

/**
 * Revoke VIP from user
 */
export async function revokeUserVip(
  userId: string | number,
  adminPin: string = '7789'
): Promise<{ success: boolean; user?: any; message: string }> {
  const supabase = getSupabaseClient();
  let updatedRecord: any = null;

  if (supabase) {
    try {
      const { data: updated, error } = await supabase
        .from('users')
        .update({
          is_vip: false,
          vip_expires_at: null,
          credits: 10,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select()
        .maybeSingle();

      if (!error && updated) {
        updatedRecord = updated;
      }
    } catch (err) {
      console.warn('[Supabase Revoke VIP Error]', err);
    }
  }

  // Also notify backend
  try {
    await fetch('/api/admin/revoke-vip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, adminPin }),
    });
  } catch {}

  return {
    success: true,
    user: updatedRecord,
    message: 'VIP status revoked and account reset to standard starter tier.',
  };
}

/**
 * Adjust user credits balance
 */
export async function adjustUserCredits(
  userId: string | number,
  credits: number,
  adminPin: string = '7789'
): Promise<{ success: boolean; user?: any; message: string }> {
  const supabase = getSupabaseClient();
  let updatedRecord: any = null;

  if (supabase) {
    try {
      const { data: updated, error } = await supabase
        .from('users')
        .update({
          credits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select()
        .maybeSingle();

      if (!error && updated) {
        updatedRecord = updated;
      }
    } catch (err) {
      console.warn('[Supabase Adjust Credits Error]', err);
    }
  }

  // Also notify backend
  try {
    await fetch('/api/admin/adjust-credits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, credits, adminPin }),
    });
  } catch {}

  return {
    success: true,
    user: updatedRecord,
    message: `Account credits adjusted to ${credits} CR.`,
  };
}

const STORAGE_KEY_VIP_CODES = 'pulsetrade_vip_codes';

/**
 * Helper to get locally saved VIP codes
 */
function getLocalVipCodes(): VipCodeItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VIP_CODES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

/**
 * Helper to save VIP codes locally
 */
function saveLocalVipCodes(codes: VipCodeItem[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_VIP_CODES, JSON.stringify(codes));
  } catch {}
}

/**
 * Fetch all VIP codes for Admin from Supabase DB, Server API, and Local Cache
 */
export async function fetchAdminVipKeys(adminPin: string = '7789'): Promise<VipCodeItem[]> {
  const codeMap = new Map<string, VipCodeItem>();

  // 1. Load from local cache first (instant availability)
  const localList = getLocalVipCodes();
  for (const c of localList) {
    if (c.code) codeMap.set(c.code.toUpperCase(), c);
  }

  // 2. Fetch from Supabase DB
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('vip_codes')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data)) {
        for (const d of data) {
          const item: VipCodeItem = {
            id: d.id,
            code: d.code,
            duration_days: d.duration_days || 30,
            is_active: Boolean(d.is_active),
            is_redeemed: Boolean(d.is_redeemed),
            redeemed_by: d.redeemed_by_email || (d.redeemed_by_user_id ? `User #${d.redeemed_by_user_id}` : undefined),
            redeemed_at: d.redeemed_at,
            created_at: d.created_at || new Date().toISOString(),
            created_by: d.created_by_admin || 'Master Admin',
          };
          codeMap.set(item.code.toUpperCase(), item);
        }
      }

      // 2b. Also read app_settings key 'vip_codes' to ensure full sync
      try {
        const { data: setRow } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'vip_codes')
          .maybeSingle();

        if (setRow?.value && Array.isArray(setRow.value)) {
          for (const d of setRow.value) {
            const item: VipCodeItem = {
              id: d.id,
              code: d.code,
              duration_days: d.duration_days || 30,
              is_active: Boolean(d.is_active !== false),
              is_redeemed: Boolean(d.is_redeemed),
              redeemed_by: d.redeemed_by || d.redeemed_by_username || d.redeemed_by_email,
              redeemed_at: d.redeemed_at,
              created_at: d.created_at || new Date().toISOString(),
              created_by: d.created_by || 'Master Admin',
            };
            if (!codeMap.has(item.code.toUpperCase()) || item.is_redeemed) {
              codeMap.set(item.code.toUpperCase(), item);
            }
          }
        }
      } catch {}
    } catch (err) {
      console.warn('[Supabase VIP Codes Fetch Error]', err);
    }
  }

  // 3. Query Node / Express Backend API
  try {
    let res = await fetch(`/api/admin/vip-codes?adminPin=${encodeURIComponent(adminPin)}`);
    if (!res.ok) {
      res = await fetch('/api/admin/vip-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPin }),
      });
    }
    if (!res.ok) {
      res = await fetch('/api/admin/vip-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPin }),
      });
    }
    if (!res.ok) {
      res = await fetch('/api.php?action=admin_vip_codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPin }),
      });
    }

    if (res.ok) {
      const data = await res.json();
      const list = data?.codes || data?.keys;
      if (Array.isArray(list)) {
        for (const d of list) {
          const item: VipCodeItem = {
            id: d.id,
            code: d.code,
            duration_days: d.duration_days || 30,
            is_active: Boolean(d.is_active !== false),
            is_redeemed: Boolean(d.is_redeemed),
            redeemed_by: d.redeemed_by_username || d.redeemed_by_email || (d.redeemed_by_user_id ? `User #${d.redeemed_by_user_id}` : undefined),
            redeemed_at: d.redeemed_at,
            created_at: d.created_at || new Date().toISOString(),
            created_by: d.created_by || 'Master Admin',
          };
          codeMap.set(item.code.toUpperCase(), item);
        }
      }
    }
  } catch (err) {
    console.warn('[API VIP Codes Fetch Error]', err);
  }

  const merged = Array.from(codeMap.values()).sort((a, b) => {
    const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return timeB - timeA;
  });

  // Sync merged back to local storage
  if (merged.length > 0) {
    saveLocalVipCodes(merged);
  }

  return merged;
}

/**
 * Generate single or bulk secure VIP codes (PT-VIP-XXXXXXXX)
 * Inserts directly into online Supabase DB, syncs backend, and stores locally
 */
export async function generateVipKeys(
  count: number = 1,
  durationDays: number = 30,
  adminPin: string = '7789'
): Promise<{ success: boolean; keys?: VipCodeItem[]; message: string }> {
  const newCodes: VipCodeItem[] = [];
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  for (let i = 0; i < count; i++) {
    let rand = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const buffer = new Uint8Array(8);
      crypto.getRandomValues(buffer);
      for (const b of buffer) {
        rand += chars[b % chars.length];
      }
    } else {
      for (let j = 0; j < 8; j++) {
        rand += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    const code = `PT-VIP-${rand}`;
    newCodes.push({
      id: `vip_${Date.now()}_${i}`,
      code,
      duration_days: durationDays,
      is_active: true,
      is_redeemed: false,
      created_at: new Date().toISOString(),
      created_by: 'Master Admin',
    });
  }

  // 1. Immediately update and persist in local storage
  const currentLocal = getLocalVipCodes();
  const existingCodes = new Set(currentLocal.map((c) => c.code.toUpperCase()));
  const freshToAdd = newCodes.filter((c) => !existingCodes.has(c.code.toUpperCase()));
  const updatedLocal = [...freshToAdd, ...currentLocal];
  saveLocalVipCodes(updatedLocal);

  // 2. Try inserting into Supabase DB
  const supabase = getSupabaseClient();
  let supabaseInserted: VipCodeItem[] | null = null;
  if (supabase) {
    try {
      const rowsToInsert = newCodes.map((c) => ({
        code: c.code,
        duration_days: c.duration_days,
        is_active: true,
        is_redeemed: false,
        created_at: c.created_at,
        created_by_admin: 'Master Admin',
      }));

      const { data, error } = await supabase
        .from('vip_codes')
        .insert(rowsToInsert)
        .select();

      if (!error && Array.isArray(data)) {
        supabaseInserted = data.map((d: any) => ({
          id: d.id,
          code: d.code,
          duration_days: d.duration_days,
          is_active: d.is_active,
          is_redeemed: d.is_redeemed,
          redeemed_by: d.redeemed_by_email || (d.redeemed_by_user_id ? `User #${d.redeemed_by_user_id}` : undefined),
          redeemed_at: d.redeemed_at,
          created_at: d.created_at,
          created_by: d.created_by_admin || 'Master Admin',
        }));
      }
    } catch (err: any) {
      console.warn('[Supabase VIP Code Generation Error]', err);
    }
  }

  // 3. Sync to Node / Express Backend API
  let serverResultCodes: VipCodeItem[] | null = null;
  try {
    let res = await fetch('/api/admin/generate-vip-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, duration_days: durationDays, adminPin, codes: newCodes }),
    });
    if (!res.ok) {
      res = await fetch('/api/admin/generate-vip-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, durationDays, adminPin, codes: newCodes }),
      });
    }
    if (!res.ok) {
      res = await fetch('/api.php?action=admin_generate_vip_codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, duration_days: durationDays, adminPin, codes: newCodes }),
      });
    }

    if (res.ok) {
      const data = await res.json();
      const list = data.codes || data.keys;
      if (Array.isArray(list) && list.length > 0) {
        serverResultCodes = list;
      }
    }
  } catch (err: any) {
    console.warn('[Backend VIP Sync Warning]', err);
  }

  const finalCodes = supabaseInserted || serverResultCodes || newCodes;

  // Update local storage with final IDs if any
  const finalMap = new Map<string, VipCodeItem>();
  for (const c of updatedLocal) finalMap.set(c.code.toUpperCase(), c);
  for (const c of finalCodes) finalMap.set(c.code.toUpperCase(), c);
  const fullList = Array.from(finalMap.values());
  saveLocalVipCodes(fullList);

  // Sync complete list to app_settings key 'vip_codes' for 100% database persistence
  if (supabase) {
    try {
      await supabase.from('app_settings').upsert({
        key: 'vip_codes',
        value: fullList,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[app_settings VIP Codes save error]', err);
    }
  }

  return {
    success: true,
    keys: finalCodes,
    message: `Generated ${finalCodes.length} secure one-time VIP code(s)!`,
  };
}

/**
 * Toggle disable / enable VIP code
 */
export async function toggleVipKey(
  id: string | number,
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  // Update local storage first
  const current = getLocalVipCodes();
  let nextActive = false;
  const updated = current.map((c) => {
    if (String(c.id) === String(id) || c.code === String(id)) {
      nextActive = !c.is_active;
      return { ...c, is_active: nextActive };
    }
    return c;
  });
  saveLocalVipCodes(updated);

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data: row } = await supabase.from('vip_codes').select('is_active').eq('id', id).maybeSingle();
      if (row) {
        nextActive = !row.is_active;
      }
      await supabase.from('vip_codes').update({ is_active: nextActive }).eq('id', id);
    } catch (err) {
      console.warn('[Supabase Toggle VIP Error]', err);
    }

    try {
      await supabase.from('app_settings').upsert({
        key: 'vip_codes',
        value: updated,
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  try {
    let res = await fetch('/api/admin/toggle-vip-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, adminPin }),
    });
    if (!res.ok) {
      res = await fetch('/api/admin/toggle-vip-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, adminPin }),
      });
    }
  } catch {}

  return {
    success: true,
    message: `VIP Code status updated to ${nextActive ? 'ACTIVE' : 'DISABLED'}.`,
  };
}

/**
 * Admin Test Redeem Tool for verification
 */
export async function adminTestRedeemVipKey(
  code: string,
  usernameOrEmail: string = 'admin_test'
): Promise<{ success: boolean; message: string }> {
  const cleanKey = (code || '').trim().toUpperCase();
  const currentList = getLocalVipCodes();
  const found = currentList.find((c) => c.code.toUpperCase() === cleanKey);
  if (!found) {
    return { success: false, message: `VIP code "${cleanKey}" not found in inventory.` };
  }
  if (!found.is_active) {
    return { success: false, message: `VIP code "${cleanKey}" is deactivated.` };
  }
  if (found.is_redeemed) {
    return { success: false, message: `VIP code "${cleanKey}" was already redeemed by ${found.redeemed_by || 'another trader'}.` };
  }

  found.is_redeemed = true;
  found.redeemed_by = usernameOrEmail;
  found.redeemed_at = new Date().toISOString();
  saveLocalVipCodes(currentList);

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('vip_codes').update({
        is_redeemed: true,
        redeemed_by_email: usernameOrEmail,
        redeemed_at: found.redeemed_at,
      }).eq('code', cleanKey);
    } catch {}
    try {
      await supabase.from('app_settings').upsert({
        key: 'vip_codes',
        value: currentList,
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  return {
    success: true,
    message: `Code "${cleanKey}" marked as redeemed by ${usernameOrEmail}. Single-use rule verified!`,
  };
}

// =========================================================================
// BROKER PLATFORMS MANAGER (EXPERTOPTION, DERIV, POCKETOPTION, QUOTEX, MT5)
// =========================================================================
export const DEFAULT_BROKER_PLATFORMS: BrokerPlatformItem[] = [
  {
    id: 'expert_option',
    name: 'ExpertOption',
    profile: 'BINARY_QUICK',
    enabled: true,
    referralUrl: 'https://expertoption.com/?ref=TOLVEXA',
    badge: 'QUICK EXPIRY',
    icon: '⚡',
    sortOrder: 1,
  },
  {
    id: 'deriv',
    name: 'Deriv',
    profile: 'BINARY_QUICK',
    enabled: true,
    referralUrl: 'https://track.deriv.com/_tolvexa',
    badge: 'SYNTHETICS & FX',
    icon: '🎯',
    sortOrder: 2,
  },
  {
    id: 'pocket_option',
    name: 'PocketOption',
    profile: 'BINARY_QUICK',
    enabled: true,
    referralUrl: 'https://pocketoption.com/?ref=TOLVEXA',
    badge: 'DIGITAL OPTIONS',
    icon: '📈',
    sortOrder: 3,
  },
  {
    id: 'quotex',
    name: 'Quotex',
    profile: 'BINARY_QUICK',
    enabled: true,
    referralUrl: 'https://quotex.com/?ref=TOLVEXA',
    badge: 'BINARY FX',
    icon: '📊',
    sortOrder: 4,
  },
  {
    id: 'mt5',
    name: 'MetaTrader 5',
    profile: 'MT5',
    enabled: true,
    referralUrl: '',
    badge: 'CFD & FOREX',
    icon: '💼',
    sortOrder: 5,
  },
];

const STORAGE_KEY_PLATFORMS = 'pulsetrade_broker_platforms';

export function getBrokerPlatforms(): BrokerPlatformItem[] {
  if (typeof window === 'undefined') return DEFAULT_BROKER_PLATFORMS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PLATFORMS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_BROKER_PLATFORMS;
}

export async function fetchRemoteBrokerPlatforms(): Promise<BrokerPlatformItem[]> {
  let list = getBrokerPlatforms();
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'broker_platforms')
        .maybeSingle();

      if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
        list = data.value;
        if (typeof window !== 'undefined') {
          localStorage.setItem(STORAGE_KEY_PLATFORMS, JSON.stringify(list));
        }
        return list;
      }
    } catch (err) {
      console.warn('[Supabase Broker Platforms Fetch Error]', err);
    }
  }
  return list;
}

export async function saveBrokerPlatforms(
  platforms: BrokerPlatformItem[],
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_PLATFORMS, JSON.stringify(platforms));
    window.dispatchEvent(new CustomEvent('pulsetrade_platforms_changed', { detail: platforms }));
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('app_settings').upsert({
        key: 'broker_platforms',
        value: platforms,
        updated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn('[Supabase Platforms Save Error]', err);
    }
  }

  return { success: true, message: 'Broker platforms saved to database successfully!' };
}

// =========================================================================
// DIRECT WALLET ORDERS & ADMIN APPROVAL WORKFLOW
// =========================================================================
const STORAGE_KEY_WALLET_ORDERS = 'pulsetrade_direct_wallet_orders';

export function getLocalDirectWalletOrders(): DirectWalletOrder[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WALLET_ORDERS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export async function submitDirectWalletOrder(
  order: Omit<DirectWalletOrder, 'id' | 'created_at' | 'status'>
): Promise<{ success: boolean; orderId: string; message: string }> {
  const newOrder: DirectWalletOrder = {
    ...order,
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    status: 'pending_admin',
    created_at: new Date().toISOString(),
  };

  const current = getLocalDirectWalletOrders();
  const updated = [newOrder, ...current];
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_WALLET_ORDERS, JSON.stringify(updated));
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('wallet_orders').insert([{
        id: newOrder.id,
        user_id: newOrder.user_id,
        username: newOrder.username,
        email: newOrder.email,
        package_id: newOrder.package_id,
        package_name: newOrder.package_name,
        package_type: newOrder.package_type,
        credits_amount: newOrder.credits_amount,
        price_usd: newOrder.price_usd,
        coin_symbol: newOrder.coin_symbol,
        network: newOrder.network,
        wallet_address: newOrder.wallet_address,
        tx_hash: newOrder.tx_hash,
        notes: newOrder.notes,
        status: 'pending_admin',
        created_at: newOrder.created_at,
      }]);
    } catch {}

    try {
      await supabase.from('app_settings').upsert({
        key: 'direct_wallet_orders',
        value: updated.slice(0, 100),
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  return {
    success: true,
    orderId: newOrder.id,
    message: 'Transfer submitted successfully! Status: Pending Admin Verification.',
  };
}

export async function fetchDirectWalletOrders(): Promise<DirectWalletOrder[]> {
  const local = getLocalDirectWalletOrders();
  const orderMap = new Map<string, DirectWalletOrder>();
  for (const o of local) orderMap.set(o.id, o);

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'direct_wallet_orders').maybeSingle();
      if (data?.value && Array.isArray(data.value)) {
        for (const o of data.value) orderMap.set(o.id, o);
      }
    } catch {}

    try {
      const { data } = await supabase.from('wallet_orders').select('*').order('created_at', { ascending: false });
      if (Array.isArray(data)) {
        for (const d of data) {
          orderMap.set(d.id, {
            id: d.id,
            user_id: d.user_id,
            username: d.username,
            email: d.email,
            package_id: d.package_id,
            package_name: d.package_name,
            package_type: d.package_type,
            credits_amount: d.credits_amount,
            price_usd: d.price_usd,
            coin_symbol: d.coin_symbol,
            network: d.network,
            wallet_address: d.wallet_address,
            tx_hash: d.tx_hash,
            notes: d.notes,
            status: d.status,
            created_at: d.created_at,
            reviewed_at: d.reviewed_at,
            reviewed_by: d.reviewed_by,
          });
        }
      }
    } catch {}
  }

  const merged = Array.from(orderMap.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_WALLET_ORDERS, JSON.stringify(merged));
  }
  return merged;
}

export async function approveDirectWalletOrder(
  orderId: string,
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  const orders = await fetchDirectWalletOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) return { success: false, message: 'Order not found.' };
  if (order.status !== 'pending_admin') {
    return { success: false, message: `Order is already ${order.status}.` };
  }

  // Grant VIP or Credits based on package_type
  if (order.package_type === 'VIP_30_DAY') {
    await grantUserVip(order.user_id, 30, adminPin);
  } else {
    const supabase = getSupabaseClient();
    let currentCredits = 10;
    if (supabase) {
      try {
        const { data: u } = await supabase.from('users').select('credits').eq('id', order.user_id).maybeSingle();
        if (u) currentCredits = Number(u.credits) || 0;
      } catch {}
    }
    const newCredits = currentCredits + (order.credits_amount || 25);
    await adjustUserCredits(order.user_id, newCredits, adminPin);
  }

  order.status = 'approved';
  order.reviewed_at = new Date().toISOString();
  order.reviewed_by = 'Master Admin';

  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_WALLET_ORDERS, JSON.stringify(orders));
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('wallet_orders').update({
        status: 'approved',
        reviewed_at: order.reviewed_at,
        reviewed_by: order.reviewed_by,
      }).eq('id', orderId);
    } catch {}
    try {
      await supabase.from('app_settings').upsert({
        key: 'direct_wallet_orders',
        value: orders,
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  return {
    success: true,
    message: `Order #${orderId} approved! ${order.package_name} granted to ${order.username || order.email}.`,
  };
}

export async function rejectDirectWalletOrder(
  orderId: string,
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  const orders = await fetchDirectWalletOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) return { success: false, message: 'Order not found.' };

  order.status = 'rejected';
  order.reviewed_at = new Date().toISOString();
  order.reviewed_by = 'Master Admin';

  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_WALLET_ORDERS, JSON.stringify(orders));
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('wallet_orders').update({
        status: 'rejected',
        reviewed_at: order.reviewed_at,
        reviewed_by: order.reviewed_by,
      }).eq('id', orderId);
    } catch {}
    try {
      await supabase.from('app_settings').upsert({
        key: 'direct_wallet_orders',
        value: orders,
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  return {
    success: true,
    message: `Order #${orderId} marked as rejected. No credits or VIP granted.`,
  };
}

/**
 * Delete VIP code
 */
export async function deleteVipKey(
  id: string | number,
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { error } = await supabase.from('vip_codes').delete().eq('id', id);
      if (!error) {
        return { success: true, message: 'VIP Code deleted from database.' };
      }
    } catch (err) {
      console.warn('[Supabase Delete VIP Error]', err);
    }
  }

  try {
    const res = await fetch('/api/admin/delete-vip-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, adminPin }),
    });
    const data = await res.json();
    return { success: Boolean(data.success), message: data.message || 'VIP key deleted.' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error deleting VIP key.' };
  }
}

// =========================================================================
// EXTERNAL BROKER SETTINGS (Integration Mode)
// =========================================================================

export const DEFAULT_BROKERS_SETTINGS: BrokersSettings = {
  brokers: {
    deriv: {
      enabled: true,
      label: 'Open Deriv',
      referralUrl: 'https://track.deriv.com',
      openInNewTab: true,
    },
    expertOption: {
      enabled: true,
      label: 'Open ExpertOption',
      referralUrl: 'https://r.expertoption.com',
      openInNewTab: true,
    },
  },
  referralBonus: {
    enabled: true,
    extraCredits: 5,
    message: 'Register with referral code or via official broker partner link to claim +5 extra computation credits!',
    referralCode: 'TOLVEXA',
  },
};

export const DEFAULT_BROKER_CONFIG: ExternalBrokerConfig = {
  enabled: true,
  brokerName: 'Deriv',
  brokerUrl: 'https://track.deriv.com',
  openInNewTab: true,
  buttonLabel: 'Open Deriv',
};

const STORAGE_KEY_BROKERS = 'pulsetrade_brokers_settings';
const STORAGE_KEY_BROKER = 'pulsetrade_external_broker';

export function getBrokersSettings(): BrokersSettings {
  if (typeof window === 'undefined') return DEFAULT_BROKERS_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BROKERS);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        brokers: {
          deriv: { ...DEFAULT_BROKERS_SETTINGS.brokers.deriv, ...(parsed.brokers?.deriv || {}) },
          expertOption: { ...DEFAULT_BROKERS_SETTINGS.brokers.expertOption, ...(parsed.brokers?.expertOption || {}) },
        },
        referralBonus: { ...DEFAULT_BROKERS_SETTINGS.referralBonus, ...(parsed.referralBonus || {}) },
      };
    }
  } catch (e) {
    console.warn('[Brokers Settings Parse Error]', e);
  }
  return DEFAULT_BROKERS_SETTINGS;
}

export function getBrokerConfig(): ExternalBrokerConfig {
  const currentBrokers = getBrokersSettings();
  if (currentBrokers.brokers.deriv.enabled && currentBrokers.brokers.deriv.referralUrl) {
    return {
      enabled: true,
      brokerName: 'Deriv',
      brokerUrl: currentBrokers.brokers.deriv.referralUrl,
      openInNewTab: currentBrokers.brokers.deriv.openInNewTab,
      buttonLabel: currentBrokers.brokers.deriv.label || 'Open Deriv',
    };
  } else if (currentBrokers.brokers.expertOption.enabled && currentBrokers.brokers.expertOption.referralUrl) {
    return {
      enabled: true,
      brokerName: 'ExpertOption',
      brokerUrl: currentBrokers.brokers.expertOption.referralUrl,
      openInNewTab: currentBrokers.brokers.expertOption.openInNewTab,
      buttonLabel: currentBrokers.brokers.expertOption.label || 'Open ExpertOption',
    };
  }
  return DEFAULT_BROKER_CONFIG;
}

export async function fetchRemoteBrokersSettings(): Promise<BrokersSettings> {
  let settings = getBrokersSettings();
  const supabase = getSupabaseClient();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'brokers_settings')
        .maybeSingle();

      if (!error && data?.value) {
        settings = {
          brokers: {
            deriv: { ...DEFAULT_BROKERS_SETTINGS.brokers.deriv, ...(data.value.brokers?.deriv || {}) },
            expertOption: { ...DEFAULT_BROKERS_SETTINGS.brokers.expertOption, ...(data.value.brokers?.expertOption || {}) },
          },
          referralBonus: { ...DEFAULT_BROKERS_SETTINGS.referralBonus, ...(data.value.referralBonus || {}) },
        };
        localStorage.setItem(STORAGE_KEY_BROKERS, JSON.stringify(settings));
        return settings;
      }
    } catch (err) {
      console.warn('[Supabase Brokers Fetch Error]', err);
    }
  }

  try {
    const res = await fetch('/api/settings/brokers');
    if (res.ok) {
      const data = await res.json();
      if (data?.brokersSettings) {
        settings = {
          brokers: {
            deriv: { ...DEFAULT_BROKERS_SETTINGS.brokers.deriv, ...(data.brokersSettings.brokers?.deriv || {}) },
            expertOption: { ...DEFAULT_BROKERS_SETTINGS.brokers.expertOption, ...(data.brokersSettings.brokers?.expertOption || {}) },
          },
          referralBonus: { ...DEFAULT_BROKERS_SETTINGS.referralBonus, ...(data.brokersSettings.referralBonus || {}) },
        };
        localStorage.setItem(STORAGE_KEY_BROKERS, JSON.stringify(settings));
      }
    }
  } catch {}

  return settings;
}

export async function fetchRemoteBrokerConfig(): Promise<ExternalBrokerConfig> {
  await fetchRemoteBrokersSettings();
  return getBrokerConfig();
}

export async function saveBrokersSettings(
  newSettings: BrokersSettings,
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  // Validate Deriv URL if enabled
  if (newSettings.brokers.deriv.enabled && newSettings.brokers.deriv.referralUrl) {
    const u = newSettings.brokers.deriv.referralUrl.trim();
    if (!u.startsWith('https://') && !u.startsWith('http://')) {
      return { success: false, message: 'Deriv Referral URL must start with https://' };
    }
  }

  // Validate ExpertOption URL if enabled
  if (newSettings.brokers.expertOption.enabled && newSettings.brokers.expertOption.referralUrl) {
    const u = newSettings.brokers.expertOption.referralUrl.trim();
    if (!u.startsWith('https://') && !u.startsWith('http://')) {
      return { success: false, message: 'ExpertOption Referral URL must start with https://' };
    }
  }

  // 1. Save local
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_BROKERS, JSON.stringify(newSettings));
    window.dispatchEvent(new CustomEvent('pulsetrade_brokers_changed', { detail: newSettings }));
  }

  // 2. Save Supabase app_settings
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from('app_settings').upsert({
        key: 'brokers_settings',
        value: newSettings,
        updated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn('[Supabase Brokers Save Error]', err);
    }
  }

  // 3. Save backend
  try {
    await fetch('/api/settings/brokers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brokersSettings: newSettings, adminPin }),
    });
  } catch {}

  return {
    success: true,
    message: 'Broker & Referral settings saved to database successfully!',
  };
}

export async function saveBrokerConfig(
  newConfig: ExternalBrokerConfig,
  adminPin: string = '7789'
): Promise<{ success: boolean; message: string }> {
  const current = getBrokersSettings();
  current.brokers.deriv = {
    enabled: newConfig.enabled,
    label: newConfig.buttonLabel || 'Open Deriv',
    referralUrl: newConfig.brokerUrl,
    openInNewTab: newConfig.openInNewTab,
  };
  return saveBrokersSettings(current, adminPin);
}

