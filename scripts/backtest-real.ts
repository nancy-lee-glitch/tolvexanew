/**
 * scripts/backtest-real.ts — Stage 4B Walk-Forward Backtest on Real Deriv Market History
 *
 * Usage:
 *   npm run backtest:real
 *
 * Guarantees:
 *   - Uses ONLY real Deriv WebSocket history (wss://api.derivws.com/trading/v1/options/ws/public).
 *   - Zero parameter tuning, zero engine modifications, zero fabricated ticks/candles.
 *   - Strict causality: at each scan timestamp, passes ONLY candles whose bar has closed
 *     (c.time + granularitySec <= scanSec) and ticks with t.time <= scanSec.
 *   - Caches downloads to data/cache/*.json and resumes from cache when present.
 *   - Writes plain-text/markdown report to reports/backtest-YYYY-MM-DD.md and all trades
 *     to reports/trades-YYYY-MM-DD.csv.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WsLib from 'ws';
import { analyzeMT5Signal } from '../src/utils/engines/mt5Engine.ts';
import { analyzeBinarySignal, calculateBreakEvenWinRate } from '../src/utils/engines/binaryEngine.ts';
import { defaultStaleAfterMs } from '../src/services/liveFeed.ts';
import { isSyntheticAsset } from '../src/services/symbolMap.ts';
import { resolveAssetPipSpec } from '../src/utils/instrumentMeta.ts';
import type {
  BinaryExpiry,
  BinaryExpiryChoice,
  Candle,
  SignalStrength,
} from '../src/utils/engines/types.ts';
import type { AssetConfig, TimestampedTick } from '../src/types.ts';

export const DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
export const REQUEST_DELAY_MS = 400;
export const MAX_RETRIES = 5;
export const PAGE_COUNT = 5000;
export const MT5_LOOKBACK_YEARS = 5;
export const BINARY_LOOKBACK_DAYS = 14;
export const MT5_ACCOUNT_BALANCE_USD = 10_000;
export const MT5_RISK_PCT = 1.0;
export const MT5_TIMEOUT_HOURS = 48;
export const BINARY_COOLDOWN_SEC = 180;
export const BINARY_PAYOUT_DEFAULT_PCT = 85;
export const MIN_VERDICT_TRADES = 30;

const CACHE_DIR = resolve(process.cwd(), 'data/cache');
const REPORTS_DIR = resolve(process.cwd(), 'reports');

const MAJOR_FOREX_CANDIDATES = [
  'frxEURUSD',
  'frxGBPUSD',
  'frxUSDJPY',
  'frxAUDUSD',
  'frxUSDCAD',
  'frxUSDCHF',
  'frxGBPJPY',
  'frxEURJPY',
  'frxNZDUSD',
  'frxEURGBP',
];

const LARGEST_INDEX_PRIORITY = [
  'OTC_SPC',   // US 500
  'OTC_NDX',   // US Tech 100
  'OTC_DJI',   // Wall Street 30
  'OTC_GDAXI', // Germany 40
  'OTC_FTSE',  // UK 100
  'OTC_N225',  // Japan 225
  'OTC_HSI',   // Hong Kong 50
  'OTC_FCHI',  // France 40
  'OTC_SX5E',  // Euro 50
  'OTC_AS51',  // Australia 200
  'OTC_SSMI',  // Swiss 20
];

export const BINARY_SYMBOLS = [
  'frxEURUSD',
  'frxGBPUSD',
  'frxUSDJPY',
  'frxXAUUSD',
  'cryBTCUSD',
] as const;

export const MT5_TIMEFRAME_SPECS = [
  { label: 'D1', granularity: 86400 },
  { label: 'H4', granularity: 14400 },
  { label: 'H1', granularity: 3600 },
  { label: 'M15', granularity: 900 },
  { label: 'M5', granularity: 300 },
] as const;

// ============================================================================
// 1. SPREAD COST CONFIGURATION (SINGLE CONFIG OBJECT USING instrumentMeta.ts)
// ============================================================================

export interface SpreadCostEntry {
  spreadValue: number;
  unitLabel: 'pips' | 'points' | 'USD';
  pipSize: number;
  spreadPrice: number;
  decimals: number;
}

export const SPREAD_CONFIG: Record<string, SpreadCostEntry> = {
  frxEURUSD: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxEURUSD', name: 'EUR/USD', type: 'FOREX' });
    return { spreadValue: 1.0, unitLabel: 'pips', pipSize: spec.pipSize, spreadPrice: 1.0 * spec.pipSize, decimals: spec.decimals };
  })(),
  frxGBPUSD: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxGBPUSD', name: 'GBP/USD', type: 'FOREX' });
    return { spreadValue: 1.3, unitLabel: 'pips', pipSize: spec.pipSize, spreadPrice: 1.3 * spec.pipSize, decimals: spec.decimals };
  })(),
  frxUSDJPY: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxUSDJPY', name: 'USD/JPY', type: 'FOREX' });
    return { spreadValue: 1.0, unitLabel: 'pips', pipSize: spec.pipSize, spreadPrice: 1.0 * spec.pipSize, decimals: spec.decimals };
  })(),
  FOREX_OTHER_MAJOR: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX' });
    return { spreadValue: 1.5, unitLabel: 'pips', pipSize: spec.pipSize, spreadPrice: 1.5 * spec.pipSize, decimals: spec.decimals };
  })(),
  FOREX_OTHER_JPY_CROSS: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxGBPJPY', name: 'GBP/JPY', type: 'FOREX' });
    return { spreadValue: 1.5, unitLabel: 'pips', pipSize: spec.pipSize, spreadPrice: 1.5 * spec.pipSize, decimals: spec.decimals };
  })(),
  frxXAUUSD: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxXAUUSD', name: 'Gold/USD', type: 'COMMODITY' });
    return { spreadValue: 25, unitLabel: 'points', pipSize: spec.pipSize, spreadPrice: 25 * spec.pipSize, decimals: spec.decimals };
  })(),
  frxXAGUSD: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'frxXAGUSD', name: 'Silver/USD', type: 'COMMODITY' });
    return { spreadValue: 30, unitLabel: 'points', pipSize: spec.pipSize, spreadPrice: 30 * spec.pipSize, decimals: spec.decimals };
  })(),
  cryBTCUSD: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'cryBTCUSD', name: 'BTC/USD', type: 'CRYPTO' });
    return { spreadValue: 20, unitLabel: 'USD', pipSize: spec.pipSize, spreadPrice: 20, decimals: spec.decimals };
  })(),
  cryETHUSD: (() => {
    const spec = resolveAssetPipSpec({ symbol: 'cryETHUSD', name: 'ETH/USD', type: 'CRYPTO' });
    return { spreadValue: 2, unitLabel: 'USD', pipSize: spec.pipSize, spreadPrice: 2, decimals: spec.decimals };
  })(),
  INDEX_DEFAULT: {
    spreadValue: 1.5,
    unitLabel: 'points',
    pipSize: 1.0,
    spreadPrice: 1.5,
    decimals: 2,
  },
};

export function resolveSpreadCostForAsset(asset: AssetConfig): SpreadCostEntry {
  const exact = SPREAD_CONFIG[asset.symbol];
  if (exact) return exact;
  if (asset.type === 'FOREX') {
    const spec = resolveAssetPipSpec(asset);
    const isJpy = spec.pipSize >= 0.01;
    const base = isJpy ? SPREAD_CONFIG.FOREX_OTHER_JPY_CROSS : SPREAD_CONFIG.FOREX_OTHER_MAJOR;
    return {
      ...base,
      pipSize: spec.pipSize,
      spreadPrice: 1.5 * spec.pipSize,
      decimals: spec.decimals,
    };
  }
  if (asset.type === 'INDEX') {
    return {
      ...SPREAD_CONFIG.INDEX_DEFAULT,
      decimals: asset.decimals || 2,
    };
  }
  const spec = resolveAssetPipSpec(asset);
  return {
    spreadValue: 1.5,
    unitLabel: 'points',
    pipSize: spec.pipSize,
    spreadPrice: 1.5 * spec.pipSize,
    decimals: spec.decimals,
  };
}

// ============================================================================
// 2. DERIV WEBSOCKET HISTORY CLIENT & RESUMABLE CACHE
// ============================================================================

export interface ActiveSymbolRaw {
  symbol?: string;
  underlying_symbol?: string;
  display_name?: string;
  underlying_symbol_name?: string;
  market?: string;
  submarket?: string;
  pip?: number;
  pip_size?: number;
  pip_value?: number;
  exchange_is_open?: number | boolean;
  is_trading_suspended?: number | boolean;
}

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

function createWs(url: string): WsLike {
  if (typeof globalThis.WebSocket === 'function') {
    return new globalThis.WebSocket(url) as unknown as WsLike;
  }
  return new WsLib(url) as unknown as WsLike;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deriveDecimalsFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const s = step.toString();
  if (s.includes('e-')) {
    const exp = parseInt(s.split('e-')[1], 10);
    return Number.isFinite(exp) ? exp : 2;
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export class DerivHistoryClient {
  private url: string;
  private ws: WsLike | null = null;
  private reqId = 0;
  private lastRequestMs = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(url = DERIV_WS_URL) {
    this.url = url;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;
    this.closeSocket();
    await new Promise<void>((resolveConn, rejectConn) => {
      let settled = false;
      const ws = createWs(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closeSocket();
        rejectConn(new Error('WebSocket connect timeout (15s)'));
      }, 15_000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveConn();
      };
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        const id = Number(parsed?.req_id);
        if (!Number.isFinite(id)) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (parsed.error) {
          const code = parsed.error.code || 'DerivError';
          const message = parsed.error.message || 'Unknown Deriv error';
          entry.reject(Object.assign(new Error(`${code}: ${message}`), { code }));
        } else {
          entry.resolve(parsed);
        }
      };
      ws.onerror = () => {
        // onclose handles cleanup
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectConn(new Error('WebSocket closed before opening'));
        }
        this.rejectAllPending('WebSocket disconnected');
        if (this.ws === ws) this.ws = null;
      };
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // ignore
    }
    this.rejectAllPending('Socket closed');
  }

  async request(payload: Record<string, unknown>, timeoutMs = 25_000): Promise<any> {
    let lastError: Error = new Error('Request failed');
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const waitMs = Math.max(0, REQUEST_DELAY_MS - (Date.now() - this.lastRequestMs));
      if (waitMs > 0) await sleep(waitMs);

      try {
        await this.ensureConnected();
        const id = ++this.reqId;
        this.lastRequestMs = Date.now();
        const res = await new Promise<any>((resFn, rejFn) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            rejFn(new Error(`Request ${id} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          this.pending.set(id, { resolve: resFn, reject: rejFn, timer });
          this.ws!.send(JSON.stringify({ ...payload, req_id: id }));
        });
        return res;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const code = String(err?.code || '');
        if (code === 'InvalidSymbol' || code === 'InputValidationFailed') {
          throw lastError;
        }
        this.closeSocket();
        if (attempt < MAX_RETRIES) {
          await sleep(500 * attempt);
        }
      }
    }
    throw lastError;
  }

  close(): void {
    this.closeSocket();
  }
}

export function selectUniverseFromActiveSymbols(rawSymbols: ActiveSymbolRaw[]): {
  mt5Assets: AssetConfig[];
  binaryAssets: AssetConfig[];
  activeIndexBugNotes: string[];
} {
  const bySymbol = new Map<string, ActiveSymbolRaw>();
  for (const item of rawSymbols) {
    if (!item || typeof item !== 'object') continue;
    const sym = String(item.underlying_symbol ?? item.symbol ?? '').trim();
    if (!sym) continue;
    const market = String(item.market ?? '').toLowerCase();
    if (market === 'synthetic_index' || isSyntheticAsset({ symbol: sym, market })) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, item);
  }

  const toAssetConfig = (raw: ActiveSymbolRaw): AssetConfig => {
    const sym = String(raw.underlying_symbol ?? raw.symbol ?? '').trim();
    const display = String(raw.underlying_symbol_name ?? raw.display_name ?? sym).trim();
    const market = String(raw.market ?? '').toLowerCase();
    const rawStep = Number(raw.pip ?? raw.pip_size ?? raw.pip_value);
    const tickSize = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 0.0001;
    const decimals = deriveDecimalsFromStep(tickSize);
    let type: AssetConfig['type'] = 'FOREX';
    if (market === 'indices' || market === 'index') type = 'INDEX';
    else if (market === 'commodities' || market === 'commodity') type = 'COMMODITY';
    else if (market === 'cryptocurrency' || market === 'crypto') type = 'CRYPTO';
    else if (market === 'stocks' || market === 'stock') type = 'STOCK';

    const spec = resolveAssetPipSpec({
      symbol: sym,
      name: display,
      type,
      market,
      decimals,
      tickSize,
      pipSize: type === 'FOREX' ? undefined : tickSize,
    });
    return {
      symbol: sym,
      name: display,
      type,
      decimals: spec.decimals,
      pipSize: spec.pipSize,
      tickSize: spec.tickSize,
      distanceUnit: spec.distanceUnit,
    };
  };

  const mt5Assets: AssetConfig[] = [];
  const chosen = new Set<string>();

  // 8 major forex pairs
  let fxCount = 0;
  for (const fx of MAJOR_FOREX_CANDIDATES) {
    if (fxCount >= 8) break;
    const raw = bySymbol.get(fx);
    if (raw) {
      mt5Assets.push(toAssetConfig(raw));
      chosen.add(fx);
      fxCount++;
    }
  }
  if (fxCount < 8) {
    for (const [sym, raw] of bySymbol.entries()) {
      if (fxCount >= 8) break;
      if (chosen.has(sym)) continue;
      if (String(raw.market ?? '').toLowerCase() === 'forex' && sym.startsWith('frx')) {
        mt5Assets.push(toAssetConfig(raw));
        chosen.add(sym);
        fxCount++;
      }
    }
  }

  // Metals: frxXAUUSD and frxXAGUSD if present
  for (const metal of ['frxXAUUSD', 'frxXAGUSD']) {
    const raw = bySymbol.get(metal);
    if (raw && !chosen.has(metal)) {
      mt5Assets.push(toAssetConfig(raw));
      chosen.add(metal);
    }
  }

  // Crypto: cryBTCUSD, cryETHUSD
  for (const crypto of ['cryBTCUSD', 'cryETHUSD']) {
    const raw = bySymbol.get(crypto);
    if (raw && !chosen.has(crypto)) {
      mt5Assets.push(toAssetConfig(raw));
      chosen.add(crypto);
    }
  }

  // 3 largest non-synthetic indices present
  let idxCount = 0;
  for (const idxSym of LARGEST_INDEX_PRIORITY) {
    if (idxCount >= 3) break;
    const raw = bySymbol.get(idxSym);
    if (raw && !chosen.has(idxSym)) {
      mt5Assets.push(toAssetConfig(raw));
      chosen.add(idxSym);
      idxCount++;
    }
  }
  if (idxCount < 3) {
    for (const [sym, raw] of bySymbol.entries()) {
      if (idxCount >= 3) break;
      if (chosen.has(sym)) continue;
      const market = String(raw.market ?? '').toLowerCase();
      if (market === 'indices' || market === 'index') {
        mt5Assets.push(toAssetConfig(raw));
        chosen.add(sym);
        idxCount++;
      }
    }
  }

  const binaryAssets: AssetConfig[] = [];
  for (const bSym of BINARY_SYMBOLS) {
    const raw = bySymbol.get(bSym);
    if (raw) binaryAssets.push(toAssetConfig(raw));
  }

  const activeIndexBugNotes: string[] = [];
  if (mt5Assets.some((a) => a.symbol.toUpperCase() === 'FRXAUDUSD')) {
    const audSpec = resolveAssetPipSpec({ symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX' });
    if (audSpec.pipSize !== 0.0001) {
      activeIndexBugNotes.push(
        `frxAUDUSD resolved unexpected pipSize=${audSpec.pipSize} instead of 0.0001.`
      );
    }
  }

  return { mt5Assets, binaryAssets, activeIndexBugNotes };
}

interface CandleCacheFile {
  symbol: string;
  timeframe: string;
  granularitySec: number;
  complete: boolean;
  targetStartSec: number;
  updatedAtIso: string;
  candles: Candle[];
}

interface TickCacheFile {
  symbol: string;
  complete: boolean;
  targetStartSec: number;
  updatedAtIso: string;
  ticks: TimestampedTick[];
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

function dedupeAndSortTicks(ticks: TimestampedTick[]): TimestampedTick[] {
  const map = new Map<number, TimestampedTick>();
  for (const t of ticks) {
    if (!t || !Number.isFinite(t.time) || !Number.isFinite(t.price)) continue;
    map.set(Math.floor(t.time), { time: Math.floor(t.time), price: t.price });
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function shortSym(symbol: string): string {
  return symbol.replace(/^frx|^cry/, '');
}

async function fetchCandlesWithCache(
  client: DerivHistoryClient,
  symbol: string,
  tfLabel: string,
  granularitySec: number,
  nowSec: number
): Promise<Candle[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = resolve(CACHE_DIR, `${symbol}_${tfLabel}.json`);
  const targetStartSec = nowSec - MT5_LOOKBACK_YEARS * 365 * 86400;

  let cached: CandleCacheFile | null = null;
  if (existsSync(cachePath)) {
    try {
      cached = JSON.parse(readFileSync(cachePath, 'utf8')) as CandleCacheFile;
    } catch {
      cached = null;
    }
  }

  let candles = cached?.candles ? dedupeAndSortCandles(cached.candles) : [];
  if (cached?.complete && candles.length > 0) {
    console.log(
      `${shortSym(symbol)} ${tfLabel}: ${candles.length.toLocaleString('en-US')} candles loaded from cache`
    );
    return candles;
  }

  let endParam: string | number = candles.length > 0 ? candles[0].time - 1 : 'latest';
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

    console.log(
      `${shortSym(symbol)} ${tfLabel}: ${candles.length.toLocaleString('en-US')} candles so far`
    );

    if (page % 5 === 0) {
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
      // Reached broker history boundary when fewer than a full batch came back
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
  return candles;
}

async function fetchTicks14dWithCache(
  client: DerivHistoryClient,
  symbol: string,
  nowSec: number
): Promise<TimestampedTick[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = resolve(CACHE_DIR, `${symbol}_TICKS_14D.json`);
  const targetStartSec = nowSec - BINARY_LOOKBACK_DAYS * 86400;

  let cached: TickCacheFile | null = null;
  if (existsSync(cachePath)) {
    try {
      cached = JSON.parse(readFileSync(cachePath, 'utf8')) as TickCacheFile;
    } catch {
      cached = null;
    }
  }

  let ticks = cached?.ticks ? dedupeAndSortTicks(cached.ticks) : [];
  if (cached?.complete && ticks.length > 0) {
    console.log(
      `${shortSym(symbol)} TICKS: ${ticks.length.toLocaleString('en-US')} ticks loaded from cache`
    );
    return ticks;
  }

  let endParam: string | number = ticks.length > 0 ? ticks[0].time - 1 : 'latest';
  let page = 0;
  let complete = false;

  while (true) {
    const oldestSoFar = ticks.length > 0 ? ticks[0].time : nowSec;
    if (ticks.length > 0 && oldestSoFar <= targetStartSec) {
      complete = true;
      break;
    }

    let resp: any;
    try {
      resp = await client.request({
        ticks_history: symbol,
        style: 'ticks',
        count: PAGE_COUNT,
        end: endParam,
        adjust_start_time: 1,
      });
    } catch (err: any) {
      console.warn(
        `[WARN] ${shortSym(symbol)} TICKS page failed (${err?.message || err}); saving partial cache (${ticks.length} ticks).`
      );
      break;
    }

    const prices: number[] = Array.isArray(resp?.history?.prices) ? resp.history.prices : [];
    const times: number[] = Array.isArray(resp?.history?.times) ? resp.history.times : [];
    if (prices.length === 0 || times.length === 0) {
      complete = true;
      break;
    }

    const batch: TimestampedTick[] = [];
    const len = Math.min(prices.length, times.length);
    for (let i = 0; i < len; i++) {
      batch.push({ time: Number(times[i]), price: Number(prices[i]) });
    }

    const prevOldest = ticks.length > 0 ? ticks[0].time : Infinity;
    ticks = dedupeAndSortTicks([...batch, ...ticks]);
    const newOldest = ticks.length > 0 ? ticks[0].time : Infinity;
    page++;

    if (page % 5 === 0 || newOldest <= targetStartSec) {
      const coveredDays = Math.min(
        BINARY_LOOKBACK_DAYS,
        Math.max(0, (nowSec - newOldest) / 86400)
      );
      console.log(
        `${shortSym(symbol)} TICKS: ${ticks.length.toLocaleString('en-US')} ticks so far (${coveredDays.toFixed(1)}/${BINARY_LOOKBACK_DAYS} days)`
      );
    }

    if (page % 10 === 0) {
      writeFileSync(
        cachePath,
        JSON.stringify({
          symbol,
          complete: false,
          targetStartSec,
          updatedAtIso: new Date().toISOString(),
          ticks,
        } satisfies TickCacheFile),
        'utf8'
      );
    }

    if (newOldest >= prevOldest || newOldest <= targetStartSec) {
      complete = newOldest <= targetStartSec || len < PAGE_COUNT;
      break;
    }
    if (len < 100 && page > 1) {
      complete = true;
      break;
    }
    endParam = newOldest - 1;
  }

  ticks = ticks.filter((t) => t.time >= targetStartSec);
  writeFileSync(
    cachePath,
    JSON.stringify({
      symbol,
      complete,
      targetStartSec,
      updatedAtIso: new Date().toISOString(),
      ticks,
    } satisfies TickCacheFile),
    'utf8'
  );
  return ticks;
}

// ============================================================================
// 3. STATISTICAL HELPERS (95% CI, DRAWDOWN, STREAK, WILSON SCORE)
// ============================================================================

/**
 * Two-sided 95% Student-t critical value for df = n - 1.
 */
