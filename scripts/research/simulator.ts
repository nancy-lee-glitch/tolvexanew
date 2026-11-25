/**
 * scripts/research/simulator.ts — Walk-Forward Simulator for Stage R1 Hypotheses H1–H8
 *
 * Guarantees:
 *  - Physically truncates all candle arrays before LOCKED_FORWARD_BLOCK.startSec so
 *    the locked 20% forward block is NEVER read or reported.
 *  - Strict closed-candle causality: only bars with c.time + granularitySec <= scanSec are visible.
 *  - Enforces 1 open trade per symbol per hypothesis.
 *  - Same spread cost model as scripts/backtest-real.ts (resolveSpreadCostForAsset).
 *  - Conservative SL-first tie-breaking when SL and TP occur in the same M5 candle.
 *  - Runtime assertion verifying every trade sits strictly before LOCKED_FORWARD_BLOCK.startSec.
 */

import { analyzeMT5Signal } from '../../src/utils/engines/mt5Engine.ts';
import {
  calculateATR,
  calculateEMA,
  calculateRSI,
} from '../../src/utils/engines/indicators.ts';
import { computeVolatilityRegime } from '../../src/utils/engines/marketContext.ts';
import { resolveAssetPipSpec } from '../../src/utils/instrumentMeta.ts';
import { isSyntheticAsset } from '../../src/services/symbolMap.ts';
import {
  MT5_ACCOUNT_BALANCE_USD,
  MT5_RISK_PCT,
  MT5_TIMEOUT_HOURS,
  buildConversionRatesAtTime,
  resolveMt5TradeOnM5,
  resolveSpreadCostForAsset,
  type Mt5SymbolHistory,
} from '../backtest-real.ts';
import type { Candle } from '../../src/utils/engines/types.ts';
import type { AssetConfig } from '../../src/types.ts';
import {
  isNearFixedWeekdayReleaseUtc,
  type HypothesisId,
} from './hypotheses.ts';
import { splitTimeRange, type ResearchTimeSplit } from './stats.ts';

export type ResearchBlockName = 'learning' | 'validation';

export interface ResearchTradeRecord {
  hypothesisId: HypothesisId;
  hypothesisName: string;
  block: ResearchBlockName;
  symbol: string;
  entryTimeSec: number;
  exitTimeSec: number;
  entryTimeIso: string;
  exitTimeIso: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitReason: string;
  grossR: number;
  costR: number;
  netR: number;
}

export interface H8SelectedHourRule {
  symbol: string;
  utcHour: number;
  direction: 'BUY' | 'SELL';
  learningCount: number;
  learningTStat: number;
}

export interface ResearchSimulationOutput {
  timeSplit: ResearchTimeSplit;
  lockedForwardBlock: {
    startSec: number;
    endSec: number;
    startIso: string;
    endIso: string;
  };
  tradesByHypothesis: Record<HypothesisId, ResearchTradeRecord[]>;
  h8SelectedRules: H8SelectedHourRule[];
  symbolsIncluded: string[];
}

function advanceClosedIndex(
  candles: Candle[],
  currentIdx: number,
  scanSec: number,
  granularitySec: number
): number {
  let idx = currentIdx;
  while (idx < candles.length && candles[idx].time + granularitySec <= scanSec) {
    idx++;
  }
  return idx;
}

function lowerBoundTime(candles: Candle[], targetTimeSec: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < targetTimeSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

export function computeCommonResearchTimeSplit(
  histories: Map<string, Mt5SymbolHistory>
): ResearchTimeSplit {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const hist of histories.values()) {
    if (
      hist.D1.length < 30 ||
      hist.H4.length < 50 ||
      hist.H1.length < 100 ||
      hist.M15.length < 100 ||
      hist.M5.length < 100
    ) {
      continue;
    }
    const symStart = Math.max(
      hist.D1[0].time,
      hist.H4[0].time,
      hist.H1[0].time,
      hist.M15[0].time,
      hist.M5[0].time
    );
    const symEnd = Math.min(
      hist.D1[hist.D1.length - 1].time + 86400,
      hist.H4[hist.H4.length - 1].time + 14400,
      hist.H1[hist.H1.length - 1].time + 3600,
      hist.M15[hist.M15.length - 1].time + 900,
      hist.M5[hist.M5.length - 1].time + 300
    );
    if (symEnd > symStart) {
      starts.push(symStart);
      ends.push(symEnd);
    }
  }

  if (starts.length === 0 || ends.length === 0) {
    throw new Error('No symbols have sufficient candle history to form a research time split.');
  }

  const globalStartSec = medianNumber(starts);
  const globalEndSec = medianNumber(ends);
  return splitTimeRange(globalStartSec, globalEndSec);
}

/**
 * Physically truncates all candles strictly before lockStartSec so the locked 20% block
 * cannot be read by any strategy or exit rule.
 */
