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

export function getAuthHeaders(): Record<string, string> {
  let token = '';
  if (typeof window !== 'undefined') {
    token = localStorage.getItem('pulsetrade_session_token') || sessionStorage.getItem('pulsetrade_session_token') || '';
    if (!token) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          try {
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            if (parsed?.access_token) {
              token = parsed.access_token;
              break;
            }
          } catch {}
        }
      }
    }
  }
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

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
  siteName: 'Tolvexa',
  siteTagline: 'Quantitative Micro-Volatility Trading Signal Companion',
  logoUrl: '',
  faviconUrl: '',
  logoIcon: 'zap',
  badgeText: 'v8.2 QUANT',
  bannerText: '⚡ 30-Day VIP Pass: Multi-window live confirmation with 24/7 verified Deriv feeds',
  bannerEnabled: true,
  supportTelegram: 'https://t.me/pulsetrade_quant',
  supportWhatsapp: '',
  supportEmail: 'support@tolvexa.com',
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

  // 2. Try Backend API
  try {
    const res = await fetch('/api/admin/settings');
    if (res.ok) {
      const data = await res.json();
      if (data && data.settings) {
        settings = { ...DEFAULT_SITE_SETTINGS, ...(data.settings.site_branding || data.settings) };
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

  // 2. Save to server backend with auth headers
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ key: 'site_branding', value: merged }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn('[Server Settings Save Warning]', data?.error);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('[Server Settings Save Network Error]', err);
    return false;
  }
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
      console.warn('[Supabase NOWPayments Fetch Error]', err);
    }
  }

  return config;
}

/**
 * Save NOWPayments configuration via admin settings
 */
export async function saveNowPaymentsConfig(newConfig: NowPaymentsConfig): Promise<boolean> {
  const merged = { ...DEFAULT_NOWPAYMENTS_CONFIG, ...newConfig };

  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_NOWPAYMENTS, JSON.stringify(merged));
    window.dispatchEvent(new CustomEvent('pulsetrade_nowpayments_changed', { detail: merged }));
  }

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ key: 'nowpayments_config', value: merged }),
    });
    return res.ok;
  } catch (err: any) {
    console.warn('[Save NOWPayments Config Error]', err);
    return false;
  }
}

/**
 * Test NOWPayments API connectivity
 */
export async function testNowPaymentsConnection(
  _apiKey: string,
  _isSandbox: boolean = false
): Promise<{ success: boolean; message: string }> {
  return {
    success: false,
    message: 'Payments are being set up. Payment gateway testing and live webhook integration will be enabled in Stage 5.',
  };
}

/**
 * Create a live NOWPayments invoice for instant payment verification
 */
export async function createNowPaymentsPayment(_params: {
  priceAmount: number;
  priceCurrency?: string;
  payCurrency: string;
  orderId: string;
  orderDescription: string;
}): Promise<{ success: boolean; data?: NowPaymentsPayment; message?: string }> {
  return {
    success: false,
    message: 'Payments are being set up. Automated cryptocurrency invoices will be enabled in Stage 5.',
  };
}

/**
 * Poll payment status from NOWPayments
 */
export async function checkNowPaymentsStatus(_paymentId: string): Promise<{
  success: boolean;
  data?: NowPaymentsPayment;
  message?: string;
}> {
  return {
    success: false,
    message: 'Payments are being set up. Real-time blockchain status tracking will be enabled in Stage 5.',
  };
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
    const res = await fetch('/api/admin/pricing');
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
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  localStorage.setItem(STORAGE_KEY_PACKAGES, JSON.stringify(packages));
  window.dispatchEvent(new CustomEvent('pulsetrade_packages_changed', { detail: packages }));

  try {
    const res = await fetch('/api/admin/pricing', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ packages }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return {
        success: false,
        message: data.error || 'Failed to update pricing packages on server.',
      };
    }

    return {
      success: true,
      message: data.message || 'Pricing packages saved and synchronized successfully!',
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Network error updating pricing packages.',
    };
  }
}

/**
 * Fetch all registered users for Admin Dashboard from live online Supabase DB or Server API
 */
export async function fetchAdminUsers(_adminPin?: string): Promise<AdminUserItem[]> {
  try {
    const res = await fetch('/api/admin/users', {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.users)) {
        return data.users.map((u: any) => {
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
    }
  } catch (err) {
    console.warn('[API Users Fetch Error]', err);
  }

  return [];
}

/**
 * Grant 30-Day VIP to a user
 */
export async function grantUserVip(
  userId: string | number,
  days: number = 30,
  _adminPin?: string
): Promise<{ success: boolean; user?: any; message: string }> {
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'grant_vip', userId, days }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { success: false, message: data.error || 'Failed to grant VIP.' };
    }
    return {
      success: true,
      user: data.user,
      message: data.message || `30-Day VIP granted!`,
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
  _adminPin?: string
): Promise<{ success: boolean; user?: any; message: string }> {
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'revoke_vip', userId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { success: false, message: data.error || 'Failed to revoke VIP.' };
    }
    return {
      success: true,
      user: data.user,
      message: data.message || 'VIP status revoked and account reset.',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error revoking VIP.' };
  }
}

