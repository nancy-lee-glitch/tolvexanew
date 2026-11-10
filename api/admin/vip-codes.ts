import crypto from 'node:crypto';
import { requireAdmin } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

export default async function handler(req: any, res: any) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const supabase = getSupabaseAdmin();

  // GET: Fetch list of VIP codes
  if (req.method === 'GET') {
    const { data: codes, error } = await supabase
      .from('vip_codes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, vipCodes: codes || [] });
  }

  // POST: Actions (generate, toggle, delete)
  if (req.method === 'POST') {
    const { action, count, durationDays, id } = req.body || {};

    if (action === 'generate') {
      const codeCount = Math.min(50, Math.max(1, Number(count) || 1));
      const days = Math.max(1, Number(durationDays) || 30);
      const generatedCodes: Array<{
        code: string;
        duration_days: number;
        is_active: boolean;
        is_redeemed: boolean;
        created_by_admin: string;
      }> = [];

      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < codeCount; i++) {
        let codeStr = 'TK-';
        const bytes = crypto.randomBytes(9);
        for (let b = 0; b < 9; b++) {
          codeStr += chars[bytes[b] % chars.length];
        }
        generatedCodes.push({
          code: codeStr,
          duration_days: days,
          is_active: true,
          is_redeemed: false,
          created_by_admin: admin.email,
        });
      }

      const { data: inserted, error: insertErr } = await supabase
        .from('vip_codes')
        .insert(generatedCodes)
        .select();

      if (insertErr) {
        return res.status(500).json({ ok: false, error: insertErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'GENERATE_VIP_CODES',
        'vip_codes',
        undefined,
        { count: codeCount, durationDays: days }
      );

      return res.json({
        ok: true,
        message: `Successfully generated ${codeCount} VIP code(s).`,
        generated: inserted || [],
      });
    }

    if (action === 'toggle') {
      if (!id) {
        return res.status(400).json({ ok: false, error: 'VIP code id is required.' });
      }

      const { data: existing, error: fetchErr } = await supabase
        .from('vip_codes')
        .select('id, code, is_active')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr || !existing) {
        return res.status(404).json({ ok: false, error: 'VIP code record not found.' });
      }

      const nextState = !existing.is_active;
      const { data: updated, error: updateErr } = await supabase
        .from('vip_codes')
        .update({ is_active: nextState })
        .eq('id', id)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ ok: false, error: updateErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'TOGGLE_VIP_CODE',
        'vip_codes',
        String(id),
        { code: existing.code, is_active: nextState }
      );

      return res.json({ ok: true, code: updated });
    }

    if (action === 'delete') {
      if (!id) {
        return res.status(400).json({ ok: false, error: 'VIP code id is required.' });
      }

      const { error: delErr } = await supabase
        .from('vip_codes')
        .delete()
        .eq('id', id)
        .eq('is_redeemed', false); // Only unredeemed codes can be deleted

      if (delErr) {
        return res.status(500).json({ ok: false, error: delErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'DELETE_VIP_CODE',
        'vip_codes',
        String(id)
      );

      return res.json({ ok: true, message: 'VIP code removed.' });
    }

    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
