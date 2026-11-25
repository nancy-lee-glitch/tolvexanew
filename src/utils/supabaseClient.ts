import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { InstrumentSpec, UserProfile, UserTradingProfile } from '../types.ts';
import { DEFAULT_INSTRUMENT_SPECS, normalizeSpecKey } from './engines/mt5Engine.ts';
import type { ChartHistorySignalItem } from './chartOverlays.ts';

let supabaseInstance: SupabaseClient | null = null;
let currentConfigKey = '';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

// Canonical Supabase Project Credentials (public anon key safe for browser)
const DEFAULT_SUPABASE_URL = 'https://uhzodamgzhnicifobnjj.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoem9kYW1nemhuaWNpZm9ibmpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NDAxNzQsImV4cCI6MjEwNTQxNjE3NH0.SFgqhFDOnZ1bfhI4raCSEhvkmlCTgUDEaJHxAtjMRpA';

/**
 * Get active Supabase configuration strictly from environment variables or project defaults.
 * Zero localStorage overrides allowed.
 */
export function getSupabaseConfig(): SupabaseConfig {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const envUrl = meta.env?.VITE_SUPABASE_URL || '';
  const envAnonKey = meta.env?.VITE_SUPABASE_ANON_KEY || '';

  const url = (envUrl || DEFAULT_SUPABASE_URL).trim();
  const anonKey = (envAnonKey || DEFAULT_SUPABASE_ANON_KEY).trim();

  return { url, anonKey };
}

/**
 * Check if valid Supabase credentials are configured
 */
export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseConfig();
  return Boolean(url && url.startsWith('http') && anonKey && anonKey.length > 20);
}

/**
 * Get or initialize Supabase client with persistent session handling
 */
export function getSupabaseClient(): SupabaseClient | null {
  const { url, anonKey } = getSupabaseConfig();

  if (!url || !anonKey || !url.startsWith('http')) {
    return null;
  }

  const keyCombination = `${url}_${anonKey}`;
  if (supabaseInstance && currentConfigKey === keyCombination) {
    return supabaseInstance;
  }

  try {
    supabaseInstance = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    currentConfigKey = keyCombination;
    return supabaseInstance;
  } catch (err) {
    console.warn('[Supabase Client Error]', err);
    return null;
  }
}

/**
 * Robust 10-second fetch wrapper with AbortController and normalized return shape
 */
export async function secureFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON response
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: json?.error || json?.message || `HTTP error ${res.status}`,
      };
    }

    return {
      ok: true,
      status: res.status,
      data: json,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return {
        ok: false,
        status: 408,
        error: 'Network request timed out after 10 seconds. Please check your connection.',
      };
    }
    return {
      ok: false,
      status: 0,
      error: err?.message || 'Unable to establish server connection.',
    };
  }
}

/**
 * Test Supabase connectivity and table presence
 */
export async function testSupabaseConnection(
  url: string,
  anonKey: string
): Promise<{ success: boolean; message: string; activeTraders?: number }> {
  try {
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      return { success: false, message: 'Invalid URL format. Project URL must start with https://' };
    }
    if (anonKey.length < 25) {
      return { success: false, message: 'Invalid Anon Public Key provided.' };
    }

    const testClient = createClient(url, anonKey);
    const { data, error } = await testClient.rpc('online_count');

    if (error) {
      return { success: false, message: `Database Notice: ${error.message}` };
    }

    return {
      success: true,
      message: 'Successfully connected to Tickvere PostgreSQL database!',
      activeTraders: Number(data) || 1,
    };
  } catch (err: any) {
    return { success: false, message: `Connection failed: ${err?.message || 'Network error'}` };
  }
}

export const DEFAULT_USER_TRADING_PROFILE: UserTradingProfile = {
  accountCurrency: 'USD',
  accountBalance: 1000,
  riskPct: 1.0,
  leverage: 100,
  brokerSpreadPips: 1.2,
  contractSizeOverrides: {},
};

