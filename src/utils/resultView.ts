/**
 * resultView.ts — Pure presentation view-model builder for Binary & MT5 scan results
 * and Market Context 3-line summary (Stage 4H-B).
 *
 * Principle (Steve Krug): one answer first, details on demand.
 * Zero DOM dependencies, zero engine logic changes, 100% unit-testable.
 */

import type {
  AnalysisMode,
  AnalysisProfile,
  DistanceUnit,
  SignalData,
  SignalStrength,
} from '../types.ts';
import type {
  BinarySignalOutput,
  MT5SignalOutput,
} from './engines/types.ts';
import type {
  KeyLevelMapItem,
  MarketContextSummary,
  UtcSessionHourBucket,
} from './engines/marketContext.ts';
import { formatDistanceUnitWord } from './instrumentMeta.ts';
import { calculateBreakEvenWinRate } from './engines/binaryEngine.ts';

export type ResultSignalInput = SignalData | BinarySignalOutput | MT5SignalOutput;

export type ResultSectionType =
  | 'blocked'
  | 'verdict'
  | 'reason'
  | 'next_check'
  | 'key_facts'
  | 'order_ticket'
  | 'validity'
  | 'why'
  | 'strength'
  | 'breakeven'
  | 'risk'
  | 'more_details';

export interface ResultStrengthChip {
  label: string;
  strength: SignalStrength;
}

export interface BinaryResultView {
  kind: 'BINARY';
  profile: 'BINARY_QUICK';
  direction: 'CALL' | 'PUT';
  sections: ResultSectionType[];
  verdict: {
    badge: 'CALL ▲' | 'PUT ▼';
    plainSentence: string;
  };
  keyFacts: {
    expiryLabel: string;
    expiryRaw: string;
    enterWithinSeconds: number;
    suggestedStakeUsd: number;
  };
  whyBullets: [string, string, string];
  strengthChip: ResultStrengthChip;
  breakEvenLine: string;
  payoutPct: number;
  breakEvenWinRatePct: number;
  riskLine: string;
  moreDetails: {
    defaultOpen: false;
    entryPrice: number;
  };
}

export interface MT5OrderTicket {
  orderType: 'BUY' | 'SELL';
  orderKind: 'MARKET' | 'LIMIT';
  entryText: string;
  entryPrice: number;
  entryZone: { min: number; max: number } | null;
  stopLossPriceText: string;
  stopLossPrice: number;
  stopLossDistanceText: string;
  tp1PriceText: string;
  tp1Price: number;
  tp1DistanceText: string;
  tp2PriceText: string;
  tp2Price: number;
  tp2DistanceText: string;
  lotSize: number;
  lotSizeText: string;
  riskMoney: number;
  accountCurrency: string;
  riskMoneyText: string;
  rewardRiskText: string;
  rewardRiskTp1: number;
  rewardRiskTp2: number;
  primaryButtonLabel: 'Copy order';
  copyOrderText: string;
}

export interface MT5ResultView {
  kind: 'MT5';
  profile: 'MT5';
  direction: 'BUY' | 'SELL';
  orderKind: 'MARKET' | 'LIMIT';
  sections: ResultSectionType[];
  verdict: {
    badge: string;
    plainSentence: string;
  };
  orderTicket: MT5OrderTicket;
  validityLine: string;
  validityMinutesLeft: number;
  whyBullets: [string, string, string];
  strengthChip: ResultStrengthChip;
  moreDetails: {
    defaultOpen: false;
    needsAtLeastWinRateLine: string;
    tradeManagement: string;
    spreadAndSessionNotes: string;
    invalidationRule: string;
    accountSizingWarning?: string;
  };
}

export interface WaitResultView {
  kind: 'WAIT';
  profile: AnalysisProfile;
  direction: 'WAIT';
  sections: ['verdict', 'reason', 'next_check'];
  verdict: {
    badge: 'WAIT ✋';
  };
  reason: string;
  checkAgainMinutes: number;
  checkAgainText: string;
  strengthChip: null;
  moreDetails: null;
}

export interface BlockedResultView {
  kind: 'BLOCKED';
  profile: AnalysisProfile;
  direction: 'WAIT';
  sections: ['blocked'];
  blockedReason: string;
  plainLanguageReason: string;
  strengthChip: null;
  moreDetails: null;
}

