import { z } from 'zod';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { authenticateRequest } from '../_lib/auth.js';
import { checkRateLimit } from '../_lib/rateLimit.js';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_INPUTS_SNAPSHOT_BYTES = 8 * 1024;
const MAX_CONFLUENCE_ITEMS = 12;
const MAX_CONFLUENCE_ITEM_CHARS = 200;

const SignalLogSchema = z.object({
  asset: z.string().min(1).max(64),
  timeframe: z.string().min(1).max(16),
  direction: z.enum(['CALL', 'PUT', 'BUY', 'SELL', 'WAIT']),
  entry_price: z.number().nonnegative(),
  target_price: z.number().positive().optional().nullable(),
  stop_loss: z.number().positive().optional().nullable(),
  take_profit_1: z.number().positive().optional().nullable(),
  take_profit_2: z.number().positive().optional().nullable(),
  confidence: z.number().min(0).max(100).optional().default(0),
  confluence_factors: z.array(z.string().max(MAX_CONFLUENCE_ITEM_CHARS)).max(MAX_CONFLUENCE_ITEMS).optional(),
  setup_name: z.string().max(128).optional(),
  engine: z.string().max(64).optional(),
  profile: z.enum(['BINARY_QUICK', 'MT5']).optional(),
  platform: z.string().max(64).optional(),
  expiry: z.string().max(16).optional().nullable(),
  strength: z.enum(['Low', 'Medium', 'High']).optional(),
  inputs_snapshot: z.record(z.string(), z.unknown()).optional(),
  feed_source: z.string().max(256).optional(),
  valid_until: z.string().optional().nullable(),
});

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // 0. Enforce strict payload size ceilings (413 Payload Too Large)
  let rawBodyObj: Record<string, unknown> | null = null;
  try {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ ok: false, error: 'Signal payload exceeds maximum allowed size.' });
      }
      rawBodyObj = JSON.parse(req.body);
    } else if (req.body && typeof req.body === 'object') {
      const serialized = JSON.stringify(req.body);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ ok: false, error: 'Signal payload exceeds maximum allowed size.' });
      }
      rawBodyObj = req.body as Record<string, unknown>;
    }
  } catch {
    return res.status(400).json({ ok: false, error: 'Malformed JSON signal payload.' });
  }

  if (rawBodyObj) {
    if (rawBodyObj.inputs_snapshot !== undefined && rawBodyObj.inputs_snapshot !== null) {
      const snapshotBytes = Buffer.byteLength(JSON.stringify(rawBodyObj.inputs_snapshot), 'utf8');
      if (snapshotBytes > MAX_INPUTS_SNAPSHOT_BYTES) {
        return res.status(413).json({
          ok: false,
          error: 'inputs_snapshot exceeds the 8 KB serialized limit.',
        });
      }
    }

    if (Array.isArray(rawBodyObj.confluence_factors)) {
      if (
        rawBodyObj.confluence_factors.length > MAX_CONFLUENCE_ITEMS ||
        rawBodyObj.confluence_factors.some(
          (item) => typeof item === 'string' && item.length > MAX_CONFLUENCE_ITEM_CHARS
        )
      ) {
        return res.status(413).json({
          ok: false,
          error: 'confluence_factors exceeds 12 items of 200 characters max.',
        });
      }
    }
  }

  // 1. Zod input validation (strips/ignores client created_at)
  const parseResult = SignalLogSchema.safeParse(rawBodyObj ?? req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: parseResult.error.issues[0]?.message || 'Invalid signal data payload',
    });
  }

  const payload = parseResult.data;

  // Reject WAIT signals that carry a stop_loss or price targets
  if (
    payload.direction === 'WAIT' &&
    (payload.stop_loss != null ||
      payload.target_price != null ||
      payload.take_profit_1 != null ||
      payload.take_profit_2 != null)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'WAIT signals cannot carry stop_loss or target price fields.',
    });
  }

  // Re-verify serialized inputs_snapshot after parsing
  if (payload.inputs_snapshot) {
    const parsedSnapshotBytes = Buffer.byteLength(JSON.stringify(payload.inputs_snapshot), 'utf8');
    if (parsedSnapshotBytes > MAX_INPUTS_SNAPSHOT_BYTES) {
      return res.status(413).json({
        ok: false,
        error: 'inputs_snapshot exceeds the 8 KB serialized limit.',
      });
    }
  }

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

  // 4. Insert into public.signals using service role (created_at generated exclusively by DB/server)
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
        target_price: payload.target_price ?? null,
        stop_loss: payload.stop_loss ?? null,
        take_profit_1: payload.take_profit_1 ?? null,
        take_profit_2: payload.take_profit_2 ?? null,
        confidence: payload.confidence ?? 0,
        confluence_factors: payload.confluence_factors || [],
        setup_name: payload.setup_name || 'Algorithmic Signal',
        engine: payload.engine || null,
        profile: payload.profile || null,
        platform: payload.platform || null,
        expiry: payload.expiry || null,
        strength: payload.strength || null,
        inputs_snapshot: payload.inputs_snapshot || {},
        feed_source: payload.feed_source || null,
        created_at: new Date().toISOString(),
        valid_until: payload.valid_until || null,
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

