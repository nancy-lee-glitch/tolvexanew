/**
 * conditions.ts — Pure Trading Conditions Gate (Stage 4L).
 *
 * Evaluates measurable risk conditions right now (market open/closed, feed
 * freshness, scheduled macro events, FX rollover, volatility percentile,
 * session activity quartile, M15/H1/H4/D1 trend alignment, user loss limits,
 * and synthetic index disclaimers).
 *
 * Strictly deterministic (zero PRNG calls, zero network calls, zero DOM dependencies),
 * and never predicts whether a trade will win or lose.
 */

import type { AnalysisProfile, AssetConfig, FeedHealthStatus } from '../types.ts';
import type { MarketContextSummary, ContextTimeframe, TrendDirectionLabel } from './engines/marketContext.ts';
import type { MarketEventItem } from './engines/types.ts';
import { inferAssetCurrencies } from './instrumentMeta.ts';
import { isSyntheticAsset } from '../services/symbolMap.ts';

export type ConditionLevel = 'OK' | 'CAUTION' | 'NOT_ADVISED';
export type ConditionSeverity = 'NOT_ADVISED' | 'CAUTION';

export type ConditionReasonCode =
  | 'MARKET_CLOSED'
  | 'FEED_NOT_LIVE'
  | 'TICK_STALE'
  | 'HIGH_IMPACT_NEWS'
  | 'ROLLOVER_WINDOW'
  | 'ATR_TOO_LOW'
  | 'ATR_EXTREME'
  | 'CONSECUTIVE_LOSSES'
  | 'DAILY_LOSS_LIMIT'
  | 'SYNTHETIC_PRACTICE_ONLY'
  | 'QUIET_SESSION_HOUR'
  | 'ATR_LOW_CAUTION'
  | 'ATR_HIGH_CAUTION'
  | 'UPCOMING_HIGH_NEWS'
  | 'TREND_DISAGREEMENT'
  | 'FRIDAY_LATE_SESSION';

export interface ConditionReason {
  code: ConditionReasonCode;
  text: string;
  severity: ConditionSeverity;
}

export interface ConditionsUserState {
  consecutiveLosses?: number;
  dailyLossesCount?: number;
  dailyLossLimitCount?: number | null;
  dailyLossUsd?: number;
  dailyLossLimitUsd?: number | null;
}

export interface ConditionsConfig {
  binaryTickMaxAgeSec: number;
  binaryNewsWindowMinutes: number;
  mt5NewsWindowMinutes: number;
  cautionNewsWindowMinutes: number;
  rolloverStartHourUtc: number;
  rolloverEndHourUtc: number;
  atrPercentileLowBlock: number;
  atrPercentileHighBlock: number;
  atrPercentileLowCautionMax: number;
  atrPercentileHighCautionMin: number;
  quietSessionQuartile: number;
  fridayCutoffHourUtc: number;
  maxConsecutiveLosses: number;
}

export const CONDITIONS_CONFIG_KEY = 'conditions_config';

export const DEFAULT_CONDITIONS_CONFIG: ConditionsConfig = {
  binaryTickMaxAgeSec: 6,
  binaryNewsWindowMinutes: 15,
  mt5NewsWindowMinutes: 30,
  cautionNewsWindowMinutes: 60,
  rolloverStartHourUtc: 21,
  rolloverEndHourUtc: 24,
  atrPercentileLowBlock: 10,
  atrPercentileHighBlock: 95,
  atrPercentileLowCautionMax: 25,
  atrPercentileHighCautionMin: 85,
  quietSessionQuartile: 0.25,
  fridayCutoffHourUtc: 19,
  maxConsecutiveLosses: 3,
};

export const CONDITIONS_CONFIG_BOUNDS: Record<
  keyof ConditionsConfig,
  { min: number; max: number; integer?: boolean; label: string }
