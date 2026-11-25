import { z } from 'zod';
import { requireAdmin, authenticateRequest } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

const DEFAULT_CONDITIONS_CONFIG = {
  binaryTickMaxAgeSec: 6,
  binaryNewsWindowMinutes: 15,
  mt5NewsWindowMinutes: 30,
  cautionNewsWindowMinutes: 60,
  rolloverStartHourUtc: 21,
  rolloverEndHourUtc: 24,
  atrPercentileLowBlock: 10,
  atrPercentileHighBlock: 95,
  atrPercentileLowCautionMax: 25,
  atrPercentileHighCautionMin: 85,
  quietSessionQuartile: 0.25,
  fridayCutoffHourUtc: 19,
  maxConsecutiveLosses: 3,
};

const ConditionsConfigSchema = z
  .object({
    binaryTickMaxAgeSec: z.number().finite().min(1).max(60).default(6),
    binaryNewsWindowMinutes: z.number().int().min(0).max(180).default(15),
    mt5NewsWindowMinutes: z.number().int().min(0).max(240).default(30),
    cautionNewsWindowMinutes: z.number().int().min(0).max(360).default(60),
    rolloverStartHourUtc: z.number().int().min(0).max(23).default(21),
    rolloverEndHourUtc: z.number().int().min(1).max(24).default(24),
    atrPercentileLowBlock: z.number().finite().min(0).max(45).default(10),
    atrPercentileHighBlock: z.number().finite().min(55).max(100).default(95),
    atrPercentileLowCautionMax: z.number().finite().min(0).max(50).default(25),
    atrPercentileHighCautionMin: z.number().finite().min(50).max(100).default(85),
    quietSessionQuartile: z.number().finite().min(0.05).max(0.5).default(0.25),
    fridayCutoffHourUtc: z.number().int().min(12).max(23).default(19),
    maxConsecutiveLosses: z.number().int().min(1).max(20).default(3),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.atrPercentileLowBlock > cfg.atrPercentileLowCautionMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'atrPercentileLowBlock cannot exceed atrPercentileLowCautionMax.',
      });
    }
    if (cfg.atrPercentileLowCautionMax >= cfg.atrPercentileHighCautionMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'atrPercentileLowCautionMax must be lower than atrPercentileHighCautionMin.',
      });
    }
    if (cfg.atrPercentileHighCautionMin > cfg.atrPercentileHighBlock) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'atrPercentileHighCautionMin cannot exceed atrPercentileHighBlock.',
      });
    }
    if (
      cfg.cautionNewsWindowMinutes <
      Math.max(cfg.binaryNewsWindowMinutes, cfg.mt5NewsWindowMinutes)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cautionNewsWindowMinutes must be >= binary and MT5 news windows.',
      });
    }
  });

export default async function handler(req: any, res: any) {
  // GET: Public returns only safe keys ('site_branding', 'external_broker', 'min_actionable_strength', 'conditions_config').
  // If caller is verified admin, can return all settings.
  if (req.method === 'GET') {
    const auth = await authenticateRequest(req);
    const isAdmin = auth?.isAdmin || false;
    const supabase = getSupabaseAdmin();

    let dbQuery = supabase.from('app_settings').select('key, value, updated_at');
    if (!isAdmin) {
      dbQuery = dbQuery.in('key', [
        'site_branding',
        'external_broker',
        'min_actionable_strength',
        'conditions_config',
      ]);
    }

    const { data: rows, error } = await dbQuery;
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    const settingsMap: Record<string, any> = {};
    for (const row of rows || []) {
      settingsMap[row.key] = row.value;
    }
    if (
      settingsMap.min_actionable_strength !== 'Low' &&
      settingsMap.min_actionable_strength !== 'Medium' &&
      settingsMap.min_actionable_strength !== 'High'
    ) {
      settingsMap.min_actionable_strength = 'Medium';
    }

    const parsedConditions = ConditionsConfigSchema.safeParse(settingsMap.conditions_config);
    settingsMap.conditions_config = parsedConditions.success
      ? parsedConditions.data
      : { ...DEFAULT_CONDITIONS_CONFIG };

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
    let storedValue = value;

    if (cleanKey === 'min_actionable_strength') {
      if (value !== 'Low' && value !== 'Medium' && value !== 'High') {
        return res.status(400).json({
          ok: false,
          error: "min_actionable_strength must be 'Low', 'Medium', or 'High'.",
        });
      }
    } else if (cleanKey === 'conditions_config') {
      const check = ConditionsConfigSchema.safeParse(value);
      if (!check.success) {
        return res.status(400).json({
          ok: false,
          error: check.error.issues[0]?.message || 'Invalid conditions_config payload.',
        });
      }
      storedValue = check.data;
    }

    const supabase = getSupabaseAdmin();
    const { data: updated, error } = await supabase
      .from('app_settings')
      .upsert({
        key: cleanKey,
        value: storedValue,
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
