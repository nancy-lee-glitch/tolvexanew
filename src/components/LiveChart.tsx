import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { AnalysisProfile, AssetConfig, SignalHistoryItem, TimestampedTick, UserProfile } from '../types.ts';
import type { MarketContextSummary } from '../utils/engines/marketContext.ts';
import type { FeedHealthStatus } from '../services/derivFeed.ts';
import type { Candle } from '../services/liveFeed.ts';
import { getOrFetchCandles, mergeTickIntoCandles } from '../services/candleStore.ts';
import { getOrInitializeTimestampedTicks } from '../utils/quantEngine.ts';
import { fetchUserAssetSignalMarkers } from '../utils/supabaseClient.ts';
import {
  buildHistoryMarkerOverlays,
  buildKeyLevelOverlays,
  buildSignalChartOverlays,
  isChartSignalExpiredOrInvalidated,
  snapTimestampToSeries,
  type ChartHistorySignalItem,
  type ChartOverlayLineStyle,
  type EngineChartSignal,
} from '../utils/chartOverlays.ts';

export type ChartType = 'line' | 'area' | 'candles';
export type AggregationInterval =
  | 'tick'
  | '5s'
  | '15s'
  | '1m'
  | 'M5'
  | 'M15'
  | 'H1'
  | 'H4'
  | 'D1';

type HistoricalInterval = 'M5' | 'M15' | 'H1' | 'H4' | 'D1';

const HISTORICAL_INTERVAL_SET = new Set<string>(['M5', 'M15', 'H1', 'H4', 'D1']);

function isHistoricalInterval(interval: AggregationInterval): interval is HistoricalInterval {
  return HISTORICAL_INTERVAL_SET.has(interval);
}

function toLineStyle(style: ChartOverlayLineStyle): LineStyle {
  switch (style) {
    case 'dashed':
      return LineStyle.Dashed;
    case 'dotted':
      return LineStyle.Dotted;
    case 'solid':
    default:
      return LineStyle.Solid;
  }
}