> = {
  binaryTickMaxAgeSec: { min: 1, max: 60, integer: false, label: 'Binary tick freshness limit (sec)' },
  binaryNewsWindowMinutes: { min: 0, max: 180, integer: true, label: 'Binary high-impact news window (min)' },
  mt5NewsWindowMinutes: { min: 0, max: 240, integer: true, label: 'MT5 high-impact news window (min)' },
  cautionNewsWindowMinutes: { min: 0, max: 360, integer: true, label: 'Caution news notice window (min)' },
  rolloverStartHourUtc: { min: 0, max: 23, integer: true, label: 'FX rollover start hour (UTC)' },
  rolloverEndHourUtc: { min: 1, max: 24, integer: true, label: 'FX rollover end hour (UTC)' },
  atrPercentileLowBlock: { min: 0, max: 45, integer: false, label: 'ATR percentile dead-market block (<)' },
  atrPercentileHighBlock: { min: 55, max: 100, integer: false, label: 'ATR percentile extreme-volatility block (>)' },
  atrPercentileLowCautionMax: { min: 0, max: 50, integer: false, label: 'ATR percentile low-activity caution max' },
  atrPercentileHighCautionMin: { min: 50, max: 100, integer: false, label: 'ATR percentile elevated-activity caution min' },
  quietSessionQuartile: { min: 0.05, max: 0.5, integer: false, label: 'Quiet session bottom quartile (0.05–0.50)' },
  fridayCutoffHourUtc: { min: 12, max: 23, integer: true, label: 'Friday late-session caution hour (UTC)' },
  maxConsecutiveLosses: { min: 1, max: 20, integer: true, label: 'Max consecutive losses before block' },
};

export interface ValidateConditionsConfigResult {
  ok: boolean;
  value?: ConditionsConfig;
  error?: string;
}

export function validateConditionsConfig(raw: unknown): ValidateConditionsConfigResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'conditions_config must be an object.' };
  }
  const src = raw as Record<string, unknown>;
  const out: ConditionsConfig = { ...DEFAULT_CONDITIONS_CONFIG };

  for (const key of Object.keys(CONDITIONS_CONFIG_BOUNDS) as Array<keyof ConditionsConfig>) {
    const val = src[key];
    if (val === undefined) continue;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { ok: false, error: `${key} must be a finite number.` };
    }
    const bounds = CONDITIONS_CONFIG_BOUNDS[key];
    if (val < bounds.min || val > bounds.max) {
      return {
        ok: false,
        error: `${key} must be between ${bounds.min} and ${bounds.max}.`,
      };
    }
    out[key] = bounds.integer ? Math.round(val) : val;
  }

  if (out.atrPercentileLowBlock > out.atrPercentileLowCautionMax) {
    return {
      ok: false,
      error: 'atrPercentileLowBlock cannot exceed atrPercentileLowCautionMax.',
    };
  }
  if (out.atrPercentileLowCautionMax >= out.atrPercentileHighCautionMin) {
    return {
      ok: false,
      error: 'atrPercentileLowCautionMax must be lower than atrPercentileHighCautionMin.',
    };
  }
  if (out.atrPercentileHighCautionMin > out.atrPercentileHighBlock) {
    return {
      ok: false,
      error: 'atrPercentileHighCautionMin cannot exceed atrPercentileHighBlock.',
    };
  }
  if (
    out.cautionNewsWindowMinutes <
    Math.max(out.binaryNewsWindowMinutes, out.mt5NewsWindowMinutes)
  ) {
    return {
      ok: false,
      error: 'cautionNewsWindowMinutes must be at least as large as binary and MT5 news windows.',
    };
  }

  return { ok: true, value: out };
}

export function normalizeConditionsConfig(raw: unknown): ConditionsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_CONDITIONS_CONFIG };
  }
  const src = raw as Record<string, unknown>;
  const merged: Record<string, number> = { ...DEFAULT_CONDITIONS_CONFIG };

  for (const key of Object.keys(CONDITIONS_CONFIG_BOUNDS) as Array<keyof ConditionsConfig>) {
    const rawVal = Number(src[key]);
    if (Number.isFinite(rawVal)) {
      const b = CONDITIONS_CONFIG_BOUNDS[key];
      const clamped = Math.min(b.max, Math.max(b.min, rawVal));
      merged[key] = b.integer ? Math.round(clamped) : clamped;
    }
  }

  const check = validateConditionsConfig(merged);
  return check.ok && check.value ? check.value : { ...DEFAULT_CONDITIONS_CONFIG };
}