export function getTCritical95(df: number): number {
  if (df <= 0) return 1.96;
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000, 120: 1.980,
  };
  if (table[df]) return table[df];
  if (df > 120) return 1.96;
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i++) {
    if (df < keys[i]) {
      const k0 = keys[i - 1];
      const k1 = keys[i];
      const t = (df - k0) / (k1 - k0);
      return table[k0] + t * (table[k1] - table[k0]);
    }
  }
  return 1.96;
}

export interface Mt5PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  longestLosingStreak: number;
  ci95LowR: number | null;
  ci95HighR: number | null;
  verdict: 'not enough trades' | 'positive and significant' | 'positive but not significant' | 'zero' | 'negative';
}

export function computeMt5Stats(rValues: number[]): Mt5PerformanceStats {
  const n = rValues.length;
  if (n === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      avgR: 0,
      totalR: 0,
      maxDrawdownR: 0,
      longestLosingStreak: 0,
      ci95LowR: null,
      ci95HighR: null,
      verdict: 'not enough trades',
    };
  }

  let wins = 0;
  let totalR = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDd = 0;
  let streak = 0;
  let longestStreak = 0;

  for (const r of rValues) {
    totalR += r;
    if (r > 0) {
      wins++;
      streak = 0;
    } else {
      streak++;
      if (streak > longestStreak) longestStreak = streak;
    }
    cumR += r;
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDd) maxDd = dd;
  }

  const avgR = totalR / n;
  let ci95LowR: number | null = null;
  let ci95HighR: number | null = null;
  if (n >= 2) {
    let sqDiff = 0;
    for (const r of rValues) {
      sqDiff += (r - avgR) * (r - avgR);
    }
    const sd = Math.sqrt(sqDiff / (n - 1));
    const se = sd / Math.sqrt(n);
    const tCrit = getTCritical95(n - 1);
    ci95LowR = avgR - tCrit * se;
    ci95HighR = avgR + tCrit * se;
  }

  let verdict: Mt5PerformanceStats['verdict'] = 'not enough trades';
  if (n >= MIN_VERDICT_TRADES) {
    if (Math.abs(avgR) < 1e-9) {
      verdict = 'zero';
    } else if (avgR < 0) {
      verdict = 'negative';
    } else if (ci95LowR !== null && ci95LowR > 0) {
      verdict = 'positive and significant';
    } else {
      verdict = 'positive but not significant';
    }
  }

  return {
    trades: n,
    wins,
    losses: n - wins,
    winRatePct: parseFloat(((wins / n) * 100).toFixed(2)),
    avgR,
    totalR,
    maxDrawdownR: maxDd,
    longestLosingStreak: longestStreak,
    ci95LowR,
    ci95HighR,
    verdict,
  };
}