export function truncateHistoriesBeforeLock(
  histories: Map<string, Mt5SymbolHistory>,
  m5RatesMap: Map<string, Candle[]>,
  lockStartSec: number
): {
  truncatedHistories: Map<string, Mt5SymbolHistory>;
  truncatedRatesMap: Map<string, Candle[]>;
} {
  const truncatedHistories = new Map<string, Mt5SymbolHistory>();
  for (const [sym, hist] of histories.entries()) {
    truncatedHistories.set(sym, {
      asset: hist.asset,
      D1: hist.D1.filter((c) => c.time + 86400 <= lockStartSec),
      H4: hist.H4.filter((c) => c.time + 14400 <= lockStartSec),
      H1: hist.H1.filter((c) => c.time + 3600 <= lockStartSec),
      M15: hist.M15.filter((c) => c.time + 900 <= lockStartSec),
      M5: hist.M5.filter((c) => c.time + 300 <= lockStartSec),
    });
  }

  const truncatedRatesMap = new Map<string, Candle[]>();
  for (const [sym, bars] of m5RatesMap.entries()) {
    truncatedRatesMap.set(
      sym,
      bars.filter((c) => c.time + 300 <= lockStartSec)
    );
  }

  return { truncatedHistories, truncatedRatesMap };
}

function resolveBracketOnM5(params: {
  direction: 'BUY' | 'SELL';
  entryTimeSec: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  targetR: number;
  breakEvenAtR?: number;
  spreadPrice: number;
  m5Candles: Candle[];
  startIdx: number;
  lockStartSec: number;
}):
  | { status: 'NO_BARS' }
  | {
      status: 'CLOSED';
      exitTimeSec: number;
      exitReason: string;
      grossR: number;
      costR: number;
      netR: number;
    } {
  const {
    direction,
    entryTimeSec,
    entryPrice,
    stopLoss,
    takeProfit,
    targetR,
    breakEvenAtR,
    spreadPrice,
    m5Candles,
    startIdx,
    lockStartSec,
  } = params;

  const slDistance = Math.abs(entryPrice - stopLoss);
  if (!(slDistance > 0)) return { status: 'NO_BARS' };

  const costR = spreadPrice / slDistance;
  const deadlineSec = Math.min(entryTimeSec + MT5_TIMEOUT_HOURS * 3600, lockStartSec);

  let currentStop = stopLoss;
  let movedToBe = false;
  const beTriggerPrice =
    typeof breakEvenAtR === 'number'
      ? direction === 'BUY'
        ? entryPrice + breakEvenAtR * slDistance
        : entryPrice - breakEvenAtR * slDistance
      : null;

  let lastBar: Candle | null = null;
  const begin = Math.max(0, startIdx);

  for (let i = begin; i < m5Candles.length; i++) {
    const c = m5Candles[i];
    if (c.time + 300 <= entryTimeSec) continue;
    if (c.time + 300 > deadlineSec) break;
    lastBar = c;

    // 1. SL checked FIRST (conservative)
    const slHit = direction === 'BUY' ? c.low <= currentStop : c.high >= currentStop;
    if (slHit) {
      const grossR = movedToBe ? 0 : -1.0;
      return {
        status: 'CLOSED',
        exitTimeSec: c.time + 300,
        exitReason: movedToBe ? 'BE_STOP' : 'SL',
        grossR,
        costR,
        netR: grossR - costR,
      };
    }

    // 2. TP checked SECOND
    const tpHit = direction === 'BUY' ? c.high >= takeProfit : c.low <= takeProfit;
    if (tpHit) {
      return {
        status: 'CLOSED',
        exitTimeSec: c.time + 300,
        exitReason: 'TP',
        grossR: targetR,
        costR,
        netR: targetR - costR,
      };
    }

    // 3. Arm break-even for subsequent candles once +1R is reached
    if (!movedToBe && beTriggerPrice !== null) {
      const reachedBe =
        direction === 'BUY' ? c.high >= beTriggerPrice : c.low <= beTriggerPrice;
      if (reachedBe) {
        movedToBe = true;
        currentStop = entryPrice;
      }
    }
  }

  if (!lastBar) return { status: 'NO_BARS' };

  const move = direction === 'BUY' ? lastBar.close - entryPrice : entryPrice - lastBar.close;
  const grossR = move / slDistance;
  return {
    status: 'CLOSED',
    exitTimeSec: lastBar.time + 300,
    exitReason: lastBar.time + 300 >= entryTimeSec + MT5_TIMEOUT_HOURS * 3600 ? 'TIMEOUT_48H' : 'BLOCK_END',
    grossR,
    costR,
    netR: grossR - costR,
  };
}

function assignBlock(entryTimeSec: number, split: ResearchTimeSplit): ResearchBlockName | null {
  if (entryTimeSec < split.globalStartSec) return null;
  if (entryTimeSec < split.learningEndSec) return 'learning';
  if (entryTimeSec < split.lockedForwardStartSec) return 'validation';
  return null;
}