export interface AssessConditionsInput {
  asset: AssetConfig;
  platformProfile: AnalysisProfile;
  feedStatus: FeedHealthStatus | string;
  tickAgeSeconds?: number | null;
  nowMs?: number;
  marketContext?: MarketContextSummary | null;
  upcomingEvents?: MarketEventItem[];
  userState?: ConditionsUserState;
  config?: Partial<ConditionsConfig>;
}

export interface ConditionsAssessment {
  level: ConditionLevel;
  reasons: ConditionReason[];
  nextBetterWindowText?: string;
}

export const CONDITIONS_DISCLAIMER_TEXT =
  'This checks risk conditions. It does not predict whether a trade will win or lose.';

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

function formatUtcHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function is24x7MarketAsset(asset: AssetConfig): boolean {
  return asset.type === 'CRYPTO' || asset.type === 'SYNTH' || isSyntheticAsset(asset);
}

function isFxOrMetalAsset(asset: AssetConfig): boolean {
  if (is24x7MarketAsset(asset)) return false;
  if (asset.type === 'FOREX' || asset.type === 'COMMODITY') return true;
  const sym = (asset.symbol || '').toUpperCase();
  return sym.startsWith('FRX');
}

function isWeekendMarketClosedUtc(asset: AssetConfig, utcDay: number, utcHour: number): boolean {
  if (is24x7MarketAsset(asset)) return false;
  if (asset.type === 'INDEX' || /^OTC_/i.test(asset.symbol || '')) {
    return false;
  }
  return utcDay === 6 || (utcDay === 5 && utcHour >= 21) || (utcDay === 0 && utcHour < 21);
}

function isHourInRolloverWindow(utcHour: number, startHour: number, endHour: number): boolean {
  const endNormalized = endHour === 0 ? 24 : endHour;
  if (startHour === endNormalized) return false;
  if (startHour < endNormalized) {
    return utcHour >= startHour && utcHour < endNormalized;
  }
  return utcHour >= startHour || utcHour < endNormalized;
}

function findMatchingHighEvents(
  events: MarketEventItem[] | undefined,
  asset: AssetConfig
): Array<{ event: MarketEventItem; startMs: number }> {
  if (!events || events.length === 0) return [];
  if (asset.type === 'SYNTH' || isSyntheticAsset(asset)) return [];

  const { baseCcy, quoteCcy } = inferAssetCurrencies(asset);
  const matches: Array<{ event: MarketEventItem; startMs: number }> = [];

  for (const ev of events) {
    if (!ev || ev.impact !== 'HIGH') continue;
    const startMs = Date.parse(ev.starts_at);
    if (!Number.isFinite(startMs)) continue;

    const ccy = (ev.currency || '').toUpperCase().trim();
    const matchesCurrency =
      ccy === 'ALL' ||
      (Boolean(ccy) && (ccy === baseCcy || ccy === quoteCcy)) ||
      (ccy === 'USD' &&
        (asset.type === 'CRYPTO' ||
          asset.type === 'COMMODITY' ||
          asset.type === 'INDEX' ||
          asset.type === 'STOCK'));

    if (matchesCurrency) {
      matches.push({ event: ev, startMs });
    }
  }

  return matches.sort((a, b) => a.startMs - b.startMs);
}

function isQuietSessionHour(
  marketContext: MarketContextSummary | null | undefined,
  utcHour: number,
  quietQuartile: number
): boolean {
  const hours = marketContext?.sessionProfile?.hours;
  if (!Array.isArray(hours) || hours.length === 0) return false;

  const populated = hours.filter(
    (h) => h.avgRangePips !== null && Number.isFinite(h.avgRangePips) && h.sampleCount > 0
  );
  if (populated.length < 4) return false;

  const sortedAsc = [...populated].sort(
    (a, b) => (a.avgRangePips ?? 0) - (b.avgRangePips ?? 0)
  );
  const quietCount = Math.max(1, Math.floor(sortedAsc.length * quietQuartile));
  const quietHoursSet = new Set(sortedAsc.slice(0, quietCount).map((h) => h.hourUtc));
  return quietHoursSet.has(utcHour);
}