function parseTradingProfileFromRow(dbUser?: any): UserTradingProfile {
  const allowedCcy = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF']);
  const rawCcy = typeof dbUser?.account_currency === 'string' ? dbUser.account_currency.toUpperCase() : 'USD';
  const accountCurrency = (allowedCcy.has(rawCcy) ? rawCcy : 'USD') as UserTradingProfile['accountCurrency'];
  const rawBalance = Number(dbUser?.account_balance);
  const rawRisk = Number(dbUser?.risk_pct);
  const rawLeverage = Number(dbUser?.leverage);
  const rawSpread = Number(dbUser?.broker_spread_pips);
  const rawOverrides =
    dbUser?.contract_size_overrides && typeof dbUser.contract_size_overrides === 'object'
      ? dbUser.contract_size_overrides
      : {};

  return {
    accountCurrency,
    accountBalance: Number.isFinite(rawBalance) && rawBalance >= 0 ? rawBalance : DEFAULT_USER_TRADING_PROFILE.accountBalance,
    riskPct:
      Number.isFinite(rawRisk) && rawRisk >= 0.1 && rawRisk <= 3.0
        ? rawRisk
        : DEFAULT_USER_TRADING_PROFILE.riskPct,
    leverage:
      Number.isFinite(rawLeverage) && rawLeverage >= 1 && rawLeverage <= 2000
        ? Math.round(rawLeverage)
        : DEFAULT_USER_TRADING_PROFILE.leverage,
    brokerSpreadPips:
      Number.isFinite(rawSpread) && rawSpread >= 0
        ? rawSpread
        : DEFAULT_USER_TRADING_PROFILE.brokerSpreadPips,
    contractSizeOverrides: rawOverrides,
  };
}

/**
 * Format a Supabase user into standard UserProfile.
 * Role, VIP status, and credits are strictly derived from the database row.
 */
export function mapToUserProfile(userObj: any, dbUser?: any): UserProfile {
  let isVip = Boolean(dbUser?.is_vip);
  const vipExpiresAt = dbUser?.vip_expires_at || null;

  let vipDaysLeft = 0;
  let vipHoursLeft = 0;
  let vipSecondsLeft = 0;

  if (isVip && vipExpiresAt) {
    const diffMs = new Date(vipExpiresAt).getTime() - Date.now();
    if (diffMs <= 0) {
      isVip = false;
    } else {
      vipSecondsLeft = Math.floor(diffMs / 1000);
      vipDaysLeft = Math.floor(vipSecondsLeft / 86400);
      vipHoursLeft = Math.floor((vipSecondsLeft % 86400) / 3600);
    }
  }

  const role: 'USER' | 'ADMIN' = dbUser?.role === 'ADMIN' ? 'ADMIN' : 'USER';
  const email = (userObj?.email || dbUser?.email || '').toLowerCase();

  let credits = 10;
  if (role === 'ADMIN' || isVip) {
    credits = 9999;
  } else if (typeof dbUser?.credits === 'number') {
    credits = dbUser.credits;
  }

  const metadata = userObj?.user_metadata || {};

  return {
    id: dbUser?.id || (userObj?.id ? parseInt(String(userObj.id).replace(/\D/g, '').slice(0, 8)) || 1 : 1),
    username: dbUser?.username || metadata.username || email.split('@')[0] || 'Trader',
    email,
    role,
    credits,
    is_vip: isVip,
    vip_expires_at: vipExpiresAt,
    vip_days_left: vipDaysLeft,
    vip_hours_left: vipHoursLeft,
    vip_seconds_left: vipSecondsLeft,
    trading_profile: parseTradingProfileFromRow(dbUser),
  };
}

/**
 * Register new user with server-side validation & anti-abuse checks via /api/auth/register
 */
