/**
 * PulseTrade Pro - Quantitative Confluence Engine
 *
 * Continuous 24/7 Real-Time Tick & Candle Analysis:
 * - Market Structure Classification (BULLISH / BEARISH / RANGING / NEUTRAL)
 * - Empirical Price Distribution Proxy & Price Momentum Proxy (price/time only — no volume or order book)
 * - Mode A: Binary Quick Expiry (CALL | PUT | WAIT) — delegated to src/utils/engines/binaryEngine.ts
 * - Mode B: MT5 Candle Engine (BUY | SELL | WAIT) — delegated to src/utils/engines/mt5Engine.ts
 */

import type {
  SafeCloseAnalysis,
  MarketStructureType,
  StructureCue,
  ConfluenceFactorItem,
  ConfluenceGateResult,
  AnalysisMode,
  PriceDistributionProxy,
  MultiWindowConfirmation,
  HistoryLearningContext,
  TimestampedTick,
  LiveRegimeInfo,
  SignalStrength,
  AssetConfig,
} from '../types.ts';
import { isSyntheticAsset } from '../services/symbolMap.ts';

export type { TimestampedTick, LiveRegimeInfo };

export interface TickData {
  price: number;
  time: number;
}

export interface TechnicalAudit {
  rsi: number;
  rsiState: 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL' | 'BULLISH_MOMENTUM' | 'BEARISH_MOMENTUM';
  emaFast: number;
  emaSlow: number;
  emaSpread: number;
  emaTrend: 'BULLISH' | 'BEARISH' | 'CROSSOVER_UP' | 'CROSSOVER_DOWN';
  momentumBuyPct: number;
  momentumSellPct: number;
  tickVelocity: number;
  tickAcceleration: number;
  bollingerBandStatus: 'PIERCED_LOWER' | 'PIERCED_UPPER' | 'MIDDLE_EXPANDING' | 'SQUEEZE';
  bollingerPctB: number;
  confluenceScore: number;
  strength: SignalStrength;
  confluenceFactors: string[];
  recheckSteps: string[];
  setupName: string;
  recommendedAction: 'CALL' | 'PUT' | 'WAIT';
}

/**
 * Exponential Moving Average (EMA)
 */
export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) {
    const sum = prices.reduce((acc, val) => acc + val, 0);
    return sum / prices.length;
  }
  const k = 2 / (period + 1);
  const initialSMA = prices.slice(0, period).reduce((acc, val) => acc + val, 0) / period;
  let ema = initialSMA;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Relative Strength Index (RSI)
 */
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length <= period) return 50.0;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return avgGain === 0 ? 50.0 : 100.0;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

/**
 * Moving Average Convergence Divergence (MACD 12, 26, 9)
 */
export function calculateMACD(
  prices: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macdLine: number; signalLine: number; histogram: number } {
  if (prices.length === 0) return { macdLine: 0, signalLine: 0, histogram: 0 };
  const emaFast = calculateEMA(prices, fastPeriod);
  const emaSlow = calculateEMA(prices, slowPeriod);
  const macdLine = parseFloat((emaFast - emaSlow).toFixed(5));

  const macdSeries: number[] = [];
  const minSamples = Math.min(prices.length, 30);
  for (let i = prices.length - minSamples; i < prices.length; i++) {
    const sub = prices.slice(0, i + 1);
    const f = calculateEMA(sub, fastPeriod);
    const s = calculateEMA(sub, slowPeriod);
    macdSeries.push(f - s);
  }
  const signalLine = parseFloat(calculateEMA(macdSeries, signalPeriod).toFixed(5));
  const histogram = parseFloat((macdLine - signalLine).toFixed(5));
  return { macdLine, signalLine, histogram };
}

/**
 * Bollinger Bands
 */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdDevMultiplier: number = 2.0
): { upper: number; middle: number; lower: number; bandwidth: number; pctB: number } {
  const safePeriod = Math.min(period, prices.length);
  const slice = prices.slice(-safePeriod);
  const mean = slice.reduce((a, b) => a + b, 0) / safePeriod;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / safePeriod;
  const stdDev = Math.sqrt(variance);

  const upper = mean + stdDevMultiplier * stdDev;
  const lower = mean - stdDevMultiplier * stdDev;
  const bandwidth = (upper - lower) / (mean || 1);
  const currentPrice = slice[slice.length - 1];
  const pctB = upper === lower ? 0.5 : (currentPrice - lower) / (upper - lower);

  return { upper, middle: mean, lower, bandwidth, pctB };
}

/**
 * Price momentum proxy computed strictly from positive vs negative price deltas.
 */
export function calculatePriceMomentumProxy(
  prices: number[],
  window: number = 20
): { buyPct: number; sellPct: number } {
  if (prices.length < 2) return { buyPct: 50, sellPct: 50 };
  const slice = prices.slice(-Math.min(window, prices.length));
  let upMove = 0;
  let downMove = 0;

  for (let i = 1; i < slice.length; i++) {
    const delta = slice[i] - slice[i - 1];
    if (delta > 0) upMove += delta;
    else if (delta < 0) downMove += Math.abs(delta);
  }

  const total = upMove + downMove;
  if (total === 0) return { buyPct: 50, sellPct: 50 };
  const buyPct = Math.round((upMove / total) * 100);
  return { buyPct, sellPct: 100 - buyPct };
}

/**
 * Tick Velocity & Acceleration
 */
export function calculateVelocityAndAcceleration(
  prices: number[],
  pipsMultiplier: number = 10000
): { velocity: number; acceleration: number } {
  if (prices.length < 3) return { velocity: 0, acceleration: 0 };
  const n = prices.length;
  const v1 = (prices[n - 1] - prices[n - 2]) * pipsMultiplier;
  const v0 = (prices[n - 2] - prices[n - 3]) * pipsMultiplier;
  const velocity = parseFloat(v1.toFixed(3));
  const acceleration = parseFloat((v1 - v0).toFixed(3));
  return { velocity, acceleration };
}

/**
 * Empirical Price Distribution Proxy (price/time histogram only; no volume data).
 * Computes modal dwell level and upper/lower empirical activity boundaries.
 */
export function calculatePriceDistributionProxy(
  prices: number[],
  pipSize: number
): PriceDistributionProxy {
  const safePrices = prices.length > 0 ? prices : [0];
  const rangeHigh = Math.max(...safePrices);
  const rangeLow = Math.min(...safePrices);
  const currentPrice = safePrices[safePrices.length - 1];

  if (rangeHigh === rangeLow) {
    return {
      modePrice: currentPrice,
      valueAreaHigh: currentPrice + 2 * pipSize,
      valueAreaLow: currentPrice - 2 * pipSize,
      highDensityNodePips: 0,
      rangeHigh,
      rangeLow,
    };
  }

  // Create 10 empirical price histogram bins
  const binsCount = 10;
  const binStep = (rangeHigh - rangeLow) / binsCount;
  const bins = new Array(binsCount).fill(0);

  for (const p of safePrices) {
    const idx = Math.min(binsCount - 1, Math.max(0, Math.floor((p - rangeLow) / binStep)));
    bins[idx]++;
  }

  // Find modal price dwell cluster
  let maxCount = -1;
  let modeBinIdx = Math.floor(binsCount / 2);
  for (let i = 0; i < binsCount; i++) {
    if (bins[i] > maxCount) {
      maxCount = bins[i];
      modeBinIdx = i;
    }
  }

  const modePrice = parseFloat((rangeLow + (modeBinIdx + 0.5) * binStep).toFixed(5));
  const vahIdx = Math.min(binsCount - 1, modeBinIdx + 2);
  const valIdx = Math.max(0, modeBinIdx - 2);
  const valueAreaHigh = parseFloat((rangeLow + (vahIdx + 0.5) * binStep).toFixed(5));
  const valueAreaLow = parseFloat((rangeLow + (valIdx + 0.5) * binStep).toFixed(5));
  const highDensityNodePips = parseFloat((Math.abs(currentPrice - modePrice) / pipSize).toFixed(1));

  return {
    modePrice,
    valueAreaHigh,
    valueAreaLow,
    highDensityNodePips,
    rangeHigh,
    rangeLow,
  };
}

export interface SessionAdvisorInfo {
  sessionName: string;
  utcTime: string;
  localTimeHint: string;
  quality: 'PRIME' | 'NORMAL' | 'CAUTION' | 'THIN';
  note: string;
  isWeakSession: boolean;
}

/**
 * Session Activity Advisor (UTC aligned):
 * Evaluates active market hours and spread risks.
 */
