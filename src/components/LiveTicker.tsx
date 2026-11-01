import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { AssetConfig } from '../types.ts';
import { pushAssetTick, getAssetTicks, getOrInitializeTimestampedTicks } from '../utils/quantEngine.ts';
import { LiveChart } from './LiveChart.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { ASSETS, getAssetConfigBySymbol } from '../services/symbolMap.ts';
import {
  DerivFeedService,
  type FeedHealthStatus,
  ACTIVE_APP_ID,
  IS_CUSTOM_APP_ID_CONFIGURED,
} from '../services/derivFeed.ts';

export type { FeedHealthStatus };
export { ASSETS, getAssetConfigBySymbol };

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
  const [lastTickAgeSec, setLastTickAgeSec] = useState<number>(0);
  const [activeEndpointUrl, setActiveEndpointUrl] = useState<string>('');
  const [tickVelocity, setTickVelocity] = useState<string>('Steady');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | 'CRYPTO' | 'FOREX' | 'SYNTH'>('ALL');
  const [showAppIdNotice, setShowAppIdNotice] = useState<boolean>(false);

  const historyRef = useRef<number[]>([]);
  const tickCountRef = useRef<number>(0);
  const currentPriceRef = useRef<number>(activeAsset.basePrice || 1.08542);
  const feedServiceRef = useRef<DerivFeedService | null>(null);

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

  // Process live incoming tick
  const handleLiveTick = useCallback((newPrice: number, isSimulated: boolean = false) => {
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
      setLastTickAgeSec(0);
      onFeedStatusChange?.(true, 'LIVE');
    }
  }, [activeAsset.symbol, onPriceUpdate, onTicksUpdate, onFeedStatusChange]);

  // Connect Deriv WebSocket Feed
  useEffect(() => {
    if (feedServiceRef.current) {
      feedServiceRef.current.setSymbol(activeAsset.symbol);
      return;
    }

    feedServiceRef.current = new DerivFeedService(activeAsset.symbol, {
      onTick: (event) => {
        handleLiveTick(event.price, false);
      },
      onHistory: (historyEvent) => {
        const { prices, times } = historyEvent;
        if (prices.length > 0) {
          // Prefill internal buffer
          const safeHistory = prices.slice(-120);
          historyRef.current = safeHistory;
          onTicksUpdate?.([...safeHistory]);

          const latest = prices[prices.length - 1];
          currentPriceRef.current = latest;
          setCurrentPrice(latest);
          onPriceUpdate?.(latest);

          // Populate timestamped ticks in quantEngine
          for (let i = 0; i < prices.length; i++) {
            const t = times[i] || (Math.floor(Date.now() / 1000) - (prices.length - i));
            pushAssetTick(activeAsset.symbol, prices[i], t);
          }
        }
      },
      onStatusChange: (status, ageSec, endpoint) => {
        setFeedStatus(status);
        setLastTickAgeSec(ageSec);
        setActiveEndpointUrl(endpoint);
        const isLive = status === 'LIVE' && ageSec <= 10;
        onFeedStatusChange?.(isLive, status);
      },
    });

    return () => {
      if (feedServiceRef.current) {
        feedServiceRef.current.destroy();
        feedServiceRef.current = null;
      }
    };
  }, [activeAsset.symbol, handleLiveTick, onFeedStatusChange, onPriceUpdate, onTicksUpdate]);

  // Manual Reconnect Trigger
  const handleManualRetry = () => {
    if (feedServiceRef.current) {
      feedServiceRef.current.manualRetry();
    }
  };

  // Optional Simulated Demo Ticker (ONLY when isDemoMode === true)
  useEffect(() => {
    if (!isDemoMode) return;

    const simTimer = setInterval(() => {
      const prev = currentPriceRef.current;
      const stepSize = (activeAsset.pipSize || 0.0001) * (Math.random() > 0.8 ? 2.0 : 1.0);
      const delta = (Math.random() - 0.495) * stepSize;
      const next = Math.max(0.00001, parseFloat((prev + delta).toFixed(activeAsset.decimals || 5)));
      handleLiveTick(next, true);
    }, 800);

    return () => clearInterval(simTimer);
  }, [isDemoMode, activeAsset.pipSize, activeAsset.decimals, handleLiveTick]);

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

  // Honest staleness check: LIVE if tick age <= 10s (not 2s)
  const isFeedActive = isDemoMode || (feedStatus === 'LIVE' && lastTickAgeSec <= 10);

  // Filter assets by category
  const filteredAssets = ASSETS.filter((a) => {
    if (categoryFilter === 'ALL') return true;
    if (categoryFilter === 'CRYPTO') return a.type === 'CRYPTO';
    if (categoryFilter === 'FOREX') return a.type === 'FOREX';
    if (categoryFilter === 'SYNTH') return a.type === 'SYNTH' || a.type === 'COMMODITY';
    if ((categoryFilter as string) === '24X7') return a.type === 'SYNTH' || a.type === 'CRYPTO';
    return true;
  });

  return (
    <div id="live-ticker-container" className="space-y-2.5">
      {/* 1. DEMO MODE BANNER (Only displayed if user explicitly toggled DEMO) */}
      {isDemoMode && (
        <div className="bg-amber-950/70 border border-amber-500/40 rounded-2xl p-2.5 sm:p-3 text-xs font-mono text-amber-200 flex items-center justify-between gap-3 shadow-lg">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span className="leading-tight">
              <strong>SIMULATED DATA (DEMO MODE)</strong> — Replaying offline simulation for testing.
              Trades are NOT recorded to live performance ledger.
            </span>
          </div>
          {onToggleDemoMode && (
            <button
              type="button"
              onClick={() => onToggleDemoMode(false)}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs shrink-0 cursor-pointer shadow-sm transition"
            >
              Switch to Live Feed
            </button>
          )}
        </div>
      )}

      {/* 2. MARKET CLOSED (WEEKEND) INTELLIGENT HELPER */}
      {!isDemoMode && feedStatus === 'MARKET_CLOSED' && (
        <div className="bg-slate-900 border border-amber-500/40 rounded-2xl p-3 text-xs font-mono text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
            <div className="leading-tight text-slate-300">
              <strong className="text-white block font-bold">
                🏛️ Global Interbank Forex Market Closed (Weekend)
              </strong>
              <span>
                {activeAsset.name} reopens Sunday 5:00 PM EST (21:00 UTC). Volatility Synthetics and Crypto operate 24/7/365 with uninterrupted live tick streams!
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
            <button
              type="button"
              onClick={() => {
                const vol100 = ASSETS.find((a) => a.symbol === 'R_100');
                if (vol100) onAssetChange(vol100);
              }}
              className="px-2.5 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer shadow-sm"
            >
              <span>⚡ Switch to VOL 100 (24/7)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const btc = ASSETS.find((a) => a.symbol === 'cryBTCUSD');
                if (btc) onAssetChange(btc);
              }}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer shadow-sm"
            >
              <span>🪙 BTC/USD</span>
            </button>
          </div>
        </div>
      )}

      {/* 3. RECONNECTING / STALE FEED NOTICE WITH DIRECT RETRY (No forced demo push) */}
      {!isDemoMode && !isFeedActive && feedStatus !== 'MARKET_CLOSED' && (
        <div className="bg-slate-900 border border-amber-500/40 rounded-2xl p-2.5 sm:p-3 text-xs font-mono text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-lg">
          <div className="flex items-center gap-2.5">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                feedStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : feedStatus === 'STALE'
                  ? 'bg-amber-400'
                  : 'bg-rose-500 animate-ping'
              }`}
            />
            <div className="leading-tight text-slate-300">
              <strong className="text-white block font-bold">
                {feedStatus === 'RECONNECTING'
                  ? 'Connecting to Deriv Live Market Feed...'
                  : feedStatus === 'STALE'
                  ? `Live Feed Awaiting Next Tick ${lastTickAgeSec > 0 && lastTickAgeSec < 60 ? `(${lastTickAgeSec}s)` : ''}`
                  : 'Live Feed Temporarily Disconnected'}
              </strong>
              <span>
                {activeAsset.name} feed {feedStatus.toLowerCase()}
                {lastTickAgeSec > 0 && lastTickAgeSec < 60 ? ` (last tick ${lastTickAgeSec}s ago)` : ' (awaiting initial quote)'}.
                Signal generation is paused until fresh ticks arrive.
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
            <button
              type="button"
              onClick={handleManualRetry}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-emerald-400 border border-emerald-500/40 hover:border-emerald-400 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-sm"
              title="Force immediate reconnection attempt"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Retry connection</span>
            </button>
          </div>
        </div>
      )}

      {/* 4. TOP TELEMETRY BAR: Category Selector + Live Status Pill + VIP Screener */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        {/* Category Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none text-xs font-mono">
          {[
            { id: 'ALL', label: 'All (16)' },
            { id: '24X7', label: '⚡ 24/7 Active (8)' },
            { id: 'FOREX', label: 'Forex (8)' },
            { id: 'CRYPTO', label: 'Crypto (2)' },
            { id: 'SYNTH', label: 'Synthetics & Gold (6)' },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id as any)}
              className={`px-2.5 sm:px-3 py-1.5 rounded-xl font-bold transition shrink-0 ${
                categoryFilter === cat.id
                  ? 'bg-slate-800 text-white border border-slate-700 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Right side: VIP Radar button + Status Pill + App ID indicator */}
        <div className="flex items-center gap-2 flex-wrap">
          {onOpenVipRadar && (
            <button
              type="button"
              id="vip-radar-screener-btn"
              data-tour="radar-control"
              onClick={onOpenVipRadar}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500/20 to-amber-400/20 hover:from-amber-500/30 hover:to-amber-400/30 border border-amber-500/40 text-amber-400 font-mono text-xs font-black shadow-md shadow-amber-500/10 transition"
              title="Open Real-Time Trade Screener"
            >
              <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span>VIP RADAR</span>
            </button>
          )}

          {/* STATUS PILL (LIVE / RECONNECTING / OFFLINE / STALE / MARKET_CLOSED) */}
          <div
            className={`flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded-xl border transition shadow-sm ${
              isDemoMode
                ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                : feedStatus === 'LIVE' && lastTickAgeSec <= 10
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : feedStatus === 'MARKET_CLOSED'
                ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                : feedStatus === 'RECONNECTING'
                ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
            }`}
            title={`Deriv WebSocket Feed: ${activeEndpointUrl || 'Connecting'}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isDemoMode
                  ? 'bg-amber-400'
                  : feedStatus === 'LIVE' && lastTickAgeSec <= 10
                  ? 'bg-emerald-400 animate-pulse'
                  : feedStatus === 'MARKET_CLOSED'
                  ? 'bg-amber-400'
                  : feedStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-rose-500'
              }`}
            />
            <span className="font-bold">
              {isDemoMode
                ? 'SIMULATED DEMO'
                : feedStatus === 'LIVE' && lastTickAgeSec <= 10
                ? 'LIVE'
                : feedStatus === 'MARKET_CLOSED'
                ? 'WEEKEND CLOSED'
                : feedStatus === 'RECONNECTING'
                ? `RECONNECTING ${lastTickAgeSec > 0 && lastTickAgeSec < 60 ? `(${lastTickAgeSec}s)` : ''}`
                : feedStatus === 'STALE'
                ? `STALE ${lastTickAgeSec > 0 && lastTickAgeSec < 60 ? `(${lastTickAgeSec}s)` : ''}`
                : 'OFFLINE'}
            </span>
          </div>

          {/* App ID Info / Dev Note */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowAppIdNotice((v) => !v)}
              className="px-2 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 text-xs font-mono"
              title="Deriv WebSocket App ID Status"
            >
              <span>ID: {ACTIVE_APP_ID}</span>
            </button>

            {showAppIdNotice && (
              <div className="absolute right-0 top-9 w-64 p-3 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl z-30 font-mono text-xs space-y-2 text-slate-300">
                <div className="flex items-center justify-between border-b border-slate-800 pb-1">
                  <span className="font-bold text-white">Deriv Feed Config</span>
                  <button type="button" onClick={() => setShowAppIdNotice(false)} className="text-slate-400 hover:text-white">✕</button>
                </div>
                <p className="text-[11px] leading-tight text-slate-300">
                  {IS_CUSTOM_APP_ID_CONFIGURED
                    ? `Using custom App ID: ${ACTIVE_APP_ID}`
                    : `Using Deriv Public Tier ID (1089). To register your own App ID, visit api.deriv.com and set VITE_DERIV_APP_ID in your environment.`}
                </p>
                <div className="text-[10px] text-emerald-400">
                  Endpoint: {activeEndpointUrl ? new URL(activeEndpointUrl).hostname : 'ws.derivws.com'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. ASSET SELECTOR TABS */}
      <div className="overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-800">
        <div className="flex items-center gap-2 min-w-max" id="asset-selector-tabs" data-tour="asset-selector">
          {filteredAssets.map((asset) => {
            const isActive = asset.symbol === activeAsset.symbol;
            return (
              <button
                key={asset.symbol}
                type="button"
                id={`tab-${asset.symbol}`}
                onClick={() => onAssetChange(asset)}
                className={`py-2 px-3 rounded-xl text-left transition-all shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-slate-900 border border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'bg-slate-900/60 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 leading-none">
                  <span className="px-1 py-0.5 rounded bg-slate-800 text-[10px] font-bold text-slate-300">
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

      {/* 5. TRADINGVIEW LIGHTWEIGHT CHARTS LIVE TERMINAL */}
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
