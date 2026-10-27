import React from 'react';
import { SafeImage } from './SafeImage.tsx';

interface AboutPageProps {
  onGetStarted: () => void;
  onLaunchCockpit: () => void;
}

export function AboutPage({ onGetStarted, onLaunchCockpit }: AboutPageProps) {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-16">
      {/* Header */}
      <div className="text-center space-y-3 max-w-2xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-500/30 text-xs font-mono text-emerald-400">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Institutional Research &amp; Quantitative Engineering</span>
        </div>
        <h1 className="text-2xl sm:text-4xl font-black text-white font-mono">
          About PulseTrade Pro
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
          Pioneering sub-second statistical intelligence and strict behavioral risk protocols for retail options and synthetic traders worldwide.
        </p>
      </div>

      {/* Hero Visual */}
      <div className="aspect-[21/9] w-full rounded-3xl overflow-hidden border border-slate-800 relative">
        <SafeImage
          src="https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?auto=format&fit=crop&w=1200&q=80"
          alt="Quantitative Research Trading Desk"
          fallbackTitle="PulseTrade Quantitative Laboratory"
          className="w-full h-full object-cover opacity-85"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/30 to-transparent flex items-end p-6">
          <div className="font-mono text-xs text-emerald-300">
            <strong>PulseTrade Core Lab</strong> • Multi-Timeframe Algorithmic Confluence Engine
          </div>
        </div>
      </div>

      {/* Mission & Core Philosophy */}
      <div className="grid md:grid-cols-2 gap-8 items-center">
        <div className="space-y-4">
          <span className="text-xs font-mono font-bold uppercase text-emerald-400 tracking-widest">
            Our Mission
          </span>
          <h2 className="text-xl sm:text-2xl font-black text-white font-mono">
            Democratizing High-Frequency Edge for Retail Traders
          </h2>
          <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
            Institutional trading firms spend hundreds of millions on low-latency data feeds and statistical models. Retail traders are often left relying on laggy indicators or scam bots that promise unrealistic 100% win rates.
          </p>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
            PulseTrade Pro was founded to bridge this gap. We provide a rigorous, transparent quantitative companion that combines 1-hour macro trend direction with 1-minute order-flow exhaustion, enforces an unyielding 6-second freshness entry window, and forces adherence to a 2% account preservation rule.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 font-mono">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider text-emerald-400">
            Non-Custodial Commitment
          </h3>
          <ul className="space-y-3 text-xs text-slate-300">
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong>Zero Deposit Handling:</strong> We never accept trading capital or touch user funds. You trade exclusively on your own licensed broker accounts.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong>Direct Deriv Feed:</strong> Live ticks stream straight from Deriv&apos;s authoritative WebSocket servers with zero intermediary delays.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong>Mandatory Honest Logging:</strong> Every trade is validated through our outcome feedback loop to eliminate survivorship bias in performance stats.</span>
            </li>
          </ul>
        </div>
      </div>

      {/* The 4 Architectural Pillars */}
      <div className="space-y-6">
        <div className="text-center space-y-1">
          <span className="text-xs font-mono font-bold uppercase text-amber-400 tracking-widest">
            Engineering Rigor
          </span>
          <h2 className="text-xl sm:text-2xl font-black text-white font-mono">
            The 4 Architectural Pillars of PulseTrade Pro
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-4 font-mono text-xs">
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-2">
            <div className="text-emerald-400 font-bold text-sm">01. Multi-Timeframe Confluence</div>
            <p className="text-slate-400 leading-relaxed">
              Signals are only generated when the 1-hour macro vector, the 1-minute micro-candle structure, and raw tick momentum agree on direction with an 85%+ confidence score.
            </p>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-2">
            <div className="text-teal-400 font-bold text-sm">02. 6-Second Radial Freshness</div>
            <p className="text-slate-400 leading-relaxed">
              If an options trade is placed more than 6 seconds after inflection, broker re-quoting destroys the edge. Our radial countdown locks expired setups automatically.
            </p>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-2">
            <div className="text-amber-400 font-bold text-sm">03. 2% Capital Preservation Guard</div>
            <p className="text-slate-400 leading-relaxed">
              Martingale staking is mathematically ruinous. Our risk advisor dynamically limits trade sizes to 2% of account balance to guarantee bankroll longevity.
            </p>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-2">
            <div className="text-indigo-400 font-bold text-sm">04. 30-Day Protected VIP Slots</div>
            <p className="text-slate-400 leading-relaxed">
              VIP access is managed with cryptographic keys and strict 30-calendar-day expirations. Once 30 days elapse, VIP privileges conclude cleanly to eliminate unauthorized overstay.
            </p>
          </div>
        </div>
      </div>

      {/* Regulatory & Risk Transparency */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-4 font-mono text-xs text-slate-400">
        <h3 className="text-sm font-bold text-slate-200 uppercase">
          Regulatory Compliance &amp; Risk Disclosure
        </h3>
        <p className="leading-relaxed">
          Trading binary options, digital contracts, synthetic volatility indices, and foreign exchange entails substantial risk of financial loss. Past performance, backtests, and algorithmic win-rate statistics do not guarantee future results.
        </p>
        <p className="leading-relaxed">
          PulseTrade Pro is a quantitative analytical tool and software companion, not a registered investment advisor, broker, or financial manager. You are solely responsible for determining whether any trading strategy or risk level is suitable for your financial position. Never trade with capital you cannot afford to lose.
        </p>
      </div>

      {/* CTA Footer */}
      <div className="text-center space-y-4 pt-4">
        <h3 className="text-lg font-bold text-white font-mono">Ready to experience the edge?</h3>
        <div className="flex flex-wrap justify-center gap-3 font-mono">
          <button
            type="button"
            onClick={onGetStarted}
            className="py-3 px-6 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition shadow-lg shadow-emerald-500/20"
          >
            Get Started Free (10 Credits) &rarr;
          </button>
          <button
            type="button"
            onClick={onLaunchCockpit}
            className="py-3 px-5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition"
          >
            Launch Live Cockpit
          </button>
        </div>
      </div>
    </div>
  );
}