export function getSessionAdvisor(symbol: string = 'EUR/USD'): SessionAdvisorInfo {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDay = now.getUTCDay(); // 0 is Sunday, 5 is Friday, 6 is Saturday
  const utcTimeStr = `${String(utcHour).padStart(2, '0')}:${String(utcMinute).padStart(2, '0')} UTC`;
  
  let localTimeHint = '';
  try {
    localTimeHint = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    localTimeHint = '';
  }

  const isMajorForex = /EUR|GBP|USD|CAD|CHF|JPY/i.test(symbol);
  const isWeekend = utcDay === 0 || (utcDay === 6 && utcHour >= 0);
  const isLateFriday = utcDay === 5 && utcHour >= 19;

  // 1. Weekend / Late Friday
  if (isWeekend || isLateFriday) {
    if (isMajorForex) {
      return {
        sessionName: 'Weekend / Market Closed',
        utcTime: utcTimeStr,
        localTimeHint,
        quality: 'THIN',
        note: 'Forex markets are closed or entering thin liquidity. Switch to 24/7 crypto for live spot sessions (synthetics are practice only).',
        isWeakSession: true,
      };
    }
  }

  // 2. London / NY Overlap (~12:00–17:00 UTC)
  if (utcHour >= 12 && utcHour < 17) {
    return {
      sessionName: 'London / NY Overlap',
      utcTime: utcTimeStr,
      localTimeHint,
      quality: 'PRIME',
      note: 'Peak multi-session participation and clearer directional continuation for EUR/USD, GBP/USD, and majors.',
      isWeakSession: false,
    };
  }

  // 3. London Open & Morning (~07:00–11:00 UTC)
  if (utcHour >= 7 && utcHour < 11) {
    const isFirst15Min = utcHour === 7 && utcMinute <= 15;
    if (isFirst15Min) {
      return {
        sessionName: 'London Open (Opening 15m)',
        utcTime: utcTimeStr,
        localTimeHint,
        quality: 'CAUTION',
        note: 'First 10–15 min after London open has erratic spread adjustments. Allow initial range to settle.',
        isWeakSession: true,
      };
    }
    return {
      sessionName: 'London Morning Session',
      utcTime: utcTimeStr,
      localTimeHint,
      quality: 'PRIME',
      note: 'Active session momentum for EUR/USD, GBP/USD, and cross pairs with clearer multi-candle follow-through.',
      isWeakSession: false,
    };
  }

  // 4. NY Afternoon (~17:00–21:00 UTC)
  if (utcHour >= 17 && utcHour < 21) {
    return {
      sessionName: 'NY Afternoon Session',
      utcTime: utcTimeStr,
      localTimeHint,
      quality: 'NORMAL',
      note: 'Moderate activity. European desks closed; momentum slows toward close.',
      isWeakSession: false,
    };
  }

  // 5. Thin Liquidity Window (~21:00–23:00 UTC)
  if (utcHour >= 21 && utcHour <= 23) {
    return {
      sessionName: 'Session Rollover / Thin Liquidity',
      utcTime: utcTimeStr,
      localTimeHint,
      quality: 'THIN',
      note: 'Thin interbank liquidity between NY close and Tokyo open. Spreads widen; 30s–1m short expiries subject to random tick noise.',
      isWeakSession: true,
    };
  }

  // 6. Asian Session (~00:00–07:00 UTC)
  return {
    sessionName: 'Asian (Tokyo / Sydney) Session',
    utcTime: utcTimeStr,
    localTimeHint,
    quality: 'CAUTION',
    note: 'Asian session is predominantly mean-reverting range on EUR/USD and GBP pairs. Short expiries less directional; favor higher timeframes or pause for London open.',
    isWeakSession: isMajorForex,
  };
}

/**
 * Real Live Market Regime Classifier (Fix 6)
 *
 * Uses live tick buffers (volatility, range, efficiency ratio / drift vs chop)
 * instead of clock-only assertions. Never shows "Safe to trade" if live path is choppy.
 */
export function evaluateLiveMarketRegime(
  symbol: string = 'frxEURUSD',
  pipSize: number = 0.0001
): LiveRegimeInfo {
  const session = getSessionAdvisor(symbol);
  const pipsMultiplier = 1 / pipSize;
  const rawTicks = getAssetTicks(symbol);
  const ticks = rawTicks.length >= 6
    ? rawTicks
    : getOrInitializeAssetTicks(symbol, 1.0850, pipSize, 5, 35);

  const len = ticks.length;
  if (len < 6) {
    return {
      regime: 'THIN',
      badgeLabel: 'Live regime: Thin liquidity — trade with caution',
      subText: 'Buffering live tick feed from WebSocket.',
      color: 'bg-slate-900/90',
      dotColor: 'bg-amber-400',
      borderColor: 'border-amber-500/40',
      textColor: 'text-amber-300',
      utcSession: session.sessionName,
      volatilityPips: 0,
      efficiencyRatio: 0,
    };
  }

  const slice = ticks.slice(-Math.min(len, 25));
  const netDisplacement = Math.abs(slice[slice.length - 1] - slice[0]) * pipsMultiplier;

  let grossDistance = 0;
  for (let i = 1; i < slice.length; i++) {
    grossDistance += Math.abs(slice[i] - slice[i - 1]) * pipsMultiplier;
  }

  const efficiencyRatio = grossDistance > 0 ? parseFloat((netDisplacement / grossDistance).toFixed(3)) : 0;
  const avgStep = grossDistance / (slice.length - 1);
  const volatilityPips = parseFloat(grossDistance.toFixed(1));

  // 1. Spiky / high volatility regime
  if (avgStep > 1.35) {
    return {
      regime: 'HIGH_VOLATILITY',
      badgeLabel: 'Live regime: High volatility — reduce size / WAIT',
      subText: `Rapid micro-displacement (${avgStep.toFixed(2)} p/step). Wide spreads expected.`,
      color: 'bg-rose-950/80',
      dotColor: 'bg-rose-400 animate-pulse',
      borderColor: 'border-rose-500/40',
      textColor: 'text-rose-300',
      utcSession: session.sessionName,
      volatilityPips,
      efficiencyRatio,
    };
  }

  // 2. Mean-reverting chop regime (ping-pong without clean displacement)
  if (efficiencyRatio < 0.28) {
    return {
      regime: 'CHOP',
      badgeLabel: 'Live regime: Chop / mixed — prefer WAIT',
      subText: `Low directional follow-through (${Math.round(efficiencyRatio * 100)}% efficiency). Sideways consolidation.`,
      color: 'bg-amber-950/80',
      dotColor: 'bg-amber-400 animate-pulse',
      borderColor: 'border-amber-500/40',
      textColor: 'text-amber-300',
      utcSession: session.sessionName,
      volatilityPips,
      efficiencyRatio,
    };
  }

  // 3. Directional regime
  return {
    regime: 'DIRECTIONAL',
    badgeLabel: 'Live regime: Directional — cleaner setups',
    subText: `Strong directional persistence (${Math.round(efficiencyRatio * 100)}% efficiency). Favorable impulse alignment.`,
    color: 'bg-emerald-950/80',
    dotColor: 'bg-emerald-400 animate-pulse',
    borderColor: 'border-emerald-500/40',
    textColor: 'text-emerald-300',
    utcSession: session.sessionName,
    volatilityPips,
    efficiencyRatio,
  };
}

/**
 * 1) MARKET STRUCTURE CLASSIFIER
 * Analyzes local swing highs and swing lows across the real tick buffer.
 * Output: BULLISH (HH/HL) | BEARISH (LH/LL) | RANGING / NEUTRAL
 */
