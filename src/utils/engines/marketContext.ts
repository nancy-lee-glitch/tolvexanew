/**
 * marketContext.ts — Transparent, sample-size-annotated Market Context calculations.
 *
 * Computes:
 *  1. Multi-timeframe trend table (M15, H1, H4, D1): direction, strength word, EMA(21) distance & n.
 *  2. Key levels map (PDH/PDL, PWH/PWL, H1 swings, daily pivots PP/R1/R2/S1/S2, round numbers)
 *     in plain English ("price is X pips above/below Y") with exact pip sizes and n.
 *  3. Volatility regime: today's ATR(14) vs trailing 30-day ATR percentile ('quiet' / 'normal' / 'unusually active') + n.
 *  4. Session profile: average H-L range in pips by UTC hour (00..23) over the trailing 8 weeks (from H1 candles) + n.
 *
 * Zero win rates, zero probability estimates, every metric carries its sample size.
 */

import type { AssetConfig, Candle, DailyPivotLevels } from './types.ts';
import {
  calculateATRSeries,
  calculateEMA,
  calculateRSI,
  detectSwingLevels,
} from './indicators.ts';
import {
  computeDailyPivotLevels,
  computeRoundNumbers,
  resolveInstrumentSpec,
} from './mt5Engine.ts';

export type ContextTimeframe = 'M15' | 'H1' | 'H4' | 'D1';
export type TrendDirectionLabel = 'Bullish' | 'Bearish' | 'Neutral';
export type TrendStrengthWord = 'Strong' | 'Moderate' | 'Weak';
export type VolatilityRegimeLabel = 'quiet' | 'normal' | 'unusually active';

export interface TrendTimeframeRow {
  timeframe: ContextTimeframe;
  direction: TrendDirectionLabel;
  strength: TrendStrengthWord;
  ema21: number | null;
  distancePips: number | null;
  distancePct: number | null;
  lastClose: number | null;
  sampleCount: number;
}

export interface KeyLevelMapItem {
  id: string;
  label: string;
  group: 'Daily Range' | 'Weekly Range' | 'Swing' | 'Daily Pivot' | 'Round Number';
  price: number;
  signedPipsFromLevel: number;
  absPipsFromLevel: number;
  relation: 'above' | 'below' | 'at';
  plainText: string;
  sampleCount: number;
}

export interface VolatilityRegimeSummary {
  currentAtr: number | null;
  currentAtrPips: number | null;
  percentile30d: number | null;
  regime: VolatilityRegimeLabel;
  sampleCount: number;
  lookbackTargetDays: number;
}

export interface UtcSessionHourBucket {
  hourUtc: number;
  hourLabel: string;
  avgRangePips: number | null;
  sampleCount: number;
}

export interface UtcSessionProfileSummary {
  lookbackWeeks: number;
  totalBars: number;
  hours: UtcSessionHourBucket[];
  mostActiveHour: UtcSessionHourBucket | null;
  quietestHour: UtcSessionHourBucket | null;
}

export interface MarketContextSummary {
  symbol: string;
  assetName: string;
  pipSize: number;
  decimals: number;
  currentPrice: number;
  computedAtIso: string;
  trendTable: TrendTimeframeRow[];
  levelsMap: KeyLevelMapItem[];
  dailyPivot: DailyPivotLevels | null;
  pivotSampleCount: number;
  volatilityRegime: VolatilityRegimeSummary;
  sessionProfile: UtcSessionProfileSummary;
}

/**
 * Resolves exact pip size for any AssetConfig (including EUR/USD = 0.0001, USD/JPY = 0.01, XAU/USD = 0.01).
 */
export function resolveAssetPipSize(asset: Pick<AssetConfig, 'symbol' | 'name' | 'type' | 'pipSize' | 'decimals'>): {
  pipSize: number;
  decimals: number;
} {
  const spec = resolveInstrumentSpec(asset as AssetConfig);
  const pipSize =
    typeof asset.pipSize === 'number' && Number.isFinite(asset.pipSize) && asset.pipSize > 0
      ? asset.pipSize
      : spec.pipSize;
  const decimals =
    typeof asset.decimals === 'number' && Number.isFinite(asset.decimals)
      ? asset.decimals
      : spec.decimals;
  return { pipSize, decimals };
}

/**
 * Computes distance in pips from `currentPrice` to `levelPrice`, plus plain-language description.
 */
