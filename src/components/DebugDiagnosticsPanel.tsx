import React, { useEffect, useState } from 'react';
import {
  getLiveFeed,
  getFeedDiagnostics,
  subscribeDiagnostics,
  type FeedDiagnosticsSnapshot,
} from '../services/feedSingleton.ts';
import { subscribeAssetRegistry, getAssetRegistryInfo } from '../services/assetRegistry.ts';
import {
  formatChartDiagnosticsLines,
  formatChartLastUpdateTime,
  getChartDiagnosticsSnapshot,
  subscribeChartDiagnostics,
  type ChartDiagnosticsSnapshot,
} from '../utils/chartDiagnostics.ts';
import { useBrand } from '../utils/brand.ts';

export function DebugDiagnosticsPanel() {
  const { siteName } = useBrand();
  const [diag, setDiag] = useState<FeedDiagnosticsSnapshot>(() => getFeedDiagnostics());
  const [chartDiag, setChartDiag] = useState<ChartDiagnosticsSnapshot>(() =>
    getChartDiagnosticsSnapshot()
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getLiveFeed();
    setDiag(getFeedDiagnostics());
    setChartDiag(getChartDiagnosticsSnapshot());

    const unsubDiag = subscribeDiagnostics((next) => setDiag(next));
    const unsubReg = subscribeAssetRegistry(() => {
      setDiag(getFeedDiagnostics());
    });
    const unsubChart = subscribeChartDiagnostics((next) => setChartDiag(next));
    const timer = setInterval(() => {
      setDiag(getFeedDiagnostics());
      setChartDiag(getChartDiagnosticsSnapshot());
    }, 1000);

    return () => {
      unsubDiag();
      unsubReg();
      unsubChart();
      clearInterval(timer);
    };
  }, []);

  const registryInfo = diag.registry || getAssetRegistryInfo();
  const counts = registryInfo.categoryCounts;
  const liveChartDiag = getChartDiagnosticsSnapshot();
  const displayChart = chartDiag.activeSymbol ? chartDiag : liveChartDiag;

  const isFeedProblem = diag.status === 'OFFLINE' || diag.status === 'RECONNECTING';
  const statusDisplay = diag.status === 'IDLE' ? 'Idle — pick an asset' : diag.status;

  const formatPlainReport = (): string => {
    const ageLabel = diag.tickAgeSec !== null ? `${diag.tickAgeSec}s` : 'N/A';
    const latestChart = getChartDiagnosticsSnapshot();
    return [
      `${siteName.toUpperCase()} FEED DIAGNOSTICS`,
      `Timestamp: ${new Date().toISOString()}`,
      `Endpoint: ${diag.endpoint || 'N/A'}`,
      `Feed Status: ${statusDisplay} (reason: ${diag.reason || 'none'}, issue: ${isFeedProblem ? 'YES' : 'NO'})`,
      `Last Tick Age: ${ageLabel}`,
      `Reconnect Count (since page load): ${diag.reconnectCount}`,
      `Registry Source: ${registryInfo.source} (reason: ${registryInfo.reason})`,
      `Registry Assets Total: ${registryInfo.total}`,
      `Categories: Forex=${counts.Forex}, Stocks=${counts.Stocks}, Indices=${counts.Indices}, Commodities=${counts.Commodities}, Crypto=${counts.Crypto}, Synthetics=${counts.Synthetics}`,
      `Last Feed Error: ${diag.lastError || 'None'}`,
      ...formatChartDiagnosticsLines(latestChart),
    ].join('\n');
  };

  const handleCopyReport = async () => {
    const report = formatPlainReport();
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback textarea copy if clipboard API unavailable
      try {
        const el = document.createElement('textarea');
        el.value = report;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.warn('[DebugDiagnosticsPanel] Copy failed:', err);
      }
    }
  };

  return (
    <div
      id="debug-diagnostics-panel"
      className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-4 font-mono text-xs text-slate-200 shadow-2xl space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="font-bold text-cyan-300 uppercase tracking-wider">
            Feed Diagnostics (?debug=1)
          </span>
        </div>
        <button
          type="button"
          id="btn-copy-debug-report"
          onClick={handleCopyReport}
          className="px-3 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 font-bold text-[11px] transition cursor-pointer"
        >
          {copied ? '✓ Copied report' : 'Copy report'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 space-y-1">
          <div className="text-slate-400">Current Endpoint</div>
          <div className="text-emerald-300 break-all font-bold">{diag.endpoint || 'N/A'}</div>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 space-y-1">
          <div className="text-slate-400">Feed Status &amp; Reason</div>
          <div className={`font-bold ${isFeedProblem ? 'text-rose-300' : 'text-white'}`}>
            {statusDisplay}{' '}
            <span className="text-slate-400 font-normal">
              ({diag.status === 'IDLE' ? 'no feed problems' : diag.reason || 'none'})
            </span>
          </div>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 space-y-1">
          <div className="text-slate-400">Last Tick Age / Reconnects</div>
          <div className="text-white font-bold">
            {diag.tickAgeSec !== null ? `${diag.tickAgeSec}s` : 'N/A'} &bull; Reconnects:{' '}
            <span className="text-amber-300">{diag.reconnectCount}</span>
          </div>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 space-y-1">
          <div className="text-slate-400">Registry Source</div>
          <div className="text-white font-bold">
            <span className={registryInfo.source === 'live' ? 'text-emerald-400' : 'text-amber-300'}>
              {registryInfo.source}
            </span>{' '}
            <span className="text-slate-400 font-normal">({registryInfo.reason})</span>
          </div>
        </div>
      </div>

      <div
        data-testid="debug-chart-section"
        className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-[11px] space-y-1.5"
      >
        <div className="text-cyan-300 font-bold uppercase tracking-wider">Chart</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-slate-200">
          <div>
            Buffer ticks ({displayChart.activeSymbol || 'none'}):{' '}
            <strong className="text-white">{displayChart.bufferTickCount}</strong>
          </div>
          <div>
            Series points:{' '}
            <strong className="text-white">{displayChart.seriesPointCount}</strong>
          </div>
          <div>
            wsConnected:{' '}
            <strong className={displayChart.wsConnected ? 'text-emerald-400' : 'text-amber-300'}>
              {String(displayChart.wsConnected)}
            </strong>
          </div>
          <div>
            Interval:{' '}
            <strong className="text-white">{displayChart.selectedInterval || 'tick'}</strong>
          </div>
          <div className="sm:col-span-2">
            Last chart update:{' '}
            <strong className="text-slate-300">
              {formatChartLastUpdateTime(displayChart.lastUpdateAtMs)}
            </strong>
          </div>
        </div>
      </div>

      <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-[11px] space-y-1">
        <div className="text-slate-400">Assets Per Category (Total: {registryInfo.total})</div>
        <div className="flex flex-wrap gap-2 text-slate-200">
          <span>Forex: <strong>{counts.Forex}</strong></span>
          <span>Stocks: <strong>{counts.Stocks}</strong></span>
          <span>Indices: <strong>{counts.Indices}</strong></span>
          <span>Commodities: <strong>{counts.Commodities}</strong></span>
          <span>Crypto: <strong>{counts.Crypto}</strong></span>
          <span>Synthetics: <strong>{counts.Synthetics}</strong></span>
        </div>
      </div>

      <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-[11px] space-y-1">
        <div className="text-slate-400">Last Feed Error Message</div>
        <div className={diag.lastError ? 'text-rose-300 break-words' : 'text-slate-500'}>
          {diag.lastError || 'None'}
        </div>
      </div>
    </div>
  );
}