export function detectMarketStructure(
  prices: number[],
  pipSize: number
): {
  structure: MarketStructureType;
  cue: StructureCue;
  summary: string;
  swingHigh: number;
  swingLow: number;
  recentRangePips: number;
} {
  if (!prices || prices.length < 8) {
    const curr = prices && prices.length > 0 ? prices[prices.length - 1] : 1.08500;
    return {
      structure: 'NEUTRAL',
      cue: 'INSUFFICIENT_DATA',
      summary: 'Insufficient tick data to audit market structure (requires >= 8 ticks)',
      swingHigh: curr,
      swingLow: curr,
      recentRangePips: 0,
    };
  }

  const safePrices = prices.slice(-40);
  const currentPrice = safePrices[safePrices.length - 1];
  const maxPrice = Math.max(...safePrices);
  const minPrice = Math.min(...safePrices);
  const recentRangePips = parseFloat(((maxPrice - minPrice) / pipSize).toFixed(1));

  // If price is completely flat or range is negligible
  if (recentRangePips < 1.0) {
    return {
      structure: 'RANGING',
      cue: 'COMPRESSION',
      summary: `Extreme Compression (${recentRangePips} pips range) — Volatility too low for reliable expansion`,
      swingHigh: maxPrice,
      swingLow: minPrice,
      recentRangePips,
    };
  }

  // Partition prices into two halves to compare local extremes
  const half = Math.floor(safePrices.length / 2);
  const firstHalf = safePrices.slice(0, half);
  const secondHalf = safePrices.slice(half);

  const sh1 = Math.max(...firstHalf);
  const sl1 = Math.min(...firstHalf);
  const sh2 = Math.max(...secondHalf);
  const sl2 = Math.min(...secondHalf);

  const isHH = sh2 > sh1 + (0.2 * pipSize);
  const isHL = sl2 > sl1 + (0.1 * pipSize);
  const isLH = sh2 < sh1 - (0.2 * pipSize);
  const isLL = sl2 < sl1 - (0.1 * pipSize);

  // Structural HH / HL check
  if (isHH && isHL && currentPrice >= (minPrice + maxPrice) * 0.48) {
    return {
      structure: 'BULLISH',
      cue: 'HH_HL',
      summary: `Bullish Structure (HH/HL confirmed: Higher High @ ${sh2.toFixed(5)}, Higher Low @ ${sl2.toFixed(5)})`,
      swingHigh: maxPrice,
      swingLow: minPrice,
      recentRangePips,
    };
  }

  // Structural LH / LL check
  if (isLH && isLL && currentPrice <= (minPrice + maxPrice) * 0.52) {
    return {
      structure: 'BEARISH',
      cue: 'LH_LL',
      summary: `Bearish Structure (LH/LL confirmed: Lower High @ ${sh2.toFixed(5)}, Lower Low @ ${sl2.toFixed(5)})`,
      swingHigh: maxPrice,
      swingLow: minPrice,
      recentRangePips,
    };
  }

  // Trend slope check across full buffer
  const firstPrice = safePrices[0];
  const deltaPips = (currentPrice - firstPrice) / pipSize;

  if (deltaPips > 3.0) {
    return {
      structure: 'BULLISH',
      cue: 'EXPANSION',
      summary: `Bullish Trend Expansion (+${deltaPips.toFixed(1)} pips upward displacement)`,
      swingHigh: maxPrice,
      swingLow: minPrice,
      recentRangePips,
    };
  } else if (deltaPips < -3.0) {
    return {
      structure: 'BEARISH',
      cue: 'EXPANSION',
      summary: `Bearish Trend Expansion (${deltaPips.toFixed(1)} pips downward displacement)`,
      swingHigh: maxPrice,
      swingLow: minPrice,
      recentRangePips,
    };
  }

  return {
    structure: 'RANGING',
    cue: 'RANGE_CONSOLIDATION',
    summary: `Equilibrium Range (${recentRangePips} pips band) — Consolidating between ${minPrice.toFixed(5)} and ${maxPrice.toFixed(5)}`,
    swingHigh: maxPrice,
    swingLow: minPrice,
    recentRangePips,
  };
}

/**
 * 2A) MODE A — QUICK CONFLUENCE GATE (ExpertOption / Deriv Short Expiry)
 * Soft Gate Policy:
 * 1. Hard Required: Symbol, Timeframe, minimum tick buffer (>= 8 ticks)
 * 2. Core (Must agree for actionable CALL/PUT):
 *    - Micro structure bias (Bullish or Bearish; if chop -> WAIT)
 *    - EMA fast/slow alignment with that bias
 * 3. Soft Filters (Improve quality, but single soft FAIL does NOT force WAIT if Core is strong)
 */
export interface LiveMovementEvaluation {
  netPipsDelta: number;
  recentTicksDelta: number;
  direction: 'BULLISH' | 'BEARISH' | 'FLAT';
  isConflictingWith: (proposed: 'CALL' | 'PUT') => boolean;
  conflictMessage: string;
  summary: string;
}

/**
 * Measures real-time short-horizon micro-movement from the latest live tick buffer.
 * Enforces: Never buy into an active drop, and never sell into an active rally.
 */
export function evaluateLiveMarketMovement(
  prices: number[],
  pipSize: number
): LiveMovementEvaluation {
  const pipsMultiplier = 1 / pipSize;
  if (!prices || prices.length < 4) {
    return {
      netPipsDelta: 0,
      recentTicksDelta: 0,
      direction: 'FLAT',
      isConflictingWith: () => false,
      conflictMessage: '',
      summary: 'Insufficient tick data to evaluate live movement.',
    };
  }

  const currentPrice = prices[prices.length - 1];
  const sampleWindow = Math.min(prices.length, 8);
  const startPrice = prices[prices.length - sampleWindow];
  const netPipsDelta = parseFloat(((currentPrice - startPrice) * pipsMultiplier).toFixed(2));

  // Immediate 3-tick micro movement
  const last3 = prices.slice(-3);
  const recentTicksDelta = parseFloat(((last3[last3.length - 1] - last3[0]) * pipsMultiplier).toFixed(2));

  let direction: 'BULLISH' | 'BEARISH' | 'FLAT' = 'FLAT';
  if (netPipsDelta >= 0.15 && recentTicksDelta >= -0.05) {
    direction = 'BULLISH';
  } else if (netPipsDelta <= -0.15 && recentTicksDelta <= 0.05) {
    direction = 'BEARISH';
  } else {
    direction = 'FLAT';
  }

  const isConflictingWith = (proposed: 'CALL' | 'PUT'): boolean => {
    if (proposed === 'CALL') {
      return netPipsDelta < -0.2 || (recentTicksDelta < -0.15 && netPipsDelta <= 0);
    }
    if (proposed === 'PUT') {
      return netPipsDelta > 0.2 || (recentTicksDelta > 0.15 && netPipsDelta >= 0);
    }
    return false;
  };

  const getConflictMessage = (proposed: 'CALL' | 'PUT'): string => {
    if (proposed === 'CALL') {
      return `Live price is actively falling (${netPipsDelta} pips across last ${sampleWindow} ticks) directly opposing bullish bias. Never buy into an active drop.`;
    }
    return `Live price is actively climbing (+${netPipsDelta} pips across last ${sampleWindow} ticks) directly opposing bearish bias. Never sell into an active rally.`;
  };

  return {
    netPipsDelta,
    recentTicksDelta,
    direction,
    isConflictingWith,
    conflictMessage: getConflictMessage('CALL'),
    summary:
      direction === 'BULLISH'
        ? `Live price advancing (+${netPipsDelta} pips)`
        : direction === 'BEARISH'
        ? `Live price retreating (${netPipsDelta} pips)`
        : `Live micro movement is flat (${netPipsDelta >= 0 ? '+' : ''}${netPipsDelta} pips)`,
  };
}

/**
 * 2A) MODE A — QUICK CONFLUENCE GATE (ExpertOption / Deriv Style)
 * Soft Gate Policy:
 * 1. Hard Required: Symbol, Timeframe, minimum tick buffer (>= 8 ticks)
 * 2. Core (Must agree for actionable CALL/PUT):
 *    - Micro structure bias (Bullish or Bearish; if chop -> WAIT)
 *    - Live tick path agreement (price must NOT be actively moving opposite to bias)
 *    - EMA fast/slow alignment with that bias
 * 3. Soft Filters (Improve quality, but single soft FAIL does NOT force WAIT if Core is strong):
 *    - RSI momentum calibration (flag WARN/FAIL, but does NOT alone block trade)
 *    - Volatility regime (only dead market forces WAIT)
 * 4. Context Rows:
 *    - Liquidity sweep, FVG, Price momentum proxy: Show as CONTEXT only (informational), NOT hard blockers on Mode A!
 */
