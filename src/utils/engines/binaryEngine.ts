/**
 * binaryEngine.ts — Short-Expiry Binary Options Engine (Part 1 of Stage 3)
 *
 * Covers ExpertOption, Deriv, PocketOption, and Quotex under `BINARY_QUICK`.
 * Design guarantees:
 *  - Deterministic & identical output for Free and VIP users (zero fake score boosts).
 *  - Requires LIVE Deriv tick stream (DELAYED / OFFLINE / MARKET_CLOSED / RECONNECTING -> WAIT).
 *  - No win-probability percentages displayed until Stage 4 calibration; uses Low / Medium / High strength only.
 *  - No volume/order-book claims (uses Price momentum proxy & OHLC structure).
 *  - Never outputs Stop Loss, Take Profit, or lot size fields.
 *  - Enforces M15 higher-timeframe filter, M1 candle boundary filter, ±15m HIGH news filter, and OTC block.
 */

import type {
  BinaryEngineInput,
  BinaryExpiry,
  BinarySignalOutput,
  Candle,
  MarketEventItem,
  SignalStrength,
  TimestampedTick,
} from './types.ts';
import type { AssetConfig } from '../../types.ts';
import {
  calculateATR,
  calculateATRPercentile,
  calculateBollingerBands,
  calculateEMA,
  calculatePriceMomentumProxy,
  calculateRSI,
  detectSwingLevels,
} from './indicators.ts';

const EXPIRY_SECONDS: Record<BinaryExpiry, number> = {
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '3m': 180,
  '5m': 300,
};

/**
 * Binary break-even win rate:
 *   break_even = 1 / (1 + payout)
 * where payout = payoutPct / 100 (e.g., 85% -> 0.85 -> 54.05%).
 */
export function calculateBreakEvenWinRate(payoutPct: number): number {
  const validPayout = Number.isFinite(payoutPct) && payoutPct > 0 ? payoutPct : 85;
  const payout = validPayout / 100;
  return parseFloat(((1 / (1 + payout)) * 100).toFixed(2));
}

export function formatBreakEvenStatement(payoutPct: number): string {
  const validPayout = Number.isFinite(payoutPct) && payoutPct > 0 ? payoutPct : 85;
  const be = calculateBreakEvenWinRate(validPayout);
  return `You need to win more than ${be.toFixed(2)}% of trades at this ${validPayout}% payout to profit.`;
}

function normalizeTickTimeMs(t: number): number {
  return t > 1e12 ? t : t * 1000;
}

function mapStrength(rawScore: number): SignalStrength {
  if (rawScore >= 82) return 'High';
  if (rawScore >= 66) return 'Medium';
  return 'Low';
}

function is24x7Asset(asset: AssetConfig): boolean {
  return asset.type === 'SYNTH' || asset.type === 'CRYPTO';
}

function checkSessionWindow(asset: AssetConfig, nowMs: number): {
  blocked: boolean;
  sessionName: string;
  sessionQuality: 'PRIME' | 'NORMAL' | 'CAUTION' | 'THIN';
  note: string;
} {
  if (is24x7Asset(asset)) {
    return {
      blocked: false,
      sessionName: asset.type === 'SYNTH' ? '24/7 Synthetic Index' : '24/7 Crypto Market',
      sessionQuality: 'PRIME',
      note: 'Continuous 24/7 liquidity without interbank rollover hours.',
    };
  }

  const d = new Date(nowMs);
  const utcDay = d.getUTCDay(); // 0=Sun .. 6=Sat
  const utcHour = d.getUTCHours();

  // Standard FX weekend close: Fri >= 21:00 UTC through Sun < 21:00 UTC
  if (utcDay === 6 || (utcDay === 5 && utcHour >= 21) || (utcDay === 0 && utcHour < 21)) {
    return {
      blocked: true,
      sessionName: 'Market Closed (Weekend)',
      sessionQuality: 'THIN',
      note: 'Spot FX/metals/equities are in weekend close (opens Sunday 21:00 UTC). Switch to 24/7 Synthetics or Crypto.',
    };
  }

  // Daily rollover thin-liquidity window: 21:00 - 23:59 UTC
  if (utcHour >= 21) {
    return {
      blocked: true,
      sessionName: 'Daily Rollover (21:00–00:00 UTC)',
      sessionQuality: 'THIN',
      note: 'Rollover hours between New York close and Tokyo open carry wide spreads and erratic quote jumps.',
    };
  }

  if (utcHour >= 12 && utcHour < 17) {
    return {
      blocked: false,
      sessionName: 'London / NY Overlap',
      sessionQuality: 'PRIME',
      note: 'Peak multi-session participation with cleaner directional follow-through.',
    };
  }

  if (utcHour >= 7 && utcHour < 12) {
    return {
      blocked: false,
      sessionName: 'London Session',
      sessionQuality: 'PRIME',
      note: 'Active European session momentum.',
    };
  }

  if (utcHour >= 17 && utcHour < 21) {
    return {
      blocked: false,
      sessionName: 'NY Afternoon Session',
      sessionQuality: 'NORMAL',
      note: 'Moderate late-US session activity.',
    };
  }

  return {
    blocked: false,
    sessionName: 'Asian Session (00:00–07:00 UTC)',
    sessionQuality: 'CAUTION',
    note: 'Lower overnight FX range; requires stricter confluence alignment.',
  };
}