function getEmaDir(candles: Candle[], fast = 21, slow = 50): 'BUY' | 'SELL' | 'FLAT' {
  if (candles.length < slow) return 'FLAT';
  const closes = candles.map((c) => c.close);
  const f = calculateEMA(closes, fast);
  const s = calculateEMA(closes, slow);
  if (f > s) return 'BUY';
  if (f < s) return 'SELL';
  return 'FLAT';
}

// ----------------------------------------------------------------------------
// H1: Trend alignment (D1, H4, H1 EMA21 vs EMA50 agree + M15 pullback to EMA21)
// ----------------------------------------------------------------------------
function simulateH1(
  histories: Map<string, Mt5SymbolHistory>,
  split: ResearchTimeSplit
): ResearchTradeRecord[] {
  const trades: ResearchTradeRecord[] = [];
  const name = 'Trend alignment';

  for (const hist of histories.values()) {
    const { asset, D1, H4, H1, M15, M5 } = hist;
    if (D1.length < 50 || H4.length < 50 || H1.length < 50 || M15.length < 50 || M5.length < 20) {
      continue;
    }
    const spread = resolveSpreadCostForAsset(asset);
    let d1Idx = 0;
    let h4Idx = 0;
    let h1Idx = 0;
    let m5Idx = 0;
    let busyUntilSec = 0;

    let cachedKey = '';
    let cachedTrend: 'BUY' | 'SELL' | 'FLAT' = 'FLAT';

    for (let m15Idx = 50; m15Idx <= M15.length; m15Idx++) {
      const lastM15 = M15[m15Idx - 1];
      const scanSec = lastM15.time + 900;
      if (scanSec < split.globalStartSec || scanSec >= split.lockedForwardStartSec) continue;
      if (scanSec < busyUntilSec) continue;

      d1Idx = advanceClosedIndex(D1, d1Idx, scanSec, 86400);
      h4Idx = advanceClosedIndex(H4, h4Idx, scanSec, 14400);
      h1Idx = advanceClosedIndex(H1, h1Idx, scanSec, 3600);
      if (d1Idx < 50 || h4Idx < 50 || h1Idx < 50) continue;

      const key = `${d1Idx}:${h4Idx}:${h1Idx}`;
      if (key !== cachedKey) {
        cachedKey = key;
        const d1Dir = getEmaDir(D1.slice(Math.max(0, d1Idx - 200), d1Idx));
        const h4Dir = getEmaDir(H4.slice(Math.max(0, h4Idx - 200), h4Idx));
        const h1Dir = getEmaDir(H1.slice(Math.max(0, h1Idx - 200), h1Idx));
        cachedTrend =
          d1Dir !== 'FLAT' && d1Dir === h4Dir && h4Dir === h1Dir ? d1Dir : 'FLAT';
      }
      if (cachedTrend === 'FLAT') continue;

      const m15Slice = M15.slice(Math.max(0, m15Idx - 200), m15Idx);
      const ema21M15 = calculateEMA(
        m15Slice.map((c) => c.close),
        21
      );

      const pullbackBuy =
        cachedTrend === 'BUY' &&
        lastM15.low <= ema21M15 &&
        lastM15.close >= ema21M15 &&
        lastM15.close > lastM15.open;
      const pullbackSell =
        cachedTrend === 'SELL' &&
        lastM15.high >= ema21M15 &&
        lastM15.close <= ema21M15 &&
        lastM15.close < lastM15.open;

      if (!pullbackBuy && !pullbackSell) continue;

      const atrM15 = calculateATR(m15Slice, 14);
      const slDist = 1.5 * atrM15;
      if (!(slDist > spread.spreadPrice && slDist > 0)) continue;

      const direction = pullbackBuy ? 'BUY' : 'SELL';
      const entryPrice = lastM15.close;
      const stopLoss = direction === 'BUY' ? entryPrice - slDist : entryPrice + slDist;
      const takeProfit = direction === 'BUY' ? entryPrice + 2 * slDist : entryPrice - 2 * slDist;

      m5Idx = lowerBoundTime(M5, scanSec - 300);
      const res = resolveBracketOnM5({
        direction,
        entryTimeSec: scanSec,
        entryPrice,
        stopLoss,
        takeProfit,
        targetR: 2.0,
        spreadPrice: spread.spreadPrice,
        m5Candles: M5,
        startIdx: m5Idx,
        lockStartSec: split.lockedForwardStartSec,
      });
      if (res.status !== 'CLOSED') continue;

      const block = assignBlock(scanSec, split);
      if (!block) continue;

      busyUntilSec = res.exitTimeSec;
      trades.push({
        hypothesisId: 'H1',
        hypothesisName: name,
        block,
        symbol: asset.symbol,
        entryTimeSec: scanSec,
        exitTimeSec: res.exitTimeSec,
        entryTimeIso: new Date(scanSec * 1000).toISOString(),
        exitTimeIso: new Date(res.exitTimeSec * 1000).toISOString(),
        direction,
        entryPrice,
        stopLoss,
        takeProfit,
        exitReason: res.exitReason,
        grossR: res.grossR,
        costR: res.costR,
        netR: res.netR,
      });
    }
  }

  return trades;
}

