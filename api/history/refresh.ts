import crypto from 'node:crypto';
import WebSocket from 'ws';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { authenticateRequest } from '../_lib/auth.js';
import { checkRateLimit } from '../_lib/rateLimit.js';

/**
 * api/history/refresh.ts — Persistent multi-timeframe candle cache refresher.
 *
 * Vercel Cron Note:
 *  - vercel.json configures daily cron jobs for the top 20 non-synthetic assets
 *    because Vercel's free (Hobby) plan limits cron frequency (max once per day)
 *    and limits total cron count per deployment (upgrade to Pro or use an external
 *    scheduler with CRON_SECRET if running all 20 independent schedules on Vercel).
 *  - Interactive logged-in client requests can also trigger on-demand refreshes
 *    protected by per-IP + per-symbol fail-closed rate limits and staleness checks.
 */

export type CanonicalTf = 'M5' | 'M15' | 'H1' | 'H4' | 'D1';

const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const WS_TIMEOUT_MS = 15_000;

interface TfConfig {
  tf: CanonicalTf;
  granularity: number;
  limit: number;
  freshWindowMs: number;
}

const TF_CONFIGS: Record<CanonicalTf, TfConfig> = {
  M5: { tf: 'M5', granularity: 300, limit: 2000, freshWindowMs: 15 * 60 * 1000 },
  M15: { tf: 'M15', granularity: 900, limit: 2000, freshWindowMs: 15 * 60 * 1000 },
  H1: { tf: 'H1', granularity: 3600, limit: 5000, freshWindowMs: 60 * 60 * 1000 },
  H4: { tf: 'H4', granularity: 14400, limit: 5000, freshWindowMs: 60 * 60 * 1000 },
  D1: { tf: 'D1', granularity: 86400, limit: 5000, freshWindowMs: 12 * 60 * 60 * 1000 },
};

const ALL_TFS: CanonicalTf[] = ['D1', 'H4', 'H1', 'M15', 'M5'];

function normalizeTimeframe(raw: unknown): CanonicalTf | 'ALL' | null {
  const s = String(raw || '').trim().toUpperCase();
  switch (s) {
    case 'M5':
    case '5M':
    case '300':
      return 'M5';
    case 'M15':
    case '15M':
    case '900':
      return 'M15';
    case 'H1':
    case '1H':
    case '3600':
      return 'H1';
    case 'H4':
    case '4H':
    case '14400':
      return 'H4';
    case 'D1':
    case '1D':
    case '86400':
      return 'D1';
    case 'ALL':
      return 'ALL';
    default:
      return null;
  }
}

function isSyntheticSymbolPattern(symbol: string): boolean {
  return /^(R_|1HZ|BOOM|CRASH|JD\d+|STPRNG|RDBEAR|RDBULL)/i.test(symbol.trim());
}

function constantTimeMatch(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function isAuthorizedCron(req: any): boolean {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const headers = req.headers || {};
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token && constantTimeMatch(token, secret)) return true;
  }
  const cronHeader = headers['x-cron-secret'];
  if (typeof cronHeader === 'string' && cronHeader.trim()) {
    if (constantTimeMatch(cronHeader.trim(), secret)) return true;
  }
  return false;
}

