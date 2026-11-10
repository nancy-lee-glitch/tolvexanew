import { requireAdmin, authenticateRequest } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

export default async function handler(req: any, res: any) {
  const supabase = getSupabaseAdmin();

  // GET: Public returns only safe keys ('site_branding', 'external_broker').
  // If caller is verified admin, can return all settings.
  if (req.method === 'GET') {
    const auth = await authenticateRequest(req);
    const isAdmin = auth?.isAdmin || false;

    let dbQuery = supabase.from('app_settings').select('key, value, updated_at');
    if (!isAdmin) {
      dbQuery = dbQuery.in('key', ['site_branding', 'external_broker']);
    }

    const { data: rows, error } = await dbQuery;
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    const settingsMap: Record<string, any> = {};
    for (const row of rows || []) {
      settingsMap[row.key] = row.value;
    }

    return res.json({
      ok: true,
      settings: settingsMap,
    });
  }

  // POST: Admin updates a setting key/value
  if (req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { key, value } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ ok: false, error: 'Setting key is required.' });
    }

    const cleanKey = key.trim();

    const { data: updated, error } = await supabase
      .from('app_settings')
      .upsert({
        key: cleanKey,
        value,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    await logAdminAudit(
      admin.userId,
      'UPDATE_SETTINGS',
      'app_settings',
      cleanKey,
      { key: cleanKey }
    );

    return res.json({
      ok: true,
      message: `Setting ${cleanKey} updated successfully.`,
      setting: updated,
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
