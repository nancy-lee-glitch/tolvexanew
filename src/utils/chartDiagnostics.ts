/**
 * chartDiagnostics.ts — Pure chart metrics, empty-state overlay rules,
 * and live chart diagnostics store for DebugDiagnosticsPanel (?debug=1).
 */

import type { FeedHealthStatus } from '../services/derivFeed.ts';
import { getAssetTimestampedTicks } from './quantEngine.ts';

export interface ChartFooterMetrics {
  changePrice: number;
  changePips: number;
  changePct: number;
  high: number;
  low: number;
  totalBars: number;
  timespanMinutes: number;
}

export interface ComputeLiveTickMetricsInput {
  open: number;
  close: number;
  high: number;
  low: number;
  firstTimeSec: number;
  lastTimeSec: number;
  pointCount: number;
  pipSize: number;
}

export function computeLiveTickMetrics(input: ComputeLiveTickMetricsInput): ChartFooterMetrics {
  const { open, close, high, low, firstTimeSec, lastTimeSec, pointCount, pipSize } = input;
  if (pointCount <= 0 || !Number.isFinite(close) || close <= 0) {
    return {
      changePrice: 0,
      changePips: 0,
      changePct: 0,
      high: Number.isFinite(close) ? close : 0,
      low: Number.isFinite(close) ? close : 0,
      totalBars: 0,
      timespanMinutes: 0,
    };
  }

  const safeOpen = Number.isFinite(open) && open > 0 ? open : close;
  const safePip = Number.isFinite(pipSize) && pipSize > 0 ? pipSize : 0.0001;
  const change = close - safeOpen;
  const pips = parseFloat((change / safePip).toFixed(1));
  const pct = parseFloat(((change / safeOpen) * 100).toFixed(2));
  const spanMin =
    Number.isFinite(firstTimeSec) && Number.isFinite(lastTimeSec) && lastTimeSec >= firstTimeSec
      ? Math.round((lastTimeSec - firstTimeSec) / 60)
      : 0;

  return {
    changePrice: Number.isFinite(change) ? change : 0,
    changePips: Number.isFinite(pips) ? pips : 0,
    changePct: Number.isFinite(pct) ? pct : 0,
    high: Number.isFinite(high) && high > 0 ? high : close,
    low: Number.isFinite(low) && low > 0 ? low : close,
    totalBars: pointCount,
    timespanMinutes: Number.isFinite(spanMin) ? Math.max(0, spanMin) : 0,
  };
}

export type ChartEmptyOverlayKind = 'MARKET_CLOSED' | 'LOADING' | 'EMPTY_TIMEOUT';

export interface ChartEmptyOverlayState {
  visible: boolean;
  kind: ChartEmptyOverlayKind | null;
  message: string | null;
  showRetry: boolean;
}

export function resolveChartEmptyOverlayState(params: {
  pointCount: number;
  feedStatus?: FeedHealthStatus | string | null;
  elapsedMs: number;
}): ChartEmptyOverlayState {
  const { pointCount, feedStatus, elapsedMs } = params;
  if (pointCount > 0) {
    return {
      visible: false,
      kind: null,
      message: null,
      showRetry: false,
    };
  }

  if (String(feedStatus || '').toUpperCase() === 'MARKET_CLOSED') {
    return {
      visible: true,
      kind: 'MARKET_CLOSED',
      message: 'Market closed',
      showRetry: false,
    };
  }

  if (elapsedMs < 8000) {
    return {
      visible: true,
      kind: 'LOADING',
      message: 'Loading price history...',
      showRetry: false,
    };
  }

  return {
    visible: true,
    kind: 'EMPTY_TIMEOUT',
    message: 'No price data yet. Check your connection or pick another asset.',
    showRetry: true,
  };
}

export interface ChartDiagnosticsSnapshot {
  activeSymbol: string;
  bufferTickCount: number;
  seriesPointCount: number;
  wsConnected: boolean;
  selectedInterval: string;
  lastUpdateAtMs: number | null;
}