// ----------------------------------------------------------------------------
// H2, H3, H4: Existing MT5 Engine (structure H1) with pre-registered filters
// ----------------------------------------------------------------------------
function simulateMt5FilteredHypothesis(params: {
  hypothesisId: 'H2' | 'H3' | 'H4';
  hypothesisName: string;
  histories: Map<string, Mt5SymbolHistory>;
  ratesHistory: Map<string, Candle[]>;
  split: ResearchTimeSplit;
  shouldScanAtTime: (scanSec: number, d1Closed: Candle[], asset: AssetConfig) => boolean;
}): ResearchTradeRecord[] {
  const { hypothesisId, hypothesisName, histories, ratesHistory, split, shouldScanAtTime } = params;
  const trades: ResearchTradeRecord[] = [];

  for (const hist of histories.values()) {
    const { asset, D1, H4, H1, M15, M5 } = hist;
    if (D1.length < 5 || H4.length < 15 || H1.length < 25 || M15.length < 25 || M5.length < 50) {
      continue;
    }
    const spread = resolveSpreadCostForAsset(asset);
    const firstScanSec = Math.ceil(split.globalStartSec / 1800) * 1800;

    let d1Idx = 0;
    let h4Idx = 0;
    let h1Idx = 0;
    let m15Idx = 0;
    let m5Idx = 0;
    const rateCursors = new Map<string, number>();
    let busyUntilSec = 0;

    for (let scanSec = firstScanSec; scanSec < split.lockedForwardStartSec; scanSec += 1800) {
      if (scanSec < busyUntilSec) continue;

      const d = new Date(scanSec * 1000);
      const utcDay = d.getUTCDay();
      if (utcDay === 0 || utcDay === 6) continue;

      d1Idx = advanceClosedIndex(D1, d1Idx, scanSec, 86400);
      h4Idx = advanceClosedIndex(H4, h4Idx, scanSec, 14400);
      h1Idx = advanceClosedIndex(H1, h1Idx, scanSec, 3600);
      m15Idx = advanceClosedIndex(M15, m15Idx, scanSec, 900);
      m5Idx = advanceClosedIndex(M5, m5Idx, scanSec, 300);

      if (d1Idx < 2 || h4Idx < 10 || h1Idx < 20 || m15Idx < 20 || m5Idx < 20) continue;

      const d1Slice = D1.slice(Math.max(0, d1Idx - 250), d1Idx);
      if (!shouldScanAtTime(scanSec, d1Slice, asset)) continue;

      const conversionRates = buildConversionRatesAtTime(ratesHistory, rateCursors, scanSec);

      const signal = analyzeMT5Signal({
        asset,
        platform: 'mt5',
        platformName: 'MetaTrader 5',
        d1Candles: d1Slice,
        h4Candles: H4.slice(Math.max(0, h4Idx - 250), h4Idx),
        h1Candles: H1.slice(Math.max(0, h1Idx - 250), h1Idx),
        m15Candles: M15.slice(Math.max(0, m15Idx - 250), m15Idx),
        m5Candles: M5.slice(Math.max(0, m5Idx - 250), m5Idx),
        structureTimeframe: 'H1',
        feedStatus: 'LIVE',
        accountCurrency: 'USD',
        accountBalance: MT5_ACCOUNT_BALANCE_USD,
        riskPct: MT5_RISK_PCT,
        spreadPrice: spread.spreadPrice,
        conversionRates,
        nowMs: scanSec * 1000,
      });

      if (signal.direction === 'WAIT') continue;
      if (signal.stopLoss === null || signal.takeProfit1 === null || signal.rewardRiskTp1 === null) {
        continue;
      }
      if (signal.lotSize <= 0) continue;

      const resolution = resolveMt5TradeOnM5({
        direction: signal.direction,
        orderKind: signal.orderKind,
        signalTimeSec: scanSec,
        validUntilSec: Math.min(scanSec + signal.validityMinutes * 60, split.lockedForwardStartSec),
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit1: signal.takeProfit1,
        rewardRiskTp1: signal.rewardRiskTp1,
        spreadPrice: spread.spreadPrice,
        m5Candles: M5,
        startIdx: m5Idx,
      });

      if (resolution.status === 'UNFILLED_LIMIT') {
        busyUntilSec = resolution.resolvedAtSec;
        continue;
      }
      if (resolution.status === 'INCOMPLETE_DATA') {
        continue;
      }
      if (resolution.exitTimeSec > split.lockedForwardStartSec) {
        continue;
      }

      const block = assignBlock(resolution.entryTimeSec, split);
      if (!block) continue;

      busyUntilSec = resolution.exitTimeSec;
      trades.push({
        hypothesisId,
        hypothesisName,
        block,
        symbol: asset.symbol,
        entryTimeSec: resolution.entryTimeSec,
        exitTimeSec: resolution.exitTimeSec,
        entryTimeIso: new Date(resolution.entryTimeSec * 1000).toISOString(),
        exitTimeIso: new Date(resolution.exitTimeSec * 1000).toISOString(),
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        exitReason: resolution.exitReason,
        grossR: resolution.grossR,
        costR: resolution.costR,
        netR: resolution.netR,
      });
    }
  }

  return trades;
}

