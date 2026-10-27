import React from 'react';
import type { UserProfile, BlogArticle } from '../types.ts';
import { BLOG_ARTICLES } from '../data/blogArticles.ts';
import { SafeImage } from './SafeImage.tsx';
import { getSiteSettings, getPricingPackages, getBrokerPlatforms } from '../utils/siteConfigManager.ts';

interface LandingPageProps {
  user: UserProfile | null;
  onGetStarted: () => void;
  onOpenLogin: () => void;
  onLaunchCockpit: () => void;
  onSelectArticle: (article: BlogArticle) => void;
  onNavigateToPricing: () => void;
  onNavigateToAbout: () => void;
}

export function LandingPage({
  user,
  onGetStarted,
  onOpenLogin,
  onLaunchCockpit,
  onSelectArticle,
  onNavigateToPricing,
  onNavigateToAbout,
}: LandingPageProps) {
  const siteSettings = getSiteSettings();
  const pricingPackages = getPricingPackages();
  const vipPkg = pricingPackages.find((p) => p.type === 'VIP_30_DAY');
  const starterPkg = pricingPackages.find((p) => p.type === 'CREDITS');
  const vipPrice = vipPkg?.price_usd || siteSettings.vipPriceUsd || 49;
  const starterPrice = starterPkg?.price_usd || siteSettings.starterPriceUsd || 5;

  return (
    <div className="space-y-8 sm:space-y-24 pb-12 sm:pb-16">
      {/* HERO SECTION */}
      <section className="relative pt-2 sm:pt-12 px-2 sm:px-4 max-w-6xl mx-auto text-center space-y-4 sm:space-y-8">
        {/* Top Trust & Telemetry Pill */}
        <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1 sm:py-1.5 rounded-full bg-slate-900/90 border border-emerald-500/30 text-[11px] sm:text-xs font-mono text-emerald-400 shadow-lg shadow-emerald-950/40">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Deriv WebSocket Real-Time Telemetry</span>
          <span className="text-slate-600 hidden sm:inline">•</span>
          <span className="text-slate-300 hidden sm:inline">Sub-25ms Execution Latency</span>
        </div>

        {/* Hero Title & Subtitle */}
        <div className="max-w-4xl mx-auto space-y-3 sm:space-y-5">
          <h1 className="text-2xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-[1.18]">
            Quantitative Trading Signals with a Strict{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-300 to-amber-300">
              6-Second Window
            </span>
          </h1>
          <p className="text-xs sm:text-lg text-slate-300 max-w-2xl mx-auto leading-relaxed">
            Eliminate emotional bias in binary and digital options. Built for Deriv, ExpertOption, PocketOption, and Quotex with microstructure confluence, session awareness, and capital preservation.
          </p>
        </div>

        {/* CTA Group with 'Get Started' Button */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 sm:gap-3.5 max-w-md mx-auto pt-1 sm:pt-2">
          <button
            type="button"
            onClick={onGetStarted}
            className="w-full sm:w-auto px-6 py-3.5 sm:px-8 sm:py-4 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-sm sm:text-base font-mono rounded-2xl transition shadow-xl shadow-emerald-500/25 hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2 group"
          >
            <span>Get Started Free</span>
            <span className="text-xs bg-slate-950/20 px-2 py-0.5 rounded-md font-bold text-slate-950">
              10 Credits
            </span>
            <svg
              className="w-4 h-4 transition-transform group-hover:translate-x-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onLaunchCockpit}
            className="w-full sm:w-auto px-5 py-3.5 sm:px-6 sm:py-4 bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 text-white font-bold text-xs sm:text-sm font-mono rounded-2xl transition flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Explore Live Cockpit</span>
          </button>
        </div>

        {/* User Status / Protection Notice */}
        <div className="pt-1 text-[11px] sm:text-xs font-mono text-slate-400 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1 text-emerald-400">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
            </svg>
            Zero Credit Card Required
          </span>
          <span className="flex items-center gap-1 text-amber-300">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            VIP Protected Allocation
          </span>
        </div>

        {/* HERO VISUAL & STATISTICAL LEDGER */}
        <div className="pt-4 sm:pt-8">
          <div className="relative mx-auto max-w-5xl rounded-3xl p-1 bg-gradient-to-b from-slate-700/60 via-slate-800/30 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="bg-slate-950 rounded-[22px] p-3 sm:p-6 overflow-hidden space-y-4 sm:space-y-6">
              {/* High-res Trading Dashboard Banner */}
              <div className="relative rounded-2xl overflow-hidden aspect-[21/9] max-h-72 w-full border border-slate-800">
                <SafeImage
                  src="https://images.unsplash.com/photo-1642543492481-44e81e3914a7?auto=format&fit=crop&w=1200&q=80"
                  alt="PulseTrade Pro Algorithmic Cockpit Display"
                  fallbackTitle="PulseTrade Pro Algorithmic Telemetry"
                  className="w-full h-full object-cover opacity-80 hover:scale-105 transition duration-700"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent flex items-end p-3 sm:p-6">
                  <div className="flex flex-wrap items-center justify-between w-full gap-2">
                    <div className="text-left font-mono">
                      <span className="text-[10px] text-emerald-400 uppercase tracking-wider block font-bold">
                        Institutional Order Flow Sync
                      </span>
                      <div className="text-xs sm:text-base font-bold text-white">
                        Deriv Live WebSocket • EUR/USD &amp; Volatility Synthetics
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 bg-slate-900/90 border border-emerald-500/40 px-2.5 py-1 rounded-xl font-mono text-[11px] sm:text-xs text-emerald-300">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span>Prime 6-Sec Window Engine</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 4 Quantitative Performance Metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3 text-left font-mono">
                <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
                  <span className="text-[10px] text-slate-400 uppercase block tracking-wider">
                    Confluence Gate
                  </span>
                  <div className="text-xl sm:text-3xl font-black text-emerald-400 mt-1">Multi-Factor</div>
                  <span className="text-[10px] sm:text-[11px] text-slate-500">WAIT Biased in Chop</span>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
                  <span className="text-[10px] text-slate-400 uppercase block tracking-wider">
                    Tick Latency
                  </span>
                  <div className="text-xl sm:text-3xl font-black text-teal-300 mt-1">&lt;25ms</div>
                  <span className="text-[10px] sm:text-[11px] text-slate-500">Direct Gateway</span>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
                  <span className="text-[10px] text-slate-400 uppercase block tracking-wider">
                    Free Starter Credits
                  </span>
                  <div className="text-xl sm:text-3xl font-black text-amber-300 mt-1">10 CR</div>
                  <span className="text-[10px] sm:text-[11px] text-slate-500">Upon Registration</span>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
                  <span className="text-[10px] text-slate-400 uppercase block tracking-wider">
                    VIP Pass Validity
                  </span>
                  <div className="text-xl sm:text-3xl font-black text-indigo-300 mt-1">30 Days</div>
                  <span className="text-[10px] sm:text-[11px] text-slate-500">Strict Protected Allocation</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION: WHY PULSETRADE PRO (LEGITIMACY & ARCHITECTURE) */}
      <section className="px-4 max-w-6xl mx-auto space-y-12">
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <span className="text-xs font-mono font-bold uppercase text-emerald-400 tracking-widest">
            Institutional Discipline
          </span>
          <h2 className="text-2xl sm:text-4xl font-black text-white">
            Built to Eliminate the 4 Fatal Mistakes of Retail Traders
          </h2>
          <p className="text-sm text-slate-400">
            PulseTrade Pro is not a gimmick bot. It is a mathematical companion designed around hard latency boundaries and strict capital survival rules.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Card 1: 6-Second Window */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-3xl p-6 space-y-4 hover:border-emerald-500/40 transition">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-white font-mono">1. The 6-Second Freshness Window</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              When micro-momentum triggers, broker quote spreads adjust within 800ms. Our radial timer counts down from 6 seconds. If you cannot place the trade before expiration, the signal locks out to protect you from chasing bad strikes.
            </p>
          </div>

          {/* Card 2: 2% Capital Preservation Guard */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-3xl p-6 space-y-4 hover:border-teal-500/40 transition">
            <div className="w-12 h-12 rounded-2xl bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-white font-mono">2. Strict 2% Stake Sizing</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Martingale and 20% stakes wipe accounts during normal variance clusters. PulseTrade Pro calculates your mathematically sound 2% stake based on your broker balance, keeping drawdown strictly contained under 18%.
            </p>
          </div>

          {/* Card 3: Protected VIP 30-Day Timeframe */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-3xl p-6 space-y-4 hover:border-amber-500/40 transition">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-white font-mono">3. Protected 30-Day VIP Allocation</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              VIP slots are protected so the wrong user cannot claim VIP access accidentally. Every verified VIP pass is programmed with a strict 30-day (1 month) expiration window with an active countdown timer to prevent exceeding the allowed timeframe.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION: HOW IT WORKS (3 STEPS) */}
      <section className="px-4 max-w-6xl mx-auto space-y-12">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-10 space-y-8">
          <div className="text-center space-y-2 max-w-xl mx-auto">
            <span className="text-xs font-mono font-bold uppercase text-teal-400 tracking-widest">
              Execution Workflow
            </span>
            <h2 className="text-2xl sm:text-3xl font-black text-white font-mono">
              From Registration to Signal Execution
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-6 font-mono">
            <div className="bg-slate-950 border border-slate-800/80 rounded-2xl p-5 space-y-3 relative">
              <div className="w-8 h-8 rounded-full bg-emerald-500 text-slate-950 font-black text-sm flex items-center justify-center">
                1
              </div>
              <h4 className="text-sm font-bold text-white uppercase">Register &amp; Claim 10 Credits</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Click <strong>Get Started</strong> to register. Your IP is validated by the Citadel Shield, and 10 free credits are deposited immediately without requiring a credit card.
              </p>
            </div>

            <div className="bg-slate-950 border border-slate-800/80 rounded-2xl p-5 space-y-3 relative">
              <div className="w-8 h-8 rounded-full bg-teal-400 text-slate-950 font-black text-sm flex items-center justify-center">
                2
              </div>
              <h4 className="text-sm font-bold text-white uppercase">Monitor Confluence</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                The multi-timeframe algorithm aggregates 1H trend vectors and 1M tick momentum from the live Deriv feed. Audio chimes alert you the millisecond confidence hits 85%+.
              </p>
            </div>

            <div className="bg-slate-950 border border-slate-800/80 rounded-2xl p-5 space-y-3 relative">
              <div className="w-8 h-8 rounded-full bg-amber-400 text-slate-950 font-black text-sm flex items-center justify-center">
                3
              </div>
              <h4 className="text-sm font-bold text-white uppercase">Execute &amp; Log Outcome</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Enter your trade on ExpertOption or Deriv within the 6-second radial window. Log your WIN or LOSS to unlock subsequent signals and reinforce the quantitative model.
              </p>
            </div>
          </div>

          <div className="text-center pt-2">
            <button
              type="button"
              onClick={onGetStarted}
              className="px-8 py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20"
            >
              Get Started with 10 Free Credits &rarr;
            </button>
          </div>
        </div>
      </section>

      {/* SECTION: VIP MEMBERSHIP & PROTECTED 30-DAY TIMEFRAME */}
      <section className="px-4 max-w-6xl mx-auto space-y-10">
        <div className="text-center space-y-2 max-w-xl mx-auto">
          <span className="text-xs font-mono font-bold uppercase text-amber-400 tracking-widest">
            Membership Tiers
          </span>
          <h2 className="text-2xl sm:text-4xl font-black text-white font-mono">
            Transparent Pricing &amp; VIP Access
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            No recurring hidden charges. All VIP passes run for strictly 30 days (1 month) from activation.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {/* Tier 1: Free Starter */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-emerald-400 uppercase tracking-wider font-bold">
                  Starter Tier
                </span>
                <span className="text-[10px] font-mono bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md">
                  Default Registration
                </span>
              </div>
              <div className="font-mono">
                <span className="text-3xl font-black text-white">FREE</span>
                <span className="text-xs text-slate-400 ml-2">10 Starter Credits</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Test the live signals and experience the 6-second radial execution window risk-free.
              </p>
              <ul className="space-y-2.5 text-xs text-slate-300 font-mono pt-2">
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 10 Algorithmic signal credits
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Real-time Deriv WebSocket live feed
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 6-Second entry freshness timer
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 2% Capital risk preservation advisor
                </li>
                <li className="flex items-center gap-2 text-slate-500">
                  <span>✗</span> Unlimited queries (Credits deduct 1 per signal)
                </li>
              </ul>
            </div>

            <button
              type="button"
              onClick={onGetStarted}
              className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs font-bold rounded-xl transition"
            >
              Get Started Free &rarr;
            </button>
          </div>

          {/* Tier 2: VIP 30-Day Protected Pass */}
          <div className="bg-gradient-to-b from-amber-950/40 via-slate-900 to-slate-900 border-2 border-amber-500/60 rounded-3xl p-6 sm:p-8 space-y-6 flex flex-col justify-between relative shadow-2xl shadow-amber-950/50">
            <div className="absolute -top-3.5 right-6 bg-gradient-to-r from-amber-500 to-amber-400 text-slate-950 text-[11px] font-black font-mono px-3 py-1 rounded-full uppercase tracking-wide shadow-md">
              Protected 30-Day Slot
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-amber-300 uppercase tracking-wider font-bold flex items-center gap-1.5">
                  ★ VIP Quant Pass
                </span>
                <span className="text-[10px] font-mono text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded border border-amber-500/40">
                  Strictly 30 Days (1 Month)
                </span>
              </div>
              <div className="font-mono">
                <span className="text-3xl sm:text-4xl font-black text-white">${vipPrice}</span>
                <span className="text-xs text-slate-400 ml-2">/ 30 Days Fixed Access</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Full institutional privilege. Strictly assigned via cryptographic activation key or crypto invoice to ensure only verified traders receive the VIP slot.
              </p>
              <ul className="space-y-2.5 text-xs text-slate-200 font-mono pt-2">
                <li className="flex items-center gap-2">
                  <span className="text-amber-400 font-bold">★</span> Unlimited signals (0 credits deducted)
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-amber-400 font-bold">★</span> Active 30-day live countdown timer
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-amber-400 font-bold">★</span> Strict 30-day timeframe (never exceeds without renewal)
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-amber-400 font-bold">★</span> Priority Deriv WebSocket order-flow stream
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-amber-400 font-bold">★</span> VIP quantitative Discord/Telegram channel
                </li>
              </ul>
            </div>

            <button
              type="button"
              onClick={onNavigateToPricing}
              className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black font-mono text-xs rounded-xl transition shadow-lg shadow-amber-500/25"
            >
              Unlock 30-Day VIP Pass (${vipPrice}) &rarr;
            </button>
          </div>
        </div>
      </section>

      {/* SECTION: SUPPORTED BROKER PLATFORMS */}
      <section className="px-4 max-w-6xl mx-auto space-y-6">
        <div className="text-center space-y-2 max-w-xl mx-auto">
          <span className="text-xs font-mono font-bold uppercase text-emerald-400 tracking-widest">
            Ecosystem Integrations
          </span>
          <h2 className="text-2xl sm:text-3xl font-black text-white font-mono">
            Supported Trading Platforms
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Tolvexa provides synchronized multi-timeframe quantitative signals tailored for both Binary Expiry brokers and MetaTrader 5 institutional accounts.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 font-mono">
          {getBrokerPlatforms().filter((p) => p.enabled).map((platform) => (
            <div
              key={platform.id}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2 flex flex-col justify-between hover:border-slate-700 transition"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xl">{platform.icon}</span>
                  <span className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                    platform.profile === 'MT5'
                      ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  }`}>
                    {platform.profile === 'MT5' ? 'MetaTrader 5' : 'Binary Expiry'}
                  </span>
                </div>
                <h4 className="text-sm font-bold text-white">{platform.name}</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-sans">{platform.description}</p>
              </div>

              {platform.referralUrl ? (
                <a
                  href={platform.referralUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold underline flex items-center justify-between pt-2 border-t border-slate-800"
                >
                  <span>Open Broker</span>
                  <span>↗</span>
                </a>
              ) : (
                <span className="text-[10px] text-slate-500 pt-2 border-t border-slate-800 block">
                  ✓ Full Signal Support
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* SECTION: EDUCATIONAL BLOG & SEO GUIDES */}
      <section className="px-4 max-w-6xl mx-auto space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <span className="text-xs font-mono font-bold uppercase text-emerald-400 tracking-widest">
              Quantitative Academy &amp; SEO Guides
            </span>
            <h2 className="text-2xl sm:text-3xl font-black text-white font-mono mt-1">
              Trading Research &amp; Market Mechanics
            </h2>
          </div>
          <p className="text-xs text-slate-400 max-w-sm">
            Institutional research on latency arbitrage, stake sizing, and multi-timeframe divergence.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {BLOG_ARTICLES.map((article) => (
            <article
              key={article.id}
              className="bg-slate-900/80 border border-slate-800 rounded-3xl overflow-hidden hover:border-slate-700 transition flex flex-col justify-between group"
            >
              <div>
                <div className="relative aspect-[16/9] w-full overflow-hidden">
                  <SafeImage
                    src={article.imageUrl}
                    alt={article.title}
                    fallbackTitle={article.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
                  />
                  <div className="absolute top-3 left-3 bg-slate-950/80 backdrop-blur border border-slate-700 text-emerald-400 text-[10px] font-mono px-2.5 py-1 rounded-lg">
                    {article.category}
                  </div>
                </div>

                <div className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                    <span>{article.date}</span>
                    <span>•</span>
                    <span>{article.readTime}</span>
                    <span>•</span>
                    <span className="text-slate-300">{article.author}</span>
                  </div>

                  <h3 className="text-base sm:text-lg font-bold text-white group-hover:text-emerald-400 transition font-mono leading-snug">
                    {article.title}
                  </h3>

                  <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                    {article.excerpt}
                  </p>
                </div>
              </div>

              <div className="px-5 pb-5 sm:px-6 sm:pb-6 pt-2 flex items-center justify-between border-t border-slate-800/80 font-mono text-xs">
                <div className="flex flex-wrap gap-1.5">
                  {article.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="bg-slate-950 text-slate-400 text-[10px] px-2 py-0.5 rounded border border-slate-800"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => onSelectArticle(article)}
                  className="text-emerald-400 hover:text-emerald-300 font-bold hover:underline flex items-center gap-1"
                >
                  Read Article &rarr;
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* SECTION: FREQUENTLY ASKED QUESTIONS */}
      <section className="px-4 max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <span className="text-xs font-mono font-bold uppercase text-slate-400 tracking-widest">
            Transparency &amp; Legitimacy
          </span>
          <h2 className="text-2xl sm:text-3xl font-black text-white font-mono">
            Frequently Asked Questions
          </h2>
        </div>

        <div className="space-y-3.5 font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2">
            <h4 className="text-sm font-bold text-white">How do the free starter credits work?</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              When you click &ldquo;Get Started&rdquo; and create an account, our Citadel Anti-Harvesting system verifies your connection and automatically grants you 10 free signal credits. Each signal query costs 1 credit. No payment method is needed.
            </p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2">
            <h4 className="text-sm font-bold text-white">How is the VIP 30-day timeframe strictly enforced?</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              To prevent unauthorized accounts from taking VIP slots and to guarantee fairness, VIP status is bound to a verified cryptographic activation code or confirmed crypto transaction. Each VIP period is timestamped in the database for exactly 30 calendar days (720 hours). Once the 30-day window expires, the system automatically revokes VIP access and resets to standard credits to prevent exceeding the allowed timeframe.
            </p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2">
            <h4 className="text-sm font-bold text-white">Which brokers can I use with PulseTrade Pro?</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              PulseTrade Pro is a companion analytics engine. You execute your trades directly on your preferred broker: ExpertOption, Deriv, PocketOption, Quotex, or OlympTrade. Because we do not accept trading deposits, your capital remains 100% under your control at all times.
            </p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2">
            <h4 className="text-sm font-bold text-white">What is the 6-Second Freshness Window?</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              In short-expiry binary options (1–5 minutes), broker algorithms re-anchor prices within seconds of an impulse. If you enter after 6 seconds, the statistical advantage degrades into negative expectation. Our radial timer locks expired signals to protect you from bad fills.
            </p>
          </div>
        </div>
      </section>

      {/* FINAL BOTTOM CTA BANNER */}
      <section className="px-4 max-w-5xl mx-auto">
        <div className="bg-gradient-to-r from-emerald-950/80 via-slate-900 to-teal-950/80 border border-emerald-500/40 rounded-3xl p-8 sm:p-12 text-center space-y-6 shadow-2xl">
          <h2 className="text-2xl sm:text-4xl font-black text-white font-mono tracking-tight">
            Ready to Trade with Institutional Confluence?
          </h2>
          <p className="text-xs sm:text-sm text-slate-300 max-w-xl mx-auto leading-relaxed">
            Create your trader handle now and get 10 free starter credits automatically credited to your session. Zero credit card required.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={onGetStarted}
              className="px-10 py-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base font-mono rounded-2xl transition shadow-xl shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98]"
            >
              Get Started Free &rarr;
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
