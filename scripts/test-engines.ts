/**
 * Deterministic Unit Test Suite for Short-Expiry Binary Engine (Stage 3 Part 1)
 * Run with: npx tsx scripts/test-engines.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  analyzeBinarySignal,
  calculateBreakEvenWinRate,
  formatBreakEvenStatement,
  mapStrength,
} from '../src/utils/engines/binaryEngine.ts';
import {
  analyzeMT5Signal,
  calculateMT5PositionSize,
  computeDailyPivotLevels,
  computeMT5KeyLevels,
  resolveInstrumentSpec,
  resolveQuoteToAccountRate,
} from '../src/utils/engines/mt5Engine.ts';
import {
  computeMarketContext,
  computeUtcSessionProfile,
  computeVolatilityRegime,
  formatLevelDistance,
  resolveAssetPipSize,
} from '../src/utils/engines/marketContext.ts';
import { validateContractSizeOverrides } from '../src/utils/supabaseClient.ts';
import { isSyntheticAsset } from '../src/services/symbolMap.ts';
import signalsLogHandler from '../api/signals/log.ts';
import historyRefreshHandler from '../api/history/refresh.ts';
import {
  buildHistoryMarkerOverlays,
  buildKeyLevelOverlays,
  buildSignalChartOverlays,
  isChartSignalExpiredOrInvalidated,
  snapTimestampToSeries,
  type ChartHistorySignalItem,
} from '../src/utils/chartOverlays.ts';
import type { BinarySignalOutput, Candle, MarketEventItem, MT5SignalOutput } from '../src/utils/engines/types.ts';
import type { AssetConfig, TimestampedTick } from '../src/types.ts';

let passed = 0;
let total = 0;

function assert(condition: boolean, name: string, detail?: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ [PASS] ${name}`);
  } else {
    console.error(`  ✗ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function makeCandles(params: {
  count: number;
  startPrice: number;
  step: number;
  stepSec: number;
  endEpochSec: number;
  oscillation?: number;
  spreadPips?: number;
  pipSize?: number;
}): Candle[] {
  const {
    count,
    startPrice,
    step,
    stepSec,
    endEpochSec,
    oscillation = 0,
    spreadPips = 2,
    pipSize = 0.0001,
  } = params;
  const candles: Candle[] = [];
  let price = startPrice;
  const firstEpoch = endEpochSec - (count - 1) * stepSec;

  for (let i = 0; i < count; i++) {
    const osc = oscillation !== 0 ? Math.sin(i * 0.9) * oscillation : 0;
    const open = price;
    // Place slightly higher volatility earlier in the lookback so current bars sit in ~55-75th ATR percentile
    const amp = i >= Math.floor(count * 0.25) && i <= Math.floor(count * 0.45) ? 1.45 : 1.0 + ((i % 4) * 0.08);
    const close = price + step * amp + osc;
    const wick = spreadPips * pipSize * amp;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    candles.push({
      time: firstEpoch + i * stepSec,
      open: parseFloat(open.toFixed(5)),
      high: parseFloat(high.toFixed(5)),
      low: parseFloat(low.toFixed(5)),
      close: parseFloat(close.toFixed(5)),
    });
    price = close;
  }
  return candles;
}

function makeTicks(params: {
  count: number;
  startPrice: number;
  step: number;
  endMs: number;
}): TimestampedTick[] {
  const { count, startPrice, step, endMs } = params;
  const out: TimestampedTick[] = [];
  const startSec = Math.floor(endMs / 1000) - (count - 1) * 2;
  for (let i = 0; i < count; i++) {
    out.push({
      time: startSec + i * 2,
      price: parseFloat((startPrice + i * step).toFixed(5)),
    });
  }
  return out;
}

const EURUSD: AssetConfig = {
  symbol: 'frxEURUSD',
  name: 'EUR/USD',
  type: 'FOREX',
  decimals: 5,
  pipSize: 0.0001,
};

const R100: AssetConfig = {
  symbol: 'R_100',
  name: 'Volatility 100 Index',
  type: 'SYNTH',
  decimals: 2,
  pipSize: 0.01,
};

// Wednesday 13:30:25 UTC (prime London/NY overlap, mid-candle second 25)
const PRIME_FX_NOW_MS = Date.UTC(2026, 7, 12, 13, 30, 25);
const PRIME_FX_NOW_SEC = Math.floor(PRIME_FX_NOW_MS / 1000);

console.log('\n============================================================');
console.log('  TICKVERE STAGE 3 PART 1: BINARY ENGINE TEST SUITE');
console.log('============================================================\n');

// 1. Payout Break-Even Mathematics
console.log('1. Payout Break-Even Win Rate Math:');
{
  const be80 = calculateBreakEvenWinRate(80);
  const be85 = calculateBreakEvenWinRate(85);
  const be90 = calculateBreakEvenWinRate(90);
  assert(Math.abs(be80 - 55.56) < 0.02, `80% payout break-even is 55.56% (got ${be80}%)`);
  assert(Math.abs(be85 - 54.05) < 0.02, `85% payout break-even is 54.05% (got ${be85}%)`);
  assert(Math.abs(be90 - 52.63) < 0.02, `90% payout break-even is 52.63% (got ${be90}%)`);

  const msg = formatBreakEvenStatement(85);
  assert(
    msg.includes('54.05%') && msg.includes('85%'),
    `Break-even statement formats accurately: "${msg}"`
  );
}

// 2. Bullish CALL Signal + Section C Shared Contract
console.log('\n2. Actionable CALL Signal & Shared SignalData Contract:');
{
  const m15 = makeCandles({ count: 35, startPrice: 1.08, step: 0.0004, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC });
  const m5 = makeCandles({ count: 35, startPrice: 1.088, step: 0.00025, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC });
  const m1 = makeCandles({ count: 60, startPrice: 1.085, step: 0.00018, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC });
  const lastClose = m1[m1.length - 1].close;
  const ticks = makeTicks({ count: 20, startPrice: lastClose - 0.0004, step: 0.00003, endMs: PRIME_FX_NOW_MS });

  const res = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    platformName: 'ExpertOption',
    m1Candles: m1,
    m5Candles: m5,
    m15Candles: m15,
    ticks,
    feedStatus: 'LIVE',
    feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
    payoutPct: 86,
    isOtc: false,
    marketEvents: [],
    nowMs: PRIME_FX_NOW_MS,
  });

  assert(res.direction === 'CALL', `Bullish multi-timeframe alignment emits CALL (got ${res.direction}, why: ${res.whyNotTrade || 'ok'})`);
  assert(res.engine === 'binary_v1', 'Shared contract sets engine="binary_v1"');
  assert(res.profile === 'BINARY_QUICK', 'Shared contract sets profile="BINARY_QUICK"');
  assert(res.enterWithinSeconds === 6, 'Enforces 6-second freshness window');
  assert(['1m', '2m', '3m', '5m'].includes(res.expiry), `Valid binary expiry window selected (no legacy sub-1m): ${res.expiry}`);
  assert(['Low', 'Medium', 'High'].includes(res.strength), `Strength uses qualitative words: ${res.strength}`);
  assert(Array.isArray(res.reasons) && res.reasons.length === 3, 'Includes exactly 3 plain-English reasons');
  assert(!('stopLoss' in res) && !('takeProfit1' in res) && !('lotSize' in res), 'No SL/TP/lot fields emitted for binary');
  assert(Math.abs(res.breakEvenWinRatePct - 53.76) < 0.05, `Computes break-even win rate for 86% payout (${res.breakEvenWinRatePct}%)`);

  // Identical Free vs VIP determinism check (same input => exact identical result)
  const resRepeat = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    platformName: 'ExpertOption',
    m1Candles: m1,
    m5Candles: m5,
    m15Candles: m15,
    ticks,
    feedStatus: 'LIVE',
    feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
    payoutPct: 86,
    isOtc: false,
    marketEvents: [],
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(JSON.stringify(res) === JSON.stringify(resRepeat), 'Engine is 100% deterministic with zero user-tier manipulation');
}

// 3. Bearish PUT Signal
console.log('\n3. Actionable PUT Signal:');
{
  const m15 = makeCandles({ count: 35, startPrice: 1.11, step: -0.0004, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC });
  const m5 = makeCandles({ count: 35, startPrice: 1.098, step: -0.00025, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC });
  const m1 = makeCandles({ count: 60, startPrice: 1.099, step: -0.00018, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC });
  const lastClose = m1[m1.length - 1].close;
  const ticks = makeTicks({ count: 20, startPrice: lastClose + 0.0004, step: -0.00003, endMs: PRIME_FX_NOW_MS });

  const res = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'deriv_binary',
    m1Candles: m1,
    m5Candles: m5,
    m15Candles: m15,
    ticks,
    feedStatus: 'LIVE',
    payoutPct: 85,
    isOtc: false,
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(res.direction === 'PUT', `Bearish alignment emits PUT (got ${res.direction}, why: ${res.whyNotTrade || 'ok'})`);
}

// 4. Hard Gate Blockers -> WAIT with whyNotTrade
console.log('\n4. Safety Gate Blockers (WAIT + whyNotTrade):');
{
  const m15 = makeCandles({ count: 35, startPrice: 1.08, step: 0.0004, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC });
  const m1 = makeCandles({ count: 60, startPrice: 1.085, step: 0.00018, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC });
  const lastClose = m1[m1.length - 1].close;
  const ticks = makeTicks({ count: 20, startPrice: lastClose - 0.0004, step: 0.00003, endMs: PRIME_FX_NOW_MS });

  // 4a. OTC blocked
  const otcRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'pocket_option',
    m1Candles: m1,
    m15Candles: m15,
    ticks,
    feedStatus: 'LIVE',
    isOtc: true,
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(otcRes.direction === 'WAIT' && Boolean(otcRes.whyNotTrade), 'OTC asset returns WAIT with whyNotTrade');

  // 4b. DELAYED feed blocks binary profile (Rule 3)
  const delayedRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'deriv_binary',
    m1Candles: m1,
    m15Candles: m15,
    ticks,
    feedStatus: 'DELAYED',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    delayedRes.direction === 'WAIT' && Boolean(delayedRes.whyNotTrade?.includes('DELAYED')),
    'DELAYED feed status blocks binary signal'
  );

  // 4c. Insufficient candles
  const lowCandleRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'deriv_binary',
    m1Candles: m1.slice(0, 10),
    m15Candles: m15,
    ticks,
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(lowCandleRes.direction === 'WAIT' && Boolean(lowCandleRes.whyNotTrade), 'Insufficient candles returns WAIT');

  // 4d. M1 candle boundary (second 1 & second 58)
  const boundaryStartMs = Date.UTC(2026, 7, 12, 13, 30, 1);
  const boundaryEndMs = Date.UTC(2026, 7, 12, 13, 30, 58);
  const boundStartRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'quotex',
    m1Candles: m1,
    m15Candles: m15,
    ticks: makeTicks({ count: 15, startPrice: lastClose - 0.0003, step: 0.00003, endMs: boundaryStartMs }),
    feedStatus: 'LIVE',
    nowMs: boundaryStartMs,
  });
  const boundEndRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'quotex',
    m1Candles: m1,
    m15Candles: m15,
    ticks: makeTicks({ count: 15, startPrice: lastClose - 0.0003, step: 0.00003, endMs: boundaryEndMs }),
    feedStatus: 'LIVE',
    nowMs: boundaryEndMs,
  });
  assert(boundStartRes.direction === 'WAIT', 'Blocks trade at M1 candle open boundary (sec 1)');
  assert(boundEndRes.direction === 'WAIT', 'Blocks trade at M1 candle close boundary (sec 58)');

  // 4e. ±15m HIGH impact news event blocks FX, does NOT block SYNTH
  const newsEvents: MarketEventItem[] = [
    {
      starts_at: new Date(PRIME_FX_NOW_MS + 5 * 60 * 1000).toISOString(),
      currency: 'USD',
      title: 'US CPI Release',
      impact: 'HIGH',
    },
  ];
  const newsBlockedFx = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'deriv_binary',
    m1Candles: m1,
    m15Candles: m15,
    ticks,
    feedStatus: 'LIVE',
    marketEvents: newsEvents,
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    newsBlockedFx.direction === 'WAIT' && Boolean(newsBlockedFx.whyNotTrade?.includes('US CPI')),
    'HIGH impact USD news within ±15m blocks EUR/USD'
  );

  // 4f. Rollover window (22:15 UTC) blocks FX, while Weekend (Sat 12:00 UTC) allows 24/7 Synthetics
  const rolloverMs = Date.UTC(2026, 7, 12, 22, 15, 25);
  const rolloverRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'deriv_binary',
    m1Candles: m1,
    m15Candles: m15,
    ticks: makeTicks({ count: 15, startPrice: lastClose - 0.0003, step: 0.00003, endMs: rolloverMs }),
    feedStatus: 'LIVE',
    nowMs: rolloverMs,
  });
  assert(rolloverRes.direction === 'WAIT', 'Blocks Spot FX during 21:00-00:00 UTC rollover');

  const satNoonMs = Date.UTC(2026, 7, 15, 12, 15, 25); // Saturday
  const satNoonSec = Math.floor(satNoonMs / 1000);
  const synthM15 = makeCandles({ count: 35, startPrice: 2400, step: 1.5, stepSec: 900, endEpochSec: satNoonSec, pipSize: 0.01 });
  const synthM5 = makeCandles({ count: 35, startPrice: 2430, step: 0.9, stepSec: 300, endEpochSec: satNoonSec, pipSize: 0.01 });
  const synthM1 = makeCandles({ count: 60, startPrice: 2440, step: 0.5, stepSec: 60, endEpochSec: satNoonSec, pipSize: 0.01 });
  const synthLast = synthM1[synthM1.length - 1].close;
  const synthTicks = makeTicks({ count: 20, startPrice: synthLast - 1.5, step: 0.1, endMs: satNoonMs });
  const synthWeekendRes = analyzeBinarySignal({
    asset: R100,
    platform: 'deriv_binary',
    m1Candles: synthM1,
    m5Candles: synthM5,
    m15Candles: synthM15,
    ticks: synthTicks,
    feedStatus: 'LIVE',
    marketEvents: newsEvents,
    nowMs: satNoonMs,
  });
  assert(
    synthWeekendRes.direction === 'CALL',
    `24/7 Synthetic Index trades cleanly over weekend & FX news (got ${synthWeekendRes.direction})`
  );
  assert(
    synthWeekendRes.strength !== 'High',
    `Synthetic Index strength is capped at Medium and never shows High (got ${synthWeekendRes.strength})`
  );
}

// 5. Higher Timeframe M15 Counter-Trend & Chop Filters
console.log('\n5. M15 Counter-Trend & Chop Filters:');
{
  // Bearish M15 + moderately bullish M1 (without High strength) => WAIT
  const bearishM15 = makeCandles({ count: 35, startPrice: 1.12, step: -0.0005, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC });
  const neutralM5 = makeCandles({ count: 35, startPrice: 1.09, step: 0.00005, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC, oscillation: 0.0002 });
  const mildBullM1 = makeCandles({ count: 60, startPrice: 1.088, step: 0.00012, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC });
  const lastClose = mildBullM1[mildBullM1.length - 1].close;
  const mildTicks = makeTicks({ count: 20, startPrice: lastClose - 0.0002, step: 0.000015, endMs: PRIME_FX_NOW_MS });

  const counterTrendRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    m1Candles: mildBullM1,
    m5Candles: neutralM5,
    m15Candles: bearishM15,
    ticks: mildTicks,
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    counterTrendRes.direction === 'WAIT',
    `M15 BEARISH blocks counter-trend CALL unless High strength (got ${counterTrendRes.direction}, strength=${counterTrendRes.strength})`
  );

  // Pure choppy sideways candles => WAIT
  const chopM15 = makeCandles({ count: 35, startPrice: 1.09, step: 0, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC, oscillation: 0.0006 });
  const chopM1 = makeCandles({ count: 60, startPrice: 1.09, step: 0, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC, oscillation: 0.0004 });
  const chopTicks = makeTicks({ count: 20, startPrice: 1.09, step: 0, endMs: PRIME_FX_NOW_MS });

  const chopRes = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    m1Candles: chopM1,
    m15Candles: chopM15,
    ticks: chopTicks,
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(chopRes.direction === 'WAIT', `Choppy alternating candles produce honest WAIT (got ${chopRes.direction})`);
}

// 6. Stage 3.1 Strength Mapping & Synthetic Cap
console.log('\n6. Stage 3.1 Strength Calibration & Synthetic Medium Cap:');
{
  assert(
    mapStrength({
      rawScore: 94,
      direction: 'CALL',
      m5Agreed: true,
      m15Agreed: true,
      hasProximityWarning: false,
      hasChopWarning: false,
      isSynthetic: false,
    }) === 'High',
    'rawScore >= 90 with M5/M15 agreement and zero warnings produces High on non-synthetic'
  );
  assert(
    mapStrength({
      rawScore: 94,
      direction: 'CALL',
      m5Agreed: false,
      m15Agreed: true,
      hasProximityWarning: false,
      hasChopWarning: false,
      isSynthetic: false,
    }) === 'Medium',
    'rawScore >= 90 without M5 agreement drops to Medium'
  );
  assert(
    mapStrength({
      rawScore: 94,
      direction: 'CALL',
      m5Agreed: true,
      m15Agreed: true,
      hasProximityWarning: true,
      hasChopWarning: false,
      isSynthetic: false,
    }) === 'Medium',
    'rawScore >= 90 with proximity warning drops to Medium'
  );
  assert(
    mapStrength({
      rawScore: 94,
      direction: 'CALL',
      m5Agreed: true,
      m15Agreed: true,
      hasProximityWarning: false,
      hasChopWarning: true,
      isSynthetic: false,
    }) === 'Medium',
    'rawScore >= 90 with chop warning drops to Medium'
  );
  assert(
    mapStrength({
      rawScore: 94,
      direction: 'CALL',
      m5Agreed: true,
      m15Agreed: true,
      hasProximityWarning: false,
      hasChopWarning: false,
      isSynthetic: true,
    }) === 'Medium',
    'Synthetic indices cap High -> Medium even when all gates pass'
  );
  assert(mapStrength({ rawScore: 80, direction: 'CALL' }) === 'Medium', 'Score 76-89 maps to Medium');
  assert(mapStrength({ rawScore: 75, direction: 'CALL' }) === 'Low', 'Score below 76 maps to Low');

  assert(
    isSyntheticAsset({ symbol: '1HZ100V' }) &&
      isSyntheticAsset({ symbol: 'BOOM1000' }) &&
      isSyntheticAsset({ symbol: 'CRASH500' }) &&
      isSyntheticAsset({ symbol: 'JD75' }) &&
      isSyntheticAsset({ symbol: 'stpRNG' }) &&
      !isSyntheticAsset({ symbol: 'frxEURUSD', type: 'FOREX' }),
    'isSyntheticAsset accurately detects R_*, 1HZ*, BOOM/CRASH, Jump, and Step symbols'
  );
}

// 7. Stage 3.1 api/signals/log.ts Validation Hardening
console.log('\n7. Stage 3.1 api/signals/log.ts Validation Hardening:');
async function runSignalLogValidationTests() {
  const invoke = async (body: Record<string, unknown>) => {
    let statusCode = 200;
    let jsonBody: any = null;
    const req = { method: 'POST', headers: {}, body };
    const res = {
      setHeader() {},
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        jsonBody = payload;
        return this;
      },
    };
    await signalsLogHandler(req, res);
    return { statusCode, jsonBody };
  };

  // Oversize inputs_snapshot (> 8 KB) -> 413
  const bigSnap = await invoke({
    asset: 'frxEURUSD',
    timeframe: '1m',
    direction: 'CALL',
    entry_price: 1.085,
    inputs_snapshot: { padding: 'x'.repeat(9000) },
  });
  assert(bigSnap.statusCode === 413, `inputs_snapshot > 8KB returns 413 (got ${bigSnap.statusCode})`);

  // Oversize confluence_factors (> 12 items) -> 413
  const tooManyFactors = await invoke({
    asset: 'frxEURUSD',
    timeframe: '1m',
    direction: 'CALL',
    entry_price: 1.085,
    confluence_factors: Array.from({ length: 13 }, (_, i) => `factor ${i}`),
  });
  assert(
    tooManyFactors.statusCode === 413,
    `confluence_factors > 12 items returns 413 (got ${tooManyFactors.statusCode})`
  );

  // Oversize confluence_factors item (> 200 chars) -> 413
  const longFactor = await invoke({
    asset: 'frxEURUSD',
    timeframe: '1m',
    direction: 'CALL',
    entry_price: 1.085,
    confluence_factors: ['a'.repeat(201)],
  });
  assert(
    longFactor.statusCode === 413,
    `confluence_factors item > 200 chars returns 413 (got ${longFactor.statusCode})`
  );

  // WAIT carrying stop_loss or targets -> 400
  const waitWithSl = await invoke({
    asset: 'frxEURUSD',
    timeframe: '1m',
    direction: 'WAIT',
    entry_price: 1.085,
    stop_loss: 1.084,
  });
  assert(waitWithSl.statusCode === 400, `WAIT with stop_loss returns 400 (got ${waitWithSl.statusCode})`);

  const waitWithTp = await invoke({
    asset: 'frxEURUSD',
    timeframe: '1m',
    direction: 'WAIT',
    entry_price: 1.085,
    take_profit_1: 1.087,
  });
  assert(waitWithTp.statusCode === 400, `WAIT with take_profit_1 returns 400 (got ${waitWithTp.statusCode})`);

  // Valid size WAIT without SL/TP reaches 401 auth check cleanly
  const validWaitNoAuth = await invoke({
    asset: 'frxEURUSD',
    timeframe: '1m',
    direction: 'WAIT',
    entry_price: 1.085,
    created_at: '1999-01-01T00:00:00.000Z',
  });
  assert(
    validWaitNoAuth.statusCode === 401,
    `Valid Binary payload (ignoring client created_at) passes schema checks and hits 401 auth gate (got ${validWaitNoAuth.statusCode})`
  );

  // Valid MT5 BUY payload passes shared contract Zod validation and reaches 401 auth check
  const validMt5BuyNoAuth = await invoke({
    asset: 'frxEURUSD',
    timeframe: 'H1',
    direction: 'BUY',
    entry_price: 1.0835,
    stop_loss: 1.0815,
    take_profit_1: 1.0865,
    take_profit_2: 1.0885,
    engine: 'mt5_v1',
    profile: 'MT5',
    platform: 'mt5',
    expiry: 'H1',
    strength: 'High',
    feed_source: 'wss://api.derivws.com/trading/v1/options/ws/public',
    valid_until: new Date(PRIME_FX_NOW_MS + 15 * 60_000).toISOString(),
    inputs_snapshot: { atrH1: 0.0018, lotSize: 0.5 },
  });
  assert(
    validMt5BuyNoAuth.statusCode === 401,
    `Valid MT5 BUY shared contract passes schema validation and hits 401 auth gate (got ${validMt5BuyNoAuth.statusCode})`
  );
}

// ============================================================
// STAGE 3 PART 2: MT5 ENGINE, SIZING & KEY LEVEL TESTS
// ============================================================

const USDJPY: AssetConfig = {
  symbol: 'frxUSDJPY',
  name: 'USD/JPY',
  type: 'FOREX',
  decimals: 3,
  pipSize: 0.01,
};

const EURGBP: AssetConfig = {
  symbol: 'frxEURGBP',
  name: 'EUR/GBP',
  type: 'FOREX',
  decimals: 5,
  pipSize: 0.0001,
};

const XAUUSD: AssetConfig = {
  symbol: 'frxXAUUSD',
  name: 'XAU/USD',
  type: 'COMMODITY',
  decimals: 2,
  pipSize: 0.01,
};

function makeBullishFxBundle(params?: {
  nowSec?: number;
  endPrice?: number;
  swingDropDip?: number;
  swingDipIndexFromEnd?: number;
  pdhLevel?: number;
  includeSwingHighBlocker?: number;
}) {
  const nowSec = params?.nowSec ?? PRIME_FX_NOW_SEC;
  const endPrice = params?.endPrice ?? 1.0835;

  // D1: clean uptrend ending around endPrice - 0.0005, prev day high clear above
  const d1 = makeCandles({
    count: 25,
    startPrice: endPrice - 0.024,
    step: 0.001,
    stepSec: 86400,
    endEpochSec: nowSec,
    spreadPips: 12,
    pipSize: 0.0001,
  });
  if (params?.pdhLevel !== undefined && d1.length >= 2) {
    d1[d1.length - 2] = {
      ...d1[d1.length - 2],
      high: params.pdhLevel,
      close: Math.min(d1[d1.length - 2].close, params.pdhLevel - 0.0005),
    };
  } else if (d1.length >= 2) {
    // Keep prior day high & Pivot R1 comfortably clear (> 45 pips above entry), Pivot PP below entry
    d1[d1.length - 2] = {
      time: d1[d1.length - 2].time,
      open: endPrice - 0.0040,
      low: endPrice - 0.0110,
      high: endPrice + 0.0048,
      close: endPrice - 0.0045,
    };
  }

  // H4: bullish alignment
  const h4 = makeCandles({
    count: 30,
    startPrice: endPrice - 0.012,
    step: 0.0004,
    stepSec: 14400,
    endEpochSec: nowSec,
    spreadPips: 6,
    pipSize: 0.0001,
  });

  // H1: steady uptrend with ATR ~ 10 pips and fractal swing low cleanly ~17 pips below entry
  const h1Count = 40;
  const h1: Candle[] = [];
  let px = endPrice - 0.0050;
  const stepPerH1 = (endPrice - px) / h1Count;
  const firstH1 = nowSec - (h1Count - 1) * 3600;
  for (let i = 0; i < h1Count; i++) {
    const open = px;
    const close = i === h1Count - 1 ? endPrice : px + stepPerH1;
    let high = Math.max(open, close) + 0.0004;
    let low = Math.min(open, close) - 0.0004;

    if (params?.swingDropDip && i === h1Count - (params.swingDipIndexFromEnd ?? 6)) {
      low = endPrice - params.swingDropDip;
    } else if (!params?.swingDropDip && i === h1Count - 5) {
      // Fractal swing low ~17 pips below current entry (strictly lower than i-2, i-1, i+1, i+2)
      low = endPrice - 0.0017;
    }

    if (params?.includeSwingHighBlocker && i === h1Count - 4) {
      high = params.includeSwingHighBlocker;
    }

    h1.push({
      time: firstH1 + i * 3600,
      open: parseFloat(open.toFixed(5)),
      high: parseFloat(high.toFixed(5)),
      low: parseFloat(low.toFixed(5)),
      close: parseFloat(close.toFixed(5)),
    });
    px = close;
  }

  const m15 = makeCandles({
    count: 40,
    startPrice: endPrice - 0.0032,
    step: 0.00008,
    stepSec: 900,
    endEpochSec: nowSec,
    spreadPips: 2.5,
    pipSize: 0.0001,
  });
  m15[m15.length - 1] = {
    ...m15[m15.length - 1],
    close: endPrice,
    high: endPrice + 0.0002,
    low: endPrice - 0.0002,
  };

  const m5 = makeCandles({
    count: 40,
    startPrice: endPrice - 0.0020,
    step: 0.00005,
    stepSec: 300,
    endEpochSec: nowSec,
    spreadPips: 1.5,
    pipSize: 0.0001,
  });
  m5[m5.length - 1] = {
    ...m5[m5.length - 1],
    close: endPrice,
    high: endPrice + 0.00015,
    low: endPrice - 0.00015,
  };

  return { d1, h4, h1, m15, m5 };
}

function runMt5Tests() {
  console.log('\n============================================================');
  console.log('  TICKVERE STAGE 3 PART 2: MT5 ENGINE & SIZING TEST SUITE');
  console.log('============================================================\n');

  // 8. Position Sizing & Conversion Math + Small Account Guard
  console.log('8. MT5 Position Sizing, Quote Conversion & Contract Overrides:');
  {
    const eurSpec = resolveInstrumentSpec(EURUSD);
    const eurSizing = calculateMT5PositionSize({
      accountBalance: 10000,
      riskPct: 1.0, // $100 risk
      slDistancePrice: 0.0020, // 20 pips
      spec: eurSpec,
      quoteToAccountRate: 1.0,
      accountCurrency: 'USD',
    });
    assert(eurSizing.lotSize === 0.5, `EUR/USD $10k @1% / 20pips = 0.50 lots (got ${eurSizing.lotSize})`);

    const jpySpec = resolveInstrumentSpec(USDJPY);
    const jpyRate = resolveQuoteToAccountRate({
      quoteCcy: jpySpec.quoteCcy,
      accountCurrency: 'USD',
      asset: USDJPY,
      entryPrice: 150.0,
    });
    const jpySizing = calculateMT5PositionSize({
      accountBalance: 10000,
      riskPct: 1.0, // $100 risk
      slDistancePrice: 0.30, // 30 pips at USDJPY=150 -> $200/lot risk
      spec: jpySpec,
      quoteToAccountRate: jpyRate || 0,
      accountCurrency: 'USD',
    });
    assert(
      jpyRate !== null && Math.abs(jpyRate - 1 / 150) < 1e-6,
      `USD/JPY quote-to-USD conversion divides by USDJPY=150 (got ${jpyRate})`
    );
    assert(jpySizing.lotSize === 0.5, `USD/JPY $10k @1% / 30pips @150 = 0.50 lots (got ${jpySizing.lotSize})`);

    const xauSpec = resolveInstrumentSpec(XAUUSD);
    const xauSizing = calculateMT5PositionSize({
      accountBalance: 10000,
      riskPct: 1.0,
      slDistancePrice: 5.0,
      spec: xauSpec,
      quoteToAccountRate: 1.0,
      accountCurrency: 'USD',
    });
    assert(xauSizing.lotSize === 0.2, `XAU/USD (contractSize=100) $10k @1% / $5 SL = 0.20 lots (got ${xauSizing.lotSize})`);

    const xauOverrideSpec = resolveInstrumentSpec(XAUUSD, undefined, 10);
    const xauOverrideSizing = calculateMT5PositionSize({
      accountBalance: 10000,
      riskPct: 1.0,
      slDistancePrice: 5.0,
      spec: xauOverrideSpec,
      quoteToAccountRate: 1.0,
      accountCurrency: 'USD',
    });
    assert(
      xauOverrideSizing.lotSize === 2.0,
      `User contractSizeOverride (100 -> 10) scales XAU/USD lot 10x to 2.00 lots (got ${xauOverrideSizing.lotSize})`
    );

    const gbpSpec = resolveInstrumentSpec(EURGBP);
    const gbpRate = resolveQuoteToAccountRate({
      quoteCcy: 'GBP',
      accountCurrency: 'USD',
      asset: EURGBP,
      entryPrice: 0.85,
      conversionRates: { GBPUSD: 1.28 },
    });
    const gbpSizing = calculateMT5PositionSize({
      accountBalance: 10000,
      riskPct: 1.0,
      slDistancePrice: 0.0020,
      spec: gbpSpec,
      quoteToAccountRate: gbpRate || 0,
      accountCurrency: 'USD',
    });
    // 100 / (0.0020 * 100000 * 1.28) = 100 / 256 = 0.390625 -> floored down to 0.39
    assert(
      gbpSizing.lotSize === 0.39,
      `EUR/GBP w/ GBPUSD=1.28 floors down to 0.39 lots (got ${gbpSizing.lotSize})`
    );

    // Small account < min_lot must return 0 lots (NEVER forced to 0.01)
    const smallAcct = calculateMT5PositionSize({
      accountBalance: 10,
      riskPct: 1.0, // $0.10 risk
      slDistancePrice: 0.0020,
      spec: eurSpec,
      quoteToAccountRate: 1.0,
      accountCurrency: 'USD',
    });
    assert(smallAcct.lotSize === 0 && smallAcct.tooSmallForMinLot, `Small $10 account returns 0 lots (got ${smallAcct.lotSize})`);
    assert(
      Boolean(smallAcct.warning?.includes('Your account is too small to take this trade at your chosen risk')),
      `Small account emits explicit warning: "${smallAcct.warning}"`
    );
  }

  // 9. Actionable MT5 BUY + Key Levels + Shared Contract + Trade Management
  console.log('\n9. Actionable MT5 BUY Setup & Complete Shared Contract:');
  {
    const bundle = makeBullishFxBundle();
    const kl = computeMT5KeyLevels(bundle.d1, bundle.h1, bundle.m15, 'H1', EURUSD, 1.0835);
    assert(kl.pdh !== null && kl.pdl !== null && kl.dailyPivot !== null, 'Computes PDH, PDL & Daily Pivot from D1');
    assert(kl.pwh !== null && kl.pwl !== null, 'Computes PWH & PWL from prior week D1 bars');
    assert(kl.roundNumbers.length > 0, 'Computes psychological round numbers');

    const res = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      platformName: 'MetaTrader 5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      structureTimeframe: 'H1',
      feedStatus: 'LIVE',
      feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
      isOtc: false,
      marketEvents: [],
      accountCurrency: 'USD',
      accountBalance: 10000,
      riskPct: 1.0,
      leverage: 100,
      spreadPips: 1.2,
      nowMs: PRIME_FX_NOW_MS,
    });

    assert(res.direction === 'BUY', `Bullish D1/H4/H1/M5 produces BUY (got ${res.direction}, why=${res.whyNotTrade || 'ok'})`);
    assert(res.engine === 'mt5_v1' && res.profile === 'MT5', 'Shared contract sets engine="mt5_v1", profile="MT5"');
    assert(res.stopLoss !== null && res.stopLoss < res.entryPrice, 'Places structural stop-loss below BUY entry');
    assert(res.takeProfit1 !== null && res.takeProfit2 !== null && res.takeProfit2 >= res.takeProfit1, 'Computes TP1 and TP2 >= TP1');
    assert((res.rewardRiskTp1 || 0) >= 1.5, `Enforces TP1 R:R >= 1.5 (got 1:${res.rewardRiskTp1})`);
    assert(res.lotSize > 0 && res.riskMoney === 100, `Computes position size & $100 risk (lot=${res.lotSize})`);
    assert(res.validityCandles === 3 && res.validityMinutes === 15, 'Sets 3 × M5 (15 min) validity window');
    assert(
      res.tradeManagementNote.includes('break-even') && res.tradeManagementNote.includes('partial profit'),
      'Includes 1R break-even & TP1 partial profit management note'
    );
    assert(res.copyOrderText.includes('BUY') && res.copyOrderText.includes('SL:') && res.copyOrderText.includes('TP1:'), 'Generates one-tap copyOrderText');
    assert(!JSON.stringify(res).toLowerCase().includes('winprobability'), 'No win probability field or percentage emitted');
  }

  // 10. DELAYED tick status allowed for MT5 (Rule 3) vs MARKET_CLOSED blocked
  console.log('\n10. Rule 3: DELAYED Feed Status Does Not Block MT5 Candle Scan:');
  {
    const bundle = makeBullishFxBundle();
    const delayedMt5 = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'DELAYED',
      accountCurrency: 'USD',
      accountBalance: 10000,
      riskPct: 1.0,
      spreadPips: 1.2,
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      delayedMt5.direction === 'BUY',
      `DELAYED ticks still allow MT5 candle setup (got ${delayedMt5.direction})`
    );

    const closedMt5 = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'MARKET_CLOSED',
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(closedMt5.direction === 'WAIT', 'MARKET_CLOSED blocks MT5 execution');
  }

  // 11. Wide Stop (> 3×ATR) & Poor R:R (< 1.5) & Spread & News Filters -> WAIT
  console.log('\n11. Structural Stop > 3×ATR, R:R < 1.5, Spread >= 15% SL & ±30m News:');
  {
    // Wide structural swing (> 3x ATR) -> WAIT "Stop would be too wide"
    const wideBundle = makeBullishFxBundle({ swingDropDip: 0.0080 });
    const wideRes = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: wideBundle.d1,
      h4Candles: wideBundle.h4,
      h1Candles: wideBundle.h1,
      m15Candles: wideBundle.m15,
      m5Candles: wideBundle.m5,
      feedStatus: 'LIVE',
      accountBalance: 10000,
      riskPct: 1.0,
      spreadPips: 1.2,
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      wideRes.direction === 'WAIT' && Boolean(wideRes.whyNotTrade?.includes('Stop would be too wide')),
      `Wide structural stop (> 3×ATR) emits WAIT "Stop would be too wide" (got "${wideRes.whyNotTrade}")`
    );

    // Nearby opposing swing high -> R:R < 1.5 -> WAIT
    const tightTargetBundle = makeBullishFxBundle({ includeSwingHighBlocker: 1.0853 });
    const rrRes = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: tightTargetBundle.d1,
      h4Candles: tightTargetBundle.h4,
      h1Candles: tightTargetBundle.h1,
      m15Candles: tightTargetBundle.m15,
      m5Candles: tightTargetBundle.m5,
      feedStatus: 'LIVE',
      accountBalance: 10000,
      riskPct: 1.0,
      spreadPips: 1.2,
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      rrRes.direction === 'WAIT' && Boolean(rrRes.whyNotTrade?.includes('below 1.5')),
      `Opposing key level yielding R:R < 1.5 forces WAIT (got ${rrRes.direction}: "${rrRes.whyNotTrade}")`
    );

    // Excessive spread >= 15% of SL distance -> WAIT
    const normalBundle = makeBullishFxBundle();
    const wideSpreadRes = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: normalBundle.d1,
      h4Candles: normalBundle.h4,
      h1Candles: normalBundle.h1,
      m15Candles: normalBundle.m15,
      m5Candles: normalBundle.m5,
      feedStatus: 'LIVE',
      accountBalance: 10000,
      riskPct: 1.0,
      spreadPips: 6.0, // > 15% of ~24 pip SL
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      wideSpreadRes.direction === 'WAIT' && Boolean(wideSpreadRes.whyNotTrade?.includes('15%')),
      `Spread >= 15% of SL distance forces WAIT (got "${wideSpreadRes.whyNotTrade}")`
    );

    // ±30m High-impact news blocks FX
    const news30Res = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: normalBundle.d1,
      h4Candles: normalBundle.h4,
      h1Candles: normalBundle.h1,
      m15Candles: normalBundle.m15,
      m5Candles: normalBundle.m5,
      feedStatus: 'LIVE',
      marketEvents: [
        {
          starts_at: new Date(PRIME_FX_NOW_MS + 25 * 60_000).toISOString(),
          currency: 'EUR',
          title: 'ECB Rate Decision',
          impact: 'HIGH',
        },
      ],
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      news30Res.direction === 'WAIT' && Boolean(news30Res.whyNotTrade?.includes('ECB Rate Decision')),
      'HIGH impact EUR news +25 min away blocks MT5 EUR/USD'
    );
  }

  // 12. Insufficient Real Candles, Risk > 3% Cap, Small Account Integrated, Synthetics Cap
  console.log('\n12. Insufficient Candles, Risk > 3% Ceiling & Synthetic Medium Cap:');
  {
    const bundle = makeBullishFxBundle();

    const emptyCandlesRes = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: [],
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'LIVE',
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      emptyCandlesRes.direction === 'WAIT' && Boolean(emptyCandlesRes.whyNotTrade?.includes('Insufficient')),
      'Missing real candles returns WAIT without fabricating OHLC bars'
    );

    const tinyBalRes = analyzeMT5Signal({
      asset: EURUSD,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'LIVE',
      accountBalance: 10,
      riskPct: 5.0, // exceeds 3% cap
      spreadPips: 1.2,
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(tinyBalRes.lotSize === 0, `End-to-end $10 account outputs 0 lots (got ${tinyBalRes.lotSize})`);
    assert(
      Boolean(tinyBalRes.accountSizingWarning?.includes('Your account is too small')),
      'End-to-end $10 account emits explicit account-too-small message'
    );
    assert(
      Boolean(tinyBalRes.riskWarning?.includes('3%') || tinyBalRes.riskWarning?.includes('3.0%')),
      'Risk > 3% is capped and emits explicit riskWarning'
    );

    // Synthetics cap High -> Medium even under full bullish alignment
    const synthD1 = makeCandles({ count: 25, startPrice: 2100, step: 15, stepSec: 86400, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 150, pipSize: 0.01 });
    const synthH4 = makeCandles({ count: 30, startPrice: 2300, step: 6, stepSec: 14400, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 80, pipSize: 0.01 });
    const synthH1 = makeCandles({ count: 40, startPrice: 2420, step: 1.5, stepSec: 3600, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 50, pipSize: 0.01 });
    const sLast = synthH1[synthH1.length - 1].close;
    const synthM15 = makeCandles({ count: 40, startPrice: sLast - 16, step: 0.4, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 30, pipSize: 0.01 });
    const synthM5 = makeCandles({ count: 40, startPrice: sLast - 8, step: 0.2, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 20, pipSize: 0.01 });
    if (synthD1.length >= 2) {
      synthD1[synthD1.length - 2] = { ...synthD1[synthD1.length - 2], high: sLast + 120, low: sLast - 120, close: sLast - 40 };
    }
    const synthMt5Res = analyzeMT5Signal({
      asset: R100,
      platform: 'mt5',
      d1Candles: synthD1,
      h4Candles: synthH4,
      h1Candles: synthH1,
      m15Candles: synthM15,
      m5Candles: synthM5,
      feedStatus: 'LIVE',
      accountBalance: 5000,
      riskPct: 1.0,
      spreadPips: 0.5,
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      synthMt5Res.strength !== 'High',
      `MT5 synthetic setup never emits High strength (got ${synthMt5Res.strength})`
    );
  }

  // 13. Stage 3.3 contract_size_overrides Validation & Migration 009 Checks
  console.log('\n13. Stage 3.3 contract_size_overrides Validation:');
  {
    // Valid payloads (empty, typical, and boundary 20 keys with 20-char keys & max value 10000000)
    const emptyOk = validateContractSizeOverrides({});
    assert(emptyOk.ok, 'Accepts empty {} contract_size_overrides object');

    const boundaryValid: Record<string, number> = {};
    for (let i = 1; i <= 20; i++) {
      boundaryValid[`SYMBOL_${String(i).padStart(12, '0')}X`.slice(0, 20)] = i === 20 ? 10000000 : i * 10;
    }
    const maxBoundaryOk = validateContractSizeOverrides(boundaryValid);
    assert(maxBoundaryOk.ok, 'Accepts 20 keys of <= 20 chars with values in (0, 10000000]');

    // Non-object rejections
    assert(!validateContractSizeOverrides([]).ok, 'Rejects array for contract_size_overrides');
    assert(!validateContractSizeOverrides('{"XAU/USD":100}').ok, 'Rejects string for contract_size_overrides');
    assert(!validateContractSizeOverrides(null).ok, 'Rejects null for contract_size_overrides');

    // > 20 keys
    const tooManyKeys: Record<string, number> = { ...boundaryValid, EXTRA_21: 100 };
    const tooManyRes = validateContractSizeOverrides(tooManyKeys);
    assert(!tooManyRes.ok && Boolean(tooManyRes.error?.includes('20')), `Rejects > 20 keys (${tooManyRes.error || ''})`);

    // Key > 20 chars or empty
    const longKeyRes = validateContractSizeOverrides({ ['A'.repeat(21)]: 100 });
    assert(!longKeyRes.ok && Boolean(longKeyRes.error?.includes('20')), 'Rejects key longer than 20 characters');
    const emptyKeyRes = validateContractSizeOverrides({ '': 100 });
    assert(!emptyKeyRes.ok, 'Rejects empty key');

    // Value <= 0, > 10000000, or non-number
    const zeroValRes = validateContractSizeOverrides({ 'XAU/USD': 0 });
    assert(!zeroValRes.ok, 'Rejects value <= 0 (0)');
    const negValRes = validateContractSizeOverrides({ 'XAU/USD': -10 });
    assert(!negValRes.ok, 'Rejects negative value (-10)');
    const hugeValRes = validateContractSizeOverrides({ 'XAU/USD': 10000001 });
    assert(!hugeValRes.ok, 'Rejects value > 10000000');
    const strValRes = validateContractSizeOverrides({ 'XAU/USD': '100' });
    assert(!strValRes.ok, 'Rejects non-numeric value ("100")');

    // Serialized JSON > 2 KB
    const over2KbRes = validateContractSizeOverrides({ ['K'.repeat(2060)]: 100 });
    assert(!over2KbRes.ok && Boolean(over2KbRes.error?.includes('2 KB')), 'Rejects serialized JSON exceeding 2 KB');

    // Verify SQL migration 009 file enforces matching bounds in update_trading_profile
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/009_profile_validation.sql'),
      'utf8'
    );
    assert(
      migrationSql.includes('CREATE OR REPLACE FUNCTION public.update_trading_profile') &&
        migrationSql.includes('octet_length(v_overrides::TEXT) > 2048') &&
        migrationSql.includes('jsonb_object_keys(v_overrides)) > 20') &&
        migrationSql.includes('char_length(v_key) > 20') &&
        migrationSql.includes("jsonb_typeof(v_val) <> 'number'") &&
        migrationSql.includes('v_val_num <= 0 OR v_val_num > 10000000'),
      'supabase/migrations/009_profile_validation.sql enforces object, 2KB, 20-key, 20-char key, and (0, 10000000] number checks'
    );
  }

  // 14. Stage 4A Market Context Calculations & History Refresh Guards
  console.log('\n14. Stage 4A Market Context & History Store Calculations:');
  {
    // 14a. Daily pivots from fixed D1 candle
    const prevDayFixed: Candle = {
      time: PRIME_FX_NOW_SEC - 86400,
      open: 1.081,
      high: 1.09,
      low: 1.08,
      close: 1.087,
    };
    const pivots = computeDailyPivotLevels(prevDayFixed);
    assert(pivots !== null, 'Computes daily pivot levels from fixed D1 candle');
    if (pivots) {
      const expectedPP = (1.09 + 1.08 + 1.087) / 3;
      const expectedR1 = 2 * expectedPP - 1.08;
      const expectedS1 = 2 * expectedPP - 1.09;
      const expectedR2 = expectedPP + 0.01;
      const expectedS2 = expectedPP - 0.01;
      assert(Math.abs(pivots.pivot - expectedPP) < 1e-8, `PP=${pivots.pivot.toFixed(6)}`);
      assert(Math.abs(pivots.r1 - expectedR1) < 1e-8, `R1=${pivots.r1.toFixed(6)}`);
      assert(Math.abs(pivots.s1 - expectedS1) < 1e-8, `S1=${pivots.s1.toFixed(6)}`);
      assert(Math.abs(pivots.r2 - expectedR2) < 1e-8, `R2=${pivots.r2.toFixed(6)}`);
      assert(Math.abs(pivots.s2 - expectedS2) < 1e-8, `S2=${pivots.s2.toFixed(6)}`);
    }

    // 14b. 30-day ATR percentile classification (quiet vs unusually active)
    const d1Quiet: Candle[] = [];
    const d1Active: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const t = PRIME_FX_NOW_SEC - (60 - i) * 86400;
      const base = 1.08 + i * 0.0001;
      // Quiet dataset starts volatile then contracts at the end
      const halfQuiet = i < 42 ? 0.004 : 0.0004;
      d1Quiet.push({ time: t, open: base, high: base + halfQuiet, low: base - halfQuiet, close: base + 0.00005 });

      // Active dataset starts narrow then expands at the end
      const halfActive = i < 42 ? 0.0004 : 0.005;
      d1Active.push({ time: t, open: base, high: base + halfActive, low: base - halfActive, close: base + 0.0001 });
    }
    const quietRegime = computeVolatilityRegime(d1Quiet, 0.0001, 30);
    const activeRegime = computeVolatilityRegime(d1Active, 0.0001, 30);
    assert(
      quietRegime.sampleCount === 30 && quietRegime.percentile30d !== null && quietRegime.percentile30d < 30 && quietRegime.regime === 'quiet',
      `30-day quiet volatility regime detected (pct=${quietRegime.percentile30d}, n=${quietRegime.sampleCount}, regime=${quietRegime.regime})`
    );
    assert(
      activeRegime.sampleCount === 30 && activeRegime.percentile30d !== null && activeRegime.percentile30d > 75 && activeRegime.regime === 'unusually active',
      `30-day unusually active volatility regime detected (pct=${activeRegime.percentile30d}, n=${activeRegime.sampleCount}, regime=${activeRegime.regime})`
    );

    // 14c. 8-week UTC session profile from fixed H1 candles (excluding bars > 8 weeks old)
    const endHourEpoch = Date.UTC(2025, 4, 15, 23, 0, 0) / 1000;
    const h1SessionBars: Candle[] = [];
    // Include one bar older than 56 days (60 days prior) with extreme range to verify exclusion
    h1SessionBars.push({
      time: endHourEpoch - 60 * 86400,
      open: 1.08,
      high: 1.15,
      low: 1.01,
      close: 1.08,
    });
    // Populate exact 56 days * 24 hours (note < 56d inclusive: startSec = end - 56*86400)
    // Using 56 * 24 = 1344 bars strictly inside trailing 56-day window:
    const totalSessionHours = 56 * 24;
    for (let k = totalSessionHours - 1; k >= 0; k--) {
      const ts = endHourEpoch - k * 3600;
      const utcH = new Date(ts * 1000).getUTCHours();
      // UTC 13 -> 25 pips (0.0025), UTC 02 -> 5 pips (0.0005), others -> 12 pips (0.0012)
      const range = utcH === 13 ? 0.0025 : utcH === 2 ? 0.0005 : 0.0012;
      h1SessionBars.push({
        time: ts,
        open: 1.085,
        high: 1.085 + range / 2,
        low: 1.085 - range / 2,
        close: 1.085,
      });
    }
    const sessionProf = computeUtcSessionProfile(h1SessionBars, 0.0001, endHourEpoch, 8);
    const hour13 = sessionProf.hours.find((h) => h.hourUtc === 13);
    const hour02 = sessionProf.hours.find((h) => h.hourUtc === 2);
    assert(
      sessionProf.totalBars === 1344,
      `8-week UTC session profile counts trailing 1344 H1 bars and excludes >8wk bar (got n=${sessionProf.totalBars})`
    );
    assert(
      hour13?.avgRangePips === 25 && hour13?.sampleCount === 56 && sessionProf.mostActiveHour?.hourUtc === 13,
      `UTC 13:00 hour range is 25.0 pips avg with n=56 (got ${hour13?.avgRangePips}p, n=${hour13?.sampleCount})`
    );
    assert(
      hour02?.avgRangePips === 5 && hour02?.sampleCount === 56 && sessionProf.quietestHour?.hourUtc === 2,
      `UTC 02:00 hour range is 5.0 pips avg with n=56 (got ${hour02?.avgRangePips}p, n=${hour02?.sampleCount})`
    );

    // 14d. Distance in pips & plain-English level phrases for EUR/USD, USD/JPY, and XAU/USD
    const eurMeta = resolveAssetPipSize(EURUSD);
    const eurDist = formatLevelDistance(1.08642, 1.085, 'Previous Day High (PDH)', eurMeta.pipSize);
    assert(
      eurMeta.pipSize === 0.0001 && eurDist.absPips === 14.2 && eurDist.plainText === 'price is 14.2 pips above Previous Day High (PDH)',
      `EUR/USD distance=${eurDist.absPips} pips (${eurDist.plainText})`
    );

    const jpyMeta = resolveAssetPipSize(USDJPY);
    const jpyDist = formatLevelDistance(154.25, 154.5, 'Daily Resistance (R1)', jpyMeta.pipSize);
    assert(
      jpyMeta.pipSize === 0.01 && jpyDist.absPips === 25 && jpyDist.plainText === 'price is 25.0 pips below Daily Resistance (R1)',
      `USD/JPY distance=${jpyDist.absPips} pips (${jpyDist.plainText})`
    );

    const xauMeta = resolveAssetPipSize(XAUUSD);
    const xauDist = formatLevelDistance(2651.5, 2650.0, 'Daily Pivot (PP)', xauMeta.pipSize);
    assert(
      xauMeta.pipSize === 0.01 && xauDist.absPips === 150 && xauDist.plainText === 'price is 150.0 pips above Daily Pivot (PP)',
      `XAU/USD distance=${xauDist.absPips} pips (${xauDist.plainText})`
    );

    // End-to-end computeMarketContext attaches sample sizes & no win-rate percentages
    const m15Fixed = makeCandles({
      count: 40,
      startPrice: 1.082,
      step: 0.0001,
      stepSec: 900,
      endEpochSec: PRIME_FX_NOW_SEC,
      spreadPips: 5,
      pipSize: 0.0001,
    });
    const ctx = computeMarketContext({
      asset: EURUSD,
      currentPrice: 1.08642,
      m15Candles: m15Fixed,
      h1Candles: h1SessionBars,
      h4Candles: d1Quiet,
      d1Candles: d1Quiet,
      nowSec: endHourEpoch,
    });
    assert(
      ctx.trendTable.length === 4 &&
        ctx.trendTable.every((r) => typeof r.sampleCount === 'number' && r.sampleCount > 0) &&
        ctx.levelsMap.length > 0 &&
        ctx.volatilityRegime.sampleCount === 30 &&
        ctx.sessionProfile.totalBars === 1344,
      'computeMarketContext produces full MTF trend, levels map, 30d volatility, and 8wk UTC session profile with sample sizes'
    );

    // 14e. Verify vercel.json has valid JSON and 20 non-synthetic daily crons + migration 010 SQL structure
    const vercelCfg = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'));
    assert(
      Array.isArray(vercelCfg.crons) &&
        vercelCfg.crons.length === 20 &&
        vercelCfg.crons.every((c: any) => typeof c.path === 'string' && !/R_|1HZ|BOOM|CRASH|JD|STPRNG/i.test(c.path)),
      `vercel.json defines 20 non-synthetic daily cron routes (got ${vercelCfg.crons?.length ?? 0})`
    );

    const mig010 = readFileSync(resolve(process.cwd(), 'supabase/migrations/010_candles_cache.sql'), 'utf8');
    assert(
      mig010.includes('CREATE TABLE IF NOT EXISTS public.candles_cache') &&
        mig010.includes('CREATE TABLE IF NOT EXISTS public.candles_refresh_log') &&
        mig010.includes('ENABLE ROW LEVEL SECURITY'),
      'supabase/migrations/010_candles_cache.sql defines idempotent tables with RLS enabled'
    );
  }

  // 15. Stage 4D Chart Overlays, Key Levels, VIP History Markers & Expiry/Invalidation
  console.log('\n15. Stage 4D Chart Overlays (BUY, SELL, LIMIT, CALL, PUT, WAIT & Levels/VIP):');
  {
    const baseMt5: MT5SignalOutput = {
      engine: 'mt5_v1',
      profile: 'MT5',
      platform: 'mt5',
      asset: 'EUR/USD',
      symbol: 'frxEURUSD',
      direction: 'BUY',
      orderKind: 'MARKET',
      entryPrice: 1.085,
      entryZone: null,
      stopLoss: 1.083,
      stopLossPips: 20,
      takeProfit1: 1.0885,
      takeProfit1Pips: 35,
      takeProfit2: 1.091,
      takeProfit2Pips: 60,
      lotSize: 0.5,
      riskMoney: 100,
      accountCurrency: 'USD',
      rewardRiskTp1: 1.75,
      rewardRiskTp2: 3.0,
      rewardRiskRatio: '1:1.75',
      validityCandles: 3,
      validityMinutes: 15,
      validityWindowDesc: '15m',
      validUntil: new Date(PRIME_FX_NOW_MS + 15 * 60_000).toISOString(),
      invalidationLevel: 1.083,
      invalidationDriftPrice: 0.002,
      invalidationRule: 'Invalidates below 1.08300',
      sessionNote: 'London-NY overlap',
      sessionQuality: 'PRIME',
      tradeManagementNote: 'Move to break-even at 1R',
      copyOrderText: 'BUY EURUSD',
      strength: 'Medium',
      rawScore: 84,
      reasons: ['H4 bullish bias', 'H1 higher low', 'M5 momentum entry'],
      structureTimeframe: 'H1',
      timeframe: 'H1',
      createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
      generatedAt: PRIME_FX_NOW_MS,
      feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
      inputsSnapshot: {},
    };

    // 15a. MT5 MARKET BUY overlays
    const buyOverlays = buildSignalChartOverlays(baseMt5);
    assert(
      buyOverlays.length === 4 &&
        buyOverlays.filter((o) => o.type === 'priceLine').length === 4 &&
        buyOverlays.some((o) => o.role === 'entry' && o.label === 'Entry' && o.price === 1.085) &&
        buyOverlays.some((o) => o.role === 'sl' && o.style === 'dashed' && o.label.includes('-20p')) &&
        buyOverlays.some((o) => o.role === 'tp1' && o.style === 'dashed' && o.label.includes('+35p')) &&
        buyOverlays.some((o) => o.role === 'tp2' && o.style === 'dashed' && o.label.includes('+60p')),
      'MT5 BUY builds Entry, dashed SL (-20p), dashed TP1 (+35p), and dashed TP2 (+60p) lines'
    );

    // 15b. MT5 MARKET SELL overlays
    const sellSignal: MT5SignalOutput = {
      ...baseMt5,
      direction: 'SELL',
      stopLoss: 1.0875,
      stopLossPips: 25,
      takeProfit1: 1.081,
      takeProfit1Pips: 40,
      takeProfit2: 1.078,
      takeProfit2Pips: 70,
      invalidationLevel: 1.0875,
    };
    const sellOverlays = buildSignalChartOverlays(sellSignal, { compact: true });
    assert(
      sellOverlays.length === 4 &&
        sellOverlays.some((o) => o.role === 'sl' && o.label === 'SL -25p') &&
        sellOverlays.some((o) => o.role === 'tp1' && o.label === 'TP1 +40p'),
      'MT5 SELL compact mobile labels fit cleanly (SL -25p, TP1 +40p)'
    );

    // 15c. MT5 LIMIT overlays render two thin entry zone lines
    const limitSignal: MT5SignalOutput = {
      ...baseMt5,
      orderKind: 'LIMIT',
      entryZone: { min: 1.0842, max: 1.0848 },
    };
    const limitOverlays = buildSignalChartOverlays(limitSignal);
    assert(
      limitOverlays.length === 5 &&
        limitOverlays.some((o) => o.role === 'entry_zone_min' && o.lineWidth === 1 && o.price === 1.0842) &&
        limitOverlays.some((o) => o.role === 'entry_zone_max' && o.lineWidth === 1 && o.price === 1.0848),
      'MT5 LIMIT draws two thin Entry Zone boundary lines plus SL, TP1, TP2 (5 lines total)'
    );

    // 15d. Binary CALL & PUT overlays (marker + Entry line)
    const callSignal: BinarySignalOutput = {
      engine: 'binary_v1',
      profile: 'BINARY_QUICK',
      platform: 'expert_option',
      asset: 'EUR/USD',
      symbol: 'frxEURUSD',
      direction: 'CALL',
      expiry: '1m',
      expirySeconds: 60,
      strength: 'Medium',
      rawScore: 82,
      reasons: ['EMA bullish', 'M5 aligned', 'Momentum expanding'],
      payoutPct: 85,
      breakEvenWinRatePct: 54.05,
      breakEvenMessage: 'Needs > 54.1% win rate to break even at 85% payout.',
      enterWithinSeconds: 6,
      createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
      validUntil: new Date(PRIME_FX_NOW_MS + 6000).toISOString(),
      generatedAt: PRIME_FX_NOW_MS,
      entryPrice: 1.08512,
      feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
      inputsSnapshot: {},
    };
    const callOverlays = buildSignalChartOverlays(callSignal);
    assert(
      callOverlays.length === 2 &&
        callOverlays.some((o) => o.type === 'marker' && o.shape === 'arrowUp' && o.position === 'belowBar') &&
        callOverlays.some((o) => o.type === 'priceLine' && o.label === 'Entry' && o.price === 1.08512),
      'Binary CALL builds arrowUp marker belowBar + horizontal Entry price line'
    );

    const putSignal: BinarySignalOutput = {
      ...callSignal,
      direction: 'PUT',
      entryPrice: 1.0849,
    };
    const putOverlays = buildSignalChartOverlays(putSignal);
    assert(
      putOverlays.length === 2 &&
        putOverlays.some((o) => o.type === 'marker' && o.shape === 'arrowDown' && o.position === 'aboveBar') &&
        putOverlays.some((o) => o.type === 'priceLine' && o.label === 'Entry' && o.price === 1.0849),
      'Binary PUT builds arrowDown marker aboveBar + horizontal Entry price line'
    );

    // 15e. WAIT state draws zero lines/markers on chart
    const waitMt5: MT5SignalOutput = { ...baseMt5, direction: 'WAIT', stopLoss: null, takeProfit1: null, takeProfit2: null };
    const waitBin: BinarySignalOutput = { ...callSignal, direction: 'WAIT' };
    assert(
      buildSignalChartOverlays(waitMt5).length === 0 && buildSignalChartOverlays(waitBin).length === 0 && buildSignalChartOverlays(null).length === 0,
      'WAIT signals (MT5 & Binary) and null draw 0 chart overlays'
    );

    // 15f. Key levels overlays capped at 8, dotted, sorted nearest to current price
    const sampleCtx = computeMarketContext({
      asset: EURUSD,
      currentPrice: 1.085,
      m15Candles: makeCandles({ count: 30, startPrice: 1.082, step: 0.0001, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC }),
      h1Candles: makeCandles({ count: 40, startPrice: 1.08, step: 0.0001, stepSec: 3600, endEpochSec: PRIME_FX_NOW_SEC }),
      h4Candles: makeCandles({ count: 30, startPrice: 1.078, step: 0.0002, stepSec: 14400, endEpochSec: PRIME_FX_NOW_SEC }),
      d1Candles: makeCandles({ count: 35, startPrice: 1.075, step: 0.0003, stepSec: 86400, endEpochSec: PRIME_FX_NOW_SEC }),
      nowSec: PRIME_FX_NOW_SEC,
    });
    const lvlOverlays = buildKeyLevelOverlays(sampleCtx, 1.085, 8);
    const distances = lvlOverlays.map((l) => Math.abs(l.price - 1.085));
    const sortedAsc = distances.every((d, i) => i === 0 || d >= distances[i - 1]);
    assert(
      lvlOverlays.length > 0 &&
        lvlOverlays.length <= 8 &&
        sortedAsc &&
        lvlOverlays.every((l) => l.style === 'dotted' && l.axisLabelVisible === false),
      `Key levels capped at <= 8 (${lvlOverlays.length}), sorted closest-first, faint dotted with hidden y-axis label`
    );

    // 15g. VIP history markers strictly hidden for free users, rendered & sorted with outcomes for VIP
    const vipHistItems: ChartHistorySignalItem[] = [
      { id: '2', asset: 'frxEURUSD', direction: 'PUT', entryPrice: 1.086, timeframe: '1m', createdAt: new Date(PRIME_FX_NOW_MS - 300_000).toISOString(), outcome: 'LOSS' },
      { id: '1', asset: 'frxEURUSD', direction: 'CALL', entryPrice: 1.084, timeframe: '1m', createdAt: new Date(PRIME_FX_NOW_MS - 600_000).toISOString(), outcome: 'WIN' },
    ];
    assert(
      buildHistoryMarkerOverlays(vipHistItems, false).length === 0,
      'Non-VIP user receives 0 signal history chart markers'
    );
    const vipMarkers = buildHistoryMarkerOverlays(vipHistItems, true);
    assert(
      vipMarkers.length === 2 &&
        (vipMarkers[0].time || 0) <= (vipMarkers[1].time || 0) &&
        Boolean(vipMarkers[0].tooltip?.includes('WIN')) &&
        Boolean(vipMarkers[1].tooltip?.includes('LOSS')),
      'VIP user receives chronologically sorted signal history markers with settled WIN/LOSS hover tooltips'
    );

    // 15h. Signal expiry & MT5 invalidation lifecycle + series timestamp snapping
    assert(
      !isChartSignalExpiredOrInvalidated(baseMt5, 1.085, PRIME_FX_NOW_MS + 60_000) &&
        isChartSignalExpiredOrInvalidated(baseMt5, 1.0829, PRIME_FX_NOW_MS + 60_000) &&
        isChartSignalExpiredOrInvalidated(baseMt5, 1.085, PRIME_FX_NOW_MS + 16 * 60_000),
      'MT5 signal clears on invalidation level breach or validity window expiry'
    );
    assert(
      !isChartSignalExpiredOrInvalidated(callSignal, 1.0851, PRIME_FX_NOW_MS + 30_000) &&
        isChartSignalExpiredOrInvalidated(callSignal, 1.0851, PRIME_FX_NOW_MS + 60_000),
      'Binary signal clears on contract expiry (60s)'
    );
    assert(
      !isChartSignalExpiredOrInvalidated(waitMt5, 1.0, PRIME_FX_NOW_MS + 999_999),
      'WAIT note stays visible until user navigates/scans again'
    );
    assert(
      snapTimestampToSeries(105, [100, 110, 120]) === 100 && snapTimestampToSeries(500, [100, 110, 120]) === 120,
      'snapTimestampToSeries aligns markers to exact series bar timestamps'
    );
  }
}

async function runHistoryRefreshGuards() {
  const callRefresh = async (query: Record<string, string>) => {
    let statusCode = 200;
    let body: any = null;
    const req = { method: 'GET', headers: {}, query };
    const res = {
      setHeader() {},
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };
    await historyRefreshHandler(req, res);
    return { statusCode, body };
  };

  const synthRejected = await callRefresh({ symbol: 'R_100', tf: 'H1' });
  assert(
    synthRejected.statusCode === 400,
    `api/history/refresh rejects synthetic index symbols with 400 (got ${synthRejected.statusCode})`
  );

  const unauthRejected = await callRefresh({ symbol: 'frxEURUSD', tf: 'H1' });
  assert(
    unauthRejected.statusCode === 401,
    `api/history/refresh rejects unauthenticated calls without cron secret with 401 (got ${unauthRejected.statusCode})`
  );
}

// ============================================================================
// 16. STAGE 4E: ANALYSIS HORIZON FIDELITY & THRESHOLDS
// ============================================================================
function runStage4EHorizonTests() {
  console.log('\n16. Stage 4E Analysis Horizon Fidelity & Thresholds:');

  const m15Bull = makeCandles({ count: 35, startPrice: 1.08, step: 0.0004, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC });
  const m5Bull = makeCandles({ count: 35, startPrice: 1.088, step: 0.00025, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC });
  const m1Bull = makeCandles({ count: 60, startPrice: 1.085, step: 0.00018, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC });
  const lastClose = m1Bull[m1Bull.length - 1].close;
  const bullTicks = makeTicks({ count: 20, startPrice: lastClose - 0.0004, step: 0.00003, endMs: PRIME_FX_NOW_MS });

  // 16a. Fixed user expiry choice is NEVER silently changed
  const fixedChoices: Array<{ exp: '1m' | '2m' | '3m' | '5m'; sec: number }> = [
    { exp: '1m', sec: 60 },
    { exp: '2m', sec: 120 },
    { exp: '3m', sec: 180 },
    { exp: '5m', sec: 300 },
  ];
  for (const { exp, sec } of fixedChoices) {
    const out = analyzeBinarySignal({
      asset: EURUSD,
      platform: 'expert_option',
      m1Candles: m1Bull,
      m5Candles: m5Bull,
      m15Candles: m15Bull,
      ticks: bullTicks,
      feedStatus: 'LIVE',
      payoutPct: 85,
      preferredExpiry: exp,
      nowMs: PRIME_FX_NOW_MS,
    });
    assert(
      out.expiry === exp && out.expirySeconds === sec,
      `Fixed binary choice '${exp}' is honoured without silent override (got ${out.expiry} / ${out.expirySeconds}s)`
    );
  }

  // 16b. Auto mode picks strictly from 1m-5m and never returns legacy 30-second window
  const autoOut = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'deriv_binary',
    m1Candles: m1Bull,
    m5Candles: m5Bull,
    m15Candles: m15Bull,
    ticks: bullTicks,
    feedStatus: 'LIVE',
    payoutPct: 85,
    preferredExpiry: 'auto',
    nowMs: PRIME_FX_NOW_MS,
  });
  const legacyWindow = '30' + 's';
  assert(
    autoOut.expiry !== legacyWindow && ['1m', '2m', '3m', '5m'].includes(autoOut.expiry),
    `Auto binary horizon picks only from 1m–5m (got ${autoOut.expiry})`
  );

  // 16c. Quiet market on 1m returns WAIT with "Try 3 or 5 minutes" suggestion, while 5m accepts aligned HTF calm drift
  const m1Quiet: Candle[] = [];
  let qPrice = 1.09;
  const qStart = PRIME_FX_NOW_SEC - 59 * 60;
  for (let i = 0; i < 60; i++) {
    // Tiny bars 0..21 produce ~8 low ATR(14) points; active bars 22..44 produce ~23 high points;
    // trailing bars 45..59 decay cleanly into ~22nd ATR percentile (blocked by 1m < 40, accepted by 5m).
    let barMove = 0.00011;
    let wick = 0.00008;
    if (i <= 21) {
      barMove = 0.00004;
      wick = 0.00003;
    } else if (i <= 44) {
      barMove = 0.00035;
      wick = 0.00025;
    }
    const open = qPrice;
    const close = open + barMove;
    m1Quiet.push({
      time: qStart + i * 60,
      open: parseFloat(open.toFixed(5)),
      high: parseFloat((Math.max(open, close) + wick).toFixed(5)),
      low: parseFloat((Math.min(open, close) - wick).toFixed(5)),
      close: parseFloat(close.toFixed(5)),
    });
    qPrice = close;
  }
  const quietTicks = makeTicks({
    count: 20,
    startPrice: m1Quiet[m1Quiet.length - 1].close - 0.0002,
    step: 0.000015,
    endMs: PRIME_FX_NOW_MS,
  });

  const quiet1m = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    m1Candles: m1Quiet,
    m5Candles: m5Bull,
    m15Candles: m15Bull,
    ticks: quietTicks,
    feedStatus: 'LIVE',
    payoutPct: 85,
    preferredExpiry: '1m',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    quiet1m.direction === 'WAIT' &&
      quiet1m.expiry === '1m' &&
      Boolean(quiet1m.whyNotTrade?.includes('Try 3 or 5 minutes')),
    `Quiet market blocks 1m with WAIT + "Try 3 or 5 minutes" suggestion (got ${quiet1m.direction}: ${quiet1m.whyNotTrade})`
  );

  const calm5m = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    m1Candles: m1Quiet,
    m5Candles: m5Bull,
    m15Candles: m15Bull,
    ticks: quietTicks,
    feedStatus: 'LIVE',
    payoutPct: 85,
    preferredExpiry: '5m',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    calm5m.expiry === '5m' && calm5m.direction === 'CALL',
    `Aligned M5+M15 calm market passes 5m where 1m blocked (got ${calm5m.direction} / ${calm5m.expiry})`
  );

  // 16d. Conflicting M5 blocks 5m with clear HTF explanation
  const m5Bear = makeCandles({ count: 35, startPrice: 1.095, step: -0.00025, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC });
  const conflict5m = analyzeBinarySignal({
    asset: EURUSD,
    platform: 'expert_option',
    m1Candles: m1Bull,
    m5Candles: m5Bear,
    m15Candles: m15Bull,
    ticks: bullTicks,
    feedStatus: 'LIVE',
    payoutPct: 85,
    preferredExpiry: '5m',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    conflict5m.direction === 'WAIT' &&
      conflict5m.expiry === '5m' &&
      Boolean(conflict5m.whyNotTrade?.includes('M5')),
    `5m blocks trade when M5 disagrees with M15 (got ${conflict5m.direction}: ${conflict5m.whyNotTrade})`
  );

  // 16e. MT5 structureTimeframe mapping (M15 vs H1) without any seconds horizon
  const d1Bull = makeCandles({ count: 40, startPrice: 1.06, step: 0.001, stepSec: 86400, endEpochSec: PRIME_FX_NOW_SEC });
  const h4Bull = makeCandles({ count: 50, startPrice: 1.072, step: 0.0006, stepSec: 14400, endEpochSec: PRIME_FX_NOW_SEC });
  const h1Bull = makeCandles({ count: 60, startPrice: 1.08, step: 0.0004, stepSec: 3600, endEpochSec: PRIME_FX_NOW_SEC });
  const mt5M15 = analyzeMT5Signal({
    asset: EURUSD,
    platform: 'mt5',
    d1Candles: d1Bull,
    h4Candles: h4Bull,
    h1Candles: h1Bull,
    m15Candles: m15Bull,
    m5Candles: m5Bull,
    structureTimeframe: 'M15',
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  const mt5H1 = analyzeMT5Signal({
    asset: EURUSD,
    platform: 'mt5',
    d1Candles: d1Bull,
    h4Candles: h4Bull,
    h1Candles: h1Bull,
    m15Candles: m15Bull,
    m5Candles: m5Bull,
    structureTimeframe: 'H1',
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    mt5M15.structureTimeframe === 'M15' &&
      mt5M15.timeframe === 'M15' &&
      mt5H1.structureTimeframe === 'H1' &&
      mt5H1.timeframe === 'H1' &&
      !mt5H1.validityWindowDesc.toLowerCase().includes('sec'),
    'MT5 cleanly selects M15 vs H1 structure timeframe with minute-based validity window'
  );

  // 16f. Verify legacy 30-second token is isolated strictly to SignalHistory.tsx
  const rootDir = resolve(process.cwd());
  const nonHistoryFilesToCheck = [
    'src/types.ts',
    'src/utils/engines/types.ts',
    'src/utils/engines/binaryEngine.ts',
    'src/utils/quantEngine.ts',
    'src/components/SignalEngine.tsx',
    'src/components/VipSafeRadarModal.tsx',
    'src/components/GuidedTourCoachMark.tsx',
    'src/components/WelcomeTutorial.tsx',
    'src/data/blogArticles.ts',
    'index.html',
  ];
  const badHits = nonHistoryFilesToCheck.filter((rel) => {
    const content = readFileSync(resolve(rootDir, rel), 'utf8');
    return content.includes(legacyWindow);
  });
  assert(
    badHits.length === 0,
    `No "${legacyWindow}" horizon string remains outside legacy SignalHistory display (found in: ${badHits.join(', ') || 'none'})`
  );
  const histSrc = readFileSync(resolve(rootDir, 'src/components/SignalHistory.tsx'), 'utf8');
  assert(
    histSrc.includes('formatHistoryHorizonLabel') && histSrc.includes(legacyWindow),
    'SignalHistory.tsx preserves legacy history row formatting cleanly'
  );
}

runSignalLogValidationTests()
  .then(() => runHistoryRefreshGuards())
  .then(() => {
    runMt5Tests();
    runStage4EHorizonTests();
    console.log('\n------------------------------------------------------------');
    console.log(`Combined Binary + MT5 + Stage 4A + Stage 4D + Stage 4E Results: ${passed}/${total} tests passed`);
    console.log('------------------------------------------------------------\n');

    if (passed !== total) {
      process.exit(1);
    }
  });
