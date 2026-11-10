import { createClient, SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  const url = (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    'https://uhzodamgzhnicifobnjj.supabase.co'
  ).trim();

  // In production Vercel functions, SUPABASE_SERVICE_ROLE_KEY is configured.
  // Fallback to anon key only if service role key is not yet set in environment.
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();

  if (!url || !serviceKey) {
    throw new Error('Supabase URL or Key is not configured in server environment.');
  }

  if (!adminClient) {
    adminClient = createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return adminClient;
}