export function evaluateQuickConfluence(params: {
  prices: number[];
  structure: MarketStructureType;
  structureCue: StructureCue;
  pipSize: number;
  rsi: number;
  ema9: number;
  ema21: number;
  emaSpread: number;
  momentumBuyPct: number;
  momentumSellPct: number;
  velocity: number;
}): ConfluenceGateResult {
  const {
    prices,
    structure,
    structureCue,
    pipSize,
    rsi,
    ema9,
    ema21,
    emaSpread,
    momentumBuyPct,
    momentumSellPct,
    velocity,
  } = params;

  const safePrices = prices.slice(-30);
  const currentPrice = safePrices[safePrices.length - 1];
  const factors: ConfluenceFactorItem[] = [];
  const failReasons: string[] = [];

  // Buffer check
  if (prices.length < 8) {
    return {
      passed: false,
      blocked: true,
      blockedReason: 'Minimum 8 ticks required for micro structure analysis',
      mode: 'quick',
      structure: 'NEUTRAL',
      structureCue: 'INSUFFICIENT_DATA',
      structureSummary: 'Analysis Blocked: Insufficient price history',
      factors: [],
      allFactorsPassed: false,
      corePassed: false,
      failReasons: ['Insufficient ticks in stream buffer'],
    };
  }

  // Factor 0: Live Price Path Confirmation (CORE)
  const liveMovement = evaluateLiveMarketMovement(safePrices, pipSize);
  let livePathStatus: 'PASS' | 'FAIL' | 'UNSURE' = 'FAIL';
  let livePathDetail = '';

  if (structure === 'BULLISH') {
    if (liveMovement.isConflictingWith('CALL')) {
      livePathStatus = 'FAIL';
      livePathDetail = `Live ticks falling (${liveMovement.netPipsDelta} pips in last 8 ticks); directly opposes CALL`;
      failReasons.push(`Live tick path conflict: price is dropping (${liveMovement.netPipsDelta} pips) against bullish indicators.`);
    } else if (liveMovement.direction === 'BULLISH' || (liveMovement.netPipsDelta >= 0 && liveMovement.recentTicksDelta >= 0)) {
      livePathStatus = 'PASS';
      livePathDetail = `Live tick path confirms upward advance (+${liveMovement.netPipsDelta} pips in 8 ticks)`;
    } else {
      livePathStatus = 'UNSURE';
      livePathDetail = `Live tick path is neutral/flattening (${liveMovement.netPipsDelta >= 0 ? '+' : ''}${liveMovement.netPipsDelta} pips)`;
    }
  } else if (structure === 'BEARISH') {
    if (liveMovement.isConflictingWith('PUT')) {
      livePathStatus = 'FAIL';
      livePathDetail = `Live ticks rising (+${liveMovement.netPipsDelta} pips in last 8 ticks); directly opposes PUT`;
      failReasons.push(`Live tick path conflict: price is rallying (+${liveMovement.netPipsDelta} pips) against bearish indicators.`);
    } else if (liveMovement.direction === 'BEARISH' || (liveMovement.netPipsDelta <= 0 && liveMovement.recentTicksDelta <= 0)) {
      livePathStatus = 'PASS';
      livePathDetail = `Live tick path confirms downward pressure (${liveMovement.netPipsDelta} pips in 8 ticks)`;
    } else {
      livePathStatus = 'UNSURE';
      livePathDetail = `Live tick path is neutral/flattening (${liveMovement.netPipsDelta >= 0 ? '+' : ''}${liveMovement.netPipsDelta} pips)`;
    }
  } else {
    livePathStatus = 'FAIL';
    livePathDetail = `Ranging structure — no clear live tick momentum`;
  }

  factors.push({
    id: 'live_path',
    name: 'Live Market Path Confirmation',
    status: livePathStatus,
    detail: livePathDetail,
    severity: 'CORE',
    isAdvanced: false,
  });

  // Factor 1: EMA Alignment (CORE)
  let emaStatus: 'PASS' | 'FAIL' | 'UNSURE' = 'FAIL';
  let emaDetail = '';
  if (structure === 'BULLISH') {
    if (ema9 >= ema21 || (currentPrice >= ema21 && velocity >= 0)) {
      emaStatus = 'PASS';
      emaDetail = `EMA 9 (${ema9.toFixed(5)}) >= EMA 21 (${ema21.toFixed(5)}) supporting upward impulse`;
    } else if (Math.abs(emaSpread) < 0.1) {
      emaStatus = 'UNSURE';
      emaDetail = `EMA spread tight (${emaSpread.toFixed(1)} pips); momentum building`;
    } else {
      emaStatus = 'FAIL';
      emaDetail = `EMA 9 lagging below EMA 21 against bullish structure`;
    }
  } else if (structure === 'BEARISH') {
    if (ema9 <= ema21 || (currentPrice <= ema21 && velocity <= 0)) {
      emaStatus = 'PASS';
      emaDetail = `EMA 9 (${ema9.toFixed(5)}) <= EMA 21 (${ema21.toFixed(5)}) supporting downward pressure`;
    } else if (Math.abs(emaSpread) < 0.1) {
      emaStatus = 'UNSURE';
      emaDetail = `EMA spread tight (${emaSpread.toFixed(1)} pips); momentum building`;
    } else {
      emaStatus = 'FAIL';
      emaDetail = `EMA 9 tracking above EMA 21 against bearish structure`;
    }
  } else {
    emaStatus = 'FAIL';
    emaDetail = `Structure is consolidating without directional moving average expansion`;
  }

  factors.push({
    id: 'ema',
    name: 'EMA Alignment & Momentum Bias',
    status: emaStatus,
    detail: emaDetail,
    severity: 'CORE',
    isAdvanced: false,
  });

  // Factor 2: RSI Momentum Calibration (SOFT FILTER - does NOT alone block Quick)
  let rsiStatus: 'PASS' | 'FAIL' | 'UNSURE' | 'WARN' = 'PASS';
  let rsiDetail = '';
  if (structure === 'BULLISH') {
    if (rsi >= 38 && rsi <= 72) {
      rsiStatus = 'PASS';
      rsiDetail = `RSI at ${rsi.toFixed(1)} — Favorable bullish continuation zone`;
    } else if (rsi < 38) {
      rsiStatus = 'PASS';
      rsiDetail = `RSI at ${rsi.toFixed(1)} — Oversold mean-reversion bounce aligned with call`;
    } else {
      rsiStatus = 'WARN';
      rsiDetail = `RSI at ${rsi.toFixed(1)} — Elevated reading; short expiry risk of momentary pullbacks`;
    }
  } else if (structure === 'BEARISH') {
    if (rsi >= 28 && rsi <= 62) {
      rsiStatus = 'PASS';
      rsiDetail = `RSI at ${rsi.toFixed(1)} — Favorable bearish pressure zone`;
    } else if (rsi > 62) {
      rsiStatus = 'PASS';
      rsiDetail = `RSI at ${rsi.toFixed(1)} — Overbought supply rejection aligned with put`;
    } else {
      rsiStatus = 'WARN';
      rsiDetail = `RSI at ${rsi.toFixed(1)} — Deep oversold; watch for temporary bounce`;
    }
  } else {
    rsiStatus = 'WARN';
    rsiDetail = `RSI at ${rsi.toFixed(1)} — Oscillating in chop without structural anchor`;
  }

  factors.push({
    id: 'rsi',
    name: 'RSI Momentum Calibration',
    status: rsiStatus,
    detail: rsiDetail,
    severity: 'SOFT',
    isAdvanced: false,
  });

  // Factor 3: Volatility & Velocity Regime (SOFT FILTER)
  let volRegimeStatus: 'PASS' | 'FAIL' | 'UNSURE' | 'WARN' = 'PASS';
  let volRegimeDetail = '';
  const absVelocity = Math.abs(velocity);

  if (absVelocity < 0.015 && momentumBuyPct === 50 && momentumSellPct === 50) {
    volRegimeStatus = 'WARN';
    volRegimeDetail = `Market stagnant (velocity: ${velocity.toFixed(3)} p/s); low tick flow increases expiry chop`;
  } else if (absVelocity >= 0.04) {
    volRegimeStatus = 'PASS';
    volRegimeDetail = `Dynamic tick velocity (${velocity > 0 ? '+' : ''}${velocity.toFixed(2)} p/s) active for short window`;
  } else {
    volRegimeStatus = 'PASS';
    volRegimeDetail = `Normal tick volatility (${velocity.toFixed(2)} p/s); standard activity`;
  }

  factors.push({
    id: 'volatility',
    name: 'Micro Volatility & Velocity Regime',
    status: volRegimeStatus,
    detail: volRegimeDetail,
    severity: 'SOFT',
    isAdvanced: false,
  });

  // Factor 4: Price momentum proxy (CONTEXT ONLY - NOT a hard blocker)
  let momentumStatus: 'PASS' | 'FAIL' | 'UNSURE' = 'UNSURE';
  let momentumDetail = '';
  if (structure === 'BULLISH') {
    if (momentumBuyPct >= 52) {
      momentumStatus = 'PASS';
      momentumDetail = `Upward tick-delta pressure: ${momentumBuyPct}% positive delta`;
    } else {
      momentumStatus = 'UNSURE';
      momentumDetail = `Price momentum proxy balanced (${momentumBuyPct}% Up / ${momentumSellPct}% Down)`;
    }
  } else if (structure === 'BEARISH') {
    if (momentumSellPct >= 52) {
      momentumStatus = 'PASS';
      momentumDetail = `Downward tick-delta pressure: ${momentumSellPct}% negative delta`;
    } else {
      momentumStatus = 'UNSURE';
      momentumDetail = `Price momentum proxy balanced (${momentumBuyPct}% Up / ${momentumSellPct}% Down)`;
    }
  } else {
    momentumStatus = 'UNSURE';
    momentumDetail = `Equilibrium price momentum proxy distribution`;
  }

  factors.push({
    id: 'price_momentum',
    name: 'Price momentum proxy',
    status: momentumStatus,
    detail: momentumDetail,
    severity: 'CONTEXT',
    isAdvanced: false,
  });

  // Factor 5: Swing Support/Resistance Rebound (CONTEXT ONLY - NOT a hard blocker on Quick)
  let sweepStatus: 'PASS' | 'FAIL' | 'UNSURE' = 'UNSURE';
  let sweepDetail = '';
  const recentSlice = safePrices.slice(-8);
  const recentMin = Math.min(...recentSlice);
  const recentMax = Math.max(...recentSlice);

  if (structure === 'BULLISH' && currentPrice > recentMin + (0.25 * pipSize)) {
    sweepStatus = 'PASS';
    sweepDetail = `Support bounce off ${recentMin.toFixed(5)} confirmed`;
  } else if (structure === 'BEARISH' && currentPrice < recentMax - (0.25 * pipSize)) {
    sweepStatus = 'PASS';
    sweepDetail = `Resistance rejection off ${recentMax.toFixed(5)} confirmed`;
  } else {
    sweepStatus = 'UNSURE';
    sweepDetail = `Continuous micro progression; no acute rejection wick`;
  }

  factors.push({
    id: 'liquidity_sweep',
    name: 'Key Level Rejection Check',
    status: sweepStatus,
    detail: sweepDetail,
    severity: 'CONTEXT',
    isAdvanced: false,
  });

  // Factor 6: Displacement Gap / Imbalance (CONTEXT ONLY - NOT a hard blocker on Quick)
  let fvgStatus: 'PASS' | 'FAIL' | 'UNSURE' = 'UNSURE';
  let fvgDetail = '';
  let bullishGap = false;
  let bearishGap = false;
  for (let i = 2; i < safePrices.length; i++) {
    if (safePrices[i] - safePrices[i - 2] > 0.6 * pipSize) bullishGap = true;
    else if (safePrices[i - 2] - safePrices[i] > 0.6 * pipSize) bearishGap = true;
  }

  if (structure === 'BULLISH' && bullishGap) {
    fvgStatus = 'PASS';
    fvgDetail = `Bullish displacement momentum supporting upward hold`;
  } else if (structure === 'BEARISH' && bearishGap) {
    fvgStatus = 'PASS';
    fvgDetail = `Bearish displacement momentum supporting downward hold`;
  } else {
    fvgStatus = 'UNSURE';
    fvgDetail = `Standard continuous tick progression`;
  }

  factors.push({
    id: 'fvg',
    name: 'Fair Value Gap (FVG Context)',
    status: fvgStatus,
    detail: fvgDetail,
    severity: 'CONTEXT',
    isAdvanced: false,
  });

  // QUICK GATE DECISION:
  const isDirectional = structure === 'BULLISH' || structure === 'BEARISH';
  const corePassed = isDirectional && emaStatus === 'PASS' && livePathStatus === 'PASS';
  const isVolDead = volRegimeStatus === 'WARN' && absVelocity < 0.01;

  let passed = false;
  if (!isDirectional) {
    failReasons.push('Market structure is currently ranging/consolidating in chop without directional bias.');
  } else if (livePathStatus !== 'PASS') {
    failReasons.push(`Live tick movement conflict: ${livePathDetail}`);
  } else if (emaStatus !== 'PASS') {
    failReasons.push(`EMA trend not aligned with micro ${structure.toLowerCase()} bias (${emaDetail}).`);
  } else if (isVolDead) {
    failReasons.push('Tick volatility is dead — high risk of expiry freeze or coin-flip chop.');
  } else {
    passed = true;
  }

  const allFactorsPassed = factors.every((f) => f.status === 'PASS');

  return {
    passed,
    blocked: false,
    mode: 'quick',
    structure,
    structureCue,
    structureSummary: structure === 'BULLISH' ? 'Bullish Structure' : structure === 'BEARISH' ? 'Bearish Structure' : 'Ranging / Neutral Structure',
    factors,
    allFactorsPassed,
    corePassed,
    failReasons,
  };
}