// ----------------------------------------------------------------------------
// H5: Breakout with trend (close beyond PDH/PDL, H4 trend agrees, BE at 1R)
// ----------------------------------------------------------------------------
function simulateH5(
  histories: Map<string, Mt5SymbolHistory>,
  split: ResearchTimeSplit
): ResearchTradeRecord[] {
  const trades: ResearchTradeRecord[] = [];
  const name = 'Breakout with trend';

  for (const hist of histories.values()) {
    const { asset, D1, H4, H1, M5 } = hist;
    if (D1.length < 3 || H4.length < 50 || H1.length < 25 || M5.length < 20) continue;
    const spread = resolveSpreadCostForAsset(asset);

    let d1Idx = 0;
    let h4Idx = 0;
    let m5Idx = 0;
    let busyUntilSec = 0;

    for (let h1Idx = 20; h1Idx <= H1.length; h1Idx++) {
      const lastH1 = H1[h1Idx - 1];
      const prevH1 = H1[h1Idx - 2];
      const scanSec = lastH1.time + 3600;
      if (scanSec < split.globalStartSec || scanSec >= split.lockedForwardStartSec) continue;
      if (scanSec < busyUntilSec) continue;

      d1Idx = advanceClosedIndex(D1, d1Idx, scanSec, 86400);
      h4Idx = advanceClosedIndex(H4, h4Idx, scanSec, 14400);
      if (d1Idx < 1 || h4Idx < 50) continue;

      const prevDay = D1[d1Idx - 1];
      const h4Dir = getEmaDir(H4.slice(Math.max(0, h4Idx - 200), h4Idx));
      if (h4Dir === 'FLAT') continue;

      const buyBreakout =
        h4Dir === 'BUY' && lastH1.close > prevDay.high && prevH1.close <= prevDay.high;
      const sellBreakout =
        h4Dir === 'SELL' && lastH1.close < prevDay.low && prevH1.close >= prevDay.low;
      if (!buyBreakout && !sellBreakout) continue;

      const h1Slice = H1.slice(Math.max(0, h1Idx - 200), h1Idx);
      const atrH1 = calculateATR(h1Slice, 14);
      const slDist = 1.0 * atrH1;
      if (!(slDist > spread.spreadPrice && slDist > 0)) continue;

      const direction = buyBreakout ? 'BUY' : 'SELL';
      const entryPrice = lastH1.close;
      const stopLoss = direction === 'BUY' ? entryPrice - slDist : entryPrice + slDist;
      const takeProfit = direction === 'BUY' ? entryPrice + 2 * slDist : entryPrice - 2 * slDist;

      m5Idx = lowerBoundTime(M5, scanSec - 300);
      const res = resolveBracketOnM5({
        direction,
        entryTimeSec: scanSec,
        entryPrice,
        stopLoss,
        takeProfit,
        targetR: 2.0,
        breakEvenAtR: 1.0,
        spreadPrice: spread.spreadPrice,
        m5Candles: M5,
        startIdx: m5Idx,
        lockStartSec: split.lockedForwardStartSec,
      });
      if (res.status !== 'CLOSED') continue;

      const block = assignBlock(scanSec, split);
      if (!block) continue;

      busyUntilSec = res.exitTimeSec;
      trades.push({
        hypothesisId: 'H5',
        hypothesisName: name,
        block,
        symbol: asset.symbol,
        entryTimeSec: scanSec,
        exitTimeSec: res.exitTimeSec,
        entryTimeIso: new Date(scanSec * 1000).toISOString(),
        exitTimeIso: new Date(res.exitTimeSec * 1000).toISOString(),
        direction,
        entryPrice,
        stopLoss,
        takeProfit,
        exitReason: res.exitReason,
        grossR: res.grossR,
        costR: res.costR,
        netR: res.netR,
      });
    }
  }

  return trades;
}

