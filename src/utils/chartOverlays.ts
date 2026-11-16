/**
 * chartOverlays.ts — Pure, deterministic conversion from Binary/MT5 signals,
 * Market Context levels, and VIP signal history into lightweight-charts overlay descriptors.
 *
 * Zero Math.random, zero DOM dependencies, safe for both React and Node/tsx unit tests.
 */

import type { DistanceUnit } from '../types.ts';
import type { MarketContextSummary } from './engines/marketContext.ts';
import type { BinarySignalOutput, MT5SignalOutput } from './engines/types.ts';

export type EngineChartSignal = MT5SignalOutput | BinarySignalOutput;
export type ChartOverlayLineStyle = 'solid' | 'dashed' | 'dotted';
export type ChartOverlayRole =
  | 'entry'
  | 'entry_zone_min'
  | 'entry_zone_max'
  | 'sl'
  | 'tp1'
  | 'tp2'
  | 'key_level'
  | 'binary_marker'
  | 'history_marker';

export interface ChartOverlay {
  id: string;
  type: 'priceLine' | 'marker';
  role: ChartOverlayRole;
  price: number;
  label: string;
  style: ChartOverlayLineStyle;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  axisLabelVisible: boolean;
  time?: number;
  position?: 'aboveBar' | 'belowBar';
  shape?: 'arrowUp' | 'arrowDown';
  size?: number;
  pipsFromEntry?: number | null;
  tooltip?: string;
}

export interface ChartHistorySignalItem {
  id: string;
  asset: string;
  direction: 'CALL' | 'PUT' | 'BUY' | 'SELL' | 'WAIT';
  entryPrice: number;
  timeframe: string;
  createdAt: string;
  outcome?: 'WIN' | 'LOSS' | 'DRAW' | null;
}

export interface BuildSignalOverlayOptions {
  compact?: boolean;
  distanceUnit?: DistanceUnit;
}

function formatShortDistance(
  pips: number | null | undefined,
  signed: '+' | '-' | '',
  unit: DistanceUnit = 'pips'
): string {
  if (typeof pips !== 'number' || !Number.isFinite(pips) || pips <= 0) return '';
  const absVal = Math.abs(pips);
  const formatted = Number.isInteger(absVal) ? String(absVal) : absVal.toFixed(1);
  return `${signed}${formatted}${unit === 'points' ? ' pts' : 'p'}`;
}

/**
 * Pure function converting an MT5 or Binary engine output into chart overlays.
 * Returns [] for null or WAIT signals.
 */
