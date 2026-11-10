import { requireAdmin } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

export default async function handler(req: any, res: any) {
  const supabase = getSupabaseAdmin();

  // GET: Publicly accessible list of active packages
  if (req.method === 'GET') {
    const { data: packages, error } = await supabase
      .from('pricing_packages')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, packages: packages || [] });
  }

  // POST: Admin update of pricing packages
  if (req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { packages } = req.body || {};
    if (!Array.isArray(packages)) {
      return res.status(400).json({ ok: false, error: 'Expected an array of packages.' });
    }

    // Upsert packages
    for (const pkg of packages) {
      const packageData = {
        name: String(pkg.name || 'Package').trim(),
        type: pkg.type === 'VIP_30_DAY' || pkg.type === 'BUNDLE' ? pkg.type : 'CREDITS',
        credits_amount: Number(pkg.credits_amount) || 0,
        bonus_credits: Number(pkg.bonus_credits) || 0,
        price_usd: Number(pkg.price_usd) || 0,
        badge_label: pkg.badge_label ? String(pkg.badge_label).trim() : null,
        description: String(pkg.description || '').trim(),
        is_active: pkg.is_active !== false,
        sort_order: Number(pkg.sort_order) || 1,
        updated_at: new Date().toISOString(),
      };

      if (pkg.id && !String(pkg.id).startsWith('new_')) {
        await supabase
          .from('pricing_packages')
          .update(packageData)
          .eq('id', Number(pkg.id));
      } else {
        await supabase
          .from('pricing_packages')
          .insert(packageData);
      }
    }

    await logAdminAudit(
      admin.userId,
      'UPDATE_PRICING_PACKAGES',
      'pricing_packages',
      undefined,
      { packageCount: packages.length }
    );

    const { data: updatedList } = await supabase
      .from('pricing_packages')
      .select('*')
      .order('sort_order', { ascending: true });

    return res.json({
      ok: true,
      message: 'Pricing packages updated successfully.',
      packages: updatedList || [],
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