function findBlockingNewsEvent(
  events: MarketEventItem[] | undefined,
  asset: AssetConfig,
  nowMs: number
): MarketEventItem | null {
  if (!events || events.length === 0) return null;
  // Synthetic indices follow mathematical volatility models, not macro calendars
  if (asset.type === 'SYNTH') return null;

  const assetText = `${asset.symbol} ${asset.name}`.toUpperCase();
  const windowMs = 15 * 60 * 1000;

  for (const ev of events) {
    if (ev.impact !== 'HIGH') continue;
    const startMs = Date.parse(ev.starts_at);
    if (!Number.isFinite(startMs)) continue;
    if (Math.abs(startMs - nowMs) > windowMs) continue;

    const ccy = (ev.currency || '').toUpperCase().trim();
    const matchesCurrency =
      ccy === 'ALL' ||
      assetText.includes(ccy) ||
      (ccy === 'USD' && (asset.type === 'CRYPTO' || asset.type === 'COMMODITY' || asset.type === 'INDEX' || asset.type === 'STOCK'));

    if (matchesCurrency) {
      return ev;
    }
  }
  return null;
}

function determineTimeframeBias(candles: Candle[]): {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  ema9: number;
  ema21: number;
  rsi14: number;
} {
  const closes = candles.map((c) => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi14 = calculateRSI(closes, 14);
  const lastClose = closes[closes.length - 1] || 0;

  if (ema9 > ema21 && lastClose >= ema21 && rsi14 >= 48) {
    return { bias: 'BULLISH', ema9, ema21, rsi14 };
  }
  if (ema9 < ema21 && lastClose <= ema21 && rsi14 <= 52) {
    return { bias: 'BEARISH', ema9, ema21, rsi14 };
  }
  return { bias: 'NEUTRAL', ema9, ema21, rsi14 };
}

function chooseDynamicExpiry(params: {
  atrPercentile: number;
  bbBandwidth: number;
  microSlopeNorm: number;
  alignedWindows: number;
}): { expiry: BinaryExpiry; rationale: string } {
  const { atrPercentile, bbBandwidth, microSlopeNorm, alignedWindows } = params;
  const absMicro = Math.abs(microSlopeNorm);

  if (atrPercentile >= 72 && absMicro >= 0.45 && alignedWindows >= 3) {
    return {
      expiry: '30s',
      rationale: 'High short-term ATR expansion paired with crisp 60s tick acceleration favors a 30s burst expiry.',
    };
  }
  if (atrPercentile >= 50 || (absMicro >= 0.25 && bbBandwidth > 0.0005)) {
    return {
      expiry: '1m',
      rationale: 'Active volatility and synchronized micro-momentum support a 1m expiry.',
    };
  }
  if (atrPercentile >= 32) {
    return {
      expiry: '2m',
      rationale: 'Moderate candle expansion favors a 2m expiry to let M1 structure follow through.',
    };
  }
  if (atrPercentile >= 18) {
    return {
      expiry: '3m',
      rationale: 'Steadier volatility pace calls for a 3m expiry buffer against intrabar noise.',
    };
  }
  return {
    expiry: '5m',
    rationale: 'Calmer volatility regime calls for a 5m expiry so directional pressure can play out.',
  };
}

function buildWaitResult(params: {
  input: BinaryEngineInput;
  nowMs: number;
  entryPrice: number;
  payoutPct: number;
  rawScore: number;
  expiry: BinaryExpiry;
  whyNotTrade: string;
  reasons: [string, string, string];
  inputsSnapshot: Record<string, unknown>;
}): BinarySignalOutput {
  const { input, nowMs, entryPrice, payoutPct, rawScore, expiry, whyNotTrade, reasons, inputsSnapshot } = params;
  return {
    engine: 'binary_v1',
    profile: 'BINARY_QUICK',
    platform: input.platform,
    platformName: input.platformName || input.platform,
    asset: input.asset.name,
    symbol: input.asset.symbol,
    direction: 'WAIT',
    expiry,
    expirySeconds: EXPIRY_SECONDS[expiry],
    strength: mapStrength(rawScore),
    rawScore: parseFloat(rawScore.toFixed(1)),
    reasons,
    whyNotTrade,
    payoutPct,
    breakEvenWinRatePct: calculateBreakEvenWinRate(payoutPct),
    breakEvenMessage: formatBreakEvenStatement(payoutPct),
    enterWithinSeconds: 0,
    createdAt: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs).toISOString(),
    generatedAt: nowMs,
    entryPrice,
    feedSource: input.feedSource || 'deriv_ws',
    inputsSnapshot,
  };
}

