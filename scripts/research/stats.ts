/**
 * scripts/research/stats.ts — Statistical Testing, Time Splitting, Power & Survival Criteria
 *
 * Implements:
 *  - Chronological 50% Learning / 30% Validation / 20% LOCKED Forward split
 *  - Exact Student-t 95% confidence intervals and one-sided p-values for H0: mean R <= 0
 *  - Bonferroni multiple-testing threshold (alpha = 0.05 / 8 = 0.00625)
 *  - Minimum Detectable Average R (80% statistical power)
 *  - Pre-registered 5-part survival decision rule
 */

export const NUM_HYPOTHESES = 8;
export const FAMILY_ALPHA = 0.05;
export const BONFERRONI_ALPHA = FAMILY_ALPHA / NUM_HYPOTHESES; // 0.00625
export const MIN_VALIDATION_TRADES = 100;
export const TARGET_POWER = 0.80;
export const Z_BETA_80 = 0.8416212335729143; // Phi^-1(0.80)

export interface ResearchTimeSplit {
  globalStartSec: number;
  learningEndSec: number;
  validationEndSec: number;
  lockedForwardStartSec: number;
  lockedForwardEndSec: number;
  globalStartIso: string;
  learningEndIso: string;
  validationEndIso: string;
  lockedForwardStartIso: string;
  lockedForwardEndIso: string;
  totalDays: number;
  learningDays: number;
  validationDays: number;
  lockedForwardDays: number;
}

export function splitTimeRange(globalStartSec: number, globalEndSec: number): ResearchTimeSplit {
  if (!(globalEndSec > globalStartSec)) {
    throw new Error(`Invalid date range: start=${globalStartSec}, end=${globalEndSec}`);
  }
  const span = globalEndSec - globalStartSec;
  const learningEndSec = Math.floor(globalStartSec + 0.5 * span);
  const validationEndSec = Math.floor(globalStartSec + 0.8 * span);

  return {
    globalStartSec,
    learningEndSec,
    validationEndSec,
    lockedForwardStartSec: validationEndSec,
    lockedForwardEndSec: globalEndSec,
    globalStartIso: new Date(globalStartSec * 1000).toISOString(),
    learningEndIso: new Date(learningEndSec * 1000).toISOString(),
    validationEndIso: new Date(validationEndSec * 1000).toISOString(),
    lockedForwardStartIso: new Date(validationEndSec * 1000).toISOString(),
    lockedForwardEndIso: new Date(globalEndSec * 1000).toISOString(),
    totalDays: span / 86400,
    learningDays: (learningEndSec - globalStartSec) / 86400,
    validationDays: (validationEndSec - learningEndSec) / 86400,
    lockedForwardDays: (globalEndSec - validationEndSec) / 86400,
  };
}

