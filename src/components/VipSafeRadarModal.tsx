import React, { useState, useEffect, useMemo } from 'react';
import type { AssetConfig, VipScreenerAsset } from '../types.ts';
import { ASSETS } from './LiveTicker.tsx';
import {
  analyzeMarketConfluence,
  calculateSafeCloseAnalysis,
  getOrInitializeAssetTicks,
  getAssetTicks,
  evaluateMultiWindowLiveConfirmation,
} from '../utils/quantEngine.ts';

interface VipSafeRadarModalProps {
  isOpen: boolean;
  onClose: () => void;
  isVIP: boolean;
  onSelectAsset: (asset: AssetConfig, timeframe?: string) => void;
  onOpenUpgrade?: () => void;
  onUpgradeVip?: () => void;
}

export function VipSafeRadarModal({
  isOpen,
  onClose,
  isVIP,
  onSelectAsset,
  onOpenUpgrade,
  onUpgradeVip,
}: VipSafeRadarModalProps) {
  const handleUpgrade = onUpgradeVip || onOpenUpgrade || onClose;
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | 'CRYPTO' | 'STOCK' | 'FOREX' | 'INDEX' | 'SAFE_ONLY'>('ALL');
  const [selectedTimeframe, setSelectedTimeframe] = useState<'30s' | '1m' | '5m' | '15m' | '1h'>('1m');
  const [lastScannedTime, setLastScannedTime] = useState<number>(Date.now());
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState<number>(30);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Auto-refresh countdown (reads fresh live buffers directly from WebSocket)
  useEffect(() => {
    if (!isOpen) return;

    const timer = setInterval(() => {
      setSecondsUntilRefresh((prev) => {
        if (prev <= 1) {
          setLastScannedTime(Date.now());
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen]);

  const handleManualRescan = () => {
    setLastScannedTime(Date.now());
    setSecondsUntilRefresh(30);
  };

  // Generate institutional screener data for all assets using real live confirmation path
  const screenerData: VipScreenerAsset[] = useMemo(() => {
    const tfMinutes = selectedTimeframe === '30s' ? 0.5 : selectedTimeframe === '1h' ? 60 : parseInt(selectedTimeframe) || 1;

    return ASSETS.map((asset) => {
      // 1. Fetch real price series for this instrument from active tick buffer
      const existing = getAssetTicks(asset.symbol);
      const ticks = existing.length >= 6
        ? existing
        : getOrInitializeAssetTicks(
            asset.symbol,
            asset.basePrice || (asset.decimals === 5 ? 1.08500 : 100.0),
            asset.pipSize,
            asset.decimals,
            60
          );

      // 2. Perform real multi-window live confirmation (Anti-Opposite Signals Gate)
      const multiWindow = evaluateMultiWindowLiveConfirmation(ticks, asset.pipSize, tfMinutes, asset.symbol);
      const audit = analyzeMarketConfluence(ticks, selectedTimeframe, asset.pipSize, isVIP);
      const safeClose = calculateSafeCloseAnalysis(ticks, selectedTimeframe, asset.pipSize);

      const currentP = ticks[ticks.length - 1];
      const firstP = ticks[0] || currentP;
      const change24h = parseFloat((((currentP - firstP) / (firstP || 1)) * 100).toFixed(2));

      // 3. Strict Rule: If buffer insufficient or multi-window disagrees -> WAIT
      let safetyRating: 'SAFE TO TRADE' | 'MODERATE RISK' | 'WAIT / VOLATILE' = 'WAIT / VOLATILE';
      let recommendedAction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
      let safeCloseTiming = 'Standby: Lookback Conflict';
      let reasonText = '';

      if (ticks.length < 8) {
        recommendedAction = 'WAIT';
        safetyRating = 'WAIT / VOLATILE';
        reasonText = `Live data insufficient (${ticks.length}/8 ticks captured). Buffering feed.`;
        safeCloseTiming = 'Standby: Buffering Live Feed';
      } else if (!multiWindow.allAgreed) {
        recommendedAction = 'WAIT';
        safetyRating = 'WAIT / VOLATILE';
        reasonText = multiWindow.conflictSummary || 'Multi-window momentum in conflict across lookbacks. WAIT advised.';
        safeCloseTiming = 'Standby: Trend Disagreement';
      } else {
        // Multi-window aligned! Direction is confirmed by real live path
        recommendedAction = multiWindow.shortBias === 'BULLISH' ? 'CALL' : multiWindow.shortBias === 'BEARISH' ? 'PUT' : 'WAIT';

        if (recommendedAction !== 'WAIT' && audit.confluenceScore >= 85) {
          safetyRating = 'SAFE TO TRADE';
          safeCloseTiming = `Safe Exit: ${safeClose.peakMomentumWindow}`;
          reasonText = `All 3 windows aligned (${multiWindow.shortBias}) · ${audit.confluenceFactors.slice(0, 2).join(' · ')}`;
        } else if (recommendedAction !== 'WAIT') {
          safetyRating = 'MODERATE RISK';
          safeCloseTiming = `Safe Exit: ${safeClose.recommendedSeconds}s`;
          reasonText = `Consensus aligned (${multiWindow.shortBias}) · Moderate momentum`;
        } else {
          safetyRating = 'WAIT / VOLATILE';
          reasonText = 'Micro-structure flat across lookbacks';
        }
      }

      const volatility: 'LOW' | 'NORMAL' | 'HIGH' =
        safeClose.volatilityLevel === 'LOW'
          ? 'LOW'
          : safeClose.volatilityLevel === 'HIGH' || safeClose.volatilityLevel === 'EXTREME'
          ? 'HIGH'
          : 'NORMAL';

      return {
        symbol: asset.symbol,
        name: asset.name,
        type: asset.type,
        price: currentP,
        decimals: asset.decimals,
        change24h,
        volatility,
        safetyRating,
        recommendedAction,
        bestTimeframe: selectedTimeframe,
        confluenceScore: recommendedAction === 'WAIT' ? Math.min(audit.confluenceScore, 48) : audit.confluenceScore,
        safeCloseTiming,
        reason: reasonText,
        sparkline: ticks.slice(-10),
      };
    });
  }, [lastScannedTime, selectedTimeframe, isVIP]);

  // Filter screener items
  const filteredItems = useMemo(() => {
    return screenerData.filter((item) => {
      // Category filter
      if (selectedCategory === 'SAFE_ONLY' && item.safetyRating !== 'SAFE TO TRADE') {
        return false;
      }
      if (selectedCategory === 'CRYPTO' && item.type !== 'CRYPTO') return false;
      if (selectedCategory === 'STOCK' && item.type !== 'STOCK') return false;
      if (selectedCategory === 'FOREX' && item.type !== 'FOREX') return false;
      if (selectedCategory === 'INDEX' && (item.type !== 'INDEX' && item.type !== 'SYNTH' && item.type !== 'COMMODITY')) return false;

      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return item.name.toLowerCase().includes(q) || item.symbol.toLowerCase().includes(q);
      }

      return true;
    });
  }, [screenerData, selectedCategory, searchQuery]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 bg-slate-950/90 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-slate-900 border-0 sm:border sm:border-slate-800 rounded-none sm:rounded-3xl w-full max-w-5xl h-full sm:h-auto sm:max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-3 sm:p-6 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl sm:rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
              <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <h2 className="text-xs sm:text-lg font-black font-mono text-white truncate">
                  VIP SAFE RADAR
                </h2>
                <span className="text-[9px] sm:text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold uppercase shrink-0">
                  Live
                </span>
              </div>
              <p className="text-[10px] sm:text-xs text-slate-400 truncate">
                Confluence screener &bull; 30s auto-scan
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            {/* Auto-refresh timer & Manual re-scan button - ALWAYS VISIBLE ON MOBILE */}
            <button
              type="button"
              onClick={handleManualRescan}
              className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-mono px-2 sm:px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 active:scale-95 transition shrink-0"
              title="Re-Scan Market Now"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span>Scan in <strong className="text-amber-300 font-bold">{secondsUntilRefresh}s</strong></span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 sm:p-2 rounded-xl bg-slate-800/80 text-slate-400 hover:text-white hover:bg-slate-700 transition shrink-0"
              title="Close Radar"
            >
              <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Filter Controls Bar */}
        <div className="p-3 sm:px-6 bg-slate-950/40 border-b border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
          {/* Category Tabs - Horizontal scrollable on mobile */}
          <div className="flex items-center gap-1.5 text-xs font-mono overflow-x-auto no-scrollbar py-0.5 shrink-0">
            {[
              { id: 'ALL', label: 'All' },
              { id: 'SAFE_ONLY', label: '⭐ Safe Only' },
              { id: 'CRYPTO', label: 'Crypto' },
              { id: 'STOCK', label: 'Stocks' },
              { id: 'FOREX', label: 'Forex' },
              { id: 'INDEX', label: 'Indices' },
            ].map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id as any)}
                className={`px-3 py-1.5 rounded-xl font-bold whitespace-nowrap transition shrink-0 ${
                  selectedCategory === cat.id
                    ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                    : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Timeframe selector & Search */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="text"
              placeholder="Search coin / stock..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 w-full sm:w-44"
            />

            <select
              value={selectedTimeframe}
              onChange={(e) => setSelectedTimeframe(e.target.value as any)}
              className="px-2.5 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-xl text-emerald-400 font-bold focus:outline-none focus:border-emerald-500"
            >
              <option value="30s">30 SEC</option>
              <option value="1m">1 MIN</option>
              <option value="5m">5 MIN</option>
              <option value="15m">15 MIN</option>
              <option value="1h">1 HOUR</option>
            </select>
          </div>
        </div>

        {/* Main List Container with VIP gating */}
        <div className="relative flex-1 p-3 sm:p-6 overflow-y-auto">
          {!isVIP ? (
            <div className="w-full h-full min-h-[360px] bg-slate-950 flex flex-col items-center justify-center p-4 sm:p-6 text-center space-y-4 select-none rounded-2xl border border-amber-500/20">
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl sm:rounded-3xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shadow-xl shrink-0">
                <svg className="w-7 h-7 sm:w-8 sm:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>

              <div className="max-w-md space-y-2">
                <h3 className="text-lg sm:text-xl font-black font-mono text-white tracking-tight">
                  VIP PASS REQUIRED FOR REAL-TIME SCREENER
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Registered VIP members enjoy 24/7 continuous multi-asset screener updates, safety ratings across all coins &amp; stocks, and instant optimal safe close timing recommendations.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5 pt-2 w-full max-w-sm">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    handleUpgrade();
                  }}
                  className="w-full min-h-[44px] py-3 px-6 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black font-mono text-xs sm:text-sm shadow-xl shadow-amber-500/20 transition cursor-pointer active:scale-98"
                >
                  UPGRADE TO VIP (UNLIMITED)
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full min-h-[44px] py-3 px-5 rounded-2xl bg-slate-900 hover:bg-slate-800 text-slate-300 font-mono text-xs sm:text-sm transition border border-slate-800 cursor-pointer active:scale-98"
                >
                  Close Preview
                </button>
              </div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center py-12 text-slate-400 font-mono text-xs">
              No assets match your current filter. Try selecting &quot;All Assets&quot;.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredItems.map((item) => {
                const fullAssetConfig = ASSETS.find((a) => a.symbol === item.symbol) || {
                  symbol: item.symbol,
                  name: item.name,
                  type: item.type,
                  decimals: item.decimals,
                  pipSize: item.decimals === 5 ? 0.0001 : 0.01,
                };

                const isSafe = item.safetyRating === 'SAFE TO TRADE';
                const isCall = item.recommendedAction === 'CALL';
                const isPut = item.recommendedAction === 'PUT';

                return (
                  <div
                    key={item.symbol}
                    className={`bg-slate-950 border rounded-2xl p-3.5 sm:p-4 transition flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4 font-mono ${
                      isSafe
                        ? 'border-emerald-500/50 bg-gradient-to-r from-emerald-950/25 via-slate-950 to-slate-950 hover:border-emerald-400'
                        : item.safetyRating === 'MODERATE RISK'
                        ? 'border-amber-500/30 bg-gradient-to-r from-amber-950/15 via-slate-950 to-slate-950 hover:border-amber-500/50'
                        : 'border-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    {/* Row 1/Col 1: Asset details & Price */}
                    <div className="flex items-center justify-between md:justify-start gap-3 min-w-[200px]">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-slate-800/80 flex items-center justify-center font-bold text-xs text-white shrink-0 border border-slate-700">
                          {item.name.slice(0, 4)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-black text-white">{item.name}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-semibold">
                              {item.type}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                            <span className="font-bold text-slate-200">${item.price.toFixed(item.decimals)}</span>
                            <span className={item.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                              {item.change24h >= 0 ? '+' : ''}{item.change24h}%
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Mobile-only quick bias badge with score */}
                      <div className="flex items-center gap-1.5 md:hidden">
                        <span
                          className={`px-2 py-0.5 rounded-lg text-xs font-black ${
                            isCall
                              ? 'bg-emerald-500 text-slate-950'
                              : isPut
                              ? 'bg-rose-500 text-white'
                              : 'bg-slate-800 text-amber-300 border border-amber-500/30'
                          }`}
                        >
                          {isCall ? 'BUY' : isPut ? 'SELL' : 'WAIT'}
                        </span>
                        <span className={`text-xs font-mono font-bold ${item.confluenceScore >= 88 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {item.confluenceScore}%
                        </span>
                      </div>
                    </div>

                    {/* Row 2/Col 2: Safety Rating & Algorithmic Action (Desktop + Tablet) */}
                    <div className="flex items-center justify-between sm:justify-start gap-3">
                      <div>
                        <span className="text-[10px] text-slate-500 block uppercase">Safety Rating</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`px-2.5 py-1 rounded-lg text-xs font-black flex items-center gap-1 ${
                              isSafe
                                ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400'
                                : item.safetyRating === 'MODERATE RISK'
                                ? 'bg-amber-500/20 border border-amber-500/40 text-amber-400'
                                : 'bg-rose-500/20 border border-rose-500/40 text-rose-400'
                            }`}
                          >
                            {isSafe && <span>✓</span>}
                            <span>{item.safetyRating}</span>
                          </span>
                        </div>
                      </div>

                      <div className="hidden md:block">
                        <span className="text-[10px] text-slate-500 block uppercase">Quant Bias</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`px-2.5 py-1 rounded-lg text-xs font-black ${
                              isCall
                                ? 'bg-emerald-500 text-slate-950'
                                : isPut
                                ? 'bg-rose-500 text-white'
                                : 'bg-slate-800 text-amber-300 border border-amber-500/30'
                            }`}
                          >
                            {isCall ? 'CALL (BUY)' : isPut ? 'PUT (SELL)' : 'WAIT'}
                          </span>
                          <span className={`text-xs font-bold ${item.confluenceScore >= 88 ? 'text-emerald-400' : item.confluenceScore >= 82 ? 'text-amber-400' : 'text-slate-400'}`}>
                            {item.confluenceScore}%
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Row 3/Col 3: Safe Close Timing & Reason */}
                    <div className="text-xs space-y-0.5 max-w-sm">
                      <div className="flex items-center gap-1.5 text-cyan-400 font-bold">
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{item.safeCloseTiming}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2 md:line-clamp-1">
                        <span className="text-slate-500 font-bold uppercase text-[9px] mr-1">Factors:</span>
                        {item.reason}
                      </p>
                    </div>

                    {/* Row 4/Col 4: Trade Action CTA Button (min 44px tap target) */}
                    <div className="shrink-0 flex items-center pt-1 md:pt-0">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectAsset(fullAssetConfig, selectedTimeframe);
                          onClose();
                        }}
                        className={`w-full md:w-auto min-h-[44px] py-2.5 px-4 rounded-xl text-xs font-black transition flex items-center justify-center gap-2 active:scale-98 ${
                          isSafe
                            ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md shadow-emerald-500/20'
                            : 'bg-slate-800 hover:bg-slate-700 text-white'
                        }`}
                      >
                        <span>TRADE THIS ASSET</span>
                        <span>&rarr;</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/50 flex flex-col sm:flex-row items-center justify-between text-xs font-mono text-slate-400 gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Scanning 24 Instruments across Crypto, Equities, Forex &amp; Deriv Volatility Indices</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-white transition"
          >
            Close Radar
          </button>
        </div>
      </div>
    </div>
  );
}