export async function signUpWithSupabase(
  email: string,
  password: string,
  username: string,
  vipKey?: string,
  _extraCredits?: number,
  turnstileToken?: string,
  website?: string
): Promise<{ success: boolean; user?: UserProfile; requireEmailConfirmation?: boolean; message: string }> {
  const trimmedEmail = (email || '').trim().toLowerCase();
  const trimmedUsername = (username || '').trim();
  const cleanPassword = password || '';

  if (!trimmedUsername || trimmedUsername.length < 3) {
    return { success: false, message: 'Username must be at least 3 characters long.' };
  }
  if (trimmedUsername.length > 30) {
    return { success: false, message: 'Username cannot exceed 30 characters.' };
  }
  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    return { success: false, message: 'Please enter a valid email address.' };
  }
  if (!cleanPassword || cleanPassword.length < 8) {
    return { success: false, message: 'Password must be at least 8 characters long.' };
  }
  if (cleanPassword.length > 128) {
    return { success: false, message: 'Password cannot exceed 128 characters.' };
  }

  // 1. Call serverless registration endpoint
  const regResult = await secureFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: trimmedUsername,
      email: trimmedEmail,
      password: cleanPassword,
      turnstileToken: turnstileToken || '',
      website: website || '',
    }),
  });

  if (!regResult.ok) {
    return {
      success: false,
      message: regResult.error || 'Registration failed. Please check your credentials.',
    };
  }

  if (regResult.data?.requireEmailConfirmation) {
    return {
      success: true,
      requireEmailConfirmation: true,
      message: regResult.data?.message || 'Account created! Please check your email to confirm your account before logging in.',
    };
  }

  // If email confirmation is disabled on the project, proceed to sign in
  const loginRes = await signInWithSupabase(trimmedEmail, cleanPassword);
  if (loginRes.success && vipKey && vipKey.trim()) {
    await redeemVipKeyWithSupabase(vipKey, loginRes.user || null);
  }

  return loginRes;
}

/**
 * Sign In existing user with email/username and password
 */
export async function signInWithSupabase(
  identity: string,
  password: string
): Promise<{ success: boolean; user?: UserProfile; message: string }> {
  const trimmedIdentity = (identity || '').trim();
  const cleanPassword = password || '';

  if (!trimmedIdentity) {
    return { success: false, message: 'Please enter your username or email address.' };
  }
  if (!cleanPassword) {
    return { success: false, message: 'Please enter your password.' };
  }

  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      message: 'Supabase client is unavailable. Please verify connection credentials.',
    };
  }

  try {
    let emailToUse = trimmedIdentity.toLowerCase();

    // If identity is a username, lookup associated email
    if (!emailToUse.includes('@')) {
      try {
        const { data: match } = await client
          .from('users')
          .select('email')
          .ilike('username', trimmedIdentity)
          .limit(1)
          .maybeSingle();
        if (match?.email) {
          emailToUse = match.email;
        }
      } catch {
        // Proceed with identity
      }
    }

    const { data: authData, error: authError } = await client.auth.signInWithPassword({
      email: emailToUse,
      password: cleanPassword,
    });

    if (authError) {
      if (authError.message.toLowerCase().includes('invalid login credentials')) {
        return { success: false, message: 'Invalid email or password. Please verify your credentials.' };
      }
      return { success: false, message: authError.message };
    }

    if (!authData?.user) {
      return { success: false, message: 'Authentication failed. Please verify your credentials.' };
    }

    // Fetch user row from public.users
    let dbUser: any = null;
    try {
      const { data } = await client
        .from('users')
        .select('*')
        .eq('auth_user_id', authData.user.id)
        .limit(1)
        .maybeSingle();
      dbUser = data;
    } catch {
      // Ignored
    }

    const profile = mapToUserProfile(authData.user, dbUser);
    return {
      success: true,
      user: profile,
      message: 'Authentication successful!',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Sign in request failed.' };
  }
}

/**
 * Sign Out
 */
export async function signOutSupabase(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    await client.auth.signOut();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current active session user on app boot
 */
export async function getCurrentSupabaseUser(): Promise<UserProfile | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData?.session?.user) {
      return null;
    }

    const user = sessionData.session.user;

    let dbUser: any = null;
    try {
      const { data } = await client
        .from('users')
        .select('*')
        .eq('auth_user_id', user.id)
        .limit(1)
        .maybeSingle();
      dbUser = data;
    } catch {
      // Ignored
    }

    return mapToUserProfile(user, dbUser);
  } catch {
    return null;
  }
}