export interface BinaryWinRateStats {
  sampleSize: number;
  wins: number;
  losses: number;
  winRatePct: number;
  ciLowerPct: number;
  ciUpperPct: number;
  notEnoughTrades: boolean;
  beats80: boolean;
  beats85: boolean;
  beats90: boolean;
}

export function computeWilson95(wins: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const z = 1.96;
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return [
    parseFloat((Math.max(0, center - margin) * 100).toFixed(2)),
    parseFloat((Math.min(1, center + margin) * 100).toFixed(2)),
  ];
}

export function computeBinaryStats(outcomes: boolean[]): BinaryWinRateStats {
  const n = outcomes.length;
  let wins = 0;
  for (const w of outcomes) {
    if (w) wins++;
  }
  const winRatePct = n > 0 ? parseFloat(((wins / n) * 100).toFixed(2)) : 0;
  const [ciLowerPct, ciUpperPct] = computeWilson95(wins, n);
  const notEnoughTrades = n < MIN_VERDICT_TRADES;
  const be80 = calculateBreakEvenWinRate(80);
  const be85 = calculateBreakEvenWinRate(85);
  const be90 = calculateBreakEvenWinRate(90);
  return {
    sampleSize: n,
    wins,
    losses: n - wins,
    winRatePct,
    ciLowerPct,
    ciUpperPct,
    notEnoughTrades,
    beats80: !notEnoughTrades && ciLowerPct > be80,
    beats85: !notEnoughTrades && ciLowerPct > be85,
    beats90: !notEnoughTrades && ciLowerPct > be90,
  };
}

// ============================================================================
// 4. MT5 WALK-FORWARD SIMULATION
// ============================================================================

export interface SimulatedMt5Trade {
  entryTimeSec: number;
  exitTimeSec: number;
  timeIso: string;
  symbol: string;
  structureTimeframe: 'M15' | 'H1';
  direction: 'BUY' | 'SELL';
  orderKind: 'MARKET' | 'LIMIT';
  strength: SignalStrength;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  rewardRiskTp1: number;
  outcome: 'WIN' | 'LOSS';
  exitReason: 'TP1' | 'SL' | 'TIMEOUT_48H';
  grossR: number;
  costR: number;
  netR: number;
}

export interface Mt5SymbolHistory {
  asset: AssetConfig;
  D1: Candle[];
  H4: Candle[];
  H1: Candle[];
  M15: Candle[];
  M5: Candle[];
}

export interface Mt5WalkForwardResult {
  trades: SimulatedMt5Trade[];
  unfilledLimitCount: number;
  skippedSmallLotCount: number;
  otcBlockedScans: number;
  startSec: number;
  endSec: number;
  splitSec: number;
}