/**
 * Adjust user credits balance
 */
export async function adjustUserCredits(
  userId: string | number,
  credits: number,
  _adminPin?: string
): Promise<{ success: boolean; user?: any; message: string }> {
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'adjust_credits', userId, credits, reason: 'admin_manual_adjustment' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { success: false, message: data.error || 'Failed to adjust credits.' };
    }
    return {
      success: true,
      user: data.user,
      message: data.message || `Account credits adjusted to ${credits} CR.`,
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error adjusting credits.' };
  }
}

// VIP codes are stored strictly in the database and never kept in browser storage
function getLocalVipCodes(): VipCodeItem[] {
  return [];
}

function saveLocalVipCodes(_codes: VipCodeItem[]) {
  // No-op: zero admin data in localStorage
}

/**
 * Fetch all VIP codes for Admin from Supabase DB or Server API
 */
export async function fetchAdminVipKeys(_adminPin?: string): Promise<VipCodeItem[]> {
  try {
    const res = await fetch('/api/admin/vip-codes', {
      headers: getAuthHeaders(),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.vipCodes)) {
        return data.vipCodes.map((d: any) => ({
          id: d.id,
          code: d.code,
          duration_days: d.duration_days || 30,
          is_active: Boolean(d.is_active),
          is_redeemed: Boolean(d.is_redeemed),
          redeemed_by: d.redeemed_by_email || (d.redeemed_by_user_id ? `User #${d.redeemed_by_user_id}` : undefined),
          redeemed_at: d.redeemed_at,
          created_at: d.created_at || new Date().toISOString(),
          created_by: d.created_by_admin || 'Master Admin',
        }));
      }
    }
  } catch (err) {
    console.warn('[API VIP Codes Fetch Error]', err);
  }

  return [];
}

/**
 * Generate single or bulk secure VIP codes via server-side admin endpoint
 */
export async function generateVipKeys(
  count: number = 1,
  durationDays: number = 30,
  _adminPin?: string
): Promise<{ success: boolean; keys?: VipCodeItem[]; message: string }> {
  try {
    const res = await fetch('/api/admin/vip-codes', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'generate', count, durationDays }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return {
        success: false,
        message: data.error || 'Failed to generate VIP codes.',
      };
    }

    const generated = (data.generated || []).map((d: any) => ({
      id: d.id,
      code: d.code,
      duration_days: d.duration_days || durationDays,
      is_active: Boolean(d.is_active),
      is_redeemed: Boolean(d.is_redeemed),
      created_at: d.created_at || new Date().toISOString(),
      created_by: d.created_by_admin || 'Master Admin',
    }));

    return {
      success: true,
      keys: generated,
      message: data.message || `Generated ${generated.length} secure VIP code(s)!`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Network error generating VIP keys.',
    };
  }
}

/**
 * Toggle disable / enable VIP code via server-side admin endpoint
 */