export function formatLevelDistance(
  currentPrice: number,
  levelPrice: number,
  levelLabel: string,
  pipSize: number
): {
  signedPips: number;
  absPips: number;
  relation: 'above' | 'below' | 'at';
  plainText: string;
} {
  const safePip = pipSize > 0 ? pipSize : 0.0001;
  const diff = currentPrice - levelPrice;
  const signedRaw = diff / safePip;
  const absRaw = Math.abs(signedRaw);
  const signedPips = parseFloat(signedRaw.toFixed(1));
  const absPips = parseFloat(absRaw.toFixed(1));

  if (absPips < 0.05) {
    return {
      signedPips: 0,
      absPips: 0,
      relation: 'at',
      plainText: `price is at ${levelLabel}`,
    };
  }

  const relation = signedRaw > 0 ? 'above' : 'below';
  return {
    signedPips,
    absPips,
    relation,
    plainText: `price is ${absPips.toFixed(1)} pips ${relation} ${levelLabel}`,
  };
}

/**
 * Computes trend direction, word strength, and distance from key EMA(21) for one timeframe.
 */
export function computeTrendRow(
  timeframe: ContextTimeframe,
  candles: Candle[],
  pipSize: number,
  overridePrice?: number
): TrendTimeframeRow {
  const sampleCount = candles.length;
  if (sampleCount < 5) {
    const lastClose = sampleCount > 0 ? candles[sampleCount - 1].close : null;
    return {
      timeframe,
      direction: 'Neutral',
      strength: 'Weak',
      ema21: null,
      distancePips: null,
      distancePct: null,
      lastClose,
      sampleCount,
    };
  }

  const closes = candles.map((c) => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, Math.min(50, closes.length));
  const prevEma21 = calculateEMA(closes.slice(0, Math.max(1, closes.length - 3)), 21);
  const rsi14 = calculateRSI(closes, 14);
  const lastClose = closes[closes.length - 1];
  const refPrice =
    typeof overridePrice === 'number' && Number.isFinite(overridePrice) && overridePrice > 0
      ? overridePrice
      : lastClose;

  let direction: TrendDirectionLabel = 'Neutral';
  if (ema9 > ema21 && refPrice >= ema21 && rsi14 >= 48) {
    direction = 'Bullish';
  } else if (ema9 < ema21 && refPrice <= ema21 && rsi14 <= 52) {
    direction = 'Bearish';
  }

  let strength: TrendStrengthWord = 'Weak';
  if (direction === 'Bullish') {
    const stackAligned = ema9 > ema21 && ema21 > ema50 && ema21 >= prevEma21;
    strength = stackAligned && rsi14 >= 55 ? 'Strong' : 'Moderate';
  } else if (direction === 'Bearish') {
    const stackAligned = ema9 < ema21 && ema21 < ema50 && ema21 <= prevEma21;
    strength = stackAligned && rsi14 <= 45 ? 'Strong' : 'Moderate';
  }

  const safePip = pipSize > 0 ? pipSize : 0.0001;
  const distancePips = parseFloat(((refPrice - ema21) / safePip).toFixed(1));
  const distancePct = ema21 !== 0 ? parseFloat((((refPrice - ema21) / ema21) * 100).toFixed(3)) : null;

  return {
    timeframe,
    direction,
    strength,
    ema21,
    distancePips,
    distancePct,
    lastClose: refPrice,
    sampleCount,
  };
}

/**
 * Computes today's D1 ATR(14) vs its trailing 30-day percentile.
 */
export function computeVolatilityRegime(
  d1Candles: Candle[],
  pipSize: number,
  lookbackDays = 30
): VolatilityRegimeSummary {
  const atrSeries = calculateATRSeries(d1Candles, 14);
  if (atrSeries.length === 0) {
    return {
      currentAtr: null,
      currentAtrPips: null,
      percentile30d: null,
      regime: 'normal',
      sampleCount: 0,
      lookbackTargetDays: lookbackDays,
    };
  }

  const window = atrSeries.slice(-lookbackDays);
  const currentAtr = window[window.length - 1];
  const safePip = pipSize > 0 ? pipSize : 0.0001;
  const currentAtrPips = parseFloat((currentAtr / safePip).toFixed(1));

  const belowOrEqual = window.filter((v) => v <= currentAtr).length;
  const percentile30d = parseFloat(((belowOrEqual / window.length) * 100).toFixed(1));

  let regime: VolatilityRegimeLabel = 'normal';
  if (percentile30d < 30) {
    regime = 'quiet';
  } else if (percentile30d > 75) {
    regime = 'unusually active';
  }

  return {
    currentAtr,
    currentAtrPips,
    percentile30d,
    regime,
    sampleCount: window.length,
    lookbackTargetDays: lookbackDays,
  };
}

/**
 * Computes average H1 high-low range in pips per UTC hour (00..23) over the last 8 weeks.
 */