/**
 * Resolves a filled MT5 trade against subsequent M5 candles.
 * - Conservative: if SL and TP1 both fall inside the same M5 candle, counts SL first.
 * - Unresolved after 48 hours: closed at market price (close of M5 bar at or just before +48h).
 * - Returns null only if the dataset ends before SL/TP1/48h can be checked.
 */
export function resolveMt5TradeOnM5(params: {
  direction: 'BUY' | 'SELL';
  orderKind: 'MARKET' | 'LIMIT';
  signalTimeSec: number;
  validUntilSec: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  rewardRiskTp1: number;
  spreadPrice: number;
  m5Candles: Candle[];
  startIdx: number;
}):
  | { status: 'UNFILLED_LIMIT'; resolvedAtSec: number }
  | { status: 'INCOMPLETE_DATA' }
  | {
      status: 'FILLED';
      entryTimeSec: number;
      exitTimeSec: number;
      outcome: 'WIN' | 'LOSS';
      exitReason: 'TP1' | 'SL' | 'TIMEOUT_48H';
      grossR: number;
      costR: number;
      netR: number;
    } {
  const {
    direction,
    orderKind,
    signalTimeSec,
    validUntilSec,
    entryPrice,
    stopLoss,
    takeProfit1,
    rewardRiskTp1,
    spreadPrice,
    m5Candles,
    startIdx,
  } = params;

  const slDistance = Math.abs(entryPrice - stopLoss);
  if (!(slDistance > 0)) {
    return { status: 'INCOMPLETE_DATA' };
  }

  let fillIdx = startIdx;
  let fillTimeSec = signalTimeSec;

  if (orderKind === 'LIMIT') {
    let foundFill = false;
    for (let i = startIdx; i < m5Candles.length; i++) {
      const c = m5Candles[i];
      if (c.time + 300 <= signalTimeSec) continue;
      if (c.time >= validUntilSec) break;
      const touched =
        direction === 'BUY' ? c.low <= entryPrice : c.high >= entryPrice;
      if (touched) {
        fillIdx = i;
        fillTimeSec = c.time;
        foundFill = true;
        break;
      }
    }
    if (!foundFill) {
      return { status: 'UNFILLED_LIMIT', resolvedAtSec: validUntilSec };
    }
  }

  const deadlineSec = fillTimeSec + MT5_TIMEOUT_HOURS * 3600;
  let lastCandleBeforeDeadline: Candle | null = null;

  for (let i = fillIdx; i < m5Candles.length; i++) {
    const c = m5Candles[i];
    if (c.time + 300 <= signalTimeSec) continue;
    if (c.time >= deadlineSec) {
      break;
    }
    lastCandleBeforeDeadline = c;

    const slHit = direction === 'BUY' ? c.low <= stopLoss : c.high >= stopLoss;
    const tpHit = direction === 'BUY' ? c.high >= takeProfit1 : c.low <= takeProfit1;

    // Conservative tie-breaker: if SL and TP1 fall inside one candle, SL is counted first
    if (slHit) {
      const grossR = -1.0;
      const costR = spreadPrice / slDistance;
      const netR = grossR - costR;
      return {
        status: 'FILLED',
        entryTimeSec: fillTimeSec,
        exitTimeSec: c.time + 300,
        outcome: netR > 0 ? 'WIN' : 'LOSS',
        exitReason: 'SL',
        grossR,
        costR,
        netR,
      };
    }

    if (tpHit) {
      const grossR = rewardRiskTp1;
      const costR = spreadPrice / slDistance;
      const netR = grossR - costR;
      return {
        status: 'FILLED',
        entryTimeSec: fillTimeSec,
        exitTimeSec: c.time + 300,
        outcome: netR > 0 ? 'WIN' : 'LOSS',
        exitReason: 'TP1',
        grossR,
        costR,
        netR,
      };
    }
  }

  const lastBarAvailable = m5Candles.length > 0 ? m5Candles[m5Candles.length - 1] : null;
  if (!lastCandleBeforeDeadline || !lastBarAvailable || lastBarAvailable.time + 300 < deadlineSec) {
    return { status: 'INCOMPLETE_DATA' };
  }

  const exitClose = lastCandleBeforeDeadline.close;
  const rawMove = direction === 'BUY' ? exitClose - entryPrice : entryPrice - exitClose;
  const grossR = rawMove / slDistance;
  const costR = spreadPrice / slDistance;
  const netR = grossR - costR;

  return {
    status: 'FILLED',
    entryTimeSec: fillTimeSec,
    exitTimeSec: deadlineSec,
    outcome: netR > 0 ? 'WIN' : 'LOSS',
    exitReason: 'TIMEOUT_48H',
    grossR,
    costR,
    netR,
  };
}

function advanceClosedIndex(candles: Candle[], currentIdx: number, scanSec: number, granularitySec: number): number {
  let idx = currentIdx;
  while (idx < candles.length && candles[idx].time + granularitySec <= scanSec) {
    idx++;
  }
  return idx;
}

export function buildConversionRatesAtTime(
  ratesHistory: Map<string, Candle[]>,
  cursors: Map<string, number>,
  scanSec: number
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, bars] of ratesHistory.entries()) {
    const prevIdx = cursors.get(sym) ?? 0;
    const nextIdx = advanceClosedIndex(bars, prevIdx, scanSec, 300);
    cursors.set(sym, nextIdx);
    if (nextIdx > 0) {
      out[sym] = bars[nextIdx - 1].close;
    }
  }
  return out;
}

export function runMt5WalkForwardForSymbol(params: {
  history: Mt5SymbolHistory;
  structureTimeframe: 'M15' | 'H1';
  ratesHistory?: Map<string, Candle[]>;
}): Mt5WalkForwardResult {
  const { history, structureTimeframe, ratesHistory = new Map() } = params;
  const { asset, D1, H4, H1, M15, M5 } = history;
  const spread = resolveSpreadCostForAsset(asset);

  if (D1.length < 5 || H4.length < 15 || H1.length < 25 || M15.length < 25 || M5.length < 50) {
    return {
      trades: [],
      unfilledLimitCount: 0,
      skippedSmallLotCount: 0,
      otcBlockedScans: 0,
      startSec: 0,
      endSec: 0,
      splitSec: 0,
    };
  }

  const startSec = Math.max(
    D1[2].time + 86400,
    H4[12].time + 14400,
    H1[22].time + 3600,
    M15[22].time + 900,
    M5[22].time + 300
  );
  const endSec = M5[M5.length - 1].time + 300;
  const splitSec = Math.floor(startSec + 0.6 * Math.max(0, endSec - startSec));

  // Align scan start to next 30-minute boundary
  const firstScanSec = Math.ceil(startSec / 1800) * 1800;

  let d1Idx = 0;
  let h4Idx = 0;
  let h1Idx = 0;
  let m15Idx = 0;
  let m5Idx = 0;
  const rateCursors = new Map<string, number>();

  let busyUntilSec = 0;
  let unfilledLimitCount = 0;
  let skippedSmallLotCount = 0;
  let otcBlockedScans = 0;
  const trades: SimulatedMt5Trade[] = [];

  for (let scanSec = firstScanSec; scanSec <= endSec; scanSec += 1800) {
    if (scanSec < busyUntilSec) continue;

    const d = new Date(scanSec * 1000);
    const utcDay = d.getUTCDay();
    const utcHour = d.getUTCHours();
    // Weekdays 07:00-16:59 UTC
    if (utcDay === 0 || utcDay === 6 || utcHour < 7 || utcHour >= 17) {
      continue;
    }

    d1Idx = advanceClosedIndex(D1, d1Idx, scanSec, 86400);
    h4Idx = advanceClosedIndex(H4, h4Idx, scanSec, 14400);
    h1Idx = advanceClosedIndex(H1, h1Idx, scanSec, 3600);
    m15Idx = advanceClosedIndex(M15, m15Idx, scanSec, 900);
    m5Idx = advanceClosedIndex(M5, m5Idx, scanSec, 300);

    if (d1Idx < 2 || h4Idx < 10 || h1Idx < 20 || m15Idx < 20 || m5Idx < 20) {
      continue;
    }

    const conversionRates = buildConversionRatesAtTime(ratesHistory, rateCursors, scanSec);

    const signal = analyzeMT5Signal({
      asset,
      platform: 'mt5',
      platformName: 'MetaTrader 5',
      d1Candles: D1.slice(Math.max(0, d1Idx - 250), d1Idx),
      h4Candles: H4.slice(Math.max(0, h4Idx - 250), h4Idx),
      h1Candles: H1.slice(Math.max(0, h1Idx - 250), h1Idx),
      m15Candles: M15.slice(Math.max(0, m15Idx - 250), m15Idx),
      m5Candles: M5.slice(Math.max(0, m5Idx - 250), m5Idx),
      structureTimeframe,
      feedStatus: 'LIVE',
      accountCurrency: 'USD',
      accountBalance: MT5_ACCOUNT_BALANCE_USD,
      riskPct: MT5_RISK_PCT,
      spreadPrice: spread.spreadPrice,
      conversionRates,
      nowMs: scanSec * 1000,
    });

    if (signal.direction === 'WAIT') {
      if (signal.inputsSnapshot?.blocker === 'OTC') {
        otcBlockedScans++;
      }
      continue;
    }

    if (
      signal.stopLoss === null ||
      signal.takeProfit1 === null ||
      signal.rewardRiskTp1 === null
    ) {
      continue;
    }

    if (signal.lotSize <= 0) {
      skippedSmallLotCount++;
      continue;
    }

    const resolution = resolveMt5TradeOnM5({
      direction: signal.direction,
      orderKind: signal.orderKind,
      signalTimeSec: scanSec,
      validUntilSec: scanSec + signal.validityMinutes * 60,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit1: signal.takeProfit1,
      rewardRiskTp1: signal.rewardRiskTp1,
      spreadPrice: spread.spreadPrice,
      m5Candles: M5,
      startIdx: m5Idx,
    });

    if (resolution.status === 'UNFILLED_LIMIT') {
      unfilledLimitCount++;
      busyUntilSec = resolution.resolvedAtSec;
      continue;
    }
    if (resolution.status === 'INCOMPLETE_DATA') {
      continue;
    }

    busyUntilSec = resolution.exitTimeSec;
    trades.push({
      entryTimeSec: resolution.entryTimeSec,
      exitTimeSec: resolution.exitTimeSec,
      timeIso: new Date(resolution.entryTimeSec * 1000).toISOString(),
      symbol: asset.symbol,
      structureTimeframe,
      direction: signal.direction,
      orderKind: signal.orderKind,
      strength: signal.strength,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit1: signal.takeProfit1,
      rewardRiskTp1: signal.rewardRiskTp1,
      outcome: resolution.outcome,
      exitReason: resolution.exitReason,
      grossR: resolution.grossR,
      costR: resolution.costR,
      netR: resolution.netR,
    });
  }

  return {
    trades,
    unfilledLimitCount,
    skippedSmallLotCount,
    otcBlockedScans,
    startSec,
    endSec,
    splitSec,
  };
}

