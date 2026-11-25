import React, { useEffect, useState } from 'react';
import type { MarketContextSummary } from '../utils/engines/marketContext.ts';
import { formatDistanceUnitWord } from '../utils/instrumentMeta.ts';
import {
  buildMarketContextSummaryLines,
  getSortedNearestLevels,
  getTopAndQuietSessionHours,
} from '../utils/resultView.ts';

interface MarketContextPanelProps {
  context: MarketContextSummary | null;
  isLoading?: boolean;
}

export function MarketContextPanel({ context, isLoading = false }: MarketContextPanelProps) {
  const [isFullOpen, setIsFullOpen] = useState(false);
  const [showAllLevels, setShowAllLevels] = useState(false);
  const [showAllHours, setShowAllHours] = useState(false);

  useEffect(() => {
    setIsFullOpen(false);
    setShowAllLevels(false);
    setShowAllHours(false);
  }, [context?.symbol]);

  if (isLoading && !context) {
    return (
      <section
        id="market-context-panel"
        aria-label="Market Context"
        className="bg-slate-950/90 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-400 space-y-1.5"
      >
        <div className="font-semibold text-slate-200">Market Context</div>
        <div className="text-[11px] text-slate-500">
          Loading multi-timeframe trend, key levels, volatility regime, and session profile...
        </div>
      </section>
    );
  }

  if (!context) {
    return null;
  }

  const { trendTable, levelsMap, volatilityRegime, sessionProfile, decimals, currentPrice } = context;
  const distanceUnit = context.distanceUnit || 'pips';
  const unitShort = distanceUnit === 'points' ? ' pts' : distanceUnit === 'pips' ? 'p' : '';

  const summary = buildMarketContextSummaryLines(context);
  const nearestSortedLevels = getSortedNearestLevels(context);
  const displayedLevels = showAllLevels ? nearestSortedLevels : nearestSortedLevels.slice(0, 5);
  const { mostActiveHours, quietestHours } = getTopAndQuietSessionHours(context);

  const regimeTextColor =
    volatilityRegime.regime === 'unusually active'
      ? 'text-amber-300'
      : volatilityRegime.regime === 'quiet'
      ? 'text-slate-300'
      : 'text-emerald-300';

  const maxHourAvg = sessionProfile.hours.reduce((max, h) => {
    return h.avgRangePips !== null && h.avgRangePips > max ? h.avgRangePips : max;
  }, 0);

  return (
    <section
      id="market-context-panel"
      aria-label="Market Context"
      className="bg-slate-950/90 border border-slate-800 rounded-xl p-3.5 space-y-3 text-slate-200"
    >
      {/* Compact 3-line summary (always shown first) */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div className="space-y-1 text-xs leading-relaxed">
          <div className="flex flex-wrap items-baseline gap-2">
            <h4 className="font-semibold text-white">Market Context &bull; {context.assetName}</h4>
            <span className="text-[11px] font-mono text-slate-400 tabular-nums">
              Spot {currentPrice > 0 ? currentPrice.toFixed(decimals) : 'N/A'}
            </span>
          </div>
          <p className="text-[11px] text-slate-300">{summary.trendLine}</p>
          <p className="text-[11px] text-slate-300">{summary.volatilityLine}</p>
          <p className="text-[11px] text-slate-300">{summary.levelsLine}</p>
        </div>

        <button
          type="button"
          onClick={() => setIsFullOpen((prev) => !prev)}
          aria-expanded={isFullOpen}
          className="shrink-0 self-start text-[11px] font-mono font-semibold text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 bg-emerald-950/30 px-2.5 py-1.5 rounded-lg transition cursor-pointer"
        >
          {isFullOpen ? 'Hide full context' : 'See full context'}
        </button>
      </div>

      {/* Expanded full context (hidden by default) */}
      {isFullOpen && (
        <div className="space-y-4 pt-3 border-t border-slate-800">
          <div className="text-[11px] font-mono text-slate-400 tabular-nums flex flex-wrap justify-between gap-2">
            <span>
              {distanceUnit === 'points'
                ? `Point size ${context.pipSize}`
                : distanceUnit === 'pips'
                ? `Pip size ${context.pipSize}`
                : `Tick size ${context.tickSize ?? context.pipSize}`}{' '}
              &middot; Identical audit data for Free &amp; VIP
            </span>
            <span className="text-slate-500">No win rates or outcome estimates</span>
          </div>

          {/* 1. Multi-Timeframe Trend Table */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-xs font-semibold text-slate-200">
                01. Multi-Timeframe Trend (EMA 9 / 21 / 50)
              </h5>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                Timeframes: M15, H1, H4, D1
              </span>
            </div>

            <div className="overflow-x-auto border border-slate-800 rounded-xl">
              <table className="w-full text-left font-mono text-[11px] tabular-nums border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                    <th className="py-2 px-3 font-medium">Timeframe</th>
                    <th className="py-2 px-3 font-medium">Direction</th>
                    <th className="py-2 px-3 font-medium">Strength</th>
                    <th className="py-2 px-3 font-medium text-right">Distance from EMA 21</th>
                    <th className="py-2 px-3 font-medium text-right">Sample</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {trendTable.map((row) => {
                    const dirClass =
                      row.direction === 'Bullish'
                        ? 'text-emerald-400'
                        : row.direction === 'Bearish'
                        ? 'text-rose-400'
                        : 'text-slate-400';

                    const distLabel =
                      row.distancePips !== null && row.distancePct !== null
                        ? distanceUnit === 'price'
                          ? (() => {
                              const priceDiff =
                                row.lastClose !== null && row.ema21 !== null
                                  ? row.lastClose - row.ema21
                                  : row.distancePips * context.pipSize;
                              return `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(decimals)} (${row.distancePct >= 0 ? '+' : ''}${row.distancePct.toFixed(2)}%)`;
                            })()
                          : `${row.distancePips >= 0 ? '+' : ''}${row.distancePips.toFixed(1)} ${formatDistanceUnitWord(row.distancePips, distanceUnit)} (${row.distancePct >= 0 ? '+' : ''}${row.distancePct.toFixed(2)}%)`
                        : 'Insufficient data';

                    return (
                      <tr key={row.timeframe} className="hover:bg-slate-900/40">
                        <td className="py-2 px-3 font-bold text-slate-200">{row.timeframe}</td>
                        <td className={`py-2 px-3 font-semibold ${dirClass}`}>{row.direction}</td>
                        <td className="py-2 px-3 text-slate-300">{row.strength}</td>
                        <td className="py-2 px-3 text-right text-slate-300">{distLabel}</td>
                        <td className="py-2 px-3 text-right text-slate-500">n={row.sampleCount} bars</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. Key Levels Map (5 nearest by default) */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-xs font-semibold text-slate-200">
                02. Key Levels Map
              </h5>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {nearestSortedLevels.length} levels mapped (D1 n={context.pivotSampleCount} / H1 n={trendTable.find((t) => t.timeframe === 'H1')?.sampleCount ?? 0})
              </span>
            </div>

            {nearestSortedLevels.length === 0 ? (
              <div className="text-[11px] font-mono text-slate-500 border border-slate-800 rounded-xl p-3">
                No key levels available yet (insufficient candle history; n={context.pivotSampleCount} D1 bars).
              </div>
            ) : (
              <div className="border border-slate-800 rounded-xl divide-y divide-slate-800/70 font-mono text-[11px] tabular-nums">
                {displayedLevels.map((lvl) => (
                  <div
                    key={lvl.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-slate-200 font-medium truncate">{lvl.plainText}</span>
                      <span className="text-slate-600 shrink-0">&bull;</span>
                      <span className="text-slate-500 shrink-0">{lvl.group}</span>
                    </div>
                    <div className="flex items-center gap-3 text-slate-400 shrink-0">
                      <span>{lvl.price.toFixed(decimals)}</span>
                      <span className="text-slate-500">n={lvl.sampleCount}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {nearestSortedLevels.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllLevels((v) => !v)}
                className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 transition cursor-pointer"
              >
                {showAllLevels ? 'Show fewer levels' : `Show all levels (${nearestSortedLevels.length})`}
              </button>
            )}
          </div>

          {/* 3. Volatility Regime */}
          <div className="space-y-2 border-t border-slate-800 pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-xs font-semibold text-slate-200">
                03. Daily Volatility Regime (ATR 14 vs 30-Day Distribution)
              </h5>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                n={volatilityRegime.sampleCount} daily ATR observations
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border border-slate-800 rounded-xl p-3 font-mono text-xs tabular-nums">
              <div>
                <div className="text-[10px] text-slate-500">Regime Classification</div>
                <div className={`font-semibold capitalize mt-0.5 ${regimeTextColor}`}>
                  {volatilityRegime.sampleCount > 0 ? volatilityRegime.regime : 'unavailable'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">n={volatilityRegime.sampleCount} days</div>
              </div>

              <div>
                <div className="text-[10px] text-slate-500">Current Daily ATR(14)</div>
                <div className="font-semibold text-white mt-0.5">
                  {distanceUnit === 'price'
                    ? volatilityRegime.currentAtr !== null
                      ? volatilityRegime.currentAtr.toFixed(decimals)
                      : 'N/A'
                    : volatilityRegime.currentAtrPips !== null
                    ? `${volatilityRegime.currentAtrPips.toFixed(1)} ${formatDistanceUnitWord(volatilityRegime.currentAtrPips, distanceUnit)}`
                    : 'N/A'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {volatilityRegime.currentAtr !== null
                    ? `${volatilityRegime.currentAtr.toFixed(decimals)} price units`
                    : 'n=0'}
                </div>
              </div>

              <div>
                <div className="text-[10px] text-slate-500">30-Day Percentile Rank</div>
                <div className="font-semibold text-slate-200 mt-0.5">
                  {volatilityRegime.percentile30d !== null
                    ? `${volatilityRegime.percentile30d.toFixed(1)}th percentile`
                    : 'N/A'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Quiet &lt;30 &middot; Normal 30–75 &middot; Active &gt;75 (n={volatilityRegime.sampleCount})
                </div>
              </div>
            </div>
          </div>

          {/* 4. 8-Week UTC Session Profile (Top 3 Most Active & Quietest by default + Show all hours) */}
          <div className="space-y-2 border-t border-slate-800 pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-xs font-semibold text-slate-200">
                04. Hourly Session Range Profile (Last {sessionProfile.lookbackWeeks} Weeks, UTC)
              </h5>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                Total sample: n={sessionProfile.totalBars} H1 candles
              </span>
            </div>

            {sessionProfile.totalBars === 0 ? (
              <div className="text-[11px] font-mono text-slate-500 border border-slate-800 rounded-xl p-3">
                No cached H1 candles in trailing {sessionProfile.lookbackWeeks}-week window (n=0 H1 bars).
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 font-mono text-[11px] tabular-nums">
                  <div className="border border-emerald-500/25 bg-slate-900/40 rounded-xl p-2.5 space-y-1.5">
                    <div className="text-[11px] font-semibold text-emerald-300">Most active hours</div>
                    {mostActiveHours.map((b) => (
                      <div key={b.hourUtc} className="flex items-center justify-between text-slate-300">
                        <span>{b.hourLabel} UTC</span>
                        <span>
                          {distanceUnit === 'price'
                            ? ((b.avgRangePips ?? 0) * context.pipSize).toFixed(decimals)
                            : `${b.avgRangePips?.toFixed(1)} ${formatDistanceUnitWord(b.avgRangePips ?? 0, distanceUnit)}`}{' '}
                          <span className="text-slate-500">(n={b.sampleCount})</span>
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="border border-slate-800 bg-slate-900/40 rounded-xl p-2.5 space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-200">Quietest hours</div>
                    {quietestHours.map((b) => (
                      <div key={b.hourUtc} className="flex items-center justify-between text-slate-300">
                        <span>{b.hourLabel} UTC</span>
                        <span>
                          {distanceUnit === 'price'
                            ? ((b.avgRangePips ?? 0) * context.pipSize).toFixed(decimals)
                            : `${b.avgRangePips?.toFixed(1)} ${formatDistanceUnitWord(b.avgRangePips ?? 0, distanceUnit)}`}{' '}
                          <span className="text-slate-500">(n={b.sampleCount})</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowAllHours((v) => !v)}
                  className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 transition cursor-pointer"
                >
                  {showAllHours ? 'Hide 24-hour table' : 'Show all hours (24h UTC)'}
                </button>

                {showAllHours && (
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 font-mono text-[10px] tabular-nums">
                    {sessionProfile.hours.map((bucket) => {
                      const ratio =
                        maxHourAvg > 0 && bucket.avgRangePips !== null
                          ? Math.min(1, bucket.avgRangePips / maxHourAvg)
                          : 0;
                      const isPeak = sessionProfile.mostActiveHour?.hourUtc === bucket.hourUtc;

                      return (
                        <div
                          key={bucket.hourUtc}
                          className={`border rounded-lg p-1.5 space-y-1 ${
                            isPeak ? 'border-emerald-500/40 bg-emerald-950/20' : 'border-slate-800 bg-slate-900/40'
                          }`}
                        >
                          <div className="flex items-center justify-between text-slate-400">
                            <span>{bucket.hourLabel}</span>
                            <span className="text-slate-500">n={bucket.sampleCount}</span>
                          </div>
                          <div className="text-slate-200 font-semibold">
                            {bucket.avgRangePips !== null
                              ? distanceUnit === 'price'
                                ? (bucket.avgRangePips * context.pipSize).toFixed(decimals)
                                : `${bucket.avgRangePips.toFixed(1)}${unitShort}`
                              : '—'}
                          </div>
                          <svg viewBox="0 0 100 4" className="w-full h-1 rounded overflow-hidden bg-slate-800 block" aria-hidden="true">
                            <rect
                              x="0"
                              y="0"
                              width={Math.round(ratio * 100)}
                              height="4"
                              fill={isPeak ? '#34d399' : '#64748b'}
                            />
                          </svg>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