export function analyzeBinarySignal(input: BinaryEngineInput): BinarySignalOutput {
  const nowMs = input.nowMs ?? Date.now();
  const payoutPct = typeof input.payoutPct === 'number' && input.payoutPct > 0 ? input.payoutPct : 85;
  const fallbackExpiry: BinaryExpiry = input.preferredExpiry || '1m';

  const m1Candles = input.m1Candles || [];
  const m5Candles = input.m5Candles || [];
  const m15Candles = input.m15Candles || [];

  const recentTicks: TimestampedTick[] = (input.ticks || [])
    .filter((t) => {
      const tMs = normalizeTickTimeMs(t.time);
      return tMs <= nowMs + 5000 && nowMs - tMs <= 60_000;
    })
    .sort((a, b) => normalizeTickTimeMs(a.time) - normalizeTickTimeMs(b.time));

  const latestPrice =
    recentTicks[recentTicks.length - 1]?.price ??
    m1Candles[m1Candles.length - 1]?.close ??
    0;

  const baseSnapshot: Record<string, unknown> = {
    symbol: input.asset.symbol,
    feedStatus: input.feedStatus,
    m1Count: m1Candles.length,
    m5Count: m5Candles.length,
    m15Count: m15Candles.length,
    recentTickCount60s: recentTicks.length,
    payoutPct,
    isOtc: Boolean(input.isOtc || input.asset.is_otc),
    evaluatedAt: new Date(nowMs).toISOString(),
  };

  // 1. Hard Gate: OTC proprietary broker prices
  if (input.isOtc || input.asset.is_otc || /OTC/i.test(input.asset.symbol) || /OTC/i.test(input.asset.name)) {
    const reason = 'OTC prices are set by your broker; we cannot analyse them.';
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: 0,
      expiry: fallbackExpiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'No public market feed exists to audit OTC broker quote integrity.',
        'Switch to an exchange-backed Forex, Crypto, or 24/7 Synthetic instrument.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'OTC' },
    });
  }

  // 2. Hard Gate: Binary requires live second-by-second ticks (blocks DELAYED / RECONNECTING / OFFLINE / MARKET_CLOSED)
  if (input.feedStatus !== 'LIVE') {
    const reason = `Binary expiry timing requires a LIVE second-by-second feed (current status: ${input.feedStatus}).`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: 0,
      expiry: fallbackExpiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Quiet or delayed feeds expose 30s–5m options entries to quote slippage.',
        'Wait for LIVE feed status or switch to MT5 candle-based analysis for slow FX sessions.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'FEED_NOT_LIVE' },
    });
  }

  // 3. Hard Gate: Minimum verified candle & tick history
  if (m1Candles.length < 25 || m15Candles.length < 15 || recentTicks.length < 5) {
    const reason = `Insufficient real market data (M1: ${m1Candles.length}/25, M15: ${m15Candles.length}/15, 60s ticks: ${recentTicks.length}/5).`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: 0,
      expiry: fallbackExpiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Indicators are only computed on verified broker history and live WebSocket ticks.',
        'Allow a few seconds for the candle and tick buffers to finish syncing.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'INSUFFICIENT_DATA' },
    });
  }

  // 4. Hard Gate: High-impact macro news within ±15 min
  const blockingNews = findBlockingNewsEvent(input.marketEvents, input.asset, nowMs);
  if (blockingNews) {
    const reason = `High-impact ${blockingNews.currency} event within ±15 min: ${blockingNews.title}.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: 20,
      expiry: fallbackExpiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Scheduled high-impact releases cause abrupt spread spikes and unpredictable wicks.',
        'Stand aside until 15 minutes after the release stabilizes.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'HIGH_IMPACT_NEWS', blockingNews },
    });
  }

  // 5. Hard Gate: Lowest-liquidity rollover / weekend close (Synthetics & Crypto are 24/7)
  const session = checkSessionWindow(input.asset, nowMs);
  if (session.blocked) {
    const reason = `Blocked during ${session.sessionName}: ${session.note}`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: 20,
      expiry: fallbackExpiry,
      whyNotTrade: reason,
      reasons: [
        `Active session window: ${session.sessionName}.`,
        session.note,
        'Switch to a 24/7 Synthetic Index or Crypto pair during off-hours.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'LOW_LIQUIDITY_SESSION', session },
    });
  }

  // 6. Hard Gate: M1 Candle Open/Close Boundary Check (first 4s or final 4s of minute)
  const secInCandle = Math.floor(nowMs / 1000) % 60;
  if (secInCandle < 4 || secInCandle >= 56) {
    const reason = `Avoided M1 candle boundary (${secInCandle}s into minute candle) where quote resets skew short expiries.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: 30,
      expiry: fallbackExpiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Entering right at minute transitions increases entry-strike slippage on brokers.',
        'Wait 4–5 seconds for the new minute candle tick flow to establish cleanly.',
      ],
      inputsSnapshot: { ...baseSnapshot, blocker: 'CANDLE_BOUNDARY', secInCandle },
    });
  }

  // =========================================================================
  // 7. COMPUTE REAL MULTI-TIMEFRAME & TICK INDICATORS
  // =========================================================================
  const pipSize = input.asset.pipSize || 0.0001;
  const m1Closes = m1Candles.map((c) => c.close);
  const ema9M1 = calculateEMA(m1Closes, 9);
  const ema21M1 = calculateEMA(m1Closes, 21);
  const emaSpreadPips = (ema9M1 - ema21M1) / pipSize;
  const rsi14M1 = calculateRSI(m1Closes, 14);
  const bbM1 = calculateBollingerBands(m1Closes, 20, 2.0);
  const atr14M1 = calculateATR(m1Candles, 14);
  const atrPct = calculateATRPercentile(m1Candles, 14, 80);
  const levels = detectSwingLevels(m1Candles.slice(-40), pipSize);

  const m15Context = determineTimeframeBias(m15Candles);
  const m5Context =
    m5Candles.length >= 15
      ? determineTimeframeBias(m5Candles)
      : { bias: m15Context.bias, ema9: m15Context.ema9, ema21: m15Context.ema21, rsi14: m15Context.rsi14 };

  // 60-second micro-trend slope & price momentum proxy from live ticks
  const tickPrices = recentTicks.map((t) => t.price);
  const firstTick = recentTicks[0];
  const lastTick = recentTicks[recentTicks.length - 1];
  const tickSpanSec = Math.max(1, (normalizeTickTimeMs(lastTick.time) - normalizeTickTimeMs(firstTick.time)) / 1000);
  const netMicroPips = (lastTick.price - firstTick.price) / pipSize;
  const atrInPips = atr14M1 > 0 ? atr14M1 / pipSize : 1;
  const microSlopeNorm = netMicroPips / Math.max(atrInPips, 0.5);
  const momentumProxy = calculatePriceMomentumProxy(tickPrices, Math.min(25, tickPrices.length));

  // M1 direction & candle body pressure (last 3 candles)
  const last3M1 = m1Candles.slice(-3);
  const bullM1Candles = last3M1.filter((c) => c.close > c.open).length;
  const bearM1Candles = last3M1.filter((c) => c.close < c.open).length;

  let m1Bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (ema9M1 > ema21M1 && (latestPrice >= ema9M1 || bullM1Candles >= 2)) m1Bias = 'BULLISH';
  else if (ema9M1 < ema21M1 && (latestPrice <= ema9M1 || bearM1Candles >= 2)) m1Bias = 'BEARISH';

  // Directional scoring: evaluate Bullish vs Bearish symmetrically
  let bullScore = 0;
  let bearScore = 0;

  // M15 higher-timeframe bias (22 pts)
  if (m15Context.bias === 'BULLISH') bullScore += 22;
  else if (m15Context.bias === 'BEARISH') bearScore += 22;

  // M5 medium bias (14 pts)
  if (m5Context.bias === 'BULLISH') bullScore += 14;
  else if (m5Context.bias === 'BEARISH') bearScore += 14;

  // M1 EMA(9/21) trend (18 pts)
  if (ema9M1 > ema21M1) bullScore += latestPrice >= ema9M1 ? 18 : 11;
  else if (ema9M1 < ema21M1) bearScore += latestPrice <= ema9M1 ? 18 : 11;

  // M1 RSI(14) healthy directional zone (14 pts), strong extended zone (8 pts)
  if (rsi14M1 >= 52 && rsi14M1 <= 72) bullScore += 14;
  else if ((rsi14M1 > 72 && rsi14M1 <= 86) || (rsi14M1 >= 35 && rsi14M1 < 52 && m1Bias === 'BULLISH')) bullScore += 8;
  if (rsi14M1 <= 48 && rsi14M1 >= 28) bearScore += 14;
  else if ((rsi14M1 < 28 && rsi14M1 >= 14) || (rsi14M1 <= 65 && rsi14M1 > 48 && m1Bias === 'BEARISH')) bearScore += 8;

  // 60s tick micro-trend + price momentum proxy (18 pts)
  if (microSlopeNorm > 0.08 && momentumProxy.buyPct >= 54) bullScore += 18;
  else if (netMicroPips > 0 && momentumProxy.buyPct >= 50) bullScore += 10;
  if (microSlopeNorm < -0.08 && momentumProxy.sellPct >= 54) bearScore += 18;
  else if (netMicroPips < 0 && momentumProxy.sellPct >= 50) bearScore += 10;

  // Bollinger expansion vs squeeze (8 pts)
  const isBbExpanded = bbM1.bandwidth > 0.00025;
  if (isBbExpanded && bbM1.pctB >= 0.5 && bbM1.pctB <= 1.05) bullScore += 8;
  if (isBbExpanded && bbM1.pctB <= 0.5 && bbM1.pctB >= -0.05) bearScore += 8;

  // Key level clearance & session quality (6 pts)
  const roomToResistanceAtr = atr14M1 > 0 ? (levels.nearestResistance - latestPrice) / atr14M1 : 1;
  const roomToSupportAtr = atr14M1 > 0 ? (latestPrice - levels.nearestSupport) / atr14M1 : 1;
  if (roomToResistanceAtr >= 0.45 && session.sessionQuality !== 'CAUTION') bullScore += 6;
  if (roomToSupportAtr >= 0.45 && session.sessionQuality !== 'CAUTION') bearScore += 6;

  // Pick leading side
  const candidateDirection: 'CALL' | 'PUT' | 'WAIT' =
    bullScore > bearScore + 8 ? 'CALL' : bearScore > bullScore + 8 ? 'PUT' : 'WAIT';
  const rawScore = Math.max(bullScore, bearScore);
  const strength = mapStrength(rawScore);

  const alignedWindows =
    candidateDirection === 'CALL'
      ? [m15Context.bias, m5Context.bias, m1Bias].filter((b) => b === 'BULLISH').length
      : candidateDirection === 'PUT'
      ? [m15Context.bias, m5Context.bias, m1Bias].filter((b) => b === 'BEARISH').length
      : 0;

  const { expiry, rationale: expiryRationale } = chooseDynamicExpiry({
    atrPercentile: atrPct,
    bbBandwidth: bbM1.bandwidth,
    microSlopeNorm,
    alignedWindows,
  });

  const snapshot: Record<string, unknown> = {
    ...baseSnapshot,
    m1: {
      ema9: ema9M1,
      ema21: ema21M1,
      emaSpreadPips: parseFloat(emaSpreadPips.toFixed(2)),
      rsi14: rsi14M1,
      bbPctB: parseFloat(bbM1.pctB.toFixed(3)),
      bbBandwidth: parseFloat(bbM1.bandwidth.toFixed(6)),
      atr14: atr14M1,
      atrPercentile: atrPct,
      bias: m1Bias,
    },
    m5: { bias: m5Context.bias, ema9: m5Context.ema9, ema21: m5Context.ema21, rsi14: m5Context.rsi14 },
    m15: { bias: m15Context.bias, ema9: m15Context.ema9, ema21: m15Context.ema21, rsi14: m15Context.rsi14 },
    microTicks60s: {
      spanSec: parseFloat(tickSpanSec.toFixed(1)),
      netMicroPips: parseFloat(netMicroPips.toFixed(2)),
      microSlopeNorm: parseFloat(microSlopeNorm.toFixed(3)),
      momentumBuyPct: momentumProxy.buyPct,
      momentumSellPct: momentumProxy.sellPct,
    },
    levels,
    session,
    bullScore,
    bearScore,
    rawScore,
    expiryChosen: expiry,
  };

  // =========================================================================
  // 8. CONFLUENCE & CHOP / COUNTER-TREND GUARDS -> HONEST WAIT
  // =========================================================================
  if (atrPct < 8) {
    const reason = `Dead volatility regime (M1 ATR at ${atrPct}th percentile) — prices lack movement to clear expiry cleanly.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: Math.min(rawScore, 45),
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        `M1 Bollinger bandwidth compressed (${bbM1.bandwidth.toFixed(5)}).`,
        'Stand aside until ATR breaks back above compression lows.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'DEAD_VOLATILITY' },
    });
  }

  if (atrPct > 96) {
    const reason = `Extreme volatility spike (M1 ATR at ${atrPct}th percentile) — unstable whipsaw conditions.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: Math.min(rawScore, 50),
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Spikes distort fixed-expiry entry risk within 30s–5m windows.',
        'Wait for volatility to cool back into normal range.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'EXTREME_VOLATILITY' },
    });
  }

  if (candidateDirection === 'WAIT' || rawScore < 62) {
    const reason = `Mixed/choppy multi-timeframe readings (Bull score ${bullScore} vs Bear score ${bearScore}) — no clean directional edge.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore,
      expiry,
      whyNotTrade: reason,
      reasons: [
        `M15 bias is ${m15Context.bias} while M1 EMA/RSI shows conflicting pressure (RSI ${rsi14M1.toFixed(1)}).`,
        `60s price momentum proxy split (${momentumProxy.buyPct}% up / ${momentumProxy.sellPct}% down tick deltas).`,
        'Capital preserved with WAIT until structure, M1/M15 EMAs, and live ticks align.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'LOW_CONFLUENCE' },
    });
  }

  // Higher-Timeframe M15 Filter:
  // If M15 trend is clearly down, do NOT emit CALL unless strength === 'High'.
  // If M15 trend is clearly up, do NOT emit PUT unless strength === 'High'.
  if (candidateDirection === 'CALL' && m15Context.bias === 'BEARISH' && strength !== 'High') {
    const reason = `M15 higher-timeframe bias is BEARISH (${m15Context.ema9.toFixed(input.asset.decimals)} < ${m15Context.ema21.toFixed(input.asset.decimals)}); counter-trend CALL blocked unless High strength.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore,
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        `Short M1 strength (${strength}) does not justify trading against the 15-minute downtrend.`,
        'Wait for either a PUT resumption signal or a confirmed M15 structural flip.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'M15_COUNTER_TREND' },
    });
  }

  if (candidateDirection === 'PUT' && m15Context.bias === 'BULLISH' && strength !== 'High') {
    const reason = `M15 higher-timeframe bias is BULLISH (${m15Context.ema9.toFixed(input.asset.decimals)} > ${m15Context.ema21.toFixed(input.asset.decimals)}); counter-trend PUT blocked unless High strength.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore,
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        `Short M1 strength (${strength}) does not justify selling into the 15-minute uptrend.`,
        'Wait for either a CALL continuation setup or an M15 trend reversal.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'M15_COUNTER_TREND' },
    });
  }

  // Active live-tick counter-move protection & key level wall protection
  if (candidateDirection === 'CALL' && (netMicroPips < -0.5 * atrInPips || momentumProxy.sellPct >= 62)) {
    const reason = `60s live tick stream is moving downward (${netMicroPips.toFixed(1)} pips, ${momentumProxy.sellPct}% down deltas) against bullish M1 setup.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: Math.min(rawScore, 55),
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Buying a short binary option while ticks drop increases immediate drawdown at strike open.',
        'Stand by until 60s tick momentum turns back upward.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'TICK_COUNTER_MOVE' },
    });
  }

  if (candidateDirection === 'PUT' && (netMicroPips > 0.5 * atrInPips || momentumProxy.buyPct >= 62)) {
    const reason = `60s live tick stream is moving upward (+${netMicroPips.toFixed(1)} pips, ${momentumProxy.buyPct}% up deltas) against bearish M1 setup.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: Math.min(rawScore, 55),
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Selling a short binary option into rising live ticks risks getting caught in a squeeze.',
        'Stand by until 60s tick momentum turns downward.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'TICK_COUNTER_MOVE' },
    });
  }

  if (candidateDirection === 'CALL' && roomToResistanceAtr < 0.25 && strength !== 'High') {
    const reason = `Price sits right under nearby M1 resistance (${levels.nearestResistance.toFixed(input.asset.decimals)}), limiting upward room.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: Math.min(rawScore, 58),
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Short-expiry CALL entries directly below resistance frequently stall on bouncebacks.',
        'Wait for a clean close above resistance or a deeper pullback to support.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'AT_RESISTANCE' },
    });
  }

  if (candidateDirection === 'PUT' && roomToSupportAtr < 0.25 && strength !== 'High') {
    const reason = `Price sits directly on nearby M1 support (${levels.nearestSupport.toFixed(input.asset.decimals)}), limiting downward room.`;
    return buildWaitResult({
      input,
      nowMs,
      entryPrice: latestPrice,
      payoutPct,
      rawScore: Math.min(rawScore, 58),
      expiry,
      whyNotTrade: reason,
      reasons: [
        reason,
        'Short-expiry PUT entries right at support carry high bounce risk before expiry.',
        'Wait for a clean breakdown below support or a pullback retest.',
      ],
      inputsSnapshot: { ...snapshot, blocker: 'AT_SUPPORT' },
    });
  }

  // =========================================================================
  // 9. ACTIONABLE BINARY SIGNAL (NO SL/TP, NO PROBABILITY %, 6s FRESHNESS)
  // =========================================================================
  const dec = input.asset.decimals || 5;
  const reasons: [string, string, string] =
    candidateDirection === 'CALL'
      ? [
          `M15 (${m15Context.bias}) & M5 (${m5Context.bias}) trend context supports upward M1 EMA(9/21) alignment (${ema9M1.toFixed(dec)} > ${ema21M1.toFixed(dec)}).`,
          `RSI(14) at ${rsi14M1.toFixed(1)} with ${momentumProxy.buyPct}% upward 60s tick momentum proxy and M1 ATR at the ${atrPct}th percentile.`,
          expiryRationale,
        ]
      : [
          `M15 (${m15Context.bias}) & M5 (${m5Context.bias}) trend context supports downward M1 EMA(9/21) alignment (${ema9M1.toFixed(dec)} < ${ema21M1.toFixed(dec)}).`,
          `RSI(14) at ${rsi14M1.toFixed(1)} with ${momentumProxy.sellPct}% downward 60s tick momentum proxy and M1 ATR at the ${atrPct}th percentile.`,
          expiryRationale,
        ];

  return {
    engine: 'binary_v1',
    profile: 'BINARY_QUICK',
    platform: input.platform,
    platformName: input.platformName || input.platform,
    asset: input.asset.name,
    symbol: input.asset.symbol,
    direction: candidateDirection,
    expiry,
    expirySeconds: EXPIRY_SECONDS[expiry],
    strength,
    rawScore: parseFloat(rawScore.toFixed(1)),
    reasons,
    payoutPct,
    breakEvenWinRatePct: calculateBreakEvenWinRate(payoutPct),
    breakEvenMessage: formatBreakEvenStatement(payoutPct),
    enterWithinSeconds: 6,
    createdAt: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + 6000).toISOString(),
    generatedAt: nowMs,
    entryPrice: latestPrice,
    feedSource: input.feedSource || 'deriv_ws',
    inputsSnapshot: snapshot,
  };
}