// ============================================================================
// 5. BINARY WALK-FORWARD SIMULATION (REAL TICKS -> M1/M5/M15 CANDLES)
// ============================================================================

export function buildCandlesUpToBucket(
  ticks: TimestampedTick[],
  granularitySec: number
): Candle[] {
  if (ticks.length === 0) return [];
  const candles: Candle[] = [];
  let curBucket = -1;
  let bar: Candle | null = null;

  for (const t of ticks) {
    const b = Math.floor(t.time / granularitySec) * granularitySec;
    if (b !== curBucket) {
      if (bar) candles.push(bar);
      curBucket = b;
      bar = { time: b, open: t.price, high: t.price, low: t.price, close: t.price };
    } else if (bar) {
      if (t.price > bar.high) bar.high = t.price;
      if (t.price < bar.low) bar.low = t.price;
      bar.close = t.price;
    }
  }
  if (bar) candles.push(bar);
  return candles;
}

export function findLastTickAtOrBefore(ticks: TimestampedTick[], targetSec: number): TimestampedTick | null {
  if (ticks.length === 0) return null;
  let lo = 0;
  let hi = ticks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].time <= targetSec) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? ticks[best] : null;
}

export interface SimulatedBinarySignal {
  entryTimeSec: number;
  timeIso: string;
  symbol: string;
  mode: BinaryExpiryChoice;
  chosenExpiry: BinaryExpiry;
  direction: 'CALL' | 'PUT';
  strength: SignalStrength;
  entryPrice: number;
  outcomesByHorizon: Record<BinaryExpiry, boolean | null>;
}

const ALL_FIXED_EXPIRIES: Array<{ key: BinaryExpiry; sec: number }> = [
  { key: '1m', sec: 60 },
  { key: '2m', sec: 120 },
  { key: '3m', sec: 180 },
  { key: '5m', sec: 300 },
];

export function runBinaryWalkForwardForSymbol(params: {
  asset: AssetConfig;
  ticks: TimestampedTick[];
  modes?: BinaryExpiryChoice[];
}): {
  signals: SimulatedBinarySignal[];
  startSec: number;
  endSec: number;
} {
  const {
    asset,
    ticks,
    modes = ['1m', '2m', '3m', '5m', 'auto'],
  } = params;

  if (ticks.length < 100) {
    return { signals: [], startSec: 0, endSec: 0 };
  }

  const m1All = buildCandlesUpToBucket(ticks, 60);
  const m5All = buildCandlesUpToBucket(ticks, 300);
  const m15All = buildCandlesUpToBucket(ticks, 900);

  if (m1All.length < 25 || m15All.length < 15) {
    return { signals: [], startSec: 0, endSec: 0 };
  }

  const firstTickSec = ticks[0].time;
  const lastTickSec = ticks[ticks.length - 1].time;
  const startSec = Math.max(firstTickSec + 60, m15All[14].time + 900, m1All[24].time + 60);
  // Offset by +5s (:05, :20, :35, :50) so 15s scans clear the 4s M1 open/close reset gate
  const firstScanSec = Math.ceil((startSec - 5) / 15) * 15 + 5;
  const staleLimitMs = defaultStaleAfterMs(asset.symbol);

  let m1Idx = 0;
  let m5Idx = 0;
  let m15Idx = 0;
  let tickEndIdx = 0;
  let tickStart60Idx = 0;

  const lastSignalByMode = new Map<BinaryExpiryChoice, number>();
  for (const m of modes) lastSignalByMode.set(m, -Infinity);

  const signals: SimulatedBinarySignal[] = [];

  for (let scanSec = firstScanSec; scanSec <= lastTickSec; scanSec += 15) {
    const d = new Date(scanSec * 1000);
    const utcDay = d.getUTCDay();
    const utcHour = d.getUTCHours();
    // Weekdays 07:00-16:59 UTC
    if (utcDay === 0 || utcDay === 6 || utcHour < 7 || utcHour >= 17) {
      continue;
    }

    m1Idx = advanceClosedIndex(m1All, m1Idx, scanSec, 60);
    m5Idx = advanceClosedIndex(m5All, m5Idx, scanSec, 300);
    m15Idx = advanceClosedIndex(m15All, m15Idx, scanSec, 900);

    while (tickEndIdx < ticks.length && ticks[tickEndIdx].time <= scanSec) {
      tickEndIdx++;
    }
    const cutoff60 = scanSec - 60;
    while (tickStart60Idx < tickEndIdx && ticks[tickStart60Idx].time < cutoff60) {
      tickStart60Idx++;
    }

    if (m1Idx < 25 || m15Idx < 15 || tickEndIdx - tickStart60Idx < 5) {
      continue;
    }

    const latestTick = ticks[tickEndIdx - 1];
    const ageMs = (scanSec - latestTick.time) * 1000;
    const feedStatus = ageMs <= staleLimitMs ? 'LIVE' : 'DELAYED';
    if (feedStatus !== 'LIVE') continue;

    const m1Slice = m1All.slice(Math.max(0, m1Idx - 120), m1Idx);
    const m5Slice = m5All.slice(Math.max(0, m5Idx - 80), m5Idx);
    const m15Slice = m15All.slice(Math.max(0, m15Idx - 80), m15Idx);
    const tickSlice = ticks.slice(tickStart60Idx, tickEndIdx);

    for (const mode of modes) {
      const prevLogged = lastSignalByMode.get(mode) ?? -Infinity;
      if (scanSec - prevLogged < BINARY_COOLDOWN_SEC) {
        continue;
      }

      const signal = analyzeBinarySignal({
        asset,
        platform: 'deriv',
        platformName: 'Deriv',
        m1Candles: m1Slice,
        m5Candles: m5Slice,
        m15Candles: m15Slice,
        ticks: tickSlice,
        feedStatus: 'LIVE',
        payoutPct: BINARY_PAYOUT_DEFAULT_PCT,
        preferredExpiry: mode,
        nowMs: scanSec * 1000,
      });

      if (signal.direction === 'WAIT') continue;

      const outcomesByHorizon: Record<BinaryExpiry, boolean | null> = {
        '1m': null,
        '2m': null,
        '3m': null,
        '5m': null,
      };

      for (const h of ALL_FIXED_EXPIRIES) {
        const expSec = scanSec + h.sec;
        if (expSec > lastTickSec) {
          outcomesByHorizon[h.key] = null;
          continue;
        }
        const exitTick = findLastTickAtOrBefore(ticks, expSec);
        if (!exitTick) {
          outcomesByHorizon[h.key] = null;
          continue;
        }
        // Tie counts as a loss
        const win =
          signal.direction === 'CALL'
            ? exitTick.price > signal.entryPrice
            : exitTick.price < signal.entryPrice;
        outcomesByHorizon[h.key] = win;
      }

      if (outcomesByHorizon[signal.expiry] === null) {
        continue;
      }

      lastSignalByMode.set(mode, scanSec);
      signals.push({
        entryTimeSec: scanSec,
        timeIso: new Date(scanSec * 1000).toISOString(),
        symbol: asset.symbol,
        mode,
        chosenExpiry: signal.expiry,
        direction: signal.direction,
        strength: signal.strength,
        entryPrice: signal.entryPrice,
        outcomesByHorizon,
      });
    }
  }

  return { signals, startSec: firstTickSec, endSec: lastTickSec };
}