export function computeUtcSessionProfile(
  h1Candles: Candle[],
  pipSize: number,
  referenceEndSec?: number,
  lookbackWeeks = 8
): UtcSessionProfileSummary {
  const safePip = pipSize > 0 ? pipSize : 0.0001;
  const endSec =
    typeof referenceEndSec === 'number' && Number.isFinite(referenceEndSec) && referenceEndSec > 0
      ? referenceEndSec
      : h1Candles.length > 0
      ? h1Candles[h1Candles.length - 1].time
      : Math.floor(Date.now() / 1000);

  const windowSec = lookbackWeeks * 7 * 86400;
  const startSec = endSec - windowSec;

  const filtered = h1Candles.filter((c) => c.time >= startSec && c.time <= endSec);

  const sums = new Array<number>(24).fill(0);
  const counts = new Array<number>(24).fill(0);

  for (const candle of filtered) {
    const hourUtc = new Date(candle.time * 1000).getUTCHours();
    const rangePips = Math.max(0, candle.high - candle.low) / safePip;
    if (Number.isFinite(rangePips) && hourUtc >= 0 && hourUtc < 24) {
      sums[hourUtc] += rangePips;
      counts[hourUtc] += 1;
    }
  }

  const hours: UtcSessionHourBucket[] = [];
  for (let h = 0; h < 24; h++) {
    const sampleCount = counts[h];
    const avgRangePips = sampleCount > 0 ? parseFloat((sums[h] / sampleCount).toFixed(1)) : null;
    hours.push({
      hourUtc: h,
      hourLabel: `${String(h).padStart(2, '0')}:00`,
      avgRangePips,
      sampleCount,
    });
  }

  const populated = hours.filter((b) => b.avgRangePips !== null && b.sampleCount > 0);
  let mostActiveHour: UtcSessionHourBucket | null = null;
  let quietestHour: UtcSessionHourBucket | null = null;

  for (const b of populated) {
    if (!mostActiveHour || (b.avgRangePips ?? 0) > (mostActiveHour.avgRangePips ?? 0)) {
      mostActiveHour = b;
    }
    if (!quietestHour || (b.avgRangePips ?? Infinity) < (quietestHour.avgRangePips ?? Infinity)) {
      quietestHour = b;
    }
  }

  return {
    lookbackWeeks,
    totalBars: filtered.length,
    hours,
    mostActiveHour,
    quietestHour,
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

/**
 * Computes the complete Market Context Summary for the Market Context Panel.
 */
export function computeMarketContext(params: {
  asset: AssetConfig;
  currentPrice?: number | null;
  m15Candles: Candle[];
  h1Candles: Candle[];
  h4Candles: Candle[];
  d1Candles: Candle[];
  nowSec?: number;
}): MarketContextSummary {
  const { pipSize, decimals } = resolveAssetPipSize(params.asset);

  const fallbackClose =
    params.m15Candles[params.m15Candles.length - 1]?.close ??
    params.h1Candles[params.h1Candles.length - 1]?.close ??
    params.h4Candles[params.h4Candles.length - 1]?.close ??
    params.d1Candles[params.d1Candles.length - 1]?.close ??
    0;

  const currentPrice =
    typeof params.currentPrice === 'number' && Number.isFinite(params.currentPrice) && params.currentPrice > 0
      ? params.currentPrice
      : fallbackClose;

  const trendTable: TrendTimeframeRow[] = [
    computeTrendRow('M15', params.m15Candles, pipSize, currentPrice),
    computeTrendRow('H1', params.h1Candles, pipSize, currentPrice),
    computeTrendRow('H4', params.h4Candles, pipSize, currentPrice),
    computeTrendRow('D1', params.d1Candles, pipSize, currentPrice),
  ];

  // Key levels assembly
  const levelsRaw: Array<{
    id: string;
    label: string;
    group: KeyLevelMapItem['group'];
    price: number;
    sampleCount: number;
  }> = [];

  const d1Count = params.d1Candles.length;
  const h1Count = params.h1Candles.length;
  const prevDay = d1Count >= 2 ? params.d1Candles[d1Count - 2] : undefined;

  if (prevDay) {
    levelsRaw.push({ id: 'pdh', label: 'Previous Day High (PDH)', group: 'Daily Range', price: prevDay.high, sampleCount: d1Count });
    levelsRaw.push({ id: 'pdl', label: 'Previous Day Low (PDL)', group: 'Daily Range', price: prevDay.low, sampleCount: d1Count });
  }

  const dailyPivot = computeDailyPivotLevels(prevDay);
  if (dailyPivot) {
    levelsRaw.push({ id: 'pp', label: 'Daily Pivot (PP)', group: 'Daily Pivot', price: dailyPivot.pivot, sampleCount: d1Count });
    levelsRaw.push({ id: 'r1', label: 'Daily Resistance (R1)', group: 'Daily Pivot', price: dailyPivot.r1, sampleCount: d1Count });
    levelsRaw.push({ id: 'r2', label: 'Daily Resistance (R2)', group: 'Daily Pivot', price: dailyPivot.r2, sampleCount: d1Count });
    levelsRaw.push({ id: 's1', label: 'Daily Support (S1)', group: 'Daily Pivot', price: dailyPivot.s1, sampleCount: d1Count });
    levelsRaw.push({ id: 's2', label: 'Daily Support (S2)', group: 'Daily Pivot', price: dailyPivot.s2, sampleCount: d1Count });
  }

  if (d1Count >= 6) {
    const currentWeekKey = getIsoWeekKey(params.d1Candles[d1Count - 1].time);
    const priorWeekBars = params.d1Candles.filter((c) => getIsoWeekKey(c.time) !== currentWeekKey).slice(-7);
    const weekSlice = priorWeekBars.length >= 3 ? priorWeekBars : params.d1Candles.slice(-7, -1);
    if (weekSlice.length > 0) {
      levelsRaw.push({
        id: 'pwh',
        label: 'Previous Week High (PWH)',
        group: 'Weekly Range',
        price: Math.max(...weekSlice.map((c) => c.high)),
        sampleCount: weekSlice.length,
      });
      levelsRaw.push({
        id: 'pwl',
        label: 'Previous Week Low (PWL)',
        group: 'Weekly Range',
        price: Math.min(...weekSlice.map((c) => c.low)),
        sampleCount: weekSlice.length,
      });
    }
  }

  if (h1Count >= 5) {
    const swings = detectSwingLevels(params.h1Candles.slice(-160), pipSize);
    const h1Sample = Math.min(h1Count, 160);
    if (swings.swingHighs.length > 0) {
      const aboveHighs = swings.swingHighs.filter((h) => h >= currentPrice);
      const nearestH = aboveHighs.length > 0 ? Math.min(...aboveHighs) : swings.swingHighs[swings.swingHighs.length - 1];
      levelsRaw.push({
        id: 'swing_h',
        label: 'H1 Swing High',
        group: 'Swing',
        price: nearestH,
        sampleCount: h1Sample,
      });
    }
    if (swings.swingLows.length > 0) {
      const belowLows = swings.swingLows.filter((l) => l <= currentPrice);
      const nearestL = belowLows.length > 0 ? Math.max(...belowLows) : swings.swingLows[swings.swingLows.length - 1];
      levelsRaw.push({
        id: 'swing_l',
        label: 'H1 Swing Low',
        group: 'Swing',
        price: nearestL,
        sampleCount: h1Sample,
      });
    }
  }

  if (currentPrice > 0) {
    const rounds = computeRoundNumbers(currentPrice, { ...params.asset, pipSize, decimals });
    const above = rounds.filter((r) => r >= currentPrice).sort((a, b) => a - b)[0];
    const below = rounds.filter((r) => r < currentPrice).sort((a, b) => b - a)[0];
    if (above) {
      levelsRaw.push({
        id: 'round_above',
        label: `Round Number (${above.toFixed(decimals)})`,
        group: 'Round Number',
        price: above,
        sampleCount: 1,
      });
    }
    if (below) {
      levelsRaw.push({
        id: 'round_below',
        label: `Round Number (${below.toFixed(decimals)})`,
        group: 'Round Number',
        price: below,
        sampleCount: 1,
      });
    }
  }

  const levelsMap: KeyLevelMapItem[] = levelsRaw
    .filter((lvl) => Number.isFinite(lvl.price) && lvl.price > 0)
    .map((lvl) => {
      const dist = formatLevelDistance(currentPrice, lvl.price, lvl.label, pipSize);
      return {
        id: lvl.id,
        label: lvl.label,
        group: lvl.group,
        price: lvl.price,
        signedPipsFromLevel: dist.signedPips,
        absPipsFromLevel: dist.absPips,
        relation: dist.relation,
        plainText: dist.plainText,
        sampleCount: lvl.sampleCount,
      };
    })
    .sort((a, b) => a.absPipsFromLevel - b.absPipsFromLevel);

  const volatilityRegime = computeVolatilityRegime(params.d1Candles, pipSize, 30);
  const sessionProfile = computeUtcSessionProfile(params.h1Candles, pipSize, params.nowSec, 8);

  return {
    symbol: params.asset.symbol,
    assetName: params.asset.name,
    pipSize,
    decimals,
    currentPrice,
    computedAtIso: new Date((params.nowSec ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    trendTable,
    levelsMap,
    dailyPivot,
    pivotSampleCount: d1Count,
    volatilityRegime,
    sessionProfile,
  };
}
