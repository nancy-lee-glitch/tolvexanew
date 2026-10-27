import React, { useState } from 'react';

interface WelcomeTutorialProps {
  isOpen: boolean;
  onClose: () => void;
  onExplorePricing?: () => void;
}

interface TutorialStep {
  title: string;
  subtitle: string;
  badge: string;
  icon: string;
  accent: 'emerald' | 'amber' | 'cyan' | 'purple';
  description: string;
  bulletPoints: { title: string; text: string }[];
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: 'Institutional Cockpit Overview',
    subtitle: 'High-Frequency Quantitative Telemetry',
    badge: 'Step 1 of 5 • Architecture',
    icon: '⚡',
    accent: 'emerald',
    description:
      'Welcome to the Tolvexa Citadel Cockpit. Our algorithmic terminal interfaces directly with live market feeds to compute micro-volatility opportunities with sub-25ms execution latency.',
    bulletPoints: [
      {
        title: '6-Second Execution Window',
        text: 'Signals are calculated on precise micro-bursts to capture entry momentum before mean reversion occurs.',
      },
      {
        title: 'Live WebSocket Heartbeat',
        text: 'Real-time price ticks stream continuously across active sessions with zero polling lag.',
      },
      {
        title: 'Active Session Presence',
        text: 'The terminal monitors institutional liquidity and active traders across global desks in real time.',
      },
    ],
  },
  {
    title: 'Selecting Your Asset & Timeframe',
    subtitle: 'Synthetics, Forex, Crypto & Commodities',
    badge: 'Step 2 of 5 • Markets',
    icon: '🎯',
    accent: 'cyan',
    description:
      'Choose from continuous 24/7 Synthetic Indices (Volatility 75, Volatility 100, Crash/Boom) or standard Forex pairs and Crypto assets.',
    bulletPoints: [
      {
        title: 'Synthetic Indices (24/7/365)',
        text: 'Engineered for uninterrupted trading with mathematical constant volatility and no weekend market closures.',
      },
      {
        title: 'Optimal Timeframes',
        text: 'Select between ultra-fast 30s/1m micro-scalps or higher-confidence 5m/15m trend-following momentum.',
      },
      {
        title: 'Multi-Asset Radar',
        text: 'Switch assets anytime with 1 click; the terminal dynamically recalibrates tick velocity and spreads.',
      },
    ],
  },
  {
    title: 'Signals, Confluence & Credit Balance',
    subtitle: 'Transparent Algorithmic Execution',
    badge: 'Step 3 of 5 • Signals & Credits',
    icon: '📊',
    accent: 'emerald',
    description:
      'Every signal computation cross-audits 5 technical indicators before issuance: RSI momentum, dual EMA spreads, tick acceleration, and Bollinger pinch status.',
    bulletPoints: [
      {
        title: 'Standard Accounts (1 Credit / Signal)',
        text: 'New traders start with 10 free starter credits. Each calculated signal consumes 1 credit.',
      },
      {
        title: '85%+ Confluence Threshold',
        text: 'Signals are only generated when multi-indicator confluence exceeds institutional safety criteria.',
      },
      {
        title: 'Outcome Tracking & Recalibration',
        text: 'Log your WIN/LOSS outcomes directly in the terminal to help refine mathematical risk boundaries.',
      },
    ],
  },
  {
    title: 'Safe Radar & Exit Optimization',
    subtitle: 'Protecting Profits with Peak Momentum Windows',
    badge: 'Step 4 of 5 • Risk Shield',
    icon: '🛡️',
    accent: 'amber',
    description:
      'Binary and micro-scalp contracts often fail during the last few seconds due to sharp mean reversion. Safe Radar predicts the exact window when profit momentum peaks.',
    bulletPoints: [
      {
        title: 'Peak Momentum Window',
        text: 'Informs you when contract gains are highest (e.g. 18s–26s into a 60s trade) for early close opportunities.',
      },
      {
        title: 'Reversal Risk Warning',
        text: 'Real-time alert flags when counter-trend micro-ticks begin forming against your directional position.',
      },
      {
        title: 'MT5 Lot & Pip Calculator',
        text: 'Generates strict 2% account equity stop-loss and take-profit targets for MetaTrader 5 contracts.',
      },
    ],
  },
  {
    title: 'VIP 30-Day Pass & Instant Crypto Activation',
    subtitle: 'Unlimited Institutional Access',
    badge: 'Step 5 of 5 • VIP Status',
    icon: '👑',
    accent: 'amber',
    description:
      'Unlock the full power of the terminal with a strict 30-Day VIP Pass. VIP members enjoy 0 credit deduction, unlimited signals, and automated blockchain verification.',
    bulletPoints: [
      {
        title: 'Zero Credit Deductions',
        text: 'Generate unlimited signals 24 hours a day without running out of credits.',
      },
      {
        title: 'Full Safe Radar Screener Unlocked',
        text: 'Scan the entire multi-asset market simultaneously to find the safest trade setup in seconds.',
      },
      {
        title: 'Instant Automated Verification',
        text: 'Pay via NOWPayments crypto or enter a one-time VIP activation voucher code to unlock VIP instantly.',
      },
    ],
  },
];

