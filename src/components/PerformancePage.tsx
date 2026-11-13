import React from 'react';

interface PerformancePageProps {
  onLaunchCockpit: () => void;
  onOpenPricing?: () => void;
  onGetStarted?: () => void;
}

export function PerformancePage({ onLaunchCockpit }: PerformancePageProps) {
  return (
    <div className="max-w-5xl mx-auto space-y-6 font-mono text-xs animate-in fade-in duration-200">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-7 shadow-xl space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Verification Ledger
              </span>
            </div>
            <h1 className="text-xl sm:text-3xl font-black text-white mt-1">
              Public Performance Ledger
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onLaunchCockpit}
              className="py-2 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold transition shadow"
            >
              Launch Cockpit →
            </button>
          </div>
        </div>

        <p className="text-slate-400 font-sans text-xs sm:text-sm leading-relaxed max-w-3xl">
          Tolvexa only publishes performance data derived from signals that have been recorded and settled by our
          system. <strong>WAIT signals are never recorded as wins or losses.</strong>
        </p>
      </div>

      {/* Honest Empty State */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-8 sm:p-12 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mx-auto text-slate-400">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <h2 className="text-base sm:text-lg font-bold text-white">
          Awaiting Verified Signal History
        </h2>
        <p className="font-sans text-xs sm:text-sm text-slate-300 max-w-xl mx-auto leading-relaxed">
          Verified results will appear here once enough signals have been recorded and settled by our system. We do not publish estimated or sample results.
        </p>
      </div>

      {/* Breakeven Explanation Banner */}
      <div className="bg-amber-950/25 border border-amber-500/30 rounded-2xl p-4 space-y-2 text-slate-300">
        <div className="flex items-center gap-2 text-amber-300 font-bold text-xs uppercase">
          <span>⚖️ Understanding Binary Breakeven Economics</span>
        </div>
        <p className="font-sans text-xs leading-relaxed text-slate-300">
          In fixed-odds options trading, payout ratios determine the minimum win rate required to avoid losing money
          over time. For example, at an illustrative 85% broker payout, a 50% win rate produces a net loss; to reach
          mathematical breakeven at an 85% payout, a trader needs at least{' '}
          <strong className="text-amber-300">54.05% win rate</strong> (1 &divide; 1.85). Break-even thresholds vary
          directly with the broker payout offered on each contract.
        </p>
      </div>

      {/* Prominent Risk Disclosure Notice */}
      <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 space-y-2 text-slate-400 text-xs">
        <h3 className="text-white font-bold uppercase text-xs flex items-center gap-1.5">
          <span>⚠️ Mandatory Regulatory Risk Disclosure</span>
        </h3>
        <p className="font-sans leading-relaxed">
          Trading binary options, digital contracts, foreign exchange, and synthetic indices involves high financial risk
          and may not be suitable for all individuals. Rapid price fluctuations can result in the loss of your entire initial
          stake. Historical win rates and statistical analyses do not guarantee future profitability. Tolvexa provides
          quantitative signals for analytical decision support only. Never trade with money you cannot afford to lose.
        </p>
      </div>
    </div>
  );
}
