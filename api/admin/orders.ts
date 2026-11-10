import { requireAdmin } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

export default async function handler(req: any, res: any) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const supabase = getSupabaseAdmin();

  // GET: Fetch direct orders & payment orders
  if (req.method === 'GET') {
    const { data: directOrders, error: directErr } = await supabase
      .from('direct_orders')
      .select('*, users:user_id(username, email)')
      .order('created_at', { ascending: false })
      .limit(100);

    const { data: gatewayOrders, error: gatewayErr } = await supabase
      .from('payment_orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (directErr) {
      return res.status(500).json({ ok: false, error: directErr.message });
    }

    return res.json({
      ok: true,
      directOrders: directOrders || [],
      gatewayOrders: gatewayOrders || [],
    });
  }

  // POST: Review actions on direct orders (approve, reject)
  if (req.method === 'POST') {
    const { action, orderId, notes } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'Order ID is required.' });
    }

    const { data: order, error: fetchErr } = await supabase
      .from('direct_orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (fetchErr || !order) {
      return res.status(404).json({ ok: false, error: 'Direct order record not found.' });
    }

    if (order.status !== 'PENDING') {
      return res.status(400).json({
        ok: false,
        error: `Order has already been reviewed (current status: ${order.status}).`,
      });
    }

    if (action === 'approve') {
      // 1. Fetch user to grant credits or VIP
      const { data: targetUser } = await supabase
        .from('users')
        .select('*')
        .eq('id', order.user_id)
        .maybeSingle();

      if (!targetUser) {
        return res.status(404).json({ ok: false, error: 'Associated user account not found.' });
      }

      const isVipPackage = String(order.package_id).toLowerCase().includes('vip') || Number(order.amount) >= 40;

      if (isVipPackage) {
        // Grant 30 days VIP
        const now = Date.now();
        const currentExp = targetUser.vip_expires_at ? new Date(targetUser.vip_expires_at).getTime() : 0;
        const baseTime = targetUser.is_vip && currentExp > now ? currentExp : now;
        const newExpiry = new Date(baseTime + 30 * 86400000).toISOString();

        await supabase
          .from('users')
          .update({
            is_vip: true,
            vip_expires_at: newExpiry,
            credits: 9999,
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetUser.id);

        await supabase.from('credit_ledger').insert({
          user_id: targetUser.id,
          delta: 0,
          reason: 'manual_order_vip_approval',
          ref_id: String(orderId),
          balance_after: 9999,
        });
      } else {
        // Credit grant
        const creditsToAdd = Number(order.amount) >= 20 ? 80 : 10;
        const newBalance = targetUser.credits + creditsToAdd;

        await supabase
          .from('users')
          .update({
            credits: newBalance,
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetUser.id);

        await supabase.from('credit_ledger').insert({
          user_id: targetUser.id,
          delta: creditsToAdd,
          reason: 'manual_order_credit_approval',
          ref_id: String(orderId),
          balance_after: newBalance,
        });
      }

      // Update order status
      const { data: updatedOrder, error: updateErr } = await supabase
        .from('direct_orders')
        .update({
          status: 'APPROVED',
          reviewer_notes: notes || 'Payment verified by administrator',
          reviewed_at: new Date().toISOString(),
          reviewed_by: admin.userId,
        })
        .eq('id', orderId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ ok: false, error: updateErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'APPROVE_DIRECT_ORDER',
        'direct_orders',
        String(orderId),
        { userId: targetUser.id, amount: order.amount, isVipPackage }
      );

      return res.json({
        ok: true,
        message: 'Order approved and benefits granted to user.',
        order: updatedOrder,
      });
    }

    if (action === 'reject') {
      const { data: updatedOrder, error: updateErr } = await supabase
        .from('direct_orders')
        .update({
          status: 'REJECTED',
          reviewer_notes: notes || 'Rejected by administrator',
          reviewed_at: new Date().toISOString(),
          reviewed_by: admin.userId,
        })
        .eq('id', orderId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ ok: false, error: updateErr.message });
      }

      await logAdminAudit(
        admin.userId,
        'REJECT_DIRECT_ORDER',
        'direct_orders',
        String(orderId),
        { reason: notes }
      );

      return res.json({
        ok: true,
        message: 'Order status marked as rejected.',
        order: updatedOrder,
      });
    }

    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