/**
 * Atomic VIP code redemption via SECURITY DEFINER RPC `redeem_vip_code`
 */
export async function redeemVipKeyWithSupabase(
  vipKey: string,
  currentUser: UserProfile | null
): Promise<{ success: boolean; user?: UserProfile; message: string }> {
  if (!currentUser) {
    return { success: false, message: 'Please sign in or create an account first.' };
  }

  const cleanKey = (vipKey || '').trim().toUpperCase();
  if (!cleanKey) {
    return { success: false, message: 'Please enter a valid VIP activation code.' };
  }

  const client = getSupabaseClient();
  if (!client) {
    return { success: false, message: 'Database client not connected.' };
  }

  try {
    // Call atomic RPC
    const { data, error } = await client.rpc('redeem_vip_code', {
      p_code: cleanKey,
    });

    if (error) {
      return { success: false, message: error.message };
    }

    if (!data?.ok) {
      return {
        success: false,
        message: data?.error || 'Invalid or already redeemed VIP access key.',
      };
    }

    const newVipExpiresAt = data.vip_expires_at;
    const diffMs = new Date(newVipExpiresAt).getTime() - Date.now();
    const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
    const daysLeft = Math.floor(totalSeconds / 86400);
    const hoursLeft = Math.floor((totalSeconds % 86400) / 3600);

    const updatedProfile: UserProfile = {
      ...currentUser,
      is_vip: true,
      vip_expires_at: newVipExpiresAt,
      vip_days_left: daysLeft,
      vip_hours_left: hoursLeft,
      vip_seconds_left: totalSeconds,
      credits: 9999,
    };

    return {
      success: true,
      user: updatedProfile,
      message: `★ ${data.days_granted || 30}-Day VIP Pass activated! Unlimited signals unlocked until ${new Date(newVipExpiresAt).toLocaleDateString()}.`,
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Failed to process VIP redemption.' };
  }
}

/**
 * Deduct Credit via atomic SECURITY DEFINER RPC `consume_credit`
 *
 * NOTE: Analysis currently runs in the browser, so this gate protects the credit balance
 * but cannot hide analysis code that ships in the bundle; premium outputs (history,
 * backtests, MT5 plans) move behind server endpoints with entitlement checks in Stage 4.
 */
export async function deductCreditWithSupabase(
  currentUser: UserProfile,
  profile: 'binary' | 'mt5' = 'binary'
): Promise<{ success: boolean; credits: number; is_vip: boolean; message: string }> {
  if (currentUser.is_vip || currentUser.role === 'ADMIN') {
    return {
      success: true,
      credits: currentUser.credits,
      is_vip: true,
      message: 'VIP Unlimited Access Active (0 credits consumed)',
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    if (currentUser.credits <= 0) {
      return {
        success: false,
        credits: 0,
        is_vip: false,
        message: 'Insufficient credits. Upgrade to VIP or top up credits.',
      };
    }
    return {
      success: true,
      credits: currentUser.credits - 1,
      is_vip: false,
      message: '1 credit deducted for algorithmic signal computation.',
    };
  }

  try {
    // The server defines the credit cost in app_settings (binary: 1, mt5: 2)
    const { data, error } = await client.rpc('consume_credit', { p_profile: profile });

    if (error) {
      return { success: false, credits: currentUser.credits, is_vip: false, message: error.message };
    }

    if (!data?.ok) {
      return {
        success: false,
        credits: data?.credits ?? currentUser.credits,
        is_vip: Boolean(data?.unlimited),
        message: data?.error || 'Insufficient credits. Upgrade to VIP or top up credits.',
      };
    }

    return {
      success: true,
      credits: data.credits,
      is_vip: Boolean(data.unlimited),
      message: data.unlimited
        ? 'VIP Unlimited Access Active (0 credits consumed)'
        : `${data.cost || 1} credit deducted for algorithmic signal computation.`,
    };
  } catch (err: any) {
    return {
      success: false,
      credits: currentUser.credits,
      is_vip: false,
      message: err?.message || 'Error executing credit deduction.',
    };
  }
}

/**
 * Real-Time Presence Heartbeat via atomic RPC `presence_ping`
 */
export async function sendSupabasePresence(
  sessionId: string,
  _userId: number | null,
  activeAsset: string
): Promise<number | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const { data, error } = await client.rpc('presence_ping', {
      p_session: sessionId,
      p_asset: activeAsset || 'EUR/USD',
    });

    if (error) {
      return null;
    }

    return Number(data) || 1;
  } catch {
    return null;
  }
}