export function buildSignalChartOverlays(
  signal: EngineChartSignal | null | undefined,
  options: BuildSignalOverlayOptions = {}
): ChartOverlay[] {
  if (!signal || signal.direction === 'WAIT') {
    return [];
  }

  const compact = Boolean(options.compact);
  const unit: DistanceUnit = options.distanceUnit || signal.distanceUnit || 'pips';

  if (signal.profile === 'MT5') {
    const overlays: ChartOverlay[] = [];
    const hasDistinctZone =
      signal.orderKind === 'LIMIT' &&
      signal.entryZone !== null &&
      typeof signal.entryZone.min === 'number' &&
      typeof signal.entryZone.max === 'number' &&
      Math.abs(signal.entryZone.max - signal.entryZone.min) > 0;

    if (hasDistinctZone && signal.entryZone) {
      overlays.push({
        id: 'mt5-entry-zone-min',
        type: 'priceLine',
        role: 'entry_zone_min',
        price: signal.entryZone.min,
        label: compact ? 'Entry L' : 'Entry Zone Low',
        style: 'solid',
        color: '#38bdf8',
        lineWidth: 1,
        axisLabelVisible: false,
      });
      overlays.push({
        id: 'mt5-entry-zone-max',
        type: 'priceLine',
        role: 'entry_zone_max',
        price: signal.entryZone.max,
        label: compact ? 'Entry H' : 'Entry Zone High',
        style: 'solid',
        color: '#38bdf8',
        lineWidth: 1,
        axisLabelVisible: true,
      });
    } else if (typeof signal.entryPrice === 'number' && Number.isFinite(signal.entryPrice) && signal.entryPrice > 0) {
      overlays.push({
        id: 'mt5-entry',
        type: 'priceLine',
        role: 'entry',
        price: signal.entryPrice,
        label: 'Entry',
        style: 'solid',
        color: '#38bdf8',
        lineWidth: 2,
        axisLabelVisible: true,
      });
    }

    if (typeof signal.stopLoss === 'number' && Number.isFinite(signal.stopLoss) && signal.stopLoss > 0) {
      const slTag = formatShortDistance(signal.stopLossPips, '-', unit);
      overlays.push({
        id: 'mt5-sl',
        type: 'priceLine',
        role: 'sl',
        price: signal.stopLoss,
        label: slTag ? (compact ? `SL ${slTag}` : `SL (${slTag})`) : 'SL',
        style: 'dashed',
        color: '#f43f5e',
        lineWidth: 2,
        axisLabelVisible: true,
        pipsFromEntry: signal.stopLossPips,
      });
    }

    if (typeof signal.takeProfit1 === 'number' && Number.isFinite(signal.takeProfit1) && signal.takeProfit1 > 0) {
      const tp1Tag = formatShortDistance(signal.takeProfit1Pips, '+', unit);
      overlays.push({
        id: 'mt5-tp1',
        type: 'priceLine',
        role: 'tp1',
        price: signal.takeProfit1,
        label: tp1Tag ? (compact ? `TP1 ${tp1Tag}` : `TP1 (${tp1Tag})`) : 'TP1',
        style: 'dashed',
        color: '#10b981',
        lineWidth: 2,
        axisLabelVisible: true,
        pipsFromEntry: signal.takeProfit1Pips,
      });
    }

    if (typeof signal.takeProfit2 === 'number' && Number.isFinite(signal.takeProfit2) && signal.takeProfit2 > 0) {
      const tp2Tag = formatShortDistance(signal.takeProfit2Pips, '+', unit);
      overlays.push({
        id: 'mt5-tp2',
        type: 'priceLine',
        role: 'tp2',
        price: signal.takeProfit2,
        label: tp2Tag ? (compact ? `TP2 ${tp2Tag}` : `TP2 (${tp2Tag})`) : 'TP2',
        style: 'dashed',
        color: '#34d399',
        lineWidth: 1,
        axisLabelVisible: !compact,
        pipsFromEntry: signal.takeProfit2Pips,
      });
    }

    return overlays;
  }

  // Binary Quick Expiry Signal (CALL or PUT)
  const isCall = signal.direction === 'CALL';
  const markerTimeSec = Math.floor((signal.generatedAt || Date.parse(signal.createdAt)) / 1000);
  const overlays: ChartOverlay[] = [
    {
      id: `bin-marker-${markerTimeSec}`,
      type: 'marker',
      role: 'binary_marker',
      price: signal.entryPrice,
      label: signal.direction,
      style: 'solid',
      color: isCall ? '#10b981' : '#f43f5e',
      lineWidth: 1,
      axisLabelVisible: false,
      time: markerTimeSec,
      position: isCall ? 'belowBar' : 'aboveBar',
      shape: isCall ? 'arrowUp' : 'arrowDown',
      size: 2,
      tooltip: `${signal.direction} (${signal.expiry}) @ ${signal.entryPrice}`,
    },
  ];

  if (typeof signal.entryPrice === 'number' && Number.isFinite(signal.entryPrice) && signal.entryPrice > 0) {
    overlays.push({
      id: 'bin-entry',
      type: 'priceLine',
      role: 'entry',
      price: signal.entryPrice,
      label: 'Entry',
      style: 'solid',
      color: isCall ? '#10b981' : '#f43f5e',
      lineWidth: 2,
      axisLabelVisible: true,
    });
  }

  return overlays;
}

function shortLevelLabel(id: string, fallbackLabel: string): string {
  switch (id) {
    case 'pdh':
      return 'PDH';
    case 'pdl':
      return 'PDL';
    case 'pwh':
      return 'PWH';
    case 'pwl':
      return 'PWL';
    case 'pp':
      return 'PP';
    case 'r1':
      return 'R1';
    case 'r2':
      return 'R2';
    case 's1':
      return 'S1';
    case 's2':
      return 'S2';
    case 'swing_h':
      return 'H1 Swing H';
    case 'swing_l':
      return 'H1 Swing L';
    default:
      if (id.startsWith('round_')) {
        const match = fallbackLabel.match(/\(([^)]+)\)/);
        return match ? `Rnd ${match[1]}` : 'Round';
      }
      return fallbackLabel.slice(0, 12);
  }
}

/**
 * Converts Market Context key levels (PDH/PDL, PWH/PWL, daily pivots, round numbers)
 * into faint dotted price lines ordered nearest-to-price first, capped at maxLevels (default 8).
 */
export function buildKeyLevelOverlays(
  marketContext: MarketContextSummary | null | undefined,
  currentPrice: number | null | undefined,
  maxLevels = 8
): ChartOverlay[] {
  if (!marketContext || !Array.isArray(marketContext.levelsMap) || marketContext.levelsMap.length === 0) {
    return [];
  }

  const refPrice =
    typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : marketContext.currentPrice;

  const preferredGroups = new Set(['Daily Range', 'Weekly Range', 'Daily Pivot', 'Round Number']);
  const primary = marketContext.levelsMap.filter((lvl) => preferredGroups.has(lvl.group));
  const candidates = primary.length > 0 ? primary : marketContext.levelsMap;

  const sorted = [...candidates]
    .filter((lvl) => Number.isFinite(lvl.price) && lvl.price > 0)
    .sort((a, b) => Math.abs(a.price - refPrice) - Math.abs(b.price - refPrice))
    .slice(0, Math.max(1, maxLevels));

  return sorted.map((lvl) => ({
    id: `lvl-${lvl.id}`,
    type: 'priceLine',
    role: 'key_level',
    price: lvl.price,
    label: shortLevelLabel(lvl.id, lvl.label),
    style: 'dotted',
    color: 'rgba(148, 163, 184, 0.35)',
    lineWidth: 1,
    axisLabelVisible: false,
    tooltip: lvl.plainText,
  }));
}

