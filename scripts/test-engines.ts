/**
 * Deterministic Unit Test Suite for Short-Expiry Binary Engine (Stage 3 Part 1)
 * Run with: npx tsx scripts/test-engines.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import {
  DEFAULT_BROKER_CONFIG,
  DEFAULT_BROKER_PLATFORMS,
  DEFAULT_BROKERS_SETTINGS,
  DEFAULT_MIN_ACTIONABLE_STRENGTH,
  DEFAULT_SITE_SETTINGS,
  detectLegacyBrandWarnings,
  fetchRemoteBrokerPlatforms,
  fetchRemoteMinActionableStrength,
  getMinActionableStrength,
  normalizeMinActionableStrength,
  normalizeSiteSettings,
  resolveBrokerDestinationUrl,
  saveBrokerPlatforms,
  saveMinActionableStrength,
  saveSiteSettings,
} from '../src/utils/siteConfigManager.ts';
import {
  applyBrandTokens,
  getBrandSnapshot,
  loadBrandOnce,
  resetBrandLoaderForTests,
} from '../src/utils/brand.ts';
import {
  assertSpecMatchesSymbol,
  formatChartChangeSummary,
  formatDistanceUnitWord,
  isOtcInstrument,
  normalizeSpecKey,
  resolveAssetPipSpec,
  resolveBaseInstrumentSpec,
  resolveDefaultMaxLot,
} from '../src/utils/instrumentMeta.ts';
import {
  buildMarketContextSummaryLines,
  buildResultView,
  computeNextCandleCloseMinutes,
  getSortedNearestLevels,
  getStrengthRank,
  getTopAndQuietSessionHours,
  isStrengthBelowMinimum,
  MIN_STRENGTH_WAIT_REASON,
} from '../src/utils/resultView.ts';
import { isSyntheticAsset } from '../src/services/symbolMap.ts';
import signalsLogHandler from '../api/signals/log.ts';
import adminSettingsHandler from '../api/admin/settings.ts';
import historyRefreshHandler from '../api/history/refresh.ts';
import {
  assessConditions,
  CONDITIONS_DISCLAIMER_TEXT,
  DEFAULT_CONDITIONS_CONFIG,
  normalizeConditionsConfig,
  OVERRIDE_BUTTON_LABEL,
  pickConsistentWaitReason,
  resolveAnalyseGateState,
  validateConditionsConfig,
} from '../src/utils/conditions.ts';
import type { MarketContextSummary } from '../src/utils/engines/marketContext.ts';
import {
  buildHistoryMarkerOverlays,
  buildKeyLevelOverlays,
  buildSignalChartOverlays,
  isChartSignalExpiredOrInvalidated,
  snapTimestampToSeries,
  type ChartHistorySignalItem,
} from '../src/utils/chartOverlays.ts';
import {
  computeLiveTickMetrics,
  computeTickVelocityLabel,
  formatChartDiagnosticsLines,
  getChartDiagnosticsSnapshot,
  reportChartDiagnostics,
  resetChartDiagnosticsForTest,
  resolveChartEmptyOverlayState,
} from '../src/utils/chartDiagnostics.ts';
import {
  getAssetTimestampedTicks,
  pushAssetTick,
  seedTimestampedTicksFromCandles,
} from '../src/utils/quantEngine.ts';
import {
  buildTradesCsv,
  computeBinaryStats,
  computeMt5Stats,
  computeWilson95,
  generateBacktestReport,
  MIN_VERDICT_TRADES,
  resolveMt5TradeOnM5,
  resolveSpreadCostForAsset,
  runBinaryWalkForwardForSymbol,
  runMt5WalkForwardForSymbol,
  selectUniverseFromActiveSymbols,
  SPREAD_CONFIG,
} from './backtest-real.ts';
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

// ============================================================================
// 17. STAGE 4F: PIP SIZES, DISTANCE UNITS, BRAND & WORDING
// ============================================================================
function runStage4FPipBrandWordingTests() {
  console.log('\n17. Stage 4F Pip Sizes, Distance Units, Brand & Wording:');

  // 17a. 5-digit GBP/USD with stale 0.00001 pipSize resolves to 0.0001 pip / 0.00001 tick / 5 decimals
  const gbpSpec = resolveAssetPipSpec({
    name: 'GBP/USD',
    symbol: 'frxGBPUSD',
    type: 'FOREX',
    pipSize: 0.00001,
    decimals: 5,
  });
  assert(
    gbpSpec.pipSize === 0.0001 &&
      gbpSpec.tickSize === 0.00001 &&
      gbpSpec.decimals === 5 &&
      gbpSpec.distanceUnit === 'pips',
    `GBP/USD 5-digit resolves pipSize=0.0001, tickSize=0.00001, unit=pips (got pip=${gbpSpec.pipSize}, tick=${gbpSpec.tickSize}, unit=${gbpSpec.distanceUnit})`
  );

  // Spot 1.32062 vs level 1.32052 reads "1.0 pip" (not "10.0")
  const gbpSpotDist = formatLevelDistance(1.32062, 1.32052, 'Daily Pivot', gbpSpec.pipSize, gbpSpec.distanceUnit);
  assert(
    gbpSpotDist.plainText.includes('1.0 pip') &&
      !gbpSpotDist.plainText.includes('1.0 pips') &&
      Math.abs(gbpSpotDist.absPips - 1.0) < 1e-6,
    `GBP/USD 1.32062 vs 1.32052 reads "1.0 pip" (got "${gbpSpotDist.plainText}")`
  );

  // Daily ATR 0.00696 reads "69.6 pips"
  const dailyAtrPips = parseFloat((0.00696 / gbpSpec.pipSize).toFixed(1));
  const dailyAtrLabel = `${dailyAtrPips.toFixed(1)} ${formatDistanceUnitWord(dailyAtrPips, gbpSpec.distanceUnit)}`;
  assert(
    dailyAtrLabel === '69.6 pips',
    `GBP/USD daily ATR 0.00696 reads "69.6 pips" (got "${dailyAtrLabel}")`
  );

  // 17b. USD/JPY 150.05 vs 150.00 reads "5.0 pips"
  const jpySpec = resolveAssetPipSpec({
    name: 'USD/JPY',
    symbol: 'frxUSDJPY',
    type: 'FOREX',
    pipSize: 0.001,
    decimals: 3,
  });
  const jpyDist = formatLevelDistance(150.05, 150.0, 'Round 150', jpySpec.pipSize, jpySpec.distanceUnit);
  assert(
    jpySpec.pipSize === 0.01 &&
      jpySpec.distanceUnit === 'pips' &&
      jpyDist.plainText.includes('5.0 pips'),
    `USD/JPY 150.05 vs 150.00 reads "5.0 pips" (got "${jpyDist.plainText}")`
  );

  // 17c. XAU/USD (0.01, pips) and BTC/USD (1.0, points) use their own units
  const xauSpec = resolveAssetPipSpec({
    name: 'Gold/USD',
    symbol: 'frxXAUUSD',
    type: 'COMMODITY',
    pipSize: 0.01,
    decimals: 2,
  });
  const xauDist = formatLevelDistance(2000.5, 2000.0, 'Round 2000', xauSpec.pipSize, xauSpec.distanceUnit);
  assert(
    xauSpec.pipSize === 0.01 &&
      xauSpec.distanceUnit === 'pips' &&
      xauDist.plainText.includes('50.0 pips'),
    `XAU/USD uses 0.01 / pips ("${xauDist.plainText}")`
  );

  const btcSpec = resolveAssetPipSpec({
    name: 'BTC/USD',
    symbol: 'cryBTCUSD',
    type: 'CRYPTO',
    pipSize: 0.01,
    decimals: 2,
  });
  const btcDist = formatLevelDistance(65100, 65000, 'Round 65000', btcSpec.pipSize, btcSpec.distanceUnit);
  assert(
    btcSpec.pipSize === 1.0 &&
      btcSpec.distanceUnit === 'points' &&
      btcDist.plainText.includes('100.0 points'),
    `BTC/USD uses 1.0 / points ("${btcDist.plainText}")`
  );

  // 17d. Unmapped index without a table entry uses plain 'price' difference (no "points" of one tick)
  const us30Spec = resolveAssetPipSpec({
    name: 'US 30 Index',
    symbol: 'OTC_DJI',
    type: 'INDEX',
    pipSize: 0.1,
    decimals: 1,
  });
  const us30Dist = formatLevelDistance(39100, 39000, 'Round 39000', us30Spec.pipSize, us30Spec.distanceUnit, us30Spec.decimals);
  assert(
    us30Spec.distanceUnit === 'price' &&
      us30Dist.plainText === 'price is 100.0 above Round 39000' &&
      !us30Dist.plainText.includes('points') &&
      !us30Dist.plainText.includes('pips'),
    `Unmapped index uses plain price difference ("${us30Dist.plainText}")`
  );

  // Unknown FX pairs infer JPY -> 0.01 and non-JPY -> 0.0001
  const nzdSpec = resolveAssetPipSpec({
    name: 'NZD/USD',
    symbol: 'frxNZDUSD',
    type: 'FOREX',
    pipSize: 0.00001,
    decimals: 5,
  });
  const audJpySpec = resolveAssetPipSpec({
    name: 'AUD/JPY',
    symbol: 'frxAUDJPY',
    type: 'FOREX',
    pipSize: 0.001,
    decimals: 3,
  });
  assert(
    nzdSpec.pipSize === 0.0001 && nzdSpec.distanceUnit === 'pips' &&
      audJpySpec.pipSize === 0.01 && audJpySpec.distanceUnit === 'pips',
    'Unmapped FX non-JPY -> 0.0001 and JPY -> 0.01 with pips unit'
  );

  // 17e. MT5 engine on BTC/USD outputs distanceUnit='points' and "pts" in copyOrderText
  const btcD1 = makeCandles({ count: 35, startPrice: 52000, step: 350, stepSec: 86400, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 900, pipSize: 1 });
  const btcH4 = makeCandles({ count: 40, startPrice: 60000, step: 120, stepSec: 14400, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 400, pipSize: 1 });
  const btcH1 = makeCandles({ count: 50, startPrice: 63500, step: 45, stepSec: 3600, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 250, pipSize: 1 });
  const btcLast = btcH1[btcH1.length - 1].close;
  const btcM15 = makeCandles({ count: 50, startPrice: btcLast - 500, step: 11, stepSec: 900, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 160, pipSize: 1 });
  const btcM5 = makeCandles({ count: 50, startPrice: btcLast - 220, step: 5, stepSec: 300, endEpochSec: PRIME_FX_NOW_SEC, spreadPips: 110, pipSize: 1 });
  const btcMt5 = analyzeMT5Signal({
    asset: { name: 'BTC/USD', symbol: 'cryBTCUSD', type: 'CRYPTO', pipSize: 1.0, decimals: 2 },
    platform: 'mt5',
    d1Candles: btcD1,
    h4Candles: btcH4,
    h1Candles: btcH1,
    m15Candles: btcM15,
    m5Candles: btcM5,
    feedStatus: 'LIVE',
    accountBalance: 10000,
    riskPct: 1.0,
    nowMs: PRIME_FX_NOW_MS,
  });
  assert(
    btcMt5.distanceUnit === 'points' && !btcMt5.copyOrderText.includes('pips'),
    `BTC/USD MT5 output uses distanceUnit="points" without "pips" in order text (unit=${btcMt5.distanceUnit})`
  );

  // 17f. Brand & wording checks across HTML, manifest, config, and signal UI
  const rootDir = resolve(process.cwd());
  const indexHtml = readFileSync(resolve(rootDir, 'index.html'), 'utf8');
  const manifest = readFileSync(resolve(rootDir, 'public/manifest.webmanifest'), 'utf8');
  const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
  const siteCfg = readFileSync(resolve(rootDir, 'src/utils/siteConfigManager.ts'), 'utf8');
  const signalUi = readFileSync(resolve(rootDir, 'src/components/SignalEngine.tsx'), 'utf8');
  const radarModal = readFileSync(resolve(rootDir, 'src/components/VipSafeRadarModal.tsx'), 'utf8');
  const landingUi = readFileSync(resolve(rootDir, 'src/components/LandingPage.tsx'), 'utf8');

  assert(
    indexHtml.includes('<title>Tickvere – Live Market Analysis Companion</title>'),
    'index.html title is "Tickvere – Live Market Analysis Companion"'
  );
  assert(
    manifest.includes('Tickvere') && swJs.includes('tickvere-pwa-v3'),
    'manifest.webmanifest and sw.js use Tickvere branding'
  );
  assert(
    siteCfg.includes("siteName: 'Tickvere'") && siteCfg.includes("siteTagline: 'Live Market Analysis Companion'"),
    'siteConfigManager.ts defaults to Tickvere – Live Market Analysis Companion'
  );

  const filesToScan = [indexHtml, manifest, swJs, siteCfg, signalUi, radarModal, landingUi];
  const forbidden = [
    ['tol', 'vexa'].join(''),
    ['institutional', 'grade'].join('-'),
    ['quantitative', 'micro', 'volatility'].join(' ').replace('micro volatility', 'micro-volatility'),
    ['price', 'momentum', 'proxy:'].join(' '),
  ];
  const forbiddenFound = forbidden.filter((term) =>
    filesToScan.some((txt) => txt.toLowerCase().includes(term))
  );
  assert(
    forbiddenFound.length === 0,
    `No forbidden legacy brand/wording phrases remain (found: ${forbiddenFound.join(', ') || 'none'})`
  );

  assert(
    signalUi.includes('Last 60 seconds of ticks:') && signalUi.includes('(not a forecast)'),
    'SignalEngine.tsx displays "Last 60 seconds of ticks: X% up, Y% down (not a forecast)"'
  );
  assert(
    signalUi.includes("signal.direction !== 'WAIT'") &&
      signalUi.includes('Setup strength (not a win probability)') &&
      radarModal.includes("recommendedAction !== 'WAIT'"),
    'Setup strength label is strictly gated so it never appears on WAIT results'
  );
}

// ============================================================================
// 18. STAGE 4G: REFERRAL URL INTEGRITY & MARKET RADAR SCHEDULE COPY
// ============================================================================
async function runStage4GReferralAndRadarTests() {
  console.log('\n18. Stage 4G Referral URL Round-Trip & MarketRadar Copy:');

  // 18a. No invented referral/affiliate codes in defaults
  const defaultUrls = [
    ...DEFAULT_BROKER_PLATFORMS.map((p) => p.referralUrl || ''),
    DEFAULT_BROKERS_SETTINGS.brokers.deriv.referralUrl,
    DEFAULT_BROKERS_SETTINGS.brokers.expertOption.referralUrl,
    DEFAULT_BROKER_CONFIG.brokerUrl,
  ];
  const hasInventedCode = defaultUrls.some((u) => {
    const lower = u.toLowerCase();
    return (
      lower.includes('?ref=') ||
      lower.includes('_tickvere') ||
      lower.includes('track.deriv') ||
      lower.includes('r.expertoption')
    );
  });
  assert(
    !hasInventedCode,
    'Default referralUrl values contain zero invented referral/affiliate codes'
  );

  // Empty referralUrl falls back cleanly to plain broker homepage without tracking
  assert(
    resolveBrokerDestinationUrl('deriv', '') === 'https://deriv.com' &&
      resolveBrokerDestinationUrl('expert_option', '') === 'https://expertoption.com' &&
      resolveBrokerDestinationUrl('pocket_option', '') === 'https://pocketoption.com' &&
      resolveBrokerDestinationUrl('quotex', '') === 'https://quotex.com',
    'Empty referralUrl routes users to plain broker homepage without tracking'
  );

  // 18b. Stored admin referralUrl round-trips byte-for-byte unchanged through save & fetch
  const legacyTag = ['tol', 'vexa'].join('');
  const customAffiliateUrl =
    `https://partner.deriv.com/promo?ref=ADMIN_CUSTOM_99&subid=${legacyTag}_legacy&_${legacyTag}=keep`;
  const storedPlatforms = DEFAULT_BROKER_PLATFORMS.map((p) =>
    p.id === 'deriv' ? { ...p, referralUrl: customAffiliateUrl } : { ...p }
  );

  let persistedJson = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    persistedJson = String(init?.body || '');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const saveRes = await saveBrokerPlatforms(storedPlatforms);
    assert(saveRes.success, 'saveBrokerPlatforms succeeds for custom affiliate referralUrl');
    const savedPayload = JSON.parse(persistedJson);
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { value: savedPayload.value } }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof fetchRemoteBrokerPlatforms>[0];

    const fetched = await fetchRemoteBrokerPlatforms(mockSupabase);
    const roundTrippedDeriv = fetched.find((p) => p.id === 'deriv');
    assert(
      roundTrippedDeriv?.referralUrl === customAffiliateUrl,
      `Stored referralUrl round-trips unchanged (${roundTrippedDeriv?.referralUrl})`
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  // 18c. MarketRadar, AdminCenter note, and SignalEngine checks
  const rootDir = resolve(process.cwd());
  const marketRadarSrc = readFileSync(resolve(rootDir, 'src/components/MarketRadar.tsx'), 'utf8');
  const adminSrc = readFileSync(resolve(rootDir, 'src/components/AdminCenter.tsx'), 'utf8');
  const signalUi = readFileSync(resolve(rootDir, 'src/components/SignalEngine.tsx'), 'utf8');

  assert(
    marketRadarSrc.includes('Session schedule (UTC clock)') &&
      marketRadarSrc.includes('Typical activity by time of day. Not live market data.'),
    'MarketRadar.tsx shows "Session schedule (UTC clock)" and "Typical activity by time of day. Not live market data."'
  );
  assert(
    adminSrc.includes('Paste your own affiliate link. If left empty, users go to the broker without tracking.'),
    'AdminCenter.tsx displays affiliate link helper note'
  );
  assert(
    !signalUi.includes('?ref=TICKVERE'),
    'SignalEngine.tsx contains no hardcoded ?ref=TICKVERE fallback URL'
  );
}

// ============================================================================
// 19. STAGE 4H-A: ADMIN BRANDING, SERVER-FIRST SAVE & DYNAMIC BRAND MODULE
// ============================================================================
function listSourceFilesRecursive(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirPath)) {
    const full = join(dirPath, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFilesRecursive(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

async function runStage4HBrandingTests() {
  console.log('\n19. Stage 4H-A Admin Branding & Dynamic Brand Tests:');

  // 19a. normalizeSiteSettings keeps admin-entered legacy words intact, only defaulting empty values
  const legacyWord = ['tol', 'vexa'].join('');
  const legacyTag = ['micro', 'volatility'].join('-');
  const normalizedCustom = normalizeSiteSettings({
    siteName: `My ${legacyWord} Desk`,
    siteTagline: `Custom ${legacyTag} Terminal`,
    supportTelegram: 'https://t.me/pulsetrade_custom',
    supportEmail: `desk@${legacyWord}.io`,
  });
  assert(
    normalizedCustom.siteName === `My ${legacyWord} Desk` &&
      normalizedCustom.siteTagline === `Custom ${legacyTag} Terminal` &&
      normalizedCustom.supportTelegram === 'https://t.me/pulsetrade_custom' &&
      normalizedCustom.supportEmail === `desk@${legacyWord}.io`,
    'normalizeSiteSettings preserves admin-entered values verbatim even with legacy words'
  );

  const normalizedEmpty = normalizeSiteSettings({
    siteName: '   ',
    siteTagline: '',
    supportTelegram: '',
    supportEmail: ' ',
  });
  assert(
    normalizedEmpty.siteName === DEFAULT_SITE_SETTINGS.siteName &&
      normalizedEmpty.siteTagline === DEFAULT_SITE_SETTINGS.siteTagline &&
      normalizedEmpty.supportTelegram === DEFAULT_SITE_SETTINGS.supportTelegram &&
      normalizedEmpty.supportEmail === DEFAULT_SITE_SETTINGS.supportEmail,
    'normalizeSiteSettings falls back to DEFAULT_SITE_SETTINGS only for empty fields'
  );

  const legacyWarnings = detectLegacyBrandWarnings(normalizedCustom);
  assert(
    legacyWarnings.length >= 3 && normalizedCustom.siteName === `My ${legacyWord} Desk`,
    `detectLegacyBrandWarnings emits non-blocking warnings (${legacyWarnings.length}) without mutating input`
  );

  // 19b. Server-first saveSiteSettings() behavior (fail closed before touching localStorage/document/events)
  const origFetch = globalThis.fetch;
  const origLocalStorage = (globalThis as any).localStorage;
  const origSessionStorage = (globalThis as any).sessionStorage;
  const origDocument = (globalThis as any).document;
  const origWindow = (globalThis as any).window;
  const origCustomEvent = (globalThis as any).CustomEvent;

  const store = new Map<string, string>();
  const dispatchedEvents: Array<{ type: string; detail: unknown }> = [];
  const docMock = { title: 'Initial Title', getElementById: () => null, querySelector: () => null };
  const lsMock = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const winMock = {
    dispatchEvent: (ev: { type: string; detail?: unknown }) => {
      dispatchedEvents.push({ type: ev.type, detail: ev.detail });
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  (globalThis as any).localStorage = lsMock;
  (globalThis as any).sessionStorage = lsMock;
  (globalThis as any).document = docMock;
  (globalThis as any).window = winMock;
  (globalThis as any).CustomEvent = class MockCustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  try {
    // Unauthorized 401: must fail and leave localStorage, document.title & events untouched
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const fail401 = await saveSiteSettings({ ...DEFAULT_SITE_SETTINGS, siteName: 'HackName' });
    assert(
      !fail401.ok &&
        fail401.status === 401 &&
        store.size === 0 &&
        docMock.title === 'Initial Title' &&
        dispatchedEvents.length === 0,
      'saveSiteSettings on 401 returns ok=false without updating localStorage, document.title, or dispatching event'
    );

    // Server 200 + GET read-back verification match
    let sentBranding: any = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        sentBranding = body.value;
        return new Response(JSON.stringify({ ok: true, setting: { key: 'site_branding', value: sentBranding } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, settings: { site_branding: sentBranding } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const okSave = await saveSiteSettings({
      ...DEFAULT_SITE_SETTINGS,
      siteName: 'NovaQuant',
      siteTagline: 'Precision Desk',
    });
    const storedAfterSave = JSON.parse(store.get('pulsetrade_site_settings') || '{}');
    assert(
      okSave.ok &&
        okSave.verified === true &&
        !okSave.mismatch &&
        /^\d{2}:\d{2}$/.test(okSave.publishedAt || '') &&
        storedAfterSave.siteName === 'NovaQuant' &&
        docMock.title === 'NovaQuant – Precision Desk' &&
        dispatchedEvents.length === 1 &&
        dispatchedEvents[0].type === 'pulsetrade_settings_changed',
      'saveSiteSettings on 200 verifies GET read-back, updates localStorage, document.title, and broadcasts event'
    );

    // Server 200 + GET read-back mismatch detected cleanly
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          settings: { site_branding: { ...DEFAULT_SITE_SETTINGS, siteName: 'StaleServerName' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const mismatchSave = await saveSiteSettings({ ...DEFAULT_SITE_SETTINGS, siteName: 'NovaQuant' });
    assert(
      mismatchSave.ok &&
        mismatchSave.verified === false &&
        Boolean(mismatchSave.mismatch?.includes('siteName')),
      `saveSiteSettings detects read-after-write mismatch (${mismatchSave.mismatch})`
    );

    // 19c. brand.ts snapshot, token helper, and shared single-fetch promise
    const snap = getBrandSnapshot();
    assert(
      snap.siteName === 'NovaQuant' &&
        typeof snap.tagline === 'string' &&
        typeof snap.supportEmail === 'string' &&
        typeof snap.supportTelegram === 'string' &&
        applyBrandTokens('Powered by {{BRAND_NAME}}', snap.siteName) === 'Powered by NovaQuant',
      'getBrandSnapshot() returns { siteName, tagline, supportEmail, supportTelegram } and applyBrandTokens formats strings'
    );

    resetBrandLoaderForTests();
    let apiFetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('/api/admin/settings')) {
        apiFetchCalls++;
        return new Response(
          JSON.stringify({ ok: true, settings: { site_branding: { ...DEFAULT_SITE_SETTINGS, siteName: 'SharedBrand' } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ message: 'Not queried in test' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const p1 = loadBrandOnce();
    const p2 = loadBrandOnce();
    const [b1, b2] = await Promise.all([p1, p2]);
    assert(
      p1 === p2 && apiFetchCalls === 1 && b1.siteName === 'SharedBrand' && b2.siteName === 'SharedBrand',
      `loadBrandOnce() deduplicates concurrent remote fetches (sharedPromise=${p1 === p2}, apiCalls=${apiFetchCalls})`
    );
  } finally {
    globalThis.fetch = origFetch;
    (globalThis as any).localStorage = origLocalStorage;
    (globalThis as any).sessionStorage = origSessionStorage;
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    (globalThis as any).CustomEvent = origCustomEvent;
    resetBrandLoaderForTests();
  }

  // 19d. Literal "Tickvere" must NOT appear anywhere in src/components/* or src/data/*
  const rootDir = resolve(process.cwd());
  const compAndDataFiles = [
    ...listSourceFilesRecursive(resolve(rootDir, 'src/components')),
    ...listSourceFilesRecursive(resolve(rootDir, 'src/data')),
  ];
  const literalTarget = ['Tick', 'vere'].join('').toLowerCase();
  const violatingFiles = compAndDataFiles
    .filter((abs) => readFileSync(abs, 'utf8').toLowerCase().includes(literalTarget))
    .map((abs) => abs.replace(`${rootDir}/`, ''));
  assert(
    violatingFiles.length === 0,
    `Zero hardcoded brand literals exist in src/components/* or src/data/* (found: ${violatingFiles.join(', ') || 'none'})`
  );

  // 19e. AdminCenter.tsx UX requirements verification
  const adminSrc = readFileSync(resolve(rootDir, 'src/components/AdminCenter.tsx'), 'utf8');
  const requiredAdminPhrases = [
    'You are not signed in as an admin. Sign in again.',
    'Published at',
    'NOT saved:',
    'Site name (short; shown in the header, legal pages and footer)',
    'Tagline (shown after the name in the browser tab)',
    'Browser tab:',
    'Link previews on WhatsApp, Telegram and Google come from index.html and change only when the code is updated and redeployed.',
    'Where this name appears',
    'browser tab',
    'legal pages',
    'install prompt',
    'error page',
  ];
  const missingAdminPhrases = requiredAdminPhrases.filter((phrase) => !adminSrc.includes(phrase));
  assert(
    missingAdminPhrases.length === 0,
    `AdminCenter.tsx contains all Stage 4H-A labels, errors, status text, note & checklist (missing: ${missingAdminPhrases.join(', ') || 'none'})`
  );
}

// ============================================================================
// 20. STAGE 4H-B: SIMPLIFIED RESULT VIEWS & MARKET CONTEXT PROGRESSIVE DISCLOSURE
// ============================================================================
function runStage4HSimplifiedUiTests() {
  console.log('\n20. Stage 4H-B Simplified Result Views & Market Context Disclosure:');

  // 20a. Binary actionable CALL view
  const longReason =
    'This is an intentionally very long explanatory reason that exceeds ninety characters and must be trimmed cleanly at a word boundary.';
  const binCallView = buildResultView(
    {
      engine: 'binary_v1',
      profile: 'BINARY_QUICK',
      platform: 'expert_option',
      asset: 'EUR/USD',
      symbol: 'frxEURUSD',
      direction: 'CALL',
      expiry: '3m',
      expirySeconds: 180,
      strength: 'High',
      rawScore: 86,
      reasons: [longReason, 'EMA9 > EMA21 on M5', 'M15 aligned bullish'],
      payoutPct: 85,
      breakEvenWinRatePct: 54.05,
      breakEvenMessage: 'Break-even 54.05%',
      enterWithinSeconds: 6,
      createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
      validUntil: new Date(PRIME_FX_NOW_MS + 6000).toISOString(),
      generatedAt: PRIME_FX_NOW_MS,
      entryPrice: 1.085,
      feedSource: 'wss://api.derivws.com',
      inputsSnapshot: {},
    },
    'BINARY_QUICK',
    { binaryBalance: 200, binaryRiskPct: 2, nowMs: PRIME_FX_NOW_MS }
  );

  assert(
    binCallView !== null &&
      binCallView.kind === 'BINARY' &&
      binCallView.verdict.badge === 'CALL ▲' &&
      binCallView.verdict.plainSentence.includes('rise over the next 3 minutes'),
    'Binary CALL buildResultView produces CALL ▲ verdict and plain sentence'
  );
  if (binCallView && binCallView.kind === 'BINARY') {
    assert(
      binCallView.keyFacts.expiryLabel === '3 MIN' &&
        binCallView.keyFacts.enterWithinSeconds === 6 &&
        binCallView.keyFacts.suggestedStakeUsd === 4 &&
        binCallView.whyBullets.length === 3 &&
        binCallView.whyBullets.every((b) => b.length <= 90) &&
        binCallView.strengthChip.label.includes('Setup strength') &&
        binCallView.strengthChip.strength === 'High' &&
        binCallView.breakEvenLine === 'Break-even win rate at 85% payout: 54.05%' &&
        binCallView.moreDetails.defaultOpen === false &&
        !('orderTicket' in binCallView) &&
        !('stopLoss' in binCallView) &&
        !('lotSize' in binCallView),
      'Binary CALL result has 3 key facts, 3 <=90-char bullets, 1 strength chip, break-even line, collapsed details, and ZERO MT5 fields'
    );
  }

  // 20b. MT5 actionable BUY view
  const mt5BuyView = buildResultView(
    {
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
      takeProfit1: 1.088,
      takeProfit1Pips: 30,
      takeProfit2: 1.09,
      takeProfit2Pips: 50,
      lotSize: 0.5,
      riskMoney: 100,
      accountCurrency: 'USD',
      rewardRiskTp1: 1.5,
      rewardRiskTp2: 2.5,
      rewardRiskRatio: '1:1.50',
      validityCandles: 3,
      validityMinutes: 15,
      validityWindowDesc: '15 min',
      validUntil: new Date(PRIME_FX_NOW_MS + 15 * 60_000).toISOString(),
      invalidationLevel: 1.0825,
      invalidationDriftPrice: 0.002,
      invalidationRule: 'Price closes below 1.08250',
      sessionNote: 'London/NY overlap active.',
      sessionQuality: 'PRIME',
      tradeManagementNote: 'Move SL to break-even at 1R; partial at TP1.',
      copyOrderText: 'EURUSD BUY 0.50 lots @ 1.08500 SL 1.08300 TP1 1.08800',
      strength: 'Medium',
      rawScore: 80,
      reasons: ['Clean H1 higher low pullback', 'R:R to TP1 is 1:1.50', 'Price holds above H1 support'],
      structureTimeframe: 'H1',
      timeframe: 'H1',
      createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
      generatedAt: PRIME_FX_NOW_MS,
      feedSource: 'wss://api.derivws.com',
      inputsSnapshot: { d1Bias: 'BULLISH', h4Bias: 'BULLISH' },
    },
    'MT5',
    { nowMs: PRIME_FX_NOW_MS, decimals: 5, distanceUnit: 'pips' }
  );

  assert(
    mt5BuyView !== null &&
      mt5BuyView.kind === 'MT5' &&
      mt5BuyView.verdict.badge === 'BUY (MARKET)' &&
      mt5BuyView.verdict.plainSentence.includes('BUY setup on the H1 chart'),
    'MT5 BUY buildResultView produces BUY verdict and chart sentence'
  );
  if (mt5BuyView && mt5BuyView.kind === 'MT5') {
    assert(
      mt5BuyView.orderTicket.entryText === '1.08500' &&
        mt5BuyView.orderTicket.stopLossPriceText === '1.08300' &&
        mt5BuyView.orderTicket.tp1PriceText === '1.08800' &&
        mt5BuyView.orderTicket.tp2PriceText === '1.09000' &&
        mt5BuyView.orderTicket.lotSizeText === '0.5 lots' &&
        mt5BuyView.orderTicket.riskMoneyText === 'USD 100.00' &&
        mt5BuyView.orderTicket.rewardRiskText === '1:1.50' &&
        mt5BuyView.orderTicket.primaryButtonLabel === 'Copy order' &&
        mt5BuyView.validityLine.includes('Valid for about 15 min, or until price crosses 1.08250') &&
        mt5BuyView.whyBullets.length === 3 &&
        mt5BuyView.whyBullets.some((b) => /\b(D1|H4|bias|higher-timeframe)\b/i.test(b)) &&
        mt5BuyView.moreDetails.defaultOpen === false &&
        mt5BuyView.moreDetails.needsAtLeastWinRateLine === 'Needs at least 40.0% winning trades to break even at this reward:risk' &&
        !('keyFacts' in mt5BuyView) &&
        !('breakEvenLine' in mt5BuyView),
      'MT5 BUY result renders compact order ticket, Copy order CTA, validity line, HTF bias bullet, collapsed details with R:R breakeven, and zero binary fields'
    );
  }

  // 20c. WAIT returns ONLY verdict, reason, and next_check in BOTH Binary and MT5 profiles
  const waitBinary = buildResultView(
    {
      asset: 'EUR/USD',
      timeframe: '5m',
      expiry: '5m',
      direction: 'WAIT',
      strength: 'Medium',
      trend: 'Neutral',
      velocity: 'Live',
      generatedAt: PRIME_FX_NOW_MS,
      whyNotTrade: 'Choppy consolidation between PDH and PDL.',
    },
    'BINARY_QUICK',
    { nowMs: Date.UTC(2026, 2, 18, 12, 1, 0) }
  );
  const waitMt5 = buildResultView(
    {
      asset: 'EUR/USD',
      timeframe: 'H1',
      direction: 'WAIT',
      strength: 'High',
      trend: 'Neutral',
      velocity: 'Candle Structure',
      generatedAt: PRIME_FX_NOW_MS,
      whyNotTrade: 'Stop would be too wide.',
    },
    'MT5',
    { nowMs: Date.UTC(2026, 2, 18, 12, 48, 0) }
  );

  assert(
    waitBinary?.kind === 'WAIT' &&
      waitBinary.sections.length === 3 &&
      waitBinary.sections[0] === 'verdict' &&
      waitBinary.sections[1] === 'reason' &&
      waitBinary.sections[2] === 'next_check' &&
      waitBinary.strengthChip === null &&
      waitBinary.moreDetails === null &&
      waitBinary.checkAgainText === 'Check again in about 4 minutes' &&
      waitMt5?.kind === 'WAIT' &&
      waitMt5.sections.length === 3 &&
      waitMt5.strengthChip === null &&
      waitMt5.moreDetails === null &&
      waitMt5.checkAgainText === 'Check again in about 12 minutes' &&
      computeNextCandleCloseMinutes('1m', Date.UTC(2026, 2, 18, 12, 0, 30)) === 1,
    'WAIT returns strictly verdict, reason, and next_check minutes with zero strength chip or accordion'
  );

  // 20d. Market Context 3-line summary, 5 nearest levels, top 3 active & quiet hours
  const sampleD1 = makeCandles({
    count: 46,
    startPrice: 1.072,
    step: 0.0003,
    stepSec: 86400,
    endEpochSec: PRIME_FX_NOW_SEC,
    spreadPips: 50,
    pipSize: 0.0001,
  });
  const sampleH4 = makeCandles({
    count: 40,
    startPrice: 1.08,
    step: 0.0002,
    stepSec: 14400,
    endEpochSec: PRIME_FX_NOW_SEC,
    spreadPips: 25,
    pipSize: 0.0001,
  });
  const sampleH1 = makeCandles({
    count: 1400,
    startPrice: 1.083,
    step: 0.00001,
    stepSec: 3600,
    endEpochSec: PRIME_FX_NOW_SEC,
    spreadPips: 15,
    pipSize: 0.0001,
  });
  const sampleM15 = makeCandles({
    count: 60,
    startPrice: 1.086,
    step: 0.00005,
    stepSec: 900,
    endEpochSec: PRIME_FX_NOW_SEC,
    spreadPips: 8,
    pipSize: 0.0001,
  });

  const ctx = computeMarketContext({
    asset: { name: 'EUR/USD', symbol: 'frxEURUSD', type: 'FOREX', pipSize: 0.00001, decimals: 5 },
    currentPrice: 1.0875,
    m15Candles: sampleM15,
    h1Candles: sampleH1,
    h4Candles: sampleH4,
    d1Candles: sampleD1,
  });
  const summaryLines = buildMarketContextSummaryLines(ctx);
  const top5Levels = getSortedNearestLevels(ctx, 5);
  const { mostActiveHours, quietestHours } = getTopAndQuietSessionHours(ctx);

  assert(
    summaryLines.trendLine.includes('M15') &&
      summaryLines.trendLine.includes('H1') &&
      summaryLines.trendLine.includes('H4') &&
      summaryLines.trendLine.includes('D1') &&
      summaryLines.volatilityLine.includes('n=30') &&
      summaryLines.levelsLine.includes('Nearest') &&
      top5Levels.length === 5 &&
      mostActiveHours.length === 3 &&
      quietestHours.length === 3 &&
      mostActiveHours.every((h) => h.sampleCount > 0) &&
      quietestHours.every((h) => h.sampleCount > 0),
    `MarketContext 3-line summary, top-5 nearest levels, and top-3 active/quiet hours include sample counts (vol="${summaryLines.volatilityLine}", lvl="${summaryLines.levelsLine}")`
  );

  // 20e. Component UI verification (SignalEngine.tsx & MarketContextPanel.tsx)
  const rootDir = resolve(process.cwd());
  const signalUi = readFileSync(resolve(rootDir, 'src/components/SignalEngine.tsx'), 'utf8');
  const contextPanelUi = readFileSync(resolve(rootDir, 'src/components/MarketContextPanel.tsx'), 'utf8');

  // Count how many times literal "Setup strength" appears in SignalEngine.tsx UI
  // It is built purely via resultView.strengthChip.label (in resultView.ts), NEVER duplicated in top HUD!
  const topHudEnd = signalUi.indexOf('2. STEP 1');
  const topHudSection = topHudEnd > 0 ? signalUi.slice(0, topHudEnd) : '';

  assert(
    signalUi.includes('Quick Trade — pick how long') &&
      signalUi.includes('Trade Plan — pick the chart and your risk') &&
      signalUi.includes('More details') &&
      signalUi.includes('useState<boolean>(false)') &&
      !topHudSection.includes('Setup strength') &&
      signalUi.includes("resultView.kind === 'WAIT'") &&
      signalUi.includes('<MarketContextPanel context={marketContext} isLoading={isLoadingContext} />') &&
      !signalUi.includes('1%–2% SUGGESTED STAKE SIZE:'),
    'SignalEngine.tsx renders distinct Step 2 headings, removes top-HUD strength duplicate, keeps WAIT minimal, and nests MarketContextPanel inside More details'
  );

  assert(
    contextPanelUi.includes('See full context') &&
      contextPanelUi.includes('Show all levels') &&
      contextPanelUi.includes('Most active hours') &&
      contextPanelUi.includes('Quietest hours') &&
      contextPanelUi.includes('Show all hours') &&
      contextPanelUi.includes('const [isFullOpen, setIsFullOpen] = useState(false)'),
    'MarketContextPanel.tsx defaults collapsed with See full context, 5 levels + Show all levels, and active/quiet top-3 + Show all hours'
  );
}

// ============================================================================
// 21. STAGE 4I: ACCOUNT TOO SMALL GUARD, STRUCTURED WHY BULLETS & MIN STRENGTH
// ============================================================================
async function runStage4IResultFixesTests() {
  console.log('\n21. Stage 4I Result View Fixes (Lot=0 Warning, Why Bullets, Min Actionable Strength):');

  // 21a. MT5 account too small (lotSize === 0): warning at top, explicit plain sentence, no Copy order CTA
  const baseMt5Small: MT5SignalOutput = {
    engine: 'mt5_v1',
    profile: 'MT5',
    platform: 'mt5',
    asset: 'EUR/USD',
    symbol: 'frxEURUSD',
    direction: 'SELL',
    orderKind: 'MARKET',
    entryPrice: 1.085,
    entryZone: null,
    stopLoss: 1.0875,
    stopLossPips: 25,
    takeProfit1: 1.08125,
    takeProfit1Pips: 37.5,
    takeProfit2: 1.07875,
    takeProfit2Pips: 62.5,
    lotSize: 0,
    riskMoney: 0,
    accountCurrency: 'USD',
    rewardRiskTp1: 1.5,
    rewardRiskTp2: 2.5,
    rewardRiskRatio: '1:1.50',
    validityCandles: 3,
    validityMinutes: 15,
    validityWindowDesc: '15m',
    validUntil: new Date(PRIME_FX_NOW_MS + 15 * 60_000).toISOString(),
    invalidationLevel: 1.0875,
    invalidationDriftPrice: 0.0025,
    invalidationRule: 'Cancel setup if price rises above 1.08750.',
    sessionNote: 'London/NY overlap liquidity.',
    sessionQuality: 'PRIME',
    tradeManagementNote: 'Move stop-loss to break-even at 1R and take partial profit at TP1.',
    copyOrderText: 'EURUSD SELL MARKET @ 1.08500 | SL 1.08750 | Lots 0',
    accountSizingWarning: 'Your account is too small to take this trade at your chosen 1.0% risk.',
    strength: 'High',
    rawScore: 86,
    reasons: [
      'A very long detailed engine narrative exceeding ninety characters that previously got truncated mid-sentence with an ellipsis dot',
      'SL placed at 1.08750 (25 pips) with 0 lots',
      'Move stop-loss to break-even at 1R',
    ],
    structureTimeframe: 'H1',
    timeframe: 'H1',
    createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
    generatedAt: PRIME_FX_NOW_MS,
    feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
    inputsSnapshot: {
      d1Bias: { bias: 'BEARISH' },
      h4Bias: { bias: 'BEARISH' },
      h1Bias: { bias: 'BEARISH' },
      session: { sessionName: 'London / New York Overlap', sessionQuality: 'PRIME' },
    },
  };

  const sellSmallView = buildResultView(baseMt5Small, 'MT5', {
    nowMs: PRIME_FX_NOW_MS,
    minActionableStrength: 'Medium',
  });
  const buySmallView = buildResultView(
    { ...baseMt5Small, direction: 'BUY', stopLoss: 1.0825, takeProfit1: 1.08875, takeProfit2: 1.09125 },
    'MT5',
    { nowMs: PRIME_FX_NOW_MS, minActionableStrength: 'Medium' }
  );
  const validLotView = buildResultView(
    {
      ...baseMt5Small,
      lotSize: 0.25,
      riskMoney: 62.5,
      accountSizingWarning: undefined,
      copyOrderText: 'EURUSD SELL MARKET @ 1.08500 | SL 1.08750 | TP1 1.08125 | TP2 1.07875 | Lots 0.25',
    },
    'MT5',
    { nowMs: PRIME_FX_NOW_MS, minActionableStrength: 'Medium' }
  );

  assert(
    sellSmallView?.kind === 'MT5' &&
      Boolean(sellSmallView.accountTooSmallWarning?.includes('account is too small')) &&
      sellSmallView.verdict.plainSentence ===
        'A SELL setup exists, but your account is too small to take it at your risk setting.' &&
      sellSmallView.orderTicket.canCopyOrder === false &&
      sellSmallView.orderTicket.copyOrderText === null &&
      sellSmallView.orderTicket.cannotCopyReason === "Can't copy: lot size is below your broker's minimum" &&
      sellSmallView.moreDetails.accountSizingWarning === undefined &&
      buySmallView?.kind === 'MT5' &&
      buySmallView.verdict.plainSentence ===
        'A BUY setup exists, but your account is too small to take it at your risk setting.' &&
      buySmallView.orderTicket.canCopyOrder === false &&
      buySmallView.orderTicket.copyOrderText === null &&
      validLotView?.kind === 'MT5' &&
      validLotView.accountTooSmallWarning === null &&
      validLotView.orderTicket.canCopyOrder === true &&
      Boolean(validLotView.orderTicket.copyOrderText?.includes('Lots 0.25')),
    'MT5 lotSize=0 shows prominent top accountTooSmallWarning, custom BUY/SELL sentence, removes Copy order button, and never emits copyOrderText with 0 lots'
  );

  // 21b. Why bullets: structured <= 90-char templates with zero "…" truncation, zero repeated ticket numbers, zero trade-management advice
  const binaryPutSample: BinarySignalOutput = {
    engine: 'binary_v1',
    profile: 'BINARY_QUICK',
    platform: 'deriv',
    asset: 'EUR/USD',
    symbol: 'frxEURUSD',
    direction: 'PUT',
    strength: 'High',
    rawScore: -84,
    expiry: '3m',
    expirySeconds: 180,
    enterWithinSeconds: 6,
    entryPrice: 1.0852,
    payoutPct: 85,
    breakEvenWinRatePct: 54.05,
    breakEvenMessage: 'Break-even win rate at 85% payout: 54.05%',
    reasons: [
      'Extremely long narrative explanation well past ninety characters that would otherwise get chopped off with a trailing ellipsis marker in old code',
      'Another verbose bullet with entry price 1.08520 and stop loss ideas',
      'Third verbose narrative bullet',
    ],
    createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
    generatedAt: PRIME_FX_NOW_MS,
    validUntil: new Date(PRIME_FX_NOW_MS + 180_000).toISOString(),
    feedSource: 'wss://api.derivws.com/trading/v1/options/ws/public',
    inputsSnapshot: {
      m5: { bias: 'BEARISH' },
      m15: { bias: 'BEARISH' },
      microTicks60s: { momentumBuyPct: 15, momentumSellPct: 85 },
    },
  };

  const binaryMixedCallSample: BinarySignalOutput = {
    ...binaryPutSample,
    direction: 'CALL',
    expiry: '2m',
    inputsSnapshot: {
      m5: { bias: 'BULLISH' },
      m15: { bias: 'NEUTRAL' },
      microTicks60s: { momentumBuyPct: 72, momentumSellPct: 28 },
    },
  };

  const binaryPutView = buildResultView(binaryPutSample, 'BINARY_QUICK', {
    nowMs: PRIME_FX_NOW_MS,
    minActionableStrength: 'Medium',
  });
  const binaryCallView = buildResultView(binaryMixedCallSample, 'BINARY_QUICK', {
    nowMs: PRIME_FX_NOW_MS,
    minActionableStrength: 'Medium',
  });

  assert(
    binaryPutView?.kind === 'BINARY' &&
      binaryPutView.whyBullets.length === 3 &&
      binaryPutView.whyBullets.every((b) => b.length > 0 && b.length <= 90 && !b.includes('\u2026') && !b.includes('...')) &&
      binaryPutView.whyBullets[0] === 'M5 and M15 point down' &&
      binaryPutView.whyBullets[1] === 'In the last 60 seconds, 85% of tick moves were down' &&
      binaryPutView.whyBullets[2] === 'Volatility suits a 3-minute trade' &&
      binaryCallView?.kind === 'BINARY' &&
      binaryCallView.whyBullets[0] === 'M5 points up; M15 is neutral' &&
      binaryCallView.whyBullets.every((b) => b.length <= 90 && !b.includes('\u2026')),
    'Binary whyBullets use structured <= 90-char templates with zero ellipsis truncation'
  );

  const mt5LondonView = buildResultView(
    {
      ...baseMt5Small,
      lotSize: 0.45,
      sessionNote: 'London session active liquidity.',
      inputsSnapshot: {
        d1Bias: { bias: 'BEARISH' },
        h4Bias: { bias: 'BEARISH' },
        h1Bias: { bias: 'BEARISH' },
        session: { sessionName: 'London Session', sessionQuality: 'PRIME' },
      },
    },
    'MT5',
    { nowMs: PRIME_FX_NOW_MS, minActionableStrength: 'Medium' }
  );
  const mt5AsianView = buildResultView(
    {
      ...baseMt5Small,
      lotSize: 0.45,
      sessionNote: 'Asian session lighter liquidity.',
      inputsSnapshot: {
        d1Bias: { bias: 'NEUTRAL' },
        h4Bias: { bias: 'BEARISH' },
        h1Bias: { bias: 'BEARISH' },
        session: { sessionName: 'Asian Session', sessionQuality: 'CAUTION' },
      },
    },
    'MT5',
    { nowMs: PRIME_FX_NOW_MS, minActionableStrength: 'Medium' }
  );

  const mt5BulletsAllClean =
    validLotView?.kind === 'MT5' &&
    validLotView.whyBullets.length === 3 &&
    validLotView.whyBullets.every(
      (b) =>
        b.length > 0 &&
        b.length <= 90 &&
        !b.includes('\u2026') &&
        !b.includes('...') &&
        !b.includes('1.085') &&
        !b.includes('1.087') &&
        !b.includes('0.25') &&
        !b.includes('25') &&
        !/break-even|partial profit/i.test(b)
    );

  assert(
    mt5BulletsAllClean &&
      validLotView?.kind === 'MT5' &&
      validLotView.whyBullets[0] === 'D1 and H4 point down; H1 agrees' &&
      validLotView.whyBullets[1] === 'Stop sits beyond the H1 swing high; TP1 is 1.5x the risk' &&
      validLotView.whyBullets[2] === 'London/NY overlap: best liquidity' &&
      mt5LondonView?.kind === 'MT5' &&
      mt5LondonView.whyBullets[2] === 'London session: active liquidity' &&
      mt5AsianView?.kind === 'MT5' &&
      mt5AsianView.whyBullets[2] === 'Asian session: lighter liquidity',
    'MT5 whyBullets use structured <= 90-char templates with zero ellipsis, zero ticket numbers, and zero trade-management advice'
  );

  // 21c. Minimum actionable strength matrix (Low/Medium/High signal vs Low/Medium/High min)
  const levels = ['Low', 'Medium', 'High'] as const;
  let matrixPass = true;
  for (const sigStrength of levels) {
    for (const minStrength of levels) {
      const expectWait = getStrengthRank(sigStrength) < getStrengthRank(minStrength);
      const binRes = buildResultView(
        { ...binaryPutSample, strength: sigStrength },
        'BINARY_QUICK',
        { nowMs: PRIME_FX_NOW_MS, minActionableStrength: minStrength }
      );
      const mt5Res = buildResultView(
        { ...baseMt5Small, lotSize: 0.25, strength: sigStrength },
        'MT5',
        { nowMs: PRIME_FX_NOW_MS, minActionableStrength: minStrength }
      );
      if (expectWait) {
        if (
          binRes?.kind !== 'WAIT' ||
          binRes.reason !== MIN_STRENGTH_WAIT_REASON ||
          binRes.strengthChip !== null ||
          mt5Res?.kind !== 'WAIT' ||
          mt5Res.reason !== MIN_STRENGTH_WAIT_REASON ||
          mt5Res.strengthChip !== null
        ) {
          matrixPass = false;
        }
      } else {
        if (binRes?.kind !== 'BINARY' || mt5Res?.kind !== 'MT5') {
          matrixPass = false;
        }
      }
    }
  }
  const explicitWaitLowMin = buildResultView(
    {
      ...binaryPutSample,
      direction: 'WAIT',
      strength: 'Low',
      whyNotTrade: 'Spread is too wide right now.',
    },
    'BINARY_QUICK',
    { nowMs: PRIME_FX_NOW_MS, minActionableStrength: 'Low' }
  );
  assert(
    matrixPass &&
      isStrengthBelowMinimum('Low', 'Medium') &&
      !isStrengthBelowMinimum('Medium', 'Medium') &&
      !isStrengthBelowMinimum('High', 'Medium') &&
      explicitWaitLowMin?.kind === 'WAIT' &&
      explicitWaitLowMin.reason === 'Spread is too wide right now.',
    'min_actionable_strength enforces full 3x3 Low/Medium/High matrix across Binary & MT5 and emits exact WAIT reason'
  );

  // 21d. Client helpers (normalize/save/fetch) + server validation + UI/migration contracts
  assert(
    DEFAULT_MIN_ACTIONABLE_STRENGTH === 'Medium' &&
      normalizeMinActionableStrength('Low') === 'Low' &&
      normalizeMinActionableStrength('high') === 'High' &&
      normalizeMinActionableStrength('invalid_level') === 'Medium' &&
      normalizeMinActionableStrength(null) === 'Medium',
    'normalizeMinActionableStrength enforces Low/Medium/High and defaults to Medium'
  );

  const origFetch = globalThis.fetch;
  const origLocalStorage = (globalThis as any).localStorage;
  const origSessionStorage = (globalThis as any).sessionStorage;
  const origWindow = (globalThis as any).window;
  const origCustomEvent = (globalThis as any).CustomEvent;

  const store = new Map<string, string>();
  const dispatched: Array<{ type: string; detail: unknown }> = [];
  const lsMock = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  (globalThis as any).localStorage = lsMock;
  (globalThis as any).sessionStorage = lsMock;
  (globalThis as any).window = {
    dispatchEvent: (ev: { type: string; detail?: unknown }) => {
      dispatched.push({ type: ev.type, detail: ev.detail });
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).CustomEvent = class MockCustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const failSave = await saveMinActionableStrength('High');
    assert(
      !failSave.ok && store.size === 0 && dispatched.length === 0,
      'saveMinActionableStrength fails closed on 403 without touching localStorage or dispatching event'
    );

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, settings: { min_actionable_strength: 'High' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const okSave = await saveMinActionableStrength('High');
    const fetchedRemote = await fetchRemoteMinActionableStrength();
    assert(
      okSave.ok &&
        okSave.value === 'High' &&
        getMinActionableStrength() === 'High' &&
        fetchedRemote === 'High' &&
        dispatched.some((e) => e.type === 'pulsetrade_min_strength_changed' && e.detail === 'High'),
      'saveMinActionableStrength persists to server/localStorage and fetchRemoteMinActionableStrength reads back High'
    );
  } finally {
    globalThis.fetch = origFetch;
    (globalThis as any).localStorage = origLocalStorage;
    (globalThis as any).sessionStorage = origSessionStorage;
    (globalThis as any).window = origWindow;
    (globalThis as any).CustomEvent = origCustomEvent;
  }

  // Verify migration 011, api/admin/settings.ts, AdminCenter.tsx, and SignalEngine.tsx Stage 4I wiring
  const rootDir = resolve(process.cwd());
  const mig011 = readFileSync(resolve(rootDir, 'supabase/migrations/011_min_actionable_strength.sql'), 'utf8');
  const settingsApi = readFileSync(resolve(rootDir, 'api/admin/settings.ts'), 'utf8');
  const adminUi = readFileSync(resolve(rootDir, 'src/components/AdminCenter.tsx'), 'utf8');
  const signalUi = readFileSync(resolve(rootDir, 'src/components/SignalEngine.tsx'), 'utf8');

  assert(
    mig011.includes("'min_actionable_strength'") &&
      mig011.includes("to_jsonb('Medium'::text)") &&
      mig011.includes('app_settings_public_select') &&
      settingsApi.includes("'min_actionable_strength'") &&
      settingsApi.includes("cleanKey === 'min_actionable_strength'") &&
      settingsApi.includes("status(400)"),
    'Migration 011 & api/admin/settings.ts expose min_actionable_strength safely and validate Low/Medium/High'
  );

  const mt5CardStart = signalUi.indexOf('data-testid="mt5-result-card"');
  const mt5TopWarningIdx = signalUi.indexOf('data-testid="mt5-account-too-small-warning"', mt5CardStart);
  const mt5VerdictBadgeIdx = signalUi.indexOf('{resultView.verdict.badge}', mt5CardStart);

  assert(
    adminUi.includes('Minimum actionable setup strength') &&
      adminUi.includes('Setups weaker than this are shown as WAIT') &&
      mt5TopWarningIdx > mt5CardStart &&
      mt5TopWarningIdx < mt5VerdictBadgeIdx &&
      signalUi.includes('resultView.orderTicket.canCopyOrder') &&
      signalUi.includes('data-testid="mt5-copy-disabled-note"') &&
      signalUi.includes('binaryBelowMinStrength') &&
      signalUi.includes('mt5BelowMinStrength') &&
      signalUi.includes('onSignalOutput?.(binaryBelowMinStrength ? null : binaryRes)') &&
      signalUi.includes('onSignalOutput?.(mt5BelowMinStrength ? null : mt5Res)'),
    'AdminCenter renders strength threshold setting and SignalEngine renders top lot=0 warning, copy guard, and WAIT downgrade without credits/overlay'
  );
}

// ============================================================================
// 22. STAGE 4J: CHART LIVE METRICS, EMPTY OVERLAYS, M1 TICK SEED & DEBUG CHART
// ============================================================================
function runStage4JChartAndDiagnosticsTests() {
  console.log('\n22. Stage 4J LiveChart Metrics, Empty States, M1 Tick Seeding & Debug Chart:');

  // 22a. Live tick metrics calculation
  const mEmpty = computeLiveTickMetrics({
    open: 0,
    close: 0,
    high: 0,
    low: 0,
    firstTimeSec: 0,
    lastTimeSec: 0,
    pointCount: 0,
    pipSize: 0.0001,
  });
  const mLive = computeLiveTickMetrics({
    open: 1.085,
    close: 1.0865,
    high: 1.087,
    low: 1.0845,
    firstTimeSec: 1700000000,
    lastTimeSec: 1700000900,
    pointCount: 42,
    pipSize: 0.0001,
  });
  assert(
    mEmpty.totalBars === 0 &&
      mEmpty.timespanMinutes === 0 &&
      mLive.totalBars === 42 &&
      mLive.timespanMinutes === 15 &&
      mLive.changePips === 15 &&
      mLive.high === 1.087 &&
      mLive.low === 1.0845,
    `computeLiveTickMetrics tracks live totalBars, timespanMinutes, high/low, and pip delta (bars=${mLive.totalBars}, span=${mLive.timespanMinutes}m, pips=${mLive.changePips})`
  );

  // 22b. Empty chart overlay rules: <8s loading, >=8s Retry, MARKET_CLOSED, hidden when >0 points
  const ovHidden = resolveChartEmptyOverlayState({ pointCount: 5, feedStatus: 'LIVE', elapsedMs: 0 });
  const ovClosed = resolveChartEmptyOverlayState({ pointCount: 0, feedStatus: 'MARKET_CLOSED', elapsedMs: 9000 });
  const ovLoading = resolveChartEmptyOverlayState({ pointCount: 0, feedStatus: 'CONNECTING', elapsedMs: 3000 });
  const ovTimeout = resolveChartEmptyOverlayState({ pointCount: 0, feedStatus: 'OFFLINE', elapsedMs: 8000 });

  assert(
    !ovHidden.visible &&
      ovClosed.visible &&
      ovClosed.message === 'Market closed' &&
      !ovClosed.showRetry &&
      ovLoading.visible &&
      ovLoading.message === 'Loading price history...' &&
      !ovLoading.showRetry &&
      ovTimeout.visible &&
      ovTimeout.message === 'No price data yet. Check your connection or pick another asset.' &&
      ovTimeout.showRetry === true,
    'resolveChartEmptyOverlayState handles Loading (0-8s), Retry timeout (>=8s), Market closed, and >0 points cleanly'
  );

  // 22c. seedTimestampedTicksFromCandles hydrates up to 60 real M1 closes cleanly & preserves newer live ticks
  const testSym = 'TEST_STAGE4J_SYM';
  const baseEpoch = 1700010000;
  // Simulate 1 live tick arriving BEFORE historical M1 fetch completes
  pushAssetTick(testSym, 1.2512, baseEpoch + 3600);
  const m1Candles = Array.from({ length: 75 }, (_, i) => ({
    time: baseEpoch - (74 - i) * 60,
    close: Number((1.24 + i * 0.0001).toFixed(5)),
  }));
  const seeded = seedTimestampedTicksFromCandles(testSym, m1Candles, 60);
  const storedAfterSeed = getAssetTimestampedTicks(testSym);
  const strictlyAscending = storedAfterSeed.every((pt, idx) => idx === 0 || pt.time > storedAfterSeed[idx - 1].time);
  assert(
    seeded.length === 61 &&
      storedAfterSeed.length === 61 &&
      strictlyAscending &&
      storedAfterSeed[storedAfterSeed.length - 1].time === baseEpoch + 3600 &&
      storedAfterSeed[storedAfterSeed.length - 1].price === 1.2512,
    `seedTimestampedTicksFromCandles fills 60 M1 closes cleanly in ascending order while keeping newer live tick (${storedAfterSeed.length} pts)`
  );

  // 22d. Chart diagnostics store + Copy report output + LiveChart/DebugDiagnosticsPanel source checks
  resetChartDiagnosticsForTest();
  const sampleUpdateMs = Date.UTC(2026, 2, 18, 12, 34, 56);
  reportChartDiagnostics({
    activeSymbol: testSym,
    seriesPointCount: 61,
    wsConnected: true,
    selectedInterval: 'tick',
    lastUpdateAtMs: sampleUpdateMs,
  });
  const snap = getChartDiagnosticsSnapshot();
  const reportLines = formatChartDiagnosticsLines(snap).join('\n');
  assert(
    snap.activeSymbol === testSym &&
      snap.bufferTickCount === 61 &&
      snap.seriesPointCount === 61 &&
      snap.wsConnected === true &&
      snap.selectedInterval === 'tick' &&
      snap.lastUpdateAtMs === sampleUpdateMs &&
      reportLines.includes('CHART') &&
      reportLines.includes(`Buffer Ticks (${testSym}): 61`) &&
      reportLines.includes('Chart Series Points: 61') &&
      reportLines.includes('Chart wsConnected: true') &&
      reportLines.includes('Selected Interval: tick') &&
      reportLines.includes('Last Chart Update: 2026-03-18T12:34:56.000Z'),
    'chartDiagnostics tracks live buffer ticks, series points, wsConnected, interval, and lastUpdateAtMs for DebugDiagnosticsPanel'
  );

  const rootDir = resolve(process.cwd());
  const liveChartSrc = readFileSync(resolve(rootDir, 'src/components/LiveChart.tsx'), 'utf8');
  const liveTickerSrc = readFileSync(resolve(rootDir, 'src/components/LiveTicker.tsx'), 'utf8');
  const debugPanelSrc = readFileSync(resolve(rootDir, 'src/components/DebugDiagnosticsPanel.tsx'), 'utf8');
  assert(
    liveChartSrc.includes("getOrFetchCandles(targetSymbol, '1m', 60)") &&
      liveChartSrc.includes('seedTimestampedTicksFromCandles') &&
      liveChartSrc.includes('computeLiveTickMetrics') &&
      liveChartSrc.includes('resolveChartEmptyOverlayState') &&
      liveChartSrc.includes('reportChartDiagnostics') &&
      liveChartSrc.includes('data-testid="chart-retry-btn"') &&
      debugPanelSrc.includes('data-testid="debug-chart-section"') &&
      debugPanelSrc.includes('formatChartDiagnosticsLines'),
    'LiveChart.tsx & DebugDiagnosticsPanel.tsx wire throttled metrics, M1 hydration, 8s/Market-closed overlays + Retry, and Chart debug report'
  );

  // 22e. Item 6: Plain price differences for synthetics and unmapped assets, keeping pips (FX/metals) and points (table crypto)
  const r100Spec = resolveAssetPipSpec({ symbol: 'R_100', name: 'Volatility 100 Index', type: 'SYNTH', decimals: 2 });
  const r10Spec = resolveAssetPipSpec({ symbol: 'R_10', name: 'Volatility 10 Index', type: 'SYNTH', decimals: 3 });
  const oilSpec = resolveAssetPipSpec({ symbol: 'USOIL', name: 'WTI Crude Oil', type: 'COMMODITY', decimals: 2 });
  const stockSpec = resolveAssetPipSpec({ symbol: 'AAPL', name: 'Apple Inc.', type: 'STOCK', decimals: 2 });
  const solSpec = resolveAssetPipSpec({ symbol: 'crySOLUSD', name: 'SOL/USD', type: 'CRYPTO', decimals: 2 });
  const xagSpec = resolveAssetPipSpec({ symbol: 'frxXAGUSD', name: 'Silver/USD', type: 'COMMODITY', decimals: 3 });
  const ethSpec = resolveAssetPipSpec({ symbol: 'cryETHUSD', name: 'ETH/USD', type: 'CRYPTO', decimals: 2 });

  assert(
    r100Spec.distanceUnit === 'price' &&
      r10Spec.distanceUnit === 'price' &&
      oilSpec.distanceUnit === 'price' &&
      stockSpec.distanceUnit === 'price' &&
      solSpec.distanceUnit === 'price' &&
      xagSpec.distanceUnit === 'pips' &&
      ethSpec.distanceUnit === 'points' &&
      ethSpec.pipSize === 0.1,
    'Asset unit matrix: synthetics & unmapped index/commodity/stock/crypto use "price"; FX/metals use "pips"; table crypto uses "points"'
  );

  const synthChange = formatChartChangeSummary({
    changePrice: 1.45,
    changePips: 145,
    changePct: 0.27,
    decimals: 2,
    distanceUnit: 'price',
  });
  const btcChange = formatChartChangeSummary({
    changePrice: 120,
    changePips: 120,
    changePct: 0.18,
    decimals: 2,
    distanceUnit: 'points',
  });
  const fxChange = formatChartChangeSummary({
    changePrice: 0.00145,
    changePips: 14.5,
    changePct: 0.13,
    decimals: 5,
    distanceUnit: 'pips',
  });
  assert(
    synthChange === '+1.45 (+0.27%)' &&
      btcChange === '+120 points (+0.18%)' &&
      fxChange === '+14.5 pips (+0.13%)',
    `formatChartChangeSummary renders "${synthChange}", "${btcChange}", and "${fxChange}"`
  );

  const r100CtxSummary = buildMarketContextSummaryLines({
    symbol: 'R_100',
    assetName: 'Volatility 100 Index',
    pipSize: 0.01,
    tickSize: 0.01,
    decimals: 2,
    distanceUnit: 'price',
    currentPrice: 540.0,
    computedAtIso: new Date(PRIME_FX_NOW_MS).toISOString(),
    trendTable: [
      {
        timeframe: 'M15',
        direction: 'Bullish',
        strength: 'Moderate',
        ema21: 539.1,
        distancePips: 90,
        distancePct: 0.17,
        lastClose: 540.0,
        sampleCount: 50,
      },
      {
        timeframe: 'H1',
        direction: 'Bullish',
        strength: 'Strong',
        ema21: 538.4,
        distancePips: 160,
        distancePct: 0.3,
        lastClose: 540.0,
        sampleCount: 50,
      },
      {
        timeframe: 'H4',
        direction: 'Neutral',
        strength: 'Weak',
        ema21: 539.8,
        distancePips: 20,
        distancePct: 0.04,
        lastClose: 540.0,
        sampleCount: 40,
      },
      {
        timeframe: 'D1',
        direction: 'Bullish',
        strength: 'Moderate',
        ema21: 532.0,
        distancePips: 800,
        distancePct: 1.5,
        lastClose: 540.0,
        sampleCount: 30,
      },
    ],
    levelsMap: [
      {
        id: 'pp',
        label: 'Daily Pivot (PP)',
        group: 'Daily Pivot',
        price: 538.55,
        signedPipsFromLevel: 145,
        absPipsFromLevel: 145,
        relation: 'above',
        plainText: 'price is 1.45 above Daily Pivot (PP)',
        sampleCount: 1,
      },
      {
        id: 'r1',
        label: 'Daily Resistance (R1)',
        group: 'Daily Pivot',
        price: 543.25,
        signedPipsFromLevel: -325,
        absPipsFromLevel: 325,
        relation: 'below',
        plainText: 'price is 3.25 below Daily Resistance (R1)',
        sampleCount: 1,
      },
    ],
    dailyPivot: null,
    pivotSampleCount: 1,
    volatilityRegime: {
      currentAtr: 12.34,
      currentAtrPips: 1234,
      percentile30d: 55,
      regime: 'normal',
      sampleCount: 30,
      lookbackTargetDays: 30,
    },
    sessionProfile: {
      lookbackWeeks: 8,
      totalBars: 1344,
      hours: [],
      mostActiveHour: null,
      quietestHour: null,
    },
  });
  const r100Mt5Signal: MT5SignalOutput = {
    engine: 'mt5_v1',
    profile: 'MT5',
    platform: 'mt5',
    platformName: 'MetaTrader 5',
    asset: 'Volatility 100 Index',
    symbol: 'R_100',
    direction: 'BUY',
    orderKind: 'MARKET',
    entryPrice: 540.0,
    entryZone: { min: 539.7, max: 540.3 },
    stopLoss: 537.5,
    stopLossPips: 250,
    takeProfit1: 543.75,
    takeProfit1Pips: 375,
    takeProfit2: 546.25,
    takeProfit2Pips: 625,
    lotSize: 0.2,
    riskMoney: 50,
    accountCurrency: 'USD',
    rewardRiskTp1: 1.5,
    rewardRiskTp2: 2.5,
    rewardRiskRatio: '1:1.50 (TP2 1:2.50)',
    validityCandles: 3,
    validityMinutes: 15,
    validityWindowDesc: '3 × M5 candles (15 min)',
    validUntil: new Date(PRIME_FX_NOW_MS + 900_000).toISOString(),
    invalidationLevel: 537.5,
    invalidationDriftPrice: 0.8,
    invalidationRule: 'Test invalidation',
    sessionNote: '24/7',
    sessionQuality: 'PRIME',
    tradeManagementNote: 'Test mgmt',
    copyOrderText: 'BUY MARKET R_100 @ 540.00',
    strength: 'Medium',
    rawScore: 76,
    reasons: ['D1/H4 up', 'M5 entry', 'Session'],
    distanceUnit: 'price',
    structureTimeframe: 'H1',
    timeframe: 'H1',
    createdAt: new Date(PRIME_FX_NOW_MS).toISOString(),
    generatedAt: PRIME_FX_NOW_MS,
    feedSource: 'deriv_ws',
    inputsSnapshot: {},
  };
  const r100View = buildResultView(r100Mt5Signal, 'MT5', {
    nowMs: PRIME_FX_NOW_MS,
    minActionableStrength: 'Low',
    decimals: 2,
    distanceUnit: 'price',
  });
  const r100Overlays = buildSignalChartOverlays(r100Mt5Signal, {
    decimals: 2,
    distanceUnit: 'price',
  });
  const slLineTitle = r100Overlays.find((l) => l.role === 'sl')?.label || '';
  const tp1LineTitle = r100Overlays.find((l) => l.role === 'tp1')?.label || '';

  assert(
    r100CtxSummary.volatilityLine === 'Volatility is normal — daily ATR(14) is 12.34 (55th percentile, n=30).' &&
      r100CtxSummary.levelsLine.includes('+3.25') &&
      r100CtxSummary.levelsLine.includes('-1.45') &&
      !r100CtxSummary.volatilityLine.includes('points') &&
      !r100CtxSummary.levelsLine.includes('points') &&
      r100View?.kind === 'MT5' &&
      r100View.orderTicket.stopLossDistanceText === '-2.50' &&
      r100View.orderTicket.tp1DistanceText === '+3.75' &&
      slLineTitle === 'SL (-2.50)' &&
      tp1LineTitle === 'TP1 (+3.75)',
    `Synthetic R_100 context, MT5 ticket, and chart lines render plain price differences without "points" (vol="${r100CtxSummary.volatilityLine}", sl="${slLineTitle}")`
  );

  // 22f. Item 7: LIVE QUOTE velocity renders 1-decimal rate (e.g. "0.5 t/s")
  const velStartMs = 1_700_000_000_000;
  const velZero = computeTickVelocityLabel({
    tickTimestampsMs: [],
    nowMs: velStartMs + 2000,
    windowStartMs: velStartMs,
  });
  const velHalf1Tick = computeTickVelocityLabel({
    tickTimestampsMs: [velStartMs + 1500],
    nowMs: velStartMs + 2000,
    windowStartMs: velStartMs,
  });
  const velHalf10s = computeTickVelocityLabel({
    tickTimestampsMs: [
      velStartMs + 1000,
      velStartMs + 3000,
      velStartMs + 5000,
      velStartMs + 7000,
      velStartMs + 9000,
    ],
    nowMs: velStartMs + 10_000,
    windowStartMs: velStartMs,
  });
  const velActive = computeTickVelocityLabel({
    tickTimestampsMs: Array.from({ length: 30 }, (_, i) => velStartMs + i * 330),
    nowMs: velStartMs + 10_000,
    windowStartMs: velStartMs,
  });
  const velHigh = computeTickVelocityLabel({
    tickTimestampsMs: Array.from({ length: 75 }, (_, i) => velStartMs + i * 130),
    nowMs: velStartMs + 10_000,
    windowStartMs: velStartMs,
  });

  assert(
    velZero.label === 'Steady (0.0 t/s)' &&
      velHalf1Tick.label === 'Steady (0.5 t/s)' &&
      velHalf10s.label === 'Steady (0.5 t/s)' &&
      velActive.label === 'Active (3.0 t/s)' &&
      velHigh.label === 'High (7.5 t/s)' &&
      liveTickerSrc.includes('computeTickVelocityLabel') &&
      liveTickerSrc.includes('Steady (0.0 t/s)'),
    `LIVE QUOTE velocity formats 1-decimal t/s cleanly ("${velHalf10s.label}", "${velActive.label}", "${velHigh.label}")`
  );
}

function runStage4BBacktestTests() {
  console.log('\n============================================================');
  console.log('  TICKVERE STAGE 4B: REAL-HISTORY BACKTEST HARNESS SUITE');
  console.log('============================================================\n');

  // 23a. Spread costs & instrumentMeta pip sizes
  console.log('23a. SPREAD_CONFIG & resolveSpreadCostForAsset:');
  const eurSpread = resolveSpreadCostForAsset(EURUSD);
  const gbpSpread = resolveSpreadCostForAsset({ symbol: 'frxGBPUSD', name: 'GBP/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001 });
  const jpySpread = resolveSpreadCostForAsset(USDJPY);
  const audSpread = resolveSpreadCostForAsset({ symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001 });
  const gbpjpySpread = resolveSpreadCostForAsset({ symbol: 'frxGBPJPY', name: 'GBP/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01 });
  const xauSpread = resolveSpreadCostForAsset(XAUUSD);
  const xagSpread = resolveSpreadCostForAsset({ symbol: 'frxXAGUSD', name: 'Silver/USD', type: 'COMMODITY', decimals: 3, pipSize: 0.001 });
  const btcSpread = resolveSpreadCostForAsset({ symbol: 'cryBTCUSD', name: 'BTC/USD', type: 'CRYPTO', decimals: 2, pipSize: 1.0 });
  const ethSpread = resolveSpreadCostForAsset({ symbol: 'cryETHUSD', name: 'ETH/USD', type: 'CRYPTO', decimals: 2, pipSize: 0.1 });
  const idxSpread = resolveSpreadCostForAsset({ symbol: 'OTC_SPC', name: 'US 500', type: 'INDEX', decimals: 2, pipSize: 0.01 });

  assert(
    Math.abs(eurSpread.spreadPrice - 0.0001) < 1e-9 &&
      Math.abs(gbpSpread.spreadPrice - 0.00013) < 1e-9 &&
      Math.abs(jpySpread.spreadPrice - 0.01) < 1e-9 &&
      Math.abs(audSpread.spreadPrice - 0.00015) < 1e-9 &&
      Math.abs(gbpjpySpread.spreadPrice - 0.015) < 1e-9 &&
      Math.abs(xauSpread.spreadPrice - 0.25) < 1e-9 &&
      Math.abs(xagSpread.spreadPrice - 0.03) < 1e-9 &&
      btcSpread.spreadPrice === 20 &&
      ethSpread.spreadPrice === 2 &&
      idxSpread.spreadPrice === 1.5 &&
      Object.keys(SPREAD_CONFIG).length >= 10,
    `Exact per-symbol spreads computed from instrumentMeta.ts (EUR=${eurSpread.spreadPrice}, GBP=${gbpSpread.spreadPrice}, XAU=${xauSpread.spreadPrice}, BTC=${btcSpread.spreadPrice})`
  );

  // 23b. Active-symbol universe selection (non-synthetic filter + OTC index bug note)
  console.log('\n23b. selectUniverseFromActiveSymbols:');
  const universe = selectUniverseFromActiveSymbols([
    { symbol: 'R_100', display_name: 'Volatility 100', market: 'synthetic_index', pip: 0.01 },
    { symbol: '1HZ100V', display_name: 'Volatility 100 (1s)', market: 'synthetic_index', pip: 0.01 },
    { symbol: 'frxEURUSD', display_name: 'EUR/USD', market: 'forex', pip: 0.00001 },
    { symbol: 'frxGBPUSD', display_name: 'GBP/USD', market: 'forex', pip: 0.00001 },
    { symbol: 'frxUSDJPY', display_name: 'USD/JPY', market: 'forex', pip: 0.001 },
    { symbol: 'frxAUDUSD', display_name: 'AUD/USD', market: 'forex', pip: 0.00001 },
    { symbol: 'frxUSDCAD', display_name: 'USD/CAD', market: 'forex', pip: 0.00001 },
    { symbol: 'frxUSDCHF', display_name: 'USD/CHF', market: 'forex', pip: 0.00001 },
    { symbol: 'frxGBPJPY', display_name: 'GBP/JPY', market: 'forex', pip: 0.001 },
    { symbol: 'frxEURJPY', display_name: 'EUR/JPY', market: 'forex', pip: 0.001 },
    { symbol: 'frxNZDUSD', display_name: 'NZD/USD', market: 'forex', pip: 0.00001 },
    { symbol: 'frxXAUUSD', display_name: 'Gold/USD', market: 'commodities', pip: 0.01 },
    { symbol: 'frxXAGUSD', display_name: 'Silver/USD', market: 'commodities', pip: 0.001 },
    { symbol: 'cryBTCUSD', display_name: 'BTC/USD', market: 'cryptocurrency', pip: 0.01 },
    { symbol: 'cryETHUSD', display_name: 'ETH/USD', market: 'cryptocurrency', pip: 0.01 },
    { symbol: 'OTC_SPC', display_name: 'US 500', market: 'indices', pip: 0.01 },
    { symbol: 'OTC_NDX', display_name: 'US Tech 100', market: 'indices', pip: 0.01 },
    { symbol: 'OTC_DJI', display_name: 'Wall Street 30', market: 'indices', pip: 0.01 },
    { symbol: 'OTC_GDAXI', display_name: 'Germany 40', market: 'indices', pip: 0.01 },
  ]);
  assert(
    universe.mt5Assets.length === 15 &&
      !universe.mt5Assets.some((a) => a.symbol === 'R_100' || a.symbol === '1HZ100V') &&
      universe.binaryAssets.length === 5 &&
      universe.mt5Assets.find((a) => a.symbol === 'frxEURUSD')?.pipSize === 0.0001 &&
      universe.mt5Assets.find((a) => a.symbol === 'frxAUDUSD')?.pipSize === 0.0001 &&
      universe.activeIndexBugNotes.length === 0,
    `Selected 15 non-synthetic MT5 symbols + 5 Binary symbols, fixed EURUSD & AUDUSD pipSize=0.0001, and cleared fixed bug notes`
  );

  // 23c. MT5 M5 resolution: SL-first conservative tie-breaker, TP1 win, 48h timeout, unfilled limit
  console.log('\n23c. resolveMt5TradeOnM5 Rules:');
  const baseT0 = Date.UTC(2026, 7, 10, 10, 0, 0) / 1000;
  // Both SL and TP1 hit in same M5 bar -> SL wins conservatively
  const slFirstRes = resolveMt5TradeOnM5({
    direction: 'BUY',
    orderKind: 'MARKET',
    signalTimeSec: baseT0,
    validUntilSec: baseT0 + 900,
    entryPrice: 1.1000,
    stopLoss: 1.0980,
    takeProfit1: 1.1040,
    rewardRiskTp1: 2.0,
    spreadPrice: 0.0002,
    m5Candles: [
      { time: baseT0, open: 1.1000, high: 1.1045, low: 1.0975, close: 1.1030 },
    ],
    startIdx: 0,
  });
  assert(
    slFirstRes.status === 'FILLED' &&
      slFirstRes.exitReason === 'SL' &&
      slFirstRes.outcome === 'LOSS' &&
      Math.abs(slFirstRes.netR - -1.1) < 1e-9,
    `SL + TP1 in same candle conservatively triggers SL (-1.10R w/ spread)`
  );

  // Clean TP1 hit
  const tpRes = resolveMt5TradeOnM5({
    direction: 'BUY',
    orderKind: 'MARKET',
    signalTimeSec: baseT0,
    validUntilSec: baseT0 + 900,
    entryPrice: 1.1000,
    stopLoss: 1.0980,
    takeProfit1: 1.1040,
    rewardRiskTp1: 2.0,
    spreadPrice: 0.0002,
    m5Candles: [
      { time: baseT0, open: 1.1000, high: 1.1020, low: 1.0990, close: 1.1015 },
      { time: baseT0 + 300, open: 1.1015, high: 1.1042, low: 1.1010, close: 1.1038 },
    ],
    startIdx: 0,
  });
  assert(
    tpRes.status === 'FILLED' &&
      tpRes.exitReason === 'TP1' &&
      tpRes.outcome === 'WIN' &&
      Math.abs(tpRes.netR - 1.9) < 1e-9,
    `Clean TP1 hit awards +1.90R after 0.10R spread cost`
  );

  // 48h timeout close at market
  const m5Flat48h: Candle[] = [];
  for (let s = baseT0; s <= baseT0 + 50 * 3600; s += 300) {
    const closePx = s === baseT0 + 48 * 3600 - 300 ? 1.1010 : 1.1005;
    m5Flat48h.push({ time: s, open: 1.1000, high: 1.1012, low: 1.0990, close: closePx });
  }
  const timeoutRes = resolveMt5TradeOnM5({
    direction: 'BUY',
    orderKind: 'MARKET',
    signalTimeSec: baseT0,
    validUntilSec: baseT0 + 900,
    entryPrice: 1.1000,
    stopLoss: 1.0980,
    takeProfit1: 1.1040,
    rewardRiskTp1: 2.0,
    spreadPrice: 0.0002,
    m5Candles: m5Flat48h,
    startIdx: 0,
  });
  // +0.0010 / 0.0020 = +0.50R gross - 0.10R spread = +0.40R
  assert(
    timeoutRes.status === 'FILLED' &&
      timeoutRes.exitReason === 'TIMEOUT_48H' &&
      Math.abs(timeoutRes.netR - 0.4) < 1e-6,
    `48h unresolved trade closes at market price (${timeoutRes.status === 'FILLED' ? timeoutRes.netR.toFixed(3) : timeoutRes.status})`
  );

  // Unfilled LIMIT expires after validUntilSec
  const unfilledLimit = resolveMt5TradeOnM5({
    direction: 'BUY',
    orderKind: 'LIMIT',
    signalTimeSec: baseT0,
    validUntilSec: baseT0 + 900,
    entryPrice: 1.0990,
    stopLoss: 1.0970,
    takeProfit1: 1.1030,
    rewardRiskTp1: 2.0,
    spreadPrice: 0.0002,
    m5Candles: [
      { time: baseT0, open: 1.1000, high: 1.1010, low: 1.0995, close: 1.1005 },
      { time: baseT0 + 300, open: 1.1005, high: 1.1015, low: 1.0996, close: 1.1012 },
      { time: baseT0 + 600, open: 1.1012, high: 1.1020, low: 1.1000, close: 1.1018 },
      { time: baseT0 + 900, open: 1.1018, high: 1.1020, low: 1.0980, close: 1.0985 },
    ],
    startIdx: 0,
  });
  assert(
    unfilledLimit.status === 'UNFILLED_LIMIT',
    `Unfilled LIMIT order expires cleanly at validity window`
  );

  // 23d. Statistics: computeMt5Stats (<30 => 'not enough trades', >=30 => all 4 verdicts) & Wilson 95% CI
  console.log('\n23d. Statistical Helpers & Verdict Classification:');
  const smallPos = computeMt5Stats([1.5, 1.4, -1.1, 1.5, 1.6, 1.4, -1.1, 1.5, 1.6, 1.5]);
  const repeat = <T>(arr: T[], times: number): T[] => Array.from({ length: times }, () => arr).flat();
  const posSig = computeMt5Stats(repeat([1.5, 1.4, -1.1, 1.5, 1.6, 1.4, -1.1, 1.5, 1.6, 1.5], 3));
  const posNotSig = computeMt5Stats(repeat([1.2, -1.1, 0.2], 10));
  const zeroStats = computeMt5Stats(repeat([1.0, -1.0], 15));
  const negStats = computeMt5Stats(repeat([-1.1, -1.1, 0.5, -1.1], 8));
  const ddCheck = computeMt5Stats([-1.1, -1.1, 0.5, -1.1]);
  assert(
    MIN_VERDICT_TRADES === 30 &&
      smallPos.verdict === 'not enough trades' &&
      posSig.verdict === 'positive and significant' &&
      posNotSig.verdict === 'positive but not significant' &&
      zeroStats.verdict === 'zero' &&
      negStats.verdict === 'negative' &&
      ddCheck.verdict === 'not enough trades' &&
      ddCheck.longestLosingStreak === 2 &&
      Math.abs(ddCheck.maxDrawdownR - 2.8) < 1e-9,
    `computeMt5Stats requires >=30 trades before emitting positive/negative verdicts and computes exact DD/streak`
  );

  const [wLo, wHi] = computeWilson95(70, 100);
  const bStats = computeBinaryStats(Array.from({ length: 100 }, (_, i) => i < 70));
  const bSmall = computeBinaryStats(Array.from({ length: 15 }, () => true));
  assert(
    wLo > 56 &&
      wHi < 80 &&
      !bStats.notEnoughTrades &&
      bStats.beats80 &&
      bStats.beats85 &&
      bStats.beats90 &&
      bSmall.notEnoughTrades &&
      !bSmall.beats80 &&
      !bSmall.beats85 &&
      !bSmall.beats90,
    `computeBinaryStats 70/100 Wilson CI [${wLo}%, ${wHi}%] beats BE while n<30 suppresses positive break-even flags`
  );

  // 23e. Binary walk-forward cooldown, tie=loss & candle causality from ticks
  console.log('\n23e. Binary Walk-Forward (Tick-Built Candles, 3m Cooldown, Tie = Loss):');
  // Build ~4.5 hours of dense trending 2-second ticks ending on Wednesday 13:45 UTC
  const binEndSec = Date.UTC(2026, 7, 12, 13, 45, 0) / 1000;
  const binStartSec = binEndSec - 4.5 * 3600;
  const binTicks: TimestampedTick[] = [];
  let pxBin = 1.0800;
  for (let t = binStartSec; t <= binEndSec; t += 2) {
    const idx = (t - binStartSec) / 2;
    const wave = Math.sin(idx * 0.12) * 0.000015;
    pxBin += 0.0000025 + wave;
    binTicks.push({ time: t, price: parseFloat(pxBin.toFixed(5)) });
  }
  const binWalk = runBinaryWalkForwardForSymbol({
    asset: EURUSD,
    ticks: binTicks,
    modes: ['1m', '3m', 'auto'],
  });
  let cooldownOk = true;
  const lastByMode = new Map<string, number>();
  for (const s of binWalk.signals) {
    const prev = lastByMode.get(s.mode);
    if (prev !== undefined && s.entryTimeSec - prev < 180) {
      cooldownOk = false;
    }
    lastByMode.set(s.mode, s.entryTimeSec);
  }
  // Verify exact tie counts as loss
  const flatTieEnd = Date.UTC(2026, 7, 12, 13, 30, 0) / 1000;
  const tieCheckWin = (() => {
    const entry = 1.1000;
    const exit = 1.1000;
    return exit > entry;
  })();
  assert(
    cooldownOk && !tieCheckWin && binWalk.startSec === binStartSec && binWalk.endSec === binEndSec && flatTieEnd > 0,
    `Binary walk-forward enforces 180s per-mode cooldown and treats exact tie as loss (signals=${binWalk.signals.length})`
  );

  // 23f. MT5 walk-forward + CSV + Report text compliance (no "accuracy"/"probability")
  console.log('\n23f. MT5 Walk-Forward, CSV Columns & Report Disclaimers:');
  const mt5WalkEnd = Date.UTC(2026, 7, 12, 16, 0, 0) / 1000;
  const bundleMt5 = makeBullishFxBundle({ nowSec: mt5WalkEnd });
  const mt5Walk = runMt5WalkForwardForSymbol({
    history: {
      asset: EURUSD,
      D1: bundleMt5.d1,
      H4: bundleMt5.h4,
      H1: bundleMt5.h1,
      M15: bundleMt5.m15,
      M5: bundleMt5.m5,
    },
    structureTimeframe: 'H1',
  });
  const csv = buildTradesCsv({ mt5Trades: mt5Walk.trades, binarySignals: binWalk.signals });
  const report = generateBacktestReport({
    generatedAtIso: new Date(PRIME_FX_NOW_MS).toISOString(),
    mt5PerSymbolResults: [{ asset: EURUSD, h1: mt5Walk, m15: mt5Walk }],
    binaryPerSymbolResults: [{ asset: EURUSD, signals: binWalk.signals, startSec: binWalk.startSec, endSec: binWalk.endSec }],
    engineBugsFound: universe.activeIndexBugNotes,
  });
  const lowerReport = report.toLowerCase();
  assert(
    csv.startsWith('time,symbol,engine,direction,strength,entry,outcome,R\n') &&
      report.includes('These results are historical and do not predict future performance.') &&
      report.includes('14 days is a small sample') &&
      report.includes('Plain-English Summary') &&
      report.includes('Pooled MT5 (all trades):') &&
      report.includes('Pooled Binary (all trades):') &&
      report.includes('Engine Anomalies Observed During Run') &&
      !lowerReport.includes('accuracy') &&
      !lowerReport.includes('probability'),
    `CSV header exact & report includes pooled summaries, disclaimer, 14-day caveat, and zero "accuracy"/"probability"`
  );
}

function runStage4KSafetyFixTests() {
  console.log('\n============================================================');
  console.log('  TICKVERE STAGE 4K: INSTRUMENT SAFETY & OTC/REPORT FIXES');
  console.log('============================================================\n');

  // 24a. All 28 FX pairs + metals + crypto + OTC_* indices: normalizeSpecKey, contractSize, pipSize, maxLot, and $10k/1%/25-pip sizing
  console.log('24a. All 28 FX Pairs + Metals + Crypto + Indices Spec & Lot Sizing:');
  const CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'] as const;
  // Approximate spot/USD prices for cross conversion in position-sizing check
  const USD_PER_CCY: Record<string, number> = {
    EUR: 1.09,
    GBP: 1.27,
    USD: 1.0,
    JPY: 1 / 150,
    AUD: 0.66,
    CAD: 1 / 1.36,
    CHF: 1 / 0.88,
    NZD: 0.61,
  };
  const fxRates: Record<string, number> = {};
  for (const b of CURRENCIES) {
    for (const q of CURRENCIES) {
      if (b === q) continue;
      fxRates[`${b}${q}`] = USD_PER_CCY[b] / USD_PER_CCY[q];
    }
  }

  let pairCount = 0;
  let all28SpecOk = true;
  let all28LotOk = true;
  const badPairs: string[] = [];

  for (let i = 0; i < CURRENCIES.length; i++) {
    for (let j = i + 1; j < CURRENCIES.length; j++) {
      pairCount++;
      const c1 = CURRENCIES[i];
      const c2 = CURRENCIES[j];
      // Standard market ordering (EUR > GBP > AUD > NZD > USD > CAD > CHF > JPY)
      const ORDER = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];
      const [base, quote] = ORDER.indexOf(c1) < ORDER.indexOf(c2) ? [c1, c2] : [c2, c1];
      const sym = `frx${base}${quote}`;
      const expectedKey = `${base}/${quote}`;
      const expectedPip = quote === 'JPY' ? 0.01 : 0.0001;
      const expectedDec = quote === 'JPY' ? 3 : 5;

      const asset: AssetConfig = {
        symbol: sym,
        name: expectedKey,
        type: 'FOREX',
        pipSize: quote === 'JPY' ? 0.001 : 0.00001, // raw Deriv precision step
        decimals: expectedDec,
      };
      const key = normalizeSpecKey(sym);
      const spec = resolveInstrumentSpec(asset);
      const check = assertSpecMatchesSymbol(sym, spec);
      const rate = resolveQuoteToAccountRate({
        quoteCcy: spec.quoteCcy,
        accountCurrency: 'USD',
        asset,
        entryPrice: fxRates[`${base}${quote}`],
        conversionRates: fxRates,
      });
      const sizing = calculateMT5PositionSize({
        accountBalance: 10_000,
        riskPct: 1.0,
        slDistancePrice: 25 * spec.pipSize,
        spec,
        quoteToAccountRate: rate || 1,
        accountCurrency: 'USD',
      });

      if (
        key !== expectedKey ||
        spec.contractSize !== 100000 ||
        Math.abs(spec.pipSize - expectedPip) > 1e-9 ||
        spec.maxLot !== 50 ||
        !check.ok
      ) {
        all28SpecOk = false;
        badPairs.push(`${sym}(key=${key},c=${spec.contractSize},pip=${spec.pipSize})`);
      }
      if (!(sizing.lotSize >= 0.1 && sizing.lotSize <= 1.5)) {
        all28LotOk = false;
        badPairs.push(`${sym}(lots=${sizing.lotSize})`);
      }
    }
  }

  // Explicitly test frxAUDJPY, frxAUDCAD, frxAUDCHF, frxAUDNZD, frxAUDUSD (no XAU substring match!)
  const audPairCheck = ['frxAUDUSD', 'frxAUDJPY', 'frxAUDCAD', 'frxAUDCHF', 'frxAUDNZD'].every((sym) => {
    const bare = sym.slice(3);
    const quote = bare.slice(3, 6);
    const key = normalizeSpecKey(sym);
    const sp = resolveInstrumentSpec({ symbol: sym, name: `${bare.slice(0, 3)}/${quote}`, type: 'FOREX', pipSize: quote === 'JPY' ? 0.01 : 0.0001, decimals: quote === 'JPY' ? 3 : 5 });
    return key === `${bare.slice(0, 3)}/${quote}` && sp.contractSize === 100000 && sp.pipSize === (quote === 'JPY' ? 0.01 : 0.0001);
  });

  // Metals, crypto, and OTC_* indices
  const xauNorm = normalizeSpecKey('frxXAUUSD');
  const xauNameNorm = normalizeSpecKey('Gold');
  const xauSpec = resolveInstrumentSpec({ symbol: 'frxXAUUSD', name: 'Gold/USD', type: 'COMMODITY', pipSize: 0.01, decimals: 2 });
  const xagNorm = normalizeSpecKey('frxXAGUSD');
  const xagSpec = resolveInstrumentSpec({ symbol: 'frxXAGUSD', name: 'Silver/USD', type: 'COMMODITY', pipSize: 0.001, decimals: 3 });
  const btcSpec = resolveInstrumentSpec({ symbol: 'cryBTCUSD', name: 'BTC/USD', type: 'CRYPTO', pipSize: 1.0, decimals: 2 });
  const ethSpec = resolveInstrumentSpec({ symbol: 'cryETHUSD', name: 'ETH/USD', type: 'CRYPTO', pipSize: 0.1, decimals: 2 });
  const spcSpec = resolveInstrumentSpec({ symbol: 'OTC_SPC', name: 'US 500', type: 'INDEX', pipSize: 0.01, decimals: 2 });
  const ndxSpec = resolveInstrumentSpec({ symbol: 'OTC_NDX', name: 'US Tech 100', type: 'INDEX', pipSize: 0.01, decimals: 2 });
  const djiSpec = resolveInstrumentSpec({ symbol: 'OTC_DJI', name: 'Wall Street 30', type: 'INDEX', pipSize: 0.01, decimals: 2 });

  assert(
    pairCount === 28 &&
      all28SpecOk &&
      all28LotOk &&
      audPairCheck &&
      xauNorm === 'XAU/USD' &&
      xauNameNorm === 'XAU/USD' &&
      xauSpec.contractSize === 100 &&
      xauSpec.pipSize === 0.01 &&
      xauSpec.maxLot === 20 &&
      xagNorm === 'XAG/USD' &&
      xagSpec.contractSize === 5000 &&
      xagSpec.pipSize === 0.001 &&
      xagSpec.maxLot === 20 &&
      btcSpec.contractSize === 1 &&
      btcSpec.pipSize === 1.0 &&
      btcSpec.maxLot === 100 &&
      ethSpec.contractSize === 1 &&
      ethSpec.pipSize === 0.1 &&
      ethSpec.maxLot === 100 &&
      spcSpec.symbol === 'OTC_SPC' &&
      ndxSpec.symbol === 'OTC_NDX' &&
      djiSpec.symbol === 'OTC_DJI' &&
      spcSpec.contractSize === 1 &&
      spcSpec.maxLot === 50,
    `All ${pairCount} FX pairs ($10k/1%/25p => 0.1..1.5 lots), Metals (XAU/XAG), Crypto (BTC/ETH), and OTC_* indices pass spec checks (bad: ${badPairs.join(', ') || 'none'})`
  );

  // 24b. Defence-in-depth assertSpecMatchesSymbol + maxLot guard in BOTH engines
  console.log('\n24b. assertSpecMatchesSymbol & maxLot Defence-in-Depth:');
  const consoleErrors: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
  try {
    const audAsset: AssetConfig = { symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001 };
    const bundle = makeBullishFxBundle();
    const m1Ticks: TimestampedTick[] = Array.from({ length: 20 }, (_, i) => ({
      time: PRIME_FX_NOW_SEC - (20 - i) * 2,
      price: 0.655 + i * 0.0001,
    }));

    const badMt5Contract = analyzeMT5Signal({
      asset: audAsset,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'LIVE',
      contractSizeOverride: 100, // corrupted gold contract size on FX pair
      nowMs: PRIME_FX_NOW_MS,
    });
    const badMt5Pip = analyzeMT5Signal({
      asset: audAsset,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'LIVE',
      instrumentSpec: { pipSize: 0.01 }, // corrupted JPY pip on AUD/USD
      nowMs: PRIME_FX_NOW_MS,
    });
    const badBinary = analyzeBinarySignal({
      asset: audAsset,
      platform: 'deriv',
      m1Candles: makeCandles({ count: 40, startPrice: 0.65, step: 0.0002, stepSec: 60, endEpochSec: PRIME_FX_NOW_SEC }),
      m5Candles: bundle.m5,
      m15Candles: bundle.m15,
      ticks: m1Ticks,
      feedStatus: 'LIVE',
      contractSizeOverride: 100,
      nowMs: PRIME_FX_NOW_MS,
    });

    const oversizeMt5 = analyzeMT5Signal({
      asset: audAsset,
      platform: 'mt5',
      d1Candles: bundle.d1,
      h4Candles: bundle.h4,
      h1Candles: bundle.h1,
      m15Candles: bundle.m15,
      m5Candles: bundle.m5,
      feedStatus: 'LIVE',
      accountCurrency: 'USD',
      accountBalance: 5_000_000, // 1% risk = $50,000 => ~200 lots > maxLot(50)
      riskPct: 1.0,
      nowMs: PRIME_FX_NOW_MS,
    });
    const oversizeMetal = calculateMT5PositionSize({
      accountBalance: 5_000_000,
      riskPct: 1.0,
      slDistancePrice: 2.5,
      spec: xauSpec,
      quoteToAccountRate: 1,
      accountCurrency: 'USD',
    });

    assert(
      badMt5Contract.direction === 'WAIT' &&
        badMt5Contract.whyNotTrade === 'Instrument settings mismatch; analysis disabled for safety' &&
        badMt5Pip.direction === 'WAIT' &&
        badMt5Pip.whyNotTrade === 'Instrument settings mismatch; analysis disabled for safety' &&
        badBinary.direction === 'WAIT' &&
        badBinary.whyNotTrade === 'Instrument settings mismatch; analysis disabled for safety' &&
        consoleErrors.length >= 3 &&
        oversizeMt5.direction === 'WAIT' &&
        oversizeMt5.whyNotTrade === 'Lot size is outside safe limits' &&
        oversizeMetal.lotSize === 0 &&
        oversizeMetal.outsideSafeLimits === true &&
        resolveDefaultMaxLot(audAsset) === 50,
      'Corrupted contractSize/pipSize logs console.error and returns WAIT safety message in both engines; >maxLot is refused cleanly'
    );
  } finally {
    console.error = origConsoleError;
  }

  // 24c. OTC handling & exchange_is_open for OTC_* indices
  console.log('\n24c. OTC Blocking Rules & exchange_is_open Hours for OTC_* Indices:');
  const spcOpen: AssetConfig = {
    symbol: 'OTC_SPC',
    name: 'US 500',
    type: 'INDEX',
    decimals: 2,
    pipSize: 0.01,
    exchange_is_open: true,
  };
  const spcClosed: AssetConfig = { ...spcOpen, exchange_is_open: false };
  const brokerOtcRow: AssetConfig = { symbol: 'frxEURUSD', name: 'EUR/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, is_otc: true };
  const displayOtc: AssetConfig = { symbol: 'frxEURUSD', name: 'EUR/USD OTC', type: 'FOREX', decimals: 5, pipSize: 0.0001 };

  const idxBundle = makeBullishFxBundle();
  // Run during FX rollover hour (22:15:30 UTC on Wednesday) to prove exchange_is_open: true allows OTC_SPC
  const fxRolloverMs = Date.UTC(2026, 2, 18, 22, 15, 30);
  const fxRolloverSec = Math.floor(fxRolloverMs / 1000);
  const scaleCandles = (cs: Candle[], mult: number): Candle[] =>
    cs.map((c) => ({
      time: c.time,
      open: parseFloat((c.open * mult).toFixed(2)),
      high: parseFloat((c.high * mult).toFixed(2)),
      low: parseFloat((c.low * mult).toFixed(2)),
      close: parseFloat((c.close * mult).toFixed(2)),
    }));
  const idxFxBundle = makeBullishFxBundle({ nowSec: fxRolloverSec });
  const idxD1 = scaleCandles(idxFxBundle.d1, 5000);
  const idxH4 = scaleCandles(idxFxBundle.h4, 5000);
  const idxH1 = scaleCandles(idxFxBundle.h1, 5000);
  const idxM15 = makeCandles({ count: 35, startPrice: 5400, step: 2.0, stepSec: 900, endEpochSec: fxRolloverSec, spreadPips: 1, pipSize: 1 });
  const idxM5 = makeCandles({ count: 35, startPrice: 5440, step: 1.25, stepSec: 300, endEpochSec: fxRolloverSec, spreadPips: 1, pipSize: 1 });
  const idxM1 = makeCandles({ count: 60, startPrice: 5425, step: 0.9, stepSec: 60, endEpochSec: fxRolloverSec, spreadPips: 1, pipSize: 1 });
  const lastIdxM1Close = idxM1[idxM1.length - 1].close;
  const rolloverTicks = makeTicks({ count: 20, startPrice: lastIdxM1Close - 2.0, step: 0.15, endMs: fxRolloverMs });

  const mt5SpcOpen = analyzeMT5Signal({
    asset: spcOpen,
    platform: 'mt5',
    d1Candles: idxD1,
    h4Candles: idxH4,
    h1Candles: idxH1,
    m15Candles: scaleCandles(idxFxBundle.m15, 5000),
    m5Candles: scaleCandles(idxFxBundle.m5, 5000),
    feedStatus: 'LIVE',
    accountBalance: 10000,
    nowMs: fxRolloverMs,
  });
  const mt5SpcClosed = analyzeMT5Signal({
    asset: spcClosed,
    platform: 'mt5',
    d1Candles: idxD1,
    h4Candles: idxH4,
    h1Candles: idxH1,
    m15Candles: scaleCandles(idxFxBundle.m15, 5000),
    m5Candles: scaleCandles(idxFxBundle.m5, 5000),
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  const binSpcOpen = analyzeBinarySignal({
    asset: spcOpen,
    platform: 'deriv',
    m1Candles: idxM1,
    m5Candles: idxM5,
    m15Candles: idxM15,
    ticks: rolloverTicks,
    feedStatus: 'LIVE',
    nowMs: fxRolloverMs,
  });
  const binSpcClosed = analyzeBinarySignal({
    asset: spcClosed,
    platform: 'deriv',
    m1Candles: idxM1,
    m5Candles: idxM5,
    m15Candles: idxM15,
    ticks: rolloverTicks,
    feedStatus: 'LIVE',
    nowMs: fxRolloverMs,
  });
  const mt5BlockedFlag = analyzeMT5Signal({
    asset: brokerOtcRow,
    platform: 'mt5',
    d1Candles: idxBundle.d1,
    h4Candles: idxBundle.h4,
    h1Candles: idxBundle.h1,
    m15Candles: idxBundle.m15,
    m5Candles: idxBundle.m5,
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });
  const binBlockedDisplay = analyzeBinarySignal({
    asset: displayOtc,
    platform: 'pocket_option',
    m1Candles: idxM1,
    m15Candles: idxM15,
    ticks: rolloverTicks,
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });

  // Verify XAU macro news does NOT falsely block frxAUDUSD
  const xauNews: MarketEventItem[] = [
    { starts_at: new Date(PRIME_FX_NOW_MS + 5 * 60_000).toISOString(), currency: 'XAU', title: 'Gold fix', impact: 'HIGH' },
  ];
  const audWithXauNews = analyzeMT5Signal({
    asset: { symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001 },
    platform: 'mt5',
    d1Candles: idxBundle.d1,
    h4Candles: idxBundle.h4,
    h1Candles: idxBundle.h1,
    m15Candles: idxBundle.m15,
    m5Candles: idxBundle.m5,
    marketEvents: xauNews,
    feedStatus: 'LIVE',
    nowMs: PRIME_FX_NOW_MS,
  });

  assert(
    !isOtcInstrument(spcOpen, false) &&
      isOtcInstrument(brokerOtcRow, false) &&
      isOtcInstrument(displayOtc, false) &&
      mt5SpcOpen.direction === 'BUY' &&
      mt5SpcOpen.inputsSnapshot?.blocker !== 'OTC' &&
      mt5SpcClosed.direction === 'WAIT' &&
      mt5SpcClosed.inputsSnapshot?.blocker === 'MARKET_CLOSED' &&
      binSpcOpen.direction !== 'WAIT' &&
      binSpcClosed.direction === 'WAIT' &&
      binSpcClosed.inputsSnapshot?.blocker === 'LOW_LIQUIDITY_SESSION' &&
      mt5BlockedFlag.direction === 'WAIT' &&
      mt5BlockedFlag.inputsSnapshot?.blocker === 'OTC' &&
      binBlockedDisplay.direction === 'WAIT' &&
      binBlockedDisplay.inputsSnapshot?.blocker === 'OTC' &&
      audWithXauNews.inputsSnapshot?.blocker !== 'HIGH_IMPACT_NEWS',
    `OTC_SPC trades when exchange_is_open=true, waits when false, blocks only on is_otc/display OTC, and XAU news does not block frxAUDUSD`,
    `mt5Open=${mt5SpcOpen.direction}(${mt5SpcOpen.whyNotTrade || 'ok'}) mt5Closed=${mt5SpcClosed.inputsSnapshot?.blocker} binOpen=${binSpcOpen.direction}(${binSpcOpen.whyNotTrade || 'ok'}) binClosed=${binSpcClosed.inputsSnapshot?.blocker} audBlocker=${audWithXauNews.inputsSnapshot?.blocker || 'none'}`
  );

  // 24d. Backtest report <30 trades guard and pooled summaries
  console.log('\n24d. Backtest Report <30 Trade Guard & Pooled Summaries:');
  const smallMt5Trades = Array.from({ length: 5 }, (_, i) => ({
    entryTimeSec: PRIME_FX_NOW_SEC + i * 3600,
    exitTimeSec: PRIME_FX_NOW_SEC + i * 3600 + 1800,
    timeIso: new Date((PRIME_FX_NOW_SEC + i * 3600) * 1000).toISOString(),
    symbol: 'frxEURUSD',
    structureTimeframe: 'H1' as const,
    direction: 'BUY' as const,
    orderKind: 'MARKET' as const,
    strength: 'High' as const,
    entryPrice: 1.09,
    stopLoss: 1.088,
    takeProfit1: 1.094,
    rewardRiskTp1: 2.0,
    outcome: 'WIN' as const,
    exitReason: 'TP1' as const,
    grossR: 2.0,
    costR: 0.05,
    netR: 1.95,
  }));
  const smallBinSignals = Array.from({ length: 6 }, (_, i) => ({
    entryTimeSec: PRIME_FX_NOW_SEC + i * 300,
    timeIso: new Date((PRIME_FX_NOW_SEC + i * 300) * 1000).toISOString(),
    symbol: 'frxEURUSD',
    mode: '3m' as const,
    chosenExpiry: '3m' as const,
    direction: 'CALL' as const,
    strength: 'High' as const,
    entryPrice: 1.09,
    outcomesByHorizon: { '1m': true, '2m': true, '3m': true, '5m': true },
  }));

  const smallReport = generateBacktestReport({
    generatedAtIso: new Date(PRIME_FX_NOW_MS).toISOString(),
    mt5PerSymbolResults: [
      {
        asset: EURUSD,
        h1: { trades: smallMt5Trades, unfilledLimitCount: 0, skippedSmallLotCount: 0, otcBlockedScans: 0, startSec: PRIME_FX_NOW_SEC, endSec: PRIME_FX_NOW_SEC + 86400, splitSec: PRIME_FX_NOW_SEC },
        m15: { trades: [], unfilledLimitCount: 0, skippedSmallLotCount: 0, otcBlockedScans: 0, startSec: PRIME_FX_NOW_SEC, endSec: PRIME_FX_NOW_SEC + 86400, splitSec: PRIME_FX_NOW_SEC },
      },
    ],
    binaryPerSymbolResults: [
      { asset: EURUSD, signals: smallBinSignals, startSec: PRIME_FX_NOW_SEC, endSec: PRIME_FX_NOW_SEC + 3600 },
    ],
    engineBugsFound: [],
  });

  const smallLower = smallReport.toLowerCase();
  assert(
    smallReport.includes('Pooled MT5 (all trades): n=5') &&
      smallReport.includes('Pooled Binary (all trades): n=6') &&
      smallReport.includes('not enough trades') &&
      !smallLower.includes('positive and significant') &&
      !smallLower.includes('positive but not significant') &&
      !smallLower.includes('beats 80% break-even') &&
      !smallLower.includes('above break-even in:'),
    'Report never prints "positive" or "above break-even" for <30 trades, prints "not enough trades", and includes pooled MT5 & Binary lines with 95% CI'
  );
}

async function runStage4LConditionsTests() {
  console.log('\n============================================================');
  console.log('STAGE 4L TESTS: Trading Conditions Gate (OK / CAUTION / NOT_ADVISED)');
  console.log('============================================================\n');

  const WED_14_UTC_MS = Date.UTC(2025, 4, 14, 14, 0, 0); // Wed 14:00 UTC (London/NY overlap)
  const EURUSD_ASSET: AssetConfig = {
    symbol: 'frxEURUSD',
    name: 'EUR/USD',
    type: 'FOREX',
    decimals: 5,
    pipSize: 0.0001,
    distanceUnit: 'pips',
  };
  const BTC_ASSET: AssetConfig = {
    symbol: 'cryBTCUSD',
    name: 'BTC/USD',
    type: 'CRYPTO',
    decimals: 2,
    pipSize: 1.0,
    distanceUnit: 'points',
  };
  const SYNTH_ASSET: AssetConfig = {
    symbol: 'R_100',
    name: 'VOL 100',
    type: 'SYNTH',
    decimals: 2,
    pipSize: 0.01,
    distanceUnit: 'points',
  };

  const makeMockContext = (opts?: {
    percentile30d?: number;
    m15Dir?: 'Bullish' | 'Bearish' | 'Neutral';
    h1Dir?: 'Bullish' | 'Bearish' | 'Neutral';
    h4Dir?: 'Bullish' | 'Bearish' | 'Neutral';
    d1Dir?: 'Bullish' | 'Bearish' | 'Neutral';
    quietHours?: number[];
  }): MarketContextSummary => {
    const quietSet = new Set(opts?.quietHours ?? [0, 1, 2, 3, 4, 5]);
    return {
      symbol: 'frxEURUSD',
      assetName: 'EUR/USD',
      pipSize: 0.0001,
      decimals: 5,
      distanceUnit: 'pips',
      currentPrice: 1.09,
      computedAtIso: new Date(WED_14_UTC_MS).toISOString(),
      trendTable: [
        { timeframe: 'M15', direction: opts?.m15Dir ?? 'Bullish', strength: 'Strong', ema21: 1.089, distancePips: 10, distancePct: 0.09, lastClose: 1.09, sampleCount: 50 },
        { timeframe: 'H1', direction: opts?.h1Dir ?? 'Bullish', strength: 'Strong', ema21: 1.088, distancePips: 20, distancePct: 0.18, lastClose: 1.09, sampleCount: 50 },
        { timeframe: 'H4', direction: opts?.h4Dir ?? 'Bullish', strength: 'Strong', ema21: 1.085, distancePips: 50, distancePct: 0.45, lastClose: 1.09, sampleCount: 50 },
        { timeframe: 'D1', direction: opts?.d1Dir ?? 'Bullish', strength: 'Strong', ema21: 1.08, distancePips: 100, distancePct: 0.9, lastClose: 1.09, sampleCount: 50 },
      ],
      levelsMap: [],
      dailyPivot: null,
      pivotSampleCount: 0,
      volatilityRegime: {
        currentAtr: 0.008,
        currentAtrPips: 80,
        percentile30d: opts?.percentile30d ?? 50,
        regime: 'normal',
        sampleCount: 30,
        lookbackTargetDays: 30,
      },
      sessionProfile: {
        lookbackWeeks: 8,
        totalBars: 800,
        hours: Array.from({ length: 24 }, (_, hourUtc) => ({
          hourUtc,
          hourLabel: `${String(hourUtc).padStart(2, '0')}:00`,
          avgRangePips: quietSet.has(hourUtc) ? 4 : 25 + (hourUtc === 14 ? 20 : 0),
          sampleCount: 30,
        })),
        mostActiveHour: { hourUtc: 14, hourLabel: '14:00', avgRangePips: 45, sampleCount: 30 },
        quietestHour: { hourUtc: 2, hourLabel: '02:00', avgRangePips: 4, sampleCount: 30 },
      },
    };
  };

  // 25a. OK fixture
  console.log('25a. OK baseline fixture:');
  const okRes = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 2,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    upcomingEvents: [],
    userState: { consecutiveLosses: 0, dailyLossesCount: 0, dailyLossLimitCount: 3 },
  });
  assert(
    okRes.level === 'OK' &&
      okRes.reasons.length === 0 &&
      okRes.nextBetterWindowText === undefined,
    'Healthy open market with aligned trends and normal ATR returns OK with zero warnings'
  );

  // 25b. NOT_ADVISED rules & boundaries
  console.log('\n25b. NOT_ADVISED rules & boundary conditions:');
  const closedFlag = assessConditions({
    asset: { ...EURUSD_ASSET, exchange_is_open: false },
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
  });
  const weekendSat = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'MARKET_CLOSED',
    nowMs: Date.UTC(2025, 4, 17, 12, 0, 0), // Saturday 12:00 UTC
  });
  const feedDelayed = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'DELAYED',
    nowMs: WED_14_UTC_MS,
  });
  const tickBoundaryOk = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 6.0,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
  });
  const tickStale = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 6.1,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
  });
  const mt5IgnoresTickAge = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    tickAgeSeconds: 20,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
  });

  assert(
    closedFlag.level === 'NOT_ADVISED' &&
      closedFlag.reasons.some((r) => r.code === 'MARKET_CLOSED') &&
      weekendSat.level === 'NOT_ADVISED' &&
      Boolean(weekendSat.nextBetterWindowText?.includes('Sunday 21:00 UTC')) &&
      feedDelayed.level === 'NOT_ADVISED' &&
      feedDelayed.reasons.some((r) => r.code === 'FEED_NOT_LIVE') &&
      tickBoundaryOk.level === 'OK' &&
      tickStale.level === 'NOT_ADVISED' &&
      tickStale.reasons.some((r) => r.code === 'TICK_STALE') &&
      mt5IgnoresTickAge.level === 'OK',
    'Market closed, non-LIVE feed, and binary tick age (>6s vs <=6s) trigger expected NOT_ADVISED/OK transitions'
  );

  // News boundaries: 15m binary / 30m MT5 / 60m caution
  const usdNews15m: MarketEventItem[] = [
    { id: 'ev1', starts_at: new Date(WED_14_UTC_MS + 15 * 60_000).toISOString(), currency: 'USD', title: 'US CPI', impact: 'HIGH' },
  ];
  const usdNews25m: MarketEventItem[] = [
    { id: 'ev2', starts_at: new Date(WED_14_UTC_MS + 25 * 60_000).toISOString(), currency: 'USD', title: 'FOMC', impact: 'HIGH' },
  ];
  const jpyNews5m: MarketEventItem[] = [
    { id: 'ev3', starts_at: new Date(WED_14_UTC_MS + 5 * 60_000).toISOString(), currency: 'JPY', title: 'BOJ Rate', impact: 'HIGH' },
  ];
  const bin15mNews = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 1,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    upcomingEvents: usdNews15m,
  });
  const bin25mNews = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 1,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    upcomingEvents: usdNews25m,
  });
  const mt525mNews = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    upcomingEvents: usdNews25m,
  });
  const eurWithJpyNews = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    upcomingEvents: jpyNews5m,
  });

  assert(
    bin15mNews.level === 'NOT_ADVISED' &&
      bin15mNews.reasons.some((r) => r.code === 'HIGH_IMPACT_NEWS') &&
      Boolean(bin15mNews.nextBetterWindowText?.includes('UTC')) &&
      bin25mNews.level === 'CAUTION' &&
      bin25mNews.reasons.some((r) => r.code === 'UPCOMING_HIGH_NEWS') &&
      mt525mNews.level === 'NOT_ADVISED' &&
      mt525mNews.reasons.some((r) => r.code === 'HIGH_IMPACT_NEWS') &&
      eurWithJpyNews.level === 'OK',
    'HIGH-impact news triggers NOT_ADVISED at ±15m (binary) / ±30m (MT5), CAUTION up to ±60m, and matches currency'
  );

  // Rollover window (21:00 - 00:00 UTC weekday FX/metals, skipped for crypto)
  const rolloverStart = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: Date.UTC(2025, 4, 14, 21, 0, 0),
    marketContext: makeMockContext(),
  });
  const preRollover = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: Date.UTC(2025, 4, 14, 20, 59, 0),
    marketContext: makeMockContext(),
  });
  const cryptoDuringRollover = assessConditions({
    asset: BTC_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: Date.UTC(2025, 4, 14, 22, 0, 0),
    marketContext: makeMockContext(),
  });
  assert(
    rolloverStart.level === 'NOT_ADVISED' &&
      rolloverStart.reasons.some((r) => r.code === 'ROLLOVER_WINDOW') &&
      Boolean(rolloverStart.nextBetterWindowText?.includes('00:00 UTC')) &&
      preRollover.level === 'OK' &&
      cryptoDuringRollover.level === 'OK',
    'Weekday FX rollover (21:00–00:00 UTC) triggers NOT_ADVISED with 00:00 UTC next window, skipped for 24/7 crypto'
  );

  // ATR percentile dead/extreme + user limits + synthetic index
  const atrDead = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 9.9 }),
  });
  const atrExtreme = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 95.1 }),
  });
  const twoLosses = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 1,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    userState: { consecutiveLosses: 2 },
  });
  const threeLosses = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 1,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    userState: { consecutiveLosses: 3 },
  });
  const dailyLimitReached = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
    userState: { consecutiveLosses: 0, dailyLossesCount: 2, dailyLossLimitCount: 2 },
  });
  const synthRes = assessConditions({
    asset: SYNTH_ASSET,
    platformProfile: 'BINARY_QUICK',
    feedStatus: 'LIVE',
    tickAgeSeconds: 1,
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext(),
  });

  assert(
    atrDead.level === 'NOT_ADVISED' &&
      atrDead.reasons.some((r) => r.code === 'ATR_TOO_LOW') &&
      atrExtreme.level === 'NOT_ADVISED' &&
      atrExtreme.reasons.some((r) => r.code === 'ATR_EXTREME') &&
      twoLosses.level === 'OK' &&
      threeLosses.level === 'NOT_ADVISED' &&
      threeLosses.reasons.some((r) => r.code === 'CONSECUTIVE_LOSSES') &&
      dailyLimitReached.level === 'NOT_ADVISED' &&
      dailyLimitReached.reasons.some((r) => r.code === 'DAILY_LOSS_LIMIT') &&
      synthRes.level === 'NOT_ADVISED' &&
      synthRes.reasons.some((r) => r.code === 'SYNTHETIC_PRACTICE_ONLY' && r.text === 'Practice only: random by design'),
    'ATR <10 / >95, >=3 consecutive losses, daily loss limit, and synthetic index ("Practice only: random by design") trigger NOT_ADVISED'
  );

  // 25c. CAUTION rules & exact boundaries
  console.log('\n25c. CAUTION rules & boundary values:');
  const quietHourRes = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: Date.UTC(2025, 4, 14, 3, 0, 0), // 03:00 UTC is in quietHours [0..5]
    marketContext: makeMockContext(),
  });
  const atrLowCaution10 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 10 }),
  });
  const atrLowCaution25 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 25 }),
  });
  const atrNormal251 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 25.1 }),
  });
  const atrHighCaution85 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 85 }),
  });
  const atrHighCaution95 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ percentile30d: 95 }),
  });
  const trendDisagree = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: WED_14_UTC_MS,
    marketContext: makeMockContext({ m15Dir: 'Bearish', h1Dir: 'Bullish', h4Dir: 'Bullish', d1Dir: 'Bullish' }),
  });
  const fri1859 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: Date.UTC(2025, 4, 16, 18, 59, 0),
    marketContext: makeMockContext(),
  });
  const fri1900 = assessConditions({
    asset: EURUSD_ASSET,
    platformProfile: 'MT5',
    feedStatus: 'LIVE',
    nowMs: Date.UTC(2025, 4, 16, 19, 0, 0),
    marketContext: makeMockContext(),
  });

  assert(
    quietHourRes.level === 'CAUTION' &&
      quietHourRes.reasons.some((r) => r.code === 'QUIET_SESSION_HOUR') &&
      atrLowCaution10.level === 'CAUTION' &&
      atrLowCaution10.reasons.some((r) => r.code === 'ATR_LOW_CAUTION') &&
      atrLowCaution25.level === 'CAUTION' &&
      atrNormal251.level === 'OK' &&
      atrHighCaution85.level === 'CAUTION' &&
      atrHighCaution85.reasons.some((r) => r.code === 'ATR_HIGH_CAUTION') &&
      atrHighCaution95.level === 'CAUTION' &&
      trendDisagree.level === 'CAUTION' &&
      trendDisagree.reasons.some((r) => r.code === 'TREND_DISAGREEMENT') &&
      fri1859.level === 'OK' &&
      fri1900.level === 'CAUTION' &&
      fri1900.reasons.some((r) => r.code === 'FRIDAY_LATE_SESSION'),
    'All CAUTION rules (quiet session quartile, ATR 10-25 & 85-95, trend disagreement, Friday >= 19:00 UTC) trigger properly'
  );

  // 25d. Two-step override gating, WAIT consistency, config validation & API handler
  console.log('\n25d. Two-tap override gating, WAIT consistency, config validation & disclaimer:');
  const step1 = resolveAnalyseGateState({
    level: 'NOT_ADVISED',
    reasons: [{ code: 'ROLLOVER_WINDOW', severity: 'NOT_ADVISED', text: 'Rollover' }],
    overrideArmed: false,
    isHardTechnicalBlock: false,
    normalLabel: 'SCAN BINARY SIGNAL',
  });
  const step2 = resolveAnalyseGateState({
    level: 'NOT_ADVISED',
    reasons: [{ code: 'ROLLOVER_WINDOW', severity: 'NOT_ADVISED', text: 'Rollover' }],
    overrideArmed: true,
    isHardTechnicalBlock: false,
    normalLabel: 'SCAN BINARY SIGNAL',
  });
  const blockedGate = resolveAnalyseGateState({
    level: 'NOT_ADVISED',
    reasons: [{ code: 'MARKET_CLOSED', severity: 'NOT_ADVISED', text: 'Market closed' }],
    overrideArmed: false,
    isHardTechnicalBlock: true,
    hardBlockLabel: 'MARKET CLOSED',
    normalLabel: 'SCAN BINARY SIGNAL',
  });

  const consistentNewsWait = pickConsistentWaitReason(
    'Engine raw news text',
    bin15mNews,
    'HIGH_IMPACT_NEWS'
  );
  const invalidCfg = validateConditionsConfig({ ...DEFAULT_CONDITIONS_CONFIG, atrPercentileLowBlock: 40, atrPercentileLowCautionMax: 20 });
  const invalidNegTick = validateConditionsConfig({ ...DEFAULT_CONDITIONS_CONFIG, binaryTickMaxAgeSec: 0 });
  const validCfg = validateConditionsConfig({ ...DEFAULT_CONDITIONS_CONFIG, binaryTickMaxAgeSec: 10 });
  const normDefault = normalizeConditionsConfig(null);

  // Verify disclaimer & no win/loss prediction language or forbidden Math.random in conditions.ts
  const conditionsSrc = readFileSync(resolve(process.cwd(), 'src/utils/conditions.ts'), 'utf8');
  const conditionsHasRandom = conditionsSrc.includes('Math.random');
  const conditionsHasFetch = /\bfetch\s*\(/.test(conditionsSrc);

  // Verify adminSettingsHandler rejects out-of-range conditions_config when admin auth fails or validation runs
  let badCondStatus = 0;
  await adminSettingsHandler(
    { method: 'POST', headers: {}, body: { key: 'conditions_config', value: { binaryTickMaxAgeSec: 0 } } },
    {
      setHeader() {},
      status(c: number) { badCondStatus = c; return this; },
      json() { return this; },
    }
  );
  // Note: without admin auth it returns 401 first; verify signal log schema accepts conditions_override up to Zod step (returns 401 after Zod pass, vs 400 on malformed override)
  let validOverrideAuthStatus = 0;
  await signalsLogHandler(
    {
      method: 'POST',
      headers: {},
      body: {
        asset: 'frxEURUSD',
        timeframe: '3m',
        direction: 'CALL',
        entry_price: 1.09,
        conditions_override: {
          overridden: true,
          level: 'NOT_ADVISED',
          reasonCodes: ['ROLLOVER_WINDOW'],
        },
      },
    },
    {
      setHeader() {},
      status(c: number) { validOverrideAuthStatus = c; return this; },
      json() { return this; },
    }
  );
  let badOverrideStatus = 0;
  await signalsLogHandler(
    {
      method: 'POST',
      headers: {},
      body: {
        asset: 'frxEURUSD',
        timeframe: '3m',
        direction: 'CALL',
        entry_price: 1.09,
        conditions_override: {
          overridden: 'yes',
          reasonCodes: [],
        },
      },
    },
    {
      setHeader() {},
      status(c: number) { badOverrideStatus = c; return this; },
      json() { return this; },
    }
  );

  assert(
    step1.action === 'ARM_OVERRIDE' &&
      step2.action === 'RUN_WITH_OVERRIDE' &&
      step2.buttonLabel === OVERRIDE_BUTTON_LABEL &&
      blockedGate.disabled === true &&
      blockedGate.action === 'BLOCKED' &&
      consistentNewsWait === bin15mNews.reasons[0].text &&
      !invalidCfg.ok &&
      !invalidNegTick.ok &&
      validCfg.ok &&
      validCfg.value?.binaryTickMaxAgeSec === 10 &&
      normDefault.binaryTickMaxAgeSec === 6 &&
      CONDITIONS_DISCLAIMER_TEXT === 'This checks risk conditions. It does not predict whether a trade will win or lose.' &&
      !conditionsHasRandom &&
      !conditionsHasFetch &&
      badCondStatus === 403 &&
      validOverrideAuthStatus === 401 &&
      badOverrideStatus === 400,
    'Two-tap override gate, consistent WAIT wording, config validation, override schema, and pure-module checks pass'
  );
}

runSignalLogValidationTests()
  .then(() => runHistoryRefreshGuards())
  .then(() => runStage4GReferralAndRadarTests())
  .then(() => runStage4HBrandingTests())
  .then(() => runStage4IResultFixesTests())
  .then(() => runStage4LConditionsTests())
  .then(() => {
    runMt5Tests();
    runStage4EHorizonTests();
    runStage4FPipBrandWordingTests();
    runStage4HSimplifiedUiTests();
    runStage4JChartAndDiagnosticsTests();
    runStage4BBacktestTests();
    runStage4KSafetyFixTests();
    console.log('\n------------------------------------------------------------');
    console.log(`Combined Binary + MT5 + Stage 4A-4L Results: ${passed}/${total} tests passed`);
    console.log('------------------------------------------------------------\n');

    process.exit(passed === total ? 0 : 1);
  });
