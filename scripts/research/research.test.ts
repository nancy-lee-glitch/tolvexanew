/**
 * scripts/research/research.test.ts — Verification Tests for Stage R1 Research Harness
 */

import { strict as assert } from 'node:assert';
import {
  BONFERRONI_ALPHA,
  computeHypothesisBlockStats,
  evaluateSurvival,
  splitTimeRange,
  studentTOneSidedCritical,
  studentTOneSidedPValue,
} from './stats.ts';
import {
  assertNoLockedForwardLeakage,
  runAllPreRegisteredHypotheses,
} from './simulator.ts';
import { buildResearchMarkdownReport, buildResearchSummaries, buildResearchTradesCsv } from './report.ts';
import type { Candle } from '../../src/utils/engines/types.ts';
import type { Mt5SymbolHistory } from '../backtest-real.ts';

function makeSyntheticCandles(
  startSec: number,
  stepSec: number,
  count: number,
  driftPerBar = 0.0001
): Candle[] {
  const out: Candle[] = [];
  let price = 1.1;
  for (let i = 0; i < count; i++) {
    const t = startSec + i * stepSec;
    const open = price;
    const wave = Math.sin(i * 0.35) * 0.0012 + driftPerBar;
    const close = Math.max(0.5, open + wave);
    const high = Math.max(open, close) + 0.0008;
    const low = Math.min(open, close) - 0.0008;
    out.push({ time: t, open, high, low, close });
    price = close;
  }
  return out;
}

// 1. Time split 50 / 30 / 20 locked proportions
{
  const start = Date.UTC(2025, 0, 1) / 1000;
  const end = start + 100 * 86400;
  const split = splitTimeRange(start, end);
  assert.equal(Math.round(split.learningDays), 50);
  assert.equal(Math.round(split.validationDays), 30);
  assert.equal(Math.round(split.lockedForwardDays), 20);
  assert.equal(split.lockedForwardStartSec, split.validationEndSec);
}

// 2. Student-t p-value & critical value sanity against exact values
{
  // df=10, t=2.228 -> one-sided p ≈ 0.025
  const p10 = studentTOneSidedPValue(2.22814, 10);
  assert.ok(Math.abs(p10 - 0.025) < 0.0005, `Expected ~0.025, got ${p10}`);
  // df=120, one-sided alpha=0.00625 -> tCrit ≈ 2.536
  const crit = studentTOneSidedCritical(120, BONFERRONI_ALPHA);
  assert.ok(crit > 2.48 && crit < 2.60, `Expected ~2.536, got ${crit}`);
}

// 3. Survival criteria: all 5 gates enforced
{
  const goodR = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? -1.0 : 1.5)); // avg = +0.667R
  const learnGood = computeHypothesisBlockStats(goodR, 8);
  const valGood = computeHypothesisBlockStats(goodR, 8);
  const surv = evaluateSurvival({ learning: learnGood, validation: valGood });
  assert.equal(surv.verdict, 'SURVIVES');

  // Fails if < 100 validation trades
  const valTooFew = computeHypothesisBlockStats(goodR.slice(0, 99), 8);
  const failCount = evaluateSurvival({ learning: learnGood, validation: valTooFew });
  assert.equal(failCount.verdict, 'DOES NOT SURVIVE');
  assert.ok(failCount.failureReasons.some((r) => r.includes('only 99 validation trades')));

  // Fails if learning avgR < 0
  const learnNeg = computeHypothesisBlockStats([-1, -1, 0.5, -1], 8);
  const failLearn = evaluateSurvival({ learning: learnNeg, validation: valGood });
  assert.equal(failLearn.verdict, 'DOES NOT SURVIVE');
  assert.ok(failLearn.failureReasons.some((r) => r.includes('learning block average R is negative')));
}

// 4. Locked forward block assertion catches leakage
{
  assert.throws(() => {
    assertNoLockedForwardLeakage(
      {
        H1: [
          {
            hypothesisId: 'H1',
            hypothesisName: 'Test',
            block: 'validation',
            symbol: 'frxEURUSD',
            entryTimeSec: 1000,
            exitTimeSec: 2000,
            entryTimeIso: 'x',
            exitTimeIso: 'y',
            direction: 'BUY',
            entryPrice: 1.1,
            stopLoss: 1.09,
            takeProfit: 1.12,
            exitReason: 'TP',
            grossR: 2,
            costR: 0.1,
            netR: 1.9,
          },
        ],
        H2: [],
        H3: [],
        H4: [],
        H5: [],
        H6: [],
        H7: [],
        H8: [],
      },
      1500
    );
  }, /LOCKED FORWARD BLOCK VIOLATION/);
}

// 5. End-to-end simulation on deterministic synthetic candles never leaks locked 20% & builds valid report
{
  const start = Date.UTC(2025, 0, 1) / 1000;
  const days = 120;
  const asset = {
    symbol: 'frxEURUSD',
    name: 'EUR/USD',
    type: 'FOREX' as const,
    decimals: 5,
    pipSize: 0.0001,
    tickSize: 0.00001,
    distanceUnit: 'pips' as const,
  };
  const D1 = makeSyntheticCandles(start, 86400, days);
  const H4 = makeSyntheticCandles(start, 14400, days * 6);
  const H1 = makeSyntheticCandles(start, 3600, days * 24);
  const M15 = makeSyntheticCandles(start, 900, days * 96);
  const M5 = makeSyntheticCandles(start, 300, days * 288);

  const histories = new Map<string, Mt5SymbolHistory>([
    ['frxEURUSD', { asset, D1, H4, H1, M15, M5 }],
  ]);
  const m5RatesMap = new Map<string, Candle[]>([['frxEURUSD', M5]]);
  const sim = runAllPreRegisteredHypotheses({ histories, m5RatesMap });
  const summaries = buildResearchSummaries(sim);
  const md = buildResearchMarkdownReport({
    generatedAtIso: new Date().toISOString(),
    sim,
    summaries,
  });
  const csv = buildResearchTradesCsv(sim);

  assert.ok(md.includes('These results are historical and do not predict future performance.'));
  assert.ok(md.includes('covers only about one year'));
  assert.ok(md.includes('## Ideas for a future pre-registered round'));
  assert.ok(!/\baccuracy\b/i.test(md));
  assert.ok(!/probability of winning/i.test(md));
  assert.ok(csv.startsWith('hypothesis_id,hypothesis_name,block,symbol,'));
}

console.log('PASS: All Stage R1 research harness tests passed.');
