import React, { useState, useEffect, useCallback, useRef } from 'react';

export interface TourStep {
  targetKey: string;
  fallbackSelectors?: string[];
  title: string;
  description: string;
  tip?: string;
  badge: string;
  shape: 'box' | 'pill' | 'circle';
  preferredPosition?: 'top' | 'bottom' | 'left' | 'right';
  requiresCockpit?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  {
    targetKey: 'asset-selector',
    fallbackSelectors: ['#asset-selector-tabs', '[data-tour="asset-selector"]'],
    title: '1. Select Your Trading Market',
    description:
      'Choose your instrument from 24/7 Synthetic Volatility Indices (Vol 75, Vol 100), major Forex currency pairs (EUR/USD, GBP/USD), and Crypto assets with constant liquidity.',
    tip: 'Deriv Synthetics trade continuously 365 days a year without weekend closures or bank holidays.',
    badge: 'Step 1 of 9 • Markets',
    shape: 'box',
    preferredPosition: 'bottom',
    requiresCockpit: true,
  },
  {
    targetKey: 'live-ticker',
    fallbackSelectors: ['[data-tour="live-ticker"]'],
    title: '2. Real-Time Tick Stream & Velocity',
    description:
      'Sub-25ms WebSocket price telemetry direct from the institutional interbank feed. Displays live bid/ask quotes, pip spread, micro-price velocity, and momentum bursts.',
    tip: 'Rapid tick acceleration gives you early confirmation of impending volatility expansions.',
    badge: 'Step 2 of 9 • Telemetry',
    shape: 'box',
    preferredPosition: 'bottom',
    requiresCockpit: true,
  },
  {
    targetKey: 'mode-switcher',
    fallbackSelectors: ['[data-tour="mode-switcher"]', '#mode-toggle-quick'],
    title: '3. Dual Quantitative Analysis Modes',
    description:
      'Select your execution profile: Quick Expiry (calibrated for 30s to 15m binary CALL/PUT contracts) or MT5 Style (institutional BUY/SELL setups with structural Stop Loss & TP1/TP2 targets).',
    tip: 'Quick mode uses an agile soft gate for binary speed; MT5 mode enforces strict institutional invalidation levels.',
    badge: 'Step 3 of 9 • Dual Engines',
    shape: 'box',
    preferredPosition: 'bottom',
    requiresCockpit: true,
  },
  {
    targetKey: 'timeframe-selector',
    fallbackSelectors: ['[data-tour="timeframe-selector"]', '#timeframe-grid'],
    title: '4. Select Operational Horizon',
    description:
      'Choose your analysis horizon from 30 seconds up to 15 minutes (or higher in MT5). The engine dynamically adjusts indicator smoothing, sampling rates, and noise filters to match.',
    tip: 'For ExpertOption and Deriv, 30s and 1m horizons evaluate sub-minute micro-structure momentum.',
    badge: 'Step 4 of 9 • Horizons',
    shape: 'box',
    preferredPosition: 'bottom',
    requiresCockpit: true,
  },
  {
    targetKey: 'confluence-gate',
    fallbackSelectors: ['[data-tour="confluence-gate"]', '#signal-display-container'],
    title: '5. Institutional Confluence Gate',
    description:
      'Before recommending any trade, the confirmation gate tests 5 factors: Microstructure (HH/HL vs LH/LL), Fast/Slow EMA alignment, RSI momentum, and Volume Profile (POC). If the market is choppy, it outputs WAIT to protect your balance.',
    tip: 'Preserving capital during chop is the hallmark of professional quants. Tolvexa never forces trades in uncertainty.',
    badge: 'Step 5 of 9 • Risk Gate',
    shape: 'box',
    preferredPosition: 'top',
    requiresCockpit: true,
  },
  {
    targetKey: 'generate-signal',
    fallbackSelectors: ['[data-tour="generate-signal"]', '#btn-analyse-trigger'],
    title: '6. Algorithmic Signal Execution',
    description:
      'Tap here to initiate real-time mathematical computation. Confirmed signals feature a strict 6-second radial freshness window for zero slippage. If conditions are unconfirmed, it displays WAIT—and WAIT signals NEVER consume credits!',
    tip: 'Execute your trade on your broker within the 6-second window for peak mathematical expectancy.',
    badge: 'Step 6 of 9 • Execution',
    shape: 'pill',
    preferredPosition: 'top',
    requiresCockpit: true,
  },
  {
    targetKey: 'risk-advisor',
    fallbackSelectors: ['[data-tour="risk-advisor"]', '#capital-balance-input'],
    title: '7. Safe Close & Capital Preservation',
    description:
      'Tracks in-flight trades and alerts you to lock in profit before mean-reversion spikes occur. Includes an automatic 2% capital risk calculator to protect your balance against over-leveraging.',
    tip: 'Never risk more than 2% of your equity on any single binary contract.',
    badge: 'Step 7 of 9 • Capital Guard',
    shape: 'box',
    preferredPosition: 'top',
    requiresCockpit: true,
  },
  {
    targetKey: 'radar-control',
    fallbackSelectors: ['[data-tour="radar-control"]', '#vip-radar-screener-btn'],
    title: '8. VIP Multi-Asset Safe Screener',
    description:
      'Continuous 24/7 multi-asset screener monitoring synthetics, forex, and crypto simultaneously. Automatically rates market safety so you immediately identify the highest-probability trends.',
    tip: 'Tap the Radar button on desktop or mobile bottom navigation to scan the whole market in one glance.',
    badge: 'Step 8 of 9 • Radar Screener',
    shape: 'pill',
    preferredPosition: 'bottom',
    requiresCockpit: false,
  },
  {
    targetKey: 'credits-control',
    fallbackSelectors: ['[data-tour="credits-control"]', '[data-tour="credits-badge"]'],
    title: '9. Starter Credits & 30-Day VIP Pass',
    description:
      'Every new account receives 10 free starter credits. Actionable setups consume 1 credit (WAIT states are always free!). Upgrade to the 30-Day VIP Pass for unlimited calculations, zero deductions, and full institutional depth.',
    tip: 'Instant automated crypto checkout via NOWPayments with automatic blockchain activation.',
    badge: 'Step 9 of 9 • Terminal Access',
    shape: 'pill',
    preferredPosition: 'bottom',
    requiresCockpit: false,
  },
];

interface GuidedTourCoachMarkProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToPricing?: () => void;
  currentPage?: string;
  onSetPage?: (page: string) => void;
  onOpenRadar?: () => void;
}

export function GuidedTourCoachMark({
  isOpen,
  onClose,
  onNavigateToPricing,
  currentPage,
  onSetPage,
  onOpenRadar,
}: GuidedTourCoachMarkProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [targetFound, setTargetFound] = useState<boolean>(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const step = TOUR_STEPS[currentStepIndex];

  // Auto-navigate to cockpit if this step requires cockpit elements
  useEffect(() => {
    if (!isOpen || !step) return;

    if (step.requiresCockpit && currentPage !== 'cockpit' && onSetPage) {
      onSetPage('cockpit');
    }
  }, [isOpen, step, currentPage, onSetPage]);

  // Find target element with fallback selectors
  const findTargetElement = useCallback((): HTMLElement | null => {
    if (!step) return null;

    // 1. Direct data-tour selector
    let el = document.querySelector(`[data-tour="${step.targetKey}"]`) as HTMLElement | null;
    if (el) return el;

    // 2. Fallback selectors
    if (step.fallbackSelectors) {
      for (const sel of step.fallbackSelectors) {
        el = document.querySelector(sel) as HTMLElement | null;
        if (el) return el;
      }
    }

    return null;
  }, [step]);

  // Update target bounding box
  const updateTargetRect = useCallback(() => {
    if (!isOpen || !step) return;

    const el = findTargetElement();
    if (el) {
      const rect = el.getBoundingClientRect();
      setTargetRect(rect);
      setTargetFound(true);

      // Smoothly scroll target element into viewport if outside visible bounds
      const inView =
        rect.top >= 80 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) - 80 &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth);

      if (!inView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    } else {
      setTargetRect(null);
      setTargetFound(false);
    }
  }, [isOpen, step, findTargetElement]);

  // Robust polling/retry when transitioning between steps
  useEffect(() => {
    if (!isOpen) return;

    updateTargetRect();

    // Re-check after 150ms and 350ms to allow smooth scroll and layout reflow
    const t1 = setTimeout(updateTargetRect, 150);
    const t2 = setTimeout(updateTargetRect, 350);

    const handleScrollOrResize = () => {
      updateTargetRect();
    };

    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [isOpen, currentStepIndex, updateTargetRect]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleBack();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleComplete();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentStepIndex]);

  if (!isOpen || !step) return null;

  const handleNext = () => {
    if (currentStepIndex < TOUR_STEPS.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleComplete = () => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('pulsetrade_tour_completed', 'true');
      } catch {}
    }
    onClose();
  };

  // Compute tooltip coordinates safely
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const padding = step.shape === 'pill' ? 8 : 10;

  let tooltipStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 99999,
  };

  if (targetRect) {
    const spaceBelow = window.innerHeight - targetRect.bottom;
    const spaceAbove = targetRect.top;

    if (isMobile) {
      // Mobile positioning: avoid covering the highlighted box
      if (spaceBelow >= 260) {
        tooltipStyle = {
          ...tooltipStyle,
          top: Math.min(window.innerHeight - 250, targetRect.bottom + 14),
          left: 12,
          right: 12,
        };
      } else if (spaceAbove >= 260) {
        tooltipStyle = {
          ...tooltipStyle,
          bottom: Math.min(window.innerHeight - 60, window.innerHeight - targetRect.top + 14),
          left: 12,
          right: 12,
        };
      } else {
        // Fallback docked at bottom with safe area
        tooltipStyle = {
          ...tooltipStyle,
          bottom: 16,
          left: 12,
          right: 12,
        };
      }
    } else {
      // Desktop positioning
      const preferred = step.preferredPosition || 'bottom';
      const cardWidth = 380;
      const centeredLeft = Math.max(16, Math.min(window.innerWidth - cardWidth - 16, targetRect.left + (targetRect.width / 2) - (cardWidth / 2)));

      if (preferred === 'top' && spaceAbove > 230) {
        tooltipStyle = {
          ...tooltipStyle,
          bottom: window.innerHeight - targetRect.top + 16,
          left: centeredLeft,
          width: `${cardWidth}px`,
        };
      } else if (spaceBelow > 230) {
        tooltipStyle = {
          ...tooltipStyle,
          top: targetRect.bottom + 16,
          left: centeredLeft,
          width: `${cardWidth}px`,
        };
      } else if (spaceAbove > 230) {
        tooltipStyle = {
          ...tooltipStyle,
          bottom: window.innerHeight - targetRect.top + 16,
          left: centeredLeft,
          width: `${cardWidth}px`,
        };
      } else {
        // Side alignment
        tooltipStyle = {
          ...tooltipStyle,
          top: Math.max(16, targetRect.top),
          left: Math.max(16, Math.min(window.innerWidth - cardWidth - 16, targetRect.right + 16)),
          width: `${cardWidth}px`,
        };
      }
    }
  } else {
    // Center modal if target is temporarily resolving
    tooltipStyle = {
      ...tooltipStyle,
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: isMobile ? 'calc(100% - 32px)' : '420px',
    };
  }

  const isPillOrCircle = step.shape === 'pill' || step.shape === 'circle';

  return (
    <div className="fixed inset-0 z-[99990] select-none pointer-events-none">
      {/* 1. Darkened SVG Backdrop with Spotlight Cut-Out */}
      <svg
        className="fixed inset-0 w-full h-full pointer-events-none transition-all duration-300"
        style={{ zIndex: 99991 }}
      >
        <defs>
          <mask id="tour-spotlight-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {targetRect && (
              <rect
                x={targetRect.left - padding}
                y={targetRect.top - padding}
                width={targetRect.width + padding * 2}
                height={targetRect.height + padding * 2}
                rx={isPillOrCircle ? Math.min(targetRect.height, 36) : 18}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(2, 6, 23, 0.82)"
          mask="url(#tour-spotlight-mask)"
        />
      </svg>

      {/* 2. GLOWING NEON BOX OR CIRCLE (EXPLICIT USER REQUIREMENT: CIRCLE OR BOX WHAT YOU ARE EXPLAINING) */}
      {targetRect && (
        <div
          className={`fixed pointer-events-none transition-all duration-300 ${
            isPillOrCircle ? 'rounded-full' : 'rounded-2xl'
          } border-2 border-emerald-400`}
          style={{
            zIndex: 99995,
            top: targetRect.top - padding,
            left: targetRect.left - padding,
            width: targetRect.width + padding * 2,
            height: targetRect.height + padding * 2,
            boxShadow:
              '0 0 0 3px rgba(16, 185, 129, 0.35), 0 0 35px rgba(52, 211, 153, 0.55), inset 0 0 16px rgba(52, 211, 153, 0.15)',
          }}
        >
          {/* Glowing Animated Reticle Corners for Futuristic Trading Terminal Feel */}
          {!isPillOrCircle && (
            <>
              {/* Top-Left Corner Reticle */}
              <span className="absolute -top-1 -left-1 w-3 h-3 border-t-2 border-l-2 border-emerald-300" />
              {/* Top-Right Corner Reticle */}
              <span className="absolute -top-1 -right-1 w-3 h-3 border-t-2 border-r-2 border-emerald-300" />
              {/* Bottom-Left Corner Reticle */}
              <span className="absolute -bottom-1 -left-1 w-3 h-3 border-b-2 border-l-2 border-emerald-300" />
              {/* Bottom-Right Corner Reticle */}
              <span className="absolute -bottom-1 -right-1 w-3 h-3 border-b-2 border-r-2 border-emerald-300" />
            </>
          )}

          {/* Floating '✦ EXPLAINING NOW' Badge directly attached to the box border */}
          <div className="absolute -top-3.5 left-3 sm:left-4 bg-emerald-500 text-slate-950 px-2 py-0.5 rounded-full text-[9px] font-mono font-black tracking-wider uppercase shadow-md shadow-emerald-500/40 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-ping" />
            <span>EXPLAINING NOW</span>
          </div>

          {/* Pulsing beacon radar dot */}
          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-400 rounded-full animate-ping opacity-75" />
          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-400 rounded-full shadow-lg" />
        </div>
      )}

      {/* 3. INTERACTIVE TOUR EXPLANATION CARD */}
      <div
        style={tooltipStyle}
        className="pointer-events-auto bg-slate-900/98 backdrop-blur-2xl border-2 border-emerald-500/60 rounded-3xl p-4 sm:p-5 shadow-2xl shadow-slate-950/95 text-white font-sans animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Step Badge & Skip Action */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5 mb-2.5">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-mono font-black text-emerald-400 uppercase tracking-wider">
              {step.badge}
            </span>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            className="text-[11px] font-mono text-slate-400 hover:text-white transition px-2 py-1 rounded-lg hover:bg-slate-800 active:scale-95 cursor-pointer"
            title="Exit Tour"
          >
            Skip Tour ✕
          </button>
        </div>

        {/* Step Title & Detailed Explanation */}
        <div className="space-y-1.5 mb-3">
          <h3 className="text-sm sm:text-base font-black text-white font-mono tracking-tight flex items-center gap-2">
            <span>{step.title}</span>
          </h3>
          <p className="text-xs sm:text-[13px] text-slate-200 leading-relaxed font-sans">
            {step.description}
          </p>
        </div>

        {/* Pro Tip / Practical Strategy Callout */}
        {step.tip && (
          <div className="bg-slate-950/90 border border-emerald-500/30 rounded-2xl p-2.5 mb-3.5 text-[11px] font-mono text-slate-300 flex items-start gap-2 shadow-inner">
            <span className="text-amber-400 text-xs shrink-0">💡</span>
            <span className="leading-snug">
              <strong className="text-amber-300 font-bold">Pro Tip:</strong> {step.tip}
            </span>
          </div>
        )}

        {/* Navigation Controls, Step Dots & Actions */}
        <div className="flex flex-col gap-2 pt-1 border-t border-slate-800/60">
          {/* Progress Dots */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {TOUR_STEPS.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCurrentStepIndex(idx)}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    idx === currentStepIndex
                      ? 'w-6 bg-emerald-400 shadow-sm shadow-emerald-400/50'
                      : idx < currentStepIndex
                      ? 'w-2 bg-emerald-600'
                      : 'w-2 bg-slate-800 hover:bg-slate-700'
                  }`}
                  title={`Jump to Step ${idx + 1}`}
                />
              ))}
            </div>
            <span className="text-[10px] font-mono text-slate-400">
              {currentStepIndex + 1} of {TOUR_STEPS.length}
            </span>
          </div>

          {/* Action Buttons Row */}
          <div className="flex items-center justify-between gap-2 mt-1">
            {currentStepIndex > 0 ? (
              <button
                type="button"
                onClick={handleBack}
                className="py-2 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 transition font-mono text-xs font-bold active:scale-95 cursor-pointer"
              >
                ← Back
              </button>
            ) : (
              <span className="text-[10px] font-mono text-slate-500">
                Use ← / → keys
              </span>
            )}

            <div className="flex items-center gap-2">
              {/* Optional Quick Link on Radar Step */}
              {step.targetKey === 'radar-control' && onOpenRadar && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenRadar();
                  }}
                  className="py-2 px-3 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 transition font-mono text-xs font-bold active:scale-95 cursor-pointer"
                >
                  Open Radar
                </button>
              )}

              {/* Optional Quick Link on Pricing Step */}
              {step.targetKey === 'credits-control' && onNavigateToPricing && (
                <button
                  type="button"
                  onClick={() => {
                    onNavigateToPricing();
                  }}
                  className="py-2 px-3 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition font-mono text-xs font-bold active:scale-95 cursor-pointer"
                >
                  View VIP Plans
                </button>
              )}

              <button
                type="button"
                onClick={handleNext}
                className="py-2 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black font-mono text-xs transition shadow-lg shadow-emerald-500/25 active:scale-95 cursor-pointer flex items-center gap-1"
              >
                <span>{currentStepIndex === TOUR_STEPS.length - 1 ? 'Start Trading Cockpit ✓' : 'Next Step →'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