/**
 * Common entry point for live tick quick-confluence telemetry bar.
 * Note: MT5 signals run strictly on the candle-based engine in src/utils/engines/mt5Engine.ts.
 */
export function evaluateConfluenceGate(params: {
  prices: number[];
  structure: MarketStructureType;
  structureCue: StructureCue;
  pipSize: number;
  rsi: number;
  ema9: number;
  ema21: number;
  emaSpread: number;
  momentumBuyPct: number;
  momentumSellPct: number;
  velocity: number;
  mode?: AnalysisMode;
}): ConfluenceGateResult {
  return evaluateQuickConfluence(params);
}

/**
 * Multi-indicator quantitative confluence audit (Identical for Free and VIP users)
 */
export function analyzeMarketConfluence(
  prices: number[],
  activeTimeframe: string = '1m',
  pipSize: number = 0.0001,
  _isVIP: boolean = false,
  mode?: AnalysisMode,
  assetOrSymbol?: string | AssetConfig
): TechnicalAudit {
  if (!prices || prices.length < 2) {
    return {
      rsi: 50,
      rsiState: 'NEUTRAL',
      emaFast: 0,
      emaSlow: 0,
      emaSpread: 0,
      emaTrend: 'BULLISH',
      momentumBuyPct: 50,
      momentumSellPct: 50,
      tickVelocity: 0,
      tickAcceleration: 0,
      bollingerBandStatus: 'MIDDLE_EXPANDING',
      bollingerPctB: 0.5,
      confluenceScore: 0,
      strength: 'Low',
      confluenceFactors: ['Awaiting verified market price ticks'],
      recheckSteps: ['Waiting for live price ticks to accumulate'],
      setupName: 'Awaiting Data',
      recommendedAction: 'WAIT',
    };
  }

  const safePrices = prices;
  const pipsMultiplier = 1 / pipSize;

  const ema9 = calculateEMA(safePrices, 9);
  const ema21 = calculateEMA(safePrices, 21);
  const emaSpread = (ema9 - ema21) * pipsMultiplier;

  const rsi = calculateRSI(safePrices, 14);
  const bb = calculateBollingerBands(safePrices, 20, 2.0);
  const momentum = calculatePriceMomentumProxy(safePrices, 20);
  const { velocity, acceleration } = calculateVelocityAndAcceleration(safePrices, pipsMultiplier);

  const structureResult = detectMarketStructure(safePrices, pipSize);

  const effectiveMode: AnalysisMode =
    mode ||
    (['30s', '1m', '2m', '3m', '5m', '15m'].includes(activeTimeframe) ? 'quick' : 'mt5');

  const gateResult = evaluateConfluenceGate({
    prices: safePrices,
    structure: structureResult.structure,
    structureCue: structureResult.cue,
    pipSize,
    rsi,
    ema9,
    ema21,
    emaSpread,
    momentumBuyPct: momentum.buyPct,
    momentumSellPct: momentum.sellPct,
    velocity,
    mode: effectiveMode,
  });

  let rsiState: TechnicalAudit['rsiState'] = 'NEUTRAL';
  if (rsi <= 32) rsiState = 'OVERSOLD';
  else if (rsi >= 68) rsiState = 'OVERBOUGHT';
  else if (rsi >= 53) rsiState = 'BULLISH_MOMENTUM';
  else if (rsi <= 47) rsiState = 'BEARISH_MOMENTUM';

  let emaTrend: TechnicalAudit['emaTrend'] = 'BULLISH';
  if (emaSpread > 0.25) emaTrend = 'BULLISH';
  else if (emaSpread < -0.25) emaTrend = 'BEARISH';
  else if (velocity > 0.05) emaTrend = 'CROSSOVER_UP';
  else if (velocity < -0.05) emaTrend = 'CROSSOVER_DOWN';
  else emaTrend = emaSpread >= 0 ? 'BULLISH' : 'BEARISH';

  let bbStatus: TechnicalAudit['bollingerBandStatus'] = 'MIDDLE_EXPANDING';
  if (bb.pctB < 0.15) bbStatus = 'PIERCED_LOWER';
  else if (bb.pctB > 0.85) bbStatus = 'PIERCED_UPPER';
  else if (bb.bandwidth < 0.0008) bbStatus = 'SQUEEZE';

  // Compute score solely from actual factor passes (identical for VIP and Free)
  const passCount = gateResult.factors.filter((f) => f.status === 'PASS').length;
  const unsureCount = gateResult.factors.filter((f) => f.status === 'UNSURE').length;
  const factorRatio = gateResult.factors.length > 0
    ? (passCount + unsureCount * 0.4) / gateResult.factors.length
    : 0;
  const computedScore = parseFloat((factorRatio * 100).toFixed(1));
  const rawBandStrength: SignalStrength =
    computedScore >= 80 ? 'High' : computedScore >= 58 ? 'Medium' : 'Low';
  const isSynthetic = isSyntheticAsset(assetOrSymbol);
  const computedStrength: SignalStrength =
    isSynthetic && rawBandStrength === 'High' ? 'Medium' : rawBandStrength;

  let recommendedAction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  let confluenceFactors: string[] = [];
  let setupName = 'Awaiting Confluence Alignment';

  if (gateResult.passed) {
    if (structureResult.structure === 'BULLISH') {
      recommendedAction = 'CALL';
      setupName = `${activeTimeframe.toUpperCase()} Bullish Confluence Expansion`;
      confluenceFactors = gateResult.factors.map((f) => `${f.name}: ${f.detail}`);
    } else if (structureResult.structure === 'BEARISH') {
      recommendedAction = 'PUT';
      setupName = `${activeTimeframe.toUpperCase()} Bearish Pressure Wave`;
      confluenceFactors = gateResult.factors.map((f) => `${f.name}: ${f.detail}`);
    }
  } else {
    recommendedAction = 'WAIT';
    setupName = structureResult.structure === 'RANGING'
      ? 'Market Ranging — Awaiting Structural Breakout'
      : 'Confluence Standby (No Trade)';
    confluenceFactors = gateResult.failReasons.length > 0
      ? gateResult.failReasons
      : ['Market structure in consolidation; factors unconfirmed'];
  }

  const recheckSteps = [
    `Phase 1: Ingested ${safePrices.length} ticks from price buffer`,
    `Phase 2: Audited market structure: ${structureResult.structure} (${structureResult.cue})`,
    `Phase 3: Live tick confluence gate evaluated (${passCount}/${gateResult.factors.length} aligned)`,
    `Phase 4: ${recommendedAction === 'WAIT' ? 'WAIT state confirmed — capital preserved' : `Signal strength: ${computedStrength} (${passCount}/${gateResult.factors.length} factors aligned)`}`,
  ];

  return {
    rsi,
    rsiState,
    emaFast: parseFloat(ema9.toFixed(activeTimeframe.includes('USD') ? 5 : 2)),
    emaSlow: parseFloat(ema21.toFixed(activeTimeframe.includes('USD') ? 5 : 2)),
    emaSpread: parseFloat(emaSpread.toFixed(2)),
    emaTrend,
    momentumBuyPct: momentum.buyPct,
    momentumSellPct: momentum.sellPct,
    tickVelocity: velocity,
    tickAcceleration: acceleration,
    bollingerBandStatus: bbStatus,
    bollingerPctB: bb.pctB,
    confluenceScore: computedScore,
    strength: computedStrength,
    confluenceFactors,
    recheckSteps,
    setupName,
    recommendedAction,
  };
}



