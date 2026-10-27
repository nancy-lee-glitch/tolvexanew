import React, { useState, useEffect, useRef, useMemo } from 'react';
import type {
  AssetConfig,
  SignalData,
  SessionStats,
  TechnicalAudit,
  SignalHistoryItem,
  UserProfile,
  AnalysisMode,
  AnalysisProfile,
  BrokerPlatformItem,
  ConfluenceFactorItem,
  MultiWindowConfirmation,
  HistoryLearningContext,
} from '../types.ts';
import { playCallAudioChime, playPutAudioChime } from '../utils/audio.ts';
import {
  analyzeMarketConfluence,
  calculateSafeCloseAnalysis,
  generateDualModeSignal,
  evaluateMultiWindowLiveConfirmation,
  computeSignalHistoryLearning,
} from '../utils/quantEngine.ts';
import { logSignalToSupabase, logOutcomeToSupabase } from '../utils/supabaseClient.ts';
import { getBrokerPlatforms, getBrokersSettings } from '../utils/siteConfigManager.ts';
import { SignalHistory } from './SignalHistory.tsx';

interface SignalEngineProps {
  activeAsset: AssetConfig;
  currentPrice: number;
  credits: number;
  isVIP: boolean;
  onDeductCredit: () => Promise<boolean>;
  onLogOutcome: (outcome: 'WIN' | 'LOSS', signal: SignalData) => void;
  stats: SessionStats;
  ticks?: number[];
  user?: UserProfile | null;
  onOpenAuth?: (mode: 'login' | 'register') => void;
  onOpenVipRadar?: () => void;
}

export const TIMEFRAMES = [
  { id: '30s', label: '30 SEC', seconds: 30, desc: 'Micro-Scalp & Tick Flow' },
  { id: '1m', label: '1 MIN', seconds: 60, desc: 'EMA 9/21 Confluence & Momentum' },
  { id: '2m', label: '2 MIN', seconds: 120, desc: 'Dual-Candle Continuation' },
  { id: '3m', label: '3 MIN', seconds: 180, desc: 'Structure Breakout' },
  { id: '5m', label: '5 MIN', seconds: 300, desc: 'Macro Trend Momentum' },
  { id: '15m', label: '15 MIN', seconds: 900, desc: 'Key Level Reversal' },
];