// ----------------------------------------------------------------------------
// H6: Counter-trend mean reversion (H1 RSI<25 / >75 vs opposite D1 trend)
// ----------------------------------------------------------------------------
function simulateH6(
  histories: Map<string, Mt5SymbolHistory>,
  split: ResearchTimeSplit
): ResearchTradeRecord[] {
  const trades: ResearchTradeRecord[] = [];
  const name = 'Mean reversion';

  for (const hist of histories.values()) {
    const { asset, D1, H1, M5 } = hist;
    if (D1.length < 50 || H1.length < 25 || M5.length < 20) continue;
    const spread = resolveSpreadCostForAsset(asset);

    let d1Idx = 0;
    let m5Idx = 0;
    let busyUntilSec = 0;

    for (let h1Idx = 20; h1Idx <= H1.length; h1Idx++) {
      const lastH1 = H1[h1Idx - 1];
      const scanSec = lastH1.time + 3600;
      if (scanSec < split.globalStartSec || scanSec >= split.lockedForwardStartSec) continue;
      if (scanSec < busyUntilSec) continue;

      d1Idx = advanceClosedIndex(D1, d1Idx, scanSec, 86400);
      if (d1Idx < 50) continue;

      const d1Dir = getEmaDir(D1.slice(Math.max(0, d1Idx - 200), d1Idx));
      if (d1Dir === 'FLAT') continue;

      const h1Slice = H1.slice(Math.max(0, h1Idx - 200), h1Idx);
      const rsiH1 = calculateRSI(
        h1Slice.map((c) => c.close),
        14
      );

      // Opposite D1 trend: long when D1 is bearish & RSI < 25; short when D1 is bullish & RSI > 75
      const buyReversion = d1Dir === 'SELL' && rsiH1 < 25;
      const sellReversion = d1Dir === 'BUY' && rsiH1 > 75;
      if (!buyReversion && !sellReversion) continue;

      const atrH1 = calculateATR(h1Slice, 14);
      const slDist = 1.5 * atrH1;
      if (!(slDist > spread.spreadPrice && slDist > 0)) continue;

      const direction = buyReversion ? 'BUY' : 'SELL';
      const entryPrice = lastH1.close;
      const stopLoss = direction === 'BUY' ? entryPrice - slDist : entryPrice + slDist;
      const takeProfit = direction === 'BUY' ? entryPrice + slDist : entryPrice - slDist;

      m5Idx = lowerBoundTime(M5, scanSec - 300);
      const res = resolveBracketOnM5({
        direction,
        entryTimeSec: scanSec,
        entryPrice,
        stopLoss,
        takeProfit,
        targetR: 1.0,
        spreadPrice: spread.spreadPrice,
        m5Candles: M5,
        startIdx: m5Idx,
        lockStartSec: split.lockedForwardStartSec,
      });
      if (res.status !== 'CLOSED') continue;

      const block = assignBlock(scanSec, split);
      if (!block) continue;

      busyUntilSec = res.exitTimeSec;
      trades.push({
        hypothesisId: 'H6',
        hypothesisName: name,
        block,
        symbol: asset.symbol,
        entryTimeSec: scanSec,
        exitTimeSec: res.exitTimeSec,
        entryTimeIso: new Date(scanSec * 1000).toISOString(),
        exitTimeIso: new Date(res.exitTimeSec * 1000).toISOString(),
        direction,
        entryPrice,
        stopLoss,
        takeProfit,
        exitReason: res.exitReason,
        grossR: res.grossR,
        costR: res.costR,
        netR: res.netR,
      });
    }
  }

  return trades;
}

// ----------------------------------------------------------------------------
// H7: Daily trend following (Donchian 55-day entry / 20-day exit on D1)
// ----------------------------------------------------------------------------
function simulateH7(
  histories: Map<string, Mt5SymbolHistory>,
  split: ResearchTimeSplit
): ResearchTradeRecord[] {
  const trades: ResearchTradeRecord[] = [];
  const name = 'Daily trend following';

  for (const hist of histories.values()) {
    const { asset, D1 } = hist;
    if (isSyntheticAsset(asset) || D1.length < 57) continue;
    const spread = resolveSpreadCostForAsset(asset);

    let i = 55;
    while (i < D1.length - 1) {
      const entryBar = D1[i];
      const entryTimeSec = entryBar.time + 86400;
      if (entryTimeSec < split.globalStartSec) {
        i++;
        continue;
      }
      if (entryTimeSec >= split.lockedForwardStartSec) break;

      let high55 = -Infinity;
      let low55 = Infinity;
      for (let j = i - 55; j < i; j++) {
        if (D1[j].high > high55) high55 = D1[j].high;
        if (D1[j].low < low55) low55 = D1[j].low;
      }

      const buySignal = entryBar.close > high55;
      const sellSignal = entryBar.close < low55;
      if (!buySignal && !sellSignal) {
        i++;
        continue;
      }

      const atr20 = calculateATR(D1.slice(Math.max(0, i - 60), i + 1), 20);
      const riskUnit = 2.0 * atr20;
      if (!(riskUnit > spread.spreadPrice && riskUnit > 0)) {
        i++;
        continue;
      }

      const direction: 'BUY' | 'SELL' = buySignal ? 'BUY' : 'SELL';
      const entryPrice = entryBar.close;
      const stopLoss = direction === 'BUY' ? entryPrice - riskUnit : entryPrice + riskUnit;
      const costR = spread.spreadPrice / riskUnit;

      let exitIdx = D1.length - 1;
      let exitPrice = D1[exitIdx].close;
      let exitReason = 'BLOCK_END';
      let grossR = 0;

      for (let k = i + 1; k < D1.length; k++) {
        const bar = D1[k];
        // Initial 2*ATR stop checked FIRST
        const hitStop = direction === 'BUY' ? bar.low <= stopLoss : bar.high >= stopLoss;
        if (hitStop) {
          exitIdx = k;
          exitPrice = stopLoss;
          exitReason = 'SL';
          grossR = -1.0;
          break;
        }

        // 20-day opposing Donchian channel exit
        let low20 = Infinity;
        let high20 = -Infinity;
        for (let m = k - 20; m < k; m++) {
          if (D1[m].low < low20) low20 = D1[m].low;
          if (D1[m].high > high20) high20 = D1[m].high;
        }

        const hitChannelExit =
          direction === 'BUY' ? bar.close < low20 : bar.close > high20;
        if (hitChannelExit) {
          exitIdx = k;
          exitPrice = bar.close;
          exitReason = 'DONCHIAN_20_EXIT';
          grossR =
            (direction === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice) / riskUnit;
          break;
        }

        if (k === D1.length - 1) {
          exitIdx = k;
          exitPrice = bar.close;
          exitReason = 'BLOCK_END';
          grossR =
            (direction === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice) / riskUnit;
        }
      }

      const exitTimeSec = D1[exitIdx].time + 86400;
      const block = assignBlock(entryTimeSec, split);
      if (block && exitTimeSec <= split.lockedForwardStartSec) {
        trades.push({
          hypothesisId: 'H7',
          hypothesisName: name,
          block,
          symbol: asset.symbol,
          entryTimeSec,
          exitTimeSec,
          entryTimeIso: new Date(entryTimeSec * 1000).toISOString(),
          exitTimeIso: new Date(exitTimeSec * 1000).toISOString(),
          direction,
          entryPrice,
          stopLoss,
          takeProfit: entryPrice,
          exitReason,
          grossR,
          costR,
          netR: grossR - costR,
        });
      }

      i = exitIdx + 1;
    }
  }

  return trades;
}

