/**
 * mt5Engine.ts — Candle-Based CFD / MetaTrader 5 Engine (Stage 3 Part 2)
 *
 * Design guarantees:
 *  - Purely candle-driven (D1/H4 bias, H1/M15 structure & ATR(14), M5 entry timing).
 *  - Zero fake candle padding; zero tick-only MT5 shortcuts; zero hardcoded 10..60 clamps.
 *  - DELAYED tick status does NOT block candle-based MT5 analysis (only MARKET_CLOSED/OFFLINE/etc. block).
 *  - Structural SL = swing + 0.25×ATR, min 1.0×ATR, max 3.0×ATR (> 3×ATR => WAIT "Stop would be too wide").
 *  - TP1 = closer of nearest opposing key level or 1.5R (at least 1R); R:R < 1.5 => WAIT.
 *  - TP2 = closer of next opposing key level or 2.5R.
 *  - Position sizing rounded DOWN to lot_step; if < min_lot, lotSize = 0 with explicit small-account message (never forced to 0.01).
 *  - Spread filter (< 15% of SL distance) & ±30 min HIGH impact news filter.
 *  - Zero win-probability percentages emitted anywhere. Synthetics capped at Medium.
 */

import type {
  AssetConfig,
  Candle,
  DailyPivotLevels,
  InstrumentSpec,
  MT5EngineInput,
  MT5KeyLevels,
  MT5SignalOutput,
  MarketEventItem,
  SignalStrength,
} from './types.ts';
import {
  calculateATR,
  calculateEMA,
  calculateRSI,
  detectSwingLevels,
} from './indicators.ts';
import { isSyntheticAsset } from '../../services/symbolMap.ts';