export function SignalEngine({
  activeAsset,
  currentPrice,
  credits,
  isVIP,
  onDeductCredit,
  onLogOutcome,
  stats,
  ticks = [],
  user,
  onOpenAuth,
  onOpenVipRadar,
}: SignalEngineProps) {
  // 1. Unified Broker Platform Selector State (Replaces Quick/MT5 dual buttons)
  const [platforms] = useState<BrokerPlatformItem[]>(() => getBrokerPlatforms());
  const [selectedPlatformId, setSelectedPlatformId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('pulsetrade_selected_platform');
      if (saved) return saved;
    } catch {}
    return 'expert_option';
  });

  const currentPlatform = useMemo(() => {
    return platforms.find((p) => p.id === selectedPlatformId) || platforms[0] || {
      id: 'expert_option',
      name: 'ExpertOption',
      profile: 'BINARY_QUICK' as const,
      enabled: true,
    };
  }, [platforms, selectedPlatformId]);

  // Derived Profile & quantEngine mode
  const analysisProfile: AnalysisProfile = currentPlatform.profile;
  const analysisMode: AnalysisMode = analysisProfile === 'MT5' ? 'mt5' : 'quick';

  const handlePlatformChange = (id: string) => {
    setSelectedPlatformId(id);
    try {
      localStorage.setItem('pulsetrade_selected_platform', id);
    } catch {}
    if (signal) setSignal(null);
  };

  // Timeframe
  const [selectedTf, setSelectedTf] = useState<string>('1m');

  // Auto-Scan Switch State (Cockpit only: auto re-scan after WAIT)
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pulsetrade_auto_scan') === 'true';
    } catch {
      return false;
    }
  });
  const [autoScanSecondsRemaining, setAutoScanSecondsRemaining] = useState<number>(0);
  const [autoScanAttempt, setAutoScanAttempt] = useState<number>(0);
  const autoScanCountdownRef = useRef<NodeJS.Timeout | null>(null);
  const triggerAnalysisRef = useRef<() => void>(() => {});
  const MAX_AUTO_SCAN_ATTEMPTS = 10;

  // Unmount cleanup to prevent stuck timers when leaving Cockpit
  useEffect(() => {
    return () => {
      if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
    };
  }, []);
  
  // Signal State
  const [signal, setSignal] = useState<SignalData | null>(null);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [freshnessSec, setFreshnessSec] = useState<number>(6.0);
  const [isExpired, setIsExpired] = useState<boolean>(false);
  const [creditNotice, setCreditNotice] = useState<string | null>(null);

  // MT5 Risk & Lot size adjustments (includes $10 for small account testing)
  const [mt5Balance, setMt5Balance] = useState<number>(10000);
  const [mt5RiskPct, setMt5RiskPct] = useState<number>(1.0);
  const [copiedMt5Text, setCopiedMt5Text] = useState<boolean>(false);
  const [copiedMt5Json, setCopiedMt5Json] = useState<boolean>(false);

  // Re-check animation state
  const [isRechecking, setIsRechecking] = useState<boolean>(false);
  const [recheckStage, setRecheckStage] = useState<number>(0);
  const [recheckNote, setRecheckNote] = useState<string>('');

  // Active in-trade tracking
  const [activeTrade, setActiveTrade] = useState<{
    entryPrice: number;
    direction: 'CALL' | 'PUT';
    timeframeSeconds: number;
    startedAt: number;
    secondsRemaining: number;
    status: 'IN_THE_MONEY' | 'OUT_OF_THE_MONEY' | 'AT_THE_MONEY';
    pipDiff: number;
    completed: boolean;
  } | null>(null);

  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const tradeTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Signal History tracking
  const [signalHistory, setSignalHistory] = useState<SignalHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('pulsetrade_signal_history');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [
      {
        id: 'sig_init_1',
        asset: activeAsset?.name || 'EUR/USD',
        timeframe: '1m',
        direction: 'CALL',
        entryPrice: currentPrice || 1.0852,
        targetPrice: (currentPrice || 1.0852) + (activeAsset?.pipSize || 0.0001) * 4,
        confidence: 91.4,
        generatedAt: Date.now() - 180000,
        outcome: 'WIN',
        pipDiff: 3.2,
        sparkline: [1.0848, 1.0849, 1.0850, 1.0851, 1.08515, 1.0852, 1.08535, 1.0854, 1.08548, 1.08552],
      },
    ];
  });

  useEffect(() => {
    try {
      localStorage.setItem('pulsetrade_signal_history', JSON.stringify(signalHistory));
    } catch {}
  }, [signalHistory]);

  const handleUpdateHistoryOutcome = (id: string, outcome: 'WIN' | 'LOSS') => {
    setSignalHistory((prev) =>
      prev.map((item) => (item.id === id ? { ...item, outcome } : item))
    );
  };

  // Safe live ticks buffer — strictly use verified real ticks from live stream
  const safeTicks = useMemo(() => {
    return ticks && Array.isArray(ticks) ? ticks : [];
  }, [ticks]);

  // Live telemetry audit
  const liveAudit: TechnicalAudit = useMemo(() => {
    return analyzeMarketConfluence(safeTicks, selectedTf, activeAsset?.pipSize || 0.0001, isVIP, analysisMode);
  }, [safeTicks, selectedTf, activeAsset?.pipSize, isVIP, analysisMode]);

  // Safe close analysis
  const safeCloseAnalysis = useMemo(() => {
    return calculateSafeCloseAnalysis(safeTicks, selectedTf, activeAsset?.pipSize || 0.0001);
  }, [safeTicks, selectedTf, activeAsset?.pipSize]);

  const tfConfig = TIMEFRAMES.find((t) => t.id === selectedTf) || TIMEFRAMES[0];

  // PRIMARY CONFIRMATION ENGINE TRIGGER
  const handleTriggerAnalysis = async () => {
    // 1) Security check: Login required to trade
    if (!user) {
      onOpenAuth?.('login');
      return;
    }

    if (isLocked || isRechecking || activeTrade) return;

    // 2) Instrument & Timeframe check
    if (!activeAsset || !activeAsset.symbol) {
      const blockedSignal: SignalData = {
        asset: 'UNKNOWN',
        timeframe: selectedTf,
        direction: 'WAIT',
        confidence: 0,
        trend: 'Neutral',
        velocity: 'Blocked',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: 'Instrument not identified. Please select an asset from the market ticker.',
        plainLanguageReason: 'Analysis blocked: Instrument must come from reliable app state. Never guess instrument from price alone.',
        riskNote: 'Trading involves risk. Algorithmic telemetry is not financial advice.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      return;
    }

    if (!selectedTf) {
      const blockedSignal: SignalData = {
        asset: activeAsset.name,
        timeframe: 'MISSING',
        direction: 'WAIT',
        confidence: 0,
        trend: 'Neutral',
        velocity: 'Blocked',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: 'Timeframe not identified. Please select an expiration timeframe.',
        plainLanguageReason: 'Analysis blocked: Timeframe required for multi-factor confluence model.',
        riskNote: 'Trading involves risk. Algorithmic telemetry is not financial advice.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      return;
    }

    // 3) Live Stream Buffer Check (MANDATORY — NEVER GUESS FROM MOCK/FILL PADDING)
    if (safeTicks.length < 8) {
      const blockedSignal: SignalData = {
        asset: activeAsset.name,
        timeframe: selectedTf,
        direction: 'WAIT',
        confidence: 0,
        trend: 'Neutral',
        velocity: 'Stream Loading',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: `Live market data insufficient (${safeTicks.length}/8 ticks captured for ${activeAsset.name}). Please wait 3-5 seconds and try again.`,
        plainLanguageReason: 'Live tick buffer insufficient to compute micro momentum safely. PulseTrade strictly requires verified live WebSocket ticks before evaluating setups. No credits deducted.',
        riskNote: 'Trading involves risk. Always wait for confirmed live market velocity.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      setCreditNotice('No credits deducted for unconfirmed live market data.');
      return;
    }

    // 4) Pre-check Credit Availability for non-VIP
    if (!isVIP && credits <= 0) {
      await onDeductCredit(); // redirects to pricing
      return;
    }

    setCreditNotice(null);
    setIsRechecking(true);
    setRecheckStage(1);
    setRecheckNote(`[1/4] Ingesting reliable tick buffer for ${activeAsset.name} (${safeTicks.length} ticks)...`);

    setTimeout(() => {
      setRecheckStage(2);
      setRecheckNote(`[2/4] Auditing market structure (HH/HL vs LH/LL vs Compression)...`);
    }, 250);

    setTimeout(() => {
      setRecheckStage(3);
      setRecheckNote(
        analysisMode === 'quick'
          ? `[3/4] Evaluating Quick Soft Gate (EMA Core + RSI/Vol Filters)...`
          : `[3/4] Evaluating MT5 Strict Gate (EMA + RSI + FRVP POC + Sweep + FVG)...`
      );
    }, 500);

    setTimeout(async () => {
      setRecheckStage(4);
      setRecheckNote(`[4/4] Synthesizing ${currentPlatform.name} (${analysisProfile}) live output profile...`);

      // 1) Evaluate Multi-Window Live Confirmation from active asset live ticks
      const tfMinutes = selectedTf.endsWith('s') ? 0.5 : parseInt(selectedTf) || 1;
      const multiWindow = evaluateMultiWindowLiveConfirmation(safeTicks, activeAsset.pipSize || 0.0001, tfMinutes, activeAsset.symbol);

      // 2) Compute Signal History Learning for this asset + profile + tf
      const historyLearning = computeSignalHistoryLearning(
        activeAsset.symbol || activeAsset.name,
        analysisProfile,
        selectedTf
      );

      // Run real quant engine confirmation gate with dedicated mode policy
      const generatedSignal = generateDualModeSignal({
        symbol: activeAsset.name,
        timeframe: selectedTf,
        prices: safeTicks,
        currentPrice: currentPrice || 1.08500,
        pipSize: activeAsset.pipSize || 0.0001,
        decimals: activeAsset.decimals || 5,
        mode: analysisMode,
        isVIP,
        accountBalance: mt5Balance,
        riskPercent: mt5RiskPct,
      });

      // Enrich signal with broker platform, multi-window confirmation, and learning memory
      generatedSignal.platform = currentPlatform.name;
      generatedSignal.analysisProfile = analysisProfile;
      generatedSignal.multiWindow = multiWindow;
      generatedSignal.historyLearning = historyLearning;
      generatedSignal.suggestedExpiryMinutes = multiWindow.suggestedExpiryMinutes;
      generatedSignal.suggestedExpiryReason = multiWindow.suggestedExpiryReason;

      // RULE 6: If multi-window checks disagree, strictly force WAIT
      if (!multiWindow.allAgreed && (generatedSignal.direction === 'CALL' || generatedSignal.direction === 'PUT' || (generatedSignal.direction as string) === 'BUY' || (generatedSignal.direction as string) === 'SELL')) {
        generatedSignal.direction = 'WAIT';
        generatedSignal.gatePassed = false;
        generatedSignal.confidence = Math.min(generatedSignal.confidence, 48);
        generatedSignal.plainLanguageReason = multiWindow.conflictSummary || 'Multi-window momentum disagreement detected across long, mid, and short lookbacks. Trade aborted to protect capital.';
      }

      // RULE 7: Signal History Learning threshold enforcement
      if (historyLearning.status === 'CAUTION_RAISED_THRESHOLD' && generatedSignal.confidence < 75) {
        generatedSignal.direction = 'WAIT';
        generatedSignal.gatePassed = false;
        generatedSignal.plainLanguageReason = `${historyLearning.note} Market regime currently hostile; WAIT enforced until confluence exceeds 75%.`;
      }

      setSignal(generatedSignal);
      setIsRechecking(false);

      const isActionable = generatedSignal.direction === 'CALL' || generatedSignal.direction === 'PUT' || (analysisProfile === 'MT5' && ((generatedSignal.direction as string) === 'BUY' || (generatedSignal.direction as string) === 'SELL'));

      // FIX 2A: Record to history ONLY if signal is actionable (WIN/LOSS/PENDING). Never save WAIT into trade history!
      if (isActionable) {
        const historyItem: SignalHistoryItem = {
          id: 'sig_' + Date.now(),
          asset: activeAsset.name,
          platform: currentPlatform.name,
          platformProfile: analysisProfile,
          timeframe: selectedTf,
          direction: generatedSignal.direction,
          entryPrice: currentPrice,
          targetPrice: generatedSignal.targetPrice,
          confidence: generatedSignal.confidence,
          generatedAt: Date.now(),
          outcome: 'PENDING',
          sparkline: safeTicks.slice(-10),
        };
        setSignalHistory((prev) => [historyItem, ...prev]);
      }

      // CREDIT CHARGING RULE:
      // Only charge credit if signal is actionable! Do not charge for WAIT or BLOCKED.
      if (isActionable) {
        // Clear any auto-scan since actionable signal was found!
        if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
        setAutoScanSecondsRemaining(0);
        setAutoScanAttempt(0);

        if (!isVIP) {
          await onDeductCredit();
        }
        setCreditNotice(null);
        logSignalToSupabase(generatedSignal);
        setIsLocked(true);
        setIsExpired(false);
        setFreshnessSec(6.0);

        if (generatedSignal.direction === 'CALL' || (generatedSignal.direction as string) === 'BUY') {
          playCallAudioChime();
        } else {
          playPutAudioChime();
        }

        // 6-Second Freshness Window
        if (countdownRef.current) clearInterval(countdownRef.current);
        const start = Date.now();
        countdownRef.current = setInterval(() => {
          const elapsed = (Date.now() - start) / 1000;
          const remaining = Math.max(0, 6.0 - elapsed);
          setFreshnessSec(remaining);
          if (remaining <= 0) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            setIsExpired(true);
          }
        }, 100);
      } else {
        // Honest WAIT / NO TRADE state — NO CREDIT CHARGED
        setIsLocked(false);
        setIsExpired(false);
        setFreshnessSec(0);
        if (countdownRef.current) clearInterval(countdownRef.current);
        if (!isVIP) {
          setCreditNotice('No credit charged for WAIT state — only actionable setups consume credits.');
        }

        // AUTO-SCAN RULE: If autoScanEnabled and attempt < MAX_AUTO_SCAN_ATTEMPTS, schedule 8s countdown
        if (autoScanEnabled && autoScanAttempt < MAX_AUTO_SCAN_ATTEMPTS) {
          if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
          let remaining = 8;
          setAutoScanSecondsRemaining(remaining);
          autoScanCountdownRef.current = setInterval(() => {
            remaining -= 1;
            setAutoScanSecondsRemaining(remaining);
            if (remaining <= 0) {
              if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
              setAutoScanAttempt((att) => att + 1);
              triggerAnalysisRef.current?.();
            }
          }, 1000);
        } else if (autoScanAttempt >= MAX_AUTO_SCAN_ATTEMPTS) {
          setAutoScanSecondsRemaining(0);
        }
      }
    }, 850);
  };

  // Keep trigger ref always updated to latest instance
  useEffect(() => {
    triggerAnalysisRef.current = handleTriggerAnalysis;
  });

  // Trade Execution tracking
  const handleExecuteTrade = () => {
    if (!user) {
      onOpenAuth?.('login');
      return;
    }
    if (!signal || signal.direction === 'WAIT' || isExpired) return;

    const tfSec = tfConfig.seconds;
    setActiveTrade({
      entryPrice: currentPrice,
      direction: signal.direction as 'CALL' | 'PUT',
      timeframeSeconds: tfSec,
      startedAt: Date.now(),
      secondsRemaining: tfSec,
      status: 'AT_THE_MONEY',
      pipDiff: 0,
      completed: false,
    });
  };

  // Safe Close Now
  const handleSafeCloseNow = () => {
    if (!activeTrade || activeTrade.completed) return;
    const finalOutcome: 'WIN' | 'LOSS' = activeTrade.pipDiff > 0 ? 'WIN' : 'LOSS';
    finalizeTrade(finalOutcome, activeTrade.pipDiff);
  };

  const finalizeTrade = (outcome: 'WIN' | 'LOSS', finalPipDiff: number) => {
    if (tradeTimerRef.current) clearInterval(tradeTimerRef.current);
    if (!activeTrade) return;

    setActiveTrade((prev) => (prev ? { ...prev, completed: true } : null));
    if (signal) {
      onLogOutcome(outcome, signal);
      logOutcomeToSupabase(signal, outcome, finalPipDiff);
    }

    if (signalHistory.length > 0) {
      handleUpdateHistoryOutcome(signalHistory[0].id, outcome);
    }

    setTimeout(() => {
      setActiveTrade(null);
      setIsLocked(false);
      setIsExpired(false);
    }, 2000);
  };

  // Live in-trade progression loop
  useEffect(() => {
    if (!activeTrade || activeTrade.completed) return;

    tradeTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - activeTrade.startedAt) / 1000);
      const remaining = Math.max(0, activeTrade.timeframeSeconds - elapsed);
      const pipMultiplier = 1 / (activeAsset?.pipSize || 0.0001);
      const diff =
        activeTrade.direction === 'CALL'
          ? (currentPrice - activeTrade.entryPrice) * pipMultiplier
          : (activeTrade.entryPrice - currentPrice) * pipMultiplier;

      const pipDiff = parseFloat(diff.toFixed(1));
      const status = pipDiff > 0 ? 'IN_THE_MONEY' : pipDiff < 0 ? 'OUT_OF_THE_MONEY' : 'AT_THE_MONEY';

      setActiveTrade((prev) => (prev ? { ...prev, secondsRemaining: remaining, pipDiff, status } : null));

      if (remaining <= 0) {
        const finalOutcome = pipDiff > 0 ? 'WIN' : 'LOSS';
        finalizeTrade(finalOutcome, pipDiff);
      }
    }, 250);

    return () => {
      if (tradeTimerRef.current) clearInterval(tradeTimerRef.current);
    };
  }, [activeTrade, currentPrice, activeAsset?.pipSize]);

  // Handle post-trade feedback
  const handleOutcome = (outcome: 'WIN' | 'LOSS') => {
    if (!signal) return;
    onLogOutcome(outcome, signal);
    logOutcomeToSupabase(signal, outcome, 0);

    if (signalHistory.length > 0) {
      handleUpdateHistoryOutcome(signalHistory[0].id, outcome);
    }
    setIsLocked(false);
    setIsExpired(false);
    setSignal(null);
  };

  // Copy MT5 Trade Setup
  const handleCopyMt5Setup = () => {
    if (!signal?.mt5?.formattedText) return;
    navigator.clipboard.writeText(signal.mt5.formattedText);
    setCopiedMt5Text(true);
    setTimeout(() => setCopiedMt5Text(false), 2000);
  };

  // Copy EA JSON
  const handleCopyMt5Json = () => {
    if (!signal?.mt5) return;
    const jsonStr = JSON.stringify(signal.mt5, null, 2);
    navigator.clipboard.writeText(jsonStr);
    setCopiedMt5Json(true);
    setTimeout(() => setCopiedMt5Json(false), 2000);
  };

  const progressOffset = ((6.0 - freshnessSec) / 6.0) * 88;

  return (
    <div className="space-y-4" id="signal-engine-cockpit">
      {/* 1. TOP STATUS BAR: Live Quantitative Telemetry */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 sm:p-4 shadow-xl font-mono text-xs">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 mb-2.5">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-bold text-white text-xs sm:text-sm">
              Live Quant Gate &bull; {activeAsset?.name || 'EUR/USD'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400">Balance:</span>
            <span className="font-bold text-emerald-400">
              {isVIP ? 'UNLIMITED VIP' : `${credits} CR`}
            </span>
            {isVIP && (
              <button
                type="button"
                onClick={onOpenVipRadar}
                className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded font-bold hover:bg-amber-500/30 transition flex items-center gap-1"
              >
                <span>⚡ VIP Radar</span>
              </button>
            )}
          </div>
        </div>

        {/* Live Indicator Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800 flex items-center justify-between">
            <span className="text-slate-400">RSI (14):</span>
            <span
              className={`font-bold ${
                liveAudit.rsi > 70 ? 'text-rose-400' : liveAudit.rsi < 30 ? 'text-emerald-400' : 'text-slate-200'
              }`}
            >
              {liveAudit.rsi.toFixed(1)}
            </span>
          </div>

          <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800 flex items-center justify-between">
            <span className="text-slate-400">EMA Trend:</span>
            <span
              className={`font-bold ${
                liveAudit.emaTrend === 'BULLISH' || liveAudit.emaTrend === 'CROSSOVER_UP'
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }`}
            >
              {liveAudit.emaTrend}
            </span>
          </div>

          <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800 flex items-center justify-between">
            <span className="text-slate-400">Order Flow:</span>
            <span className="font-bold text-teal-400">
              {liveAudit.orderFlowBuyPct}% Buy / {liveAudit.orderFlowSellPct}% Sell
            </span>
          </div>

          <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800 flex items-center justify-between">
            <span className="text-slate-400">Confluence:</span>
            <span className="font-bold text-amber-400">{liveAudit.confluenceScore}%</span>
          </div>
        </div>
      </div>

      {/* 2. UNIFIED BROKER / PLATFORM SELECTOR & AUTO-SCAN (Rule 4 & Rule 7) */}
      <div data-tour="mode-switcher" className="bg-slate-900 border border-slate-800 rounded-2xl p-3 shadow-lg space-y-3 font-mono">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="broker-platform-select" className="text-[10px] text-slate-400 uppercase tracking-wider font-bold flex items-center gap-1.5">
                <span>Broker / Trading Platform</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                  analysisProfile === 'MT5'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                }`}>
                  {analysisProfile === 'MT5' ? 'MetaTrader 5 (SL/TP)' : 'Quick Expiry (CALL/PUT)'}
                </span>
              </label>

              {currentPlatform.referralUrl && (
                <a
                  href={currentPlatform.referralUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold underline flex items-center gap-0.5"
                >
                  <span>Launch {currentPlatform.name}</span>
                  <span className="text-[9px]">↗</span>
                </a>
              )}
            </div>

            <div className="relative">
              <select
                id="broker-platform-select"
                value={selectedPlatformId}
                onChange={(e) => handlePlatformChange(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 hover:border-slate-600 rounded-xl py-2 px-3 text-xs text-white font-bold appearance-none cursor-pointer focus:border-emerald-500 focus:outline-none transition shadow-inner"
              >
                {platforms.filter((p) => p.enabled).map((p) => (
                  <option key={p.id} value={p.id} className="bg-slate-900 text-white">
                    {p.name} — {p.profile === 'MT5' ? 'MetaTrader 5 (SL/TP Forex)' : 'Binary Option (Fixed Expiry)'}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>

          {/* Auto-Scan After WAIT Toggle */}
          <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-1.5 pt-1 sm:pt-0 border-t sm:border-t-0 border-slate-800 shrink-0">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-[11px] text-slate-300 font-bold">Auto-scan after WAIT</span>
              <div
                role="switch"
                aria-checked={autoScanEnabled}
                tabIndex={0}
                onClick={() => {
                  const nextVal = !autoScanEnabled;
                  setAutoScanEnabled(nextVal);
                  try {
                    localStorage.setItem('pulsetrade_auto_scan', String(nextVal));
                  } catch {}
                  if (!nextVal && autoScanCountdownRef.current) {
                    clearInterval(autoScanCountdownRef.current);
                    setAutoScanSecondsRemaining(0);
                    setAutoScanAttempt(0);
                  }
                }}
                className={`w-9 h-5 flex items-center rounded-full p-0.5 transition-colors cursor-pointer ${
                  autoScanEnabled ? 'bg-emerald-500' : 'bg-slate-800'
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                    autoScanEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </div>
            </label>
            <span className="text-[9px] text-slate-500 font-sans">
              {autoScanEnabled ? 'Auto-retries on 8s cycle (max 10)' : 'Disabled (manual scan)'}
            </span>
          </div>
        </div>

        {/* Auto-Scan Active Visual Countdown Banner */}
        {autoScanSecondsRemaining > 0 && (
          <div className="bg-amber-500/15 border border-amber-500/30 rounded-xl p-2.5 flex items-center justify-between text-xs animate-in fade-in duration-150">
            <div className="flex items-center gap-2 text-amber-300">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span className="font-bold">
                Auto-scanning… {autoScanAttempt + 1}/{MAX_AUTO_SCAN_ATTEMPTS}
              </span>
              <span className="text-[10px] text-amber-400/80 bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800/60">
                Next scan in {autoScanSecondsRemaining}s
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
                setAutoScanSecondsRemaining(0);
                setAutoScanAttempt(0);
              }}
              className="text-[10px] text-slate-400 hover:text-white px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded transition"
            >
              Cancel Auto-Scan
            </button>
          </div>
        )}
      </div>

      {/* 3. TIMEFRAME SELECTOR */}
      <div data-tour="timeframe-selector" className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
          <span className="uppercase tracking-wider">Analysis Horizon</span>
          <span className="text-emerald-400 font-bold bg-emerald-950/50 border border-emerald-500/30 px-2 py-0.5 rounded">
            Target: {tfConfig.desc}
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5" id="timeframe-grid">
          {TIMEFRAMES.map((tf) => {
            const isActive = tf.id === selectedTf;
            return (
              <button
                key={tf.id}
                type="button"
                id={`tf-btn-${tf.id}`}
                onClick={() => setSelectedTf(tf.id)}
                className={`py-1.5 px-2 rounded-xl text-xs font-mono transition-all flex flex-col items-center justify-center gap-0.5 ${
                  isActive
                    ? 'bg-gradient-to-b from-slate-800 to-slate-900 border-2 border-emerald-400 text-emerald-300 font-black shadow-md shadow-emerald-500/20'
                    : 'bg-slate-900/80 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <span className="text-xs font-black">{tf.label}</span>
                <span className="text-[9px] opacity-75 font-normal">{tf.seconds}s window</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 4. RE-CHECKING MODAL / PROGRESS BAR */}
      {isRechecking && (
        <div className="bg-slate-900 border-2 border-emerald-500/50 rounded-2xl p-4 shadow-2xl space-y-2.5 animate-in fade-in duration-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              <h4 className="font-mono text-xs font-black text-white uppercase tracking-wider">
                Auditing Tick Buffer &bull; {analysisMode === 'quick' ? 'Quick Expiry Soft Gate' : 'MT5 Strict Gate'}
              </h4>
            </div>
            <span className="font-mono text-[11px] font-bold text-emerald-400">
              Stage {recheckStage}/4
            </span>
          </div>

          <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
            <div
              className="bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300 h-full transition-all duration-300 rounded-full"
              style={{ width: `${(recheckStage / 4) * 100}%` }}
            />
          </div>

          <p className="font-mono text-[11px] text-slate-300 animate-pulse truncate">
            {recheckNote}
          </p>
        </div>
      )}

      {/* Credit Fairness Notice */}
      {creditNotice && (
        <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-xl p-2.5 text-center font-mono text-xs text-emerald-300">
          ✓ {creditNotice}
        </div>
      )}

      {/* 5. IN-FLIGHT ACTIVE TRADE TRACKER */}
      {activeTrade && (
        <div
          id="active-trade-tracker"
          className={`rounded-2xl p-3.5 shadow-2xl border transition-all duration-300 space-y-2.5 ${
            activeTrade.status === 'IN_THE_MONEY'
              ? 'bg-emerald-950/40 border-emerald-500/70'
              : activeTrade.status === 'OUT_OF_THE_MONEY'
              ? 'bg-rose-950/40 border-rose-500/70'
              : 'bg-slate-900 border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <div className="flex items-center gap-2">
              <span
                className={`text-xs font-black font-mono px-2 py-0.5 rounded-lg ${
                  activeTrade.direction === 'CALL' ? 'bg-emerald-400 text-slate-950' : 'bg-rose-500 text-white'
                }`}
              >
                LIVE {activeTrade.direction}
              </span>
              <span className="text-xs font-mono font-bold text-white">
                {activeAsset?.name} ({activeTrade.timeframeSeconds}s Horizon)
              </span>
            </div>
            <div className="flex items-center gap-1 font-mono text-xs">
              <span className="text-slate-400">EXPIRING:</span>
              <span className="text-sm font-black text-amber-400 animate-pulse">
                {activeTrade.secondsRemaining}s
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center font-mono">
            <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Entry Strike</span>
              <span className="text-xs font-bold text-slate-200">{activeTrade.entryPrice}</span>
            </div>
            <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Live Price</span>
              <span className="text-xs font-bold text-white">{currentPrice}</span>
            </div>
            <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Delta</span>
              <span
                className={`text-xs font-black ${
                  activeTrade.status === 'IN_THE_MONEY' ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {activeTrade.pipDiff > 0 ? `+${activeTrade.pipDiff}` : activeTrade.pipDiff} pips
              </span>
            </div>
          </div>

          {activeTrade.status === 'IN_THE_MONEY' && !activeTrade.completed && (
            <button
              type="button"
              onClick={handleSafeCloseNow}
              className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black font-mono text-xs shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2 animate-pulse active:scale-98"
            >
              <span>⭐ LOCK PROFIT / SAFE CLOSE NOW ({activeTrade.pipDiff > 0 ? `+${activeTrade.pipDiff}` : activeTrade.pipDiff} pips)</span>
            </button>
          )}
        </div>
      )}

      {/* 6. PRIMARY ANALYSIS CARD (MODE A VS MODE B) */}
      <div
        id="signal-display-container"
        data-tour="confluence-gate"
        className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-2xl relative overflow-hidden transition-all duration-300"
      >
        {!signal ? (
          /* Standby / Initial State */
          <div className="text-center py-5 space-y-2">
            <div className="w-11 h-11 rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center mx-auto text-emerald-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-white text-xs sm:text-sm font-mono uppercase tracking-wide">
                Confirmation Gate Ready &bull; {analysisMode === 'quick' ? 'Quick Expiry Mode' : 'MT5 Style Mode'}
              </h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                {analysisMode === 'quick'
                  ? 'Quick Expiry Soft Gate evaluates micro structure and EMA alignment. Click Scan to audit tick flow.'
                  : 'MT5 Strict Gate evaluates institutional swing structure, POC volume, and invalidation levels. No trades placed in chop.'}
              </p>
            </div>
          </div>
        ) : signal.status === 'ANALYSIS_BLOCKED' ? (
          /* BLOCKED STATE: Missing symbol or timeframe */
          <div className="bg-rose-950/30 border border-rose-500/50 rounded-xl p-4 font-mono text-xs space-y-2.5 text-center">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center mx-auto text-rose-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="font-bold text-rose-300 text-sm">
              ANALYSIS BLOCKED
            </div>
            <p className="text-slate-300 text-xs">
              {signal.blockedReason}
            </p>
            <p className="text-[11px] text-slate-400">
              {signal.plainLanguageReason}
            </p>
          </div>
        ) : analysisMode === 'quick' ? (
          /* ============================================================== */
          /* MODE A: SHORT EXPIRY (ExpertOption / Deriv Style)               */
          /* Output: CALL | PUT | WAIT (+ short reason + hold guidance)      */
          /* NO Stop Loss / Take Profit card required                        */
          /* ============================================================== */
          <div className="space-y-3.5">
            {/* Header: Direction, Symbol & Expiry */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <span
                  id="signal-direction-badge"
                  className={`text-base font-black font-mono uppercase px-3.5 py-1.5 rounded-xl shadow-lg ${
                    signal.direction === 'CALL'
                      ? 'text-slate-950 bg-emerald-400 shadow-emerald-400/20'
                      : signal.direction === 'PUT'
                      ? 'text-white bg-rose-500 shadow-rose-500/20'
                      : 'text-amber-200 bg-amber-500/20 border border-amber-500/40'
                  }`}
                >
                  {signal.direction === 'CALL'
                    ? 'CALL (BUY)'
                    : signal.direction === 'PUT'
                    ? 'PUT (SELL)'
                    : 'WAIT / NO TRADE'}
                </span>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono font-bold text-slate-200">
                      {signal.asset} &bull; {signal.timeframe.toUpperCase()}
                    </span>
                    {isVIP && (
                      <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded">
                        ★ VIP
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-emerald-400">
                    Structure: {signal.marketStructure} ({signal.structureCue})
                  </span>
                </div>
              </div>

              {/* 6-Second Freshness Window Radial Timer */}
              {signal.direction !== 'WAIT' && (
                <div className="flex items-center gap-2">
                  <div className="relative w-8 h-8 flex items-center justify-center">
                    <svg className="w-8 h-8 -rotate-90" viewBox="0 0 36 36">
                      <circle cx="18" cy="18" r="14" fill="none" stroke="#1e293b" strokeWidth="3" />
                      <circle
                        cx="18"
                        cy="18"
                        r="14"
                        fill="none"
                        stroke={isExpired ? '#f43f5e' : '#10b981'}
                        strokeWidth="3"
                        strokeDasharray="88"
                        strokeDashoffset={progressOffset}
                        className="transition-all duration-100"
                      />
                    </svg>
                    <span className="absolute text-[10px] font-mono font-bold text-white">
                      {Math.ceil(freshnessSec)}s
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Freshness Banner for Actionable Binary Mode */}
            {signal.direction !== 'WAIT' && (
              <div
                id="freshness-banner"
                className={`px-3 py-1.5 rounded-xl text-xs font-mono font-bold flex items-center justify-between transition-all ${
                  !isExpired
                    ? 'bg-emerald-950/70 border border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/70 border border-rose-500/40 text-rose-300 animate-pulse'
                }`}
              >
                <span>{isExpired ? '🔴 ENTRY WINDOW EXPIRED — RE-SCAN' : '🟢 PRIME ENTRY WINDOW CONFIRMED'}</span>
                <span className="text-[10px]">
                  {isExpired ? 'Void' : `Valid: ${freshnessSec.toFixed(1)}s`}
                </span>
              </div>
            )}

            {/* Honest WAIT Advisory Box */}
            {signal.direction === 'WAIT' && (
              <div className="bg-amber-950/30 border border-amber-500/40 rounded-xl p-3 font-mono text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-300 flex items-center gap-1.5">
                    <span>⏳</span>
                    <span>STANDBY: AWAITING DIRECTIONAL IMPULSE</span>
                  </span>
                  <span className="text-[10px] text-amber-400 font-bold bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800">
                    Confidence: {signal.confidence}%
                  </span>
                </div>
                <p className="text-slate-300 text-[11px] leading-relaxed">
                  {signal.plainLanguageReason}
                </p>
              </div>
            )}

            {/* Confluence Checklist Summary (Soft Gate Policy) */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono border-b border-slate-850 pb-1.5">
                <div>
                  <span className="text-slate-300 font-bold uppercase">Quick Confluence Checklist:</span>
                  <span className="text-[10px] text-slate-500 block">Core must agree &bull; Institutional rows are context</span>
                </div>
                <span className={signal.gatePassed ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                  {signal.gatePassed ? '✓ ACTIONABLE' : 'STANDBY'}
                </span>
              </div>
              <div className="space-y-1.5">
                {(signal.confluenceFactorsList || []).map((factor) => {
                  const isLockedRow = !isVIP && factor.isAdvanced;
                  return (
                    <div
                      key={factor.id}
                      className="flex items-center justify-between text-xs font-mono p-1.5 rounded-lg bg-slate-900/60 border border-slate-800/50"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold shrink-0 ${
                          isLockedRow
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : factor.status === 'PASS'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : factor.status === 'FAIL'
                            ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        }`}>
                          {isLockedRow ? '★' : factor.status === 'PASS' ? '✓' : factor.status === 'FAIL' ? '✗' : '?'}
                        </span>
                        <div className="truncate">
                          <span className="text-slate-300">{factor.name}</span>
                          <span className="text-[9px] text-slate-500 ml-1.5">[{factor.severity}]</span>
                        </div>
                      </div>

                      {isLockedRow ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 shrink-0 font-bold">
                          🔒 VIP Depth
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-bold ${
                          factor.status === 'PASS'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : factor.status === 'FAIL'
                            ? 'bg-rose-500/20 text-rose-300'
                            : 'bg-amber-500/20 text-amber-300'
                        }`}>
                          {factor.status}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Suggested Expiry Minutes & Safe Close Advisory */}
            <div className="bg-slate-950/90 border border-emerald-500/30 rounded-xl p-3 font-mono text-xs space-y-2">
              <div className="flex items-center justify-between text-emerald-300 font-bold text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span>⏱️</span>
                  <span>SUGGESTED EXPIRY: {signal.suggestedExpiryMinutes || 1} MIN</span>
                </span>
                <span className="text-[10px] text-white bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 rounded font-bold">
                  Peak Window: {safeCloseAnalysis.peakMomentumWindow}
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                {signal.suggestedExpiryReason || signal.shortHoldGuidance || safeCloseAnalysis.advisoryText}
              </p>
            </div>

            {/* Multi-Window Live Confirmation (Rule 6) */}
            {signal.multiWindow && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs space-y-2">
                <div className="flex items-center justify-between border-b border-slate-850 pb-1.5">
                  <span className="text-slate-300 font-bold uppercase text-[10px]">
                    Multi-Window Directional Confirmation:
                  </span>
                  <span className={`text-[10px] font-bold ${signal.multiWindow.allAgreed ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {signal.multiWindow.allAgreed ? '✓ CONSENSUS ALIGNED' : '⚠️ WINDOW CONFLICT'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                  <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block truncate">{signal.multiWindow.longWindowDesc}</span>
                    <span className={`font-bold block mt-0.5 ${
                      signal.multiWindow.longBias === 'BULLISH' ? 'text-emerald-400' : signal.multiWindow.longBias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal.multiWindow.longBias}
                    </span>
                  </div>
                  <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block truncate">{signal.multiWindow.midWindowDesc}</span>
                    <span className={`font-bold block mt-0.5 ${
                      signal.multiWindow.midBias === 'BULLISH' ? 'text-emerald-400' : signal.multiWindow.midBias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal.multiWindow.midBias}
                    </span>
                  </div>
                  <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block truncate">{signal.multiWindow.shortWindowDesc}</span>
                    <span className={`font-bold block mt-0.5 ${
                      signal.multiWindow.shortBias === 'BULLISH' ? 'text-emerald-400' : signal.multiWindow.shortBias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal.multiWindow.shortBias}
                    </span>
                  </div>
                </div>
                {signal.multiWindow.conflictSummary && (
                  <p className="text-[10px] text-amber-300 leading-tight">
                    {signal.multiWindow.conflictSummary}
                  </p>
                )}
              </div>
            )}

            {/* Signal History Learning Note (Rule 7) */}
            {signal.historyLearning && signal.historyLearning.totalRecent >= 4 && (
              <div className={`p-2.5 rounded-xl border text-[10px] font-mono leading-relaxed ${
                signal.historyLearning.status === 'CAUTION_RAISED_THRESHOLD'
                  ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                  : 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
              }`}>
                <span>🧠 <strong>Signal Memory ({signal.historyLearning.winRatePct}% win rate):</strong> {signal.historyLearning.note}</span>
              </div>
            )}

            {/* Strike & Target Price Info */}
            <div className="grid grid-cols-3 gap-2 text-center font-mono">
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-2">
                <span className="text-[10px] text-slate-500 uppercase block">Entry Strike</span>
                <span className="text-xs font-bold text-white block mt-0.5">{signal.entryPrice}</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-2">
                <span className="text-[10px] text-slate-500 uppercase block">Confluence</span>
                <span className="text-xs font-black text-emerald-400 block mt-0.5">{signal.confidence}%</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-2">
                <span className="text-[10px] text-slate-500 uppercase block">Target Strike</span>
                <span className="text-xs font-bold text-amber-400 block mt-0.5">
                  {signal.direction === 'WAIT' ? 'N/A' : signal.targetPrice?.toFixed(activeAsset?.decimals || 5)}
                </span>
              </div>
            </div>

            {/* Execute On Broker CTA */}
            {!activeTrade && !isExpired && signal.direction !== 'WAIT' && (
              <button
                type="button"
                onClick={handleExecuteTrade}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black font-mono text-xs sm:text-sm shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2"
              >
                <span>EXECUTE {signal.direction} ON BROKER ({signal.timeframe.toUpperCase()})</span>
                <span className="text-xs opacity-80">&rarr; Track Live Win</span>
              </button>
            )}

            {/* Plain language risk note */}
            <div className="text-[10px] font-mono text-slate-500 text-center pt-1">
              {signal.riskNote}
            </div>
          </div>
        ) : (
          /* ============================================================== */
          /* MODE B: MT5 STYLE (MetaTrader 5 Clean Ordered Card)             */
          /* 1) Symbol + Timeframe                                          */
          /* 2) Structure (BULLISH/BEARISH/RANGING/NEUTRAL + cue)           */
          /* 3) Direction (BUY | SELL | WAIT)                               */
          /* 4) Strict Confluence Checklist                                 */
          /* 5) Entry Zone (if actionable)                                  */
          /* 6) Stop Loss (invalidation-based)                              */
          /* 7) TP1 / TP2 (1:1.5 RR & 1:2.5 RR)                             */
          /* 8) Invalidation / When to stay out                             */
          /* 9) Short plain-language reason & Account Sizing                */
          /* ============================================================== */
          <div className="space-y-3.5 font-mono">
            {/* 1) Symbol + Timeframe Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-400" />
                <span className="text-xs font-bold text-white">
                  Symbol: <strong className="text-blue-300">{signal.asset}</strong> &bull; Timeframe: <strong className="text-emerald-400">{signal.timeframe.toUpperCase()}</strong>
                </span>
              </div>
              <span className="text-[10px] text-slate-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                Mode: MT5 Institutional
              </span>
            </div>

            {/* 2) Structure */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex items-center justify-between text-xs">
              <div>
                <span className="text-[10px] text-slate-400 block uppercase">2) Market Structure:</span>
                <span className={`font-black text-xs sm:text-sm ${
                  signal.marketStructure === 'BULLISH'
                    ? 'text-emerald-400'
                    : signal.marketStructure === 'BEARISH'
                    ? 'text-rose-400'
                    : 'text-amber-400'
                }`}>
                  {signal.marketStructure} &bull; {signal.structureCue}
                </span>
              </div>
              <span className="text-[11px] text-slate-400 text-right max-w-[200px] truncate">
                {signal.structureSummary}
              </span>
            </div>

            {/* 3) Direction */}
            <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-xs text-slate-400 uppercase font-bold">3) Actionable Direction:</span>
              <span className={`text-sm font-black uppercase px-3 py-1 rounded-lg ${
                signal.direction === 'CALL'
                  ? 'bg-emerald-400 text-slate-950'
                  : signal.direction === 'PUT'
                  ? 'bg-rose-500 text-white'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`}>
                {signal.direction === 'CALL' ? 'BUY (LONG)' : signal.direction === 'PUT' ? 'SELL (SHORT)' : 'WAIT / NO TRADE'}
              </span>
            </div>

            {/* 4) Strict Checklist States */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] border-b border-slate-850 pb-1.5">
                <div>
                  <span className="text-slate-300 font-bold uppercase">4) Strict Confluence Checklist:</span>
                  <span className="text-[10px] text-slate-500 block">Critical factors must pass &bull; No fiction in chop</span>
                </div>
                <span className={signal.gatePassed ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                  {signal.gatePassed ? 'CONFIRMED' : 'WAIT (Gate Unmet)'}
                </span>
              </div>
              <div className="space-y-1.5">
                {(signal.confluenceFactorsList || []).map((factor) => {
                  const isLocked = !isVIP && factor.isAdvanced;
                  return (
                    <div
                      key={factor.id}
                      className="flex items-center justify-between text-xs p-1.5 rounded-lg bg-slate-900/60 border border-slate-800/60"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold shrink-0 ${
                          isLocked
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : factor.status === 'PASS'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : factor.status === 'FAIL'
                            ? 'bg-rose-500/20 text-rose-400'
                            : 'bg-amber-500/20 text-amber-400'
                        }`}>
                          {isLocked ? '★' : factor.status === 'PASS' ? '✓' : factor.status === 'FAIL' ? '✗' : '?'}
                        </span>
                        <div className="truncate">
                          <span className="text-slate-300">{factor.name}</span>
                          <span className="text-[9px] text-slate-500 ml-1.5">[{factor.severity}]</span>
                        </div>
                      </div>
                      {isLocked ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold shrink-0">
                          🔒 VIP Depth
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${
                          factor.status === 'PASS'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : factor.status === 'FAIL'
                            ? 'bg-rose-500/20 text-rose-300'
                            : 'bg-amber-500/20 text-amber-300'
                        }`}>
                          {factor.status}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Multi-Window Live Movement Confirmation (Rule 6) */}
            {signal.multiWindow && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs space-y-2">
                <div className="flex items-center justify-between border-b border-slate-850 pb-1.5">
                  <span className="text-slate-300 font-bold uppercase text-[10px]">
                    Multi-Window Consensus Check ({activeAsset.name}):
                  </span>
                  <span className={`text-[10px] font-bold ${signal.multiWindow.allAgreed ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {signal.multiWindow.allAgreed ? '✓ CONSENSUS CONFIRMED' : '⚠️ CONFLICTING LOOKBACKS'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                  <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block truncate">{signal.multiWindow.longWindowDesc}</span>
                    <span className={`font-bold block mt-0.5 ${
                      signal.multiWindow.longBias === 'BULLISH' ? 'text-emerald-400' : signal.multiWindow.longBias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal.multiWindow.longBias}
                    </span>
                  </div>
                  <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block truncate">{signal.multiWindow.midWindowDesc}</span>
                    <span className={`font-bold block mt-0.5 ${
                      signal.multiWindow.midBias === 'BULLISH' ? 'text-emerald-400' : signal.multiWindow.midBias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal.multiWindow.midBias}
                    </span>
                  </div>
                  <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block truncate">{signal.multiWindow.shortWindowDesc}</span>
                    <span className={`font-bold block mt-0.5 ${
                      signal.multiWindow.shortBias === 'BULLISH' ? 'text-emerald-400' : signal.multiWindow.shortBias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal.multiWindow.shortBias}
                    </span>
                  </div>
                </div>
                {signal.multiWindow.conflictSummary && (
                  <p className="text-[10px] text-amber-300 leading-tight">
                    {signal.multiWindow.conflictSummary}
                  </p>
                )}
              </div>
            )}

            {/* Signal History Learning Note (Rule 7) */}
            {signal.historyLearning && signal.historyLearning.totalRecent >= 4 && (
              <div className={`p-2.5 rounded-xl border text-[10px] font-mono leading-relaxed ${
                signal.historyLearning.status === 'CAUTION_RAISED_THRESHOLD'
                  ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                  : 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
              }`}>
                <span>🧠 <strong>Signal Memory ({signal.historyLearning.winRatePct}% win rate):</strong> {signal.historyLearning.note}</span>
              </div>
            )}

            {/* 5, 6, 7) Entry Zone, Stop Loss, Take Profit (Only if Actionable - Never invented if WAIT) */}
            {signal.direction !== 'WAIT' && signal.mt5 ? (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-2">
                    <span className="text-[10px] text-slate-400 uppercase block">5) Entry Zone</span>
                    <span className="text-xs font-bold text-white block mt-0.5">
                      {signal.entryZone ? `${signal.entryZone.min} - ${signal.entryZone.max}` : signal.entryPrice}
                    </span>
                  </div>
                  <div className="bg-slate-950 border border-rose-500/30 rounded-xl p-2">
                    <span className="text-[10px] text-rose-400 uppercase block">6) Stop Loss</span>
                    <span className="text-xs font-bold text-rose-300 block mt-0.5">{signal.mt5.stopLossPrice}</span>
                    <span className="text-[9px] text-rose-400/80">-{signal.mt5.stopLossPips} pips (Structural)</span>
                  </div>
                  <div className="bg-slate-950 border border-emerald-500/30 rounded-xl p-2">
                    <span className="text-[10px] text-emerald-400 uppercase block">7) Take Profit 1</span>
                    <span className="text-xs font-bold text-emerald-300 block mt-0.5">{signal.mt5.takeProfit1Price}</span>
                    <span className="text-[9px] text-emerald-400/80">+{signal.mt5.takeProfit1Pips} pips (1:1.5)</span>
                  </div>
                  <div className="bg-slate-950 border border-teal-500/30 rounded-xl p-2">
                    <span className="text-[10px] text-teal-400 uppercase block">7) Take Profit 2</span>
                    <span className="text-xs font-bold text-teal-300 block mt-0.5">{signal.mt5.takeProfit2Price}</span>
                    <span className="text-[9px] text-teal-400/80">+{signal.mt5.takeProfit2Pips} pips (1:2.5)</span>
                  </div>
                </div>

                {/* MT5 Position Size Calculator */}
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-bold">Position Size Calculator:</span>
                    <span className="text-emerald-400 font-bold">
                      Recommended: <strong className="text-white text-sm">{signal.mt5.recommendedLot} Lots</strong>
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-slate-400 block mb-1">Account Balance ($):</span>
                      <div className="flex items-center gap-1">
                        {[10, 100, 1000, 5000, 10000].map((b) => (
                          <button
                            key={b}
                            type="button"
                            onClick={() => setMt5Balance(b)}
                            className={`flex-1 py-1 rounded text-center transition ${
                              mt5Balance === b ? 'bg-blue-500 text-white font-bold' : 'bg-slate-900 text-slate-400'
                            }`}
                          >
                            ${b >= 1000 ? `${b / 1000}k` : b}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-1">Risk (% of balance):</span>
                      <div className="flex items-center gap-1">
                        {[0.5, 1.0, 2.0].map((r) => (
                          <button
                            key={r}
                            type="button"
                            onClick={() => setMt5RiskPct(r)}
                            className={`flex-1 py-1 rounded text-center transition ${
                              mt5RiskPct === r ? 'bg-blue-500 text-white font-bold' : 'bg-slate-900 text-slate-400'
                            }`}
                          >
                            {r}%
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Small Account Warning Callout */}
                  {signal.accountSizingWarning && (
                    <div className="mt-2 p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-[11px] text-amber-300 leading-relaxed">
                      ⚠️ <strong>Account Sizing Notice:</strong> {signal.accountSizingWarning}
                    </div>
                  )}
                </div>

                {/* Copy Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCopyMt5Setup}
                    className="py-2 px-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition flex items-center justify-center gap-1.5 active:scale-95"
                  >
                    {copiedMt5Text ? <span>✓ COPIED SETUP!</span> : <span>COPY MT5 SETUP</span>}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyMt5Json}
                    className="py-2 px-3 bg-slate-800 hover:bg-slate-750 text-slate-200 font-bold text-xs rounded-xl border border-slate-700 transition flex items-center justify-center gap-1.5 active:scale-95"
                  >
                    {copiedMt5Json ? <span>✓ COPIED JSON!</span> : <span>COPY EA JSON</span>}
                  </button>
                </div>
              </div>
            ) : (
              /* If WAIT state, SL/TP are never invented */
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-center space-y-1 text-slate-400 text-xs">
                <span className="font-bold text-amber-300 block">5, 6, 7) Entry / SL / TP: OMITTED</span>
                <span>Stop Loss & Take Profit levels are never invented when structure is ranging or unconfirmed.</span>
              </div>
            )}

            {/* 8) Invalidation / When to stay out */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs space-y-1">
              <span className="text-[10px] text-amber-400 font-bold block uppercase">
                8) Invalidation &amp; When To Stay Out:
              </span>
              <p className="text-slate-300 leading-relaxed text-[11px]">
                {signal.invalidationReason || 'Wait for structure breakout before taking risk.'}
              </p>
            </div>

            {/* 9) Short plain-language reason */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs space-y-1">
              <span className="text-[10px] text-cyan-400 font-bold block uppercase">
                9) Analysis Summary:
              </span>
              <p className="text-slate-300 leading-relaxed text-[11px]">
                {signal.plainLanguageReason}
              </p>
            </div>

            {/* Risk Line */}
            <div className="text-[10px] text-slate-500 text-center pt-1">
              {signal.riskNote}
            </div>
          </div>
        )}
      </div>

      {/* 7. MANDATORY OUTCOME FEEDBACK LOOP */}
      {isLocked && (
        <div
          id="mandatory-outcome-loop"
          className="bg-slate-900 border border-amber-500/40 rounded-2xl p-3.5 shadow-xl space-y-2.5 animate-in fade-in duration-300"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
              <h4 className="text-xs font-mono font-bold text-amber-300 uppercase tracking-wider">
                Session Recalibration Feedback
              </h4>
            </div>
            <span className="text-[10px] font-mono text-slate-500">Lockout Engaged</span>
          </div>
          <p className="text-xs text-slate-400">
            Log trade outcome to unlock the next computation and recalibrate algorithmic momentum weights.
          </p>

          <div className="grid grid-cols-2 gap-2 pt-1 font-mono">
            <button
              type="button"
              id="btn-outcome-won"
              onClick={() => handleOutcome('WIN')}
              className="py-2.5 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs sm:text-sm rounded-xl transition shadow-md shadow-emerald-500/20 flex items-center justify-center gap-1.5"
            >
              TRADE WON
            </button>
            <button
              type="button"
              id="btn-outcome-lost"
              onClick={() => handleOutcome('LOSS')}
              className="py-2.5 px-3 bg-rose-500 hover:bg-rose-400 text-white font-black text-xs sm:text-sm rounded-xl transition shadow-md shadow-rose-500/20 flex items-center justify-center gap-1.5"
            >
              TRADE LOST
            </button>
          </div>
        </div>
      )}

      {/* 8. PRIMARY TRIGGER SCAN BUTTON (Sticky / Mobile-Optimized) */}
      <div className="sticky bottom-16 md:static z-20 pt-1 pb-2">
        <button
          type="button"
          id="btn-analyse-trigger"
          data-tour="generate-signal"
          onClick={handleTriggerAnalysis}
          disabled={isLocked || isRechecking || Boolean(activeTrade)}
          className={`w-full py-3.5 px-4 rounded-2xl font-black font-mono text-xs sm:text-sm uppercase tracking-wider shadow-2xl transition-all duration-200 flex items-center justify-center gap-2 ${
            isLocked || Boolean(activeTrade)
              ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
              : isRechecking
              ? 'bg-emerald-500/20 text-emerald-300 border-2 border-emerald-400 cursor-wait'
              : analysisMode === 'quick'
              ? 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 shadow-emerald-500/30 active:scale-98 cursor-pointer'
              : 'bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-400 hover:from-blue-400 hover:to-indigo-400 text-white shadow-blue-500/30 active:scale-98 cursor-pointer'
          }`}
        >
          {isRechecking ? (
            <>
              <svg className="animate-spin h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>AUDITING MARKET CONFLUENCE...</span>
            </>
          ) : isLocked ? (
            <span>🔒 AWAITING SESSION OUTCOME FEEDBACK</span>
          ) : activeTrade ? (
            <span>⚡ TRADE ACTIVE — TRACKING IN-FLIGHT DELTA</span>
          ) : analysisMode === 'quick' ? (
            <>
              <span>⚡ SCAN QUICK CONFLUENCE</span>
              <span className="text-xs opacity-75">({activeAsset?.name || 'EUR/USD'} &bull; {selectedTf.toUpperCase()})</span>
            </>
          ) : (
            <>
              <span>📊 SCAN MT5 SETUP</span>
              <span className="text-xs opacity-75">({activeAsset?.name || 'EUR/USD'} &bull; {selectedTf.toUpperCase()})</span>
            </>
          )}
        </button>
      </div>

      {/* 9. SIGNAL HISTORY TABLE */}
      <SignalHistory signals={signalHistory} activeAsset={activeAsset} onUpdateOutcome={handleUpdateHistoryOutcome} />
    </div>
  );
}
