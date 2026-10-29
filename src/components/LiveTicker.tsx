import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { AssetConfig } from '../types.ts';
import { pushAssetTick, getAssetTicks, getOrInitializeTimestampedTicks } from '../utils/quantEngine.ts';
import { LiveChart } from './LiveChart.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

export type FeedHealthStatus = 'LIVE' | 'RECONNECTING' | 'OFFLINE' | 'STALE' | 'NO_DATA';

interface LiveTickerProps {
  activeAsset: AssetConfig;
  onAssetChange: (asset: AssetConfig) => void;
  onPriceUpdate?: (price: number) => void;
  onTicksUpdate?: (ticks: number[]) => void;
  onOpenVipRadar?: () => void;
  isVIP?: boolean;
  isDemoMode?: boolean;
  onToggleDemoMode?: (isDemo: boolean) => void;
  onFeedStatusChange?: (isLive: boolean, status: FeedHealthStatus) => void;
}

export const ASSETS: AssetConfig[] = [
  // Forex Majors (Native Deriv WebSocket Feed)
  { symbol: 'frxEURUSD', name: 'EUR/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.08542 },
  { symbol: 'frxGBPUSD', name: 'GBP/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.29420 },
  { symbol: 'frxUSDJPY', name: 'USD/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 154.250 },
  { symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 0.65410 },
  { symbol: 'frxUSDCAD', name: 'USD/CAD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.38240 },
  { symbol: 'frxGBPJPY', name: 'GBP/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 198.650 },
  { symbol: 'frxEURJPY', name: 'EUR/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 167.420 },

  // Crypto Coins (Native Deriv WebSocket Feed)
  { symbol: 'cryBTCUSD', name: 'BTC/USD', type: 'CRYPTO', decimals: 2, pipSize: 1.0, basePrice: 88450.00 },
  { symbol: 'cryETHUSD', name: 'ETH/USD', type: 'CRYPTO', decimals: 2, pipSize: 0.1, basePrice: 3240.50 },

  // Commodities & Indices (Native Deriv WebSocket Feed)
  { symbol: 'frxXAUUSD', name: 'GOLD (XAU)', type: 'COMMODITY', decimals: 2, pipSize: 0.01, basePrice: 2684.50 },

  // Deriv Volatility Synthetics (24/7 Guaranteed Live Ticks)
  { symbol: 'R_100', name: 'VOL 100', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 2415.80 },
  { symbol: 'R_75', name: 'VOL 75', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 48920.40 },
  { symbol: 'R_50', name: 'VOL 50', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 341.20 },
  { symbol: 'R_25', name: 'VOL 25', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 1820.60 },
  { symbol: '1HZ100V', name: 'VOL 100 (1s)', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 840.10 },
];

export function LiveTicker({
  activeAsset,
  onAssetChange,
  onPriceUpdate,
  onTicksUpdate,
  onOpenVipRadar,
  isVIP,
  isDemoMode = false,
  onToggleDemoMode,
  onFeedStatusChange,
}: LiveTickerProps) {
  const [currentPrice, setCurrentPrice] = useState<number>(activeAsset.basePrice || 1.08542);
  const [prevPrice, setPrevPrice] = useState<number>(activeAsset.basePrice || 1.08542);
  const [pricePulse, setPricePulse] = useState<'up' | 'down' | null>(null);
  const [feedStatus, setFeedStatus] = useState<FeedHealthStatus>('RECONNECTING');
  const [lastTickAgoMs, setLastTickAgoMs] = useState<number>(0);
  const [tickVelocity, setTickVelocity] = useState<string>('Normal');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | 'CRYPTO' | 'FOREX' | 'SYNTH'>('ALL');

  const historyRef = useRef<number[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const tickCountRef = useRef<number>(0);
  const currentPriceRef = useRef<number>(activeAsset.basePrice || 1.08542);
  const lastTickTimestampRef = useRef<number>(Date.now());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const backoffMsRef = useRef<number>(1000);
  const isMountedRef = useRef<boolean>(true);

  // Sync initial price on activeAsset change
  useEffect(() => {
    getOrInitializeTimestampedTicks(
      activeAsset.symbol,
      activeAsset.basePrice || 1.08542,
      activeAsset.pipSize || 0.0001,
      activeAsset.decimals || 5,
      600
    );
    const existing = getAssetTicks(activeAsset.symbol);
    const initialP = existing.length > 0
      ? existing[existing.length - 1]
      : (activeAsset.basePrice || (activeAsset.decimals === 5 ? 1.08542 : 100.0));

    currentPriceRef.current = initialP;
    setCurrentPrice(initialP);
    setPrevPrice(initialP);
    historyRef.current = existing.length > 0 ? [...existing] : [initialP];
    onPriceUpdate?.(initialP);
    if (existing.length > 0) {
      onTicksUpdate?.([...existing]);
    }
  }, [activeAsset.symbol]);

  const processNewTick = useCallback((newPrice: number, isSimulated: boolean = false) => {
    lastTickTimestampRef.current = Date.now();
    tickCountRef.current += 1;
    const nowSec = Math.floor(Date.now() / 1000);
    pushAssetTick(activeAsset.symbol, newPrice, nowSec);

    const prev = currentPriceRef.current;
    const priceDiff = newPrice - prev;
    if (priceDiff > 0.0000001) {
      setPricePulse('up');
    } else if (priceDiff < -0.0000001) {
      setPricePulse('down');
    }

    currentPriceRef.current = newPrice;
    setPrevPrice(prev);
    setCurrentPrice(newPrice);
    onPriceUpdate?.(newPrice);

    historyRef.current.push(newPrice);
    if (historyRef.current.length > 120) {
      historyRef.current.shift();
    }
    onTicksUpdate?.([...historyRef.current]);

    if (!isSimulated) {
      setFeedStatus('LIVE');
      onFeedStatusChange?.(true, 'LIVE');
    }
  }, [activeAsset.symbol, onPriceUpdate, onTicksUpdate, onFeedStatusChange]);

  // Connect WebSocket with Exponential Backoff
  useEffect(() => {
    isMountedRef.current = true;
    backoffMsRef.current = 1000;

    const connectWS = () => {
      if (!isMountedRef.current) return;

      try {
        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.close();
        }

        setFeedStatus('RECONNECTING');
        onFeedStatusChange?.(false, 'RECONNECTING');

        const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMountedRef.current) return;
          backoffMsRef.current = 1000; // Reset backoff on successful connect
          setFeedStatus('LIVE');
          onFeedStatusChange?.(true, 'LIVE');

          // Subscribe to active asset ticks
          ws.send(JSON.stringify({ forget_all: 'ticks' }));
          ws.send(JSON.stringify({ ticks: activeAsset.symbol, subscribe: 1 }));
        };

        ws.onmessage = (event) => {
          if (!isMountedRef.current) return;
          try {
            const data = JSON.parse(event.data);
            if (data.tick && data.tick.symbol === activeAsset.symbol) {
              const quote = parseFloat(data.tick.quote);
              if (!isNaN(quote)) {
                processNewTick(quote, false);
              }
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onclose = () => {
          if (!isMountedRef.current) return;
          setFeedStatus('RECONNECTING');
          onFeedStatusChange?.(false, 'RECONNECTING');

          const delay = backoffMsRef.current;
          backoffMsRef.current = Math.min(16000, backoffMsRef.current * 2); // Exponential backoff up to 16s

          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(connectWS, delay);
        };

        ws.onerror = () => {
          if (!isMountedRef.current) return;
          setFeedStatus('OFFLINE');
          onFeedStatusChange?.(false, 'OFFLINE');
        };
      } catch (e) {
        console.warn('WS Init notice', e);
        setFeedStatus('OFFLINE');
        onFeedStatusChange?.(false, 'OFFLINE');
      }
    };

    connectWS();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      }
    };
  }, [activeAsset.symbol, processNewTick, onFeedStatusChange]);

  // Stale-Tick Watchdog (>2000ms without tick marks feed as STALE / NO LIVE DATA)
  useEffect(() => {
    const watchdogInterval = setInterval(() => {
      const msSinceLastTick = Date.now() - lastTickTimestampRef.current;
      setLastTickAgoMs(msSinceLastTick);

      if (isDemoMode) {
        return; // Demo mode handles its own ticker
      }

      if (msSinceLastTick > 2000) {
        setFeedStatus((prev) => {
          if (prev === 'LIVE') {
            onFeedStatusChange?.(false, 'STALE');
            return 'STALE';
          }
          return prev;
        });
      }
    }, 500);

    return () => clearInterval(watchdogInterval);
  }, [isDemoMode, onFeedStatusChange]);

  // DEMO MODE ONLY: Simulated tick generator for testing/offline simulation
  // Strict rule: ONLY runs when isDemoMode === true! In production LIVE mode, Math.random ticks are 100% disabled.
  useEffect(() => {
    if (!isDemoMode) return;

    const simTimer = setInterval(() => {
      const prev = currentPriceRef.current;
      const stepSize = (activeAsset.pipSize || 0.0001) * (Math.random() > 0.8 ? 2.2 : 1.1);
      const delta = (Math.random() - 0.495) * stepSize;
      const next = Math.max(0.00001, parseFloat((prev + delta).toFixed(activeAsset.decimals || 5)));
      processNewTick(next, true);
    }, 750);

    return () => clearInterval(simTimer);
  }, [isDemoMode, activeAsset.pipSize, activeAsset.decimals, processNewTick]);

  // Tick Velocity tracking loop
  useEffect(() => {
    const velInterval = setInterval(() => {
      const count = tickCountRef.current;
      tickCountRef.current = 0;
      if (count > 6) {
        setTickVelocity(`High (${count * 2} t/s)`);
      } else if (count > 2) {
        setTickVelocity(`Active (${count * 2} t/s)`);
      } else {
        setTickVelocity(`Steady (${count * 2} t/s)`);
      }
    }, 1000);
    return () => clearInterval(velInterval);
  }, []);

  const isFeedActive = isDemoMode || (feedStatus === 'LIVE' && lastTickAgoMs <= 2000);

  // Filter assets by category
  const filteredAssets = ASSETS.filter((a) => {
    if (categoryFilter === 'ALL') return true;
    if (categoryFilter === 'CRYPTO') return a.type === 'CRYPTO';
    if (categoryFilter === 'FOREX') return a.type === 'FOREX';
    if (categoryFilter === 'SYNTH') return a.type === 'SYNTH' || a.type === 'COMMODITY';
    return true;
  });

  return (
    <div id="live-ticker-container" className="space-y-2">
      {/* DEMO MODE WARNING BANNER */}
      {isDemoMode && (
        <div className="bg-amber-950/70 border border-amber-500/40 rounded-xl p-2.5 text-xs font-mono text-amber-200 flex items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span>
              <strong>SIMULATED DATA (DEMO MODE)</strong> — Replaying simulated volatility for test execution.
              Outcomes are NOT recorded to live performance ledger.
            </span>
          </div>
          {onToggleDemoMode && (
            <button
              type="button"
              onClick={() => onToggleDemoMode(false)}
              className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-[11px] shrink-0"
            >
              Switch to Live Feed
            </button>
          )}
        </div>
      )}

      {/* FEED STALE / NO LIVE DATA ALERT */}
      {!isDemoMode && !isFeedActive && (
        <div className="bg-rose-950/70 border border-rose-500/40 rounded-xl p-2.5 text-xs font-mono text-rose-200 flex items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping shrink-0" />
            <div>
              <strong>NO LIVE DATA</strong> — Deriv WebSocket feed for {activeAsset.name} is {feedStatus.toLowerCase()} (last tick: {(lastTickAgoMs / 1000).toFixed(1)}s ago).
              Signal generation is paused to protect capital.
            </div>
          </div>
          {onToggleDemoMode && (
            <button
              type="button"
              onClick={() => onToggleDemoMode(true)}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 rounded-lg text-[11px] shrink-0 font-bold"
            >
              Enable Demo Mode
            </button>
          )}
        </div>
      )}

      {/* Top Bar: Feed Status & Category Selector + VIP Screener Trigger */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        {/* Category Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none text-[11px] font-mono">
          {[
            { id: 'ALL', label: 'All (15)' },
            { id: 'FOREX', label: 'Forex (7)' },
            { id: 'CRYPTO', label: 'Crypto (2)' },
            { id: 'SYNTH', label: 'Synthetics & Gold (6)' },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id as any)}
              className={`px-2.5 py-1 rounded-lg font-bold transition shrink-0 ${
                categoryFilter === cat.id
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Right side: VIP Screener button + Stream status + Live/Demo Toggle */}
        <div className="flex items-center gap-2">
          {onOpenVipRadar && (
            <button
              type="button"
              id="vip-radar-screener-btn"
              data-tour="radar-control"
              onClick={onOpenVipRadar}
              className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-gradient-to-r from-amber-500/20 to-amber-400/20 hover:from-amber-500/30 hover:to-amber-400/30 border border-amber-500/40 text-amber-400 font-mono text-xs font-black shadow-md shadow-amber-500/10 transition"
              title="Open Real-Time Trade Screener"
            >
              <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span>VIP RADAR</span>
            </button>
          )}

          {/* Honest Connection Health Indicator */}
          <div className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded-xl border bg-slate-900/80 border-slate-800">
            <span
              className={`w-2 h-2 rounded-full ${
                isDemoMode
                  ? 'bg-amber-400'
                  : feedStatus === 'LIVE' && lastTickAgoMs <= 2000
                  ? 'bg-emerald-400 animate-pulse'
                  : feedStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-rose-500'
              }`}
            />
            <span
              className={`font-bold ${
                isDemoMode
                  ? 'text-amber-300'
                  : feedStatus === 'LIVE' && lastTickAgoMs <= 2000
                  ? 'text-emerald-400'
                  : feedStatus === 'RECONNECTING'
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}
            >
              {isDemoMode
                ? 'SIMULATED DEMO'
                : feedStatus === 'LIVE' && lastTickAgoMs <= 2000
                ? 'DERIV LIVE'
                : feedStatus === 'RECONNECTING'
                ? 'RECONNECTING'
                : 'NO LIVE DATA'}
            </span>
          </div>

          {/* Mode Switcher (Live vs Demo) */}
          {onToggleDemoMode && (
            <button
              type="button"
              onClick={() => onToggleDemoMode(!isDemoMode)}
              className={`px-2 py-1 rounded-lg text-[10px] font-mono font-bold border transition ${
                isDemoMode
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title="Toggle Simulated Demo Mode for practice"
            >
              {isDemoMode ? '🧪 DEMO' : '⚡ LIVE'}
            </button>
          )}
        </div>
      </div>

      {/* Asset Grid Selection */}
      <div className="overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-800">
        <div className="flex items-center gap-1.5 min-w-max" id="asset-selector-tabs" data-tour="asset-selector">
          {filteredAssets.map((asset) => {
            const isActive = asset.symbol === activeAsset.symbol;
            return (
              <button
                key={asset.symbol}
                type="button"
                id={`tab-${asset.symbol}`}
                onClick={() => onAssetChange(asset)}
                className={`py-2 px-3 rounded-xl text-left transition-all shrink-0 ${
                  isActive
                    ? 'bg-slate-900 border border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'bg-slate-900/60 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 leading-none">
                  <span className="px-1 py-0.2 rounded bg-slate-800 text-[9px] font-bold text-slate-300">
                    {asset.type}
                  </span>
                </div>
                <div className={`text-xs font-bold font-mono mt-1 ${isActive ? 'text-emerald-400' : 'text-slate-200'}`}>
                  {asset.name}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* TradingView Lightweight Charts Live Terminal */}
      <div data-tour="live-ticker">
        <ErrorBoundary fallbackTitle="Chart Telemetry Initializing...">
          <LiveChart
            activeAsset={activeAsset}
            currentPrice={currentPrice}
            prevPrice={prevPrice}
            pricePulse={pricePulse}
            wsConnected={isFeedActive}
            onAssetChange={onAssetChange}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