// ----------------------------------------------------------------------------
// H8: Hour-of-day drift (select non-zero hours in learning 50%, test in validation 30%)
// ----------------------------------------------------------------------------
function simulateH8(
  histories: Map<string, Mt5SymbolHistory>,
  split: ResearchTimeSplit
): { trades: ResearchTradeRecord[]; selectedRules: H8SelectedHourRule[] } {
  const trades: ResearchTradeRecord[] = [];
  const selectedRules: H8SelectedHourRule[] = [];
  const name = 'Hour-of-day drift';

  for (const hist of histories.values()) {
    const { asset, H1 } = hist;
    if (H1.length < 40) continue;
    const spread = resolveSpreadCostForAsset(asset);

    // Phase 1: ONLY inspect learning block [globalStartSec, learningEndSec) to pick (symbol, hour)
    const returnsByHour: number[][] = Array.from({ length: 24 }, () => []);
    for (let i = 20; i < H1.length; i++) {
      const bar = H1[i];
      if (bar.time < split.globalStartSec) continue;
      if (bar.time + 3600 > split.learningEndSec) break;
      const priorAtr = calculateATR(H1.slice(Math.max(0, i - 60), i), 14);
      if (!(priorAtr > spread.spreadPrice && priorAtr > 0)) continue;
      const h = new Date(bar.time * 1000).getUTCHours();
      returnsByHour[h].push((bar.close - bar.open) / priorAtr);
    }

    const chosenHourDir = new Map<number, 'BUY' | 'SELL'>();
    for (let h = 0; h < 24; h++) {
      const arr = returnsByHour[h];
      if (arr.length < 20) continue;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const varSum = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0);
      const sd = Math.sqrt(varSum / (arr.length - 1));
      if (!(sd > 0)) continue;
      const tStat = mean / (sd / Math.sqrt(arr.length));
      if (Math.abs(tStat) >= 2.0) {
        const direction: 'BUY' | 'SELL' = mean > 0 ? 'BUY' : 'SELL';
        chosenHourDir.set(h, direction);
        selectedRules.push({
          symbol: asset.symbol,
          utcHour: h,
          direction,
          learningCount: arr.length,
          learningTStat: parseFloat(tStat.toFixed(3)),
        });
      }
    }

    if (chosenHourDir.size === 0) continue;

    // Phase 2: Evaluate chosen (symbol, hour) rules across learning & validation (never locked block)
    for (let i = 20; i < H1.length; i++) {
      const bar = H1[i];
      const entryTimeSec = bar.time;
      const exitTimeSec = bar.time + 3600;
      if (entryTimeSec < split.globalStartSec) continue;
      if (exitTimeSec > split.lockedForwardStartSec) break;

      const h = new Date(entryTimeSec * 1000).getUTCHours();
      const direction = chosenHourDir.get(h);
      if (!direction) continue;

      const priorAtr = calculateATR(H1.slice(Math.max(0, i - 60), i), 14);
      if (!(priorAtr > spread.spreadPrice && priorAtr > 0)) continue;

      const block = assignBlock(entryTimeSec, split);
      if (!block) continue;

      const move = direction === 'BUY' ? bar.close - bar.open : bar.open - bar.close;
      const grossR = move / priorAtr;
      const costR = spread.spreadPrice / priorAtr;
      const netR = grossR - costR;

      trades.push({
        hypothesisId: 'H8',
        hypothesisName: name,
        block,
        symbol: asset.symbol,
        entryTimeSec,
        exitTimeSec,
        entryTimeIso: new Date(entryTimeSec * 1000).toISOString(),
        exitTimeIso: new Date(exitTimeSec * 1000).toISOString(),
        direction,
        entryPrice: bar.open,
        stopLoss: direction === 'BUY' ? bar.open - priorAtr : bar.open + priorAtr,
        takeProfit: bar.close,
        exitReason: 'HOUR_CLOSE',
        grossR,
        costR,
        netR,
      });
    }
  }

  return { trades, selectedRules };
}

