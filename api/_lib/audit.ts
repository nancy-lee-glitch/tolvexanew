import { getSupabaseAdmin } from './supabaseAdmin.js';

export async function logAdminAudit(
  adminId: number,
  action: string,
  targetType?: string,
  targetId?: string,
  details?: Record<string, any>,
  ipAddress?: string
) {
  try {
    const supabase = getSupabaseAdmin();
    await supabase.from('audit_logs').insert({
      admin_id: adminId,
      action,
      target_type: targetType || null,
      target_id: targetId || null,
      details: details || {},
      ip_address: ipAddress || 'serverless_function',
    });
  } catch (err) {
    console.warn('[logAdminAudit Warning]', err);
  }
}