// Lanczos approximation for ln(Gamma(z))
function lnGamma(z: number): number {
  const cof = [
    76.18009172947146,
    -86.50532032941677,
    24.01409824083091,
    -1.231739572450155,
    0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Continued fraction for incomplete beta I_x(a, b)
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-12;
  const fpMin = 1e-30;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Exact one-sided p-value P(T_df >= t) for Student's t distribution.
 */
export function studentTOneSidedPValue(tStat: number, df: number): number {
  if (!Number.isFinite(tStat) || !Number.isFinite(df) || df < 1) return 1;
  if (tStat === 0) return 0.5;
  const x = df / (df + tStat * tStat);
  const twoSided = Math.min(1, Math.max(0, regularizedIncompleteBeta(df / 2, 0.5, x)));
  return tStat > 0 ? twoSided / 2 : 1 - twoSided / 2;
}

/**
 * Exact upper critical value t* such that P(T_df >= t*) = oneSidedAlpha.
 */
export function studentTOneSidedCritical(df: number, oneSidedAlpha: number): number {
  if (!Number.isFinite(df) || df < 1) return 2.5;
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = studentTOneSidedPValue(mid, df);
    if (p > oneSidedAlpha) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export interface HypothesisBlockStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgR: number;
  totalR: number;
  sdR: number | null;
  seR: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  ci95LowR: number | null;
  ci95HighR: number | null;
  tStat: number | null;
  pValueOneSided: number | null;
  passesBonferroni: boolean;
  minDetectableAvgR80Bonf: number | null;
  minDetectableAvgR80Uncorr: number | null;
}

export function computeHypothesisBlockStats(
  rValues: number[],
  numHypotheses = NUM_HYPOTHESES
): HypothesisBlockStats {
  const n = rValues.length;
  if (n === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      avgR: 0,
      totalR: 0,
      sdR: null,
      seR: null,
      maxDrawdownR: 0,
      longestLosingStreak: 0,
      ci95LowR: null,
      ci95HighR: null,
      tStat: null,
      pValueOneSided: null,
      passesBonferroni: false,
      minDetectableAvgR80Bonf: null,
      minDetectableAvgR80Uncorr: null,
    };
  }

  let wins = 0;
  let totalR = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let streak = 0;
  let longestLosingStreak = 0;

  for (const r of rValues) {
    totalR += r;
    if (r > 0) {
      wins++;
      streak = 0;
    } else {
      streak++;
      if (streak > longestLosingStreak) longestLosingStreak = streak;
    }
    cumR += r;
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  const avgR = totalR / n;
  const winRatePct = parseFloat(((wins / n) * 100).toFixed(2));

  if (n < 2) {
    return {
      trades: n,
      wins,
      losses: n - wins,
      winRatePct,
      avgR,
      totalR,
      sdR: null,
      seR: null,
      maxDrawdownR,
      longestLosingStreak,
      ci95LowR: null,
      ci95HighR: null,
      tStat: null,
      pValueOneSided: null,
      passesBonferroni: false,
      minDetectableAvgR80Bonf: null,
      minDetectableAvgR80Uncorr: null,
    };
  }

  let sqDiff = 0;
  for (const r of rValues) {
    sqDiff += (r - avgR) * (r - avgR);
  }
  const sdR = Math.sqrt(sqDiff / (n - 1));
  const seR = sdR / Math.sqrt(n);
  const df = n - 1;

  const t95TwoSided = studentTOneSidedCritical(df, 0.025);
  const ci95LowR = avgR - t95TwoSided * seR;
  const ci95HighR = avgR + t95TwoSided * seR;

  let tStat: number | null = null;
  let pValueOneSided: number | null = null;
  if (seR > 0) {
    tStat = avgR / seR;
    pValueOneSided = studentTOneSidedPValue(tStat, df);
  } else if (avgR > 0) {
    tStat = Infinity;
    pValueOneSided = 0;
  } else {
    tStat = avgR < 0 ? -Infinity : 0;
    pValueOneSided = avgR < 0 ? 1 : 0.5;
  }

  const bonfAlpha = FAMILY_ALPHA / Math.max(1, numHypotheses);
  const passesBonferroni = pValueOneSided !== null && pValueOneSided < bonfAlpha;

  const tCritBonf = studentTOneSidedCritical(df, bonfAlpha);
  const tCritUncorr = studentTOneSidedCritical(df, FAMILY_ALPHA);
  const minDetectableAvgR80Bonf = seR > 0 ? (tCritBonf + Z_BETA_80) * seR : null;
  const minDetectableAvgR80Uncorr = seR > 0 ? (tCritUncorr + Z_BETA_80) * seR : null;

  return {
    trades: n,
    wins,
    losses: n - wins,
    winRatePct,
    avgR,
    totalR,
    sdR,
    seR,
    maxDrawdownR,
    longestLosingStreak,
    ci95LowR,
    ci95HighR,
    tStat,
    pValueOneSided,
    passesBonferroni,
    minDetectableAvgR80Bonf,
    minDetectableAvgR80Uncorr,
  };
}

export interface SurvivalEvaluation {
  verdict: 'SURVIVES' | 'DOES NOT SURVIVE';
  failureReasons: string[];
}

export function evaluateSurvival(params: {
  learning: HypothesisBlockStats;
  validation: HypothesisBlockStats;
  minValidationTrades?: number;
  numHypotheses?: number;
}): SurvivalEvaluation {
  const minTrades = params.minValidationTrades ?? MIN_VALIDATION_TRADES;
  const bonfAlpha = FAMILY_ALPHA / (params.numHypotheses ?? NUM_HYPOTHESES);
  const { learning, validation } = params;
  const failureReasons: string[] = [];

  if (validation.trades < minTrades) {
    failureReasons.push(
      `only ${validation.trades} validation trades (requires at least ${minTrades})`
    );
  }
  if (!(validation.avgR > 0)) {
    failureReasons.push(
      `validation average R after costs is ${validation.avgR >= 0 ? 'zero' : 'negative'} (${validation.avgR.toFixed(4)}R)`
    );
  }
  if (validation.ci95LowR === null || !(validation.ci95LowR > 0)) {
    const ciStr =
      validation.ci95LowR !== null && validation.ci95HighR !== null
        ? `[${validation.ci95LowR.toFixed(4)}R, ${validation.ci95HighR.toFixed(4)}R]`
        : 'N/A';
    failureReasons.push(`95% confidence interval does not stay strictly above 0 (${ciStr})`);
  }
  if (validation.pValueOneSided === null || !(validation.pValueOneSided < bonfAlpha)) {
    const pStr =
      validation.pValueOneSided !== null ? validation.pValueOneSided.toFixed(5) : 'N/A';
    failureReasons.push(
      `Bonferroni-corrected p-value failed (p=${pStr}, threshold < ${bonfAlpha.toFixed(5)})`
    );
  }
  if (learning.trades === 0) {
    failureReasons.push('learning block had 0 trades');
  } else if (learning.avgR < 0) {
    failureReasons.push(
      `learning block average R is negative (${learning.avgR.toFixed(4)}R)`
    );
  }

  return {
    verdict: failureReasons.length === 0 ? 'SURVIVES' : 'DOES NOT SURVIVE',
    failureReasons,
  };
}
