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
  copyOrderText: string | null;
  canCopyOrder: boolean;
  cannotCopyReason: string | null;
}

export interface MT5ResultView {
  kind: 'MT5';
  profile: 'MT5';
  direction: 'BUY' | 'SELL';
  orderKind: 'MARKET' | 'LIMIT';
  sections: ResultSectionType[];
  accountTooSmallWarning: string | null;
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
  minActionableStrength?: SignalStrength;
}

export interface MarketContextThreeLineSummary {
  trendLine: string;
  volatilityLine: string;
  levelsLine: string;
}

export const MIN_STRENGTH_WAIT_REASON =
  'A setup was found but it is not strong enough to act on.';

export function getStrengthRank(strength: SignalStrength | string | undefined): number {
  const norm = String(strength || '').trim().toLowerCase();
  if (norm === 'high') return 3;
  if (norm === 'medium') return 2;
  return 1;
}

export function isStrengthBelowMinimum(
  strength: SignalStrength | string | undefined,
  minStrength: SignalStrength | string | undefined = 'Medium'
): boolean {
  return getStrengthRank(strength) < getStrengthRank(minStrength);
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

function formatExpiryHyphenDuration(expiryRaw: string): string {
  const norm = expiryRaw.toLowerCase();
  if (norm === '1m') return '1-minute';
  if (norm === '2m') return '2-minute';
  if (norm === '3m') return '3-minute';
  if (norm === '5m') return '5-minute';
  return norm || 'short-expiry';
}

function formatExpiryTileLabel(expiryRaw: string): string {
  const norm = expiryRaw.toLowerCase();
  if (norm === '1m') return '1 MIN';
  if (norm === '2m') return '2 MIN';
  if (norm === '3m') return '3 MIN';
  if (norm === '5m') return '5 MIN';
  return norm.toUpperCase();
}

type BiasVal = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

function extractBiasValue(raw: unknown): BiasVal | null {
  if (typeof raw === 'string') {
    const up = raw.toUpperCase();
    if (up === 'BULLISH' || up === 'BEARISH' || up === 'NEUTRAL') return up;
    return null;
  }
  if (raw && typeof raw === 'object' && 'bias' in raw) {
    return extractBiasValue((raw as { bias?: unknown }).bias);
  }
  return null;
}

function extractNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function clampShortBullet(sentence: string, fallback: string): string {
  const clean = sentence.replace(/\s+/g, ' ').trim();
  if (clean.length > 0 && clean.length <= 90) return clean;
  return fallback.slice(0, 90);
}

function buildBinaryWhyBullets(
  signal: ResultSignalInput,
  direction: 'CALL' | 'PUT',
  expiryRaw: string
): [string, string, string] {
  const snap = (signal.inputsSnapshot || {}) as Record<string, unknown>;
  const targetBias: BiasVal = direction === 'CALL' ? 'BULLISH' : 'BEARISH';
  const dirWord = direction === 'CALL' ? 'up' : 'down';

  const m5Bias = extractBiasValue(snap.m5) ?? extractBiasValue(snap.m5Bias);
  const m15Bias = extractBiasValue(snap.m15) ?? extractBiasValue(snap.m15Bias);

  // (1) Trend context
  let trendBullet: string;
  if (m5Bias === targetBias && m15Bias === targetBias) {
    trendBullet = `M5 and M15 point ${dirWord}`;
  } else if (m5Bias === targetBias && m15Bias === 'NEUTRAL') {
    trendBullet = `M5 points ${dirWord}; M15 is neutral`;
  } else if (m5Bias === targetBias) {
    trendBullet = `M5 points ${dirWord}; M15 holds steady`;
  } else if (m15Bias === targetBias && m5Bias === 'NEUTRAL') {
    trendBullet = `M15 points ${dirWord}; M5 is neutral`;
  } else if (m15Bias === targetBias) {
    trendBullet = `M15 points ${dirWord}; M5 is consolidating`;
  } else {
    trendBullet = `M5 and M15 point ${dirWord}`;
  }

  // (2) 60s Momentum
  const micro = (snap.microTicks60s && typeof snap.microTicks60s === 'object'
    ? (snap.microTicks60s as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const buyPct = extractNumber(micro.momentumBuyPct) ?? extractNumber(snap.momentumBuyPct);
  const sellPct = extractNumber(micro.momentumSellPct) ?? extractNumber(snap.momentumSellPct);
  const domPct = direction === 'CALL' ? buyPct : sellPct;

  const momentumBullet =
    domPct !== null && domPct > 0
      ? `In the last 60 seconds, ${Math.round(domPct)}% of tick moves were ${dirWord}`
      : `Recent tick momentum moves ${dirWord}`;

  // (3) Volatility fit
  const volFitBullet = `Volatility suits a ${formatExpiryHyphenDuration(expiryRaw)} trade`;

  return [
    clampShortBullet(trendBullet, `M5 and M15 point ${dirWord}`),
    clampShortBullet(momentumBullet, `Recent tick momentum moves ${dirWord}`),
    clampShortBullet(volFitBullet, 'Volatility fits short-expiry entry'),
  ];
}

function buildMt5WhyBullets(
  signal: ResultSignalInput,
  direction: 'BUY' | 'SELL',
  tfUpper: string,
  rrTp1: number
): [string, string, string] {
  const sigAsData = signal as SignalData;
  const rawMt5 = signal as MT5SignalOutput;
  const snap = (signal.inputsSnapshot || {}) as Record<string, unknown>;
  const targetBias: BiasVal = direction === 'BUY' ? 'BULLISH' : 'BEARISH';
  const dirWord = direction === 'BUY' ? 'up' : 'down';
  const swingSide = direction === 'BUY' ? 'low' : 'high';

  const d1 = extractBiasValue(snap.d1Bias);
  const h4 = extractBiasValue(snap.h4Bias);
  const structBias =
    tfUpper === 'M15' ? extractBiasValue(snap.m15Bias) : extractBiasValue(snap.h1Bias);

  // (1) Higher-timeframe bias (D1 / H4 / structure)
  let biasBullet: string;
  if (d1 === targetBias && h4 === targetBias) {
    biasBullet = `D1 and H4 point ${dirWord}; ${tfUpper} agrees`;
  } else if (h4 === targetBias && d1 === 'NEUTRAL') {
    biasBullet = `D1 neutral, H4 points ${dirWord}; ${tfUpper} agrees`;
  } else if (d1 === targetBias && h4 === 'NEUTRAL') {
    biasBullet = `D1 points ${dirWord}, H4 neutral; ${tfUpper} agrees`;
  } else if (structBias === targetBias) {
    biasBullet = `D1 and H4 favor ${direction}; ${tfUpper} agrees`;
  } else {
    biasBullet = `D1 and H4 point ${dirWord}; ${tfUpper} agrees`;
  }

  // (2) Structure & Reward:Risk (never repeating ticket prices, lots, or pips)
  const rrSafe = Number.isFinite(rrTp1) && rrTp1 > 0 ? rrTp1 : 1.5;
  const rrFormatted =
    Math.abs(rrSafe * 10 - Math.round(rrSafe * 10)) < 0.01
      ? rrSafe.toFixed(1)
      : rrSafe.toFixed(2);
  const structureBullet = `Stop sits beyond the ${tfUpper} swing ${swingSide}; TP1 is ${rrFormatted}x the risk`;

  // (3) Session / liquidity context (never trade management advice)
  const sessionObj = (snap.session && typeof snap.session === 'object'
    ? (snap.session as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const sessionNameLower = String(sessionObj.sessionName || '').toLowerCase();
  const sessionQual = String(
    sessionObj.sessionQuality || sigAsData.sessionQuality || rawMt5.sessionQuality || ''
  ).toUpperCase();
  const noteLower = String(
    sessionObj.note || sigAsData.sessionNote || rawMt5.sessionNote || ''
  ).toLowerCase();
  const assetLower = String(signal.asset || '').toLowerCase();

  let sessionBullet: string;
  if (sessionNameLower.includes('synthetic') || assetLower.includes('volatility')) {
    sessionBullet = '24/7 synthetic index; practice conditions only';
  } else if (sessionNameLower.includes('crypto')) {
    sessionBullet = '24/7 crypto liquidity; no blocking macro news';
  } else if (sessionNameLower.includes('overlap')) {
    sessionBullet = 'London/NY overlap: best liquidity';
  } else if (sessionNameLower.includes('london')) {
    sessionBullet = 'London session: active liquidity';
  } else if (sessionNameLower.includes('new york') || sessionNameLower.includes('ny afternoon')) {
    sessionBullet = 'NY session: moderate liquidity';
  } else if (sessionNameLower.includes('asian')) {
    sessionBullet = 'Asian session: lighter liquidity';
  } else if (sessionNameLower.includes('rollover')) {
    sessionBullet = 'Rollover window: thinner liquidity';
  } else if (noteLower.includes('overlap')) {
    sessionBullet = 'London/NY overlap: best liquidity';
  } else if (noteLower.includes('european')) {
    sessionBullet = 'London session: active liquidity';
  } else if (sessionQual === 'PRIME') {
    sessionBullet = 'Prime session liquidity; no blocking news';
  } else if (sessionQual === 'CAUTION' || sessionQual === 'THIN') {
    sessionBullet = 'Lighter session liquidity; check spread first';
  } else {
    sessionBullet = 'Standard session liquidity; no blocking news';
  }

  return [
    clampShortBullet(biasBullet, `D1 and H4 point ${dirWord}; ${tfUpper} agrees`),
    clampShortBullet(structureBullet, `Stop sits beyond the ${tfUpper} swing ${swingSide}`),
    clampShortBullet(sessionBullet, 'Standard session liquidity'),
  ];
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
  const minStrength = options.minActionableStrength ?? 'Medium';
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

  const belowMinimumStrength =
    signal.direction !== 'WAIT' &&
    isStrengthBelowMinimum(signal.strength || 'Low', minStrength);

  // WAIT (explicit engine WAIT or downgraded below minimum actionable strength)
  if (signal.direction === 'WAIT' || belowMinimumStrength) {
    const tf =
      ('expiry' in signal && signal.expiry) ||
      ('timeframe' in signal && signal.timeframe) ||
      (profile === 'MT5' ? 'H1' : '3m');
    const mins = computeNextCandleCloseMinutes(String(tf), nowMs);
    const reason = belowMinimumStrength
      ? MIN_STRENGTH_WAIT_REASON
      : (signal.whyNotTrade ||
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

    const whyBullets = buildBinaryWhyBullets(signal, dir, expiryRaw);

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

  const isAccountTooSmall = !Number.isFinite(lotSize) || lotSize <= 0;
  const rawSizingWarning =
    mt5Nested?.accountSizingWarning || rawMt5.accountSizingWarning || sigAsData.accountSizingWarning;
  const accountTooSmallWarning = isAccountTooSmall
    ? rawSizingWarning || 'Your account is too small to take this trade at your chosen risk.'
    : null;

  const rawCopyText =
    mt5Nested?.formattedText ||
    rawMt5.copyOrderText ||
    `${signal.asset} ${dir} ${orderKind} @ ${entryPrice.toFixed(decimals)} | SL ${stopLoss.toFixed(decimals)} | TP1 ${tp1.toFixed(decimals)} | TP2 ${tp2.toFixed(decimals)} | Lots ${lotSize}`;

  const entryText =
    orderKind === 'LIMIT' && entryZone && Math.abs(entryZone.max - entryZone.min) > 0
      ? `${entryZone.min.toFixed(decimals)} – ${entryZone.max.toFixed(decimals)}`
      : entryPrice.toFixed(decimals);

  const plainSentence = isAccountTooSmall
    ? `A ${dir} setup exists, but your account is too small to take it at your risk setting.`
    : orderKind === 'LIMIT'
    ? `Price bias favors a ${dir} limit pullback on the ${tfUpper} chart.`
    : `Price bias favors a ${dir} setup on the ${tfUpper} chart.`;

  return {
    kind: 'MT5',
    profile: 'MT5',
    direction: dir,
    orderKind,
    sections: ['verdict', 'order_ticket', 'validity', 'why', 'strength', 'more_details'],
    accountTooSmallWarning,
    verdict: {
      badge: `${dir} ${orderKind === 'LIMIT' ? '(LIMIT)' : '(MARKET)'}`,
      plainSentence,
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
      lotSizeText: !isAccountTooSmall ? `${lotSize} lots` : '0 lots (below min)',
      riskMoney,
      accountCurrency,
      riskMoneyText: `${accountCurrency} ${riskMoney.toFixed(2)}`,
      rewardRiskText: rewardRiskRatio,
      rewardRiskTp1,
      rewardRiskTp2,
      primaryButtonLabel: 'Copy order',
      copyOrderText: isAccountTooSmall ? null : rawCopyText,
      canCopyOrder: !isAccountTooSmall,
      cannotCopyReason: isAccountTooSmall
        ? "Can't copy: lot size is below your broker's minimum"
        : null,
    },
    validityLine,
    validityMinutesLeft,
    whyBullets: buildMt5WhyBullets(signal, dir, tfUpper, rrSafe),
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
      accountSizingWarning: isAccountTooSmall ? undefined : rawSizingWarning || undefined,
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