/**
 * Analyzes market velocity, tick variance, and momentum horizon to suggest
 * optimal safe close timing and profit target BEFORE and DURING a trade.
 */
export function calculateSafeCloseAnalysis(
  ticks: number[],
  activeTimeframe: string = '1m',
  pipSize: number = 0.0001
): SafeCloseAnalysis {
  if (!ticks || ticks.length < 2) {
    return {
      volatilityLevel: 'LOW',
      recommendedSeconds: 45,
      peakMomentumWindow: '35s - 50s',
      safeProfitPips: 4.0,
      advisoryText: 'Waiting for live market ticks to measure velocity.',
      earlyCloseRecommended: false,
      reversalRisk: 'LOW',
    };
  }
  const safeTicks = ticks;
  const pipsMultiplier = 1 / pipSize;
  const currentPrice = safeTicks[safeTicks.length - 1];

  let totalDeltaPips = 0;
  for (let i = 1; i < safeTicks.length; i++) {
    totalDeltaPips += Math.abs(safeTicks[i] - safeTicks[i - 1]) * pipsMultiplier;
  }
  const avgTickVelocity = totalDeltaPips / (safeTicks.length - 1);

  let volatilityLevel: SafeCloseAnalysis['volatilityLevel'] = 'NORMAL';
  let recommendedSeconds = 45;
  let profitTargetPips = 6.0;
  let decayFactor = 0.02;

  if (activeTimeframe === '30s') {
    recommendedSeconds = 22;
    profitTargetPips = 3.5;
  } else if (activeTimeframe === '1m') {
    recommendedSeconds = 45;
    profitTargetPips = 5.5;
  } else if (activeTimeframe === '2m') {
    recommendedSeconds = 85;
    profitTargetPips = 7.5;
  } else if (activeTimeframe === '5m') {
    recommendedSeconds = 180;
    profitTargetPips = 12.0;
  }

  if (avgTickVelocity > 0.8) {
    volatilityLevel = 'HIGH';
    recommendedSeconds = Math.max(15, Math.round(recommendedSeconds * 0.75));
    profitTargetPips = parseFloat((profitTargetPips * 1.3).toFixed(1));
    decayFactor = 0.04;
  } else if (avgTickVelocity < 0.2) {
    volatilityLevel = 'LOW';
    recommendedSeconds = Math.round(recommendedSeconds * 1.25);
    profitTargetPips = parseFloat((profitTargetPips * 0.85).toFixed(1));
    decayFactor = 0.015;
  }

  const minRange = Math.max(10, Math.round(recommendedSeconds * 0.8));
  const maxRange = Math.round(recommendedSeconds * 1.15);
  const peakMomentumWindow = `${minRange}s - ${maxRange}s`;

  let advisoryText = '';
  if (volatilityLevel === 'HIGH') {
    advisoryText = `High market velocity (${avgTickVelocity.toFixed(2)} p/s). Peak impulse window: ${peakMomentumWindow}. Safe close advised upon reaching +${profitTargetPips} pips.`;
  } else if (volatilityLevel === 'LOW') {
    advisoryText = `Low volatility (${avgTickVelocity.toFixed(2)} p/s). Steady hold advised. Target +${profitTargetPips} pips before expected mean-reversion.`;
  } else {
    advisoryText = `Normal velocity conditions. Expected peak momentum at ${peakMomentumWindow}. Optimal safe close zone: +${profitTargetPips} pips.`;
  }

  return {
    volatilityLevel,
    recommendedSeconds,
    peakMomentumWindow,
    safeProfitPips: profitTargetPips,
    advisoryText,
    earlyCloseRecommended: volatilityLevel === 'HIGH',
    reversalRisk: volatilityLevel === 'HIGH' ? 'ELEVATED' : 'LOW',
  };
}

// Asset Tick Buffer Repository for Real Screener Stepping & Live Charting
const assetTickBuffers: Record<string, number[]> = {};
const assetTimestampedTickBuffers: Record<string, TimestampedTick[]> = {};

/**
 * Returns real timestamped ticks accumulated from the live market feed.
 * Never seeds fake sine-wave prices or simulated history.
 */
export function getOrInitializeTimestampedTicks(
  symbol: string,
  _basePrice?: number,
  _pipSize?: number,
  _decimals?: number,
  _count?: number
): TimestampedTick[] {
  if (!assetTimestampedTickBuffers[symbol]) {
    assetTimestampedTickBuffers[symbol] = [];
  }
  return assetTimestampedTickBuffers[symbol];
}

/**
 * Returns raw numeric tick buffer from real feed. Starts empty.
 */
export function getOrInitializeAssetTicks(
  symbol: string,
  _basePrice?: number,
  _pipSize?: number,
  _decimals?: number,
  _count?: number
): number[] {
  return assetTickBuffers[symbol] || [];
}

