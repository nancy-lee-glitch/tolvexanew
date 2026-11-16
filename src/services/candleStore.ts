/**
 * candleStore.ts — Hybrid Supabase candles_cache + LiveFeed WebSocket candle store.
 *
 * Flow:
 *  1. For persistent timeframes (M5, M15, H1, H4, D1) on non-synthetic symbols:
 *     - Read Supabase `candles_cache` first (paginated beyond PostgREST 1000-row cap when needed).
 *     - Inspect `candles_refresh_log` against staleness windows:
 *         M5 / M15: 15 minutes
 *         H1 / H4:  1 hour
 *         D1:       12 hours
 *     - If missing or stale and caller has a valid Supabase session, trigger `/api/history/refresh`
 *       (deduplicated per symbol+tf) and re-read from `candles_cache`.
 *     - Merge any live incoming WebSocket ticks into the latest forming candle.
 *     - Fall back cleanly to `feed.getCandles()` if DB cache is unavailable/empty.
 *  2. For M1 candles or synthetic indices: stream directly via `feed.getCandles()` + live ticks.
 */

import { useState, useEffect } from 'react';
import type { Candle, Tick } from './liveFeed.ts';
import { getLiveFeed, subscribeTicks } from './feedSingleton.ts';
import { isSyntheticAsset } from './symbolMap.ts';
import { getSupabaseClient, isSupabaseConfigured } from '../utils/supabaseClient.ts';

export type CanonicalCacheTf = 'M5' | 'M15' | 'H1' | 'H4' | 'D1';
export type TimeframeInput =
  | '1m'
  | '5m'
  | '15m'
  | '1h'
  | '4h'
  | '1d'
  | 'M1'
  | 'M5'
  | 'M15'
  | 'H1'
  | 'H4'
  | 'D1'
  | number;

export function timeframeToSeconds(tf: TimeframeInput): number {
  if (typeof tf === 'number') return tf;
  const clean = (tf || '').trim().toLowerCase();
  switch (clean) {
    case '1m':
    case 'm1':
    case '60':
      return 60;
    case '5m':
    case 'm5':
    case '300':
      return 300;
    case '15m':
    case 'm15':
    case '900':
      return 900;
    case '1h':
    case 'h1':
    case '3600':
      return 3600;
    case '4h':
    case 'h4':
    case '14400':
      return 14400;
    case '1d':
    case 'd1':
    case '86400':
      return 86400;
    default:
      return 60;
  }
}

export function toCanonicalDbTf(granularitySec: number): CanonicalCacheTf | null {
  switch (granularitySec) {
    case 300:
      return 'M5';
    case 900:
      return 'M15';
    case 3600:
      return 'H1';
    case 14400:
      return 'H4';
    case 86400:
      return 'D1';
    default:
      return null;
  }
}

export function getFreshWindowMs(tf: CanonicalCacheTf): number {
  switch (tf) {
    case 'M5':
    case 'M15':
      return 15 * 60 * 1000;
    case 'H1':
    case 'H4':
      return 60 * 60 * 1000;
    case 'D1':
      return 12 * 60 * 60 * 1000;
  }
}

const MAX_MEMORY_BARS = 5500;
const MEMORY_REVALIDATE_MS = 60 * 1000;

interface CacheEntry {
  candles: Candle[];
  fetchedAtMs: number;
  requestedCount: number;
}

const candleCache = new Map<string, CacheEntry>();
const pendingFetches = new Map<string, Promise<Candle[]>>();
const pendingServerRefreshes = new Map<string, Promise<boolean>>();
const candleListeners = new Map<string, Set<(candles: Candle[]) => void>>();
const recentTicksBySymbol = new Map<string, Tick[]>();

let isTickSubscriptionActive = false;

/**
 * Pure helper: merge a single tick into a sorted ascending Candle[] list.
 */
export function mergeTickIntoCandles(candles: Candle[], tick: Tick, granSec: number): Candle[] {
  if (!Number.isFinite(tick.price) || !Number.isFinite(tick.epoch) || granSec <= 0) {
    return candles;
  }
  const bucket = Math.floor(tick.epoch / granSec) * granSec;
  const price = tick.price;

  if (candles.length === 0) {
    return [{ time: bucket, open: price, high: price, low: price, close: price }];
  }

  const out = [...candles];
  const last = out[out.length - 1];

  if (last.time === bucket) {
    out[out.length - 1] = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
  } else if (bucket > last.time) {
    out.push({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
    });
    if (out.length > MAX_MEMORY_BARS) {
      out.shift();
    }
  }
  return out;
}

/**
 * Merge any recent live WebSocket ticks recorded in memory into historical DB/WS candles.
 */
