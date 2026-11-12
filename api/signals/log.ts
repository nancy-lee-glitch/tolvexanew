import { z } from 'zod';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { authenticateRequest } from '../_lib/auth.js';
import { checkRateLimit } from '../_lib/rateLimit.js';

const SignalLogSchema = z.object({
  asset: z.string().min(1).max(32),
  timeframe: z.string().min(1).max(16),
  direction: z.enum(['CALL', 'PUT', 'BUY', 'SELL']),
  entry_price: z.number().positive(),
  target_price: z.number().positive().optional().nullable(),
  stop_loss: z.number().positive().optional().nullable(),
  take_profit_1: z.number().positive().optional().nullable(),
  take_profit_2: z.number().positive().optional().nullable(),
  confidence: z.number().min(0).max(100),
  confluence_factors: z.array(z.string()).optional(),
  setup_name: z.string().max(128).optional(),
});

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // 1. Zod input validation
  const parseResult = SignalLogSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: parseResult.error.issues[0]?.message || 'Invalid signal data payload',
    });
  }

  const payload = parseResult.data;

// 2. Authentication check: derive user_id from verified token, reject unauthenticated
  const auth = await authenticateRequest(req);
  if (!auth || !auth.userId) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: Authentication required to record signals.',
    });
  }
  const verifiedUserId = auth.userId;

  // 3. Rate limiting per user
  const rateKey = `signal_user:${verifiedUserId}`;
  const rateCheck = await checkRateLimit(rateKey, 40, 60, true);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      ok: false,
      error: 'Signal recording rate limit exceeded. Please wait.',
    });
  }

  // 4. Insert into public.signals using service role
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('signals')
      .insert({
        user_id: verifiedUserId,
        asset: payload.asset,
        timeframe: payload.timeframe,
        direction: payload.direction,
        entry_price: payload.entry_price,
        target_price: payload.target_price || null,
        stop_loss: payload.stop_loss || null,
        take_profit_1: payload.take_profit_1 || null,
        take_profit_2: payload.take_profit_2 || null,
        confidence: payload.confidence,
        confluence_factors: payload.confluence_factors || [],
        setup_name: payload.setup_name || 'Algorithmic Signal',
      })
      .select('id, created_at')
      .single();

    if (error) {
      console.error('[Signal Log DB Error]', error.message);
      return res.status(500).json({ ok: false, error: 'Unable to record signal.' });
    }

    return res.status(201).json({
      ok: true,
      signalId: data.id,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    console.error('[Signal Log Exception]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error recording signal.' });
  }
}
