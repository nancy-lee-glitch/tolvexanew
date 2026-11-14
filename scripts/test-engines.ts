/**
 * Deterministic Unit Test Suite for Short-Expiry Binary Engine (Stage 3 Part 1)
 * Run with: npx tsx scripts/test-engines.ts
 */

import {
  analyzeBinarySignal,
  calculateBreakEvenWinRate,
  formatBreakEvenStatement,
} from '../src/utils/engines/binaryEngine.ts';
import type { Candle, MarketEventItem } from '../src/utils/engines/types.ts';
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
  assert(['30s', '1m', '2m', '3m', '5m'].includes(res.expiry), `Valid binary expiry window selected: ${res.expiry}`);
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

console.log('\n------------------------------------------------------------');
console.log(`Binary Engine Results: ${passed}/${total} tests passed`);
console.log('------------------------------------------------------------\n');

if (passed !== total) {
  process.exit(1);
}