export interface BrokerAssetMeta {
  payoutPct: number;
  isOtc: boolean;
  enabled: boolean;
}

export interface MarketEventRow {
  id: string;
  starts_at: string;
  ends_at?: string | null;
  currency: string;
  title: string;
  impact: 'LOW' | 'MEDIUM' | 'HIGH' | 'HOLIDAY';
}

const brokerMetaCache = new Map<string, { data: BrokerAssetMeta; fetchedAt: number }>();
let marketEventsCache: { data: MarketEventRow[]; fetchedAt: number } | null = null;
const META_TTL_MS = 60_000;

/**
 * Fetch broker asset payout percentage and OTC status from public.broker_assets.
 * Falls back to { payoutPct: 85, isOtc: false, enabled: true } when unavailable.
 */
export async function fetchBrokerAssetMeta(brokerId: string, symbol: string): Promise<BrokerAssetMeta> {
  const key = `${brokerId}:${symbol}`;
  const cached = brokerMetaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < META_TTL_MS) {
    return cached.data;
  }

  const fallback: BrokerAssetMeta = { payoutPct: 85, isOtc: false, enabled: true };
  const client = getSupabaseClient();
  if (!client || !brokerId || !symbol) return fallback;

  try {
    const { data, error } = await client
      .from('broker_assets')
      .select('payout_pct, is_otc, enabled')
      .eq('broker_id', brokerId)
      .eq('symbol', symbol)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      brokerMetaCache.set(key, { data: fallback, fetchedAt: Date.now() });
      return fallback;
    }

    const resolved: BrokerAssetMeta = {
      payoutPct: typeof data.payout_pct === 'number' && data.payout_pct > 0 ? Number(data.payout_pct) : 85,
      isOtc: Boolean(data.is_otc),
      enabled: data.enabled !== false,
    };
    brokerMetaCache.set(key, { data: resolved, fetchedAt: Date.now() });
    return resolved;
  } catch {
    return fallback;
  }
}

const instrumentSpecCache = new Map<string, { data: Partial<InstrumentSpec>; fetchedAt: number }>();

/**
 * Fetch admin-editable MT5 contract specifications from public.instrument_specs.
 * Falls back cleanly to DEFAULT_INSTRUMENT_SPECS when unavailable.
 */
export async function fetchInstrumentSpec(symbolOrName: string): Promise<Partial<InstrumentSpec> | undefined> {
  const normKey = normalizeSpecKey(symbolOrName);
  const cacheKey = normKey || symbolOrName;
  const cached = instrumentSpecCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < META_TTL_MS) {
    return cached.data;
  }

  const client = getSupabaseClient();
  const candidates = Array.from(new Set([normKey, symbolOrName].filter(Boolean)));
  if (!client || candidates.length === 0) {
    return DEFAULT_INSTRUMENT_SPECS[normKey];
  }

  try {
    const { data, error } = await client
      .from('instrument_specs')
      .select('symbol, contract_size, min_lot, lot_step, quote_ccy, pip_size, decimals')
      .in('symbol', candidates)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      const def = DEFAULT_INSTRUMENT_SPECS[normKey];
      if (def) {
        instrumentSpecCache.set(cacheKey, { data: def, fetchedAt: Date.now() });
      }
      return def;
    }

    const resolved: Partial<InstrumentSpec> = {
      symbol: String(data.symbol || normKey),
      contractSize: Number(data.contract_size),
      minLot: Number(data.min_lot),
      lotStep: Number(data.lot_step),
      quoteCcy: String(data.quote_ccy || 'USD').toUpperCase(),
      pipSize: Number(data.pip_size),
      decimals: Number(data.decimals),
    };
    instrumentSpecCache.set(cacheKey, { data: resolved, fetchedAt: Date.now() });
    return resolved;
  } catch {
    return DEFAULT_INSTRUMENT_SPECS[normKey];
  }
}

