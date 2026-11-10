import { requireAdmin } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';

export default async function handler(req: any, res: any) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const supabase = getSupabaseAdmin();
  const query = req.query || {};
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const actionFilter = typeof query.action === 'string' ? query.action.trim() : '';

  let dbQuery = supabase
    .from('audit_logs')
    .select('*, users:admin_id(username, email)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (actionFilter) {
    dbQuery = dbQuery.eq('action', actionFilter);
  }

  const { data: logs, error } = await dbQuery;

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({
    ok: true,
    auditLogs: logs || [],
  });
}