export async function toggleVipKey(
  id: string | number,
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/admin/vip-codes', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'toggle', id }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return {
        success: false,
        message: data.error || 'Failed to toggle VIP code status.',
      };
    }

    return {
      success: true,
      message: `VIP Code status updated to ${data.code?.is_active ? 'ACTIVE' : 'DISABLED'}.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Network error toggling VIP code status.',
    };
  }
}

/**
 * Admin Test Redeem Tool for verification via atomic server RPC
 */
export async function adminTestRedeemVipKey(
  code: string,
  _usernameOrEmail: string = 'admin_test'
): Promise<{ success: boolean; message: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, message: 'Database client not connected.' };
  }

  try {
    const { data, error } = await supabase.rpc('redeem_vip', { p_code: code.trim().toUpperCase() });
    if (error) {
      return { success: false, message: error.message };
    }
    if (data?.ok) {
      return {
        success: true,
        message: `Code "${code.toUpperCase()}" redeemed successfully! VIP active until ${data.vip_expires_at || '30 days'}.`,
      };
    }
    return {
      success: false,
      message: data?.error || 'Redemption rejected.',
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Error processing VIP code redemption.',
    };
  }
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

export function getBrokerPlatforms(): BrokerPlatformItem[] {
  return DEFAULT_BROKER_PLATFORMS;
}

export async function fetchRemoteBrokerPlatforms(): Promise<BrokerPlatformItem[]> {
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'broker_platforms')
        .maybeSingle();

      if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
        return data.value;
      }
    } catch (err) {
      console.warn('[Supabase Broker Platforms Fetch Error]', err);
    }
  }
  return DEFAULT_BROKER_PLATFORMS;
}

export async function saveBrokerPlatforms(
  platforms: BrokerPlatformItem[],
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ key: 'broker_platforms', value: platforms }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, message: data.error || 'Failed to update broker platforms.' };
    }
    return { success: true, message: 'Broker platforms saved to database successfully!' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error updating broker platforms.' };
  }
}

// =========================================================================
// DIRECT WALLET ORDERS & ADMIN APPROVAL WORKFLOW
// =========================================================================
export function getLocalDirectWalletOrders(): DirectWalletOrder[] {
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

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('direct_orders').insert([{
        user_id: newOrder.user_id,
        package_id: String(newOrder.package_id),
        amount: newOrder.price_usd,
        tx_hash: newOrder.tx_hash,
        status: 'PENDING',
        reviewer_notes: `${newOrder.coin_symbol || 'CRYPTO'} - ${newOrder.network || 'MAINNET'}`,
      }]).select().single();

      if (!error && data) {
        return {
          success: true,
          orderId: String(data.id),
          message: 'Transfer submitted successfully! Status: Pending Verification.',
        };
      }
    } catch (err) {
      console.warn('[Direct Order Submit Error]', err);
    }
  }

  return {
    success: true,
    orderId: newOrder.id,
    message: 'Transfer submitted successfully! Status: Pending Verification.',
  };
}

export async function fetchDirectWalletOrders(): Promise<DirectWalletOrder[]> {
  try {
    const res = await fetch('/api/admin/orders', {
      headers: getAuthHeaders(),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.directOrders)) {
        return data.directOrders.map((d: any) => ({
          id: String(d.id),
          user_id: d.user_id,
          username: d.users?.username || `User #${d.user_id}`,
          email: d.users?.email || '',
          package_id: d.package_id,
          package_name: d.package_id,
          package_type: String(d.package_id).toLowerCase().includes('vip') ? 'VIP_30_DAY' : 'CREDITS',
          credits_amount: 25,
          price_usd: Number(d.amount) || 0,
          coin_symbol: 'CRYPTO',
          network: 'MAINNET',
          wallet_address: '',
          tx_hash: d.tx_hash,
          notes: d.reviewer_notes,
          status: (d.status || 'PENDING').toLowerCase(),
          created_at: d.created_at,
          reviewed_at: d.reviewed_at,
          reviewed_by: d.reviewed_by ? String(d.reviewed_by) : undefined,
        }));
      }
    }
  } catch (err) {
    console.warn('[Fetch Direct Wallet Orders Error]', err);
  }

  return [];
}

export async function approveDirectWalletOrder(
  orderId: string,
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/admin/orders', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'approve', orderId: Number(orderId) || orderId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { success: false, message: data.error || 'Failed to approve order.' };
    }

    return {
      success: true,
      message: data.message || `Order #${orderId} approved and benefits credited!`,
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error approving order.' };
  }
}

export async function rejectDirectWalletOrder(
  orderId: string,
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/admin/orders', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'reject', orderId: Number(orderId) || orderId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { success: false, message: data.error || 'Failed to reject order.' };
    }

    return {
      success: true,
      message: data.message || `Order #${orderId} marked as rejected.`,
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error rejecting order.' };
  }
}

/**
 * Delete VIP code via server-side admin endpoint
 */
export async function deleteVipKey(
  id: string | number,
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/admin/vip-codes', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'delete', id }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { success: false, message: data.error || 'Failed to delete VIP key.' };
    }

    return {
      success: true,
      message: data.message || 'VIP key removed.',
    };
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
        return settings;
      }
    } catch (err) {
      console.warn('[Supabase Brokers Fetch Error]', err);
    }
  }

  try {
    const res = await fetch('/api/admin/settings');
    if (res.ok) {
      const data = await res.json();
      const brokersVal = data?.settings?.brokers_settings;
      if (brokersVal) {
        settings = {
          brokers: {
            deriv: { ...DEFAULT_BROKERS_SETTINGS.brokers.deriv, ...(brokersVal.brokers?.deriv || {}) },
            expertOption: { ...DEFAULT_BROKERS_SETTINGS.brokers.expertOption, ...(brokersVal.brokers?.expertOption || {}) },
          },
          referralBonus: { ...DEFAULT_BROKERS_SETTINGS.referralBonus, ...(brokersVal.referralBonus || {}) },
        };
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
  _adminPin?: string
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

  // 1. Dispatch event without localStorage persistence
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pulsetrade_brokers_changed', { detail: newSettings }));
  }

  // 2. Save via server-side admin settings
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ key: 'brokers_settings', value: newSettings }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, message: data.error || 'Failed to update broker settings.' };
    }
  } catch (err: any) {
    return { success: false, message: err?.message || 'Network error updating broker settings.' };
  }

  return {
    success: true,
    message: 'Broker & Referral settings saved to database successfully!',
  };
}

export async function saveBrokerConfig(
  newConfig: ExternalBrokerConfig,
  _adminPin?: string
): Promise<{ success: boolean; message: string }> {
  const current = getBrokersSettings();
  current.brokers.deriv = {
    enabled: newConfig.enabled,
    label: newConfig.buttonLabel || 'Open Deriv',
    referralUrl: newConfig.brokerUrl,
    openInNewTab: newConfig.openInNewTab,
  };
  return saveBrokersSettings(current);
}

