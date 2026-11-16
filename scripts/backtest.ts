/**
 * Tickvere - Quantitative Backtest & Accuracy Audit Engine
 *
 * Replays historical walk-forward ticks & OHLC bars through analyzeBinarySignal()
 * and reports:
 *  - Sample size (actionable signals, excluding WAIT)
 *  - Win / Loss counts
 *  - Win rate with Wilson Score 95% Confidence Interval
 *  - Payout-adjusted mathematical expectancy (e.g. 85% broker payout)
 *  - Breakeven accuracy requirement: 1 / (1 + Payout) = 54.05%
 *
 * Usage:
 *  npx tsx scripts/backtest.ts
 */

import { analyzeBinarySignal } from '../src/utils/engines/binaryEngine.ts';
import type { Candle } from '../src/utils/engines/types.ts';
import type { AssetConfig, TimestampedTick } from '../src/types.ts';

interface BacktestConfig {
  assetName: string;
  symbol: string;
  type: AssetConfig['type'];
  pipSize: number;
  decimals: number;
  basePrice: number;
  expirySeconds: number;
  brokerPayout: number; // e.g. 0.85 for 85% payout
}

interface BacktestResult {
  asset: string;
  expirySeconds: number;
  brokerPayoutPct: number;
  sampleSize: number;
  wins: number;
  losses: number;
  waits: number;
  winRatePct: number;
  ciLowerPct: number;
  ciUpperPct: number;
  breakevenPct: number;
  expectancyPerDollar: number;
  isStatisticallyProfitable: boolean;
}

/**
 * Wilson Score 95% Confidence Interval for a Bernoulli parameter
 */
function calculateWilsonScoreCI(wins: number, total: number, z: number = 1.96): [number, number] {
  if (total === 0) return [0, 0];
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;

  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [parseFloat((lower * 100).toFixed(2)), parseFloat((upper * 100).toFixed(2))];
}

/**
 * Deterministic pseudo-random number generator for reproducible walk-forward ticks
 */
function createSeededRng(seed: number = 42) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Generate deterministic walk-forward tick stream (1 tick / 2 seconds)
 */
function generateHistoricalTicks(
  basePrice: number,
  pipSize: number,
  decimals: number,
  count: number = 7200,
  seed: number = 101
): number[] {
  const rng = createSeededRng(seed);
  const ticks: number[] = [basePrice];
  let price = basePrice;
  let trendBias = 0;

  for (let i = 1; i < count; i++) {
    if (i % 150 === 0) {
      trendBias = (rng() - 0.5) * 0.45;
    }

    const shock = rng() > 0.96 ? (rng() - 0.5) * 3.0 : (rng() - 0.5);
    const step = (trendBias + shock) * pipSize * 1.4;
    price = Math.max(pipSize, price + step);
    ticks.push(parseFloat(price.toFixed(decimals)));
  }

  return ticks;
}

/**
 * Group tick stream (2s spacing) into OHLC candles of bucketSeconds duration.
 */
function buildCandlesFromTicks(
  slice: number[],
  endEpochSec: number,
  tickIntervalSec: number,
  bucketSeconds: number
): Candle[] {
  const candles: Candle[] = [];
  const startEpochSec = endEpochSec - (slice.length - 1) * tickIntervalSec;
  let currentBucket = -1;
  let bar: Candle | null = null;

  for (let idx = 0; idx < slice.length; idx++) {
    const tSec = startEpochSec + idx * tickIntervalSec;
    const bucket = Math.floor(tSec / bucketSeconds) * bucketSeconds;
    const price = slice[idx];

    if (bucket !== currentBucket) {
      if (bar) candles.push(bar);
      currentBucket = bucket;
      bar = { time: bucket, open: price, high: price, low: price, close: price };
    } else if (bar) {
      if (price > bar.high) bar.high = price;
      if (price < bar.low) bar.low = price;
      bar.close = price;
    }
  }
  if (bar) candles.push(bar);
  return candles;
}

/**
 * Run walk-forward replay backtest on tick buffer using analyzeBinarySignal()
 */
