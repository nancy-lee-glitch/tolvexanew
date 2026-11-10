import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { UserProfile } from '../types.ts';

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
  _extraCredits?: number
): Promise<{ success: boolean; user?: UserProfile; message: string }> {
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
  if (!cleanPassword || cleanPassword.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters long.' };
  }

  // 1. Call serverless registration endpoint
  const regResult = await secureFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: trimmedUsername,
      email: trimmedEmail,
      password: cleanPassword,
    }),
  });

  if (!regResult.ok) {
    // If endpoint is not reachable (e.g. static preview), fallback to direct client-side signup
    const client = getSupabaseClient();
    if (!client) {
      return { success: false, message: regResult.error || 'Registration service unavailable.' };
    }

    const { data: authData, error: authError } = await client.auth.signUp({
      email: trimmedEmail,
      password: cleanPassword,
      options: {
        data: { username: trimmedUsername },
      },
    });

    if (authError) {
      return { success: false, message: authError.message };
    }

    if (!authData?.user) {
      return { success: false, message: 'Registration failed. No user was returned.' };
    }

    if (Array.isArray(authData.user.identities) && authData.user.identities.length === 0) {
      return {
        success: false,
        message: 'An account with this email address already exists. Please sign in instead.',
      };
    }

    // Auto sign in to retrieve session
    const signInRes = await signInWithSupabase(trimmedEmail, cleanPassword);
    if (signInRes.success && vipKey && vipKey.trim()) {
      await redeemVipKeyWithSupabase(vipKey, signInRes.user || null);
    }
    return signInRes;
  }

  // 2. Sign in to retrieve full session & database profile
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
 */
export async function deductCreditWithSupabase(
  currentUser: UserProfile
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
    const { data, error } = await client.rpc('consume_credit', { p_cost: 1 });

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
        : '1 credit deducted for algorithmic signal computation.',
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

/**
 * Record Quantitative Signal in Supabase (Public read, Server/Admin insert)
 */
export async function logSignalToSupabase(signal: any, userId?: number | null) {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client.from('signals').insert({
      user_id: userId || null,
      asset: signal.asset,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entry_price: signal.entryPrice,
      target_price: signal.targetPrice,
      stop_loss: signal.mt5?.stopLossPrice || null,
      take_profit_1: signal.mt5?.takeProfit1Price || null,
      take_profit_2: signal.mt5?.takeProfit2Price || null,
      confidence: signal.confidence,
      confluence_factors: signal.technicalAudit?.confluenceFactors || [],
      setup_name: signal.technicalAudit?.setupName || 'Algorithmic Signal',
    });

    return !error;
  } catch {
    return false;
  }
}

/**
 * Record Verified Trade Outcome in Supabase
 */
export async function logOutcomeToSupabase(outcome: 'WIN' | 'LOSS', signal: any, userId?: number | null) {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client.from('trade_outcomes').insert({
      user_id: userId || null,
      asset: signal.asset,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entry_price: signal.entryPrice,
      outcome: outcome,
    });

    return !error;
  } catch {
    return false;
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