function detectTrendDisagreement(marketContext: MarketContextSummary | null | undefined): boolean {
  const table = marketContext?.trendTable;
  if (!Array.isArray(table) || table.length === 0) return false;

  const targetTfs: ContextTimeframe[] = ['M15', 'H1', 'H4', 'D1'];
  const populatedDirs: TrendDirectionLabel[] = [];
  for (const tf of targetTfs) {
    const row = table.find((r) => r.timeframe === tf);
    if (row && row.sampleCount >= 5) {
      populatedDirs.push(row.direction);
    }
  }

  if (populatedDirs.length < 2) return false;
  return new Set(populatedDirs).size > 1;
}

export function assessConditions(input: AssessConditionsInput): ConditionsAssessment {
  const cfg = normalizeConditionsConfig(input.config);
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const nowDate = new Date(nowMs);
  const utcDay = nowDate.getUTCDay();
  const utcHour = nowDate.getUTCHours();

  const asset = input.asset;
  const reasons: ConditionReason[] = [];
  const addedCodes = new Set<ConditionReasonCode>();

  const pushReason = (code: ConditionReasonCode, severity: ConditionSeverity, text: string) => {
    if (addedCodes.has(code)) return;
    addedCodes.add(code);
    reasons.push({ code, severity, text });
  };

  // -----------------------------------------------------------------------
  // NOT_ADVISED RULES
  // -----------------------------------------------------------------------

  // 1. Market closed
  const explicitClosed = asset.exchange_is_open === false || input.feedStatus === 'MARKET_CLOSED';
  const weekendClosed =
    asset.exchange_is_open !== true && isWeekendMarketClosedUtc(asset, utcDay, utcHour);
  const isMarketClosed = explicitClosed || weekendClosed;

  if (isMarketClosed) {
    pushReason(
      'MARKET_CLOSED',
      'NOT_ADVISED',
      weekendClosed
        ? `${asset.name || asset.symbol} is closed for the weekend (opens Sunday 21:00 UTC).`
        : `${asset.name || asset.symbol} market is currently closed.`
    );
  }

  // 2. Feed status not LIVE or tick age > binary freshness window
  const feedStatusUpper = String(input.feedStatus || '').toUpperCase();
  if (feedStatusUpper !== 'LIVE' && feedStatusUpper !== 'MARKET_CLOSED') {
    pushReason(
      'FEED_NOT_LIVE',
      'NOT_ADVISED',
      feedStatusUpper === 'DELAYED'
        ? 'Live quote feed is delayed right now.'
        : `Price feed is not live (${feedStatusUpper || 'DISCONNECTED'}).`
    );
  }

  if (
    input.platformProfile === 'BINARY_QUICK' &&
    typeof input.tickAgeSeconds === 'number' &&
    Number.isFinite(input.tickAgeSeconds) &&
    input.tickAgeSeconds > cfg.binaryTickMaxAgeSec
  ) {
    pushReason(
      'TICK_STALE',
      'NOT_ADVISED',
      `Last tick is ${input.tickAgeSeconds.toFixed(1)}s old (limit is ${cfg.binaryTickMaxAgeSec}s for quick trades).`
    );
  }

  // 3. HIGH-impact scheduled event (±15m binary, ±30m MT5) -> NOT_ADVISED; (±60m) -> CAUTION
  const matchingEvents = findMatchingHighEvents(input.upcomingEvents, asset);
  const blockingNewsMinutes =
    input.platformProfile === 'MT5' ? cfg.mt5NewsWindowMinutes : cfg.binaryNewsWindowMinutes;
  const blockingNewsMs = blockingNewsMinutes * 60_000;
  const cautionNewsMs = cfg.cautionNewsWindowMinutes * 60_000;

  let blockingNewsEndMs: number | null = null;
  let cautionNewsEvent: { event: MarketEventItem; startMs: number } | null = null;

  for (const item of matchingEvents) {
    const diffMs = Math.abs(item.startMs - nowMs);
    if (diffMs <= blockingNewsMs) {
      pushReason(
        'HIGH_IMPACT_NEWS',
        'NOT_ADVISED',
        `High-impact ${item.event.currency} news (${item.event.title}) within ${blockingNewsMinutes} minutes.`
      );
      const windowEnd = item.startMs + blockingNewsMs;
      if (blockingNewsEndMs === null || windowEnd > blockingNewsEndMs) {
        blockingNewsEndMs = windowEnd;
      }
      break;
    } else if (diffMs <= cautionNewsMs && !cautionNewsEvent) {
      cautionNewsEvent = item;
    }
  }

  // 4. Weekday FX rollover window (21:00–00:00 UTC) for forex & metals
  const isRollover =
    !isMarketClosed &&
    isFxOrMetalAsset(asset) &&
    utcDay >= 1 &&
    utcDay <= 5 &&
    isHourInRolloverWindow(utcHour, cfg.rolloverStartHourUtc, cfg.rolloverEndHourUtc);

  if (isRollover) {
    pushReason(
      'ROLLOVER_WINDOW',
      'NOT_ADVISED',
      `Daily rollover (${pad2(cfg.rolloverStartHourUtc)}:00–${pad2(cfg.rolloverEndHourUtc % 24)}:00 UTC): wide spreads and thin liquidity.`
    );
  }

  // 5. Daily ATR percentile (<10 dead market, >95 extreme; 10-25 or 85-95 caution)
  const volRegime = input.marketContext?.volatilityRegime;
  const atrPct =
    volRegime &&
    typeof volRegime.percentile30d === 'number' &&
    Number.isFinite(volRegime.percentile30d) &&
    (volRegime.sampleCount ?? 0) > 0
      ? volRegime.percentile30d
      : null;

  if (atrPct !== null) {
    if (atrPct < cfg.atrPercentileLowBlock) {
      pushReason(
        'ATR_TOO_LOW',
        'NOT_ADVISED',
        `Market is unusually quiet (ATR ${Math.round(atrPct)}th percentile, below ${cfg.atrPercentileLowBlock}th).`
      );
    } else if (atrPct > cfg.atrPercentileHighBlock) {
      pushReason(
        'ATR_EXTREME',
        'NOT_ADVISED',
        `Volatility is extreme (ATR ${Math.round(atrPct)}th percentile, above ${cfg.atrPercentileHighBlock}th).`
      );
    } else if (atrPct >= cfg.atrPercentileLowBlock && atrPct <= cfg.atrPercentileLowCautionMax) {
      pushReason(
        'ATR_LOW_CAUTION',
        'CAUTION',
        `Market activity is muted (ATR ${Math.round(atrPct)}th percentile).`
      );
    } else if (atrPct >= cfg.atrPercentileHighCautionMin && atrPct <= cfg.atrPercentileHighBlock) {
      pushReason(
        'ATR_HIGH_CAUTION',
        'CAUTION',
        `Volatility is elevated (ATR ${Math.round(atrPct)}th percentile).`
      );
    }
  }

  // 6. User consecutive losses & daily loss limit
  const consecutiveLosses = Math.max(0, Number(input.userState?.consecutiveLosses ?? 0));
  if (consecutiveLosses >= cfg.maxConsecutiveLosses) {
    pushReason(
      'CONSECUTIVE_LOSSES',
      'NOT_ADVISED',
      `${consecutiveLosses} consecutive losses recorded. Pause before scanning again.`
    );
  }

  const dailyCount = Math.max(0, Number(input.userState?.dailyLossesCount ?? 0));
  const dailyCountLimit = input.userState?.dailyLossLimitCount;
  const dailyUsd = Math.max(0, Number(input.userState?.dailyLossUsd ?? 0));
  const dailyUsdLimit = input.userState?.dailyLossLimitUsd;

  const hitCountLimit =
    typeof dailyCountLimit === 'number' &&
    Number.isFinite(dailyCountLimit) &&
    dailyCountLimit > 0 &&
    dailyCount >= dailyCountLimit;
  const hitUsdLimit =
    typeof dailyUsdLimit === 'number' &&
    Number.isFinite(dailyUsdLimit) &&
    dailyUsdLimit > 0 &&
    dailyUsd >= dailyUsdLimit;

  if (hitCountLimit || hitUsdLimit) {
    pushReason(
      'DAILY_LOSS_LIMIT',
      'NOT_ADVISED',
      'You have reached your daily loss limit.'
    );
  }

  // 7. Synthetic index -> NOT_ADVISED ("Practice only: random by design")
  if (isSyntheticAsset(asset)) {
    pushReason('SYNTHETIC_PRACTICE_ONLY', 'NOT_ADVISED', 'Practice only: random by design');
  }

  // -----------------------------------------------------------------------
  // CAUTION RULES
  // -----------------------------------------------------------------------

  // 8. Quietest quartile of asset's session profile
  if (!isMarketClosed && !isRollover && isQuietSessionHour(input.marketContext, utcHour, cfg.quietSessionQuartile)) {
    pushReason(
      'QUIET_SESSION_HOUR',
      'CAUTION',
      `${pad2(utcHour)}:00 UTC is typically in the quietest quarter of hours for ${asset.name || asset.symbol}.`
    );
  }

  // 9. HIGH-impact event within 60 minutes (outside tighter blocking window)
  if (cautionNewsEvent) {
    pushReason(
      'UPCOMING_HIGH_NEWS',
      'CAUTION',
      `High-impact ${cautionNewsEvent.event.currency} news (${cautionNewsEvent.event.title}) within ${cfg.cautionNewsWindowMinutes} minutes.`
    );
  }

  // 10. M15, H1, H4, D1 trends disagree
  if (detectTrendDisagreement(input.marketContext)) {
    pushReason(
      'TREND_DISAGREEMENT',
      'CAUTION',
      'M15, H1, H4, and D1 trends do not agree.'
    );
  }

  // 11. Friday after 19:00 UTC (non-24/7 markets while still open)
  if (!isMarketClosed && !is24x7MarketAsset(asset) && utcDay === 5 && utcHour >= cfg.fridayCutoffHourUtc) {
    pushReason(
      'FRIDAY_LATE_SESSION',
      'CAUTION',
      `Friday after ${pad2(cfg.fridayCutoffHourUtc)}:00 UTC: liquidity thins ahead of the weekend close.`
    );
  }

  // Sort NOT_ADVISED reasons first, then CAUTION reasons
  reasons.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'NOT_ADVISED' ? -1 : 1;
  });

  const hasNotAdvised = reasons.some((r) => r.severity === 'NOT_ADVISED');
  const hasCaution = reasons.some((r) => r.severity === 'CAUTION');
  const level: ConditionLevel = hasNotAdvised ? 'NOT_ADVISED' : hasCaution ? 'CAUTION' : 'OK';

  // -----------------------------------------------------------------------
  // Next better window text (deterministic, when known)
  // -----------------------------------------------------------------------
  let nextBetterWindowText: string | undefined;

  if (level !== 'OK') {
    if (addedCodes.has('MARKET_CLOSED')) {
      if (weekendClosed) {
        nextBetterWindowText = 'Sunday 21:00 UTC (market reopen)';
      } else if (isFxOrMetalAsset(asset) && utcHour < 7) {
        nextBetterWindowText = '07:00 UTC (London session open)';
      }
    } else if (addedCodes.has('ROLLOVER_WINDOW')) {
      nextBetterWindowText = `${pad2(cfg.rolloverEndHourUtc % 24)}:00 UTC (after FX rollover)`;
    } else if (addedCodes.has('HIGH_IMPACT_NEWS') && blockingNewsEndMs !== null) {
      nextBetterWindowText = `${formatUtcHHMM(blockingNewsEndMs)} UTC (after news window)`;
    } else if (addedCodes.has('UPCOMING_HIGH_NEWS') && cautionNewsEvent) {
      const endMs = cautionNewsEvent.startMs + blockingNewsMs;
      nextBetterWindowText = `${formatUtcHHMM(endMs)} UTC (after news window)`;
    } else if (addedCodes.has('FRIDAY_LATE_SESSION')) {
      nextBetterWindowText = 'Sunday 21:00 UTC (next weekly open)';
    } else if (addedCodes.has('QUIET_SESSION_HOUR')) {
      const mostActive = input.marketContext?.sessionProfile?.mostActiveHour;
      if (mostActive && mostActive.sampleCount > 0) {
        nextBetterWindowText = `${pad2(mostActive.hourUtc)}:00 UTC (most active historical hour)`;
      } else if (!is24x7MarketAsset(asset) && utcHour < 7) {
        nextBetterWindowText = '07:00 UTC (London session open)';
      } else if (!is24x7MarketAsset(asset) && utcHour >= 17) {
        nextBetterWindowText = '07:00 UTC (London session open)';
      }
    } else if (addedCodes.has('DAILY_LOSS_LIMIT')) {
      nextBetterWindowText = '00:00 UTC tomorrow (daily limit reset)';
    }
  }

  return {
    level,
    reasons,
    nextBetterWindowText,
  };
}