/**
 * Load authenticated user's saved MT5 risk profile from public.users.
 */
export async function fetchUserTradingProfile(): Promise<UserTradingProfile> {
  const client = getSupabaseClient();
  if (!client) return { ...DEFAULT_USER_TRADING_PROFILE };

  try {
    const { data: sessionData } = await client.auth.getSession();
    const uid = sessionData?.session?.user?.id;
    if (!uid) return { ...DEFAULT_USER_TRADING_PROFILE };

    const { data, error } = await client
      .from('users')
      .select('account_currency, account_balance, risk_pct, leverage, broker_spread_pips, contract_size_overrides')
      .eq('auth_user_id', uid)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return { ...DEFAULT_USER_TRADING_PROFILE };
    }
    return parseTradingProfileFromRow(data);
  } catch {
    return { ...DEFAULT_USER_TRADING_PROFILE };
  }
}

/**
 * Validate contract_size_overrides JSON structure, bounds, and serialized size (<= 2 KB).
 */
export function validateContractSizeOverrides(
  overrides: unknown
): { ok: boolean; value?: Record<string, number>; error?: string } {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, error: 'contract_size_overrides must be a JSON object.' };
  }

  const serializedBytes = new TextEncoder().encode(JSON.stringify(overrides)).length;
  if (serializedBytes > 2048) {
    return { ok: false, error: 'contract_size_overrides exceeds maximum serialized size of 2 KB.' };
  }

  const entries = Object.entries(overrides as Record<string, unknown>);
  if (entries.length > 20) {
    return { ok: false, error: 'contract_size_overrides can have at most 20 entries.' };
  }

  const normalized: Record<string, number> = {};
  for (const [key, rawVal] of entries) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 20) {
      return { ok: false, error: 'Each contract_size_overrides key must be 1 to 20 characters.' };
    }
    if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
      return { ok: false, error: 'Each contract_size_overrides value must be a number.' };
    }
    if (rawVal <= 0 || rawVal > 10000000) {
      return { ok: false, error: 'Each contract_size_overrides value must be > 0 and <= 10000000.' };
    }
    normalized[key] = rawVal;
  }

  return { ok: true, value: normalized };
}

/**
 * Persist MT5 trading risk settings via SECURITY DEFINER RPC `update_trading_profile`.
 */
