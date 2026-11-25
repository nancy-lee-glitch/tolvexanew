/**
 * scripts/research/hypotheses.ts — Stage R1 Pre-Registered Strategy Hypotheses
 *
 * IMPORTANT: All 8 hypotheses and their exact parameters are declared here BEFORE
 * any simulation result is computed. Parameters are FIXED (no grid search, no tuning).
 */

export type HypothesisId = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8';

export interface PreRegisteredHypothesis {
  id: HypothesisId;
  shortName: string;
  description: string;
  parameters: Record<string, string | number | readonly number[]>;
  decisionCadenceSec: number;
  maxHoldNote: string;
}

export const PRE_REGISTERED_HYPOTHESES: readonly PreRegisteredHypothesis[] = [
  {
    id: 'H1',
    shortName: 'Trend alignment (D1/H4/H1 EMA21>EMA50 + M15 pullback)',
    description:
      'Trade only when D1, H4, and H1 EMA(21) vs EMA(50) all agree; enter on an M15 candle pullback touching M15 EMA(21) and closing in trend direction; stop 1.5 x ATR(14) on M15; target 2R.',
    parameters: {
      emaFast: 21,
      emaSlow: 50,
      atrPeriod: 14,
      atrTimeframe: 'M15',
      stopAtrMult: 1.5,
      targetR: 2.0,
      maxHoldHours: 48,
    },
    decisionCadenceSec: 900,
    maxHoldNote: '48h max hold',
  },
  {
    id: 'H2',
    shortName: 'Session filter (MT5 H1 engine, 12:00–16:00 UTC)',
    description:
      'Existing MT5 engine signals (analyzeMT5Signal, structure H1) taken only between 12:00 and 16:00 UTC on weekdays.',
    parameters: {
      structureTimeframe: 'H1',
      utcHourStartInclusive: 12,
      utcHourEndExclusive: 16,
      scanStepSec: 1800,
      maxHoldHours: 48,
    },
    decisionCadenceSec: 1800,
    maxHoldNote: '48h max hold',
  },
  {
    id: 'H3',
    shortName: 'News-time avoidance (MT5 H1 engine skipping fixed release windows)',
    description:
      'Existing MT5 engine signals (analyzeMT5Signal, structure H1) skipping +/- 30 minutes around 12:30, 13:30, 14:00, and 18:00 UTC on weekdays.',
    parameters: {
      structureTimeframe: 'H1',
      releaseTimesUtcMinutes: [12 * 60 + 30, 13 * 60 + 30, 14 * 60, 18 * 60] as const,
      avoidRadiusMinutes: 30,
      weekdayHourStart: 7,
      weekdayHourEndExclusive: 21,
      scanStepSec: 1800,
      maxHoldHours: 48,
    },
    decisionCadenceSec: 1800,
    maxHoldNote: '48h max hold',
  },
  {
    id: 'H4',
    shortName: 'Volatility regime filter (MT5 H1 engine, 30d ATR pct 30–75)',
    description:
      'Existing MT5 engine signals (analyzeMT5Signal, structure H1) taken only when trailing 30-day D1 ATR(14) percentile is between 30 and 75 inclusive.',
    parameters: {
      structureTimeframe: 'H1',
      atrLookbackDays: 30,
      minAtrPercentile: 30,
      maxAtrPercentile: 75,
      weekdayHourStart: 7,
      weekdayHourEndExclusive: 21,
      scanStepSec: 1800,
      maxHoldHours: 48,
    },
    decisionCadenceSec: 1800,
    maxHoldNote: '48h max hold',
  },
  {
    id: 'H5',
    shortName: 'Breakout with trend (PDH/PDL close + H4 EMA21/50 + BE at 1R)',
    description:
      'H1 close beyond previous closed day high or low with H4 EMA(21) vs EMA(50) agreeing; stop 1.0 x ATR(14) on H1; target 2R; move stop to break-even once +1R is reached.',
    parameters: {
      h4EmaFast: 21,
      h4EmaSlow: 50,
      atrPeriod: 14,
      atrTimeframe: 'H1',
      stopAtrMult: 1.0,
      breakEvenAtR: 1.0,
      targetR: 2.0,
      maxHoldHours: 48,
    },
    decisionCadenceSec: 3600,
    maxHoldNote: '48h max hold',
  },
  {
    id: 'H6',
    shortName: 'Counter-trend mean reversion (H1 RSI25/75 vs opposite D1 trend)',
    description:
      'H1 RSI(14) below 25 (long) when D1 EMA(21) < EMA(50), or above 75 (short) when D1 EMA(21) > EMA(50); stop 1.5 x ATR(14) on H1; target 1R.',
    parameters: {
      rsiPeriod: 14,
      rsiOversold: 25,
      rsiOverbought: 75,
      d1EmaFast: 21,
      d1EmaSlow: 50,
      atrPeriod: 14,
      atrTimeframe: 'H1',
      stopAtrMult: 1.5,
      targetR: 1.0,
      maxHoldHours: 48,
    },
    decisionCadenceSec: 3600,
    maxHoldNote: '48h max hold',
  },
  {
    id: 'H7',
    shortName: 'Daily trend following (Donchian 55-day entry / 20-day exit on D1)',
    description:
      'Classic slow Donchian 55-day breakout entry and 20-day opposing-channel exit on D1 for all non-synthetic symbols, equal risk per trade (1R = 2 x ATR(20) on D1).',
    parameters: {
      entryChannelDays: 55,
      exitChannelDays: 20,
      atrPeriod: 20,
      initialStopAtrMult: 2.0,
    },
    decisionCadenceSec: 86400,
    maxHoldNote: 'Held until 20-day D1 exit or 2xATR(20) initial stop (or block end)',
  },
  {
    id: 'H8',
    shortName: 'Hour-of-day drift (select non-zero UTC hours in learning, test in validation)',
    description:
      'For each symbol and UTC hour (00–23), test in learning block (first 50%) whether 1-hour return is statistically non-zero (|t| >= 2.0, n >= 20); hold matching direction for 1 hour in validation.',
    parameters: {
      minLearningObsPerHour: 20,
      learningSelectMinAbsT: 2.0,
      holdHours: 1,
      atrNormalizationPeriod: 14,
    },
    decisionCadenceSec: 3600,
    maxHoldNote: '1h fixed hold (open to close of H1 bar)',
  },
] as const;

export const H3_RELEASE_MINUTES_UTC: readonly number[] = [
  12 * 60 + 30, // 12:30 UTC
  13 * 60 + 30, // 13:30 UTC
  14 * 60 + 0,  // 14:00 UTC
  18 * 60 + 0,  // 18:00 UTC
];

export function isNearFixedWeekdayReleaseUtc(epochSec: number, radiusMinutes = 30): boolean {
  const d = new Date(epochSec * 1000);
  const utcDay = d.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false;
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const relMin of H3_RELEASE_MINUTES_UTC) {
    if (Math.abs(minuteOfDay - relMin) <= radiusMinutes) {
      return true;
    }
  }
  return false;
}