export function mergeRecentTicksIntoCandles(candles: Candle[], symbol: string, granSec: number): Candle[] {
  const buffered = recentTicksBySymbol.get(symbol);
  if (!buffered || buffered.length === 0) return candles;
  let merged = candles;
  for (const tick of buffered) {
    merged = mergeTickIntoCandles(merged, tick, granSec);
  }
  return merged;
}

function ensureTickSubscription() {
  if (isTickSubscriptionActive) return;
  isTickSubscriptionActive = true;

  subscribeTicks((tick: Tick) => {
    const symbol = tick.symbol;
    const recent = recentTicksBySymbol.get(symbol) || [];
    recent.push(tick);
    if (recent.length > 200) recent.shift();
    recentTicksBySymbol.set(symbol, recent);

    const commonGranularities = [60, 300, 900, 3600, 14400, 86400];

    for (const gran of commonGranularities) {
      const key = `${symbol}:${gran}`;
      const entry = candleCache.get(key);
      if (!entry || entry.candles.length === 0) continue;

      const bucket = Math.floor(tick.epoch / gran) * gran;
      const last = entry.candles[entry.candles.length - 1];

      let updated = false;
      if (last.time === bucket) {
        last.high = Math.max(last.high, tick.price);
        last.low = Math.min(last.low, tick.price);
        last.close = tick.price;
        updated = true;
      } else if (bucket > last.time) {
        entry.candles.push({
          time: bucket,
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
        });
        if (entry.candles.length > MAX_MEMORY_BARS) entry.candles.shift();
        updated = true;
      }

      if (updated) {
        const set = candleListeners.get(key);
        if (set && set.size > 0) {
          const snapshot = [...entry.candles];
          for (const fn of set) {
            try {
              fn(snapshot);
            } catch (err) {
              console.warn('[CandleStore] Listener error', err);
            }
          }
        }
      }
    }
  });
}

async function fetchCandlesFromSupabaseCache(
  symbol: string,
  tf: CanonicalCacheTf,
  limit: number
): Promise<Candle[]> {
  const client = getSupabaseClient();
  if (!client || !isSupabaseConfigured()) return [];

  const targetCount = Math.min(Math.max(limit, 1), 5000);
  const pageSize = 1000;
  const rows: { open_time: number; o: number; h: number; l: number; c: number }[] = [];

  for (let offset = 0; offset < targetCount; offset += pageSize) {
    const end = Math.min(offset + pageSize - 1, targetCount - 1);
    const { data, error } = await client
      .from('candles_cache')
      .select('open_time, o, h, l, c')
      .eq('symbol', symbol)
      .eq('tf', tf)
      .order('open_time', { ascending: false })
      .range(offset, end);

    if (error || !Array.isArray(data) || data.length === 0) {
      break;
    }

    for (const r of data) {
      const time = Number(r.open_time);
      const open = Number(r.o);
      const high = Number(r.h);
      const low = Number(r.l);
      const close = Number(r.c);
      if (
        Number.isFinite(time) &&
        Number.isFinite(open) &&
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close)
      ) {
        rows.push({ open_time: time, o: open, h: high, l: low, c: close });
      }
    }

    if (data.length < pageSize) {
      break;
    }
  }

  // Query fetched descending; return oldest -> newest
  rows.reverse();
  return rows.map((r) => ({
    time: r.open_time,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
  }));
}

async function isCacheStaleInLog(symbol: string, tf: CanonicalCacheTf): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client || !isSupabaseConfigured()) return true;

  try {
    const { data, error } = await client
      .from('candles_refresh_log')
      .select('last_refreshed_at, last_error')
      .eq('symbol', symbol)
      .eq('tf', tf)
      .maybeSingle();

    if (error || !data || !data.last_refreshed_at || data.last_error) {
      return true;
    }
    const refreshedMs = Date.parse(data.last_refreshed_at);
    if (!Number.isFinite(refreshedMs)) return true;
    return Date.now() - refreshedMs > getFreshWindowMs(tf);
  } catch {
    return true;
  }
}

async function triggerServerRefresh(symbol: string, tf: CanonicalCacheTf): Promise<boolean> {
  if (typeof window === 'undefined' || isSyntheticAsset(symbol)) return false;

  const client = getSupabaseClient();
  if (!client) return false;

  const key = `${symbol}:${tf}`;
  const existing = pendingServerRefreshes.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const { data: sessionData } = await client.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        return false;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 16_000);
      try {
        const res = await fetch('/api/history/refresh', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ symbol, tf }),
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    } finally {
      pendingServerRefreshes.delete(key);
    }
  })();

  pendingServerRefreshes.set(key, promise);
  return promise;
}