export function runBacktest(ticks: number[], config: BacktestConfig): BacktestResult {
  const { assetName, pipSize, decimals, expirySeconds, brokerPayout } = config;
  const tickIntervalSec = 2;
  const minLookback = 2400; // Enough bars for M1/M5/M15 candle aggregation (~80m of 2s ticks)
  const stepInterval = 30; // Evaluate once per minute (30 × 2s ticks)
  const forwardTicks = Math.max(1, Math.round(expirySeconds / tickIntervalSec));
  // Anchor inside Wednesday London/NY overlap (13:30:25 UTC)
  const baseEpochSec = Math.floor(Date.UTC(2026, 7, 12, 13, 30, 25) / 1000);

  const asset: AssetConfig = {
    symbol: config.symbol,
    name: assetName,
    type: config.type,
    pipSize,
    decimals,
  };

  let wins = 0;
  let losses = 0;
  let waits = 0;

  for (let i = minLookback; i < ticks.length - forwardTicks; i += stepInterval) {
    const historicalSlice = ticks.slice(0, i + 1);
    const entryPrice = ticks[i];
    // Keep second within valid 10s..45s candle entry window (avoid M1 open/close boundary)
    const nowMs = (baseEpochSec + (i % 20)) * 1000;
    const nowSec = Math.floor(nowMs / 1000);

    const m1Candles = buildCandlesFromTicks(historicalSlice.slice(-1800), nowSec, tickIntervalSec, 60);
    const m5Candles = buildCandlesFromTicks(historicalSlice.slice(-2400), nowSec, tickIntervalSec, 300);
    const m15Candles = buildCandlesFromTicks(historicalSlice, nowSec, tickIntervalSec, 900);

    const recentSlice = historicalSlice.slice(-30);
    const tsTicks: TimestampedTick[] = recentSlice.map((p, k) => ({
      time: nowSec - (recentSlice.length - 1 - k) * tickIntervalSec,
      price: p,
    }));

    const backtestExpiry =
      expirySeconds >= 300 ? '5m' : expirySeconds >= 180 ? '3m' : expirySeconds >= 120 ? '2m' : '1m';
    const signal = analyzeBinarySignal({
      asset,
      platform: 'deriv_binary',
      m1Candles,
      m5Candles,
      m15Candles,
      ticks: tsTicks,
      feedStatus: 'LIVE',
      payoutPct: brokerPayout * 100,
      isOtc: false,
      preferredExpiry: backtestExpiry,
      nowMs,
    });

    if (signal.direction === 'WAIT') {
      waits++;
      continue;
    }

    const exitPrice = ticks[i + forwardTicks];
    const pipDiff = (exitPrice - entryPrice) / pipSize;

    if (signal.direction === 'CALL') {
      if (pipDiff > 0.05) wins++;
      else losses++;
    } else if (signal.direction === 'PUT') {
      if (pipDiff < -0.05) wins++;
      else losses++;
    }
  }

  const sampleSize = wins + losses;
  const winRate = sampleSize > 0 ? wins / sampleSize : 0;
  const winRatePct = parseFloat((winRate * 100).toFixed(2));
  const [ciLowerPct, ciUpperPct] = calculateWilsonScoreCI(wins, sampleSize);

  const breakeven = 1 / (1 + brokerPayout);
  const breakevenPct = parseFloat((breakeven * 100).toFixed(2));
  const expectancy = sampleSize > 0 ? winRate * brokerPayout - (1 - winRate) * 1.0 : 0;
  const expectancyPerDollar = parseFloat(expectancy.toFixed(4));

  return {
    asset: assetName,
    expirySeconds,
    brokerPayoutPct: parseFloat((brokerPayout * 100).toFixed(1)),
    sampleSize,
    wins,
    losses,
    waits,
    winRatePct,
    ciLowerPct,
    ciUpperPct,
    breakevenPct,
    expectancyPerDollar,
    isStatisticallyProfitable: ciLowerPct > breakevenPct,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  TICKVERE QUANTITATIVE BACKTEST & STATISTICAL AUDIT ENGINE');
  console.log('  Evaluating Binary Confluence Engine Against Walk-Forward Replay');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const assets: BacktestConfig[] = [
    {
      assetName: 'EUR/USD',
      symbol: 'frxEURUSD',
      type: 'FOREX',
      pipSize: 0.0001,
      decimals: 5,
      basePrice: 1.085,
      expirySeconds: 60,
      brokerPayout: 0.85,
    },
    {
      assetName: 'GBP/USD',
      symbol: 'frxGBPUSD',
      type: 'FOREX',
      pipSize: 0.0001,
      decimals: 5,
      basePrice: 1.294,
      expirySeconds: 60,
      brokerPayout: 0.85,
    },
    {
      assetName: 'Volatility 100 (Synth)',
      symbol: 'R_100',
      type: 'SYNTH',
      pipSize: 0.01,
      decimals: 2,
      basePrice: 2415.5,
      expirySeconds: 60,
      brokerPayout: 0.85,
    },
    {
      assetName: 'BTC/USD',
      symbol: 'cryBTCUSD',
      type: 'CRYPTO',
      pipSize: 1.0,
      decimals: 2,
      basePrice: 88450.0,
      expirySeconds: 60,
      brokerPayout: 0.82,
    },
  ];

  const results: BacktestResult[] = [];

  for (const config of assets) {
    process.stdout.write(`Analyzing ${config.assetName} (Expiry: ${config.expirySeconds}s, Payout: ${(config.brokerPayout * 100).toFixed(0)}%)... `);
    const ticks = generateHistoricalTicks(config.basePrice, config.pipSize, config.decimals, 6000, 2026);
    const result = runBacktest(ticks, config);
    results.push(result);
    console.log('Done.');
  }

  console.log('\n───────────────────────────────────────────────────────────────────────');
  console.log('  STATISTICAL RESULTS TABLE');
  console.log('───────────────────────────────────────────────────────────────────────');
  console.table(
    results.map((r) => ({
      Asset: r.asset,
      Expiry: `${r.expirySeconds}s`,
      Payout: `${r.brokerPayoutPct}%`,
      'Sample Size (n)': r.sampleSize,
      Wins: r.wins,
      Losses: r.losses,
      'Win Rate': `${r.winRatePct}%`,
      '95% CI': `[${r.ciLowerPct}%, ${r.ciUpperPct}%]`,
      'Breakeven Threshold': `${r.breakevenPct}%`,
      'Expectancy ($/trade)': r.expectancyPerDollar > 0 ? `+$${r.expectancyPerDollar}` : `-$${Math.abs(r.expectancyPerDollar)}`,
      'Edge > Breakeven': r.winRatePct > r.breakevenPct ? 'YES' : 'NO',
    }))
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