export function assertNoLockedForwardLeakage(
  tradesByHypothesis: Record<HypothesisId, ResearchTradeRecord[]>,
  lockedForwardStartSec: number
): void {
  for (const [id, trades] of Object.entries(tradesByHypothesis)) {
    for (const t of trades) {
      if (t.entryTimeSec >= lockedForwardStartSec || t.exitTimeSec > lockedForwardStartSec) {
        throw new Error(
          `LOCKED FORWARD BLOCK VIOLATION in ${id} (${t.symbol}): entry=${t.entryTimeIso}, exit=${t.exitTimeIso}, lockStart=${new Date(lockedForwardStartSec * 1000).toISOString()}`
        );
      }
    }
  }
}

export function runAllPreRegisteredHypotheses(params: {
  histories: Map<string, Mt5SymbolHistory>;
  m5RatesMap: Map<string, Candle[]>;
}): ResearchSimulationOutput {
  const timeSplit = computeCommonResearchTimeSplit(params.histories);
  const { truncatedHistories, truncatedRatesMap } = truncateHistoriesBeforeLock(
    params.histories,
    params.m5RatesMap,
    timeSplit.lockedForwardStartSec
  );

  const h1Trades = simulateH1(truncatedHistories, timeSplit);

  const h2Trades = simulateMt5FilteredHypothesis({
    hypothesisId: 'H2',
    hypothesisName: 'Session filter (12:00–16:00 UTC)',
    histories: truncatedHistories,
    ratesHistory: truncatedRatesMap,
    split: timeSplit,
    shouldScanAtTime: (scanSec) => {
      const hour = new Date(scanSec * 1000).getUTCHours();
      return hour >= 12 && hour < 16;
    },
  });

  const h3Trades = simulateMt5FilteredHypothesis({
    hypothesisId: 'H3',
    hypothesisName: 'News-time avoidance',
    histories: truncatedHistories,
    ratesHistory: truncatedRatesMap,
    split: timeSplit,
    shouldScanAtTime: (scanSec) => {
      const hour = new Date(scanSec * 1000).getUTCHours();
      if (hour < 7 || hour >= 21) return false;
      return !isNearFixedWeekdayReleaseUtc(scanSec, 30);
    },
  });

  const h4Trades = simulateMt5FilteredHypothesis({
    hypothesisId: 'H4',
    hypothesisName: 'Volatility regime (ATR pct 30–75)',
    histories: truncatedHistories,
    ratesHistory: truncatedRatesMap,
    split: timeSplit,
    shouldScanAtTime: (scanSec, d1Closed, asset) => {
      const hour = new Date(scanSec * 1000).getUTCHours();
      if (hour < 7 || hour >= 21) return false;
      const spec = resolveAssetPipSpec(asset);
      const vol = computeVolatilityRegime(d1Closed, spec.pipSize, 30);
      return vol.percentile30d !== null && vol.percentile30d >= 30 && vol.percentile30d <= 75;
    },
  });

  const h5Trades = simulateH5(truncatedHistories, timeSplit);
  const h6Trades = simulateH6(truncatedHistories, timeSplit);
  const h7Trades = simulateH7(truncatedHistories, timeSplit);
  const h8Result = simulateH8(truncatedHistories, timeSplit);

  const tradesByHypothesis: Record<HypothesisId, ResearchTradeRecord[]> = {
    H1: h1Trades,
    H2: h2Trades,
    H3: h3Trades,
    H4: h4Trades,
    H5: h5Trades,
    H6: h6Trades,
    H7: h7Trades,
    H8: h8Result.trades,
  };

  assertNoLockedForwardLeakage(tradesByHypothesis, timeSplit.lockedForwardStartSec);

  return {
    timeSplit,
    lockedForwardBlock: {
      startSec: timeSplit.lockedForwardStartSec,
      endSec: timeSplit.lockedForwardEndSec,
      startIso: timeSplit.lockedForwardStartIso,
      endIso: timeSplit.lockedForwardEndIso,
    },
    tradesByHypothesis,
    h8SelectedRules: h8Result.selectedRules,
    symbolsIncluded: Array.from(truncatedHistories.keys()),
  };
}
