import { requireAdmin } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

export default async function handler(req: any, res: any) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const supabase = getSupabaseAdmin();

  // GET: List users with pagination and search
  if (req.method === 'GET') {
    const query = req.query || {};
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const search = typeof query.search === 'string' ? query.search.trim() : '';

    let dbQuery = supabase
      .from('users')
      .select('id, auth_user_id, username, email, role, credits, is_vip, vip_expires_at, registration_ip, created_at, updated_at', { count: 'exact' });

    if (search) {
      dbQuery = dbQuery.or(`email.ilike.%${search}%,username.ilike.%${search}%`);
    }

    const { data: users, count, error } = await dbQuery
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok: true,
      users: users || [],
      total: count || 0,
      limit,
      offset,
    });
  }

  // POST: Actions on users (grant_vip, revoke_vip, adjust_credits)
  if (req.method === 'POST') {
    const { action, userId, days, credits, reason } = req.body || {};
    const targetUserId = Number(userId);

    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ ok: false, error: 'A valid numeric userId is required.' });
    }

    // Fetch target user first
    const { data: targetUser, error: fetchErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', targetUserId)
      .maybeSingle();

    if (fetchErr || !targetUser) {
      return res.status(404).json({ ok: false, error: 'Target user account not found.' });
    }

    if (action === 'grant_vip') {
      const grantDays = Math.max(1, Number(days) || 30);
      const now = Date.now();
      const currentExpiry = targetUser.vip_expires_at ? new Date(targetUser.vip_expires_at).getTime() : 0;
      const baseTime = targetUser.is_vip && currentExpiry > now ? currentExpiry : now;
      const newExpiry = new Date(baseTime + grantDays * 86400000).toISOString();

      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({
          is_vip: true,
          vip_expires_at: newExpiry,
          credits: 9999,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetUserId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ ok: false, error: updateErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'GRANT_VIP',
        'user',
        String(targetUserId),
        { days: grantDays, newExpiry, targetEmail: targetUser.email }
      );

      return res.json({
        ok: true,
        message: `Granted ${grantDays} days VIP to ${targetUser.username}.`,
        user: updated,
      });
    }

    if (action === 'revoke_vip') {
      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({
          is_vip: false,
          vip_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetUserId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ ok: false, error: updateErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'REVOKE_VIP',
        'user',
        String(targetUserId),
        { targetEmail: targetUser.email }
      );

      return res.json({
        ok: true,
        message: `VIP status revoked for ${targetUser.username}.`,
        user: updated,
      });
    }

    if (action === 'adjust_credits') {
      const newCredits = Math.max(0, Number(credits) || 0);
      const delta = newCredits - targetUser.credits;

      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({
          credits: newCredits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetUserId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ ok: false, error: updateErr.message });
      }

      // Write immutable credit ledger record
      await supabase.from('credit_ledger').insert({
        user_id: targetUserId,
        delta,
        reason: reason || 'admin_manual_adjustment',
        balance_after: newCredits,
      });

      await logAdminAudit(
        admin.userId,
        'ADJUST_CREDITS',
        'user',
        String(targetUserId),
        { oldCredits: targetUser.credits, newCredits, delta, reason }
      );

      return res.json({
        ok: true,
        message: `Updated credits for ${targetUser.username} to ${newCredits}.`,
        user: updated,
      });
    }

    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
