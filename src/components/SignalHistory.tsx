import React, { useState, useMemo } from 'react';
import type { SignalHistoryItem, AssetConfig } from '../types.ts';

interface SignalHistoryProps {
  signals: SignalHistoryItem[];
  activeAsset: AssetConfig;
  onUpdateOutcome?: (id: string, outcome: 'WIN' | 'LOSS') => void;
}

export type HistoryFilterTab = 'ALL' | 'WON' | 'LOST';

export function SignalHistory({ signals, activeAsset, onUpdateOutcome }: SignalHistoryProps) {
  const [filterTab, setFilterTab] = useState<HistoryFilterTab>('ALL');
  const [visibleCount, setVisibleCount] = useState<number>(10);

  // Filter out any non-actionable WAIT signals (Strict Rule: never record WAIT as win/loss)
  const actionableSignals = useMemo(() => {
    return signals.filter(
      (s) => s.direction !== 'WAIT' && s.outcome !== 'WAIT'
    );
  }, [signals]);

  // Compute real session stats based purely on user outcomes
  const { wins, losses, totalLogged, winRateStr } = useMemo(() => {
    const logged = actionableSignals.filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS');
    const w = logged.filter((s) => s.outcome === 'WIN').length;
    const l = logged.filter((s) => s.outcome === 'LOSS').length;
    const total = w + l;
    const rate = total > 0 ? `${((w / total) * 100).toFixed(1)}%` : '--';
    return { wins: w, losses: l, totalLogged: total, winRateStr: rate };
  }, [actionableSignals]);

  // Filtered by selected tab
  const filteredList = useMemo(() => {
    switch (filterTab) {
      case 'WON':
        return actionableSignals.filter((s) => s.outcome === 'WIN');
      case 'LOST':
        return actionableSignals.filter((s) => s.outcome === 'LOSS');
      case 'ALL':
      default:
        return actionableSignals;
    }
  }, [actionableSignals, filterTab]);

  const displayedList = filteredList.slice(0, visibleCount);
  const hasMore = filteredList.length > visibleCount;

  // Format timestamp helper
  const formatTime = (ts: number) => {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /**
   * Generates a smooth SVG sparkline path from price ticks relative to entry strike
   */
  const renderSparkline = (
    sparkline: number[] = [],
    entryPrice: number,
    direction: 'CALL' | 'PUT' | 'WAIT',
    outcome?: 'WIN' | 'LOSS' | 'IN_TRADE' | 'PENDING' | 'WAIT'
  ) => {
    const points = sparkline && sparkline.length >= 4 
      ? sparkline 
      : [entryPrice - 0.0001, entryPrice, entryPrice + 0.0001, entryPrice + (direction === 'CALL' ? 0.0002 : -0.0002)];

    const min = Math.min(...points, entryPrice);
    const max = Math.max(...points, entryPrice);
    const range = max - min || 0.0002;

    const width = 110;
    const height = 36;
    const padding = 4;
    const usableHeight = height - padding * 2;

    const coords = points.map((val, idx) => {
      const x = padding + (idx / (points.length - 1)) * (width - padding * 2);
      const y = padding + usableHeight - ((val - min) / range) * usableHeight;
      return { x, y };
    });

    const entryY = padding + usableHeight - ((entryPrice - min) / range) * usableHeight;

    const pathData = coords.reduce((acc, pt, idx) => {
      return idx === 0 ? `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    }, '');

    const areaData = `${pathData} L ${coords[coords.length - 1].x.toFixed(1)} ${height} L ${coords[0].x.toFixed(1)} ${height} Z`;

    const isFavorable = outcome === 'WIN' || (!outcome && (direction === 'CALL' ? points[points.length - 1] >= entryPrice : points[points.length - 1] <= entryPrice));
    const strokeColor = isFavorable ? '#10b981' : outcome === 'LOSS' ? '#f43f5e' : '#38bdf8';
    const fillColor = isFavorable ? 'rgba(16, 185, 129, 0.15)' : outcome === 'LOSS' ? 'rgba(244, 63, 94, 0.15)' : 'rgba(56, 189, 248, 0.15)';

    return (
      <div className="relative flex flex-col items-center">
        <svg width={width} height={height} className="overflow-visible">
          <line
            x1={padding}
            y1={entryY}
            x2={width - padding}
            y2={entryY}
            stroke="#64748b"
            strokeWidth="1"
            strokeDasharray="2 2"
            opacity="0.6"
          />
          <path d={areaData} fill={fillColor} />
          <path
            d={pathData}
            fill="none"
            stroke={strokeColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx={coords[0].x} cy={coords[0].y} r="2.5" fill="#94a3b8" />
          <circle
            cx={coords[coords.length - 1].x}
            cy={coords[coords.length - 1].y}
            r="3.5"
            fill={strokeColor}
            className="animate-pulse"
          />
        </svg>
        <span className="text-[9px] font-mono text-slate-500 mt-0.5">
          Strike: <span className="text-slate-300 font-semibold">{entryPrice.toFixed(activeAsset.decimals)}</span>
        </span>
      </div>
    );
  };

  return (
    <div id="signal-history-section" className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl space-y-3 font-mono">
      {/* Header with Title & Genuine Performance Snapshot */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>ACTIONABLE TRADE HISTORY</span>
              <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                {actionableSignals.length} recorded
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Verified signal ledger with strike, direction, time &amp; relative price sparkline
            </p>
          </div>
        </div>

        {/* Real Accuracy Metric Box (No fake baseline) */}
        <div className="flex items-center gap-2 self-start sm:self-auto bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs">
          <span className="text-slate-400">Session Accuracy:</span>
          <span className={`font-black ${winRateStr !== '--' && parseFloat(winRateStr) >= 50 ? 'text-emerald-400' : 'text-slate-200'}`}>
            {winRateStr}
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-emerald-400 font-bold">{wins}W</span>
          <span className="text-slate-600">/</span>
          <span className="text-rose-400 font-bold">{losses}L</span>
        </div>
      </div>

      {/* 3 Categories Filter Tabs: All, Won, Lost */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/60 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          {[
            { id: 'ALL', label: `All (${actionableSignals.length})` },
            { id: 'WON', label: `Won (${wins})` },
            { id: 'LOST', label: `Lost (${losses})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setFilterTab(tab.id as HistoryFilterTab);
                setVisibleCount(10);
              }}
              className={`px-3 py-1 rounded-xl font-bold transition ${
                filterTab === tab.id
                  ? 'bg-slate-800 text-white border border-slate-700 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <span className="text-[10px] text-slate-500 hidden sm:inline">
          Showing {displayedList.length} of {filteredList.length}
        </span>
      </div>

      {/* Signals Ledger List */}
      {displayedList.length === 0 ? (
        <div className="text-center py-8 px-4 bg-slate-950/60 border border-slate-800/60 rounded-xl space-y-2">
          <div className="w-9 h-9 mx-auto rounded-full bg-slate-800/60 flex items-center justify-center text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p className="text-xs text-slate-300 font-bold">
            {filterTab === 'WON'
              ? 'No winning trades logged yet'
              : filterTab === 'LOST'
              ? 'No losing trades logged'
              : 'No actionable signals generated in current session'}
          </p>
          <p className="text-[11px] text-slate-500 max-w-md mx-auto">
            {filterTab === 'ALL'
              ? 'Click "Re-Check & Scan" above to compute an institutional setup. Confirmed CALL/PUT trades will appear here automatically.'
              : 'Trades marked with outcomes will appear under this category tab.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayedList.map((sig, index) => {
            const isCall = sig.direction === 'CALL' || (sig.direction as string) === 'BUY';
            const isWin = sig.outcome === 'WIN';
            const isLoss = sig.outcome === 'LOSS';
            const isInTrade = sig.outcome === 'IN_TRADE';
            const profileLabel = sig.platformProfile === 'MT5' ? 'MetaTrader 5' : 'Quick Expiry';

            return (
              <div
                key={sig.id || index}
                className="bg-slate-950 border border-slate-800 hover:border-slate-700 transition rounded-xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
              >
                {/* 1. Asset & Direction */}
                <div className="flex items-center gap-3 min-w-[170px]">
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center font-black text-xs shrink-0 shadow-md ${
                      isCall
                        ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                        : 'bg-rose-500/15 border border-rose-500/30 text-rose-400'
                    }`}
                  >
                    {isCall ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                      </svg>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-white text-xs">{sig.asset}</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-cyan-300 font-semibold border border-slate-700">
                        {sig.timeframe.toUpperCase()}
                      </span>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-900 text-slate-400 border border-slate-800">
                        {profileLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                      <span className={isCall ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                        {sig.direction}
                      </span>
                      <span>&bull;</span>
                      <span className="text-slate-500">{formatTime(sig.generatedAt)}</span>
                      <span>&bull;</span>
                      <span className="text-emerald-400/90">{sig.confidence}% Conf</span>
                    </div>
                  </div>
                </div>

                {/* 2. Entry Strike & Target */}
                <div className="flex items-center gap-4 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase">Entry Strike</span>
                    <span className="font-bold text-slate-100">{sig.entryPrice.toFixed(activeAsset.decimals)}</span>
                  </div>
                  {sig.targetPrice && (
                    <div>
                      <span className="text-[10px] text-slate-500 block uppercase">Target Strike</span>
                      <span className="font-bold text-amber-300/90">{sig.targetPrice.toFixed(activeAsset.decimals)}</span>
                    </div>
                  )}
                </div>

                {/* 3. Sparkline Chart Visualization */}
                <div className="hidden sm:block">
                  {renderSparkline(sig.sparkline, sig.entryPrice, sig.direction, sig.outcome)}
                </div>

                {/* 4. Outcome Badge & Controls */}
                <div className="flex items-center gap-2 shrink-0">
                  {isWin ? (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-black shadow-sm">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                      </svg>
                      <span>WON</span>
                      {typeof sig.pipDiff === 'number' && (
                        <span className="text-[10px] opacity-80">(+{sig.pipDiff} pips)</span>
                      )}
                    </div>
                  ) : isLoss ? (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-400 text-xs font-black shadow-sm">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      <span>LOST</span>
                      {typeof sig.pipDiff === 'number' && (
                        <span className="text-[10px] opacity-80">({sig.pipDiff} pips)</span>
                      )}
                    </div>
                  ) : isInTrade ? (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                      <span>IN TRADE</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] px-2 py-1 rounded bg-slate-800 text-slate-400 border border-slate-700">
                        PENDING
                      </span>
                      {onUpdateOutcome && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            title="Log Win"
                            onClick={() => onUpdateOutcome(sig.id, 'WIN')}
                            className="px-2 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded text-[10px] font-bold transition border border-emerald-500/30 cursor-pointer"
                          >
                            +W
                          </button>
                          <button
                            type="button"
                            title="Log Loss"
                            onClick={() => onUpdateOutcome(sig.id, 'LOSS')}
                            className="px-2 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 rounded text-[10px] font-bold transition border border-rose-500/30 cursor-pointer"
                          >
                            -L
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Load More Pagination */}
          {hasMore && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + 10)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-200 rounded-xl text-xs font-bold transition border border-slate-700"
              >
                Load More ({filteredList.length - visibleCount} remaining)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