const DEFAULT_CHART_DIAGNOSTICS: ChartDiagnosticsSnapshot = {
  activeSymbol: '',
  bufferTickCount: 0,
  seriesPointCount: 0,
  wsConnected: false,
  selectedInterval: 'tick',
  lastUpdateAtMs: null,
};

let currentChartDiag: ChartDiagnosticsSnapshot = { ...DEFAULT_CHART_DIAGNOSTICS };
const chartDiagListeners = new Set<(snap: ChartDiagnosticsSnapshot) => void>();

export function reportChartDiagnostics(
  patch: Partial<Omit<ChartDiagnosticsSnapshot, 'bufferTickCount'>> & { bufferTickCount?: number }
): void {
  const nextSymbol = patch.activeSymbol !== undefined ? patch.activeSymbol : currentChartDiag.activeSymbol;
  const computedBufferCount =
    patch.bufferTickCount !== undefined
      ? patch.bufferTickCount
      : nextSymbol
      ? getAssetTimestampedTicks(nextSymbol).length
      : 0;

  currentChartDiag = {
    ...currentChartDiag,
    ...patch,
    activeSymbol: nextSymbol,
    bufferTickCount: computedBufferCount,
  };

  const snap = getChartDiagnosticsSnapshot();
  for (const listener of chartDiagListeners) {
    try {
      listener(snap);
    } catch {
      // Ignore listener errors in diagnostics store
    }
  }
}

export function getChartDiagnosticsSnapshot(): ChartDiagnosticsSnapshot {
  const sym = currentChartDiag.activeSymbol;
  const liveBufferCount = sym ? getAssetTimestampedTicks(sym).length : currentChartDiag.bufferTickCount;
  return {
    ...currentChartDiag,
    bufferTickCount: liveBufferCount,
  };
}

export function subscribeChartDiagnostics(
  listener: (snap: ChartDiagnosticsSnapshot) => void
): () => void {
  chartDiagListeners.add(listener);
  listener(getChartDiagnosticsSnapshot());
  return () => {
    chartDiagListeners.delete(listener);
  };
}

export function formatChartLastUpdateTime(lastUpdateAtMs: number | null): string {
  if (lastUpdateAtMs === null || !Number.isFinite(lastUpdateAtMs) || lastUpdateAtMs <= 0) {
    return 'Never';
  }
  return new Date(lastUpdateAtMs).toISOString();
}

export function formatChartDiagnosticsLines(snap: ChartDiagnosticsSnapshot): string[] {
  return [
    'CHART',
    `Active Symbol: ${snap.activeSymbol || 'N/A'}`,
    `Buffer Ticks (${snap.activeSymbol || 'none'}): ${snap.bufferTickCount}`,
    `Chart Series Points: ${snap.seriesPointCount}`,
    `Chart wsConnected: ${String(snap.wsConnected)}`,
    `Selected Interval: ${snap.selectedInterval || 'tick'}`,
    `Last Chart Update: ${formatChartLastUpdateTime(snap.lastUpdateAtMs)}`,
  ];
}

export function resetChartDiagnosticsForTest(): void {
  currentChartDiag = { ...DEFAULT_CHART_DIAGNOSTICS };
}

export function computeTickVelocityLabel(params: {
  tickTimestampsMs: number[];
  nowMs: number;
  windowStartMs: number;
  windowMs?: number;
}): { rate: number; label: string } {
  const windowMs = params.windowMs ?? 10_000;
  const cutoff = params.nowMs - windowMs;
  const recentCount = params.tickTimestampsMs.filter(
    (t) => Number.isFinite(t) && t >= cutoff && t <= params.nowMs
  ).length;
  const elapsedSec = Math.min(
    windowMs / 1000,
    Math.max(1, (params.nowMs - params.windowStartMs) / 1000)
  );
  const rate = recentCount / elapsedSec;
  const formatted = rate.toFixed(1);
  if (rate > 6) {
    return { rate, label: `High (${formatted} t/s)` };
  }
  if (rate > 2) {
    return { rate, label: `Active (${formatted} t/s)` };
  }
  return { rate, label: `Steady (${formatted} t/s)` };
}
