import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { AssetConfig, TimestampedTick } from '../types.ts';
import { getOrInitializeTimestampedTicks } from '../utils/quantEngine.ts';

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
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | null>(null);
  const autoFollowRef = useRef<boolean>(true);
  const animationFrameRef = useRef<number | null>(null);

  const [chartType, setChartType] = useState<ChartType>('line');
  const [interval, setInterval] = useState<AggregationInterval>('tick');
  const [isScrolledAway, setIsScrolledAway] = useState<boolean>(false);
  const [hoverData, setHoverData] = useState<{ price: string; time: string } | null>(null);
  const [useFallbackCanvas, setUseFallbackCanvas] = useState<boolean>(false);

  // Buffer summary metrics
  const [metrics, setMetrics] = useState({
    changePips: 0,
    changePct: 0,
    high: currentPrice || 1.085,
    low: currentPrice || 1.085,
    totalBars: 0,
    timespanMinutes: 0,
  });

  const decimals = activeAsset?.decimals ?? 5;
  const pipSize = activeAsset?.pipSize ?? 0.0001;

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
  const buildCandleData = useCallback((ticks: TimestampedTick[], stepSec: number): BarPoint[] => {
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

  // Draw fallback HTML5 canvas if lightweight-charts fails or is initializing
  const drawFallbackChart = useCallback((ticks: TimestampedTick[]) => {
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

    // Background gradient
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
  }, [pipSize]);

  // Unified Chart Initialization and Data Binding
  useEffect(() => {
    if (!containerRef.current) return;

    let isDisposed = false;
    let chart: IChartApi | null = null;
    let rangeHandler: ((range: any) => void) | null = null;
    let crosshairHandler: ((param: any) => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    try {
      // Clean up previous chart instance
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
          scaleMargins: { top: 0.15, bottom: 0.15 },
          autoScale: true,
        },
        timeScale: {
          borderColor: '#1e293b',
          timeVisible: true,
          secondsVisible: interval === 'tick' || interval === '5s',
        },
      });

      chartRef.current = chart;

      // Ingest reliable tick history
      const ticks = getOrInitializeTimestampedTicks(
        activeAsset.symbol,
        activeAsset.basePrice || currentPrice,
        pipSize,
        decimals,
        interval === '5m' ? 600 : interval === '1m' ? 400 : 250
      );

      // Compute metrics safely
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
      }

      // Create series according to selected type
      if (chartType === 'line') {
        const lineSeries = chart.addLineSeries({
          color: '#10b981',
          lineWidth: 2,
          priceLineVisible: true,
          priceLineColor: '#10b981',
          priceLineWidth: 1,
          priceLineStyle: LineStyle.Dashed,
          lastValueVisible: true,
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
          lastValueVisible: true,
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
          lastValueVisible: true,
        });
        const data = buildCandleData(ticks, intervalSeconds);
        if (data.length > 0) {
          candleSeries.setData(data);
        }
        seriesRef.current = candleSeries;
      }

      // Try scrolling to real-time safely
      try {
        chart.timeScale().scrollToRealTime();
      } catch {}

      // Track logical range changes for "Jump to Live"
      rangeHandler = (range: any) => {
        if (!range || isDisposed) return;
        const isAway = typeof range.to === 'number' && range.to < 0.95;
        setIsScrolledAway(isAway);
        autoFollowRef.current = !isAway;
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);

      // Track crosshair hover
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
              const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              setHoverData({
                price: Number(p).toFixed(decimals),
                time: timeStr,
              });
            }
          }
        } catch {
          setHoverData(null);
        }
      };
      chart.subscribeCrosshairMove(crosshairHandler);

      // Resize observer
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          if (isDisposed || !chartRef.current || !entries || entries.length === 0) return;
          const { width: newWidth } = entries[0].contentRect;
          if (newWidth > 50) {
            try {
              chartRef.current.applyOptions({ width: newWidth });
            } catch {}
          }
        });
        resizeObserver.observe(container);
      }

      setUseFallbackCanvas(false);
    } catch (err) {
      console.warn('[LiveChart init warning, activating resilient fallback]', err);
      setUseFallbackCanvas(true);
      const ticks = getOrInitializeTimestampedTicks(
        activeAsset.symbol,
        activeAsset.basePrice || currentPrice,
        pipSize,
        decimals,
        100
      );
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
  }, [activeAsset.symbol, chartType, interval, intervalSeconds, decimals, pipSize, buildLineData, buildCandleData, drawFallbackChart]);

  // Real-time tick update throttling via requestAnimationFrame with tab-visibility pause
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    // Phase 3: Pause animations & tick processing when tab is hidden to preserve mobile battery
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

        if (chartType === 'line' || chartType === 'area') {
          const bucketTime = intervalSeconds > 1
            ? (Math.floor(nowSec / intervalSeconds) * intervalSeconds) as UTCTimestamp
            : nowSec;
          (series as ISeriesApi<'Line'> | ISeriesApi<'Area'>).update({
            time: bucketTime,
            value: currentPrice,
          });
        } else if (chartType === 'candles') {
          const effStep = Math.max(2, intervalSeconds);
          const bucketTime = (Math.floor(nowSec / effStep) * effStep) as UTCTimestamp;
          (series as ISeriesApi<'Candlestick'>).update({
            time: bucketTime,
            open: prevPrice,
            high: Math.max(prevPrice, currentPrice),
            low: Math.min(prevPrice, currentPrice),
            close: currentPrice,
          });
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
  }, [currentPrice, prevPrice, pricePulse, chartType, intervalSeconds]);

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

  // Jump to live handler
  const handleJumpToLive = () => {
    if (!chartRef.current) return;
    try {
      chartRef.current.timeScale().scrollToRealTime();
      autoFollowRef.current = true;
      setIsScrolledAway(false);
    } catch {}
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
                {activeAsset?.name || 'Asset'}
              </span>
              <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.2 rounded border border-slate-700">
                {activeAsset?.type || 'FOREX'}
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
                {hoverData ? hoverData.price : (currentPrice || 1.085).toFixed(decimals)}
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
            <div>H: <span className="text-slate-200 font-bold">{metrics.high.toFixed(decimals)}</span></div>
            <div>L: <span className="text-slate-200 font-bold">{metrics.low.toFixed(decimals)}</span></div>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 px-2.5 py-1 rounded-xl text-[11px]">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-400'
              }`}
            />
            <span className="text-emerald-400 font-bold">
              {wsConnected ? 'LIVE FEED' : '24/7 ACTIVE'}
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
          className={`w-full rounded-xl overflow-hidden cursor-crosshair ${useFallbackCanvas ? 'hidden' : 'block'}`}
          style={{ minHeight: '250px', touchAction: 'pan-x pan-y' }}
        />

        {/* Resilient Native Canvas Sparkline Fallback */}
        {useFallbackCanvas && (
          <div className="w-full h-[250px] bg-slate-950 rounded-xl p-2 flex flex-col justify-end">
            <canvas ref={fallbackCanvasRef} width={400} height={200} className="w-full h-full block" />
          </div>
        )}

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
      </div>

      {/* Chart Footer: Buffer health telemetry */}
      <div className="flex items-center justify-between text-[10px] text-slate-500 mt-2 pt-2 border-t border-slate-800/80">
        <div className="flex items-center gap-2">
          <span>Buffer: {metrics.timespanMinutes > 0 ? `~${metrics.timespanMinutes}m continuous` : 'Buffering...'}</span>
          <span>•</span>
          <span>Resolution: {interval}</span>
        </div>
        <div>
          <span>PulseTrade Quantitative Telemetry</span>
        </div>
      </div>
    </div>
  );
}