export async function saveUserTradingProfile(
  updates: Partial<UserTradingProfile>
): Promise<{ success: boolean; profile?: UserTradingProfile; warning?: string; message: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, message: 'Database client not connected.' };
  }

  let validatedOverrides: Record<string, number> | null = null;
  if (updates.contractSizeOverrides !== undefined) {
    const check = validateContractSizeOverrides(updates.contractSizeOverrides);
    if (!check.ok || !check.value) {
      return { success: false, message: check.error || 'Invalid contract_size_overrides.' };
    }
    validatedOverrides = check.value;
  }

  let riskWarning: string | undefined;
  let safeRisk = updates.riskPct;
  if (typeof safeRisk === 'number') {
    if (safeRisk > 3.0) {
      safeRisk = 3.0;
      riskWarning = 'Risk % per trade capped at 3.0% maximum.';
    } else if (safeRisk > 2.0) {
      riskWarning = `High risk warning: ${safeRisk.toFixed(1)}% exceeds conservative 1%–2% sizing.`;
    } else if (safeRisk < 0.1) {
      safeRisk = 0.1;
    }
  }

  try {
    const { data, error } = await client.rpc('update_trading_profile', {
      p_account_currency: updates.accountCurrency ?? null,
      p_account_balance: typeof updates.accountBalance === 'number' ? updates.accountBalance : null,
      p_risk_pct: typeof safeRisk === 'number' ? safeRisk : null,
      p_leverage: typeof updates.leverage === 'number' ? Math.round(updates.leverage) : null,
      p_broker_spread_pips:
        typeof updates.brokerSpreadPips === 'number' ? updates.brokerSpreadPips : null,
      p_contract_size_overrides: validatedOverrides,
    });

    if (error) {
      return { success: false, message: error.message };
    }
    if (!data?.ok) {
      return { success: false, message: data?.error || 'Failed to update trading profile.' };
    }

    return {
      success: true,
      profile: parseTradingProfileFromRow(data),
      warning: riskWarning,
      message: riskWarning || 'Trading risk profile saved.',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Unable to save trading profile.' };
  }
}

/**
 * Fetch upcoming/recent market events within ±2 hours from public.market_events.
 */
export async function fetchUpcomingMarketEvents(): Promise<MarketEventRow[]> {
  if (marketEventsCache && Date.now() - marketEventsCache.fetchedAt < META_TTL_MS) {
    return marketEventsCache.data;
  }

  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const now = Date.now();
    const minIso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const maxIso = new Date(now + 2 * 60 * 60 * 1000).toISOString();

    const { data, error } = await client
      .from('market_events')
      .select('id, starts_at, ends_at, currency, title, impact')
      .gte('starts_at', minIso)
      .lte('starts_at', maxIso)
      .order('starts_at', { ascending: true });

    if (error || !Array.isArray(data)) {
      return [];
    }

    const rows = data as MarketEventRow[];
    marketEventsCache = { data: rows, fetchedAt: Date.now() };
    return rows;
  } catch {
    return [];
  }
}

/**
 * Record Quantitative Signal via server-authoritative POST /api/signals/log
 * User ID is extracted from verified token on server; client direct inserts to signals are revoked.
 */