export interface AnalyseGateInput {
  level: ConditionLevel;
  reasons: ConditionReason[];
  overrideArmed: boolean;
  isHardTechnicalBlock: boolean;
  hardBlockLabel?: string;
  normalLabel: string;
}

export interface AnalyseGateState {
  disabled: boolean;
  requiresOverrideTap: boolean;
  overrideArmed: boolean;
  buttonLabel: string;
  action: 'BLOCKED' | 'ARM_OVERRIDE' | 'RUN_WITH_OVERRIDE' | 'RUN_NORMAL';
}

export const OVERRIDE_BUTTON_LABEL = 'I understand the risk, analyse anyway';

export function resolveAnalyseGateState(input: AnalyseGateInput): AnalyseGateState {
  if (input.isHardTechnicalBlock) {
    return {
      disabled: true,
      requiresOverrideTap: false,
      overrideArmed: false,
      buttonLabel: input.hardBlockLabel || input.normalLabel,
      action: 'BLOCKED',
    };
  }

  if (input.level === 'NOT_ADVISED') {
    if (!input.overrideArmed) {
      return {
        disabled: false,
        requiresOverrideTap: true,
        overrideArmed: false,
        buttonLabel: input.normalLabel,
        action: 'ARM_OVERRIDE',
      };
    }
    return {
      disabled: false,
      requiresOverrideTap: true,
      overrideArmed: true,
      buttonLabel: OVERRIDE_BUTTON_LABEL,
      action: 'RUN_WITH_OVERRIDE',
    };
  }

  return {
    disabled: false,
    requiresOverrideTap: false,
    overrideArmed: false,
    buttonLabel: input.normalLabel,
    action: 'RUN_NORMAL',
  };
}