export type ResultViewModel =
  | BinaryResultView
  | MT5ResultView
  | WaitResultView
  | BlockedResultView;

export interface BuildResultViewOptions {
  binaryBalance?: number;
  binaryRiskPct?: number;
  brokerPayoutPct?: number;
  nowMs?: number;
  decimals?: number;
  distanceUnit?: DistanceUnit;
}

export interface MarketContextThreeLineSummary {
  trendLine: string;
  volatilityLine: string;
  levelsLine: string;
}

export function normalizeAnalysisProfile(
  profileOrMode: AnalysisProfile | AnalysisMode
): AnalysisProfile {
  return profileOrMode === 'MT5' || profileOrMode === 'mt5' ? 'MT5' : 'BINARY_QUICK';
}

export function truncateBullet(text: string, maxLen = 90): string {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  const slice = cleaned.slice(0, maxLen - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cutoff = lastSpace >= Math.floor(maxLen * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${cutoff.replace(/[.,;:\s]+$/, '')}\u2026`;
}

export function getTimeframePeriodSeconds(tfOrExpiry: string | undefined): number {
  const norm = String(tfOrExpiry || '').trim().toLowerCase();
  if (norm === '1m') return 60;
  if (norm === '2m') return 120;
  if (norm === '3m') return 180;
  if (norm === '5m') return 300;
  if (norm === '15m' || norm === 'm15') return 900;
  if (norm === '30m' || norm === 'm30') return 1800;
  if (norm === '1h' || norm === 'h1') return 3600;
  if (norm === '4h' || norm === 'h4') return 14400;
  if (norm === '1d' || norm === 'd1') return 86400;
  return 180;
}

export function computeNextCandleCloseMinutes(
  tfOrExpiry: string | undefined,
  nowMs: number = Date.now()
): number {
  const periodSec = getTimeframePeriodSeconds(tfOrExpiry);
  const nowSec = Math.floor(nowMs / 1000);
  const remSec = periodSec - (nowSec % periodSec);
  return Math.max(1, Math.ceil(remSec / 60));
}

function formatExpiryDurationPhrase(expiryRaw: string): string {
  const norm = expiryRaw.toLowerCase();
  if (norm === '1m') return '1 minute';
  if (norm === '2m') return '2 minutes';
  if (norm === '3m') return '3 minutes';
  if (norm === '5m') return '5 minutes';
  return norm || 'next expiry';
}

function formatExpiryTileLabel(expiryRaw: string): string {
  const norm = expiryRaw.toLowerCase();
  if (norm === '1m') return '1 MIN';
  if (norm === '2m') return '2 MIN';
  if (norm === '3m') return '3 MIN';
  if (norm === '5m') return '5 MIN';
  return norm.toUpperCase();
}

function normalizeWhyBullets(
  rawReasons: readonly string[] | undefined,
  fallbacks: [string, string, string],
  maxLen = 90
): [string, string, string] {
  const cleaned = (rawReasons || [])
    .map((r) => truncateBullet(r, maxLen))
    .filter(Boolean);

  const out: string[] = [];
  for (const item of cleaned) {
    if (out.length >= 3) break;
    if (!out.includes(item)) out.push(item);
  }
  for (const fb of fallbacks) {
    if (out.length >= 3) break;
    const t = truncateBullet(fb, maxLen);
    if (t && !out.includes(t)) out.push(t);
  }
  while (out.length < 3) {
    out.push(truncateBullet(fallbacks[out.length % fallbacks.length], maxLen));
  }
  return [out[0], out[1], out[2]];
}

function hasHigherTimeframeBiasMention(text: string): boolean {
  return /\b(d1|h4|daily|4-hour|higher[- ]timeframe|htf|bias)\b/i.test(text);
}

function buildMt5WhyBullets(
  signal: ResultSignalInput,
  direction: 'BUY' | 'SELL'
): [string, string, string] {
  const rawReasons = Array.isArray(signal.reasons) ? signal.reasons.filter(Boolean) : [];
  const snap = (signal.inputsSnapshot || {}) as Record<string, unknown>;
  const d1Bias = typeof snap.d1Bias === 'string' ? snap.d1Bias : null;
  const h4Bias = typeof snap.h4Bias === 'string' ? snap.h4Bias : null;
  const biasWord = direction === 'BUY' ? 'bullish' : 'bearish';

  const htfFallback =
    d1Bias && h4Bias
      ? `Higher-timeframe bias: D1 ${d1Bias} & H4 ${h4Bias} favor ${direction}.`
      : `Higher-timeframe D1/H4 bias aligns ${biasWord} for this ${direction} setup.`;

  const rawTf = ('timeframe' in signal && signal.timeframe) ? signal.timeframe : 'H1';
  const fallbacks: [string, string, string] = [
    htfFallback,
    `${String(rawTf).toUpperCase()} structure confirms a clean entry with defined stop.`,
    `Opposing key levels allow >= 1.5R reward:risk to TP1.`,
  ];

  const hasHtf = rawReasons.some((r) => hasHigherTimeframeBiasMention(r));
  const merged = hasHtf ? rawReasons : [htfFallback, ...rawReasons];
  return normalizeWhyBullets(merged, fallbacks, 90);
}

export function buildResultView(
  signal: ResultSignalInput | null | undefined,
  platformProfile: AnalysisProfile | AnalysisMode,
  options: BuildResultViewOptions = {}
): ResultViewModel | null {
  if (!signal) return null;

  const profile = normalizeAnalysisProfile(platformProfile);
  const nowMs = options.nowMs ?? Date.now();
  const decimals = options.decimals ?? 5;
  const sigAsData = signal as SignalData;

  if (sigAsData.status === 'ANALYSIS_BLOCKED') {
    return {
      kind: 'BLOCKED',
      profile,
      direction: 'WAIT',
      sections: ['blocked'],
      blockedReason: sigAsData.blockedReason || 'Analysis is temporarily paused.',
      plainLanguageReason:
        sigAsData.plainLanguageReason || 'Wait for valid live market data before scanning again.',
      strengthChip: null,
      moreDetails: null,
    };
  }

  // WAIT (identical Steve Krug simplicity across both Binary and MT5)
  if (signal.direction === 'WAIT') {
    const tf =
      ('expiry' in signal && signal.expiry) ||
      ('timeframe' in signal && signal.timeframe) ||
      (profile === 'MT5' ? 'H1' : '3m');
    const mins = computeNextCandleCloseMinutes(String(tf), nowMs);
    const reason =
      (signal.whyNotTrade ||
        sigAsData.plainLanguageReason ||
        signal.reasons?.[0] ||
        'Market structure is unclear right now. Stand aside and wait for confirmation.').trim();

    return {
      kind: 'WAIT',
      profile,
      direction: 'WAIT',
      sections: ['verdict', 'reason', 'next_check'],
      verdict: {
        badge: 'WAIT ✋',
      },
      reason,
      checkAgainMinutes: mins,
      checkAgainText: `Check again in about ${mins} minute${mins === 1 ? '' : 's'}`,
      strengthChip: null,
      moreDetails: null,
    };
  }

  // BINARY ("Quick Trade") ACTIONABLE RESULT
  if (profile === 'BINARY_QUICK') {
    const dir: 'CALL' | 'PUT' = signal.direction === 'PUT' || signal.direction === 'SELL' ? 'PUT' : 'CALL';
    const expiryRaw = String(
      ('expiry' in signal && signal.expiry) ||
        ('timeframe' in signal && signal.timeframe) ||
        '2m'
    ).toLowerCase();
    const durationPhrase = formatExpiryDurationPhrase(expiryRaw);
    const binaryBalance = Math.max(0, Number(options.binaryBalance ?? 100));
    const binaryRiskPct = Math.max(0.5, Math.min(2, Number(options.binaryRiskPct ?? 1)));
    const suggestedStakeUsd = parseFloat(((binaryBalance * binaryRiskPct) / 100).toFixed(2));
    const payoutPct = Number(
      ('payoutPct' in signal && typeof signal.payoutPct === 'number' ? signal.payoutPct : undefined) ??
        options.brokerPayoutPct ??
        85
    );
    const breakEvenWinRatePct = Number(
      ('breakEvenWinRatePct' in signal && typeof signal.breakEvenWinRatePct === 'number'
        ? signal.breakEvenWinRatePct
        : undefined) ?? calculateBreakEvenWinRate(payoutPct)
    );
    const enterWithinSeconds = Number(
      ('enterWithinSeconds' in signal && typeof signal.enterWithinSeconds === 'number'
        ? signal.enterWithinSeconds
        : undefined) ?? 6
    );

    const whyBullets = normalizeWhyBullets(
      signal.reasons,
      [
        `${expiryRaw.toUpperCase()} candle momentum favors ${dir === 'CALL' ? 'upward' : 'downward'} continuation.`,
        `M5 and M15 structure aligns with the ${dir} direction.`,
        `No high-impact news or wide volatility spike blocking entry.`,
      ],
      90
    );

    return {
      kind: 'BINARY',
      profile: 'BINARY_QUICK',
      direction: dir,
      sections: ['verdict', 'key_facts', 'why', 'strength', 'breakeven', 'risk', 'more_details'],
      verdict: {
        badge: dir === 'CALL' ? 'CALL ▲' : 'PUT ▼',
        plainSentence: `Price is more likely to ${dir === 'CALL' ? 'rise' : 'fall'} over the next ${durationPhrase}.`,
      },
      keyFacts: {
        expiryLabel: formatExpiryTileLabel(expiryRaw),
        expiryRaw,
        enterWithinSeconds,
        suggestedStakeUsd,
      },
      whyBullets,
      strengthChip: {
        label: 'Setup strength (not a win probability)',
        strength: signal.strength || 'Low',
      },
      breakEvenLine: `Break-even win rate at ${payoutPct}% payout: ${breakEvenWinRatePct.toFixed(2)}%`,
      payoutPct,
      breakEvenWinRatePct,
      riskLine: 'Never risk more than 2% per trade. Algorithmic signal, not financial advice.',
      moreDetails: {
        defaultOpen: false,
        entryPrice: Number(signal.entryPrice ?? 0),
      },
    };
  }

  // MT5 ("Trade Plan") ACTIONABLE RESULT
  const dir: 'BUY' | 'SELL' = signal.direction === 'SELL' || signal.direction === 'PUT' ? 'SELL' : 'BUY';
  const mt5Nested = sigAsData.mt5;
  const rawMt5 = signal as MT5SignalOutput;
  const orderKind: 'MARKET' | 'LIMIT' =
    ('orderKind' in signal && signal.orderKind) || mt5Nested?.orderKind || rawMt5.orderKind || 'MARKET';

  const entryPrice = Number(mt5Nested?.entryPrice ?? signal.entryPrice ?? 0);
  const entryZone = mt5Nested?.entryZone ?? ('entryZone' in signal ? signal.entryZone : undefined) ?? null;
  const stopLoss = Number(mt5Nested?.stopLossPrice ?? rawMt5.stopLoss ?? 0);
  const stopLossPips = Number(mt5Nested?.stopLossPips ?? rawMt5.stopLossPips ?? 0);
  const tp1 = Number(mt5Nested?.takeProfit1Price ?? rawMt5.takeProfit1 ?? 0);
  const tp1Pips = Number(mt5Nested?.takeProfit1Pips ?? rawMt5.takeProfit1Pips ?? 0);
  const tp2 = Number(mt5Nested?.takeProfit2Price ?? rawMt5.takeProfit2 ?? 0);
  const tp2Pips = Number(mt5Nested?.takeProfit2Pips ?? rawMt5.takeProfit2Pips ?? 0);
  const lotSize = Number(mt5Nested?.recommendedLot ?? rawMt5.lotSize ?? 0);
  const riskMoney = Number(mt5Nested?.accountRiskAmount ?? rawMt5.riskMoney ?? 0);
  const accountCurrency = String(mt5Nested?.accountCurrency ?? rawMt5.accountCurrency ?? 'USD');
  const rewardRiskTp1 = Number(mt5Nested?.rewardRiskTp1 ?? rawMt5.rewardRiskTp1 ?? 1.5);
  const rewardRiskTp2 = Number(mt5Nested?.rewardRiskTp2 ?? rawMt5.rewardRiskTp2 ?? 2.5);
  const rewardRiskRatio =
    mt5Nested?.riskRewardRatio ||
    rawMt5.rewardRiskRatio ||
    `1:${(rewardRiskTp1 > 0 ? rewardRiskTp1 : 1.5).toFixed(2)}`;
  const distanceUnit: DistanceUnit =
    options.distanceUnit ||
    ('distanceUnit' in signal ? signal.distanceUnit : undefined) ||
    mt5Nested?.distanceUnit ||
    'pips';

  const fmtDist = (v: number, sign: '+' | '-') => {
    const abs = Math.abs(v);
    const num = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    return `${sign}${num} ${formatDistanceUnitWord(abs, distanceUnit)}`;
  };

  const validMs = signal.validUntil ? Date.parse(signal.validUntil) : NaN;
  const fallbackMins =
    Number(mt5Nested?.validityCandles ?? rawMt5.validityCandles ?? 3) * 5;
  const validityMinutesLeft = Number.isFinite(validMs)
    ? Math.max(0, Math.ceil((validMs - nowMs) / 60_000))
    : fallbackMins;

  const invLevel =
    mt5Nested?.invalidationLevel ??
    sigAsData.invalidationLevel ??
    rawMt5.invalidationLevel ??
    (stopLoss > 0 ? stopLoss : null);
  const invDisplay =
    invLevel !== null && Number.isFinite(invLevel) ? invLevel.toFixed(decimals) : stopLoss.toFixed(decimals);

  const validityLine =
    validityMinutesLeft > 0
      ? `Valid for about ${validityMinutesLeft} min, or until price crosses ${invDisplay}`
      : `Validity window ended — skip setup if price crossed ${invDisplay}`;

  const tfUpper = String(('timeframe' in signal && signal.timeframe) || 'H1').toUpperCase();
  const rrSafe = rewardRiskTp1 > 0 ? rewardRiskTp1 : 1.5;
  const minWinRatePct = (1 / (1 + rrSafe)) * 100;

  const copyOrderText =
    mt5Nested?.formattedText ||
    rawMt5.copyOrderText ||
    `${signal.asset} ${dir} ${orderKind} @ ${entryPrice.toFixed(decimals)} | SL ${stopLoss.toFixed(decimals)} | TP1 ${tp1.toFixed(decimals)} | TP2 ${tp2.toFixed(decimals)} | Lots ${lotSize}`;

  const entryText =
    orderKind === 'LIMIT' && entryZone && Math.abs(entryZone.max - entryZone.min) > 0
      ? `${entryZone.min.toFixed(decimals)} – ${entryZone.max.toFixed(decimals)}`
      : entryPrice.toFixed(decimals);

  return {
    kind: 'MT5',
    profile: 'MT5',
    direction: dir,
    orderKind,
    sections: ['verdict', 'order_ticket', 'validity', 'why', 'strength', 'more_details'],
    verdict: {
      badge: `${dir} ${orderKind === 'LIMIT' ? '(LIMIT)' : '(MARKET)'}`,
      plainSentence:
        orderKind === 'LIMIT'
          ? `Price bias favors a ${dir} limit pullback on the ${tfUpper} chart.`
          : `Price bias favors a ${dir} setup on the ${tfUpper} chart.`,
    },
    orderTicket: {
      orderType: dir,
      orderKind,
      entryText,
      entryPrice,
      entryZone,
      stopLossPriceText: stopLoss.toFixed(decimals),
      stopLossPrice: stopLoss,
      stopLossDistanceText: fmtDist(stopLossPips, '-'),
      tp1PriceText: tp1.toFixed(decimals),
      tp1Price: tp1,
      tp1DistanceText: fmtDist(tp1Pips, '+'),
      tp2PriceText: tp2.toFixed(decimals),
      tp2Price: tp2,
      tp2DistanceText: fmtDist(tp2Pips, '+'),
      lotSize,
      lotSizeText: lotSize > 0 ? `${lotSize} lots` : '0 lots (below min)',
      riskMoney,
      accountCurrency,
      riskMoneyText: `${accountCurrency} ${riskMoney.toFixed(2)}`,
      rewardRiskText: rewardRiskRatio,
      rewardRiskTp1,
      rewardRiskTp2,
      primaryButtonLabel: 'Copy order',
      copyOrderText,
    },
    validityLine,
    validityMinutesLeft,
    whyBullets: buildMt5WhyBullets(signal, dir),
    strengthChip: {
      label: 'Setup strength (not a win probability)',
      strength: signal.strength || 'Low',
    },
    moreDetails: {
      defaultOpen: false,
      needsAtLeastWinRateLine: `Needs at least ${minWinRatePct.toFixed(1)}% winning trades to break even at this reward:risk`,
      tradeManagement:
        mt5Nested?.tradeManagementNote ||
        sigAsData.tradeManagementNote ||
        rawMt5.tradeManagementNote ||
        'Move stop-loss to break-even at 1R and take partial profit at TP1.',
      spreadAndSessionNotes:
        mt5Nested?.sessionNote ||
        sigAsData.sessionNote ||
        rawMt5.sessionNote ||
        'Standard session liquidity. Verify your MT5 broker spread before placing the order.',
      invalidationRule:
        mt5Nested?.invalidationRule ||
        sigAsData.invalidationReason ||
        rawMt5.invalidationRule ||
        `Cancel setup if price crosses ${invDisplay}.`,
      accountSizingWarning: sigAsData.accountSizingWarning || mt5Nested?.accountSizingWarning,
    },
  };
}

export function getSortedNearestLevels(
  context: MarketContextSummary,
  limit?: number
): KeyLevelMapItem[] {
  const sorted = [...context.levelsMap].sort(
    (a, b) => a.absPipsFromLevel - b.absPipsFromLevel
  );
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}

export function getTopAndQuietSessionHours(context: MarketContextSummary): {
  mostActiveHours: UtcSessionHourBucket[];
  quietestHours: UtcSessionHourBucket[];
} {
  const valid = context.sessionProfile.hours.filter(
    (h) => h.avgRangePips !== null && h.sampleCount > 0
  );
  const byActiveDesc = [...valid].sort(
    (a, b) => (b.avgRangePips ?? 0) - (a.avgRangePips ?? 0)
  );
  const byQuietAsc = [...valid].sort(
    (a, b) => (a.avgRangePips ?? 0) - (b.avgRangePips ?? 0)
  );
  return {
    mostActiveHours: byActiveDesc.slice(0, 3),
    quietestHours: byQuietAsc.slice(0, 3),
  };
}

export function buildMarketContextSummaryLines(
  context: MarketContextSummary
): MarketContextThreeLineSummary {
  const unit = context.distanceUnit || 'pips';
  const decimals = context.decimals ?? 5;

  // Line 1: Trend across M15 / H1 / H4 / D1
  const tfText = (['M15', 'H1', 'H4', 'D1'] as const)
    .map((tf) => {
      const row = context.trendTable.find((r) => r.timeframe === tf);
      return row ? `${tf} ${row.direction}` : `${tf} N/A`;
    })
    .join(', ');
  const trendLine = `Trend: ${tfText}.`;

  // Line 2: Volatility regime + sample size
  const vol = context.volatilityRegime;
  const volatilityLine =
    vol.sampleCount > 0 && vol.currentAtrPips !== null && vol.percentile30d !== null
      ? `Volatility is ${vol.regime} — daily ATR(14) is ${vol.currentAtrPips.toFixed(1)} ${formatDistanceUnitWord(vol.currentAtrPips, unit)} (${vol.percentile30d.toFixed(0)}th percentile, n=${vol.sampleCount}).`
      : `Volatility regime unavailable (n=${vol.sampleCount} daily bars).`;

  // Line 3: Nearest level above & nearest level below
  const sorted = getSortedNearestLevels(context);
  const above = sorted.find((l) => l.price > context.currentPrice);
  const below = sorted.find((l) => l.price < context.currentPrice);

  let levelsLine = 'Key levels: awaiting sufficient candle history.';
  if (above && below) {
    levelsLine = `Nearest levels: ${above.label} above at ${above.price.toFixed(decimals)} (+${above.absPipsFromLevel.toFixed(1)} ${formatDistanceUnitWord(above.absPipsFromLevel, unit)}) and ${below.label} below at ${below.price.toFixed(decimals)} (-${below.absPipsFromLevel.toFixed(1)} ${formatDistanceUnitWord(below.absPipsFromLevel, unit)}).`;
  } else if (above) {
    levelsLine = `Nearest level above: ${above.label} at ${above.price.toFixed(decimals)} (+${above.absPipsFromLevel.toFixed(1)} ${formatDistanceUnitWord(above.absPipsFromLevel, unit)}).`;
  } else if (below) {
    levelsLine = `Nearest level below: ${below.label} at ${below.price.toFixed(decimals)} (-${below.absPipsFromLevel.toFixed(1)} ${formatDistanceUnitWord(below.absPipsFromLevel, unit)}).`;
  }

  return { trendLine, volatilityLine, levelsLine };
}
