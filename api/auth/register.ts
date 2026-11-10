import { z } from 'zod';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { checkRateLimit } from '../_lib/rateLimit.js';

const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username cannot exceed 30 characters')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Username can only contain alphanumeric characters, underscores, dots, or dashes'),
  email: z.string().email('Invalid email address format').max(100),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
  turnstileToken: z.string().optional(),
  // Honeypot fields to catch automated spam bots
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

  const { username, email, password, website, phone_extra } = parseResult.data;

  // 2. Honeypot Check: if bot filled hidden fields, reject immediately
  if ((website && website.trim() !== '') || (phone_extra && phone_extra.trim() !== '')) {
    return res.status(400).json({ ok: false, error: 'Registration request rejected.' });
  }

  // 3. Client IP Extraction
  const headers = req.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || '127.0.0.1');

  // 4. Rate Limit (Per-IP check: max 5 attempts per 10 minutes)
  const rateLimit = await checkRateLimit(`register_ip:${ip}`, 5, 600);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      ok: false,
      error: `Too many registration attempts. Please wait ${rateLimit.retryAfter || 60} seconds.`,
    });
  }

  const supabase = getSupabaseAdmin();

  // 5. IP Registrations Abuse Gate (> 3 accounts created in 24h)
  try {
    const { data: ipRecord } = await supabase
      .from('ip_registrations')
      .select('count, first_registered_at')
      .eq('ip_address', ip)
      .maybeSingle();

    if (ipRecord) {
      const firstReg = new Date(ipRecord.first_registered_at).getTime();
      const hoursSinceFirst = (Date.now() - firstReg) / (1000 * 3600);
      if (hoursSinceFirst < 24 && ipRecord.count >= 3) {
        return res.status(429).json({
          ok: false,
          error: 'Registration limit reached for this network (maximum 3 accounts per 24 hours).',
        });
      }
    }
  } catch (err) {
    console.warn('[IP Registration check notice]', err);
  }

  // 6. Create User via Supabase Admin API
  // Note: Only sanitized username is passed in metadata.
  // Role, is_vip, and credits are strictly controlled by the SQL database trigger handle_new_user().
  try {
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: {
        username: username.trim(),
      },
    });

    if (createErr) {
      return res.status(400).json({
        ok: false,
        error: createErr.message || 'Registration failed. Please check credentials or try a different email.',
      });
    }

    if (!createData?.user) {
      return res.status(500).json({
        ok: false,
        error: 'Unable to initialize user account.',
      });
    }

    // 7. Update IP registration record
    try {
      await supabase.from('ip_registrations').upsert(
        {
          ip_address: ip,
          count: 1,
          last_registered_at: new Date().toISOString(),
        },
        { onConflict: 'ip_address' }
      );
    } catch {
      // Ignored
    }

    return res.status(201).json({
      ok: true,
      message: 'Account successfully created! You can now log in.',
      user: {
        id: createData.user.id,
        email: createData.user.email,
        username,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Server error during registration.',
    });
  }
}