export function pickConsistentWaitReason(
  engineWaitReason: string,
  assessment: ConditionsAssessment | null | undefined,
  blockerCode?: string
): string {
  if (!assessment || assessment.reasons.length === 0) {
    return engineWaitReason;
  }

  const byCode = (code: ConditionReasonCode) =>
    assessment.reasons.find((r) => r.code === code)?.text;

  const upperBlocker = String(blockerCode || '').toUpperCase();
  if (upperBlocker === 'HIGH_IMPACT_NEWS') {
    return byCode('HIGH_IMPACT_NEWS') || engineWaitReason;
  }
  if (upperBlocker === 'MARKET_CLOSED') {
    return byCode('MARKET_CLOSED') || engineWaitReason;
  }
  if (upperBlocker === 'FEED_UNHEALTHY') {
    return byCode('TICK_STALE') || byCode('FEED_NOT_LIVE') || engineWaitReason;
  }
  if (upperBlocker === 'LOW_LIQUIDITY_SESSION' || upperBlocker === 'ROLLOVER_WINDOW') {
    return byCode('ROLLOVER_WINDOW') || byCode('MARKET_CLOSED') || engineWaitReason;
  }

  const lowerReason = engineWaitReason.toLowerCase();
  if (lowerReason.includes('rollover')) {
    return byCode('ROLLOVER_WINDOW') || engineWaitReason;
  }
  if (lowerReason.includes('market closed') || lowerReason.includes('weekend close')) {
    return byCode('MARKET_CLOSED') || engineWaitReason;
  }
  if (lowerReason.includes('high-impact') || lowerReason.includes('news')) {
    return byCode('HIGH_IMPACT_NEWS') || engineWaitReason;
  }
  if (lowerReason.includes('feed') || lowerReason.includes('tick')) {
    return byCode('TICK_STALE') || byCode('FEED_NOT_LIVE') || engineWaitReason;
  }

  return engineWaitReason;
}
