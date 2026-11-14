/**
 * scripts/stress-binary.ts  — run: npx tsx scripts/stress-binary.ts
 * Feeds 14h of simulated ticks (no-edge random walk vs. an artificial persistent trend) through
 * analyzeBinarySignal and checks the outcome at expiry. Purpose: catch an engine that invents edge
 * or labels noise as 'High'. Not a performance claim: real validation is the Stage 4 walk-forward backtest.
 */
import { analyzeBinarySignal } from '../src/utils/engines/binaryEngine.ts';
import type { AssetConfig, TimestampedTick } from '../src/types.ts';
import type { Candle } from '../src/services/liveFeed.ts';

const EURUSD_BENCHMARK: AssetConfig = {
  symbol: 'frxEURUSD',
  name: 'EUR/USD',
  type: 'FOREX',
  decimals: 5,
  pipSize: 0.0001,
};

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function market(kind: 'random' | 'trend', seed: number, n: number, t0: number): TimestampedTick[] {
  const r = rng(seed);
  let p = 500;
  let d = 0;
  const ticks: TimestampedTick[] = [];
  for (let i = 0; i < n; i++) {
    if (kind === 'trend') {
      d = 0.995 * d + 0.00002 * gauss(r);
    }
    p *= 1 + d + 0.0004 * gauss(r);
    ticks.push({ time: t0 + i, price: +p.toFixed(4) });
  }
  return ticks;
}

function candles(ticks: TimestampedTick[], sec: number, upTo: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const t of ticks) {
    if (t.time > upTo) break;
    const k = Math.floor(t.time / sec) * sec;
    const c = m.get(k);
    if (!c) {
      m.set(k, { time: k, open: t.price, high: t.price, low: t.price, close: t.price });
    } else {
      c.high = Math.max(c.high, t.price);
      c.low = Math.min(c.low, t.price);
      c.close = t.price;
    }
  }
  return [...m.values()];
}

function run(kind: 'random' | 'trend', seed: number, asset: AssetConfig) {
  const t0 = Math.floor(Date.UTC(2026, 7, 12, 0, 0, 0) / 1000);
  const N = 14 * 3600;
  const ticks = market(kind, seed, N, t0);
  let calls = 0;
  let waits = 0;
  let win = 0;
  let loss = 0;
  const str: Record<'Low' | 'Medium' | 'High', number> = { Low: 0, Medium: 0, High: 0 };
  const hiWin = { w: 0, n: 0 };

  for (let t = t0 + 5 * 3600; t < t0 + N - 400; t += 15) {
    const idx = t - t0;
    const past = ticks.slice(Math.max(0, idx - 20000), idx + 1);
    const m1 = candles(past, 60, t).slice(-120);
    const m5 = candles(past, 300, t).slice(-80);
    const m15 = candles(past, 900, t).slice(-60);

    const res = analyzeBinarySignal({
      asset,
      platform: 'deriv',
      m1Candles: m1,
      m5Candles: m5,
      m15Candles: m15,
      ticks: past.slice(-120),
      feedStatus: 'LIVE',
      payoutPct: 85,
      nowMs: t * 1000,
    });

    if (res.direction === 'WAIT') {
      waits++;
      const k = String(res.whyNotTrade || '').replace(/[0-9.]+/g, '#').slice(0, 80);
      const WH = ((globalThis as Record<string, unknown>).WH || {}) as Record<string, number>;
      WH[k] = (WH[k] || 0) + 1;
      (globalThis as Record<string, unknown>).WH = WH;
      continue;
    }

    calls++;
    str[res.strength]++;
    const entry = ticks[idx].price;
    const exit = ticks[Math.min(N - 1, idx + res.expirySeconds)].price;
    const w = res.direction === 'CALL' ? exit > entry : exit < entry;
    if (exit !== entry) {
      if (w) win++;
      else loss++;
    }
    if (res.strength === 'High') {
      hiWin.n++;
      if (w) hiWin.w++;
    }
  }

  const dec = win + loss;
  const wr = dec ? (100 * win) / dec : NaN;
  const se = dec ? 100 * Math.sqrt(0.25 / dec) : NaN;
  console.log(
    `${kind.padEnd(6)} seed ${seed}: signals=${calls} waits=${waits} (WAIT ${((100 * waits) / (waits + calls)).toFixed(0)}%)  strength=${JSON.stringify(str)}  decided=${dec} winrate=${wr.toFixed(1)}% (±${(1.96 * se).toFixed(1)} at 95%)  break-even 54.05%  | High-only: ${hiWin.n ? ((100 * hiWin.w) / hiWin.n).toFixed(1) : 'n/a'}% of ${hiWin.n}`
  );
}

for (const s of [1, 2, 3]) run('random', s, EURUSD_BENCHMARK);
for (const s of [1, 2, 3]) run('trend', s, EURUSD_BENCHMARK);

console.log('\nWAIT reasons (all runs):');
console.log(JSON.stringify((globalThis as Record<string, unknown>).WH, null, 1));
console.log(
  '\nHOW TO READ THIS: on the RANDOM markets no method can win more than ~50%; the share of signals labelled High there should be small (<10%). The TREND market is an artificial, unrealistically persistent trend and its win rate must NOT be quoted as real performance.'
);