// ============================================================================
// 6. REPORT & CSV FORMATTING
// ============================================================================

function fmtR(val: number): string {
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(3)}R`;
}

function fmtCiR(stats: Mt5PerformanceStats): string {
  if (stats.ci95LowR === null || stats.ci95HighR === null) return 'N/A (n<2)';
  return `[${fmtR(stats.ci95LowR)}, ${fmtR(stats.ci95HighR)}]`;
}

function formatDateYmd(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return 'N/A';
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

export function buildTradesCsv(params: {
  mt5Trades: SimulatedMt5Trade[];
  binarySignals: SimulatedBinarySignal[];
}): string {
  const rows: string[] = ['time,symbol,engine,direction,strength,entry,outcome,R'];

  const allEntries: Array<{ timeSec: number; line: string }> = [];

  for (const t of params.mt5Trades) {
    allEntries.push({
      timeSec: t.entryTimeSec,
      line: [
        t.timeIso,
        t.symbol,
        `mt5_${t.structureTimeframe}`,
        t.direction,
        t.strength,
        t.entryPrice,
        t.outcome,
        t.netR.toFixed(4),
      ].join(','),
    });
  }

  for (const s of params.binarySignals) {
    const won = s.outcomesByHorizon[s.chosenExpiry];
    if (won === null) continue;
    const payoutDecimal = BINARY_PAYOUT_DEFAULT_PCT / 100;
    const rVal = won ? payoutDecimal : -1.0;
    allEntries.push({
      timeSec: s.entryTimeSec,
      line: [
        s.timeIso,
        s.symbol,
        `binary_${s.mode}`,
        s.direction,
        s.strength,
        s.entryPrice,
        won ? 'WIN' : 'LOSS',
        rVal.toFixed(4),
      ].join(','),
    });
  }

  allEntries.sort((a, b) => a.timeSec - b.timeSec);
  for (const e of allEntries) rows.push(e.line);
  return rows.join('\n') + '\n';
}

function formatBinaryBeatsLabel(st: BinaryWinRateStats): string {
  if (st.notEnoughTrades || st.sampleSize < MIN_VERDICT_TRADES) {
    return 'not enough trades';
  }
  return `${st.beats80 ? 'Yes' : 'No'} / ${st.beats85 ? 'Yes' : 'No'} / ${st.beats90 ? 'Yes' : 'No'}`;
}

export function generateBacktestReport(params: {
  generatedAtIso: string;
  mt5PerSymbolResults: Array<{
    asset: AssetConfig;
    m15: Mt5WalkForwardResult;
    h1: Mt5WalkForwardResult;
  }>;
  binaryPerSymbolResults: Array<{
    asset: AssetConfig;
    signals: SimulatedBinarySignal[];
    startSec: number;
    endSec: number;
  }>;
  engineBugsFound: string[];
}): string {
  const { generatedAtIso, mt5PerSymbolResults, binaryPerSymbolResults, engineBugsFound } = params;

  const allMt5Trades = mt5PerSymbolResults.flatMap((r) => [...r.m15.trades, ...r.h1.trades]);
  const allBinarySignals = binaryPerSymbolResults.flatMap((r) => r.signals);
  const resolvedBinaryOutcomes = allBinarySignals
    .map((s) => s.outcomesByHorizon[s.chosenExpiry])
    .filter((v): v is boolean => v !== null);
  const resolvedBinaryCount = resolvedBinaryOutcomes.length;
  const totalTrades = allMt5Trades.length + resolvedBinaryCount;

  const pooledMt5 = computeMt5Stats(allMt5Trades.map((t) => t.netR));
  const pooledBinary = computeBinaryStats(resolvedBinaryOutcomes);

  const allTimestamps = [
    ...mt5PerSymbolResults.flatMap((r) => [r.m15.startSec, r.m15.endSec, r.h1.startSec, r.h1.endSec]),
    ...binaryPerSymbolResults.flatMap((r) => [r.startSec, r.endSec]),
  ].filter((t) => t > 0);
  const minDate = allTimestamps.length > 0 ? formatDateYmd(Math.min(...allTimestamps)) : 'N/A';
  const maxDate = allTimestamps.length > 0 ? formatDateYmd(Math.max(...allTimestamps)) : 'N/A';

  const lines: string[] = [];
  lines.push('# Stage 4B Walk-Forward Backtest Report (Real Deriv Market History)');
  lines.push('');
  lines.push(`Generated: ${generatedAtIso}`);
  lines.push(`Date range: ${minDate} to ${maxDate}`);
  lines.push(
    `Total simulated trades: ${totalTrades.toLocaleString('en-US')} (MT5: ${allMt5Trades.length.toLocaleString('en-US')}, Binary: ${resolvedBinaryCount.toLocaleString('en-US')})`
  );
  lines.push('These results are historical and do not predict future performance.');
  lines.push(`Note: groups with fewer than ${MIN_VERDICT_TRADES} trades are marked "not enough trades".`);
  lines.push('');

  // Plain-English Summary (checked before detailed tables, enforcing n >= 30 threshold)
  const mt5StrongTiers: string[] = [];
  for (const tf of ['H1', 'M15'] as const) {
    const tfTrades = allMt5Trades.filter((t) => t.structureTimeframe === tf);
    const st = computeMt5Stats(tfTrades.map((t) => t.netR));
    if (st.trades >= MIN_VERDICT_TRADES && st.ci95LowR !== null && st.ci95LowR > 0) {
      mt5StrongTiers.push(`MT5 ${tf} overall (n=${st.trades}, 95% CI ${fmtCiR(st)})`);
    }
    for (const tier of ['Low', 'Medium', 'High'] as const) {
      const tierStats = computeMt5Stats(
        tfTrades.filter((t) => t.strength === tier).map((t) => t.netR)
      );
      if (tierStats.trades >= MIN_VERDICT_TRADES && tierStats.ci95LowR !== null && tierStats.ci95LowR > 0) {
        mt5StrongTiers.push(`MT5 ${tf} ${tier} tier (n=${tierStats.trades}, 95% CI ${fmtCiR(tierStats)})`);
      }
    }
  }

  const binaryAboveBe: string[] = [];
  for (const mode of ['1m', '2m', '3m', '5m', 'auto'] as const) {
    const modeSignals = allBinarySignals.filter((s) => s.mode === mode);
    const nativeOutcomes = modeSignals
      .map((s) => s.outcomesByHorizon[s.chosenExpiry])
      .filter((v): v is boolean => v !== null);
    const bStats = computeBinaryStats(nativeOutcomes);
    if (!bStats.notEnoughTrades && (bStats.beats80 || bStats.beats85 || bStats.beats90)) {
      const payouts = [
        bStats.beats80 ? '80%' : null,
        bStats.beats85 ? '85%' : null,
        bStats.beats90 ? '90%' : null,
      ]
        .filter(Boolean)
        .join('/');
      binaryAboveBe.push(
        `Binary ${mode} (n=${bStats.sampleSize}, CI [${bStats.ciLowerPct}%, ${bStats.ciUpperPct}%] beats ${payouts} break-even)`
      );
    }
    for (const tier of ['Low', 'Medium', 'High'] as const) {
      const tierOutcomes = modeSignals
        .filter((s) => s.strength === tier)
        .map((s) => s.outcomesByHorizon[s.chosenExpiry])
        .filter((v): v is boolean => v !== null);
      const tStats = computeBinaryStats(tierOutcomes);
      if (!tStats.notEnoughTrades && (tStats.beats80 || tStats.beats85 || tStats.beats90)) {
        const payouts = [
          tStats.beats80 ? '80%' : null,
          tStats.beats85 ? '85%' : null,
          tStats.beats90 ? '90%' : null,
        ]
          .filter(Boolean)
          .join('/');
        binaryAboveBe.push(
          `Binary ${mode} ${tier} tier (n=${tStats.sampleSize}, CI [${tStats.ciLowerPct}%, ${tStats.ciUpperPct}%] beats ${payouts} break-even)`
        );
      }
    }
  }

  const pooledBinarySummaryVerdict = pooledBinary.notEnoughTrades
    ? 'not enough trades'
    : pooledBinary.beats80 || pooledBinary.beats85 || pooledBinary.beats90
    ? '95% CI clears break-even'
    : 'does not clear break-even (80%/85%/90%)';

  lines.push('## Plain-English Summary');
  lines.push('');
  lines.push(
    `- Pooled MT5 (all trades): n=${pooledMt5.trades}, win rate=${pooledMt5.winRatePct.toFixed(2)}%, avg=${fmtR(pooledMt5.avgR)}, 95% CI=${fmtCiR(pooledMt5)}, verdict: ${pooledMt5.verdict}.`
  );
  lines.push(
    `- Pooled Binary (all trades): n=${pooledBinary.sampleSize}, win rate=${pooledBinary.winRatePct.toFixed(2)}%, 95% Wilson CI=[${pooledBinary.ciLowerPct}%, ${pooledBinary.ciUpperPct}%], verdict: ${pooledBinarySummaryVerdict}.`
  );
  if (mt5StrongTiers.length > 0) {
    lines.push(
      `- MT5 engine subgroups (n>=${MIN_VERDICT_TRADES}): The 95% confidence interval for average R stays strictly above 0 R after spread costs in: ${mt5StrongTiers.join('; ')}.`
    );
  } else {
    lines.push(
      `- MT5 engine subgroups (n>=${MIN_VERDICT_TRADES}): None — no MT5 timeframe or strength tier with >= ${MIN_VERDICT_TRADES} trades keeps its 95% confidence interval of average R strictly above 0 R after spread costs.`
    );
  }
  if (binaryAboveBe.length > 0) {
    lines.push(
      `- Binary engine subgroups (n>=${MIN_VERDICT_TRADES}): The 95% Wilson confidence interval stays strictly above break-even in: ${binaryAboveBe.join('; ')}. (Note: 14 days is a small sample.)`
    );
  } else {
    lines.push(
      `- Binary engine subgroups (n>=${MIN_VERDICT_TRADES}): None — no expiry or strength tier with >= ${MIN_VERDICT_TRADES} trades keeps its 95% confidence interval above the break-even win rate (55.56% at 80%, 54.05% at 85%, 52.63% at 90%). (Note: 14 days is a small sample.)`
    );
  }
  lines.push('');

  // Spread Config Table
  lines.push('## MT5 Spread Costs Applied (instrumentMeta.ts Pip Sizes)');
  lines.push('');
  lines.push('| Symbol | Asset Type | Pip Size | Spread Cost | Spread in Price |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of mt5PerSymbolResults) {
    const sp = resolveSpreadCostForAsset(r.asset);
    lines.push(
      `| ${r.asset.symbol} | ${r.asset.type} | ${sp.pipSize} | ${sp.spreadValue} ${sp.unitLabel} | ${sp.spreadPrice.toFixed(sp.decimals)} |`
    );
  }
  lines.push('');

  // MT5 Results Section
  lines.push('## 1. MT5 Engine Results (After Spread Costs, Risk 1% of $10,000, Max 1 Open/Symbol, 48h Max Hold)');
  lines.push('');
  lines.push(
    `**Pooled ALL MT5 trades**: n=${pooledMt5.trades} | Win Rate=${pooledMt5.winRatePct.toFixed(2)}% | Avg R=${fmtR(pooledMt5.avgR)} | 95% CI=${fmtCiR(pooledMt5)} | Verdict=${pooledMt5.verdict}`
  );
  lines.push('');
  for (const tf of ['H1', 'M15'] as const) {
    lines.push(`### MT5 Structure Timeframe: ${tf}`);
    lines.push('');
    lines.push('| Symbol | Trades | Win Rate | Avg R | Total R | Max DD (R) | Max Loss Streak | 95% CI (Avg R) | Verdict |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|---|');
    const tfAll: number[] = [];
    for (const r of mt5PerSymbolResults) {
      const sub = tf === 'H1' ? r.h1 : r.m15;
      const rVals = sub.trades.map((t) => t.netR);
      tfAll.push(...rVals);
      const st = computeMt5Stats(rVals);
      lines.push(
        `| ${r.asset.symbol} | ${st.trades} | ${st.winRatePct.toFixed(2)}% | ${fmtR(st.avgR)} | ${fmtR(st.totalR)} | ${st.maxDrawdownR.toFixed(2)}R | ${st.longestLosingStreak} | ${fmtCiR(st)} | ${st.verdict} |`
      );
    }
    const tot = computeMt5Stats(tfAll);
    lines.push(
      `| **TOTAL (${tf})** | **${tot.trades}** | **${tot.winRatePct.toFixed(2)}%** | **${fmtR(tot.avgR)}** | **${fmtR(tot.totalR)}** | **${tot.maxDrawdownR.toFixed(2)}R** | **${tot.longestLosingStreak}** | **${fmtCiR(tot)}** | **${tot.verdict}** |`
    );
    lines.push('');

    lines.push(`#### ${tf} Breakdown by Strength Tier`);
    lines.push('');
    lines.push('| Tier | Trades | Win Rate | Avg R | Total R | Max DD (R) | Max Loss Streak | 95% CI (Avg R) | Verdict |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|---|');
    for (const tier of ['Low', 'Medium', 'High'] as const) {
      const tierTrades = allMt5Trades.filter(
        (t) => t.structureTimeframe === tf && t.strength === tier
      );
      const st = computeMt5Stats(tierTrades.map((t) => t.netR));
      lines.push(
        `| ${tier} | ${st.trades} | ${st.winRatePct.toFixed(2)}% | ${fmtR(st.avgR)} | ${fmtR(st.totalR)} | ${st.maxDrawdownR.toFixed(2)}R | ${st.longestLosingStreak} | ${fmtCiR(st)} | ${st.verdict} |`
      );
    }
    lines.push('');
  }

  // Learning vs Unseen (60% / 40%)
  lines.push('## 2. MT5 Learning (First 60%) vs Unseen (Last 40%) Out-of-Sample Split');
  lines.push('');
  lines.push('| Symbol | TF | Learning (60%) Trades | Learning Avg R | Learning 95% CI | Unseen (40%) Trades | Unseen Avg R | Unseen 95% CI | Unseen Verdict |');
  lines.push('|---|---|---:|---:|---|---:|---:|---|---|');
  for (const r of mt5PerSymbolResults) {
    for (const tf of ['H1', 'M15'] as const) {
      const res = tf === 'H1' ? r.h1 : r.m15;
      const learnVals = res.trades.filter((t) => t.entryTimeSec < res.splitSec).map((t) => t.netR);
      const unseenVals = res.trades.filter((t) => t.entryTimeSec >= res.splitSec).map((t) => t.netR);
      const learnSt = computeMt5Stats(learnVals);
      const unseenSt = computeMt5Stats(unseenVals);
      lines.push(
        `| ${r.asset.symbol} | ${tf} | ${learnSt.trades} | ${fmtR(learnSt.avgR)} | ${fmtCiR(learnSt)} | ${unseenSt.trades} | ${fmtR(unseenSt.avgR)} | ${fmtCiR(unseenSt)} | ${unseenSt.verdict} |`
      );
    }
  }
  lines.push('');

  lines.push('### Per-Symbol Combined Verdict (H1 + M15 Unseen 40%)');
  lines.push('');
  lines.push('| Symbol | Unseen Trades | Unseen Avg R | Unseen 95% CI | Verdict |');
  lines.push('|---|---:|---:|---|---|');
  for (const r of mt5PerSymbolResults) {
    const combinedUnseen = [
      ...r.h1.trades.filter((t) => t.entryTimeSec >= r.h1.splitSec),
      ...r.m15.trades.filter((t) => t.entryTimeSec >= r.m15.splitSec),
    ].map((t) => t.netR);
    const st = computeMt5Stats(combinedUnseen);
    lines.push(
      `| ${r.asset.symbol} | ${st.trades} | ${fmtR(st.avgR)} | ${fmtCiR(st)} | ${st.verdict} |`
    );
  }
  lines.push('');

  // Binary Results Section
  const be80 = calculateBreakEvenWinRate(80);
  const be85 = calculateBreakEvenWinRate(85);
  const be90 = calculateBreakEvenWinRate(90);
  lines.push('## 3. Binary Engine Results (14-Day Real Ticks, Walk-Forward Every 15s, 07:00–16:59 UTC Weekdays)');
  lines.push('');
  lines.push(
    `**Pooled ALL Binary trades**: n=${pooledBinary.sampleSize} | Win Rate=${pooledBinary.winRatePct.toFixed(2)}% | 95% Wilson CI=[${pooledBinary.ciLowerPct}%, ${pooledBinary.ciUpperPct}%] | BE Check (80/85/90%)=${formatBinaryBeatsLabel(pooledBinary)}`
  );
  lines.push(`- Break-even thresholds (tie = loss): **80% payout = ${be80.toFixed(2)}%**, **85% payout = ${be85.toFixed(2)}%**, **90% payout = ${be90.toFixed(2)}%**.`);
  lines.push('- Deduplication rule: **at most 1 signal per asset per 3 minutes (180s)** per horizon mode so repeated consecutive scans do not inflate counts.');
  lines.push(`- **Caveat: 14 days is a small sample.** Groups with n < ${MIN_VERDICT_TRADES} display "not enough trades".`);
  lines.push('');

  lines.push('### 3a. Binary Results by Mode (Native Chosen Expiry) and Multi-Horizon Comparison (@1m, @2m, @3m, @5m)');
  lines.push('');
  lines.push('| Mode | Signals (n) | Native Win Rate | 95% Wilson CI | Beats 80% / 85% / 90% BE? | @1m WR | @2m WR | @3m WR | @5m WR |');
  lines.push('|---|---:|---:|---|---|---|---|---|---|');
  for (const mode of ['1m', '2m', '3m', '5m', 'auto'] as const) {
    const modeSignals = allBinarySignals.filter((s) => s.mode === mode);
    const native = computeBinaryStats(
      modeSignals
        .map((s) => s.outcomesByHorizon[s.chosenExpiry])
        .filter((v): v is boolean => v !== null)
    );
    const s1 = computeBinaryStats(
      modeSignals.map((s) => s.outcomesByHorizon['1m']).filter((v): v is boolean => v !== null)
    );
    const s2 = computeBinaryStats(
      modeSignals.map((s) => s.outcomesByHorizon['2m']).filter((v): v is boolean => v !== null)
    );
    const s3 = computeBinaryStats(
      modeSignals.map((s) => s.outcomesByHorizon['3m']).filter((v): v is boolean => v !== null)
    );
    const s5 = computeBinaryStats(
      modeSignals.map((s) => s.outcomesByHorizon['5m']).filter((v): v is boolean => v !== null)
    );
    const beatsLabel = formatBinaryBeatsLabel(native);
    lines.push(
      `| ${mode} | ${native.sampleSize} | ${native.winRatePct.toFixed(2)}% | [${native.ciLowerPct}%, ${native.ciUpperPct}%] | ${beatsLabel} | ${s1.winRatePct.toFixed(2)}% (n=${s1.sampleSize}) | ${s2.winRatePct.toFixed(2)}% (n=${s2.sampleSize}) | ${s3.winRatePct.toFixed(2)}% (n=${s3.sampleSize}) | ${s5.winRatePct.toFixed(2)}% (n=${s5.sampleSize}) |`
    );
  }
  lines.push('');

  lines.push('### 3b. Binary Results by Asset (All Modes Combined at Native Expiry)');
  lines.push('');
  lines.push('| Asset | Signals (n) | Wins | Win Rate | 95% Wilson CI | Beats 80% / 85% / 90% BE? |');
  lines.push('|---|---:|---:|---:|---|---|');
  for (const r of binaryPerSymbolResults) {
    const st = computeBinaryStats(
      r.signals
        .map((s) => s.outcomesByHorizon[s.chosenExpiry])
        .filter((v): v is boolean => v !== null)
    );
    const beatsLabel = formatBinaryBeatsLabel(st);
    lines.push(
      `| ${r.asset.symbol} | ${st.sampleSize} | ${st.wins} | ${st.winRatePct.toFixed(2)}% | [${st.ciLowerPct}%, ${st.ciUpperPct}%] | ${beatsLabel} |`
    );
  }
  lines.push('');

  lines.push('### 3c. Binary Results by Strength Tier (All Modes Combined at Native Expiry)');
  lines.push('');
  lines.push('| Tier | Signals (n) | Wins | Win Rate | 95% Wilson CI | Beats 80% / 85% / 90% BE? |');
  lines.push('|---|---:|---:|---:|---|---|');
  for (const tier of ['Low', 'Medium', 'High'] as const) {
    const tierOutcomes = allBinarySignals
      .filter((s) => s.strength === tier)
      .map((s) => s.outcomesByHorizon[s.chosenExpiry])
      .filter((v): v is boolean => v !== null);
    const st = computeBinaryStats(tierOutcomes);
    const beatsLabel = formatBinaryBeatsLabel(st);
    lines.push(
      `| ${tier} | ${st.sampleSize} | ${st.wins} | ${st.winRatePct.toFixed(2)}% | [${st.ciLowerPct}%, ${st.ciUpperPct}%] | ${beatsLabel} |`
    );
  }
  lines.push('');

  // Section 4: Engine Anomalies / Notes
  lines.push('## 4. Engine Anomalies Observed During Run');
  lines.push('');
  if (engineBugsFound.length === 0) {
    lines.push('- No engine runtime crashes or anomalies triggered during this run.');
  } else {
    for (const bug of engineBugsFound) {
      lines.push(`- ${bug}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// 7. MAIN CLI RUNNER
// ============================================================================

async function main(): Promise<void> {
  console.log('Connecting to Deriv WebSocket:', DERIV_WS_URL);
  const client = new DerivHistoryClient(DERIV_WS_URL);

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const activeSymbolsCachePath = resolve(CACHE_DIR, 'active_symbols.json');
    let rawSymbols: ActiveSymbolRaw[] = [];
    try {
      const activeResp = await client.request({ active_symbols: 'brief' });
      rawSymbols = Array.isArray(activeResp?.active_symbols)
        ? activeResp.active_symbols
        : [];
      if (rawSymbols.length > 0) {
        writeFileSync(activeSymbolsCachePath, JSON.stringify(rawSymbols, null, 2), 'utf8');
      }
    } catch (err: any) {
      if (existsSync(activeSymbolsCachePath)) {
        rawSymbols = JSON.parse(readFileSync(activeSymbolsCachePath, 'utf8')) as ActiveSymbolRaw[];
        console.warn(
          `[WARN] active_symbols fetch failed (${err?.message || err}); using cached active_symbols.json (${rawSymbols.length} symbols).`
        );
      } else {
        throw err;
      }
    }

    if (rawSymbols.length === 0 && existsSync(activeSymbolsCachePath)) {
      rawSymbols = JSON.parse(readFileSync(activeSymbolsCachePath, 'utf8')) as ActiveSymbolRaw[];
    }

    if (rawSymbols.length === 0) {
      throw new Error('Deriv active_symbols returned 0 symbols.');
    }

    const { mt5Assets, binaryAssets, activeIndexBugNotes } = selectUniverseFromActiveSymbols(rawSymbols);
    console.log(
      `Selected ${mt5Assets.length} MT5 symbols: ${mt5Assets.map((a) => a.symbol).join(', ')}`
    );
    console.log(
      `Selected ${binaryAssets.length} Binary tick symbols: ${binaryAssets.map((a) => a.symbol).join(', ')}`
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const mt5Histories = new Map<string, Mt5SymbolHistory>();
    const m5RatesMap = new Map<string, Candle[]>();

    for (const asset of mt5Assets) {
      const D1 = await fetchCandlesWithCache(client, asset.symbol, 'D1', 86400, nowSec);
      const H4 = await fetchCandlesWithCache(client, asset.symbol, 'H4', 14400, nowSec);
      const H1 = await fetchCandlesWithCache(client, asset.symbol, 'H1', 3600, nowSec);
      const M15 = await fetchCandlesWithCache(client, asset.symbol, 'M15', 900, nowSec);
      const M5 = await fetchCandlesWithCache(client, asset.symbol, 'M5', 300, nowSec);
      mt5Histories.set(asset.symbol, { asset, D1, H4, H1, M15, M5 });
      if (asset.type === 'FOREX') {
        m5RatesMap.set(asset.symbol, M5);
      }
    }

    const binaryTickMap = new Map<string, { asset: AssetConfig; ticks: TimestampedTick[] }>();
    for (const asset of binaryAssets) {
      const ticks = await fetchTicks14dWithCache(client, asset.symbol, nowSec);
      binaryTickMap.set(asset.symbol, { asset, ticks });
    }

    console.log('\nRunning MT5 walk-forward simulation (H1 & M15)...');
    const mt5Results: Array<{
      asset: AssetConfig;
      m15: Mt5WalkForwardResult;
      h1: Mt5WalkForwardResult;
    }> = [];
    const engineBugs = [...activeIndexBugNotes];

    for (const asset of mt5Assets) {
      const hist = mt5Histories.get(asset.symbol)!;
      const h1 = runMt5WalkForwardForSymbol({
        history: hist,
        structureTimeframe: 'H1',
        ratesHistory: m5RatesMap,
      });
      const m15 = runMt5WalkForwardForSymbol({
        history: hist,
        structureTimeframe: 'M15',
        ratesHistory: m5RatesMap,
      });
      mt5Results.push({ asset, m15, h1 });
      if (asset.type === 'INDEX' && h1.otcBlockedScans > 0 && h1.trades.length === 0) {
        engineBugs.push(
          `${asset.symbol} had ${h1.otcBlockedScans} unexpected OTC-blocked scans during walk-forward.`
        );
      }
    }

    console.log('Running Binary walk-forward simulation (14d real ticks)...');
    const binaryResults: Array<{
      asset: AssetConfig;
      signals: SimulatedBinarySignal[];
      startSec: number;
      endSec: number;
    }> = [];

    for (const asset of binaryAssets) {
      const entry = binaryTickMap.get(asset.symbol)!;
      const res = runBinaryWalkForwardForSymbol({
        asset: entry.asset,
        ticks: entry.ticks,
      });
      binaryResults.push({ asset: entry.asset, ...res });
    }

    const dateTag = new Date().toISOString().slice(0, 10);
    const reportText = generateBacktestReport({
      generatedAtIso: new Date().toISOString(),
      mt5PerSymbolResults: mt5Results,
      binaryPerSymbolResults: binaryResults,
      engineBugsFound: Array.from(new Set(engineBugs)),
    });

    const csvText = buildTradesCsv({
      mt5Trades: mt5Results.flatMap((r) => [...r.h1.trades, ...r.m15.trades]),
      binarySignals: binaryResults.flatMap((r) => r.signals),
    });

    mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = resolve(REPORTS_DIR, `backtest-${dateTag}.md`);
    const csvPath = resolve(REPORTS_DIR, `trades-${dateTag}.csv`);
    writeFileSync(reportPath, reportText, 'utf8');
    writeFileSync(csvPath, csvText, 'utf8');

    console.log('\n' + reportText);
    console.log(`Saved report: ${reportPath}`);
    console.log(`Saved trades CSV: ${csvPath}`);
  } finally {
    client.close();
  }
}

const isEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntry) {
  main().catch((err) => {
    console.error('[backtest:real] Fatal error:', err?.message || err);
    process.exit(1);
  });
}
