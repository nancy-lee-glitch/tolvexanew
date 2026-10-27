import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { UserProfile } from '../types.ts';

// Cache client instance
let supabaseInstance: SupabaseClient | null = null;
let currentConfigKey = '';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

// Default credentials provided for project
const DEFAULT_SUPABASE_URL = 'https://uhzodamgzhnicifobnjj.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoem9kYW1nemhuaWNpZm9ibmpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NDAxNzQsImV4cCI6MjEwNTQxNjE3NH0.SFgqhFDOnZ1bfhI4raCSEhvkmlCTgUDEaJHxAtjMRpA';

/**
 * Get active Supabase configuration from environment or project defaults
 */
export function getSupabaseConfig(): SupabaseConfig {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const envUrl = meta.env?.VITE_SUPABASE_URL || '';
  const envAnonKey = meta.env?.VITE_SUPABASE_ANON_KEY || '';

  // Check if user set custom Supabase credentials in browser storage
  const storedUrl = typeof window !== 'undefined' ? localStorage.getItem('pulsetrade_supabase_url') : null;
  const storedKey = typeof window !== 'undefined' ? localStorage.getItem('pulsetrade_supabase_key') : null;

  const url = (storedUrl || envUrl || DEFAULT_SUPABASE_URL).trim();
  const anonKey = (storedKey || envAnonKey || DEFAULT_SUPABASE_ANON_KEY).trim();

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
    const { data, error } = await testClient.from('active_sessions').select('session_id').limit(5);

    if (error) {
      if (error.code === '42P01') {
        return {
          success: false,
          message:
            'Connected to Supabase project, but tables are missing. Please run supabase_schema.sql in the Supabase SQL Editor.',
        };
      }
      return { success: false, message: `Supabase Error: ${error.message}` };
    }

    return {
      success: true,
      message: 'Successfully connected to live Supabase PostgreSQL database!',
      activeTraders: data?.length || 1,
    };
  } catch (err: any) {
    return { success: false, message: `Connection failed: ${err?.message || 'Unknown network error'}` };
  }
}

/**
 * Save user custom Supabase credentials
 */
export function saveCustomSupabaseConfig(url: string, anonKey: string) {
  if (typeof window !== 'undefined') {
    if (url && anonKey) {
      localStorage.setItem('pulsetrade_supabase_url', url.trim());
      localStorage.setItem('pulsetrade_supabase_key', anonKey.trim());
    } else {
      localStorage.removeItem('pulsetrade_supabase_url');
      localStorage.removeItem('pulsetrade_supabase_key');
    }
    supabaseInstance = null;
    currentConfigKey = '';
  }
}

/**
 * Format a Supabase user into standard UserProfile
 */