function extractClientIp(req: any): string {
  const forwarded = req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || '';
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

interface DerivCandleRow {
  open_time: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

async function fetchDerivCandlesShortLived(
  symbol: string,
  tfs: TfConfig[]
): Promise<{
  ok: boolean;
  candlesByTf?: Record<CanonicalTf, DerivCandleRow[]>;
  error?: string;
  statusCode?: number;
}> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    let reqCounter = 0;

    const finish = (result: {
      ok: boolean;
      candlesByTf?: Record<CanonicalTf, DerivCandleRow[]>;
      error?: string;
      statusCode?: number;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws) {
          ws.terminate();
        }
      } catch {
        // ignore close errors
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Deriv WebSocket request timed out after 15 seconds.', statusCode: 504 });
    }, WS_TIMEOUT_MS);

    try {
      ws = new WebSocket(DERIV_PUBLIC_WS);
    } catch (err: any) {
      finish({ ok: false, error: err?.message || 'Failed to open Deriv WebSocket.', statusCode: 502 });
      return;
    }

    const activeSymbolsReqId = ++reqCounter;
    const tfByReqId = new Map<number, TfConfig>();
    const collected = {} as Record<CanonicalTf, DerivCandleRow[]>;
    let pendingHistoryCount = 0;

    ws.on('open', () => {
      if (!ws || settled) return;
      ws.send(JSON.stringify({ active_symbols: 'brief', req_id: activeSymbolsReqId }));
    });

    ws.on('message', (data) => {
      if (settled) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.req_id === activeSymbolsReqId) {
        if (msg.error) {
          finish({ ok: false, error: msg.error.message || 'Deriv active_symbols failed.', statusCode: 502 });
          return;
        }
        const list: any[] = Array.isArray(msg.active_symbols) ? msg.active_symbols : [];
        const match = list.find((item) => (item?.underlying_symbol ?? item?.symbol) === symbol);
        if (!match) {
          finish({
            ok: false,
            error: `Symbol '${symbol}' does not exist in Deriv active_symbols.`,
            statusCode: 400,
          });
          return;
        }
        const market = String(match.market || '').trim().toLowerCase();
        if (market === 'synthetic_index' || market === 'synthetic' || market === 'synthetics' || isSyntheticSymbolPattern(symbol)) {
          finish({
            ok: false,
            error: `Synthetic symbol '${symbol}' is excluded from candles_cache.`,
            statusCode: 400,
          });
          return;
        }

        // Valid live non-synthetic symbol confirmed; fetch requested timeframe(s)
        pendingHistoryCount = tfs.length;
        for (const cfg of tfs) {
          const histReqId = ++reqCounter;
          tfByReqId.set(histReqId, cfg);
          ws!.send(
            JSON.stringify({
              ticks_history: symbol,
              style: 'candles',
              granularity: cfg.granularity,
              count: cfg.limit,
              end: 'latest',
              adjust_start_time: 1,
              req_id: histReqId,
            })
          );
        }
        return;
      }

      const cfg = tfByReqId.get(msg.req_id);
      if (cfg) {
        if (msg.error) {
          finish({
            ok: false,
            error: `Deriv ticks_history error (${cfg.tf}): ${msg.error.message || 'unknown error'}`,
            statusCode: 502,
          });
          return;
        }
        const rawCandles: any[] = Array.isArray(msg.candles) ? msg.candles : [];
        const rows: DerivCandleRow[] = [];
        for (const c of rawCandles) {
          const openTime = Number(c?.epoch);
          const o = Number(c?.open);
          const h = Number(c?.high);
          const l = Number(c?.low);
          const cl = Number(c?.close);
          if (
            Number.isFinite(openTime) &&
            openTime > 0 &&
            Number.isFinite(o) &&
            Number.isFinite(h) &&
            Number.isFinite(l) &&
            Number.isFinite(cl)
          ) {
            rows.push({ open_time: openTime, o, h, l, c: cl });
          }
        }
        collected[cfg.tf] = rows;
        pendingHistoryCount -= 1;
        if (pendingHistoryCount <= 0) {
          finish({ ok: true, candlesByTf: collected });
        }
      }
    });

    ws.on('error', (err) => {
      finish({ ok: false, error: err?.message || 'Deriv WebSocket connection error.', statusCode: 502 });
    });

    ws.on('close', () => {
      if (!settled) {
        finish({ ok: false, error: 'Deriv WebSocket closed before candle response.', statusCode: 502 });
      }
    });
  });
}