export async function logSignalToSupabase(signal: any, _userId?: number | null): Promise<boolean> {
  try {
    const client = getSupabaseClient();
    const session = (await client?.auth.getSession())?.data?.session;
    const token = session?.access_token || '';

    const res = await secureFetch('/api/signals/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        asset: signal.symbol || signal.asset,
        timeframe: signal.expiry || signal.timeframe,
        direction: signal.direction,
        entry_price: Number(signal.entryPrice || 0),
        target_price: signal.targetPrice ? Number(signal.targetPrice) : null,
        stop_loss: signal.mt5?.stopLossPrice ? Number(signal.mt5.stopLossPrice) : null,
        take_profit_1: signal.mt5?.takeProfit1Price ? Number(signal.mt5.takeProfit1Price) : null,
        take_profit_2: signal.mt5?.takeProfit2Price ? Number(signal.mt5.takeProfit2Price) : null,
        confidence: 0,
        confluence_factors: Array.isArray(signal.reasons || signal.technicalAudit?.confluenceFactors)
          ? (signal.reasons || signal.technicalAudit?.confluenceFactors)
              .slice(0, 12)
              .map((item: unknown) => String(item).slice(0, 200))
          : [],
        setup_name: signal.technicalAudit?.setupName || signal.engine || 'Algorithmic Signal',
        engine: signal.engine,
        profile: signal.profile || signal.analysisProfile,
        platform: signal.platform,
        expiry: signal.expiry || signal.timeframe,
        strength: signal.strength,
        inputs_snapshot: signal.inputsSnapshot || {},
        ...(signal.conditionsOverride
          ? { conditions_override: signal.conditionsOverride }
          : {}),
        feed_source: signal.feedSource || 'deriv_ws',
        valid_until: signal.validUntil || null,
      }),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Outcome recording stub
 * Trade outcomes are settled exclusively on the server in Stage 4 to prevent
 * client-side win rate manipulation. Direct client inserts are strictly prohibited.
 */
export async function logOutcomeToSupabase(
  _outcome: 'WIN' | 'LOSS',
  _signal: any,
  _userId?: number | null
): Promise<boolean> {
  // Outcomes are settled server-side in Stage 4
  return true;
}

/**
 * Fetch recent non-WAIT signals and settled outcomes for a specific asset and VIP user.
 * Used exclusively to plot historical markers on the chart for VIP accounts.
 */
export async function fetchUserAssetSignalMarkers(
  symbol: string,
  assetName: string,
  userId?: number | null,
  isVip?: boolean
): Promise<ChartHistorySignalItem[]> {
  if (!isVip || !userId || !isSupabaseConfigured()) {
    return [];
  }

  const client = getSupabaseClient();
  if (!client) return [];

  const assetCandidates = Array.from(new Set([symbol, assetName].filter(Boolean)));
  if (assetCandidates.length === 0) return [];

  try {
    const { data: sigRows, error: sigErr } = await client
      .from('signals')
      .select('id, asset, direction, entry_price, timeframe, created_at')
      .eq('user_id', userId)
      .in('asset', assetCandidates)
      .neq('direction', 'WAIT')
      .order('created_at', { ascending: false })
      .limit(25);

    if (sigErr || !Array.isArray(sigRows) || sigRows.length === 0) {
      return [];
    }

    const sigIds = sigRows.map((r) => r.id).filter(Boolean);
    const outcomeMap = new Map<string, 'WIN' | 'LOSS' | 'DRAW'>();

    if (sigIds.length > 0) {
      const { data: outcomeRows, error: outErr } = await client
        .from('trade_outcomes')
        .select('signal_id, outcome')
        .in('signal_id', sigIds);

      if (!outErr && Array.isArray(outcomeRows)) {
        for (const o of outcomeRows) {
          if (o?.signal_id && (o.outcome === 'WIN' || o.outcome === 'LOSS' || o.outcome === 'DRAW')) {
            outcomeMap.set(String(o.signal_id), o.outcome);
          }
        }
      }
    }

    const validDirections = new Set(['CALL', 'PUT', 'BUY', 'SELL']);
    const items: ChartHistorySignalItem[] = [];
    for (const row of sigRows) {
      const dir = String(row.direction || '').toUpperCase();
      if (!validDirections.has(dir)) continue;
      const entry = Number(row.entry_price);
      if (!Number.isFinite(entry) || entry <= 0) continue;
      items.push({
        id: String(row.id),
        asset: String(row.asset || symbol),
        direction: dir as 'CALL' | 'PUT' | 'BUY' | 'SELL',
        entryPrice: entry,
        timeframe: String(row.timeframe || ''),
        createdAt: String(row.created_at || ''),
        outcome: outcomeMap.get(String(row.id)) ?? null,
      });
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Send password reset email instructions via Supabase Auth
 */
export async function sendPasswordResetEmail(email: string): Promise<{ success: boolean; message: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      message: 'Authentication service is currently not connected.',
    };
  }

  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return {
      success: false,
      message: 'Please provide a valid email address.',
    };
  }

  try {
    const redirectTo = typeof window !== 'undefined'
      ? `${window.location.origin}/?view=reset-password`
      : undefined;

    const { error } = await client.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo,
    });

    if (error) {
      return { success: false, message: error.message };
    }

    return {
      success: true,
      message: `Password reset instructions have been sent to ${cleanEmail}. Please check your inbox and spam folder.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Unable to process password reset request at this time.',
    };
  }
}

/**
 * Update user password after clicking reset link
 */
export async function updateUserPassword(newPassword: string): Promise<{ success: boolean; message: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, message: 'Authentication service not available.' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters long.' };
  }

  try {
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) {
      return { success: false, message: error.message };
    }
    return { success: true, message: 'Your password has been successfully updated! You can now log in.' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Failed to update password.' };
  }
}
