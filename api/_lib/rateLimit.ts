import { getSupabaseAdmin } from './supabaseAdmin.js';

/**
 * Stateless rate limiter using the public.rate_limits table with fail-safe fallback.
 */
export async function checkRateLimit(
  key: string,
  maxHits: number = 10,
  windowSeconds: number = 300
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  try {
    const supabase = getSupabaseAdmin();
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();

    const { data, error } = await supabase
      .from('rate_limits')
      .select('hits, reset_at')
      .eq('key', key)
      .maybeSingle();

    if (error || !data) {
      await supabase.from('rate_limits').upsert({
        key,
        hits: 1,
        reset_at: resetAt,
      });
      return { allowed: true, remaining: maxHits - 1 };
    }

    const currentReset = new Date(data.reset_at).getTime();
    if (now.getTime() > currentReset) {
      await supabase.from('rate_limits').update({
        hits: 1,
        reset_at: resetAt,
      }).eq('key', key);
      return { allowed: true, remaining: maxHits - 1 };
    }

    if (data.hits >= maxHits) {
      const retryAfter = Math.max(1, Math.ceil((currentReset - now.getTime()) / 1000));
      return { allowed: false, remaining: 0, retryAfter };
    }

    await supabase.from('rate_limits').update({
      hits: data.hits + 1,
    }).eq('key', key);

    return { allowed: true, remaining: maxHits - (data.hits + 1) };
  } catch (err) {
    // Fail safe on database connection issues
    return { allowed: true, remaining: 1 };
  }
}