async function upsertRefreshError(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  symbol: string,
  tfs: CanonicalTf[],
  errMsg: string
) {
  try {
    const truncated = errMsg.slice(0, 500);
    for (const tf of tfs) {
      const { data: existing } = await supabase
        .from('candles_refresh_log')
        .select('last_refreshed_at')
        .eq('symbol', symbol)
        .eq('tf', tf)
        .maybeSingle();
      await supabase.from('candles_refresh_log').upsert(
        {
          symbol,
          tf,
          last_refreshed_at: existing?.last_refreshed_at ?? null,
          last_error: truncated,
        },
        { onConflict: 'symbol,tf' }
      );
    }
  } catch {
    // non-fatal logging failure
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const rawBody =
    req.method === 'POST'
      ? typeof req.body === 'string'
        ? (() => {
            try {
              return JSON.parse(req.body);
            } catch {
              return {};
            }
          })()
        : req.body || {}
      : {};

  const symbol = String(req.query?.symbol ?? rawBody?.symbol ?? '').trim();
  const normalizedTf = normalizeTimeframe(req.query?.tf ?? rawBody?.tf);

  if (!symbol || !/^[A-Za-z0-9_/-]{1,32}$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: 'Valid symbol parameter is required.' });
  }

  if (!normalizedTf) {
    return res.status(400).json({
      ok: false,
      error: 'Valid tf parameter is required (M5, M15, H1, H4, D1).',
    });
  }

  if (isSyntheticSymbolPattern(symbol)) {
    return res.status(400).json({
      ok: false,
      error: `Synthetic symbol '${symbol}' cannot be cached in candles_cache.`,
    });
  }

  // Auth: accept either Vercel Cron secret OR logged-in Supabase user
  const isCron = isAuthorizedCron(req);
  if (!isCron) {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized: Valid session token or CRON_SECRET required.',
      });
    }
  }

  // Fail-closed rate limits (per-IP for user callers + per-symbol cooldown)
  const ip = extractClientIp(req);
  if (!isCron) {
    const ipLimit = await checkRateLimit(`hist:ip:${ip}`, 60, 60, true);
    if (!ipLimit.allowed) {
      return res.status(429).json({
        ok: false,
        error: ipLimit.error || 'Too many candle history requests from this IP. Please retry shortly.',
        retry_after: ipLimit.retryAfter || 60,
      });
    }
  }

  const symLimit = await checkRateLimit(`hist:sym:${symbol}:${normalizedTf}`, 6, 60, true);
  if (!symLimit.allowed) {
    return res.status(429).json({
      ok: false,
      error: symLimit.error || `Refresh cooldown active for ${symbol} ${normalizedTf}.`,
      retry_after: symLimit.retryAfter || 60,
    });
  }

  const targetTfs: TfConfig[] =
    normalizedTf === 'ALL' ? ALL_TFS.map((t) => TF_CONFIGS[t]) : [TF_CONFIGS[normalizedTf]];

  const supabase = getSupabaseAdmin();

  // Staleness check against candles_refresh_log
  const { data: logs, error: logReadErr } = await supabase
    .from('candles_refresh_log')
    .select('tf, last_refreshed_at, last_error')
    .eq('symbol', symbol)
    .in(
      'tf',
      targetTfs.map((c) => c.tf)
    );

  if (logReadErr) {
    return res.status(500).json({
      ok: false,
      error: `Failed to check candle refresh log: ${logReadErr.message}`,
    });
  }

  const logByTf = new Map<string, { last_refreshed_at: string | null; last_error: string | null }>();
  for (const row of logs || []) {
    logByTf.set(row.tf, row);
  }

  const nowMs = Date.now();
  const staleConfigs: TfConfig[] = [];
  const skippedTfs: CanonicalTf[] = [];

  for (const cfg of targetTfs) {
    const entry = logByTf.get(cfg.tf);
    const refreshedAtMs = entry?.last_refreshed_at ? Date.parse(entry.last_refreshed_at) : NaN;
    if (
      Number.isFinite(refreshedAtMs) &&
      !entry?.last_error &&
      nowMs - refreshedAtMs < cfg.freshWindowMs
    ) {
      skippedTfs.push(cfg.tf);
    } else {
      staleConfigs.push(cfg);
    }
  }

  if (staleConfigs.length === 0) {
    return res.status(200).json({
      ok: true,
      symbol,
      tf: normalizedTf,
      skipped: true,
      skipped_tfs: skippedTfs,
      refreshed_tfs: [],
      upserted: 0,
      reason: 'Cached candles are still fresh within timeframe window.',
    });
  }

  // Fetch from short-lived Deriv WS with active_symbols check + ticks_history
  const wsResult = await fetchDerivCandlesShortLived(symbol, staleConfigs);
  if (!wsResult.ok || !wsResult.candlesByTf) {
    await upsertRefreshError(
      supabase,
      symbol,
      staleConfigs.map((c) => c.tf),
      wsResult.error || 'Unknown Deriv WebSocket fetch failure'
    );
    return res.status(wsResult.statusCode || 502).json({
      ok: false,
      symbol,
      tf: normalizedTf,
      error: wsResult.error || 'Failed to fetch candles from Deriv.',
    });
  }

  // Upsert fetched candles in chunks & update candles_refresh_log
  let totalUpserted = 0;
  const refreshedTfs: CanonicalTf[] = [];

  for (const cfg of staleConfigs) {
    const rows = (wsResult.candlesByTf[cfg.tf] || []).map((r) => ({
      symbol,
      tf: cfg.tf,
      open_time: r.open_time,
      o: r.o,
      h: r.h,
      l: r.l,
      c: r.c,
    }));

    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error: upsertErr } = await supabase
        .from('candles_cache')
        .upsert(batch, { onConflict: 'symbol,tf,open_time' });

      if (upsertErr) {
        await upsertRefreshError(supabase, symbol, [cfg.tf], upsertErr.message);
        return res.status(500).json({
          ok: false,
          symbol,
          tf: cfg.tf,
          error: `Database upsert failed: ${upsertErr.message}`,
        });
      }
      totalUpserted += batch.length;
    }

    const { error: logErr } = await supabase.from('candles_refresh_log').upsert(
      {
        symbol,
        tf: cfg.tf,
        last_refreshed_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: 'symbol,tf' }
    );

    if (logErr) {
      return res.status(500).json({
        ok: false,
        symbol,
        tf: cfg.tf,
        error: `Refresh log update failed: ${logErr.message}`,
      });
    }

    refreshedTfs.push(cfg.tf);
  }

  return res.status(200).json({
    ok: true,
    symbol,
    tf: normalizedTf,
    skipped: false,
    skipped_tfs: skippedTfs,
    refreshed_tfs: refreshedTfs,
    upserted: totalUpserted,
  });
}