export const DEFAULT_INSTRUMENT_SPECS: Record<string, InstrumentSpec> = {
  'EUR/USD': { symbol: 'EUR/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5 },
  'GBP/USD': { symbol: 'GBP/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5 },
  'USD/JPY': { symbol: 'USD/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3 },
  'AUD/USD': { symbol: 'AUD/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5 },
  'USD/CAD': { symbol: 'USD/CAD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'CAD', pipSize: 0.0001, decimals: 5 },
  'USD/CHF': { symbol: 'USD/CHF', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'CHF', pipSize: 0.0001, decimals: 5 },
  'EUR/GBP': { symbol: 'EUR/GBP', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'GBP', pipSize: 0.0001, decimals: 5 },
  'GBP/JPY': { symbol: 'GBP/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3 },
  'EUR/JPY': { symbol: 'EUR/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3 },
  'XAU/USD': { symbol: 'XAU/USD', contractSize: 100, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.01, decimals: 2 },
  'XAG/USD': { symbol: 'XAG/USD', contractSize: 5000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.001, decimals: 3 },
  'BTC/USD': { symbol: 'BTC/USD', contractSize: 1, minLot: 0.001, lotStep: 0.001, quoteCcy: 'USD', pipSize: 1.0, decimals: 2 },
  'ETH/USD': { symbol: 'ETH/USD', contractSize: 1, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.1, decimals: 2 },
};

export function normalizeSpecKey(raw: string): string {
  const s = (raw || '').trim().toUpperCase();
  if (!s) return '';
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAU/USD';
  if (s.includes('XAG') || s.includes('SILVER')) return 'XAG/USD';

  const stripped = s.replace(/^FRX|^CRY|^WLDAUD|^WLD/, '');
  if (stripped.length === 6 && /^[A-Z]{6}$/.test(stripped)) {
    return `${stripped.slice(0, 3)}/${stripped.slice(3, 6)}`;
  }
  return s;
}

export function inferAssetCurrencies(asset: AssetConfig): { baseCcy: string; quoteCcy: string } {
  const clean = (asset.symbol || '').toUpperCase().replace(/^FRX|^CRY/, '').replace(/[^A-Z0-9]/g, '');
  if (/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|XAU|XAG){2}$/.test(clean) && clean.length === 6) {
    return { baseCcy: clean.slice(0, 3), quoteCcy: clean.slice(3, 6) };
  }
  const nameClean = (asset.name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (nameClean.includes('GOLD') || nameClean.includes('XAUUSD')) {
    return { baseCcy: 'XAU', quoteCcy: 'USD' };
  }
  if (nameClean.includes('SILVER') || nameClean.includes('XAGUSD')) {
    return { baseCcy: 'XAG', quoteCcy: 'USD' };
  }
  if (/^[A-Z]{6}$/.test(nameClean)) {
    return { baseCcy: nameClean.slice(0, 3), quoteCcy: nameClean.slice(3, 6) };
  }
  if (clean.startsWith('BTC') || clean.startsWith('ETH') || asset.type === 'CRYPTO') {
    return { baseCcy: clean.slice(0, 3) || 'CRYPTO', quoteCcy: 'USD' };
  }
  return { baseCcy: 'USD', quoteCcy: 'USD' };
}

export function resolveInstrumentSpec(
  asset: AssetConfig,
  overrideSpec?: Partial<InstrumentSpec>,
  contractSizeOverride?: number
): InstrumentSpec {
  const key = normalizeSpecKey(asset.symbol) || normalizeSpecKey(asset.name);
  const { quoteCcy: inferredQuote } = inferAssetCurrencies(asset);
  const defaultBySymbol = DEFAULT_INSTRUMENT_SPECS[key];

  let defaultContract = 1;
  if (defaultBySymbol) {
    defaultContract = defaultBySymbol.contractSize;
  } else if (asset.type === 'FOREX') {
    defaultContract = 100000;
  } else if (asset.type === 'COMMODITY') {
    defaultContract = asset.symbol.toUpperCase().includes('XAG') ? 5000 : 100;
  } else {
    defaultContract = 1;
  }

  const baseSpec: InstrumentSpec = {
    symbol: key || asset.symbol,
    contractSize: overrideSpec?.contractSize && overrideSpec.contractSize > 0
      ? Number(overrideSpec.contractSize)
      : defaultContract,
    minLot: overrideSpec?.minLot && overrideSpec.minLot > 0
      ? Number(overrideSpec.minLot)
      : defaultBySymbol?.minLot ?? 0.01,
    lotStep: overrideSpec?.lotStep && overrideSpec.lotStep > 0
      ? Number(overrideSpec.lotStep)
      : defaultBySymbol?.lotStep ?? 0.01,
    quoteCcy: (overrideSpec?.quoteCcy || defaultBySymbol?.quoteCcy || inferredQuote || 'USD').toUpperCase(),
    pipSize: overrideSpec?.pipSize && overrideSpec.pipSize > 0
      ? Number(overrideSpec.pipSize)
      : defaultBySymbol?.pipSize ?? asset.pipSize ?? 0.0001,
    decimals: typeof overrideSpec?.decimals === 'number'
      ? overrideSpec.decimals
      : defaultBySymbol?.decimals ?? asset.decimals ?? 5,
  };

  if (typeof contractSizeOverride === 'number' && Number.isFinite(contractSizeOverride) && contractSizeOverride > 0) {
    baseSpec.contractSize = contractSizeOverride;
  }

  return baseSpec;
}

function lookupRate(rates: Record<string, number> | undefined, pair: string): number | null {
  if (!rates) return null;
  const target = pair.toUpperCase().replace(/[^A-Z]/g, '');
  for (const [k, v] of Object.entries(rates)) {
    if (!Number.isFinite(v) || v <= 0) continue;
    const norm = k.toUpperCase().replace(/^FRX|^CRY/, '').replace(/[^A-Z]/g, '');
    if (norm === target) return v;
  }
  return null;
}

/**
 * Computes factor converting 1 unit of quote currency into 1 unit of account currency.
 * Example: USD/JPY traded on a USD account -> quote=JPY, account=USD -> returns 1 / USDJPY.
 * Example: EUR/GBP traded on a USD account -> quote=GBP, account=USD -> returns GBPUSD.
 */
export function resolveQuoteToAccountRate(params: {
  quoteCcy: string;
  accountCurrency: string;
  asset: AssetConfig;
  entryPrice: number;
  conversionRates?: Record<string, number>;
}): number | null {
  const quote = (params.quoteCcy || 'USD').toUpperCase();
  const acct = (params.accountCurrency || 'USD').toUpperCase();
  if (quote === acct) return 1.0;

  const { baseCcy, quoteCcy: pairQuote } = inferAssetCurrencies(params.asset);
  const augmentedRates: Record<string, number> = { ...(params.conversionRates || {}) };
  if (params.entryPrice > 0 && baseCcy && pairQuote && baseCcy !== pairQuote) {
    augmentedRates[`${baseCcy}${pairQuote}`] = params.entryPrice;
  }

  const direct = lookupRate(augmentedRates, `${quote}${acct}`);
  if (direct && direct > 0) return direct;

  const inverse = lookupRate(augmentedRates, `${acct}${quote}`);
  if (inverse && inverse > 0) return 1 / inverse;

  // Two-hop via USD bridge if neither direct nor inverse cross is provided
  if (quote !== 'USD' && acct !== 'USD') {
    const qToUsd =
      lookupRate(augmentedRates, `${quote}USD`) ??
      (() => {
        const inv = lookupRate(augmentedRates, `USD${quote}`);
        return inv ? 1 / inv : null;
      })();
    const usdToAcct =
      lookupRate(augmentedRates, `USD${acct}`) ??
      (() => {
        const inv = lookupRate(augmentedRates, `${acct}USD`);
        return inv ? 1 / inv : null;
      })();
    if (qToUsd && usdToAcct) {
      return qToUsd * usdToAcct;
    }
  }

  return null;
}

function countDecimals(step: number): number {
  const str = step.toString();
  if (!str.includes('.')) return 0;
  return str.split('.')[1].length;
}

export interface PositionSizingResult {
  lotSize: number;
  rawLots: number;
  riskMoney: number;
  tooSmallForMinLot: boolean;
  minLotRiskMoney: number;
  warning?: string;
}

export function calculateMT5PositionSize(params: {
  accountBalance: number;
  riskPct: number;
  slDistancePrice: number;
  spec: InstrumentSpec;
  quoteToAccountRate: number;
  accountCurrency: string;
}): PositionSizingResult {
  const { accountBalance, riskPct, slDistancePrice, spec, quoteToAccountRate, accountCurrency } = params;
  const riskMoney = parseFloat(((Math.max(0, accountBalance) * riskPct) / 100).toFixed(2));
  const riskPerSingleLot = slDistancePrice * spec.contractSize * quoteToAccountRate;

  if (riskMoney <= 0 || riskPerSingleLot <= 0) {
    return {
      lotSize: 0,
      rawLots: 0,
      riskMoney,
      tooSmallForMinLot: true,
      minLotRiskMoney: 0,
      warning: 'Your account is too small to take this trade at your chosen risk.',
    };
  }

  const rawLots = riskMoney / riskPerSingleLot;
  const stepDec = countDecimals(spec.lotStep);
  const steps = Math.floor((rawLots + 1e-10) / spec.lotStep);
  const flooredLot = parseFloat((steps * spec.lotStep).toFixed(stepDec));
  const minLotRiskMoney = parseFloat((spec.minLot * riskPerSingleLot).toFixed(2));

  if (flooredLot < spec.minLot) {
    return {
      lotSize: 0,
      rawLots,
      riskMoney,
      tooSmallForMinLot: true,
      minLotRiskMoney,
      warning: `Your account is too small to take this trade at your chosen risk (${accountCurrency} ${riskMoney.toFixed(
        2
      )} risk budget cannot cover minimum ${spec.minLot} lot risking ${accountCurrency} ${minLotRiskMoney.toFixed(2)}).`,
    };
  }

  return {
    lotSize: flooredLot,
    rawLots,
    riskMoney,
    tooSmallForMinLot: false,
    minLotRiskMoney,
  };
}

function getIsoWeekKey(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function computeDailyPivotLevels(prevDay: Candle | undefined): DailyPivotLevels | null {
  if (!prevDay) return null;
  const pivot = (prevDay.high + prevDay.low + prevDay.close) / 3;
  const range = prevDay.high - prevDay.low;
  return {
    pivot,
    r1: 2 * pivot - prevDay.low,
    r2: pivot + range,
    s1: 2 * pivot - prevDay.high,
    s2: pivot - range,
  };
}

export function computeRoundNumbers(price: number, asset: AssetConfig): number[] {
  if (!Number.isFinite(price) || price <= 0) return [];
  let step = 0.01; // big figure on 5-decimal FX (e.g. 1.0800, 1.0900, 1.1000)
  if (asset.type === 'COMMODITY' && asset.symbol.toUpperCase().includes('XAU')) {
    step = 50;
  } else if (asset.pipSize >= 1) {
    step = 1000;
  } else if (asset.pipSize >= 0.01) {
    step = price >= 500 ? 50 : 1.0; // USDJPY big figure 150.00, 151.00; R_100 big 50
  } else if (asset.pipSize >= 0.001) {
    step = 0.1;
  }

  const base = Math.floor(price / step) * step;
  const out: number[] = [];
  for (let i = -3; i <= 3; i++) {
    const level = parseFloat((base + i * step).toFixed(asset.decimals || 5));
    if (level > 0) out.push(level);
  }
  return out;
}

export function computeMT5KeyLevels(
  d1Candles: Candle[],
  h1Candles: Candle[],
  m15Candles: Candle[],
  structureTimeframe: 'H1' | 'M15',
  asset: AssetConfig,
  entryPrice: number
): MT5KeyLevels {
  const structureCandles = structureTimeframe === 'H1' ? h1Candles : m15Candles;
  const structureSwings = detectSwingLevels(structureCandles, asset.pipSize || 0.0001);
  const m15Swings = structureTimeframe === 'H1'
    ? detectSwingLevels(m15Candles.slice(-60), asset.pipSize || 0.0001)
    : structureSwings;

  const prevDay = d1Candles.length >= 2 ? d1Candles[d1Candles.length - 2] : undefined;
  const pdh = prevDay ? prevDay.high : null;
  const pdl = prevDay ? prevDay.low : null;
  const dailyPivot = computeDailyPivotLevels(prevDay);

  let pwh: number | null = null;
  let pwl: number | null = null;
  if (d1Candles.length >= 6) {
    const currentWeekKey = getIsoWeekKey(d1Candles[d1Candles.length - 1].time);
    const priorWeekBars = d1Candles.filter((c) => getIsoWeekKey(c.time) !== currentWeekKey).slice(-7);
    const weekSlice = priorWeekBars.length >= 3 ? priorWeekBars : d1Candles.slice(-7, -1);
    if (weekSlice.length > 0) {
      pwh = Math.max(...weekSlice.map((c) => c.high));
      pwl = Math.min(...weekSlice.map((c) => c.low));
    }
  }

  const combinedHighs = Array.from(new Set([...structureSwings.swingHighs, ...m15Swings.swingHighs]));
  const combinedLows = Array.from(new Set([...structureSwings.swingLows, ...m15Swings.swingLows]));

  return {
    nearestSupport: structureSwings.nearestSupport,
    nearestResistance: structureSwings.nearestResistance,
    swingHighs: combinedHighs,
    swingLows: combinedLows,
    pdh,
    pdl,
    pwh,
    pwl,
    dailyPivot,
    roundNumbers: computeRoundNumbers(entryPrice, asset),
  };
}

function assessCandleBias(candles: Candle[]): {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  ema9: number;
  ema21: number;
  ema50: number;
  rsi14: number;
  lastClose: number;
} {
  const closes = candles.map((c) => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, Math.min(50, closes.length));
  const rsi14 = calculateRSI(closes, 14);
  const lastClose = closes[closes.length - 1] || 0;

  if (ema9 > ema21 && lastClose >= ema21 && rsi14 >= 48) {
    return { bias: 'BULLISH', ema9, ema21, ema50, rsi14, lastClose };
  }
  if (ema9 < ema21 && lastClose <= ema21 && rsi14 <= 52) {
    return { bias: 'BEARISH', ema9, ema21, ema50, rsi14, lastClose };
  }
  return { bias: 'NEUTRAL', ema9, ema21, ema50, rsi14, lastClose };
}

function checkMT5Session(asset: AssetConfig, nowMs: number): {
  blocked: boolean;
  sessionName: string;
  sessionQuality: 'PRIME' | 'NORMAL' | 'CAUTION' | 'THIN';
  note: string;
} {
  const is24x7 = asset.type === 'SYNTH' || asset.type === 'CRYPTO' || isSyntheticAsset(asset);
  if (is24x7) {
    const synth = isSyntheticAsset(asset);
    return {
      blocked: false,
      sessionName: synth ? '24/7 Synthetic Index (Practice Only)' : '24/7 Crypto Market',
      sessionQuality: 'PRIME',
      note: synth
        ? '24/7 algorithmic volatility stream (random process — practice use only).'
        : 'Continuous 24/7 crypto session without weekend close.',
    };
  }

  const d = new Date(nowMs);
  const utcDay = d.getUTCDay();
  const utcHour = d.getUTCHours();

  if (utcDay === 6 || (utcDay === 5 && utcHour >= 21) || (utcDay === 0 && utcHour < 21)) {
    return {
      blocked: true,
      sessionName: 'Market Closed (Weekend)',
      sessionQuality: 'THIN',
      note: 'Spot FX/metals markets are closed for the weekend (reopens Sunday 21:00 UTC).',
    };
  }

  if (utcHour >= 21) {
    return {
      blocked: false,
      sessionName: 'NY Close / Rollover (21:00–00:00 UTC)',
      sessionQuality: 'CAUTION',
      note: 'Daily rollover hours carry wider spreads and thin liquidity. Prefer London/NY overlap (12:00–17:00 UTC) for FX.',
    };
  }

  if (utcHour >= 12 && utcHour < 17) {
    return {
      blocked: false,
      sessionName: 'London / NY Overlap (Prime FX)',
      sessionQuality: 'PRIME',
      note: 'London/NY overlap (12:00–17:00 UTC): peak institutional FX liquidity and tightest spreads.',
    };
  }

  if (utcHour >= 7 && utcHour < 12) {
    return {
      blocked: false,
      sessionName: 'London Session',
      sessionQuality: 'PRIME',
      note: 'Active European session structure; London/NY overlap follows at 12:00 UTC.',
    };
  }

  if (utcHour >= 17 && utcHour < 21) {
    return {
      blocked: false,
      sessionName: 'New York Afternoon',
      sessionQuality: 'NORMAL',
      note: 'Post-London NY session: momentum often slows compared with the London/NY overlap.',
    };
  }

  return {
    blocked: false,
    sessionName: 'Asian Session (00:00–07:00 UTC)',
    sessionQuality: 'CAUTION',
    note: 'Quiet Asian range for major FX pairs; London/NY overlap (12:00–17:00 UTC) offers stronger follow-through.',
  };
}

function findBlockingMT5News(
  events: MarketEventItem[] | undefined,
  asset: AssetConfig,
  nowMs: number
): MarketEventItem | null {
  if (!events || events.length === 0) return null;
  if (asset.type === 'SYNTH' || isSyntheticAsset(asset)) return null;

  const assetText = `${asset.symbol} ${asset.name}`.toUpperCase();
  const windowMs = 30 * 60 * 1000; // ±30 min rule for MT5

  for (const ev of events) {
    if (ev.impact !== 'HIGH') continue;
    const startMs = Date.parse(ev.starts_at);
    if (!Number.isFinite(startMs)) continue;
    if (Math.abs(startMs - nowMs) > windowMs) continue;

    const ccy = (ev.currency || '').toUpperCase().trim();
    const matches =
      ccy === 'ALL' ||
      assetText.includes(ccy) ||
      (ccy === 'USD' && (asset.type === 'CRYPTO' || asset.type === 'COMMODITY' || asset.type === 'INDEX' || asset.type === 'STOCK'));

    if (matches) return ev;
  }
  return null;
}

function buildWaitMT5Result(params: {
  input: MT5EngineInput;
  nowMs: number;
  entryPrice: number;
  accountCurrency: string;
  riskMoney: number;
  sessionNote: string;
  sessionQuality: 'PRIME' | 'NORMAL' | 'CAUTION' | 'THIN';
  structureTimeframe: 'H1' | 'M15';
  rawScore: number;
  whyNotTrade: string;
  reasons: [string, string, string];
  inputsSnapshot: Record<string, unknown>;
  riskWarning?: string;
}): MT5SignalOutput {
  const {
    input,
    nowMs,
    entryPrice,
    accountCurrency,
    riskMoney,
    sessionNote,
    sessionQuality,
    structureTimeframe,
    rawScore,
    whyNotTrade,
    reasons,
    inputsSnapshot,
    riskWarning,
  } = params;
  const isoNow = new Date(nowMs).toISOString();

  return {
    engine: 'mt5_v1',
    profile: 'MT5',
    platform: input.platform,
    platformName: input.platformName || input.platform,
    asset: input.asset.name,
    symbol: input.asset.symbol,
    direction: 'WAIT',
    orderKind: 'MARKET',
    entryPrice,
    entryZone: null,
    stopLoss: null,
    stopLossPips: null,
    takeProfit1: null,
    takeProfit1Pips: null,
    takeProfit2: null,
    takeProfit2Pips: null,
    lotSize: 0,
    riskMoney,
    accountCurrency,
    rewardRiskTp1: null,
    rewardRiskTp2: null,
    rewardRiskRatio: 'WAIT (No trade)',
    validityCandles: 0,
    validityMinutes: 0,
    validityWindowDesc: 'No active setup',
    validUntil: isoNow,
    invalidationLevel: null,
    invalidationDriftPrice: null,
    invalidationRule: whyNotTrade,
    sessionNote,
    sessionQuality,
    tradeManagementNote: 'No active order. Stand aside until structure, risk:reward (>= 1.5), and filter checks align.',
    copyOrderText: `WAIT — ${input.asset.name}: ${whyNotTrade}`,
    strength: 'Low',
    rawScore: parseFloat(rawScore.toFixed(1)),
    reasons,
    whyNotTrade,
    riskWarning,
    structureTimeframe,
    timeframe: structureTimeframe,
    createdAt: isoNow,
    generatedAt: nowMs,
    feedSource: input.feedSource || 'deriv_ws',
    inputsSnapshot,
  };
}

export function analyzeMT5Signal(input: MT5EngineInput): MT5SignalOutput {
  const nowMs = input.nowMs ?? Date.now();
  const structureTimeframe: 'H1' | 'M15' = input.structureTimeframe || 'H1';
  const spec = resolveInstrumentSpec(input.asset, input.instrumentSpec, input.contractSizeOverride);
  const dec = spec.decimals || input.asset.decimals || 5;
  const pipSize = spec.pipSize || input.asset.pipSize || 0.0001;

  const accountCurrency = (input.accountCurrency || 'USD').toUpperCase();
  const accountBalance = typeof input.accountBalance === 'number' && Number.isFinite(input.accountBalance)
    ? Math.max(0, input.accountBalance)
    : 1000;
  const rawRiskPct = typeof input.riskPct === 'number' && Number.isFinite(input.riskPct) ? input.riskPct : 1.0;
  const effectiveRiskPct = Math.min(3.0, Math.max(0.1, rawRiskPct));
  let riskWarning: string | undefined;
  if (rawRiskPct > 3.0) {
    riskWarning = `Requested ${rawRiskPct}% risk exceeds the 3% hard ceiling and has been capped at 3.0%.`;
  } else if (rawRiskPct > 2.0) {
    riskWarning = `Elevated risk warning: ${effectiveRiskPct.toFixed(1)}% per trade (max allowed is 3%; 1% is standard).`;
  }
  const riskMoney = parseFloat(((accountBalance * effectiveRiskPct) / 100).toFixed(2));
  const leverage = typeof input.leverage === 'number' && input.leverage >= 1 ? input.leverage : 100;

  const d1Candles = input.d1Candles || [];
  const h4Candles = input.h4Candles || [];
  const h1Candles = input.h1Candles || [];
  const m15Candles = input.m15Candles || [];
  const m5Candles = input.m5Candles || [];

  const latestPrice =
    m5Candles[m5Candles.length - 1]?.close ??
    m15Candles[m15Candles.length - 1]?.close ??
    h1Candles[h1Candles.length - 1]?.close ??
    0;

  const session = checkMT5Session(input.asset, nowMs);
  const isSynthetic = isSyntheticAsset(input.asset);

  const baseSnapshot: Record<string, unknown> = {
    symbol: input.asset.symbol,
    structureTimeframe,
    feedStatus: input.feedStatus,
    counts: {
      d1: d1Candles.length,
      h4: h4Candles.length,
      h1: h1Candles.length,
      m15: m15Candles.length,
      m5: m5Candles.length,
    },
    accountCurrency,
    accountBalance,
    riskPct: effectiveRiskPct,
    leverage,
    spec,
    evaluatedAt: new Date(nowMs).toISOString(),
  };

  // 1. Hard Gate: OTC proprietary broker pricing
  if (input.isOtc || input.asset.is_otc || /OTC/i.test(input.asset.symbol) || /OTC/i.test(input.asset.name)) {
    const reason = 'OTC prices are set by your broker; we cannot analyse them.';
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 0,
      whyNotTrade: reason,
      reasons: [
        reason,
        'No verifiable candle history exists for broker-internal OTC pricing.',
        'Switch to an exchange-backed Forex, Metal, Index, or Crypto symbol.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'OTC' },
      riskWarning,
    });
  }

  // 2. Hard Gate: Feed status (Note Rule 3: DELAYED ticks do NOT block MT5 candle analysis)
  if (
    input.feedStatus === 'MARKET_CLOSED' ||
    input.feedStatus === 'OFFLINE' ||
    input.feedStatus === 'RECONNECTING' ||
    input.feedStatus === 'CONNECTING'
  ) {
    const reason = `MT5 candle analysis unavailable while feed status is ${input.feedStatus}.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 0,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Wait for open market candle history before placing orders.',
        'DELAYED tick status will still allow MT5 candle analysis once the socket is connected.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'FEED_UNAVAILABLE' },
      riskWarning,
    });
  }

  // 3. Hard Gate: Market closed (weekend FX check using nowMs)
  if (session.blocked) {
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 0,
      whyNotTrade: `${session.sessionName}: ${session.note}`,
      reasons: [
        session.sessionName,
        session.note,
        'Switch to a 24/7 Crypto pair during weekend FX close.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'MARKET_CLOSED' },
      riskWarning,
    });
  }

  // 4. Hard Gate: Insufficient real candle history across required timeframes
  if (
    d1Candles.length < 2 ||
    h4Candles.length < 10 ||
    h1Candles.length < 20 ||
    m15Candles.length < 20 ||
    m5Candles.length < 20
  ) {
    const reason = `Insufficient real candle history (D1: ${d1Candles.length}/2, H4: ${h4Candles.length}/10, H1: ${h1Candles.length}/20, M15: ${m15Candles.length}/20, M5: ${m5Candles.length}/20).`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 0,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Zero analysis is computed without real historical OHLC candles from Deriv.',
        'Wait for candle history to finish loading and retry.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'INSUFFICIENT_CANDLES' },
      riskWarning,
    });
  }

  // 5. Hard Gate: ±30 min High-Impact Macro News
  const blockingNews = findBlockingMT5News(input.marketEvents, input.asset, nowMs);
  if (blockingNews) {
    const reason = `High-impact ${blockingNews.currency} event within ±30 min: ${blockingNews.title}.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 15,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Scheduled high-impact news widens broker spreads and triggers stop-hunt slippage.',
        'Stand aside until 30 minutes after the release stabilizes.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'HIGH_IMPACT_NEWS', blockingNews },
      riskWarning,
    });
  }

  // =========================================================================
  // 6. MULTI-TIMEFRAME BIAS (D1/H4) + STRUCTURE (H1/M15) + ENTRY TIMING (M5)
  // =========================================================================
  const d1Bias = assessCandleBias(d1Candles);
  const h4Bias = assessCandleBias(h4Candles);
  const h1Bias = assessCandleBias(h1Candles);
  const m15Bias = assessCandleBias(m15Candles);
  const m5Bias = assessCandleBias(m5Candles);

  const structureCandles = structureTimeframe === 'H1' ? h1Candles : m15Candles;
  const structureAssessment = structureTimeframe === 'H1' ? h1Bias : m15Bias;
  const atrStructure = calculateATR(structureCandles, 14);
  const atrH1 = calculateATR(h1Candles, 14);
  const atrM15 = calculateATR(m15Candles, 14);

  if (!Number.isFinite(atrStructure) || atrStructure <= 0) {
    const reason = `Zero ${structureTimeframe} ATR(14) — flat/stale candle range cannot establish structural stops.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 0,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Cannot size risk or define ATR-normalized stop distances without price range.',
        'Wait for active market movement before scanning.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'ZERO_ATR' },
      riskWarning,
    });
  }

  // Resolve HTF directional bias from D1 + H4
  let htfDirection: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
  if (h4Bias.bias === 'BULLISH' && d1Bias.bias !== 'BEARISH') {
    htfDirection = 'BUY';
  } else if (h4Bias.bias === 'BEARISH' && d1Bias.bias !== 'BULLISH') {
    htfDirection = 'SELL';
  } else if (d1Bias.bias === 'BULLISH' && h4Bias.bias === 'NEUTRAL' && structureAssessment.bias === 'BULLISH') {
    htfDirection = 'BUY';
  } else if (d1Bias.bias === 'BEARISH' && h4Bias.bias === 'NEUTRAL' && structureAssessment.bias === 'BEARISH') {
    htfDirection = 'SELL';
  }

  const keyLevels = computeMT5KeyLevels(
    d1Candles,
    h1Candles,
    m15Candles,
    structureTimeframe,
    input.asset,
    latestPrice
  );

  const indicatorSnapshot = {
    ...baseSnapshot,
    d1Bias: { bias: d1Bias.bias, ema9: d1Bias.ema9, ema21: d1Bias.ema21, rsi14: d1Bias.rsi14 },
    h4Bias: { bias: h4Bias.bias, ema9: h4Bias.ema9, ema21: h4Bias.ema21, rsi14: h4Bias.rsi14 },
    h1Bias: { bias: h1Bias.bias, ema9: h1Bias.ema9, ema21: h1Bias.ema21, rsi14: h1Bias.rsi14 },
    m15Bias: { bias: m15Bias.bias, ema9: m15Bias.ema9, ema21: m15Bias.ema21, rsi14: m15Bias.rsi14 },
    m5Bias: { bias: m5Bias.bias, ema9: m5Bias.ema9, ema21: m5Bias.ema21, rsi14: m5Bias.rsi14 },
    atrStructure,
    atrH1,
    atrM15,
    keyLevels,
  };

  if (htfDirection === 'WAIT') {
    const reason = `Higher-timeframe bias conflict or neutral chop (D1: ${d1Bias.bias}, H4: ${h4Bias.bias}).`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 35,
      whyNotTrade: reason,
      reasons: [
        reason,
        `${structureTimeframe} structure is ${structureAssessment.bias} with ATR(14) at ${(atrStructure / pipSize).toFixed(1)} pips.`,
        'Wait for D1 and H4 directional alignment before entering an MT5 position.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'HTF_BIAS_CONFLICT' },
      riskWarning,
    });
  }

  // Structure timeframe confirmation check
  const structureOpposes =
    (htfDirection === 'BUY' && structureAssessment.bias === 'BEARISH') ||
    (htfDirection === 'SELL' && structureAssessment.bias === 'BULLISH');
  if (structureOpposes || (h1Bias.bias !== m15Bias.bias && structureAssessment.bias === 'NEUTRAL')) {
    const reason = `${structureTimeframe} structure (${structureAssessment.bias}) does not support ${htfDirection} H4/D1 bias.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 42,
      whyNotTrade: reason,
      reasons: [
        reason,
        `H1 bias: ${h1Bias.bias}, M15 bias: ${m15Bias.bias}.`,
        'Stand aside until structure timeframe breaks back in line with D1/H4 trend.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'STRUCTURE_DISAGREEMENT' },
      riskWarning,
    });
  }

  // M5 Entry Timing: Market vs Limit at Retest Zone
  const m5DistFromEma9 = latestPrice - m5Bias.ema9;
  const alignedDist = htfDirection === 'BUY' ? m5DistFromEma9 : -m5DistFromEma9;
  const distInAtr = alignedDist / atrStructure;

  if (distInAtr > 1.5) {
    const reason = `Price is overextended (+${distInAtr.toFixed(2)}×ATR beyond M5 EMA9) — chasing entry blocked.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice: latestPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 52,
      whyNotTrade: reason,
      reasons: [
        reason,
        `M5 EMA(9) sits at ${m5Bias.ema9.toFixed(dec)} vs spot ${latestPrice.toFixed(dec)}.`,
        'Wait for a controlled pullback into the M5 EMA retest zone before entering.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'OVEREXTENDED_M5_ENTRY', distInAtr },
      riskWarning,
    });
  }

  let orderKind: 'MARKET' | 'LIMIT' = 'MARKET';
  let entryPrice = latestPrice;

  if (distInAtr > 0.45 && distInAtr <= 1.5) {
    orderKind = 'LIMIT';
    entryPrice = parseFloat(m5Bias.ema9.toFixed(dec));
  } else {
    orderKind = 'MARKET';
    entryPrice = parseFloat(latestPrice.toFixed(dec));
  }

  const zoneHalf = 0.15 * atrStructure;
  const entryZone = {
    min: parseFloat((entryPrice - zoneHalf).toFixed(dec)),
    max: parseFloat((entryPrice + zoneHalf).toFixed(dec)),
  };

  // =========================================================================
  // 7. STRUCTURAL STOP-LOSS (Swing ± 0.25×ATR, min 1.0×ATR, > 3.0×ATR => WAIT)
  // =========================================================================
  const structureSwings = detectSwingLevels(structureCandles, pipSize);
  const recentLowFallback = Math.min(...structureCandles.slice(-20).map((c) => c.low));
  const recentHighFallback = Math.max(...structureCandles.slice(-20).map((c) => c.high));

  let structuralSwingPrice: number;
  if (htfDirection === 'BUY') {
    const lowsBelow = structureSwings.swingLows.filter((l) => l < entryPrice);
    structuralSwingPrice = lowsBelow.length > 0 ? Math.max(...lowsBelow) : recentLowFallback;
  } else {
    const highsAbove = structureSwings.swingHighs.filter((h) => h > entryPrice);
    structuralSwingPrice = highsAbove.length > 0 ? Math.min(...highsAbove) : recentHighFallback;
  }

  const rawStopPrice =
    htfDirection === 'BUY'
      ? structuralSwingPrice - 0.25 * atrStructure
      : structuralSwingPrice + 0.25 * atrStructure;
  const rawSlDistance =
    htfDirection === 'BUY' ? entryPrice - rawStopPrice : rawStopPrice - entryPrice;

  if (rawSlDistance <= 0) {
    const reason = 'Structural invalidation swing lies on the wrong side of planned entry.';
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 45,
      whyNotTrade: reason,
      reasons: [
        reason,
        `Nearest swing level (${structuralSwingPrice.toFixed(dec)}) does not bracket ${htfDirection} entry (${entryPrice.toFixed(dec)}).`,
        'Stand aside until a clean structural swing forms.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'INVALID_SWING_STOP', structuralSwingPrice },
      riskWarning,
    });
  }

  if (rawSlDistance > 3.0 * atrStructure) {
    const ratioAtr = (rawSlDistance / atrStructure).toFixed(2);
    const reason = `Stop would be too wide (${ratioAtr}×ATR exceeds the 3.0×ATR structural maximum).`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 48,
      whyNotTrade: reason,
      reasons: [
        reason,
        `Nearest structural swing at ${structuralSwingPrice.toFixed(dec)} + 0.25×ATR requires ${(rawSlDistance / pipSize).toFixed(1)} pips vs 3×ATR ceiling of ${((3 * atrStructure) / pipSize).toFixed(1)} pips.`,
        'Wait for price to form a closer structural swing before committing risk.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'STOP_TOO_WIDE', rawSlDistance, atrStructure },
      riskWarning,
    });
  }

  const slDistance = Math.max(1.0 * atrStructure, rawSlDistance);
  const stopLoss = parseFloat(
    (htfDirection === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance).toFixed(dec)
  );
  const stopLossPips = parseFloat((slDistance / pipSize).toFixed(1));

  // =========================================================================
  // 8. SPREAD GATE (< 15% of SL distance)
  // =========================================================================
  const defaultSpreadPips =
    input.asset.type === 'CRYPTO' ? 15 : input.asset.type === 'COMMODITY' ? 25 : 1.2;
  const spreadPipsUsed =
    typeof input.spreadPrice === 'number' && input.spreadPrice >= 0
      ? parseFloat((input.spreadPrice / pipSize).toFixed(2))
      : typeof input.spreadPips === 'number' && input.spreadPips >= 0
      ? input.spreadPips
      : defaultSpreadPips;
  const spreadPrice =
    typeof input.spreadPrice === 'number' && input.spreadPrice >= 0
      ? input.spreadPrice
      : spreadPipsUsed * pipSize;

  if (spreadPrice >= 0.15 * slDistance) {
    const spreadSharePct = ((spreadPrice / slDistance) * 100).toFixed(1);
    const reason = `Broker spread (${spreadPipsUsed} pips = ${spreadSharePct}% of stop distance) meets or exceeds 15% of SL distance.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 50,
      whyNotTrade: reason,
      reasons: [
        reason,
        `Minimum affordable SL distance for a ${spreadPipsUsed}-pip spread is ${((spreadPrice / 0.15) / pipSize).toFixed(1)} pips.`,
        'Lower spread or wait for a wider higher-timeframe structure setup.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'SPREAD_TOO_HIGH', spreadPrice, slDistance },
      riskWarning,
    });
  }

  // =========================================================================
  // 9. TARGETS (TP1 & TP2) + R:R >= 1.5 FILTER
  // =========================================================================
  const minClearanceBuffer = 0.2 * atrStructure;
  const rawCandidateLevels: number[] = [
    ...keyLevels.swingHighs,
    ...keyLevels.swingLows,
    ...(keyLevels.pdh ? [keyLevels.pdh] : []),
    ...(keyLevels.pdl ? [keyLevels.pdl] : []),
    ...(keyLevels.pwh ? [keyLevels.pwh] : []),
    ...(keyLevels.pwl ? [keyLevels.pwl] : []),
    ...(keyLevels.dailyPivot
      ? [
          keyLevels.dailyPivot.pivot,
          keyLevels.dailyPivot.r1,
          keyLevels.dailyPivot.r2,
          keyLevels.dailyPivot.s1,
          keyLevels.dailyPivot.s2,
        ]
      : []),
    ...keyLevels.roundNumbers,
  ];

  const opposingDistances = Array.from(
    new Set(
      rawCandidateLevels
        .map((lvl) => (htfDirection === 'BUY' ? lvl - entryPrice : entryPrice - lvl))
        .filter((d) => Number.isFinite(d) && d > minClearanceBuffer)
    )
  ).sort((a, b) => a - b);

  const nearestLevelDist = opposingDistances.length > 0 ? opposingDistances[0] : Infinity;
  const target1R5Dist = 1.5 * slDistance;
  const tp1Dist =
    nearestLevelDist < target1R5Dist
      ? Math.max(slDistance, nearestLevelDist)
      : target1R5Dist;
  const rewardRiskTp1 = parseFloat((tp1Dist / slDistance).toFixed(2));

  if (rewardRiskTp1 < 1.5) {
    const blockingLevelPrice =
      htfDirection === 'BUY' ? entryPrice + nearestLevelDist : entryPrice - nearestLevelDist;
    const reason = `Reward:risk to TP1 (1:${rewardRiskTp1.toFixed(2)}) is below 1.5 due to nearby opposing key level at ${blockingLevelPrice.toFixed(dec)}.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 55,
      whyNotTrade: reason,
      reasons: [
        reason,
        `Proposed SL distance is ${(slDistance / pipSize).toFixed(1)} pips, requiring at least ${(1.5 * slDistance / pipSize).toFixed(1)} pips clear room to TP1.`,
        'Stand aside until price clears the opposing level or pulls back for better asymmetry.',
      ],
      inputsSnapshot: {
        ...indicatorSnapshot,
        blocker: 'RR_BELOW_1_5',
        rewardRiskTp1,
        blockingLevelPrice,
      },
      riskWarning,
    });
  }

  const nextLevelsBeyondTp1 = opposingDistances.filter((d) => d > tp1Dist + 0.35 * slDistance);
  const nextLevelDist = nextLevelsBeyondTp1.length > 0 ? nextLevelsBeyondTp1[0] : Infinity;
  const target2R5Dist = 2.5 * slDistance;
  const tp2Dist = nextLevelDist < target2R5Dist ? nextLevelDist : target2R5Dist;
  const rewardRiskTp2 = parseFloat((tp2Dist / slDistance).toFixed(2));

  const takeProfit1 = parseFloat(
    (htfDirection === 'BUY' ? entryPrice + tp1Dist : entryPrice - tp1Dist).toFixed(dec)
  );
  const takeProfit2 = parseFloat(
    (htfDirection === 'BUY' ? entryPrice + tp2Dist : entryPrice - tp2Dist).toFixed(dec)
  );
  const takeProfit1Pips = parseFloat((tp1Dist / pipSize).toFixed(1));
  const takeProfit2Pips = parseFloat((tp2Dist / pipSize).toFixed(1));

  // =========================================================================
  // 10. POSITION SIZING & QUOTE-TO-ACCOUNT CONVERSION
  // =========================================================================
  const quoteToAccountRate = resolveQuoteToAccountRate({
    quoteCcy: spec.quoteCcy,
    accountCurrency,
    asset: input.asset,
    entryPrice,
    conversionRates: input.conversionRates,
  });

  if (!quoteToAccountRate || quoteToAccountRate <= 0) {
    const reason = `Live ${spec.quoteCcy}->${accountCurrency} conversion rate unavailable to compute safe lot sizing.`;
    return buildWaitMT5Result({
      input,
      nowMs,
      entryPrice,
      accountCurrency,
      riskMoney,
      sessionNote: session.note,
      sessionQuality: session.sessionQuality,
      structureTimeframe,
      rawScore: 55,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Exact position sizing requires an active quote-to-account currency rate.',
        'Provide live conversion quotes or switch account currency to USD.',
      ],
      inputsSnapshot: { ...indicatorSnapshot, blocker: 'MISSING_CONVERSION_RATE', quoteCcy: spec.quoteCcy },
      riskWarning,
    });
  }

  const sizing = calculateMT5PositionSize({
    accountBalance,
    riskPct: effectiveRiskPct,
    slDistancePrice: slDistance,
    spec,
    quoteToAccountRate,
    accountCurrency,
  });

  let accountSizingWarning = sizing.warning;

  // Leverage / required margin check if lot > 0
  if (sizing.lotSize > 0 && accountBalance > 0) {
    const quoteNotionalPerLot = spec.contractSize * entryPrice;
    const notionalInAccount = quoteNotionalPerLot * quoteToAccountRate * sizing.lotSize;
    const requiredMargin = notionalInAccount / leverage;
    if (requiredMargin > accountBalance * 0.9) {
      const marginWarn = `Margin notice: ${sizing.lotSize} lots at 1:${leverage} leverage requires ~${accountCurrency} ${requiredMargin.toFixed(
        2
      )} margin (${((requiredMargin / accountBalance) * 100).toFixed(0)}% of balance).`;
      accountSizingWarning = accountSizingWarning ? `${accountSizingWarning} ${marginWarn}` : marginWarn;
    }
  }

  // =========================================================================
  // 11. STRENGTH, VALIDITY, TRADE MANAGEMENT & COPY ORDER TEXT
  // =========================================================================
  let rawScore = 62;
  if (d1Bias.bias === h4Bias.bias) rawScore += 12;
  if (h1Bias.bias === m15Bias.bias) rawScore += 10;
  if (
    (htfDirection === 'BUY' && m5Bias.bias === 'BULLISH') ||
    (htfDirection === 'SELL' && m5Bias.bias === 'BEARISH')
  ) {
    rawScore += 8;
  }
  if (session.sessionQuality === 'PRIME') rawScore += 6;
  if (rewardRiskTp1 >= 1.5 && rewardRiskTp2 >= 2.4) rawScore += 4;
  rawScore = Math.min(100, rawScore);

  let strength: SignalStrength = 'Medium';
  if (
    rawScore >= 90 &&
    d1Bias.bias === h4Bias.bias &&
    h1Bias.bias === m15Bias.bias &&
    ((htfDirection === 'BUY' && m5Bias.bias === 'BULLISH') ||
      (htfDirection === 'SELL' && m5Bias.bias === 'BEARISH')) &&
    session.sessionQuality !== 'CAUTION'
  ) {
    strength = 'High';
  } else if (rawScore < 74) {
    strength = 'Low';
  }
  if (isSynthetic && strength === 'High') {
    strength = 'Medium';
  }

  const validityCandles = 3;
  const validityMinutes = validityCandles * 5; // 3 M5 entry candles = 15m
  const validUntil = new Date(nowMs + validityMinutes * 60_000).toISOString();
  const validityWindowDesc = `${validityCandles} × M5 candles (${validityMinutes} min)`;
  const invalidationDriftPrice = parseFloat((0.3 * atrStructure).toFixed(dec));
  const invalidationRule = `Expires in ${validityWindowDesc} or if price moves > ${invalidationDriftPrice.toFixed(
    dec
  )} (0.3×ATR) away from entry zone before fill, or breaks structural stop ${stopLoss.toFixed(dec)}.`;

  const oneRPrice = parseFloat(
    (htfDirection === 'BUY' ? entryPrice + slDistance : entryPrice - slDistance).toFixed(dec)
  );
  const tradeManagementNote = `Suggest moving SL to break-even at 1R (${oneRPrice.toFixed(
    dec
  )}) and taking partial profit at TP1 (${takeProfit1.toFixed(dec)}).`;

  const cleanSymbol = (input.asset.name || input.asset.symbol).replace(/\s+/g, '');
  const orderLabel =
    orderKind === 'LIMIT' ? `${htfDirection} LIMIT` : `${htfDirection} MARKET`;
  const lotText = sizing.tooSmallForMinLot
    ? `0 lots (account too small for min ${spec.minLot} lot)`
    : `${sizing.lotSize} lots`;

  const copyOrderText = [
    `${orderLabel} ${cleanSymbol} @ ${entryPrice.toFixed(dec)}`,
    `SL: ${stopLoss.toFixed(dec)} (${stopLossPips} pips)`,
    `TP1: ${takeProfit1.toFixed(dec)} (+${takeProfit1Pips} pips | 1:${rewardRiskTp1.toFixed(2)})`,
    `TP2: ${takeProfit2.toFixed(dec)} (+${takeProfit2Pips} pips | 1:${rewardRiskTp2.toFixed(2)})`,
    `Size: ${lotText} | Risk: ${accountCurrency} ${sizing.riskMoney.toFixed(2)} (${effectiveRiskPct}%)`,
    `Valid: ${validityWindowDesc} | Management: ${tradeManagementNote}`,
  ].join(' | ');

  const rewardRiskRatio = `1:${rewardRiskTp1.toFixed(2)} (TP2 1:${rewardRiskTp2.toFixed(2)})`;

  const reasons: [string, string, string] = [
    `D1 (${d1Bias.bias}) & H4 (${h4Bias.bias}) bias aligned with ${structureTimeframe} structure (ATR ${(atrStructure / pipSize).toFixed(
      1
    )} pips; swing invalidation at ${structuralSwingPrice.toFixed(dec)}).`,
    `M5 entry (${orderKind} @ ${entryPrice.toFixed(dec)}): SL ${stopLoss.toFixed(dec)} (${stopLossPips} pips), TP1 ${takeProfit1.toFixed(
      dec
    )} (1:${rewardRiskTp1.toFixed(2)}), TP2 ${takeProfit2.toFixed(dec)} (1:${rewardRiskTp2.toFixed(2)}).`,
    `${session.sessionName}: ${tradeManagementNote}`,
  ];

  const finalSnapshot: Record<string, unknown> = {
    ...indicatorSnapshot,
    orderKind,
    entryPrice,
    structuralSwingPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    rewardRiskTp1,
    rewardRiskTp2,
    lotSize: sizing.lotSize,
    riskMoney: sizing.riskMoney,
    quoteToAccountRate,
    spreadPipsUsed,
    session,
    rawScore,
  };

  return {
    engine: 'mt5_v1',
    profile: 'MT5',
    platform: input.platform,
    platformName: input.platformName || input.platform,
    asset: input.asset.name,
    symbol: input.asset.symbol,
    direction: htfDirection,
    orderKind,
    entryPrice,
    entryZone,
    stopLoss,
    stopLossPips,
    takeProfit1,
    takeProfit1Pips,
    takeProfit2,
    takeProfit2Pips,
    lotSize: sizing.lotSize,
    riskMoney: sizing.riskMoney,
    accountCurrency,
    rewardRiskTp1,
    rewardRiskTp2,
    rewardRiskRatio,
    validityCandles,
    validityMinutes,
    validityWindowDesc,
    validUntil,
    invalidationLevel: stopLoss,
    invalidationDriftPrice,
    invalidationRule,
    sessionNote: session.note,
    sessionQuality: session.sessionQuality,
    tradeManagementNote,
    copyOrderText,
    strength,
    rawScore: parseFloat(rawScore.toFixed(1)),
    reasons,
    accountSizingWarning,
    riskWarning,
    structureTimeframe,
    timeframe: structureTimeframe,
    createdAt: new Date(nowMs).toISOString(),
    generatedAt: nowMs,
    feedSource: input.feedSource || 'deriv_ws',
    inputsSnapshot: finalSnapshot,
  };
}