function formatRemainingMMSS(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadLocalVipHistoryForAsset(symbol: string, assetName: string, isVIP: boolean): ChartHistorySignalItem[] {
  if (!isVIP || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem('pulsetrade_signal_history');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SignalHistoryItem[];
    if (!Array.isArray(parsed)) return [];
    const targetNames = new Set([symbol, assetName].filter(Boolean).map((v) => v.toLowerCase()));
    const validDir = new Set(['CALL', 'PUT', 'BUY', 'SELL']);
    const items: ChartHistorySignalItem[] = [];
    for (const row of parsed.slice(0, 40)) {
      if (!row || !row.asset || !targetNames.has(String(row.asset).toLowerCase())) continue;
      const dir = String(row.direction || '').toUpperCase();
      if (!validDir.has(dir)) continue;
      if (typeof row.entryPrice !== 'number' || !Number.isFinite(row.entryPrice) || row.entryPrice <= 0) continue;
      const outcome = row.outcome === 'WIN' || row.outcome === 'LOSS' ? row.outcome : null;
      items.push({
        id: String(row.id || `local_${row.generatedAt}`),
        asset: String(row.asset),
        direction: dir as 'CALL' | 'PUT' | 'BUY' | 'SELL',
        entryPrice: row.entryPrice,
        timeframe: String(row.timeframe || ''),
        createdAt: new Date(row.generatedAt || Date.now()).toISOString(),
        outcome,
      });
    }
    return items;
  } catch {
    return [];
  }
}

interface LiveChartProps {
  activeAsset: AssetConfig;
  currentPrice: number;
  prevPrice?: number;
  pricePulse?: 'up' | 'down' | null;
  wsConnected: boolean;
  feedStatus?: FeedHealthStatus | string;
  signal?: EngineChartSignal | null;
  marketContext?: MarketContextSummary | null;
  analysisProfile?: AnalysisProfile;
  isVIP?: boolean;
  user?: UserProfile | null;
  onClearSignal?: () => void;
  onAssetChange?: (asset: AssetConfig) => void;
}

interface BarPoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface LinePoint {
  time: UTCTimestamp;
  value: number;
}

export function LiveChart({
  activeAsset,
  currentPrice,
  prevPrice = currentPrice,
  pricePulse = null,
  wsConnected,
  feedStatus = 'CONNECTING',
  signal = null,
  marketContext = null,
  analysisProfile = 'BINARY_QUICK',
  isVIP = false,
  user = null,
  onClearSignal,
}: LiveChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const seriesDataTimesRef = useRef<number[]>([]);
  const lastBarRef = useRef<BarPoint | null>(null);
  const markerTooltipsByIdRef = useRef<Map<string, string>>(new Map());
  const markerTooltipsByTimeRef = useRef<Map<number, string>>(new Map());
  const autoFollowRef = useRef<boolean>(true);
  const animationFrameRef = useRef<number | null>(null);
  const activeSymbolRef = useRef<string>(activeAsset.symbol);
  const lastAutoSelectedSignalIdRef = useRef<number>(0);

  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 640 : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setIsMobileViewport(window.innerWidth < 640);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    activeSymbolRef.current = activeAsset.symbol;
  }, [activeAsset.symbol]);

  const [chartType, setChartType] = useState<ChartType>('line');
  const [interval, setIntervalState] = useState<AggregationInterval>('tick');
  const effectiveProfile: AnalysisProfile = signal?.profile || analysisProfile || 'BINARY_QUICK';
  const [showLevels, setShowLevels] = useState<boolean>(() => effectiveProfile === 'MT5');

  // Auto-update Levels toggle default when switching between MT5 and Binary profile
  useEffect(() => {
    setShowLevels(effectiveProfile === 'MT5');
  }, [effectiveProfile]);

  const [isScrolledAway, setIsScrolledAway] = useState<boolean>(false);
  const [hoverData, setHoverData] = useState<{ price: string; time: string; tooltip?: string } | null>(null);
  const [useFallbackCanvas, setUseFallbackCanvas] = useState<boolean>(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [historyEmptyNote, setHistoryEmptyNote] = useState<string | null>(null);
  const [seriesRevision, setSeriesRevision] = useState<number>(0);
  const [vipHistorySignals, setVipHistorySignals] = useState<ChartHistorySignalItem[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Buffer summary metrics
  const [metrics, setMetrics] = useState({
    changePips: 0,
    changePct: 0,
    high: currentPrice || 0,
    low: currentPrice || 0,
    totalBars: 0,
    timespanMinutes: 0,
  });

  const decimals = activeAsset?.decimals ?? 5;
  const pipSize = activeAsset?.pipSize ?? 0.0001;

  // When an actionable MT5 signal arrives, preselect its structure timeframe + candles once
  useEffect(() => {
    if (
      signal &&
      signal.profile === 'MT5' &&
      signal.direction !== 'WAIT' &&
      signal.generatedAt !== lastAutoSelectedSignalIdRef.current
    ) {
      lastAutoSelectedSignalIdRef.current = signal.generatedAt;
      const targetTf: AggregationInterval = signal.structureTimeframe === 'M15' ? 'M15' : 'H1';
      setIntervalState(targetTf);
      setChartType('candles');
    }
  }, [signal]);

  // Countdown + expiry/invalidation watcher for active directional signals
  useEffect(() => {
    if (!signal || signal.direction === 'WAIT') {
      return;
    }

    const checkNow = Date.now();
    setNowMs(checkNow);
    if (isChartSignalExpiredOrInvalidated(signal, currentPrice, checkNow)) {
      onClearSignal?.();
      return;
    }

    const timer = window.setInterval(() => {
      const tickNow = Date.now();
      setNowMs(tickNow);
      if (isChartSignalExpiredOrInvalidated(signal, currentPrice, tickNow)) {
        onClearSignal?.();
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [signal, currentPrice, onClearSignal]);

  // Fetch VIP history signals for active asset (exclusively when isVIP === true)
  useEffect(() => {
    if (!isVIP) {
      setVipHistorySignals([]);
      return;
    }

    let cancelled = false;
    const targetSym = activeAsset.symbol;
    const localItems = loadLocalVipHistoryForAsset(targetSym, activeAsset.name, true);
    setVipHistorySignals(localItems);

    if (user?.id) {
      fetchUserAssetSignalMarkers(targetSym, activeAsset.name, user.id, true)
        .then((remoteItems) => {
          if (cancelled || activeSymbolRef.current !== targetSym) return;
          if (remoteItems.length === 0) return;

          // Merge DB records (authoritative for settled outcomes) with any very recent local entries
          const mergedMap = new Map<string, ChartHistorySignalItem>();
          for (const item of remoteItems) {
            mergedMap.set(item.id, item);
          }
          for (const local of localItems) {
            const localMs = Date.parse(local.createdAt);
            const duplicateNear = remoteItems.some(
              (r) =>
                r.direction === local.direction &&
                Math.abs(Date.parse(r.createdAt) - localMs) < 15_000
            );
            if (!duplicateNear) {
              mergedMap.set(local.id, local);
            }
          }
          setVipHistorySignals(Array.from(mergedMap.values()));
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [isVIP, user?.id, activeAsset.symbol, activeAsset.name, signal?.generatedAt]);

  // Handle timeframe clicks smoothly
  const handleSelectInterval = (nextInterval: AggregationInterval) => {
    setIntervalState(nextInterval);
    if (isHistoricalInterval(nextInterval)) {
      setChartType('candles');
    } else if (nextInterval === 'tick' && chartType === 'candles') {
      setChartType('line');
    }
  };

  // Calculate resolution seconds from interval
  const intervalSeconds = useMemo(() => {
    switch (interval) {
      case '5s':
        return 5;
      case '15s':
        return 15;
      case '1m':
        return 60;
      case 'M5':
        return 300;
      case 'M15':
        return 900;
      case 'H1':
        return 3600;
      case 'H4':
        return 14400;
      case 'D1':
        return 86400;
      case 'tick':
      default:
        return 1;
    }
  }, [interval]);

  // Client-side tick aggregation for Line & Area with strict ascending validation
  const buildLineData = useCallback((ticks: TimestampedTick[], stepSec: number): LinePoint[] => {
    if (!ticks || !Array.isArray(ticks) || ticks.length === 0) return [];
    const valid = ticks.filter(
      (t) => t && typeof t.price === 'number' && !isNaN(t.price) && typeof t.time === 'number' && !isNaN(t.time)
    );
    const sorted = [...valid].sort((a, b) => a.time - b.time);
    const points: LinePoint[] = [];
    let lastTime = -1;

    for (const t of sorted) {
      const bucket = Math.floor(stepSec > 1 ? Math.floor(t.time / stepSec) * stepSec : t.time);
      if (bucket > lastTime) {
        points.push({ time: bucket as UTCTimestamp, value: t.price });
        lastTime = bucket;
      } else if (bucket === lastTime && points.length > 0) {
        points[points.length - 1].value = t.price;
      }
    }
    return points;
  }, []);

  // Client-side tick aggregation for Candlesticks with strict ascending validation
  const buildCandleDataFromTicks = useCallback((ticks: TimestampedTick[], stepSec: number): BarPoint[] => {
    if (!ticks || !Array.isArray(ticks) || ticks.length === 0) return [];
    const valid = ticks.filter(
      (t) => t && typeof t.price === 'number' && !isNaN(t.price) && typeof t.time === 'number' && !isNaN(t.time)
    );
    const effectiveStep = Math.max(2, Math.floor(stepSec));
    const sorted = [...valid].sort((a, b) => a.time - b.time);
    const bars: BarPoint[] = [];
    let currentBar: BarPoint | null = null;

    for (const t of sorted) {
      const bucket = Math.floor(Math.floor(t.time / effectiveStep) * effectiveStep) as UTCTimestamp;
      if (!currentBar || currentBar.time !== bucket) {
        if (currentBar) {
          bars.push(currentBar);
        }
        currentBar = {
          time: bucket,
          open: t.price,
          high: t.price,
          low: t.price,
          close: t.price,
        };
      } else {
        currentBar.high = Math.max(currentBar.high, t.price);
        currentBar.low = Math.min(currentBar.low, t.price);
        currentBar.close = t.price;
      }
    }
    if (currentBar) {
      bars.push(currentBar);
    }
    return bars;
  }, []);

  // Convert OHLC Candle[] into chart BarPoint[] / LinePoint[]
  const updateSeriesFromCandles = useCallback(
    (rawCandles: Candle[], targetSeries: any, activeChartType: ChartType) => {
      if (!targetSeries || rawCandles.length === 0) return;
      const sorted = [...rawCandles]
        .filter(
          (c) =>
            Number.isFinite(c.time) &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close)
        )
        .sort((a, b) => a.time - b.time);

      const deduped: Candle[] = [];
      for (const c of sorted) {
        const sec = Math.floor(c.time);
        if (deduped.length > 0 && deduped[deduped.length - 1].time === sec) {
          deduped[deduped.length - 1] = { ...c, time: sec };
        } else {
          deduped.push({ ...c, time: sec });
        }
      }

      if (deduped.length === 0) return;

      const highs = deduped.map((c) => c.high);
      const lows = deduped.map((c) => c.low);
      const high = Math.max(...highs);
      const low = Math.min(...lows);
      const open = deduped[0].open;
      const close = deduped[deduped.length - 1].close;
      const change = close - open;
      const pips = parseFloat((change / pipSize).toFixed(1));
      const pct = parseFloat(((change / (open || 1)) * 100).toFixed(2));
      const spanMin = Math.round((deduped[deduped.length - 1].time - deduped[0].time) / 60);

      setMetrics({
        changePips: Number.isNaN(pips) ? 0 : pips,
        changePct: Number.isNaN(pct) ? 0 : pct,
        high,
        low,
        totalBars: deduped.length,
        timespanMinutes: Number.isNaN(spanMin) ? 0 : spanMin,
      });

      if (activeChartType === 'candles') {
        const bars: BarPoint[] = deduped.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        targetSeries.setData(bars);
        lastBarRef.current = bars[bars.length - 1] || null;
        seriesDataTimesRef.current = bars.map((b) => Number(b.time));
      } else {
        const linePts: LinePoint[] = deduped.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.close,
        }));
        targetSeries.setData(linePts);
        lastBarRef.current = null;
        seriesDataTimesRef.current = linePts.map((p) => Number(p.time));
      }

      setSeriesRevision((r) => r + 1);
    },
    [pipSize]
  );

  // Draw fallback HTML5 canvas if lightweight-charts fails to mount
  const drawFallbackChart = useCallback(
    (ticks: TimestampedTick[]) => {
      const canvas = fallbackCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      if (ticks.length < 2) return;
      const prices = ticks.map((t) => t.price);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const range = max - min || pipSize;

      ctx.beginPath();
      prices.forEach((val, idx) => {
        const x = (idx / (prices.length - 1)) * width;
        const y = height - ((val - min) / range) * (height - 16) - 8;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
      grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
      ctx.fillStyle = grad;
      ctx.fill();
    },
    [pipSize]
  );

  // Unified Chart Initialization and Data Binding
  useEffect(() => {
    if (!containerRef.current) return;

    let isDisposed = false;
    let chart: IChartApi | null = null;
    let rangeHandler: ((range: any) => void) | null = null;
    let crosshairHandler: ((param: any) => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const targetSymbol = activeAsset.symbol;
    const histMode = isHistoricalInterval(interval);
    setHistoryEmptyNote(null);
    setIsLoadingHistory(histMode);
    priceLinesRef.current = [];
    seriesDataTimesRef.current = [];
    lastBarRef.current = null;

    try {
      if (chartRef.current) {
        try {
          chartRef.current.remove();
        } catch {}
        chartRef.current = null;
        seriesRef.current = null;
      }

      const container = containerRef.current;
      container.innerHTML = '';
      const clientW = container.clientWidth;
      const width = clientW > 0 ? clientW : 360;
      const height = 250;

      chart = createChart(container, {
        width,
        height,
        layout: {
          background: { type: ColorType.Solid, color: '#090d16' },
          textColor: '#94a3b8',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle.SparseDotted },
          horzLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle.SparseDotted },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: '#38bdf8', width: 1, style: LineStyle.Dashed },
          horzLine: { color: '#38bdf8', width: 1, style: LineStyle.Dashed },
        },
        rightPriceScale: {
          borderColor: '#1e293b',
          scaleMargins: { top: 0.14, bottom: 0.14 },
          autoScale: true,
        },
        timeScale: {
          borderColor: '#1e293b',
          rightOffset: width < 640 ? 10 : 8,
          timeVisible: true,
          secondsVisible: interval === 'tick' || interval === '5s',
        },
      });

      chartRef.current = chart;

      const precision = Math.min(8, Math.max(2, decimals));
      const minMove = Math.pow(10, -precision);
      const priceFormat = { type: 'price' as const, precision, minMove };

      // Create series according to selected type
      let createdSeries: ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Candlestick'>;
      if (chartType === 'line') {
        createdSeries = chart.addLineSeries({
          color: '#10b981',
          lineWidth: 2,
          priceLineVisible: true,
          priceLineColor: '#10b981',
          priceLineWidth: 1,
          priceLineStyle: LineStyle.Dashed,
          lastValueVisible: true,
          priceFormat,
        });
      } else if (chartType === 'area') {
        createdSeries = chart.addAreaSeries({
          lineColor: '#10b981',
          topColor: 'rgba(16, 185, 129, 0.35)',
          bottomColor: 'rgba(16, 185, 129, 0.01)',
          lineWidth: 2,
          priceLineVisible: true,
          priceLineColor: '#10b981',
          lastValueVisible: true,
          priceFormat,
        });
      } else {
        createdSeries = chart.addCandlestickSeries({
          upColor: '#10b981',
          downColor: '#f43f5e',
          borderVisible: false,
          wickUpColor: '#10b981',
          wickDownColor: '#f43f5e',
          priceLineVisible: true,
          priceLineColor: '#10b981',
          lastValueVisible: true,
          priceFormat,
        });
      }

      seriesRef.current = createdSeries;

      if (!histMode) {
        const ticks = getOrInitializeTimestampedTicks(targetSymbol);

        if (ticks.length > 0) {
          const prices = ticks.map((t) => t.price);
          const high = Math.max(...prices);
          const low = Math.min(...prices);
          const open = ticks[0].price;
          const close = ticks[ticks.length - 1].price;
          const change = close - open;
          const pips = parseFloat((change / pipSize).toFixed(1));
          const pct = parseFloat(((change / (open || 1)) * 100).toFixed(2));
          const spanMin = Math.round((ticks[ticks.length - 1].time - ticks[0].time) / 60);

          setMetrics({
            changePips: isNaN(pips) ? 0 : pips,
            changePct: isNaN(pct) ? 0 : pct,
            high: isNaN(high) ? currentPrice : high,
            low: isNaN(low) ? currentPrice : low,
            totalBars: ticks.length,
            timespanMinutes: isNaN(spanMin) ? 0 : spanMin,
          });
        } else {
          setMetrics({
            changePips: 0,
            changePct: 0,
            high: currentPrice || 0,
            low: currentPrice || 0,
            totalBars: 0,
            timespanMinutes: 0,
          });
        }

        if (chartType === 'candles') {
          const data = buildCandleDataFromTicks(ticks, intervalSeconds);
          if (data.length > 0) {
            (createdSeries as ISeriesApi<'Candlestick'>).setData(data);
            lastBarRef.current = data[data.length - 1];
            seriesDataTimesRef.current = data.map((d) => Number(d.time));
          }
        } else {
          const data = buildLineData(ticks, intervalSeconds);
          if (data.length > 0) {
            (createdSeries as ISeriesApi<'Line'> | ISeriesApi<'Area'>).setData(data);
            seriesDataTimesRef.current = data.map((d) => Number(d.time));
          }
        }
        setSeriesRevision((r) => r + 1);
      } else {
        // Historical Candles (M5, M15, H1, H4, D1) from candleStore (Supabase cache + WS fallback)
        const barCount = interval === 'H1' ? 300 : interval === 'M5' ? 280 : interval === 'M15' ? 240 : 180;
        getOrFetchCandles(targetSymbol, interval, barCount)
          .then((candles) => {
            if (isDisposed || activeSymbolRef.current !== targetSymbol || !seriesRef.current) return;
            setIsLoadingHistory(false);
            if (!candles || candles.length === 0) {
              setHistoryEmptyNote(`No ${interval} candle history available yet`);
              setSeriesRevision((r) => r + 1);
              return;
            }
            const enriched =
              currentPrice > 0
                ? mergeTickIntoCandles(candles, { symbol: targetSymbol, price: currentPrice, epoch: Math.floor(Date.now() / 1000) }, intervalSeconds)
                : candles;
            updateSeriesFromCandles(enriched, seriesRef.current, chartType);
            try {
              chartRef.current?.timeScale().scrollToRealTime();
            } catch {}
          })
          .catch(() => {
            if (!isDisposed && activeSymbolRef.current === targetSymbol) {
              setIsLoadingHistory(false);
              setHistoryEmptyNote(`Unable to load ${interval} candle history`);
            }
          });
      }

      try {
        chart.timeScale().scrollToRealTime();
      } catch {}

      rangeHandler = (range: any) => {
        if (!range || isDisposed) return;
        const isAway = typeof range.to === 'number' && range.to < 0.95;
        setIsScrolledAway(isAway);
        autoFollowRef.current = !isAway;
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);

      crosshairHandler = (param: any) => {
        if (isDisposed) return;
        try {
          if (!param || !param.time || !param.seriesData || !seriesRef.current) {
            setHoverData(null);
            return;
          }
          const data = param.seriesData.get(seriesRef.current as any);
          if (data) {
            const p = 'value' in data ? (data as any).value : (data as any).close;
            if (typeof p === 'number' && !isNaN(p)) {
              const timeSec = typeof param.time === 'number' ? param.time : Math.floor(Date.now() / 1000);
              const d = new Date(timeSec * 1000);
              const timeStr = histMode
                ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

              const hoveredId = typeof param.hoveredObjectId === 'string' ? param.hoveredObjectId : '';
              const markerTooltip =
                (hoveredId ? markerTooltipsByIdRef.current.get(hoveredId) : undefined) ||
                markerTooltipsByTimeRef.current.get(timeSec);

              setHoverData({
                price: Number(p).toFixed(decimals),
                time: timeStr,
                tooltip: markerTooltip,
              });
            }
          }
        } catch {
          setHoverData(null);
        }
      };
      chart.subscribeCrosshairMove(crosshairHandler);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          if (isDisposed || !chartRef.current || !entries || entries.length === 0) return;
          const { width: newWidth } = entries[0].contentRect;
          if (newWidth > 50) {
            try {
              chartRef.current.applyOptions({
                width: newWidth,
                timeScale: {
                  rightOffset: newWidth < 640 ? 10 : 8,
                },
              });
            } catch {}
          }
        });
        resizeObserver.observe(container);
      }

      setUseFallbackCanvas(false);
    } catch (err) {
      console.warn('[LiveChart init warning, activating resilient fallback]', err);
      setUseFallbackCanvas(true);
      setIsLoadingHistory(false);
      const ticks = getOrInitializeTimestampedTicks(targetSymbol);
      drawFallbackChart(ticks);
    }

    return () => {
      isDisposed = true;
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      priceLinesRef.current = [];
      if (chart) {
        try {
          if (rangeHandler) chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler);
          if (crosshairHandler) chart.unsubscribeCrosshairMove(crosshairHandler);
          chart.remove();
        } catch {}
      }
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [
    activeAsset.symbol,
    chartType,
    interval,
    intervalSeconds,
    decimals,
    pipSize,
    buildLineData,
    buildCandleDataFromTicks,
    updateSeriesFromCandles,
    drawFallbackChart,
  ]);

  // Separate Overlay Sync Effect: MT5/Binary price lines, Key Levels, Binary Entry Marker, and VIP History Markers
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // 1) Remove previous price lines
    for (const oldLine of priceLinesRef.current) {
      try {
        series.removePriceLine(oldLine);
      } catch {}
    }
    priceLinesRef.current = [];

    // 2) Signal Overlays (MT5 Entry/SL/TP1/TP2 or Binary Entry + Marker; empty for WAIT/null)
    const signalOverlays = buildSignalChartOverlays(signal, { compact: isMobileViewport });

    // 3) Key Levels Overlays when toggled on
    const levelOverlays = showLevels ? buildKeyLevelOverlays(marketContext, currentPrice, 8) : [];

    // 4) Apply Price Lines
    const createdLines: IPriceLine[] = [];
    for (const ov of [...levelOverlays, ...signalOverlays]) {
      if (ov.type !== 'priceLine') continue;
      try {
        const line = series.createPriceLine({
          price: ov.price,
          color: ov.color,
          lineWidth: ov.lineWidth,
          lineStyle: toLineStyle(ov.style),
          axisLabelVisible: ov.axisLabelVisible,
          title: ov.label,
        });
        createdLines.push(line);
      } catch {}
    }
    priceLinesRef.current = createdLines;

    // 5) Build Markers (Binary Entry Marker + VIP Historical Markers), snapped to series timestamps
    const times = seriesDataTimesRef.current;
    const rawMarkers = signalOverlays.filter((ov) => ov.type === 'marker');
    const historyMarkers = isVIP ? buildHistoryMarkerOverlays(vipHistorySignals, true) : [];

    const tooltipById = new Map<string, string>();
    const tooltipByTime = new Map<number, string>();
    const chartMarkers: SeriesMarker<UTCTimestamp>[] = [];

    if (times.length > 0) {
      const firstSeriesSec = times[0];
      const lastSeriesSec = times[times.length - 1];
      const maxSnapDist = isHistoricalInterval(interval) ? intervalSeconds * 2 : 3600;

      for (const mk of [...historyMarkers, ...rawMarkers]) {
        if (typeof mk.time !== 'number') continue;
        // Skip markers completely out of visible/loaded series range on short tick views
        if (mk.role === 'history_marker' && mk.time < firstSeriesSec - intervalSeconds) {
          continue;
        }
        const snappedSec = snapTimestampToSeries(
          mk.time,
          times,
          mk.role === 'binary_marker' ? Math.max(maxSnapDist, 86400) : maxSnapDist
        );
        if (snappedSec === null) continue;
        if (mk.role === 'history_marker' && mk.time > lastSeriesSec + intervalSeconds) continue;

        if (mk.tooltip) {
          tooltipById.set(mk.id, mk.tooltip);
          const existingTimeTip = tooltipByTime.get(snappedSec);
          tooltipByTime.set(snappedSec, existingTimeTip ? `${existingTimeTip} | ${mk.tooltip}` : mk.tooltip);
        }

        chartMarkers.push({
          id: mk.id,
          time: snappedSec as UTCTimestamp,
          position: mk.position || 'belowBar',
          shape: mk.shape || 'arrowUp',
          color: mk.color,
          size: mk.size ?? 1,
          text: mk.label,
        });
      }
    }

    chartMarkers.sort((a, b) => Number(a.time) - Number(b.time));
    markerTooltipsByIdRef.current = tooltipById;
    markerTooltipsByTimeRef.current = tooltipByTime;

    try {
      series.setMarkers(chartMarkers);
    } catch {}
  }, [signal, marketContext, showLevels, isMobileViewport, isVIP, vipHistorySignals, currentPrice, interval, intervalSeconds, seriesRevision]);

  // Real-time tick update throttling via requestAnimationFrame (preserves candlestick open!)
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    if (!wsConnected || !currentPrice || currentPrice <= 0) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      try {
        if (!seriesRef.current || !chartRef.current) return;
        const nowSec = Math.floor(Date.now() / 1000) as UTCTimestamp;
        const series = seriesRef.current;
        const pLineColor = pricePulse === 'down' ? '#f43f5e' : '#10b981';

        series.applyOptions({
          priceLineColor: pLineColor,
        });

        const bucketNum =
          intervalSeconds > 1 ? Math.floor(nowSec / intervalSeconds) * intervalSeconds : Number(nowSec);
        const bucketTime = bucketNum as UTCTimestamp;
        const lastKnownTime =
          seriesDataTimesRef.current.length > 0
            ? seriesDataTimesRef.current[seriesDataTimesRef.current.length - 1]
            : 0;

        // Avoid non-monotonic backward time updates while historical load settles
        if (lastKnownTime > 0 && bucketNum < lastKnownTime) {
          return;
        }

        if (chartType === 'line' || chartType === 'area') {
          (series as ISeriesApi<'Line'> | ISeriesApi<'Area'>).update({
            time: bucketTime,
            value: currentPrice,
          });
          if (bucketNum > lastKnownTime) {
            seriesDataTimesRef.current.push(bucketNum);
          }
        } else if (chartType === 'candles') {
          const prevBar = lastBarRef.current;
          const nextBar: BarPoint =
            prevBar && Number(prevBar.time) === bucketNum
              ? {
                  time: bucketTime,
                  open: prevBar.open,
                  high: Math.max(prevBar.high, currentPrice),
                  low: Math.min(prevBar.low, currentPrice),
                  close: currentPrice,
                }
              : {
                  time: bucketTime,
                  open: prevPrice > 0 ? prevPrice : currentPrice,
                  high: Math.max(prevPrice > 0 ? prevPrice : currentPrice, currentPrice),
                  low: Math.min(prevPrice > 0 ? prevPrice : currentPrice, currentPrice),
                  close: currentPrice,
                };
          lastBarRef.current = nextBar;
          (series as ISeriesApi<'Candlestick'>).update(nextBar);
          if (bucketNum > lastKnownTime) {
            seriesDataTimesRef.current.push(bucketNum);
          }
        }

        if (autoFollowRef.current && chartRef.current) {
          chartRef.current.timeScale().scrollToRealTime();
        }
      } catch {
        // Safe guard against non-monotonic ticks
      }
    });

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [currentPrice, prevPrice, pricePulse, chartType, intervalSeconds, wsConnected]);

  // Tab visibility resume handler: sync to live when trader returns to tab
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && autoFollowRef.current && chartRef.current) {
        try {
          chartRef.current.timeScale().scrollToRealTime();
        } catch {}
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const handleJumpToLive = () => {
    if (!chartRef.current) return;
    try {
      chartRef.current.timeScale().scrollToRealTime();
      autoFollowRef.current = true;
      setIsScrolledAway(false);
    } catch {}
  };

  const isPositive = metrics.changePips >= 0;
  const isWaitSignal = signal?.direction === 'WAIT';
  const isBinaryActive = Boolean(signal && signal.profile === 'BINARY_QUICK' && signal.direction !== 'WAIT');
  const isMt5Active = Boolean(signal && signal.profile === 'MT5' && signal.direction !== 'WAIT');

  const binaryTimers = useMemo(() => {
    if (!signal || signal.profile !== 'BINARY_QUICK' || signal.direction === 'WAIT') {
      return null;
    }
    const genMs = signal.generatedAt || Date.parse(signal.createdAt);
    const enterLeftSec = Math.max(0, (genMs + signal.enterWithinSeconds * 1000 - nowMs) / 1000);
    const expiryLeftSec = Math.max(0, Math.ceil((genMs + signal.expirySeconds * 1000 - nowMs) / 1000));
    return { enterLeftSec, expiryLeftSec };
  }, [signal, nowMs]);

  const mt5ValidLeftSec = useMemo(() => {
    if (!signal || signal.profile !== 'MT5' || signal.direction === 'WAIT') return 0;
    const vu = Date.parse(signal.validUntil);
    if (!Number.isFinite(vu)) return 0;
    return Math.max(0, Math.ceil((vu - nowMs) / 1000));
  }, [signal, nowMs]);

  const keyLevelCount = useMemo(
    () => (showLevels ? buildKeyLevelOverlays(marketContext, currentPrice, 8).length : 0),
    [showLevels, marketContext, currentPrice]
  );

  // Honest connection status badge in chart header
  const headerStatus = useMemo(() => {
    if (wsConnected && feedStatus === 'LIVE') {
      return { label: 'LIVE FEED', dotClass: 'bg-emerald-400 animate-pulse', textClass: 'text-emerald-400' };
    }
    switch (feedStatus) {
      case 'IDLE':
        return { label: 'Idle — pick an asset', dotClass: 'bg-slate-400', textClass: 'text-slate-300' };
      case 'DELAYED':
        return { label: 'QUIET / DELAYED', dotClass: 'bg-amber-400', textClass: 'text-amber-300' };
      case 'MARKET_CLOSED':
        return { label: 'MARKET CLOSED', dotClass: 'bg-slate-500', textClass: 'text-slate-400' };
      case 'RECONNECTING':
        return { label: 'RECONNECTING', dotClass: 'bg-amber-400 animate-pulse', textClass: 'text-amber-300' };
      case 'OFFLINE':
        return { label: 'OFFLINE', dotClass: 'bg-rose-500', textClass: 'text-rose-400' };
      default:
        return { label: 'CONNECTING', dotClass: 'bg-slate-400 animate-pulse', textClass: 'text-slate-300' };
    }
  }, [wsConnected, feedStatus]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 sm:p-4 shadow-xl relative overflow-hidden font-mono">
      {/* Chart Header Bar: Asset Info, Price Badge, Change, and Connection Status */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-white font-bold text-sm tracking-wide">
                {activeAsset?.name || 'Asset'}
              </span>
              <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">
                {activeAsset?.type || 'FOREX'}
              </span>
              {isWaitSignal && (
                <span
                  data-testid="chart-wait-note"
                  className="text-[10px] bg-slate-800/90 text-slate-300 px-2 py-0.5 rounded border border-slate-700 font-semibold"
                >
                  No setup
                </span>
              )}
            </div>

            <div className="flex items-baseline gap-2 mt-0.5 tabular-nums">
              <span
                id="live-chart-price-badge"
                className={`text-xl sm:text-2xl font-black tracking-tight transition-colors duration-150 ${
                  pricePulse === 'up'
                    ? 'text-emerald-400 bg-emerald-500/10 px-1.5 rounded'
                    : pricePulse === 'down'
                    ? 'text-rose-400 bg-rose-500/10 px-1.5 rounded'
                    : 'text-white'
                }`}
              >
                {hoverData
                  ? hoverData.price
                  : currentPrice > 0
                  ? currentPrice.toFixed(decimals)
                  : '--'}
              </span>
              {metrics.totalBars > 0 && (
                <span className={`text-xs font-bold ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isPositive ? `+${metrics.changePips} pips` : `${metrics.changePips} pips`} ({isPositive ? '+' : ''}{metrics.changePct}%)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right side: High/Low + Feed Connection Badge */}
        <div className="flex items-center justify-between sm:justify-end gap-3 text-xs tabular-nums">
          {metrics.totalBars > 0 && (
            <div className="text-[10px] text-slate-400 hidden xs:block">
              <div>H: <span className="text-slate-200 font-bold">{metrics.high.toFixed(decimals)}</span></div>
              <div>L: <span className="text-slate-200 font-bold">{metrics.low.toFixed(decimals)}</span></div>
            </div>
          )}

          <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 px-2.5 py-1 rounded-xl text-[11px]">
            <span className={`w-2 h-2 rounded-full ${headerStatus.dotClass}`} />
            <span className={`${headerStatus.textClass} font-bold`}>{headerStatus.label}</span>
          </div>
        </div>
      </div>

      {/* Active Signal Chart HUD: Binary Countdown OR MT5 Caption */}
      {isBinaryActive && signal?.profile === 'BINARY_QUICK' && binaryTimers && (
        <div className="mt-2 bg-slate-950/90 border border-slate-800 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums">
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded font-black ${
                signal.direction === 'CALL'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
              }`}
            >
              {signal.direction}
            </span>
            <span className="text-slate-300">
              Entry <strong className="text-white">{signal.entryPrice.toFixed(decimals)}</strong>
            </span>
            <span className="text-slate-500">&bull;</span>
            <span className="text-slate-400 uppercase">{signal.expiry}</span>
          </div>

          <div className="flex items-center gap-2.5">
            <span
              className={`px-2 py-0.5 rounded font-bold ${
                binaryTimers.enterLeftSec > 0
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-slate-800 text-slate-400 border border-slate-700'
              }`}
            >
              {binaryTimers.enterLeftSec > 0
                ? `Enter within ${binaryTimers.enterLeftSec.toFixed(1)}s`
                : 'Entry window closed'}
            </span>
            <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 font-bold">
              Expiry {formatRemainingMMSS(binaryTimers.expiryLeftSec)}
            </span>
          </div>
        </div>
      )}

      {isMt5Active && signal?.profile === 'MT5' && (
        <div className="mt-2 bg-slate-950/90 border border-slate-800 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`px-2 py-0.5 rounded font-black ${
                signal.direction === 'BUY'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
              }`}
            >
              {signal.direction} {signal.orderKind}
            </span>
            <span className="text-slate-300">
              Lot: <strong className="text-white">{signal.lotSize}</strong>
            </span>
            <span className="text-slate-600">&bull;</span>
            <span className="text-slate-300">
              Risk: <strong className="text-amber-300">{signal.accountCurrency} {signal.riskMoney.toFixed(2)}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-[10px]">
            {signal.stopLossPips !== null && (
              <span className="text-rose-400 font-bold">SL -{signal.stopLossPips}p</span>
            )}
            {signal.takeProfit1Pips !== null && (
              <span className="text-emerald-400 font-bold">TP1 +{signal.takeProfit1Pips}p</span>
            )}
            {signal.takeProfit2Pips !== null && (
              <span className="text-emerald-300 font-bold">TP2 +{signal.takeProfit2Pips}p</span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
              Valid {formatRemainingMMSS(mt5ValidLeftSec)}
            </span>
          </div>
        </div>
      )}

      {/* Chart Control Toolbar: Style + Levels Toggle + Timeframes (Tick..5s..1m..M5..D1) */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-[11px] border-b border-slate-800/60">
        {/* Left: Chart Style + Key Levels Toggle */}
        <div className="flex items-center gap-1 shrink-0">
          {[
            { id: 'line', label: 'Line' },
            { id: 'area', label: 'Area' },
            { id: 'candles', label: 'Candles' },
          ].map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() => setChartType(type.id as ChartType)}
              className={`px-2 py-0.5 rounded-md font-bold transition cursor-pointer ${
                chartType === type.id
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              {type.label}
            </button>
          ))}

          <span className="mx-0.5 text-slate-700">|</span>

          <button
            type="button"
            id="chart-toggle-levels"
            onClick={() => setShowLevels((prev) => !prev)}
            title="Toggle Market Context key levels (PDH/PDL, PWH/PWL, pivots, round numbers)"
            className={`px-2 py-0.5 rounded-md font-bold transition cursor-pointer ${
              showLevels
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent'
            }`}
          >
            Levels{showLevels && keyLevelCount > 0 ? ` (${keyLevelCount})` : ''}
          </button>
        </div>

        {/* Right: Timeframe Selector (Tick -> D1) */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none max-w-full">
          {(
            [
              { id: 'tick', label: 'Tick' },
              { id: '5s', label: '5s' },
              { id: '15s', label: '15s' },
              { id: '1m', label: '1m' },
              { id: 'M5', label: 'M5' },
              { id: 'M15', label: 'M15' },
              { id: 'H1', label: 'H1' },
              { id: 'H4', label: 'H4' },
              { id: 'D1', label: 'D1' },
            ] as const
          ).map((tf) => (
            <button
              key={tf.id}
              type="button"
              onClick={() => handleSelectInterval(tf.id)}
              className={`px-2 py-0.5 rounded-md font-bold transition shrink-0 cursor-pointer ${
                interval === tf.id
                  ? 'bg-slate-800 text-white border border-slate-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {/* Lightweight Charts HTML5 Canvas Container */}
      <div className="relative mt-2">
        <div
          ref={containerRef}
          id="tradingview-lightweight-chart-container"
          className={`w-full min-h-[250px] touch-pan-x touch-pan-y rounded-xl overflow-hidden cursor-crosshair ${
            useFallbackCanvas ? 'hidden' : 'block'
          }`}
        />

        {/* Resilient Native Canvas Sparkline Fallback */}
        {useFallbackCanvas && (
          <div className="w-full h-[250px] bg-slate-950 rounded-xl p-2 flex flex-col justify-end">
            <canvas ref={fallbackCanvasRef} width={400} height={200} className="w-full h-full block" />
          </div>
        )}

        {/* Loading indicator for historical M5-D1 timeframes */}
        {isLoadingHistory && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 rounded-xl pointer-events-none z-10">
            <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-300 font-bold">
              Loading {interval} candles...
            </div>
          </div>
        )}

        {/* Honest empty history indicator */}
        {!isLoadingHistory && historyEmptyNote && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-xs text-slate-400">
              {historyEmptyNote}
            </div>
          </div>
        )}

        {/* Hover Crosshair & Marker Tooltip Overlay */}
        {hoverData && (
          <div className="absolute top-2 left-2 bg-slate-950/90 border border-slate-800 rounded-lg px-2 py-1 text-[10px] text-slate-300 pointer-events-none shadow-md z-10 max-w-[85%] space-y-0.5">
            <div>
              <span>Price: <strong className="text-emerald-400 tabular-nums">{hoverData.price}</strong></span>
              <span className="mx-1.5 text-slate-600">|</span>
              <span>Time: <strong className="tabular-nums">{hoverData.time}</strong></span>
            </div>
            {hoverData.tooltip && (
              <div className="text-sky-300 font-semibold truncate">{hoverData.tooltip}</div>
            )}
          </div>
        )}

        {/* Non-live feed status notice (only shown when live ticks paused and not actively looking at historical candles) */}
        {!wsConnected && !isHistoricalInterval(interval) && (
          <div className="absolute top-2 right-2 bg-slate-950/90 border border-amber-500/40 rounded-lg px-2.5 py-1 text-[10px] font-mono text-amber-300 pointer-events-none shadow-md z-10 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>{feedStatus === 'IDLE' ? 'IDLE' : `${String(feedStatus)} BUFFER`}</span>
          </div>
        )}

        {/* Floating "Jump to Live" Button when panned back */}
        {isScrolledAway && (
          <button
            type="button"
            onClick={handleJumpToLive}
            className="absolute bottom-3 right-3 z-20 flex items-center gap-1 bg-emerald-500 text-slate-950 px-3 py-1 rounded-full text-xs font-black shadow-lg shadow-emerald-500/30 hover:bg-emerald-400 transition animate-bounce"
          >
            <span>Jump to Live</span>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* Chart Footer: Buffer health & active overlays summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500 mt-2 pt-2 border-t border-slate-800/80 tabular-nums">
        <div className="flex items-center gap-2">
          <span>
            {metrics.totalBars > 0
              ? isHistoricalInterval(interval)
                ? `${metrics.totalBars} ${interval} bars`
                : `Buffer: ~${metrics.timespanMinutes}m`
              : 'Waiting for data...'}
          </span>
          <span>&bull;</span>
          <span>Resolution: {interval}</span>
          {showLevels && marketContext && (
            <>
              <span>&bull;</span>
              <span className="text-sky-400">Levels: {keyLevelCount}</span>
            </>
          )}
          {isVIP && vipHistorySignals.length > 0 && (
            <>
              <span>&bull;</span>
              <span className="text-amber-300">VIP History: {vipHistorySignals.length}</span>
            </>
          )}
        </div>
        <div>
          <span>Deriv Market Telemetry</span>
        </div>
      </div>
    </div>
  );
}
