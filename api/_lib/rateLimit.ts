import { getSupabaseAdmin } from './supabaseAdmin.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  error?: string;
}

/**
 * Atomic rate limiter using database RPC `rate_limit_hit`.
 *
 * For sensitive operations (registration, VIP codes, credits, money), `failClosed` is true
 * so any database or connectivity failure blocks the request rather than bypassing protection.
 */
export async function checkRateLimit(
  key: string,
  maxHits: number = 10,
  windowSeconds: number = 300,
  failClosed: boolean = true
): Promise<RateLimitResult> {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase.rpc('rate_limit_hit', {
      p_key: key,
      p_max: maxHits,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      console.warn('[RateLimiter RPC Error]', error.message);
      if (failClosed) {
        return {
          allowed: false,
          remaining: 0,
          retryAfter: 60,
          error: 'Rate limiter unavailable. Request rejected for security.',
        };
      }
      return { allowed: true, remaining: 1 };
    }

    return {
      allowed: Boolean(data?.allowed),
      remaining: typeof data?.remaining === 'number' ? data.remaining : 0,
      retryAfter: data?.retry_after || 0,
    };
  } catch (err: any) {
    console.error('[RateLimiter Exception]', err);
    if (failClosed) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: 60,
        error: 'Security verification temporarily unavailable.',
      };
    }
    return { allowed: true, remaining: 1 };
  }
}

/**
 * Atomically increments the registration counter for an IP address via `bump_ip_registration`.
 * Resets when the 24-hour window has passed.
 */
export async function bumpIpRegistration(ip: string): Promise<{ count: number; error?: string }> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('bump_ip_registration', {
      p_ip: ip,
    });

    if (error) {
      console.warn('[bumpIpRegistration Error]', error.message);
      // Fail closed on security check
      return { count: 999, error: error.message };
    }

    return { count: Number(data) || 1 };
  } catch (err: any) {
    console.error('[bumpIpRegistration Exception]', err);
    return { count: 999, error: err?.message };
  }
}

/**
 * Reads the current 24-hour registration count for an IP address WITHOUT incrementing it.
 * Uses service-role RPC `ip_registration_count`.
 */
export async function getIpRegistrationCount(ip: string): Promise<{ count: number; error?: string }> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('ip_registration_count', {
      p_ip: ip,
    });

    if (error) {
      console.warn('[getIpRegistrationCount Error]', error.message);
      // Fail closed on security check: treat as over-quota if security RPC fails
      return { count: 999, error: error.message };
    }

    return { count: Number(data) || 0 };
  } catch (err: any) {
    console.error('[getIpRegistrationCount Exception]', err);
    return { count: 999, error: err?.message };
  }
}
