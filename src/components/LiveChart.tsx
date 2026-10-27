import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import type { AssetConfig, TimestampedTick } from '../types.ts';
import { getAssetTimestampedTicks, getOrInitializeTimestampedTicks } from '../utils/quantEngine.ts';

export type ChartType = 'line' | 'area' | 'candles';
export type AggregationInterval = 'tick' | '5s' | '15s' | '1m' | '5m';

interface LiveChartProps {
  activeAsset: AssetConfig;
  currentPrice: number;
  prevPrice?: number;
  pricePulse?: 'up' | 'down' | null;
  wsConnected: boolean;
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
}: LiveChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | null>(null);
  const autoFollowRef = useRef<boolean>(true);
  const animationFrameRef = useRef<number | null>(null);

  const [chartType, setChartType] = useState<ChartType>('line');
  const [interval, setInterval] = useState<AggregationInterval>('tick');
  const [isScrolledAway, setIsScrolledAway] = useState<boolean>(false);
  const [hoverData, setHoverData] = useState<{ price: string; time: string } | null>(null);
  const [isChartReady, setIsChartReady] = useState<boolean>(false);

  // Buffer summary metrics
  const [metrics, setMetrics] = useState({
    changePips: 0,
    changePct: 0,
    high: currentPrice,
    low: currentPrice,
    totalBars: 0,
    timespanMinutes: 0,
  });

  // Calculate resolution seconds from interval
  const intervalSeconds = useMemo(() => {
    switch (interval) {
      case '5s': return 5;
      case '15s': return 15;
      case '1m': return 60;
      case '5m': return 300;
      case 'tick':
      default: return 1;
    }
  }, [interval]);

  // Client-side tick aggregation for Line & Area
  const buildLineData = useCallback((ticks: TimestampedTick[], stepSec: number): LinePoint[] => {
    if (!ticks || ticks.length === 0) return [];
    const points: LinePoint[] = [];
    let lastTime = -1;

    for (const t of ticks) {
      const bucket = stepSec > 1
        ? Math.floor(t.time / stepSec) * stepSec
        : t.time;
      if (bucket > lastTime) {
        points.push({ time: bucket as UTCTimestamp, value: t.price });
        lastTime = bucket;
      } else if (bucket === lastTime && points.length > 0) {
        points[points.length - 1].value = t.price;
      }
    }
    return points;
  }, []);

  // Client-side tick aggregation for Candlesticks
  const buildCandleData = useCallback((ticks: TimestampedTick[], stepSec: number): BarPoint[] => {
    if (!ticks || ticks.length === 0) return [];
    const effectiveStep = Math.max(2, stepSec);
    const bars: BarPoint[] = [];
    let currentBar: BarPoint | null = null;

    for (const t of ticks) {
      const bucket = (Math.floor(t.time / effectiveStep) * effectiveStep) as UTCTimestamp;
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

  // Initialize or Re-init lightweight-chart instance
  useEffect(() => {
    if (!containerRef.current) return;

    // Clean up old chart if exists
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const container = containerRef.current;
    const width = container.clientWidth || 360;
    const height = Math.max(240, Math.min(320, window.innerHeight * 0.35));

    const chart = createChart(container, {
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#090d16' },
        textColor: '#94a3b8',
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle.SparseDotted },
        horzLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle.SparseDotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#38bdf8',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0f172a',
        },
        horzLine: {
          color: '#38bdf8',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0f172a',
        },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: { top: 0.12, bottom: 0.12 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: interval === 'tick' || interval === '5s' || interval === '15s',
        shiftVisibleRangeOnNewBar: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    chartRef.current = chart;

    // Track user pan / scroll to toggle "Jump to Live"
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      // If user scrolls back by more than 3 bars, show "Jump to live"
      const isAway = range.to < 0.95;
      setIsScrolledAway(isAway);
      autoFollowRef.current = !isAway;
    });

    // Crosshair tooltip tracking
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) {
        setHoverData(null);
        return;
      }
      const data = param.seriesData.get(seriesRef.current as any);
      if (data) {
        const p = 'value' in data ? (data as any).value : (data as any).close;
        const d = new Date((param.time as number) * 1000);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setHoverData({
          price: Number(p).toFixed(activeAsset.decimals),
          time: timeStr,
        });
      }
    });

    // Handle responsive container resize
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0 || !chartRef.current) return;
      const { width: newWidth } = entries[0].contentRect;
      if (newWidth > 0) {
        chartRef.current.applyOptions({ width: newWidth });
      }
    });

    resizeObserver.observe(container);
    setIsChartReady(true);

    return () => {
      resizeObserver.disconnect();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setIsChartReady(false);
    };
  }, [activeAsset.symbol, activeAsset.decimals]);

  // Rebuild Series and Load History whenever activeAsset, chartType, or interval changes
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;

    // Remove existing series
    if (seriesRef.current) {
      try {
        chart.removeSeries(seriesRef.current as any);
      } catch {}
      seriesRef.current = null;
    }

    // Ingest reliable tick history from quant engine buffer
    const ticks = getOrInitializeTimestampedTicks(
      activeAsset.symbol,
      activeAsset.basePrice || currentPrice,
      activeAsset.pipSize || 0.0001,
      activeAsset.decimals || 5,
      interval === '5m' ? 1200 : interval === '1m' ? 800 : 400
    );

    // Compute metrics
    if (ticks.length > 0) {
      const prices = ticks.map((t) => t.price);
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      const open = ticks[0].price;
      const close = ticks[ticks.length - 1].price;
      const change = close - open;
      const pips = parseFloat((change / (activeAsset.pipSize || 0.0001)).toFixed(1));
      const pct = parseFloat(((change / (open || 1)) * 100).toFixed(2));
      const spanMin = Math.round((ticks[ticks.length - 1].time - ticks[0].time) / 60);

      setMetrics({
        changePips: pips,
        changePct: pct,
        high,
        low,
        totalBars: ticks.length,
        timespanMinutes: spanMin,
      });
    }

    // Create appropriate series based on user choice
    if (chartType === 'line') {
      const lineSeries = chart.addLineSeries({
        color: '#10b981',
        lineWidth: 2,
        priceLineVisible: true,
        priceLineColor: '#10b981',
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dashed,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: '#10b981',
        crosshairMarkerBackgroundColor: '#064e3b',
      });
      const data = buildLineData(ticks, intervalSeconds);
      if (data.length > 0) {
        lineSeries.setData(data);
      }
      seriesRef.current = lineSeries;
    } else if (chartType === 'area') {
      const areaSeries = chart.addAreaSeries({
        lineColor: '#10b981',
        topColor: 'rgba(16, 185, 129, 0.35)',
        bottomColor: 'rgba(16, 185, 129, 0.01)',
        lineWidth: 2,
        priceLineVisible: true,
        priceLineColor: '#10b981',
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dashed,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
      });
      const data = buildLineData(ticks, intervalSeconds);
      if (data.length > 0) {
        areaSeries.setData(data);
      }
      seriesRef.current = areaSeries;
    } else {
      const candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#f43f5e',
        borderVisible: false,
        wickUpColor: '#10b981',
        wickDownColor: '#f43f5e',
        priceLineVisible: true,
        priceLineColor: '#10b981',
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dashed,
        lastValueVisible: true,
      });
      const data = buildCandleData(ticks, intervalSeconds);
      if (data.length > 0) {
        candleSeries.setData(data);
      }
      seriesRef.current = candleSeries;
    }

    // Scroll to latest bar
    chart.timeScale().scrollToRealtime();
    autoFollowRef.current = true;
    setIsScrolledAway(false);
  }, [activeAsset.symbol, chartType, interval, intervalSeconds, buildLineData, buildCandleData, isChartReady]);

  // Real-time tick update throttling via requestAnimationFrame
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      const nowSec = Math.floor(Date.now() / 1000) as UTCTimestamp;
      const series = seriesRef.current;
      if (!series) return;

      const pLineColor = pricePulse === 'down' ? '#f43f5e' : '#10b981';
      series.applyOptions({
        priceLineColor: pLineColor,
      });

      if (chartType === 'line' || chartType === 'area') {
        const bucketTime = intervalSeconds > 1
          ? (Math.floor(nowSec / intervalSeconds) * intervalSeconds) as UTCTimestamp
          : nowSec;
        try {
          (series as ISeriesApi<'Line'> | ISeriesApi<'Area'>).update({
            time: bucketTime,
            value: currentPrice,
          });
        } catch {
          // Time non-monotonic guard
        }
      } else if (chartType === 'candles') {
        const bucketTime = (Math.floor(nowSec / Math.max(2, intervalSeconds)) * Math.max(2, intervalSeconds)) as UTCTimestamp;
        try {
          (series as ISeriesApi<'Candlestick'>).update({
            time: bucketTime,
            open: prevPrice,
            high: Math.max(prevPrice, currentPrice),
            low: Math.min(prevPrice, currentPrice),
            close: currentPrice,
          });
        } catch {
          // Time non-monotonic guard
        }
      }

      if (autoFollowRef.current && chartRef.current) {
        chartRef.current.timeScale().scrollToRealtime();
      }
    });

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [currentPrice, prevPrice, pricePulse, chartType, intervalSeconds]);

  // Jump to live handler
  const handleJumpToLive = () => {
    if (!chartRef.current) return;
    chartRef.current.timeScale().scrollToRealtime();
    autoFollowRef.current = true;
    setIsScrolledAway(false);
  };

  const isPositive = metrics.changePips >= 0;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 sm:p-4 shadow-xl relative overflow-hidden font-mono">
      {/* Chart Header Bar: Asset Info, Price Badge, Change, and Connection Status */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-white font-bold text-sm tracking-wide">
                {activeAsset.name}
              </span>
              <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.2 rounded border border-slate-700">
                {activeAsset.type}
              </span>
            </div>

            <div className="flex items-baseline gap-2 mt-0.5">
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
                {hoverData ? hoverData.price : currentPrice.toFixed(activeAsset.decimals)}
              </span>
              <span className={`text-xs font-bold ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {isPositive ? `+${metrics.changePips} pips` : `${metrics.changePips} pips`} ({isPositive ? '+' : ''}{metrics.changePct}%)
              </span>
            </div>
          </div>
        </div>

        {/* Right side: High/Low + Feed Connection Badge */}
        <div className="flex items-center justify-between sm:justify-end gap-3 text-xs">
          <div className="text-[10px] text-slate-400 hidden xs:block">
            <div>H: <span className="text-slate-200 font-bold">{metrics.high.toFixed(activeAsset.decimals)}</span></div>
            <div>L: <span className="text-slate-200 font-bold">{metrics.low.toFixed(activeAsset.decimals)}</span></div>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 px-2.5 py-1 rounded-xl text-[11px]">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            <span className={wsConnected ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
              {wsConnected ? 'LIVE FEED' : 'RECONNECTING'}
            </span>
          </div>
        </div>
      </div>

      {/* Chart Control Toolbar: Type (Line/Area/Candles) + Aggregation (Tick/5s/15s/1m/5m) */}
      <div className="flex items-center justify-between gap-2 py-2 text-[11px] border-b border-slate-800/60 overflow-x-auto scrollbar-none">
        {/* Chart Style Switcher */}
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
              className={`px-2 py-0.5 rounded-md font-bold transition ${
                chartType === type.id
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>

        {/* Aggregation Timeframe Buttons */}
        <div className="flex items-center gap-1 shrink-0">
          {[
            { id: 'tick', label: 'Tick' },
            { id: '5s', label: '5s' },
            { id: '15s', label: '15s' },
            { id: '1m', label: '1m' },
            { id: '5m', label: '5m' },
          ].map((int) => (
            <button
              key={int.id}
              type="button"
              onClick={() => setInterval(int.id as AggregationInterval)}
              className={`px-2 py-0.5 rounded-md font-bold transition ${
                interval === int.id
                  ? 'bg-slate-800 text-white border border-slate-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {int.label}
            </button>
          ))}
        </div>
      </div>

      {/* Lightweight Charts HTML5 Canvas Container */}
      <div className="relative mt-2">
        <div
          ref={containerRef}
          id="tradingview-lightweight-chart-container"
          className="w-full rounded-xl overflow-hidden cursor-crosshair"
          style={{ minHeight: '240px' }}
        />

        {/* Hover Crosshair Overlay */}
        {hoverData && (
          <div className="absolute top-2 left-2 bg-slate-950/90 border border-slate-800 rounded-lg px-2 py-1 text-[10px] text-slate-300 pointer-events-none shadow-md z-10">
            <span>Price: <strong className="text-emerald-400">{hoverData.price}</strong></span>
            <span className="mx-1.5 text-slate-600">|</span>
            <span>Time: <strong>{hoverData.time}</strong></span>
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

        {/* Market Silent / Disconnected Banner */}
        {!wsConnected && (
          <div className="absolute top-2 right-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2 py-0.5 rounded text-[10px] font-bold z-10 pointer-events-none">
            Feed Reconnecting — Standby
          </div>
        )}
      </div>

      {/* Chart Footer: Buffer health telemetry */}
      <div className="flex items-center justify-between text-[10px] text-slate-500 mt-2 pt-2 border-t border-slate-800/80">
        <div className="flex items-center gap-2">
          <span>Buffer: {metrics.timespanMinutes > 0 ? `~${metrics.timespanMinutes}m continuous` : 'Buffering...'}</span>
          <span>•</span>
          <span>Mode: Client-side Aggregated</span>
        </div>
        <div>
          <span>TradingView Lightweight Engine</span>
        </div>
      </div>
    </div>
  );
}