export function pushAssetTick(symbol: string, price: number, timestampSec?: number): void {
  const now = timestampSec || Math.floor(Date.now() / 1000);

  // 1) Raw numeric price buffer (for lightweight sparklines & indicators)
  if (!assetTickBuffers[symbol]) {
    assetTickBuffers[symbol] = [price];
  } else {
    assetTickBuffers[symbol].push(price);
    if (assetTickBuffers[symbol].length > 500) {
      assetTickBuffers[symbol].shift();
    }
  }

  // 2) Real timestamped rolling buffer (retains up to 7,200 points ~ 2 hours)
  if (!assetTimestampedTickBuffers[symbol]) {
    assetTimestampedTickBuffers[symbol] = [{ time: now, price }];
  } else {
    const buf = assetTimestampedTickBuffers[symbol];
    const last = buf[buf.length - 1];
    const safeTime = Math.max(now, last ? last.time : now);

    if (last && last.time === safeTime) {
      last.price = price;
    } else {
      buf.push({ time: safeTime, price });
      if (buf.length > 7200) {
        buf.shift();
      }
    }
  }
}

export function getAssetTicks(symbol: string): number[] {
  return assetTickBuffers[symbol] ? [...assetTickBuffers[symbol]] : [];
}

export function getAssetTimestampedTicks(symbol: string): TimestampedTick[] {
  return assetTimestampedTickBuffers[symbol] ? [...assetTimestampedTickBuffers[symbol]] : [];
}

/**
 * Calculates current profit/loss and real-time safe close recommendation during an active trade.
 */
export function evaluateActiveTradeHealth(
  entryPrice: number,
  currentPrice: number,
  direction: 'CALL' | 'PUT',
  pipSize: number,
  elapsedSeconds: number,
  expirySeconds: number = 60
): {
  pips: number;
  isProfit: boolean;
  status: 'SAFE_PROFIT' | 'MAX_MOMENTUM_CLOSE_NOW' | 'AT_RISK' | 'HOLDING';
  healthScore: number;
  actionMessage: string;
} {
  const pipsMultiplier = 1 / pipSize;
  const rawDelta = direction === 'CALL' ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pips = parseFloat((rawDelta * pipsMultiplier).toFixed(1));
  const isProfit = pips > 0;
  const timeProgressPct = (elapsedSeconds / expirySeconds) * 100;

  let status: 'SAFE_PROFIT' | 'MAX_MOMENTUM_CLOSE_NOW' | 'AT_RISK' | 'HOLDING' = 'HOLDING';
  let healthScore = 50;
  let actionMessage = 'Position holding within expected volatility band.';

  if (pips >= 5.0 && timeProgressPct >= 60) {
    status = 'MAX_MOMENTUM_CLOSE_NOW';
    healthScore = 95;
    actionMessage = `Peak Momentum Reached (+${pips} pips)! Secure profit now before mean-reversion.`;
  } else if (pips >= 2.5) {
    status = 'SAFE_PROFIT';
    healthScore = 80;
    actionMessage = `In Solid Profit (+${pips} pips). Buffer protected against micro-spikes.`;
  } else if (pips < -2.0) {
    status = 'AT_RISK';
    healthScore = 20;
    actionMessage = `Position under pressure (${pips} pips). Awaiting support bounce or expiry settlement.`;
  } else {
    status = 'HOLDING';
    healthScore = 55;
    actionMessage = `Floating near entry (${pips >= 0 ? '+' : ''}${pips} pips). Momentum continuation in progress.`;
  }

  return { pips, isProfit, status, healthScore, actionMessage };
}

/**
 * Multi-Window Live Confirmation Engine (Rule 6)
 *
 * Scaled by Trade Duration T (minutes):
 * - LONG_CTX: (T + 10 * T) min context (e.g. T=1 -> 11m, T=2 -> 22m, T=5 -> 55m)
 * - MID_CTX: (T + 5 * T) min context (e.g. T=1 -> 6m, T=2 -> 12m, T=5 -> 30m)
 * - SHORT_CTX: max(T + 1, 2) min micro-context
 *
 * Measures directional bias across all three windows from verified live ticks.
 * If windows disagree -> strict WAIT (with detailed conflict summary).
 */
