import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { AssetConfig, UserProfile } from '../types.ts';
import { pushAssetTick, getAssetTicks } from '../utils/quantEngine.ts';
import { LiveChart } from './LiveChart.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { ASSETS, getAssetConfigBySymbol } from '../services/symbolMap.ts';
import {
  DerivFeedService,
  type FeedHealthStatus,
  ACTIVE_APP_ID,
  IS_CUSTOM_APP_ID_CONFIGURED,
} from '../services/derivFeed.ts';
import { AssetPicker } from './AssetPicker.tsx';
import { getRegisteredAssets, isSymbolMarketOpen, type DynamicAsset } from '../services/assetRegistry.ts';

export type { FeedHealthStatus };
export { ASSETS, getAssetConfigBySymbol };

interface LiveTickerProps {
  activeAsset: AssetConfig;
  onAssetChange: (asset: AssetConfig) => void;
  onPriceUpdate?: (price: number) => void;
  onTicksUpdate?: (ticks: number[]) => void;
  onOpenVipRadar?: () => void;
  isVIP?: boolean;
  onFeedStatusChange?: (isLive: boolean, status: FeedHealthStatus) => void;
  user?: UserProfile | null;
}

export function LiveTicker({
  activeAsset,
  onAssetChange,
  onPriceUpdate,
  onTicksUpdate,
  onOpenVipRadar,
  isVIP: _isVIP,
  onFeedStatusChange,
  user,
}: LiveTickerProps) {
  // Never initialize with fake basePrice — honest null state until real tick arrives
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  const [pricePulse, setPricePulse] = useState<'up' | 'down' | null>(null);
  const [feedStatus, setFeedStatus] = useState<FeedHealthStatus>('CONNECTING');
  const [lastTickAgeSec, setLastTickAgeSec] = useState<number>(0);
  const [activeEndpointUrl, setActiveEndpointUrl] = useState<string>('');
  const [tickVelocity, setTickVelocity] = useState<string>('Steady');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | 'CRYPTO' | 'FOREX' | 'SYNTH'>('ALL');
  const [showAppIdNotice, setShowAppIdNotice] = useState<boolean>(false);
  const [showAssetPickerModal, setShowAssetPickerModal] = useState<boolean>(false);
  const [derivToken, setDerivToken] = useState<string>(() => {
    try {
      return sessionStorage.getItem('tickvere_deriv_token') || '';
    } catch {
      return '';
    }
  });
  const [tokenSavedMsg, setTokenSavedMsg] = useState<string>('');

  const historyRef = useRef<number[]>([]);
  const tickCountRef = useRef<number>(0);
  const currentPriceRef = useRef<number | null>(null);
  const feedServiceRef = useRef<DerivFeedService | null>(null);

  // Keep a mutable ref to activeAsset to avoid stale callback closures
  const activeAssetRef = useRef<AssetConfig>(activeAsset);
  useEffect(() => {
    activeAssetRef.current = activeAsset;
  }, [activeAsset]);

  // Sync initial price on activeAsset change
  useEffect(() => {
    const existing = getAssetTicks(activeAsset.symbol);
    if (existing.length > 0) {
      const initialP = existing[existing.length - 1];
      currentPriceRef.current = initialP;
      setCurrentPrice(initialP);
      setPrevPrice(initialP);
      historyRef.current = [...existing];
      onPriceUpdate?.(initialP);
      onTicksUpdate?.([...existing]);
    } else {
      currentPriceRef.current = null;
      setCurrentPrice(null);
      setPrevPrice(null);
      historyRef.current = [];
    }
  }, [activeAsset.symbol, onPriceUpdate, onTicksUpdate]);

  // Process live incoming tick: strictly verified from Deriv WebSocket feed
  const handleLiveTick = useCallback(
    (newPrice: number, symbol: string) => {
      // Guard against stale closure: ignore ticks for symbols other than active
      if (symbol !== activeAssetRef.current.symbol) {
        return;
      }

      tickCountRef.current += 1;
      const nowSec = Math.floor(Date.now() / 1000);
      pushAssetTick(symbol, newPrice, nowSec);

      const prev = currentPriceRef.current;
      if (prev !== null) {
        const priceDiff = newPrice - prev;
        if (priceDiff > 0.0000001) {
          setPricePulse('up');
        } else if (priceDiff < -0.0000001) {
          setPricePulse('down');
        }
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
    },
    [onPriceUpdate, onTicksUpdate]
  );

  // Connect Deriv WebSocket Feed via singleton service
  useEffect(() => {
    if (feedServiceRef.current) {
      feedServiceRef.current.setSymbol(activeAsset.symbol);
      return;
    }

    feedServiceRef.current = new DerivFeedService(activeAsset.symbol, {
      onTick: (event) => {
        handleLiveTick(event.price, event.symbol);
      },
      onHistory: (historyEvent) => {
        if (historyEvent.symbol !== activeAssetRef.current.symbol) return;
        const { prices, times } = historyEvent;
        if (prices.length > 0) {
          const safeHistory = prices.slice(-120);
          historyRef.current = safeHistory;
          onTicksUpdate?.([...safeHistory]);

          const latest = prices[prices.length - 1];
          currentPriceRef.current = latest;
          setCurrentPrice(latest);
          onPriceUpdate?.(latest);

          for (let i = 0; i < prices.length; i++) {
            const t = times[i] || (Math.floor(Date.now() / 1000) - (prices.length - i));
            pushAssetTick(historyEvent.symbol, prices[i], t);
          }
        }
      },
      onStatusChange: (status, ageSec, endpoint) => {
        setFeedStatus((prev) => (prev === status ? prev : status));
        setLastTickAgeSec(ageSec);
        setActiveEndpointUrl(endpoint);
        const isLive = status === 'LIVE' && ageSec <= 6;
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

  // Honest staleness check: LIVE if status is LIVE and tick age <= 6s for binary profiles
  const isFeedActive = feedStatus === 'LIVE' && lastTickAgeSec <= 6;
  const isMarketOpenNow = isSymbolMarketOpen(activeAsset.symbol);

  // Available quick assets from dynamic registry or symbolMap
  const registered = getRegisteredAssets();
  const filteredAssets = registered.filter((a) => {
    if (categoryFilter === 'ALL') return true;
    if (categoryFilter === 'CRYPTO') return a.type === 'CRYPTO';
    if (categoryFilter === 'FOREX') return a.type === 'FOREX';
    if (categoryFilter === 'SYNTH') return a.type === 'SYNTH' || a.type === 'COMMODITY';
    return true;
  });

  return (
    <div id="live-ticker-container" className="space-y-2.5">
      {/* MARKET CLOSED NOTICE */}
      {feedStatus === 'MARKET_CLOSED' && (
        <div className="bg-slate-900 border border-amber-500/40 rounded-2xl p-3 text-xs font-mono text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
            <div className="leading-tight text-slate-300">
              <strong className="text-white block font-bold">
                🏛️ Global Interbank Market Closed
              </strong>
              <span>
                {activeAsset.name} is currently closed (opens Sun 21:00 UTC). Volatility Synthetics and Crypto operate 24/7/365 with uninterrupted live tick streams.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
            <button
              type="button"
              onClick={() => {
                const vol100 = registered.find((a) => a.symbol === 'R_100') || ASSETS.find((a) => a.symbol === 'R_100');
                if (vol100) onAssetChange(vol100);
              }}
              className="px-2.5 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer shadow-sm"
            >
              <span>⚡ Switch to VOL 100 (24/7)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const btc = registered.find((a) => a.symbol === 'cryBTCUSD') || ASSETS.find((a) => a.symbol === 'cryBTCUSD');
                if (btc) onAssetChange(btc);
              }}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer shadow-sm"
            >
              <span>🪙 BTC/USD</span>
            </button>
          </div>
        </div>
      )}

      {/* RECONNECTING / DELAYED / OFFLINE STATUS NOTICE */}
      {feedStatus !== 'LIVE' && feedStatus !== 'MARKET_CLOSED' && (
        <div className="bg-slate-900 border border-amber-500/40 rounded-2xl p-2.5 sm:p-3 text-xs font-mono text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-lg">
          <div className="flex items-center gap-2.5">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                feedStatus === 'CONNECTING'
                  ? 'bg-slate-400 animate-pulse'
                  : feedStatus === 'DELAYED'
                  ? 'bg-amber-400'
                  : feedStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-rose-500 animate-ping'
              }`}
            />
            <div className="leading-tight text-slate-300">
              <strong className="text-white block font-bold">
                {feedStatus === 'CONNECTING'
                  ? 'Connecting to Deriv Live Market Feed...'
                  : feedStatus === 'DELAYED'
                  ? `Quiet Market Feed ${lastTickAgeSec > 0 ? `(last tick ${lastTickAgeSec}s ago)` : ''}`
                  : feedStatus === 'RECONNECTING'
                  ? 'Reconnecting to Market Feed...'
                  : 'Live Feed Temporarily Disconnected'}
              </strong>
              <span>
                {activeAsset.name} feed {feedStatus.toLowerCase()}
                {lastTickAgeSec > 0 ? ` (last tick ${lastTickAgeSec}s ago)` : ''}.{' '}
                {feedStatus === 'DELAYED'
                  ? 'Binary options scans require fresh live ticks; candle-based MT5 analysis can still run during quiet sessions.'
                  : 'Analysis requires live market data before evaluating signals.'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
            {(feedStatus === 'OFFLINE' || feedStatus === 'RECONNECTING' || feedStatus === 'DELAYED') && (
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
            )}
          </div>
        </div>
      )}

      {/* 4. TOP TELEMETRY BAR */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        {/* Category Filter Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none text-xs font-mono">
          {[
            { id: 'ALL', label: 'All' },
            { id: 'FOREX', label: 'Forex' },
            { id: 'CRYPTO', label: 'Crypto' },
            { id: 'SYNTH', label: 'Synthetics' },
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

          {/* Full Asset Picker Trigger Button */}
          <button
            type="button"
            onClick={() => setShowAssetPickerModal((prev) => !prev)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-emerald-400 hover:text-emerald-300 font-bold transition shrink-0 cursor-pointer"
            title="Browse full asset catalog, search, and manage favorites"
          >
            <span>🔍 Browse All Assets</span>
          </button>
        </div>

        {/* Right side: Telemetry & Status Badges */}
        <div className="flex items-center gap-2 flex-wrap">
          {onOpenVipRadar && (
            <button
              type="button"
              id="vip-radar-screener-btn"
              data-tour="radar-control"
              onClick={onOpenVipRadar}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500/20 to-amber-400/20 hover:from-amber-500/30 hover:to-amber-400/30 border border-amber-500/40 text-amber-400 font-mono text-xs font-black shadow-md shadow-amber-500/10 transition cursor-pointer"
              title="Open Real-Time Trade Screener"
            >
              <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span>VIP RADAR</span>
            </button>
          )}

          {/* STATUS PILL */}
          <div
            className={`flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded-xl border transition shadow-sm ${
              feedStatus === 'LIVE' && lastTickAgeSec <= 6
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : feedStatus === 'CONNECTING'
                ? 'bg-slate-900 border-slate-700 text-slate-300'
                : feedStatus === 'DELAYED'
                ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                : feedStatus === 'MARKET_CLOSED'
                ? 'bg-slate-900 border-slate-700 text-slate-400'
                : feedStatus === 'RECONNECTING'
                ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
            }`}
            title={`Deriv WebSocket Feed: ${activeEndpointUrl || 'Connecting'}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                feedStatus === 'LIVE' && lastTickAgeSec <= 6
                  ? 'bg-emerald-400 animate-pulse'
                  : feedStatus === 'CONNECTING'
                  ? 'bg-slate-400 animate-pulse'
                  : feedStatus === 'DELAYED'
                  ? 'bg-amber-400'
                  : feedStatus === 'MARKET_CLOSED'
                  ? 'bg-slate-500'
                  : feedStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-rose-500'
              }`}
            />
            <span className="font-bold">
              {feedStatus === 'LIVE' && lastTickAgeSec <= 6
                ? 'LIVE'
                : feedStatus === 'CONNECTING'
                ? 'CONNECTING'
                : feedStatus === 'DELAYED'
                ? `DELAYED (${lastTickAgeSec}s)`
                : feedStatus === 'MARKET_CLOSED'
                ? 'MARKET CLOSED'
                : feedStatus === 'RECONNECTING'
                ? 'RECONNECTING'
                : 'OFFLINE'}
            </span>
          </div>

          {/* App ID Info / Dev Note */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowAppIdNotice((v) => !v)}
              className="px-2 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 text-xs font-mono cursor-pointer"
              title="Deriv WebSocket App ID Status"
            >
              <span>ID: {ACTIVE_APP_ID}</span>
            </button>

            {showAppIdNotice && (
              <div className="absolute right-0 top-9 w-72 p-3 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl z-30 font-mono text-xs space-y-2.5 text-slate-300">
                <div className="flex items-center justify-between border-b border-slate-800 pb-1">
                  <span className="font-bold text-white">Deriv Feed Config</span>
                  <button type="button" onClick={() => setShowAppIdNotice(false)} className="text-slate-400 hover:text-white cursor-pointer">✕</button>
                </div>
                <p className="text-[11px] leading-tight text-slate-300">
                  {IS_CUSTOM_APP_ID_CONFIGURED
                    ? `Using custom App ID: ${ACTIVE_APP_ID}`
                    : `Using Deriv Public Tier ID (${ACTIVE_APP_ID}). Connected directly via browser WebSocket.`}
                </p>
                <div className="text-[10px] text-emerald-400 truncate">
                  Endpoint: {activeEndpointUrl ? new URL(activeEndpointUrl).hostname : 'api.derivws.com'}
                </div>

                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white text-[11px]">Deriv Token (Optional)</span>
                    {derivToken && (
                      <span className="text-[10px] text-emerald-400 font-bold">Active in session</span>
                    )}
                  </div>
                  <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-200 leading-tight">
                    ⚠️ <strong>Warning:</strong> Use a read-only token (Scope: Read). Never share tokens with trade, admin, or payments access.
                  </div>
                  <input
                    type="password"
                    placeholder="Enter read-only API token"
                    value={derivToken}
                    onChange={(e) => setDerivToken(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white placeholder-slate-500 font-mono focus:border-emerald-500 focus:outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = derivToken.trim();
                        try {
                          if (trimmed) {
                            sessionStorage.setItem('tickvere_deriv_token', trimmed);
                          } else {
                            sessionStorage.removeItem('tickvere_deriv_token');
                          }
                          feedServiceRef.current?.authorizeAccount(trimmed);
                          setTokenSavedMsg(trimmed ? 'Token saved to session' : 'Token cleared');
                          setTimeout(() => setTokenSavedMsg(''), 2000);
                        } catch {
                          setTokenSavedMsg('Storage error');
                        }
                      }}
                      className="flex-1 py-1 px-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[10px] uppercase cursor-pointer"
                    >
                      Save Token
                    </button>
                    {derivToken && (
                      <button
                        type="button"
                        onClick={() => {
                          setDerivToken('');
                          try {
                            sessionStorage.removeItem('tickvere_deriv_token');
                          } catch {}
                          feedServiceRef.current?.authorizeAccount('');
                          setTokenSavedMsg('Cleared');
                          setTimeout(() => setTokenSavedMsg(''), 2000);
                        }}
                        className="py-1 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 text-[10px] cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {tokenSavedMsg && (
                    <div className="text-[10px] text-emerald-400 font-bold">{tokenSavedMsg}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 5. EXPANDABLE ASSET PICKER MODAL */}
      {showAssetPickerModal && (
        <AssetPicker
          activeAsset={activeAsset}
          onSelectAsset={(asset) => {
            onAssetChange(asset);
            setShowAssetPickerModal(false);
          }}
          user={user}
          onClose={() => setShowAssetPickerModal(false)}
        />
      )}

      {/* 6. HORIZONTAL QUICK TABS */}
      <div className="overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-800">
        <div className="flex items-center gap-2 min-w-max" id="asset-selector-tabs" data-tour="asset-selector">
          {filteredAssets.slice(0, 14).map((asset) => {
            const isActive = asset.symbol === activeAsset.symbol;
            const isOpen = isSymbolMarketOpen(asset.symbol);

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
                  {!isOpen && <span className="text-[9px] text-rose-400 font-bold">Closed</span>}
                </div>
                <div className={`text-xs font-bold font-mono mt-1 ${isActive ? 'text-emerald-400' : 'text-slate-200'}`}>
                  {asset.name}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 7. LIVE PRICE BAR & DATA SOURCE BADGE */}
      <div className="flex items-center justify-between px-3 py-2 rounded-2xl bg-slate-950/80 border border-slate-800/80 font-mono text-xs">
        <div className="flex items-center gap-2.5">
          <span className="text-slate-400 text-[11px]">LIVE QUOTE:</span>
          <span
            className={`text-sm font-black transition-colors ${
              pricePulse === 'up'
                ? 'text-emerald-400'
                : pricePulse === 'down'
                ? 'text-rose-400'
                : 'text-white'
            }`}
          >
            {currentPrice !== null ? currentPrice.toFixed(activeAsset.decimals || 5) : 'Connecting...'}
          </span>
          <span className="text-[10px] text-slate-500">
            ({activeAsset.symbol})
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            Velocity: {tickVelocity}
          </span>
          <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] text-slate-400">
            Source: Deriv feed
          </span>
        </div>
      </div>

      {/* 8. TRADINGVIEW LIGHTWEIGHT CHARTS LIVE TERMINAL */}
      <div data-tour="live-ticker">
        <ErrorBoundary fallbackTitle="Chart Telemetry Initializing...">
          <LiveChart
            activeAsset={activeAsset}
            currentPrice={currentPrice ?? 0}
            prevPrice={prevPrice ?? 0}
            pricePulse={pricePulse}
            wsConnected={isFeedActive}
            onAssetChange={onAssetChange}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
