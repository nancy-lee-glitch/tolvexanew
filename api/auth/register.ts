import { z } from 'zod';
import { getSupabaseAnon } from '../_lib/supabaseAnon.js';
import { checkRateLimit, bumpIpRegistration, getIpRegistrationCount } from '../_lib/rateLimit.js';
import { verifyTurnstileToken } from '../_lib/turnstile.js';
import { getClientIp } from '../_lib/ip.js';

const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username cannot exceed 30 characters')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Username can only contain alphanumeric characters, underscores, dots, or dashes'),
  email: z.string().email('Invalid email address format').max(100),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(128, 'Password cannot exceed 128 characters'),
  turnstileToken: z.string().optional(),
  // Anti-bot honeypots
  website: z.string().optional(),
  phone_extra: z.string().optional(),
});

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // 1. Zod Validation
  const parseResult = RegisterSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: parseResult.error.issues[0]?.message || 'Invalid registration data',
    });
  }

  const { username, email, password, turnstileToken, website, phone_extra } = parseResult.data;

  // 2. Honeypot Verification
  if ((website && website.trim() !== '') || (phone_extra && phone_extra.trim() !== '')) {
    return res.status(400).json({ ok: false, error: 'Registration request rejected.' });
  }

  // 3. Trustworthy Client IP Extraction
  const ip = getClientIp(req);

  // 4. Cloudflare Turnstile Server-Side Verification (fails closed in production)
  const turnstileCheck = await verifyTurnstileToken(turnstileToken, ip);
  if (!turnstileCheck.success) {
    return res.status(400).json({
      ok: false,
      error: turnstileCheck.error || 'Security verification failed.',
    });
  }

  // 5. Short-term burst rate limiting (read from env with default 5 per 10 minutes)
  const burstLimit = Number(process.env.REGISTER_BURST_PER_IP) || 5;
  const rateLimit = await checkRateLimit(`register_ip:${ip}`, burstLimit, 600, true);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      ok: false,
      error: `Too many registration attempts. Please wait ${rateLimit.retryAfter || 60} seconds.`,
    });
  }

  // 6. Pre-check 24-hour per-IP registration limit WITHOUT incrementing it
  const maxPerDay = Number(process.env.REGISTER_MAX_PER_IP_DAY) || 10;
  const currentIpCount = await getIpRegistrationCount(ip);
  if (currentIpCount.count >= maxPerDay) {
    return res.status(429).json({
      ok: false,
      error: `Registration limit reached for this network (maximum ${maxPerDay} accounts per 24 hours).`,
    });
  }

  // 7. Supabase Auth Account Creation via Anon Client (Requires Email Confirmation)
  const cleanEmail = email.trim().toLowerCase();
  const cleanUsername = username.trim();
  const siteUrl = (process.env.SITE_URL || 'https://tickvere.com').replace(/\/+$/, '');

  try {
    const anonClient = getSupabaseAnon();
    const { data: authData, error: authError } = await anonClient.auth.signUp({
      email: cleanEmail,
      password,
      options: {
        data: {
          username: cleanUsername,
        },
        emailRedirectTo: `${siteUrl}/`,
      },
    });

    // Check for user enumeration prevention (empty identities array) or duplicate error
    const isDuplicate =
      (authData?.user && Array.isArray(authData.user.identities) && authData.user.identities.length === 0) ||
      (authError && authError.message.toLowerCase().includes('already registered'));

    if (isDuplicate) {
      // Generic response that does not reveal whether the email exists; do not increment IP registration counter
      return res.status(200).json({
        ok: true,
        message: 'If your email address is eligible, a confirmation link has been sent. Please check your inbox and spam folder to confirm your account.',
      });
    }

    if (authError) {
      return res.status(400).json({
        ok: false,
        error: authError.message || 'Registration could not be completed. Please check your credentials.',
      });
    }

    // 8. Atomic IP Registration Tracker: Bump ONLY when signUp succeeds as a NEW account
    const ipBump = await bumpIpRegistration(ip);
    if (ipBump.count > maxPerDay) {
      return res.status(429).json({
        ok: false,
        error: `Registration limit reached for this network (maximum ${maxPerDay} accounts per 24 hours).`,
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'Account created! Check your email to confirm your account before logging in.',
    });
  } catch (err: any) {
    console.error('[Registration Exception]', err);
    return res.status(500).json({
      ok: false,
      error: 'An unexpected error occurred during registration. Please try again later.',
    });
  }
}