export function evaluateMultiWindowLiveConfirmation(
  pricesOrTicks: number[] | TimestampedTick[],
  pipSize: number,
  timeframeMinutes: number = 1,
  symbol?: string
): MultiWindowConfirmation {
  const pipsMultiplier = 1 / pipSize;
  const T = Math.max(0.5, timeframeMinutes);

  // Exact prompt scaling formulas (in minutes)
  const longMins = Math.round(T + 10 * T);
  const midMins = Math.round(T + 5 * T);
  const shortMins = Math.round(Math.max(T + 1, 2));

  const longSec = longMins * 60;
  const midSec = midMins * 60;
  const shortSec = shortMins * 60;

  // Retrieve timestamped ticks from symbol buffer if available, or convert from input
  let timestamped: TimestampedTick[] = [];
  if (symbol && assetTimestampedTickBuffers[symbol] && assetTimestampedTickBuffers[symbol].length >= 10) {
    timestamped = assetTimestampedTickBuffers[symbol];
  } else if (Array.isArray(pricesOrTicks) && pricesOrTicks.length > 0) {
    if (typeof pricesOrTicks[0] === 'object' && pricesOrTicks[0] !== null && 'time' in (pricesOrTicks[0] as any)) {
      timestamped = pricesOrTicks as TimestampedTick[];
    } else {
      const now = Math.floor(Date.now() / 1000);
      const step = 2;
      const numPrices = pricesOrTicks as number[];
      timestamped = numPrices.map((p, idx) => ({
        time: now - (numPrices.length - 1 - idx) * step,
        price: p,
      }));
    }
  }

  // Fallback to basic sample if completely empty
  if (timestamped.length < 5) {
    return {
      longWindowDesc: `${longMins}m Context (No Feed)`,
      longBias: 'NEUTRAL',
      midWindowDesc: `${midMins}m Context (No Feed)`,
      midBias: 'NEUTRAL',
      shortWindowDesc: `${shortMins}m Context (No Feed)`,
      shortBias: 'NEUTRAL',
      allAgreed: false,
      conflictSummary: 'Live data buffer disconnected or empty. Awaiting tick stream before evaluation.',
      suggestedExpiryMinutes: Math.round(T),
      suggestedExpiryReason: 'Awaiting verified market ticks.',
    };
  }

  const newest = timestamped[timestamped.length - 1];
  const oldest = timestamped[0];
  const capturedSec = Math.max(0, newest.time - oldest.time);
  const capturedMins = Math.floor(capturedSec / 60);

  // Strict buffer gate: if captured window is less than half of LONG_CTX or less than MID_CTX
  if (capturedSec < midSec || timestamped.length < 15) {
    return {
      longWindowDesc: `${longMins}m Context (Building)`,
      longBias: 'NEUTRAL',
      midWindowDesc: `${midMins}m Context (Building)`,
      midBias: 'NEUTRAL',
      shortWindowDesc: `${shortMins}m Context (Live)`,
      shortBias: 'NEUTRAL',
      allAgreed: false,
      conflictSummary: `Need more live data for this expiry: captured ${capturedMins}m / ${longMins}m needed. Live telemetry buffer actively building.`,
      suggestedExpiryMinutes: Math.round(T),
      suggestedExpiryReason: 'Awaiting sufficient multi-window historical buffer before confirming trades.',
    };
  }

  // Slice windows based on timestamp boundaries
  const nowTime = newest.time;
  const longTicks = timestamped.filter((t) => t.time >= nowTime - longSec).map((t) => t.price);
  const midTicks = timestamped.filter((t) => t.time >= nowTime - midSec).map((t) => t.price);
  const shortTicks = timestamped.filter((t) => t.time >= nowTime - shortSec).map((t) => t.price);

  const safeLong = longTicks.length >= 4 ? longTicks : timestamped.map((t) => t.price);
  const safeMid = midTicks.length >= 3 ? midTicks : safeLong.slice(-Math.round(safeLong.length * 0.5));
  const safeShort = shortTicks.length >= 2 ? shortTicks : safeMid.slice(-Math.round(safeMid.length * 0.3));

  // Comprehensive directional bias measurement for each window
  const measureWindowDirectionalBias = (slice: number[]) => {
    if (slice.length < 2) return { bias: 'NEUTRAL' as const, deltaPips: 0, slopePips: 0 };
    const first = slice[0];
    const last = slice[slice.length - 1];
    const deltaPips = (last - first) * pipsMultiplier;

    // Slope: first 40% vs last 40%
    const segLen = Math.max(1, Math.floor(slice.length * 0.4));
    const firstAvg = slice.slice(0, segLen).reduce((a, b) => a + b, 0) / segLen;
    const lastAvg = slice.slice(-segLen).reduce((a, b) => a + b, 0) / segLen;
    const slopePips = (lastAvg - firstAvg) * pipsMultiplier;

    // Micro swing structure (check highs and lows across 3 equal sections)
    let isHH_HL = false;
    let isLH_LL = false;
    if (slice.length >= 6) {
      const third = Math.floor(slice.length / 3);
      const s1 = slice.slice(0, third);
      const s2 = slice.slice(third, third * 2);
      const s3 = slice.slice(third * 2);
      const h1 = Math.max(...s1);
      const h2 = Math.max(...s2);
      const h3 = Math.max(...s3);
      const l1 = Math.min(...s1);
      const l2 = Math.min(...s2);
      const l3 = Math.min(...s3);
      isHH_HL = h3 >= h2 && h2 >= h1 && l3 >= l2 && l2 >= l1;
      isLH_LL = h3 <= h2 && h2 <= h1 && l3 <= l2 && l2 <= l1;
    }

    if ((isHH_HL && deltaPips > 0.15) || (deltaPips > 0.45 && slopePips > 0.15)) {
      return { bias: 'BULLISH' as const, deltaPips: parseFloat(deltaPips.toFixed(1)), slopePips: parseFloat(slopePips.toFixed(2)) };
    }
    if ((isLH_LL && deltaPips < -0.15) || (deltaPips < -0.45 && slopePips < -0.15)) {
      return { bias: 'BEARISH' as const, deltaPips: parseFloat(deltaPips.toFixed(1)), slopePips: parseFloat(slopePips.toFixed(2)) };
    }
    return { bias: 'NEUTRAL' as const, deltaPips: parseFloat(deltaPips.toFixed(1)), slopePips: parseFloat(slopePips.toFixed(2)) };
  };

  const longResult = measureWindowDirectionalBias(safeLong);
  const midResult = measureWindowDirectionalBias(safeMid);
  const shortResult = measureWindowDirectionalBias(safeShort);

  const longDesc = `${longMins}m Context (${longResult.deltaPips >= 0 ? '+' : ''}${longResult.deltaPips} pips)`;
  const midDesc = `${midMins}m Context (${midResult.deltaPips >= 0 ? '+' : ''}${midResult.deltaPips} pips)`;
  const shortDesc = `${shortMins}m Context (${shortResult.deltaPips >= 0 ? '+' : ''}${shortResult.deltaPips} pips)`;

  // All 3 windows MUST point in the same direction (BULLISH or BEARISH)
  const isAllBullish = longResult.bias === 'BULLISH' && midResult.bias === 'BULLISH' && shortResult.bias === 'BULLISH';
  const isAllBearish = longResult.bias === 'BEARISH' && midResult.bias === 'BEARISH' && shortResult.bias === 'BEARISH';
  const allAgreed = isAllBullish || isAllBearish;

  let conflictSummary: string | undefined = undefined;
  if (!allAgreed) {
    conflictSummary = `Lookback Conflict (Long ${longMins}m: ${longResult.bias} | Mid ${midMins}m: ${midResult.bias} | Short ${shortMins}m: ${shortResult.bias}). Multi-window momentum disagrees — WAIT strictly enforced to preserve capital.`;
  }

  // Calculate suggested close / expiry minutes for binary options based on volatility & noise
  let totalDelta = 0;
  for (let i = 1; i < safeShort.length; i++) {
    totalDelta += Math.abs(safeShort[i] - safeShort[i - 1]) * pipsMultiplier;
  }
  const avgVelocity = safeShort.length > 1 ? totalDelta / (safeShort.length - 1) : 0.4;

  let suggestedExpiryMinutes = Math.round(T);
  let suggestedExpiryReason = 'Standard cycle expiry for prevailing structure';

  if (avgVelocity > 0.8) {
    suggestedExpiryMinutes = Math.max(1, Math.min(Math.round(T), 2));
    suggestedExpiryReason = `High tick velocity (${avgVelocity.toFixed(2)} p/s). Rapid momentum burst best captured in ${suggestedExpiryMinutes}m before pull-back.`;
  } else if (avgVelocity < 0.25) {
    suggestedExpiryMinutes = Math.min(5, Math.round(T) + 1);
    suggestedExpiryReason = `Compressed volatility (${avgVelocity.toFixed(2)} p/s). Extended ${suggestedExpiryMinutes}m expiry needed for clean breakout.`;
  } else {
    suggestedExpiryMinutes = Math.round(T);
    suggestedExpiryReason = `Optimal volatility alignment (${avgVelocity.toFixed(2)} p/s) for standard ${Math.round(T)}m expiry.`;
  }

  return {
    longWindowDesc: longDesc,
    longBias: longResult.bias,
    midWindowDesc: midDesc,
    midBias: midResult.bias,
    shortWindowDesc: shortDesc,
    shortBias: shortResult.bias,
    allAgreed,
    conflictSummary,
    suggestedExpiryMinutes,
    suggestedExpiryReason,
  };
}

/**
 * Signal History Learning Engine (Rule 7)
 *
 * Reads recent outcomes for (asset + profile + timeframe) from localStorage.
 * If hit rate < 50% across recent trades, raises the WAIT threshold to stop repetitive bleeding.
 */
export function computeSignalHistoryLearning(
  symbol: string,
  profile: 'BINARY_QUICK' | 'MT5',
  timeframe: string
): HistoryLearningContext {
  try {
    const raw = localStorage.getItem('pulsetrade_signal_history');
    if (!raw) {
      return {
        totalRecent: 0,
        wins: 0,
        losses: 0,
        winRatePct: 0,
        penaltyApplied: 0,
        adjustedWaitThreshold: 0,
        status: 'NEUTRAL',
        note: 'No recent actionable trades logged for this asset/profile yet (neutral baseline).',
      };
    }

    const items: Array<{
      symbol?: string;
      asset?: string;
      profile?: string;
      platformProfile?: string;
      timeframe?: string;
      outcome?: 'WIN' | 'LOSS' | 'PENDING' | 'WAIT' | string;
      generatedAt?: number;
    }> = JSON.parse(raw);

    const target = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Filter relevant recent actionable trades only (never include WAIT)
    const filtered = items.filter((item) => {
      if (item.outcome !== 'WIN' && item.outcome !== 'LOSS') return false;
      const itemSym = ((item.asset || item.symbol || '') as string).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const symMatch = itemSym.includes(target) || target.includes(itemSym);
      const prof = item.platformProfile || item.profile;
      const profMatch = prof ? prof === profile : true;
      const tfMatch = item.timeframe ? item.timeframe === timeframe : true;
      return symMatch && profMatch && tfMatch;
    }).slice(-25);

    const wins = filtered.filter((i) => i.outcome === 'WIN').length;
    const losses = filtered.filter((i) => i.outcome === 'LOSS').length;
    const total = wins + losses;

    if (total < 3) {
      return {
        totalRecent: total,
        wins,
        losses,
        winRatePct: total > 0 ? Math.round((wins / total) * 100) : 0,
        penaltyApplied: 0,
        adjustedWaitThreshold: 0,
        status: 'NEUTRAL',
        note: total > 0
          ? `Recent similar setups: ${wins} won / ${losses} lost • Samples below threshold for bias adjustment (neutral baseline). Past results do not guarantee future performance.`
          : 'No recent actionable trades logged for this asset/profile yet (neutral baseline).',
      };
    }

    const winRatePct = Math.round((wins / total) * 100);

    if (winRatePct < 50) {
      const penalty = Math.min(25, (50 - winRatePct) * 1.2);
      return {
        totalRecent: total,
        wins,
        losses,
        winRatePct,
        penaltyApplied: penalty,
        adjustedWaitThreshold: 15, // Require 15% higher confluence
        status: 'CAUTION_RAISED_THRESHOLD',
        note: `Recent similar setups: ${wins} won / ${losses} lost (${winRatePct}%). Sub-50% hit rate detected; raising WAIT threshold and enforcing strict multi-window consensus to preserve balance. Past results do not guarantee future performance.`,
      };
    }

    return {
      totalRecent: total,
      wins,
      losses,
      winRatePct,
      penaltyApplied: winRatePct >= 65 ? -2 : 0,
      adjustedWaitThreshold: 0,
      status: 'FAVORABLE',
      note: `Recent similar setups: ${wins} won / ${losses} lost (${winRatePct}%). Favorable statistical alignment. Past results do not guarantee future performance.`,
    };
  } catch {
    return {
      totalRecent: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      penaltyApplied: 0,
      adjustedWaitThreshold: 0,
      status: 'NEUTRAL',
      note: 'Signal memory baseline active.',
    };
  }
}