/**
 * Builds chart markers for a VIP user's historical signals on the active asset.
 * Returns [] for non-VIP users.
 */
export function buildHistoryMarkerOverlays(
  historySignals: ChartHistorySignalItem[],
  isVip: boolean
): ChartOverlay[] {
  if (!isVip || !Array.isArray(historySignals) || historySignals.length === 0) {
    return [];
  }

  const out: ChartOverlay[] = [];
  for (const item of historySignals) {
    if (!item || item.direction === 'WAIT') continue;
    const epochMs = Date.parse(item.createdAt);
    if (!Number.isFinite(epochMs)) continue;
    const timeSec = Math.floor(epochMs / 1000);
    const isBull = item.direction === 'CALL' || item.direction === 'BUY';
    const outcomeText = item.outcome ? item.outcome : 'Pending';
    const color =
      item.outcome === 'WIN'
        ? '#10b981'
        : item.outcome === 'LOSS'
        ? '#f43f5e'
        : isBull
        ? '#38bdf8'
        : '#fbbf24';

    out.push({
      id: `hist-${item.id}`,
      type: 'marker',
      role: 'history_marker',
      price: item.entryPrice,
      label: item.outcome === 'WIN' ? `${item.direction} W` : item.outcome === 'LOSS' ? `${item.direction} L` : item.direction,
      style: 'solid',
      color,
      lineWidth: 1,
      axisLabelVisible: false,
      time: timeSec,
      position: isBull ? 'belowBar' : 'aboveBar',
      shape: isBull ? 'arrowUp' : 'arrowDown',
      size: 1,
      tooltip: `${item.direction} (${item.timeframe.toUpperCase()}) @ ${item.entryPrice} · Outcome: ${outcomeText}`,
    });
  }

  return out.sort((a, b) => (a.time || 0) - (b.time || 0));
}

/**
 * Checks whether an active directional chart signal has expired or hit MT5 invalidation.
 * Returns false for WAIT or null so "No setup" remains visible until cleared/asset switched.
 */
export function isChartSignalExpiredOrInvalidated(
  signal: EngineChartSignal | null | undefined,
  currentPrice: number | null | undefined,
  nowMs: number
): boolean {
  if (!signal || signal.direction === 'WAIT') {
    return false;
  }

  if (signal.profile === 'BINARY_QUICK') {
    const expiryMs = (signal.generatedAt || Date.parse(signal.createdAt)) + signal.expirySeconds * 1000;
    return Number.isFinite(expiryMs) && nowMs >= expiryMs;
  }

  // MT5 validity window expiry
  const validUntilMs = Date.parse(signal.validUntil);
  if (Number.isFinite(validUntilMs) && nowMs >= validUntilMs) {
    return true;
  }

  // MT5 structural invalidation trigger
  if (
    typeof signal.invalidationLevel === 'number' &&
    signal.invalidationLevel > 0 &&
    typeof currentPrice === 'number' &&
    Number.isFinite(currentPrice) &&
    currentPrice > 0
  ) {
    if (signal.direction === 'BUY' && currentPrice <= signal.invalidationLevel) {
      return true;
    }
    if (signal.direction === 'SELL' && currentPrice >= signal.invalidationLevel) {
      return true;
    }
  }

  return false;
}

/**
 * Snaps an arbitrary Unix epoch timestamp (seconds) to an existing series bar time
 * so lightweight-charts renders the marker on the correct candle/tick.
 */
export function snapTimestampToSeries(
  targetSec: number,
  seriesTimes: number[],
  maxDistanceSec = 86400 * 7
): number | null {
  if (!Number.isFinite(targetSec) || seriesTimes.length === 0) {
    return null;
  }
  const first = seriesTimes[0];
  const last = seriesTimes[seriesTimes.length - 1];
  if (targetSec < first - maxDistanceSec || targetSec > last + maxDistanceSec) {
    return null;
  }
  if (targetSec >= last) {
    return last;
  }
  // Binary search for largest seriesTime <= targetSec
  let lo = 0;
  let hi = seriesTimes.length - 1;
  let best = first;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = seriesTimes[mid];
    if (t <= targetSec) {
      best = t;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