export function WelcomeTutorial({ isOpen, onClose, onExplorePricing }: WelcomeTutorialProps) {
  const [currentStep, setCurrentStep] = useState(0);

  if (!isOpen) return null;

  const step = TUTORIAL_STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === TUTORIAL_STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      onClose();
    } else {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (!isFirst) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-7 shadow-2xl space-y-6 font-mono text-slate-100 overflow-hidden">
        {/* Decorative Ambient Glow */}
        <div className="absolute -top-24 -right-24 w-60 h-60 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-60 h-60 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Top Header Bar */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-950 border border-slate-700 flex items-center justify-center text-xl shadow-inner">
              {step.icon}
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold block">
                {step.badge}
              </span>
              <h3 className="text-base sm:text-lg font-black text-white tracking-tight">
                {step.title}
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-xl hover:bg-slate-800 transition"
            title="Skip Walkthrough"
          >
            ✕
          </button>
        </div>

        {/* Step Content */}
        <div className="space-y-4">
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-4 space-y-2">
            <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
              <span>●</span>
              <span>{step.subtitle}</span>
            </span>
            <p className="text-xs text-slate-300 leading-relaxed font-sans">
              {step.description}
            </p>
          </div>

          {/* Key Bullet Highlights */}
          <div className="space-y-2.5">
            {step.bulletPoints.map((bp, i) => (
              <div
                key={i}
                className="bg-slate-950/40 border border-slate-800/60 rounded-xl p-3 flex items-start gap-3 text-xs"
              >
                <div className="w-5 h-5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center text-[10px] font-black shrink-0 mt-0.5">
                  ✓
                </div>
                <div className="space-y-0.5">
                  <div className="font-bold text-white text-[11px]">{bp.title}</div>
                  <div className="text-[11px] text-slate-400 font-sans leading-relaxed">{bp.text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Step Progress Dots */}
        <div className="flex items-center justify-center gap-1.5 pt-1">
          {TUTORIAL_STEPS.map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setCurrentStep(idx)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                idx === currentStep
                  ? 'w-7 bg-emerald-400 shadow-sm shadow-emerald-500/40'
                  : 'w-2 bg-slate-800 hover:bg-slate-700'
              }`}
              title={`Jump to Step ${idx + 1}`}
            />
          ))}
        </div>

        {/* Bottom Actions Bar */}
        <div className="flex items-center justify-between border-t border-slate-800 pt-4 gap-2">
          <div className="flex items-center gap-2">
            {!isFirst ? (
              <button
                type="button"
                onClick={handleBack}
                className="py-2 px-3.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-1"
              >
                <span>←</span>
                <span>Back</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="py-2 px-3 text-slate-500 hover:text-slate-300 text-xs transition font-mono"
              >
                Skip Tutorial
              </button>
            )}

            {isLast && onExplorePricing && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onExplorePricing();
                }}
                className="hidden sm:inline-flex py-2 px-3 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-xl text-xs font-bold transition"
              >
                ★ View VIP Passes
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleNext}
            className="py-2.5 px-6 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-xs uppercase rounded-xl transition shadow-lg shadow-emerald-500/20 flex items-center gap-2"
          >
            <span>{isLast ? 'Got it! Launch Cockpit' : 'Next Step'}</span>
            <span>{isLast ? '🚀' : '→'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