/**
 * Fetch candles for a symbol & timeframe:
 *  - Reads Supabase `candles_cache` first when applicable (M5/M15/H1/H4/D1 on non-synthetics).
 *  - Triggers `/api/history/refresh` if missing or stale and re-reads cache.
 *  - Falls back to WebSocket `feed.getCandles()` seamlessly when offline/unauthenticated/local.
 *  - Merges live buffered ticks into the latest forming candle.
 */
export async function getOrFetchCandles(
  symbol: string,
  timeframe: TimeframeInput,
  count = 300
): Promise<Candle[]> {
  if (!symbol) return [];
  ensureTickSubscription();
  const gran = timeframeToSeconds(timeframe);
  const key = `${symbol}:${gran}`;

  const cached = candleCache.get(key);
  if (
    cached &&
    cached.candles.length >= Math.min(count, cached.candles.length) &&
    cached.requestedCount >= count &&
    cached.candles.length >= 20 &&
    Date.now() - cached.fetchedAtMs < MEMORY_REVALIDATE_MS
  ) {
    return cached.candles;
  }

  const inflightKey = `${key}:${count}`;
  if (pendingFetches.has(inflightKey)) {
    return pendingFetches.get(inflightKey)!;
  }

  const dbTf = toCanonicalDbTf(gran);
  const useDbCache = dbTf !== null && !isSyntheticAsset(symbol) && isSupabaseConfigured();

  const promise = (async () => {
    try {
      let resolvedCandles: Candle[] = [];

      if (useDbCache && dbTf) {
        resolvedCandles = await fetchCandlesFromSupabaseCache(symbol, dbTf, count);
        const isStale = await isCacheStaleInLog(symbol, dbTf);

        if (resolvedCandles.length === 0 || isStale || resolvedCandles.length < Math.min(count, 20)) {
          const refreshed = await triggerServerRefresh(symbol, dbTf);
          if (refreshed) {
            const freshRows = await fetchCandlesFromSupabaseCache(symbol, dbTf, count);
            if (freshRows.length > 0) {
              resolvedCandles = freshRows;
            }
          }
        }
      }

      // WebSocket fallback if DB cache unavailable, unauthenticated, or incomplete for requested history
      if (resolvedCandles.length < Math.min(count, 20)) {
        const feed = getLiveFeed();
        const wsCandles = await feed.getCandles(symbol, gran, Math.min(count, 5000)).catch(() => []);
        if (wsCandles.length > resolvedCandles.length) {
          resolvedCandles = wsCandles;
        }
      }

      if (resolvedCandles.length > 0) {
        const merged = mergeRecentTicksIntoCandles(resolvedCandles, symbol, gran);
        candleCache.set(key, {
          candles: merged,
          fetchedAtMs: Date.now(),
          requestedCount: count,
        });
        const set = candleListeners.get(key);
        if (set) {
          const snap = [...merged];
          for (const fn of set) fn(snap);
        }
        return merged;
      }

      return cached?.candles || [];
    } catch (err) {
      console.warn(`[CandleStore] Failed to fetch candles for ${key}:`, err);
      return cached?.candles || [];
    } finally {
      pendingFetches.delete(inflightKey);
    }
  })();

  pendingFetches.set(inflightKey, promise);
  return promise;
}

/**
 * React Hook: useCandles
 */
export function useCandles(
  symbol: string,
  timeframe: TimeframeInput = '1m'
): { candles: Candle[]; isLoading: boolean; error: string | null } {
  const [candles, setCandles] = useState<Candle[]>(() => {
    const gran = timeframeToSeconds(timeframe);
    return candleCache.get(`${symbol}:${gran}`)?.candles || [];
  });
  const [isLoading, setIsLoading] = useState<boolean>(candles.length === 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    ensureTickSubscription();
    const gran = timeframeToSeconds(timeframe);
    const key = `${symbol}:${gran}`;

    let isSubscribed = true;

    let set = candleListeners.get(key);
    if (!set) {
      set = new Set();
      candleListeners.set(key, set);
    }

    const listener = (updated: Candle[]) => {
      if (isSubscribed) {
        setCandles(updated);
        setIsLoading(false);
      }
    };
    set.add(listener);

    const existing = candleCache.get(key)?.candles;
    if (existing && existing.length > 0) {
      setCandles(existing);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      setError(null);
      getOrFetchCandles(symbol, gran)
        .then((data) => {
          if (isSubscribed) {
            setCandles(data);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (isSubscribed) {
            setError(err?.message || 'Failed to load historical candle data.');
            setIsLoading(false);
          }
        });
    }

    return () => {
      isSubscribed = false;
      set?.delete(listener);
    };
  }, [symbol, timeframe]);

  return { candles, isLoading, error };
}
