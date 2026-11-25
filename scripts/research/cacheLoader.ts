/**
 * scripts/research/cacheLoader.ts — Reads cached real Deriv candles from data/cache/.
 *
 * Rule: Does NOT download more when cache files already exist.
 * Only downloads from Deriv WebSocket when a required cache file is missing (~1 year lookback).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DERIV_WS_URL,
  DerivHistoryClient,
  MT5_TIMEFRAME_SPECS,
  PAGE_COUNT,
  selectUniverseFromActiveSymbols,
  type ActiveSymbolRaw,
  type Mt5SymbolHistory,
} from '../backtest-real.ts';
import type { Candle } from '../../src/utils/engines/types.ts';
import type { AssetConfig } from '../../src/types.ts';

const CACHE_DIR = resolve(process.cwd(), 'data/cache');
const ONE_YEAR_LOOKBACK_SEC = 365 * 86400;

interface CandleCacheFile {
  symbol: string;
  timeframe: string;
  granularitySec: number;
  complete: boolean;
  targetStartSec: number;
  updatedAtIso: string;
  candles: Candle[];
}

function dedupeAndSortCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) {
    if (
      !c ||
      !Number.isFinite(c.time) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      continue;
    }
    map.set(Math.floor(c.time), {
      time: Math.floor(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function shortSym(symbol: string): string {
  return symbol.replace(/^frx|^cry/, '');
}

async function loadOrDownloadSymbolCandles(
  getClient: () => DerivHistoryClient,
  symbol: string,
  tfLabel: string,
  granularitySec: number,
  nowSec: number
): Promise<Candle[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = resolve(CACHE_DIR, `${symbol}_${tfLabel}.json`);

  // Strictly use existing cache file if present and non-empty (do NOT extend/download more)
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as CandleCacheFile;
      if (Array.isArray(parsed?.candles) && parsed.candles.length > 0) {
        const candles = dedupeAndSortCandles(parsed.candles);
        console.log(
          `[cache] ${shortSym(symbol)} ${tfLabel}: ${candles.length.toLocaleString('en-US')} candles loaded`
        );
        return candles;
      }
    } catch {
      // Fall through to re-download corrupt/missing cache file
    }
  }

  console.log(`[cache-missing] Downloading ~1y ${shortSym(symbol)} ${tfLabel}...`);
  const client = getClient();
  const targetStartSec = nowSec - ONE_YEAR_LOOKBACK_SEC;
  let candles: Candle[] = [];
  let endParam: string | number = 'latest';
  let page = 0;
  let complete = false;

  while (true) {
    const oldestSoFar = candles.length > 0 ? candles[0].time : nowSec;
    if (candles.length > 0 && oldestSoFar <= targetStartSec) {
      complete = true;
      break;
    }

    let resp: any;
    try {
      resp = await client.request({
        ticks_history: symbol,
        style: 'candles',
        granularity: granularitySec,
        count: PAGE_COUNT,
        end: endParam,
        adjust_start_time: 1,
      });
    } catch (err: any) {
      console.warn(
        `[WARN] ${shortSym(symbol)} ${tfLabel} page failed (${err?.message || err}); saving partial cache (${candles.length} candles).`
      );
      break;
    }

    const rawList: any[] = Array.isArray(resp?.candles) ? resp.candles : [];
    if (rawList.length === 0) {
      complete = true;
      break;
    }

    const batch: Candle[] = rawList.map((c) => ({
      time: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));

    const prevOldest = candles.length > 0 ? candles[0].time : Infinity;
    candles = dedupeAndSortCandles([...batch, ...candles]);
    const newOldest = candles.length > 0 ? candles[0].time : Infinity;
    page++;

    if (page % 5 === 0) {
      console.log(
        `  ${shortSym(symbol)} ${tfLabel}: ${candles.length.toLocaleString('en-US')} candles so far`
      );
      writeFileSync(
        cachePath,
        JSON.stringify({
          symbol,
          timeframe: tfLabel,
          granularitySec,
          complete: false,
          targetStartSec,
          updatedAtIso: new Date().toISOString(),
          candles,
        } satisfies CandleCacheFile),
        'utf8'
      );
    }

    if (newOldest >= prevOldest || newOldest <= targetStartSec) {
      complete = newOldest <= targetStartSec || rawList.length < PAGE_COUNT;
      break;
    }
    if (rawList.length < 50 && page > 1) {
      complete = true;
      break;
    }
    endParam = newOldest - 1;
  }

  candles = candles.filter((c) => c.time >= targetStartSec);
  writeFileSync(
    cachePath,
    JSON.stringify({
      symbol,
      timeframe: tfLabel,
      granularitySec,
      complete,
      targetStartSec,
      updatedAtIso: new Date().toISOString(),
      candles,
    } satisfies CandleCacheFile),
    'utf8'
  );
  console.log(
    `[cache-saved] ${shortSym(symbol)} ${tfLabel}: ${candles.length.toLocaleString('en-US')} candles`
  );
  return candles;
}

export async function loadResearchUniverseAndHistories(): Promise<{
  assets: AssetConfig[];
  histories: Map<string, Mt5SymbolHistory>;
  m5RatesMap: Map<string, Candle[]>;
  downloadedAny: boolean;
}> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const activeSymbolsCachePath = resolve(CACHE_DIR, 'active_symbols.json');

  let client: DerivHistoryClient | null = null;
  let downloadedAny = false;
  const getClient = (): DerivHistoryClient => {
    downloadedAny = true;
    if (!client) {
      client = new DerivHistoryClient(DERIV_WS_URL);
    }
    return client;
  };

  try {
    let rawSymbols: ActiveSymbolRaw[] = [];
    if (existsSync(activeSymbolsCachePath)) {
      try {
        const parsed = JSON.parse(readFileSync(activeSymbolsCachePath, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          rawSymbols = parsed as ActiveSymbolRaw[];
        }
      } catch {
        rawSymbols = [];
      }
    }

    if (rawSymbols.length === 0) {
      console.log('[cache-missing] Fetching active_symbols from Deriv WebSocket...');
      const activeResp = await getClient().request({ active_symbols: 'brief' });
      rawSymbols = Array.isArray(activeResp?.active_symbols)
        ? activeResp.active_symbols
        : [];
      if (rawSymbols.length > 0) {
        writeFileSync(activeSymbolsCachePath, JSON.stringify(rawSymbols, null, 2), 'utf8');
      }
    }

    if (rawSymbols.length === 0) {
      throw new Error('Could not load active_symbols from cache or Deriv WebSocket.');
    }

    const { mt5Assets } = selectUniverseFromActiveSymbols(rawSymbols);
    const nowSec = Math.floor(Date.now() / 1000);
    const histories = new Map<string, Mt5SymbolHistory>();
    const m5RatesMap = new Map<string, Candle[]>();

    for (const asset of mt5Assets) {
      const D1 = await loadOrDownloadSymbolCandles(getClient, asset.symbol, 'D1', 86400, nowSec);
      const H4 = await loadOrDownloadSymbolCandles(getClient, asset.symbol, 'H4', 14400, nowSec);
      const H1 = await loadOrDownloadSymbolCandles(getClient, asset.symbol, 'H1', 3600, nowSec);
      const M15 = await loadOrDownloadSymbolCandles(getClient, asset.symbol, 'M15', 900, nowSec);
      const M5 = await loadOrDownloadSymbolCandles(getClient, asset.symbol, 'M5', 300, nowSec);
      histories.set(asset.symbol, { asset, D1, H4, H1, M15, M5 });
      if (asset.type === 'FOREX') {
        m5RatesMap.set(asset.symbol, M5);
      }
    }

    return { assets: mt5Assets, histories, m5RatesMap, downloadedAny };
  } finally {
    if (client) {
      (client as DerivHistoryClient).close();
    }
  }
}

export { MT5_TIMEFRAME_SPECS };
