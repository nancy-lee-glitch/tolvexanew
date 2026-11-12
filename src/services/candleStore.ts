/**
 * candleStore.ts — In-memory session candle store for multi-timeframe analysis.
 *
 * Requirements:
 * - Load M1, M5, M15, H1, H4, D1 candles via feed.getCandles() on demand.
 * - Merge live ticks into the forming candle.
 * - Expose hooks (useCandles(symbol, tf)).
 * - Cache per session in memory (persistence comes in Stage 4).
 */

import { useState, useEffect } from 'react';
import type { Candle, Tick } from './liveFeed.ts';
import { getLiveFeed, subscribeTicks } from './feedSingleton.ts';

export type TimeframeInput = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1' | number;

/**
 * Standard granularity in seconds supported by Deriv ticks_history style: "candles":
 * 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400
 */
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

// In-memory candle storage key: `${symbol}:${granularitySec}`
const candleCache = new Map<string, Candle[]>();
const pendingFetches = new Map<string, Promise<Candle[]>>();
const candleListeners = new Map<string, Set<(candles: Candle[]) => void>>();

let isTickSubscriptionActive = false;

function ensureTickSubscription() {
  if (isTickSubscriptionActive) return;
  isTickSubscriptionActive = true;

  subscribeTicks((tick: Tick) => {
    const symbol = tick.symbol;
    const epoch = tick.epoch;
    const price = tick.price;

    const commonGranularities = [60, 300, 900, 3600, 14400, 86400];

    for (const gran of commonGranularities) {
      const key = `${symbol}:${gran}`;
      const candles = candleCache.get(key);
      if (!candles || candles.length === 0) continue;

      const bucket = Math.floor(epoch / gran) * gran;
      const last = candles[candles.length - 1];

      let updated = false;
      if (last.time === bucket) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        updated = true;
      } else if (bucket > last.time) {
        candles.push({
          time: bucket,
          open: price,
          high: price,
          low: price,
          close: price,
        });
        if (candles.length > 1000) candles.shift();
        updated = true;
      }

      if (updated) {
        const set = candleListeners.get(key);
        if (set && set.size > 0) {
          const snapshot = [...candles];
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

/**
 * Fetch candles on demand from Deriv LiveFeed with in-memory deduplication and caching.
 */
export async function getOrFetchCandles(
  symbol: string,
  timeframe: TimeframeInput,
  count = 300
): Promise<Candle[]> {
  ensureTickSubscription();
  const gran = timeframeToSeconds(timeframe);
  const key = `${symbol}:${gran}`;

  const cached = candleCache.get(key);
  if (cached && cached.length >= 20) {
    return cached;
  }

  if (pendingFetches.has(key)) {
    return pendingFetches.get(key)!;
  }

  const feed = getLiveFeed();
  const promise = feed
    .getCandles(symbol, gran, count)
    .then((fetched) => {
      pendingFetches.delete(key);
      if (fetched && fetched.length > 0) {
        candleCache.set(key, fetched);
        const set = candleListeners.get(key);
        if (set) {
          const snap = [...fetched];
          for (const fn of set) fn(snap);
        }
      }
      return fetched;
    })
    .catch((err) => {
      pendingFetches.delete(key);
      console.warn(`[CandleStore] Failed to fetch candles for ${key}:`, err);
      return candleCache.get(key) || [];
    });

  pendingFetches.set(key, promise);
  return promise;
}

/**
 * React Hook: useCandles
 * Automatically provides on-demand candles for active asset and timeframe,
 * merging real-time ticks into the forming candle.
 */
export function useCandles(
  symbol: string,
  timeframe: TimeframeInput = '1m'
): { candles: Candle[]; isLoading: boolean; error: string | null } {
  const [candles, setCandles] = useState<Candle[]>(() => {
    const gran = timeframeToSeconds(timeframe);
    return candleCache.get(`${symbol}:${gran}`) || [];
  });
  const [isLoading, setIsLoading] = useState<boolean>(candles.length === 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    ensureTickSubscription();
    const gran = timeframeToSeconds(timeframe);
    const key = `${symbol}:${gran}`;

    let isSubscribed = true;

    // Listen for live updates
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

    // Initial load
    const existing = candleCache.get(key);
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