export function mapToUserProfile(userObj: any, dbUser?: any): UserProfile {
  const metadata = userObj?.user_metadata || {};
  let isVip = Boolean(dbUser?.is_vip || metadata.is_vip);
  const vipExpiresAt = dbUser?.vip_expires_at || metadata.vip_expires_at || null;

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

  const email = (userObj?.email || dbUser?.email || '').toLowerCase();
  const isAdmin = email === 'durodoluwa5@gmail.com' || dbUser?.role === 'ADMIN' || metadata.role === 'ADMIN';
  const role: 'USER' | 'ADMIN' = isAdmin ? 'ADMIN' : 'USER';

  let credits = 10;
  if (isAdmin || isVip) {
    credits = 9999;
  } else if (typeof dbUser?.credits === 'number') {
    credits = dbUser.credits;
  } else if (typeof metadata.credits === 'number') {
    credits = metadata.credits;
  }

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
 * Supabase Auth: Register new user (100% Client-Side, No /api.php dependency)
 */
export async function signUpWithSupabase(
  email: string,
  password: string,
  username: string,
  vipKey?: string,
  bonusCredits: number = 0
): Promise<{ success: boolean; user?: UserProfile; message: string }> {
  const trimmedEmail = (email || '').trim().toLowerCase();
  const trimmedUsername = (username || '').trim();
  const cleanPassword = password || '';

  // 1. Input Validation
  if (!trimmedUsername || trimmedUsername.length < 3) {
    return { success: false, message: 'Username must be at least 3 characters long.' };
  }
  if (trimmedUsername.length > 30) {
    return { success: false, message: 'Username cannot exceed 30 characters.' };
  }

  if (!trimmedEmail) {
    return { success: false, message: 'Email address is required.' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return { success: false, message: 'Please enter a valid email address.' };
  }

  if (!cleanPassword || cleanPassword.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters long.' };
  }

  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      message: 'Supabase client is unavailable. Please verify connection credentials.',
    };
  }

  try {
    const cleanVipKey = (vipKey || '').trim().toUpperCase();
    const VALID_VIP_KEYS = ['VIP-ALPHA-30D', 'PULSE-VIP-2026', 'QUANT-30D', 'VIP-TRADER-1M'];
    let isValidVip = Boolean(cleanVipKey && VALID_VIP_KEYS.includes(cleanVipKey));
    let vipDurationDays = 30;

    // Check if cleanVipKey matches any active, unredeemed admin-generated VIP code in DB
    if (!isValidVip && cleanVipKey) {
      try {
        const { data: codeRow } = await client
          .from('vip_codes')
          .select('*')
          .eq('code', cleanVipKey)
          .eq('is_active', true)
          .eq('is_redeemed', false)
          .maybeSingle();

        if (codeRow) {
          isValidVip = true;
          vipDurationDays = codeRow.duration_days || 30;
          await client.from('vip_codes').update({
            is_redeemed: true,
            redeemed_by_email: trimmedEmail,
            redeemed_at: new Date().toISOString(),
          }).eq('code', cleanVipKey);
        } else {
          // Check app_settings fallback
          const { data: setRow } = await client
            .from('app_settings')
            .select('value')
            .eq('key', 'vip_codes')
            .maybeSingle();

          if (setRow?.value && Array.isArray(setRow.value)) {
            const list = [...setRow.value];
            const idx = list.findIndex(
              (c: any) => c.code && c.code.toUpperCase() === cleanVipKey && c.is_active && !c.is_redeemed
            );
            if (idx >= 0) {
              isValidVip = true;
              vipDurationDays = list[idx].duration_days || 30;
              list[idx].is_redeemed = true;
              list[idx].redeemed_by = trimmedUsername;
              list[idx].redeemed_by_email = trimmedEmail;
              list[idx].redeemed_at = new Date().toISOString();
              await client.from('app_settings').upsert({
                key: 'vip_codes',
                value: list,
                updated_at: new Date().toISOString(),
              });
              if (typeof window !== 'undefined') {
                localStorage.setItem('pulsetrade_vip_codes', JSON.stringify(list));
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Signup VIP validation error]', err);
      }
    }

    const vipExpiresAt = isValidVip ? new Date(Date.now() + vipDurationDays * 86400000).toISOString() : null;

    // Referral Bonus Rule:
    // When a valid owner referral code or ?ref= param is verified at signup and referral bonus is active,
    // grant configured extra credits on top of standard starter credits (e.g. 10 + 5 = 15 credits total).
    const extra = Math.max(0, Math.min(50, Number(bonusCredits) || 0));
    const initialCredits = isValidVip ? 9999 : (10 + extra);
    const role = trimmedEmail === 'durodoluwa5@gmail.com' ? 'ADMIN' : 'USER';

    // 2. Call Supabase Auth SignUp
    const { data: authData, error: authError } = await client.auth.signUp({
      email: trimmedEmail,
      password: cleanPassword,
      options: {
        data: {
          username: trimmedUsername,
          is_vip: isValidVip,
          vip_expires_at: vipExpiresAt,
          credits: initialCredits,
          role,
        },
      },
    });

    if (authError) {
      return { success: false, message: authError.message };
    }

    if (!authData?.user) {
      return { success: false, message: 'Registration failed. No user was returned from Supabase.' };
    }

    // 3. Detect duplicate email (Supabase user enumeration protection returns user with empty identities)
    if (Array.isArray(authData.user.identities) && authData.user.identities.length === 0) {
      return {
        success: false,
        message: 'An account with this email address already exists. Please sign in instead.',
      };
    }

    // 4. Upsert row in public.users table
    let dbUser: any = null;
    try {
      const { data: insertedUser, error: upsertError } = await client
        .from('users')
        .upsert(
          {
            auth_user_id: authData.user.id,
            username: trimmedUsername,
            email: trimmedEmail,
            role,
            credits: initialCredits,
            is_vip: isValidVip,
            vip_expires_at: vipExpiresAt,
            registration_ip: 'vercel_web',
          },
          { onConflict: 'email' }
        )
        .select()
        .maybeSingle();

      if (!upsertError && insertedUser) {
        dbUser = insertedUser;
      }
    } catch {
      // Handled - trigger or metadata will hold values
    }

    const userProfile = mapToUserProfile(authData.user, dbUser);
    const hasSession = Boolean(authData.session);
    return {
      success: true,
      user: userProfile,
      message: isValidVip
        ? 'Account successfully created! ★ 30-Day VIP Pass activated.'
        : hasSession
        ? 'Account created successfully with 10 free starter credits!'
        : 'Account created! Turn off "Confirm email" in your Supabase Dashboard to log in immediately without confirmation.',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Authentication request failed.' };
  }
}

/**
 * Supabase Auth: Sign In existing user (supports email OR username)
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

    // If identity is a username (no @), look up associated email from public.users
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
      if (authError.message.toLowerCase().includes('email not confirmed')) {
        return {
          success: false,
          message:
            'Email confirmation is required by your Supabase project settings. In Supabase Dashboard -> Authentication -> Providers -> Email, uncheck "Confirm email" for instant login.',
        };
      }
      return { success: false, message: authError.message };
    }

    if (!authData?.user) {
      return { success: false, message: 'Authentication failed. Please verify your credentials.' };
    }

    // Fetch corresponding user record from public.users
    let dbUser: any = null;
    try {
      const { data } = await client
        .from('users')
        .select('*')
        .eq('email', authData.user.email)
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
 * Supabase Auth: Sign Out
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
 * Supabase Auth: Get current active session user on boot/refresh
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
        .eq('email', user.email)
        .limit(1)
        .maybeSingle();
      dbUser = data;
    } catch {
      // Table fallback
    }

    return mapToUserProfile(user, dbUser);
  } catch {
    return null;
  }
}

/**
 * Redeem 30-Day VIP Key in Supabase Database (Atomic Single-Use & Expiry Extension)
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

  let durationDays = 30;
  let codeSource = '';

  // 1. PRIMARY CHECK: public.vip_codes (Strict One-Time Single-Use Table)
  try {
    const { data: codeRow, error: codeErr } = await client
      .from('vip_codes')
      .select('*')
      .eq('code', cleanKey)
      .maybeSingle();

    if (!codeErr && codeRow) {
      if (!codeRow.is_active) {
        return {
          success: false,
          message: `VIP code "${cleanKey}" has been deactivated by the system administrator.`,
        };
      }
      if (codeRow.is_redeemed) {
        return {
          success: false,
          message: `VIP code "${cleanKey}" has already been redeemed (single-use code).`,
        };
      }

      // Atomic Update: Mark code as redeemed by current user
      const { data: updatedCode, error: redeemErr } = await client
        .from('vip_codes')
        .update({
          is_redeemed: true,
          redeemed_by_user_id: currentUser.id,
          redeemed_by_email: currentUser.email,
          redeemed_at: new Date().toISOString(),
        })
        .eq('code', cleanKey)
        .eq('is_redeemed', false)
        .select()
        .maybeSingle();

      if (redeemErr || !updatedCode) {
        return {
          success: false,
          message: 'Conflict: This VIP code was just redeemed by another session.',
        };
      }

      durationDays = codeRow.duration_days || 30;
      codeSource = 'vip_codes';
    }
  } catch (err) {
    console.warn('[VIP Code Check Error]', err);
  }

  // 1b. SECONDARY DB CHECK: app_settings key 'vip_codes' (Universal DB Persistence)
  if (!codeSource) {
    try {
      const { data: setRow } = await client
        .from('app_settings')
        .select('value')
        .eq('key', 'vip_codes')
        .maybeSingle();

      if (setRow?.value && Array.isArray(setRow.value)) {
        const codesList = [...setRow.value];
        const foundIdx = codesList.findIndex(
          (c: any) => c.code && c.code.toUpperCase() === cleanKey
        );
        if (foundIdx >= 0) {
          const item = codesList[foundIdx];
          if (!item.is_active) {
            return {
              success: false,
              message: `VIP code "${cleanKey}" has been deactivated by the system administrator.`,
            };
          }
          if (item.is_redeemed) {
            return {
              success: false,
              message: `VIP code "${cleanKey}" has already been redeemed (single-use code).`,
            };
          }

          // Single-use Atomic Lock
          item.is_redeemed = true;
          item.redeemed_by = currentUser.username || currentUser.email;
          item.redeemed_by_email = currentUser.email;
          item.redeemed_by_user_id = currentUser.id;
          item.redeemed_at = new Date().toISOString();
          codesList[foundIdx] = item;

          await client.from('app_settings').upsert({
            key: 'vip_codes',
            value: codesList,
            updated_at: new Date().toISOString(),
          });

          if (typeof window !== 'undefined') {
            localStorage.setItem('pulsetrade_vip_codes', JSON.stringify(codesList));
          }

          durationDays = item.duration_days || 30;
          codeSource = 'app_settings';
        }
      }
    } catch (err) {
      console.warn('[app_settings VIP check error]', err);
    }
  }

  // 1c. TERTIARY CACHE CHECK: Local browser cache (Admin generated locally)
  if (!codeSource && typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('pulsetrade_vip_codes');
      if (raw) {
        const localList = JSON.parse(raw);
        if (Array.isArray(localList)) {
          const foundIdx = localList.findIndex(
            (c: any) => c.code && c.code.toUpperCase() === cleanKey
          );
          if (foundIdx >= 0) {
            const item = localList[foundIdx];
            if (!item.is_active) {
              return {
                success: false,
                message: `VIP code "${cleanKey}" has been deactivated by the system administrator.`,
              };
            }
            if (item.is_redeemed) {
              return {
                success: false,
                message: `VIP code "${cleanKey}" has already been redeemed (single-use code).`,
              };
            }

            item.is_redeemed = true;
            item.redeemed_by = currentUser.username || currentUser.email;
            item.redeemed_by_email = currentUser.email;
            item.redeemed_by_user_id = currentUser.id;
            item.redeemed_at = new Date().toISOString();
            localList[foundIdx] = item;
            localStorage.setItem('pulsetrade_vip_codes', JSON.stringify(localList));

            durationDays = item.duration_days || 30;
            codeSource = 'local_cache';
          }
        }
      }
    } catch {}
  }

  // 2. FOURTH CHECK: Legacy public.vip_keys table
  if (!codeSource) {
    try {
      const { data: dbKey } = await client
        .from('vip_keys')
        .select('*')
        .eq('vip_code', cleanKey)
        .eq('is_active', true)
        .maybeSingle();

      if (dbKey) {
        if (dbKey.max_uses === 0 || dbKey.used_count < dbKey.max_uses) {
          codeSource = 'vip_keys';
          durationDays = dbKey.duration_days || 30;
          await client
            .from('vip_keys')
            .update({ used_count: (dbKey.used_count || 0) + 1 })
            .eq('vip_code', cleanKey);
        } else {
          return {
            success: false,
            message: `VIP key "${cleanKey}" has reached its maximum redemption limit.`,
          };
        }
      }
    } catch {
      // Pass through
    }
  }

  // 3. FIFTH CHECK: System bootstrap static keys
  if (!codeSource) {
    const VALID_KEYS = ['VIP-ALPHA-30D', 'PULSE-VIP-2026', 'QUANT-30D', 'VIP-TRADER-1M'];
    if (VALID_KEYS.includes(cleanKey)) {
      codeSource = 'static';
      durationDays = 30;
    }
  }

  if (!codeSource) {
    return {
      success: false,
      message: 'Invalid VIP activation code. Please check your code or contact support.',
    };
  }

  // 4. Calculate VIP Expiry (Extend if already active, else now + duration)
  let baseTimestamp = Date.now();
  if (currentUser.is_vip && currentUser.vip_expires_at) {
    const currentExp = new Date(currentUser.vip_expires_at).getTime();
    if (currentExp > baseTimestamp) {
      baseTimestamp = currentExp;
    }
  }
  const newVipExpiresAt = new Date(baseTimestamp + durationDays * 86400000).toISOString();

  // 5. Update public.users in Supabase database
  try {
    await client
      .from('users')
      .update({
        is_vip: true,
        vip_expires_at: newVipExpiresAt,
        credits: 9999,
        updated_at: new Date().toISOString(),
      })
      .eq('email', currentUser.email);
  } catch (err) {
    console.warn('[User VIP DB Update Error]', err);
  }

  // 6. Update Supabase Auth metadata
  try {
    await client.auth.updateUser({
      data: {
        is_vip: true,
        vip_expires_at: newVipExpiresAt,
        credits: 9999,
      },
    });
  } catch (err) {
    console.warn('[Auth Metadata Update Error]', err);
  }

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
    message: `★ ${durationDays}-Day VIP Pass activated! Unlimited signals unlocked until ${new Date(newVipExpiresAt).toLocaleDateString()}.`,
  };
}

/**
 * Deduct Credit in Supabase Database for Signal Computation
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

  if (currentUser.credits <= 0) {
    return {
      success: false,
      credits: 0,
      is_vip: false,
      message: 'Insufficient credits. Upgrade to VIP or top up credits.',
    };
  }

  const newCredits = Math.max(0, currentUser.credits - 1);
  const client = getSupabaseClient();

  if (client && currentUser.email) {
    try {
      await client
        .from('users')
        .update({ credits: newCredits })
        .eq('email', currentUser.email);
      await client.auth.updateUser({
        data: { credits: newCredits },
      });
    } catch {
      // Ignored
    }
  }

  return {
    success: true,
    credits: newCredits,
    is_vip: false,
    message: '1 credit deducted for algorithmic signal computation.',
  };
}

/**
 * Real-Time Presence Heartbeat (100% Genuine Connected Traders)
 */
export async function sendSupabasePresence(
  sessionId: string,
  userId: number | null,
  activeAsset: string
): Promise<number | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    // 1. Upsert active session
    await client.from('active_sessions').upsert(
      {
        session_id: sessionId,
        user_id: userId,
        active_asset: activeAsset,
        last_heartbeat: new Date().toISOString(),
        ip_address: 'client_connection',
      },
      { onConflict: 'session_id' }
    );

    // 2. Count active sessions within the last 45 seconds
    const cutoff = new Date(Date.now() - 45000).toISOString();
    const { count, error } = await client
      .from('active_sessions')
      .select('*', { count: 'exact', head: true })
      .gte('last_heartbeat', cutoff);

    if (error) {
      return null;
    }

    return count ?? 1;
  } catch {
    return null;
  }
}

/**
 * Record Quantitative Signal in Supabase
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
