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
  SignalStrength,
} from '../types.ts';
import { playCallAudioChime, playPutAudioChime } from '../utils/audio.ts';
import {
  analyzeMarketConfluence,
  calculatePriceMomentumProxy,
  calculateSafeCloseAnalysis,
  computeSignalHistoryLearning,
  getAssetTimestampedTicks,
} from '../utils/quantEngine.ts';
import { formatDistanceUnitWord, resolveAssetPipSpec } from '../utils/instrumentMeta.ts';
import {
  analyzeBinarySignal,
  analyzeMT5Signal,
  computeMarketContext,
  formatBreakEvenStatement,
  inferAssetCurrencies,
  normalizeSpecKey,
  type BinaryExpiry,
  type BinaryExpiryChoice,
  type MarketContextSummary,
} from '../utils/engines/index.ts';
import { MarketContextPanel } from './MarketContextPanel.tsx';
import { getOrFetchCandles } from '../services/candleStore.ts';
import { getCurrentFeedStatus } from '../services/feedSingleton.ts';
import type { FeedStatus } from '../services/liveFeed.ts';
import {
  DEFAULT_USER_TRADING_PROFILE,
  fetchBrokerAssetMeta,
  fetchInstrumentSpec,
  fetchUpcomingMarketEvents,
  fetchUserTradingProfile,
  logOutcomeToSupabase,
  logSignalToSupabase,
  saveUserTradingProfile,
  type BrokerAssetMeta,
  type MarketEventRow,
} from '../utils/supabaseClient.ts';
import {
  fetchRemoteMinActionableStrength,
  getBrokerPlatforms,
  getMinActionableStrength,
  resolveBrokerDestinationUrl,
} from '../utils/siteConfigManager.ts';
import { useBrand } from '../utils/brand.ts';
import { isSyntheticAsset, SYNTHETIC_INDICES_NOTICE } from '../services/symbolMap.ts';
import { SignalHistory } from './SignalHistory.tsx';
import type { EngineChartSignal } from '../utils/chartOverlays.ts';
import {
  MIN_STRENGTH_WAIT_REASON,
  buildResultView,
  isStrengthBelowMinimum,
} from '../utils/resultView.ts';

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
  isFeedActive?: boolean;
  feedHealthStatus?: string;
  onSignalOutput?: (sig: EngineChartSignal | null) => void;
  onMarketContextUpdate?: (ctx: MarketContextSummary | null) => void;
  onProfileChange?: (profile: AnalysisProfile) => void;
}

export const BINARY_HORIZONS: Array<{
  id: BinaryExpiryChoice;
  label: string;
  sub: string;
  desc: string;
  seconds: number;
}> = [
  { id: 'auto', label: 'Auto', sub: 'Best fit (1m–5m)', desc: 'Auto-picks 1m–5m from volatility & trend', seconds: 60 },
  { id: '1m', label: '1 MIN — Fast, higher risk', sub: '1 min expiry', desc: '1m fast expiry (higher risk)', seconds: 60 },
  { id: '2m', label: '2 MIN', sub: '2 min expiry', desc: '2m continuation expiry', seconds: 120 },
  { id: '3m', label: '3 MIN', sub: '3 min expiry', desc: '3m M5/M15 structure expiry', seconds: 180 },
  { id: '5m', label: '5 MIN', sub: '5 min expiry', desc: '5m M5 + M15 trend expiry', seconds: 300 },
];

export const MT5_HORIZONS: Array<{
  id: 'M15' | 'H1';
  label: string;
  sub: string;
  desc: string;
}> = [
  { id: 'M15', label: 'Intraday — M15 chart', sub: 'M15 structure', desc: 'Intraday M15 chart structure' },
  { id: 'H1', label: 'Swing — H1 chart', sub: 'H1 structure', desc: 'Swing H1 chart structure' },
];

const BINARY_EXPIRY_SEC_MAP: Record<BinaryExpiry, number> = {
  '1m': 60,
  '2m': 120,
  '3m': 180,
  '5m': 300,
};

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
  isFeedActive = true,
  feedHealthStatus = 'LIVE',
  onSignalOutput,
  onMarketContextUpdate,
  onProfileChange,
}: SignalEngineProps) {
  const { siteName } = useBrand();
  // 1. Unified Broker Platform Selector State (Replaces Quick/MT5 dual buttons)
  const [platforms] = useState<BrokerPlatformItem[]>(() => getBrokerPlatforms());
  const [selectedPlatformId, setSelectedPlatformId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('pulsetrade_selected_platform');
      if (saved) return saved;
    } catch (err) {
      console.warn('[SignalEngine] Failed to read selected platform preference from storage:', err);
    }
    return 'expert_option';
  });

  const currentPlatform: BrokerPlatformItem = useMemo(() => {
    return platforms.find((p) => p.id === selectedPlatformId) || platforms[0] || {
      id: 'expert_option',
      name: 'ExpertOption',
      profile: 'BINARY_QUICK' as const,
      enabled: true,
      referralUrl: '',
      sortOrder: 1,
    };
  }, [platforms, selectedPlatformId]);

  // Derived Profile & quantEngine mode
  const analysisProfile: AnalysisProfile = currentPlatform.profile;
  const analysisMode: AnalysisMode = analysisProfile === 'MT5' ? 'mt5' : 'quick';

  const latestSymbolRef = useRef<string>(activeAsset?.symbol || '');
  useEffect(() => {
    latestSymbolRef.current = activeAsset?.symbol || '';
  }, [activeAsset?.symbol]);

  useEffect(() => {
    onProfileChange?.(analysisProfile);
  }, [analysisProfile, onProfileChange]);

  // Broker availability, payout metadata & OTC check
  const [brokerMeta, setBrokerMeta] = useState<BrokerAssetMeta>({
    payoutPct: 85,
    isOtc: false,
    enabled: true,
  });
  const [marketEvents, setMarketEvents] = useState<MarketEventRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (activeAsset?.symbol) {
      fetchBrokerAssetMeta(currentPlatform.id, activeAsset.symbol)
        .then((meta) => {
          if (!cancelled) setBrokerMeta(meta);
        })
        .catch(() => {});
    }
    fetchUpcomingMarketEvents()
      .then((events) => {
        if (!cancelled) setMarketEvents(events);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentPlatform.id, activeAsset?.symbol]);

  const isOtc = useMemo(() => {
    return (
      Boolean(brokerMeta.isOtc) ||
      Boolean((activeAsset as unknown as { is_otc?: boolean })?.is_otc) ||
      Boolean((currentPlatform as unknown as { is_otc?: boolean })?.is_otc) ||
      (activeAsset?.name || '').toUpperCase().includes('OTC') ||
      (activeAsset?.symbol || '').toUpperCase().includes('OTC')
    );
  }, [activeAsset, currentPlatform, brokerMeta.isOtc]);

  // Track latest tick arrival timestamp for tick freshness interlock (< 6s)
  const lastTickTimeRef = useRef<number>(Date.now());
  useEffect(() => {
    if (ticks && ticks.length > 0) {
      lastTickTimeRef.current = Date.now();
    }
  }, [ticks, currentPrice]);

  const handlePlatformChange = (id: string) => {
    setSelectedPlatformId(id);
    try {
      localStorage.setItem('pulsetrade_selected_platform', id);
    } catch (err) {
      console.warn('[SignalEngine] Failed to save selected platform preference to storage:', err);
    }
    if (signal) setSignal(null);
    setIsMoreDetailsOpen(false);
    onSignalOutput?.(null);
  };

  // Separate analysis horizons for Binary ('auto' | '1m' | '2m' | '3m' | '5m') and MT5 ('M15' | 'H1')
  const [binaryHorizon, setBinaryHorizon] = useState<BinaryExpiryChoice>('auto');
  const [mt5Horizon, setMt5Horizon] = useState<'M15' | 'H1'>('H1');
  const [mt5NowMs, setMt5NowMs] = useState<number>(() => Date.now());
  const selectedHorizonTf = analysisMode === 'quick' ? (binaryHorizon === 'auto' ? '2m' : binaryHorizon) : mt5Horizon;

  // Auto-Scan Switch State (Cockpit only: auto re-scan after WAIT)
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pulsetrade_auto_scan') === 'true';
    } catch (err) {
      console.warn('[SignalEngine] Failed to read auto_scan setting:', err);
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

  // Stop auto-scan if live feed is interrupted
  useEffect(() => {
    if (!isFeedActive) {
      if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
      setAutoScanSecondsRemaining(0);
      setAutoScanAttempt(0);
    }
  }, [isFeedActive]);
  
  // Signal State
  const [signal, setSignal] = useState<SignalData | null>(null);
  const [marketContext, setMarketContext] = useState<MarketContextSummary | null>(null);
  const [isLoadingContext, setIsLoadingContext] = useState<boolean>(false);
  const [isMoreDetailsOpen, setIsMoreDetailsOpen] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [freshnessSec, setFreshnessSec] = useState<number>(6.0);
  const [isExpired, setIsExpired] = useState<boolean>(false);
  const [creditNotice, setCreditNotice] = useState<string | null>(null);
  const [minActionableStrength, setMinActionableStrength] = useState<SignalStrength>(() =>
    getMinActionableStrength()
  );
  const minStrengthRef = useRef<SignalStrength>(minActionableStrength);
  useEffect(() => {
    minStrengthRef.current = minActionableStrength;
  }, [minActionableStrength]);

  useEffect(() => {
    let cancelled = false;
    fetchRemoteMinActionableStrength()
      .then((lvl) => {
        if (!cancelled) setMinActionableStrength(lvl);
      })
      .catch(() => {});
    const onMinStrengthChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<SignalStrength>)?.detail;
      if (detail === 'Low' || detail === 'Medium' || detail === 'High') {
        setMinActionableStrength(detail);
      }
    };
    window.addEventListener('pulsetrade_min_strength_changed', onMinStrengthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('pulsetrade_min_strength_changed', onMinStrengthChanged);
    };
  }, []);

  useEffect(() => {
    setSignal(null);
    setMarketContext(null);
    setIsLoadingContext(false);
    setIsMoreDetailsOpen(false);
    setIsLocked(false);
    setIsExpired(false);
    setFreshnessSec(0);
    if (countdownRef.current) clearInterval(countdownRef.current);
    onSignalOutput?.(null);
    onMarketContextUpdate?.(null);
  }, [activeAsset?.symbol, onSignalOutput, onMarketContextUpdate]);

  // Binary Stake Sizing (1% - 2% suggested stake) & 3-Loss Cool-Down
  const [binaryBalance, setBinaryBalance] = useState<number>(100);
  const [binaryRiskPct, setBinaryRiskPct] = useState<number>(1);
  const [breakAcknowledged, setBreakAcknowledged] = useState<boolean>(false);

  // MT5 Risk & Account Profile (persisted to Supabase for signed-in users)
  const [mt5AccountCurrency, setMt5AccountCurrency] = useState<'USD' | 'EUR' | 'GBP' | 'JPY' | 'AUD' | 'CAD' | 'CHF'>(
    () => user?.trading_profile?.accountCurrency || DEFAULT_USER_TRADING_PROFILE.accountCurrency
  );
  const [mt5Balance, setMt5Balance] = useState<number>(
    () => user?.trading_profile?.accountBalance ?? DEFAULT_USER_TRADING_PROFILE.accountBalance
  );
  const [mt5RiskPct, setMt5RiskPct] = useState<number>(
    () => user?.trading_profile?.riskPct ?? DEFAULT_USER_TRADING_PROFILE.riskPct
  );
  const [mt5Leverage, setMt5Leverage] = useState<number>(
    () => user?.trading_profile?.leverage ?? DEFAULT_USER_TRADING_PROFILE.leverage
  );
  const [mt5SpreadPips, setMt5SpreadPips] = useState<number>(
    () => user?.trading_profile?.brokerSpreadPips ?? DEFAULT_USER_TRADING_PROFILE.brokerSpreadPips
  );
  const [mt5ContractOverrides, setMt5ContractOverrides] = useState<Record<string, number>>(
    () => user?.trading_profile?.contractSizeOverrides || {}
  );
  const [copiedMt5Text, setCopiedMt5Text] = useState<boolean>(false);
  const [copiedMt5Json, setCopiedMt5Json] = useState<boolean>(false);

  useEffect(() => {
    if (!user) return;
    if (user.trading_profile) {
      setMt5AccountCurrency(user.trading_profile.accountCurrency);
      setMt5Balance(user.trading_profile.accountBalance);
      setMt5RiskPct(user.trading_profile.riskPct);
      setMt5Leverage(user.trading_profile.leverage);
      setMt5SpreadPips(user.trading_profile.brokerSpreadPips);
      setMt5ContractOverrides(user.trading_profile.contractSizeOverrides || {});
      return;
    }
    let cancelled = false;
    fetchUserTradingProfile()
      .then((tp) => {
        if (cancelled) return;
        setMt5AccountCurrency(tp.accountCurrency);
        setMt5Balance(tp.accountBalance);
        setMt5RiskPct(tp.riskPct);
        setMt5Leverage(tp.leverage);
        setMt5SpreadPips(tp.brokerSpreadPips);
        setMt5ContractOverrides(tp.contractSizeOverrides || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.trading_profile]);

  const handleUpdateMt5Balance = (nextBal: number) => {
    setMt5Balance(nextBal);
    if (user) saveUserTradingProfile({ accountBalance: nextBal }).catch(() => {});
  };

  const handleUpdateMt5RiskPct = (nextRisk: number) => {
    const clamped = Math.min(3.0, Math.max(0.1, nextRisk));
    setMt5RiskPct(clamped);
    if (user) saveUserTradingProfile({ riskPct: clamped }).catch(() => {});
  };

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
    } catch (err) {
      console.warn('[SignalEngine] Failed to read signal history from storage:', err);
    }
    return [];
  });

  useEffect(() => {
    try {
      localStorage.setItem('pulsetrade_signal_history', JSON.stringify(signalHistory));
    } catch (err) {
      console.warn('[SignalEngine] Failed to persist signal history to storage:', err);
    }
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
  const isSynthetic = useMemo(() => isSyntheticAsset(activeAsset), [activeAsset]);
  const assetPipSpec = useMemo(() => resolveAssetPipSpec(activeAsset), [activeAsset]);

  const liveAudit: TechnicalAudit = useMemo(() => {
    const auditTf = analysisMode === 'quick' ? (binaryHorizon === 'auto' ? '1m' : binaryHorizon) : mt5Horizon;
    return analyzeMarketConfluence(safeTicks, auditTf, assetPipSpec.pipSize, isVIP, analysisMode, activeAsset);
  }, [safeTicks, binaryHorizon, mt5Horizon, assetPipSpec.pipSize, activeAsset, isVIP, analysisMode]);

  const last60sTickStats = useMemo(() => {
    const tsTicks = getAssetTimestampedTicks(activeAsset?.symbol || '');
    if (tsTicks.length >= 2) {
      const newest = tsTicks[tsTicks.length - 1];
      const cutoff = newest.time > 1e12 ? newest.time - 60_000 : newest.time - 60;
      const recent60 = tsTicks.filter((t) => t.time >= cutoff).map((t) => t.price);
      if (recent60.length >= 2) {
        return calculatePriceMomentumProxy(recent60, recent60.length);
      }
    }
    return {
      buyPct: liveAudit.momentumBuyPct,
      sellPct: liveAudit.momentumSellPct,
    };
  }, [activeAsset?.symbol, safeTicks, liveAudit.momentumBuyPct, liveAudit.momentumSellPct]);

  // Safe close analysis
  const safeCloseAnalysis = useMemo(() => {
    const closeTf = analysisMode === 'quick' ? (binaryHorizon === 'auto' ? '1m' : binaryHorizon) : mt5Horizon;
    return calculateSafeCloseAnalysis(safeTicks, closeTf, assetPipSpec.pipSize, assetPipSpec.distanceUnit);
  }, [safeTicks, binaryHorizon, mt5Horizon, assetPipSpec.pipSize, assetPipSpec.distanceUnit, analysisMode]);

  // Count consecutive recent Binary losses for "Take a break" cool-down
  const binaryConsecutiveLosses = useMemo(() => {
    let count = 0;
    for (const item of signalHistory) {
      if (item.platformProfile && item.platformProfile !== 'BINARY_QUICK') continue;
      if (item.outcome === 'PENDING' || item.outcome === 'IN_TRADE' || item.outcome === 'WAIT') continue;
      if (item.outcome === 'LOSS') {
        count += 1;
      } else if (item.outcome === 'WIN') {
        break;
      }
    }
    return count;
  }, [signalHistory]);

  const isTakeABreakLocked =
    analysisProfile === 'BINARY_QUICK' && binaryConsecutiveLosses >= 3 && !breakAcknowledged;

  // Rule 3: DELAYED status blocks binary profile only, never MT5 candle-based scans
  const isFeedBlockedForProfile = useMemo(() => {
    if (feedHealthStatus === 'MARKET_CLOSED' || feedHealthStatus === 'IDLE') return true;
    if (analysisProfile === 'BINARY_QUICK') {
      return !isFeedActive || feedHealthStatus !== 'LIVE';
    }
    return (
      feedHealthStatus === 'OFFLINE' ||
      feedHealthStatus === 'RECONNECTING' ||
      feedHealthStatus === 'CONNECTING'
    );
  }, [analysisProfile, isFeedActive, feedHealthStatus]);

  const activeBinaryHorizonCfg = BINARY_HORIZONS.find((h) => h.id === binaryHorizon) || BINARY_HORIZONS[0];
  const activeMt5HorizonCfg = MT5_HORIZONS.find((h) => h.id === mt5Horizon) || MT5_HORIZONS[1];

  // Refresh MT5 validity countdown every 15s (minutes only, never seconds)
  useEffect(() => {
    if (analysisMode !== 'mt5' || !signal || signal.direction === 'WAIT') return;
    setMt5NowMs(Date.now());
    const id = setInterval(() => setMt5NowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [analysisMode, signal]);

  // PRIMARY CONFIRMATION ENGINE TRIGGER
  const handleTriggerAnalysis = async () => {
    // 1) Security check: Login required to trade
    if (!user) {
      onOpenAuth?.('login');
      return;
    }

    if (isLocked || isRechecking || activeTrade) return;

    // 3-consecutive-loss Take-A-Break interlock for Binary profile
    if (isTakeABreakLocked) {
      setCreditNotice('Take a break acknowledged is required after 3 consecutive Binary losses.');
      return;
    }

    // 0) Safety Interlock: OTC Check
    if (isOtc) {
      const blockedSignal: SignalData = {
        asset: activeAsset?.name || 'OTC Asset',
        symbol: activeAsset?.symbol,
        timeframe: selectedHorizonTf,
        direction: 'WAIT',
        strength: 'Low',
        trend: 'Neutral',
        velocity: 'Blocked',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: 'OTC prices are set by your broker; we cannot analyse them',
        plainLanguageReason:
          'This asset uses broker-internal OTC pricing with no independent public market feed. Analysis is disabled to protect your capital.',
        whyNotTrade: 'OTC asset blocked: proprietary broker feed cannot be independently verified.',
        riskNote: 'Trading involves risk. Algorithmic telemetry is not financial advice.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      onSignalOutput?.(null);
      setCreditNotice('Analysis disabled for broker-internal OTC assets.');
      return;
    }

    // 1) Market Closed Check
    if (feedHealthStatus === 'MARKET_CLOSED') {
      const blockedSignal: SignalData = {
        asset: activeAsset?.name || 'Forex Asset',
        symbol: activeAsset?.symbol,
        timeframe: selectedHorizonTf,
        direction: 'WAIT',
        strength: 'Low',
        trend: 'Neutral',
        velocity: 'Market Closed',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: 'Market is closed. Real-time feeds resume Sunday 21:00 UTC.',
        plainLanguageReason:
          'Forex and equities markets close over the weekend. Live algorithmic analysis is disabled. You can switch to 24/7 Crypto pairs (synthetics are practice only).',
        whyNotTrade: 'Market is closed over the weekend. Switch to 24/7 Crypto for live market data.',
        riskNote: 'Trading involves risk. Always wait for confirmed live market feed.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      onSignalOutput?.(null);
      setCreditNotice('No credits deducted while market is closed.');
      return;
    }

    // 2) Live Feed Health Check (Rule 3: DELAYED blocks Binary only, NEVER MT5)
    if (isFeedBlockedForProfile) {
      const blockedSignal: SignalData = {
        asset: activeAsset?.name || 'EUR/USD',
        symbol: activeAsset?.symbol,
        timeframe: selectedHorizonTf,
        direction: 'WAIT',
        strength: 'Low',
        trend: 'Neutral',
        velocity: 'Feed Offline',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: `NO LIVE DATA: Market feed status is ${feedHealthStatus || 'CONNECTING'}.`,
        plainLanguageReason:
          analysisProfile === 'BINARY_QUICK'
            ? 'Binary expiry analysis requires an uninterrupted live tick feed. Signal generation is paused until fresh ticks resume.'
            : 'Signal generation is paused while reconnecting to Deriv market data. No credits deducted.',
        whyNotTrade: `Feed status ${feedHealthStatus || 'CONNECTING'} is unsafe for ${analysisProfile === 'BINARY_QUICK' ? 'short-expiry binary entry' : 'analysis'}.`,
        riskNote: 'Trading involves risk. Always wait for confirmed live market feed.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      onSignalOutput?.(null);
      setCreditNotice('No credits deducted while waiting for live market data.');
      return;
    }

    // 3) Binary Expiry Tick Freshness Check (< 6 seconds)
    if (analysisProfile === 'BINARY_QUICK') {
      const tickAgeSec = (Date.now() - lastTickTimeRef.current) / 1000;
      if (tickAgeSec > 6.0) {
        const blockedSignal: SignalData = {
          asset: activeAsset?.name || 'Asset',
          symbol: activeAsset?.symbol,
          timeframe: selectedHorizonTf,
          direction: 'WAIT',
          strength: 'Low',
          trend: 'Neutral',
          velocity: 'Tick Delayed',
          generatedAt: Date.now(),
          status: 'ANALYSIS_BLOCKED',
          blockedReason: `Tick feed delayed (${tickAgeSec.toFixed(1)}s old > 6s limit). Waiting for fresh live market tick.`,
          plainLanguageReason:
            'Binary options micro-structure signals require real-time tick telemetry under 6 seconds. Waiting for fresh tick from Deriv WebSocket before evaluating setups.',
          whyNotTrade: `Tick feed aged ${tickAgeSec.toFixed(1)}s exceeds the 6-second binary freshness limit.`,
          riskNote: 'Trading involves risk. Short-expiry entries require verified low-latency feeds.',
          gatePassed: false,
          confluenceFactorsList: [],
        };
        setSignal(blockedSignal);
        onSignalOutput?.(null);
        setCreditNotice('No credits deducted for delayed tick stream.');
        return;
      }
    }

    // 4) Instrument check
    if (!activeAsset || !activeAsset.symbol) {
      const blockedSignal: SignalData = {
        asset: 'UNKNOWN',
        timeframe: selectedHorizonTf,
        direction: 'WAIT',
        strength: 'Low',
        trend: 'Neutral',
        velocity: 'Blocked',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: 'Instrument not identified. Please select an asset from the market ticker.',
        plainLanguageReason: 'Analysis blocked: Instrument must come from reliable app state.',
        riskNote: 'Trading involves risk. Algorithmic telemetry is not financial advice.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      onSignalOutput?.(null);
      return;
    }

    // 5) Live Stream Check for Binary (requires >= 5 real ticks; MT5 uses candle fallback during DELAYED)
    if (analysisProfile === 'BINARY_QUICK' && safeTicks.length < 5) {
      const blockedSignal: SignalData = {
        asset: activeAsset.name,
        symbol: activeAsset.symbol,
        timeframe: selectedHorizonTf,
        direction: 'WAIT',
        strength: 'Low',
        trend: 'Neutral',
        velocity: 'Collecting Ticks',
        generatedAt: Date.now(),
        status: 'ANALYSIS_BLOCKED',
        blockedReason: `Live tick buffer warming (${safeTicks.length}/5 real ticks captured for ${activeAsset.name}).`,
        plainLanguageReason:
          `${siteName} strictly requires real WebSocket ticks before evaluating setups. Buffers start empty and never use fake seed data. No credits deducted.`,
        riskNote: 'Trading involves risk. Always wait for confirmed live market velocity.',
        gatePassed: false,
        confluenceFactorsList: [],
      };
      setSignal(blockedSignal);
      onSignalOutput?.(null);
      setCreditNotice('No credits deducted for warming tick buffer.');
      return;
    }

    // 6) Pre-check Credit Availability for non-VIP
    if (!isVIP && credits <= 0) {
      await onDeductCredit();
      return;
    }

    setCreditNotice(null);
    setIsRechecking(true);
    setRecheckStage(1);
    setRecheckNote(
      analysisProfile === 'BINARY_QUICK'
        ? `[1/4] Fetching M1, M5, M15 candles & ticks for ${activeAsset.name}...`
        : `[1/4] Fetching D1, H4, H1, M15 & M5 candles for ${activeAsset.name}...`
    );

    setTimeout(() => {
      setRecheckStage(2);
      setRecheckNote(`[2/4] Auditing structure, EMA alignment, RSI & ATR volatility regime...`);
    }, 200);

    setTimeout(() => {
      setRecheckStage(3);
      setRecheckNote(
        analysisProfile === 'BINARY_QUICK'
          ? `[3/4] Checking news events, session guard, payout breakeven & M15 filter...`
          : `[3/4] Evaluating D1/H4 bias, H1/M15 swings, ATR(14), spread & lot sizing...`
      );
    }, 450);

    setTimeout(async () => {
      setRecheckStage(4);
      setRecheckNote(`[4/4] Finalizing ${currentPlatform.name} (${analysisProfile}) output...`);

      // SECTION A: NEW DEDICATED BINARY ENGINE
      if (analysisProfile === 'BINARY_QUICK') {
        const targetSymbol = activeAsset.symbol;
        setIsLoadingContext(true);
        const contextCandlesPromise = Promise.all([
          getOrFetchCandles(targetSymbol, '1d', 90).catch(() => []),
          getOrFetchCandles(targetSymbol, '4h', 120).catch(() => []),
          getOrFetchCandles(targetSymbol, '1h', 1400).catch(() => []),
        ]);

        const [m1Candles, m5Candles, m15Candles, latestMeta, latestEvents] = await Promise.all([
          getOrFetchCandles(targetSymbol, '1m', 120).catch(() => []),
          getOrFetchCandles(targetSymbol, '5m', 80).catch(() => []),
          getOrFetchCandles(targetSymbol, '15m', 160).catch(() => []),
          fetchBrokerAssetMeta(currentPlatform.id, targetSymbol).catch(() => brokerMeta),
          fetchUpcomingMarketEvents().catch(() => marketEvents),
        ]);

        setBrokerMeta(latestMeta);
        setMarketEvents(latestEvents);

        const tsTicks = getAssetTimestampedTicks(targetSymbol);
        const nowEpochSec = Math.floor(Date.now() / 1000);
        const normalizedTicks =
          tsTicks.length >= 5
            ? tsTicks
            : safeTicks.map((p, idx) => ({
                time: nowEpochSec - (safeTicks.length - 1 - idx),
                price: p,
              }));

        const feedDiag = getCurrentFeedStatus();
        const binaryRes = analyzeBinarySignal({
          asset: activeAsset,
          platform: currentPlatform.id,
          platformName: currentPlatform.name,
          m1Candles,
          m5Candles,
          m15Candles,
          ticks: normalizedTicks,
          feedStatus: (feedHealthStatus || 'LIVE') as FeedStatus,
          feedSource: feedDiag.endpoint,
          payoutPct: latestMeta.payoutPct,
          isOtc: isOtc || latestMeta.isOtc,
          marketEvents: latestEvents,
          preferredExpiry: binaryHorizon,
        });

        const binaryBelowMinStrength =
          (binaryRes.direction === 'CALL' || binaryRes.direction === 'PUT') &&
          isStrengthBelowMinimum(binaryRes.strength, minStrengthRef.current);

        const mappedSignal: SignalData = {
          engine: binaryRes.engine,
          profile: 'BINARY_QUICK',
          analysisProfile: 'BINARY_QUICK',
          mode: 'quick',
          asset: activeAsset.name,
          symbol: binaryRes.symbol,
          platform: currentPlatform.name,
          platformName: currentPlatform.name,
          timeframe: binaryRes.expiry,
          expiry: binaryRes.expiry,
          expirySeconds: binaryRes.expirySeconds,
          direction: binaryBelowMinStrength ? 'WAIT' : binaryRes.direction,
          strength: binaryRes.strength,
          rawScore: binaryRes.rawScore,
          trend: binaryBelowMinStrength
            ? 'Neutral'
            : binaryRes.direction === 'CALL'
            ? 'Bullish'
            : binaryRes.direction === 'PUT'
            ? 'Bearish'
            : 'Neutral',
          velocity: feedHealthStatus === 'LIVE' ? 'Live Feed' : feedHealthStatus,
          generatedAt: Date.now(),
          createdAt: binaryRes.createdAt,
          validUntil: binaryRes.validUntil,
          enterWithinSeconds: binaryRes.enterWithinSeconds,
          reasons: binaryBelowMinStrength ? [MIN_STRENGTH_WAIT_REASON] : binaryRes.reasons,
          whyNotTrade: binaryBelowMinStrength ? MIN_STRENGTH_WAIT_REASON : binaryRes.whyNotTrade,
          payoutPct: binaryRes.payoutPct,
          breakEvenWinRatePct: binaryRes.breakEvenWinRatePct,
          breakEvenMessage: binaryRes.breakEvenMessage,
          feedSource: binaryRes.feedSource,
          inputsSnapshot: binaryRes.inputsSnapshot,
          entryPrice: binaryRes.entryPrice ?? (currentPrice || 0),
          plainLanguageReason: binaryBelowMinStrength
            ? MIN_STRENGTH_WAIT_REASON
            : binaryRes.whyNotTrade || binaryRes.reasons.join(' '),
          riskNote: 'Trading binary contracts carries full stake risk. algorithmic signals are educational and not financial advice.',
          gatePassed: !binaryBelowMinStrength && binaryRes.direction !== 'WAIT',
          status: 'READY',
        };

        if (latestSymbolRef.current !== targetSymbol) {
          setIsLoadingContext(false);
          setIsRechecking(false);
          return;
        }

        setIsMoreDetailsOpen(false);
        setSignal(mappedSignal);
        onSignalOutput?.(binaryBelowMinStrength ? null : binaryRes);
        setIsRechecking(false);

        contextCandlesPromise
          .then(([d1C, h4C, h1C]) => {
            if (latestSymbolRef.current !== targetSymbol) return;
            const ctx = computeMarketContext({
              asset: activeAsset,
              currentPrice: binaryRes.entryPrice ?? (currentPrice || 0),
              m15Candles,
              h1Candles: h1C,
              h4Candles: h4C,
              d1Candles: d1C,
            });
            setMarketContext(ctx);
            onMarketContextUpdate?.(ctx);
          })
          .catch(() => {})
          .finally(() => {
            if (latestSymbolRef.current === targetSymbol) {
              setIsLoadingContext(false);
            }
          });

        const isActionable = mappedSignal.direction === 'CALL' || mappedSignal.direction === 'PUT';
        if (binaryBelowMinStrength) {
          logSignalToSupabase(mappedSignal);
        }
        if (isActionable) {
          if (autoScanCountdownRef.current) clearInterval(autoScanCountdownRef.current);
          setAutoScanSecondsRemaining(0);
          setAutoScanAttempt(0);

          const historyItem: SignalHistoryItem = {
            id: 'sig_' + Date.now(),
            asset: activeAsset.name,
            platform: currentPlatform.name,
            platformProfile: 'BINARY_QUICK',
            timeframe: binaryRes.expiry,
            expiry: binaryRes.expiry,
            direction: binaryRes.direction,
            entryPrice: mappedSignal.entryPrice || currentPrice,
            strength: binaryRes.strength,
            generatedAt: Date.now(),
            outcome: 'PENDING',
            sparkline: safeTicks.slice(-10),
          };
          setSignalHistory((prev) => [historyItem, ...prev]);

          if (!isVIP) {
            await onDeductCredit();
          }
          setCreditNotice(null);
          logSignalToSupabase(mappedSignal);
          setIsLocked(true);
          setIsExpired(false);
          setFreshnessSec(binaryRes.enterWithinSeconds);

          if (binaryRes.direction === 'CALL') {
            playCallAudioChime();
          } else {
            playPutAudioChime();
          }

          if (countdownRef.current) clearInterval(countdownRef.current);
          const start = Date.now();
          countdownRef.current = setInterval(() => {
            const elapsed = (Date.now() - start) / 1000;
            const remaining = Math.max(0, binaryRes.enterWithinSeconds - elapsed);
            setFreshnessSec(remaining);
            if (remaining <= 0) {
              if (countdownRef.current) clearInterval(countdownRef.current);
              setIsExpired(true);
            }
          }, 100);
        } else {
          setIsLocked(false);
          setIsExpired(false);
          setFreshnessSec(0);
          if (countdownRef.current) clearInterval(countdownRef.current);
          if (!isVIP) {
            setCreditNotice('No credit charged for WAIT state — only actionable setups consume credits.');
          }
          if (autoScanEnabled && autoScanAttempt < MAX_AUTO_SCAN_ATTEMPTS && isFeedActive) {
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
        return;
      }

      // SECTION B: DEDICATED CANDLE-BASED MT5 ENGINE (Stage 3 Part 2)
      setIsLoadingContext(true);
      const [d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, dbSpec, latestEvents, tradingProfile] =
        await Promise.all([
          getOrFetchCandles(activeAsset.symbol, '1d', 90).catch(() => []),
          getOrFetchCandles(activeAsset.symbol, '4h', 120).catch(() => []),
          getOrFetchCandles(activeAsset.symbol, '1h', 1400).catch(() => []),
          getOrFetchCandles(activeAsset.symbol, '15m', 160).catch(() => []),
          getOrFetchCandles(activeAsset.symbol, '5m', 160).catch(() => []),
          fetchInstrumentSpec(activeAsset.symbol).catch(() => undefined),
          fetchUpcomingMarketEvents().catch(() => marketEvents),
          fetchUserTradingProfile().catch(() => ({
            accountCurrency: mt5AccountCurrency,
            accountBalance: mt5Balance,
            riskPct: mt5RiskPct,
            leverage: mt5Leverage,
            brokerSpreadPips: mt5SpreadPips,
            contractSizeOverrides: mt5ContractOverrides,
          })),
        ]);

      setMarketEvents(latestEvents);

      // Fetch live conversion quotes when quote currency != account currency
      const conversionRates: Record<string, number> = {};
      const resolvedQuoteCcy = (dbSpec?.quoteCcy || inferAssetCurrencies(activeAsset).quoteCcy || 'USD').toUpperCase();
      const acctCcy = (tradingProfile.accountCurrency || mt5AccountCurrency || 'USD').toUpperCase();
      if (resolvedQuoteCcy !== acctCcy) {
        const neededPairs = Array.from(
          new Set([
            resolvedQuoteCcy !== 'USD' ? `frx${resolvedQuoteCcy}USD` : '',
            resolvedQuoteCcy !== 'USD' ? `frxUSD${resolvedQuoteCcy}` : '',
            acctCcy !== 'USD' ? `frx${acctCcy}USD` : '',
            acctCcy !== 'USD' ? `frxUSD${acctCcy}` : '',
          ].filter(Boolean))
        );
        await Promise.all(
          neededPairs.map(async (pairSym) => {
            const c = await getOrFetchCandles(pairSym, '5m', 5).catch(() => []);
            const last = c[c.length - 1]?.close;
            if (last && last > 0) {
              conversionRates[pairSym] = last;
            }
          })
        );
      }

      const feedDiag = getCurrentFeedStatus();
      const specKey = normalizeSpecKey(activeAsset.symbol);
      const activeOverrides = {
        ...(tradingProfile.contractSizeOverrides || {}),
        ...(mt5ContractOverrides || {}),
      };
      const overrideContract =
        activeOverrides[activeAsset.symbol] ??
        activeOverrides[specKey];

      const structureTf: 'M15' | 'H1' = mt5Horizon;
      const mt5Res = analyzeMT5Signal({
        asset: activeAsset,
        platform: currentPlatform.id,
        platformName: currentPlatform.name,
        d1Candles,
        h4Candles,
        h1Candles,
        m15Candles,
        m5Candles,
        structureTimeframe: structureTf,
        feedStatus: (feedHealthStatus || 'LIVE') as FeedStatus,
        feedSource: feedDiag.endpoint,
        isOtc,
        marketEvents: latestEvents,
        instrumentSpec: dbSpec,
        accountCurrency: mt5AccountCurrency || tradingProfile.accountCurrency,
        accountBalance: mt5Balance ?? tradingProfile.accountBalance,
        riskPct: mt5RiskPct ?? tradingProfile.riskPct,
        leverage: mt5Leverage ?? tradingProfile.leverage,
        spreadPips: mt5SpreadPips ?? tradingProfile.brokerSpreadPips,
        contractSizeOverride: overrideContract,
        conversionRates,
      });

      const historyLearning = computeSignalHistoryLearning(
        activeAsset.symbol || activeAsset.name,
        'MT5',
        mt5Res.timeframe
      );

      const engineActionable = mt5Res.direction === 'BUY' || mt5Res.direction === 'SELL';
      const mt5BelowMinStrength =
        engineActionable && isStrengthBelowMinimum(mt5Res.strength, minStrengthRef.current);
      const isActionable = engineActionable && !mt5BelowMinStrength;

      const generatedSignal: SignalData = {
        engine: mt5Res.engine,
        profile: 'MT5',
        analysisProfile: 'MT5',
        mode: 'mt5',
        asset: mt5Res.asset,
        symbol: mt5Res.symbol,
        platform: currentPlatform.name,
        platformName: currentPlatform.name,
        timeframe: mt5Res.timeframe,
        direction: mt5BelowMinStrength ? 'WAIT' : mt5Res.direction,
        orderKind: mt5Res.orderKind,
        strength: mt5Res.strength,
        rawScore: mt5Res.rawScore,
        trend: mt5BelowMinStrength
          ? 'Neutral'
          : mt5Res.direction === 'BUY'
          ? 'Bullish'
          : mt5Res.direction === 'SELL'
          ? 'Bearish'
          : 'Neutral',
        velocity: feedHealthStatus === 'DELAYED' ? 'Candle Sync (Delayed Ticks)' : 'Candle Structure',
        generatedAt: mt5Res.generatedAt,
        createdAt: mt5Res.createdAt,
        validUntil: mt5Res.validUntil,
        validityWindowDesc: mt5Res.validityWindowDesc,
        reasons: mt5BelowMinStrength ? [MIN_STRENGTH_WAIT_REASON] : mt5Res.reasons,
        whyNotTrade: mt5BelowMinStrength ? MIN_STRENGTH_WAIT_REASON : mt5Res.whyNotTrade,
        feedSource: mt5Res.feedSource,
        inputsSnapshot: mt5Res.inputsSnapshot,
        entryPrice: mt5Res.entryPrice,
        targetPrice: isActionable ? (mt5Res.takeProfit1 ?? undefined) : undefined,
        entryZone: isActionable ? (mt5Res.entryZone ?? undefined) : undefined,
        invalidationLevel: isActionable ? (mt5Res.invalidationLevel ?? undefined) : undefined,
        invalidationReason: mt5Res.invalidationRule,
        sessionNote: mt5Res.sessionNote,
        sessionQuality: mt5Res.sessionQuality,
        tradeManagementNote: mt5Res.tradeManagementNote,
        accountSizingWarning: mt5Res.accountSizingWarning || mt5Res.riskWarning,
        plainLanguageReason: mt5BelowMinStrength
          ? MIN_STRENGTH_WAIT_REASON
          : mt5Res.whyNotTrade || mt5Res.reasons.join(' '),
        riskNote:
          mt5Res.riskWarning ||
          `${mt5Res.tradeManagementNote} Algorithmic setups are educational and not financial advice.`,
        gatePassed: isActionable,
        status: 'READY',
        historyLearning,
        mt5:
          isActionable && mt5Res.stopLoss !== null && mt5Res.takeProfit1 !== null && mt5Res.takeProfit2 !== null
            ? {
                symbol: mt5Res.asset.replace(/[^A-Za-z0-9]/g, ''),
                orderType: mt5Res.direction as 'BUY' | 'SELL',
                orderKind: mt5Res.orderKind,
                entryPrice: mt5Res.entryPrice,
                entryZone: mt5Res.entryZone ?? undefined,
                stopLossPrice: mt5Res.stopLoss,
                stopLossPips: mt5Res.stopLossPips ?? 0,
                takeProfit1Price: mt5Res.takeProfit1,
                takeProfit1Pips: mt5Res.takeProfit1Pips ?? 0,
                takeProfit2Price: mt5Res.takeProfit2,
                takeProfit2Pips: mt5Res.takeProfit2Pips ?? 0,
                rewardRiskTp1: mt5Res.rewardRiskTp1 ?? 0,
                rewardRiskTp2: mt5Res.rewardRiskTp2 ?? 0,
                riskRewardRatio: mt5Res.rewardRiskRatio,
                recommendedLot: mt5Res.lotSize,
                accountRiskAmount: mt5Res.riskMoney,
                accountCurrency: mt5Res.accountCurrency,
                validityCandles: mt5Res.validityCandles,
                validityWindowDesc: mt5Res.validityWindowDesc,
                validUntil: mt5Res.validUntil,
                invalidationLevel: mt5Res.invalidationLevel ?? undefined,
                invalidationRule: mt5Res.invalidationRule,
                sessionNote: mt5Res.sessionNote,
                tradeManagementNote: mt5Res.tradeManagementNote,
                formattedText: mt5Res.lotSize > 0 ? mt5Res.copyOrderText : '',
                accountSizingWarning: mt5Res.accountSizingWarning,
              }
            : undefined,
      };

      if (latestSymbolRef.current !== activeAsset.symbol) {
        setIsLoadingContext(false);
        setIsRechecking(false);
        return;
      }

      const mt5Ctx = computeMarketContext({
        asset: activeAsset,
        currentPrice: mt5Res.entryPrice || currentPrice,
        m15Candles,
        h1Candles,
        h4Candles,
        d1Candles,
      });

      setIsMoreDetailsOpen(false);
      setSignal(generatedSignal);
      setMarketContext(mt5Ctx);
      onSignalOutput?.(mt5BelowMinStrength ? null : mt5Res);
      onMarketContextUpdate?.(mt5Ctx);
      setIsLoadingContext(false);
      setIsRechecking(false);

      if (mt5BelowMinStrength) {
        logSignalToSupabase(generatedSignal);
      }

      if (isActionable) {
        const spark = m5Candles.slice(-10).map((c) => c.close);
        const historyItem: SignalHistoryItem = {
          id: 'sig_' + Date.now(),
          asset: activeAsset.name,
          platform: currentPlatform.name,
          platformProfile: 'MT5',
          timeframe: mt5Res.timeframe,
          direction: mt5Res.direction,
          entryPrice: mt5Res.entryPrice,
          targetPrice: mt5Res.takeProfit1 ?? undefined,
          strength: mt5Res.strength,
          generatedAt: Date.now(),
          outcome: 'PENDING',
          sparkline: spark,
        };
        setSignalHistory((prev) => [historyItem, ...prev]);

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
        setFreshnessSec(0);
        setMt5NowMs(Date.now());
        if (countdownRef.current) clearInterval(countdownRef.current);

        if (mt5Res.direction === 'BUY') {
          playCallAudioChime();
        } else {
          playPutAudioChime();
        }
      } else {
        setIsLocked(false);
        setIsExpired(false);
        setFreshnessSec(0);
        if (countdownRef.current) clearInterval(countdownRef.current);
        if (!isVIP) {
          setCreditNotice('No credit charged for WAIT state — only actionable setups consume credits.');
        }

        if (autoScanEnabled && autoScanAttempt < MAX_AUTO_SCAN_ATTEMPTS && !isFeedBlockedForProfile) {
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
    }, 700);
  };

  // Keep trigger ref always updated to latest instance
  useEffect(() => {
    triggerAnalysisRef.current = handleTriggerAnalysis;
  });

  // Trade Execution tracking (Binary only)
  const handleExecuteTrade = () => {
    if (!user) {
      onOpenAuth?.('login');
      return;
    }
    if (!signal || signal.direction === 'WAIT' || isExpired || analysisMode !== 'quick') return;

    const resolvedExp = (signal.expiry || '1m') as BinaryExpiry;
    const tfSec = BINARY_EXPIRY_SEC_MAP[resolvedExp] || 60;
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
      logOutcomeToSupabase(outcome, signal, user?.id || null);
    }

    if (signalHistory.length > 0) {
      handleUpdateHistoryOutcome(signalHistory[0].id, outcome);
    }
    setBreakAcknowledged(false);

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
      const pipMultiplier = 1 / assetPipSpec.pipSize;
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
  }, [activeTrade, currentPrice, assetPipSpec.pipSize]);

  // Handle post-trade feedback
  const handleOutcome = (outcome: 'WIN' | 'LOSS') => {
    if (!signal) return;
    onLogOutcome(outcome, signal);
    logOutcomeToSupabase(outcome, signal, user?.id || null);

    if (signalHistory.length > 0) {
      handleUpdateHistoryOutcome(signalHistory[0].id, outcome);
    }
    setBreakAcknowledged(false);
    setIsLocked(false);
    setIsExpired(false);
    setSignal(null);
    onSignalOutput?.(null);
  };

  // Copy MT5 Trade Setup (never offered when lotSize <= 0)
  const handleCopyMt5Setup = () => {
    if (!signal?.mt5?.formattedText || (signal.mt5.recommendedLot ?? 0) <= 0) return;
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

  const resultView = useMemo(
    () =>
      buildResultView(signal, analysisProfile, {
        binaryBalance,
        binaryRiskPct,
        brokerPayoutPct: brokerMeta.payoutPct,
        nowMs: mt5NowMs,
        decimals: assetPipSpec.decimals,
        distanceUnit: assetPipSpec.distanceUnit,
        minActionableStrength,
      }),
    [
      signal,
      analysisProfile,
      binaryBalance,
      binaryRiskPct,
      brokerMeta.payoutPct,
      mt5NowMs,
      assetPipSpec.decimals,
      assetPipSpec.distanceUnit,
      minActionableStrength,
    ]
  );

  return (
    <div className="space-y-3.5" id="signal-engine-cockpit">
      {/* 1. COMPACT TOP STATUS BAR */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 shadow-xl font-mono text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isFeedActive ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
            <span className="font-bold text-white text-xs sm:text-sm truncate">
              {activeAsset?.name || 'EUR/USD'} &bull; {analysisMode === 'quick' ? 'Quick Trade' : 'MT5 Trade Plan'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="font-bold text-emerald-400">
              {isVIP ? 'VIP' : `${credits} CR`}
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
      </div>

      {/* 2. STEP 1 — PLATFORM / BROKER SELECTOR */}
      <div data-tour="mode-switcher" className="bg-slate-900 border border-slate-800 rounded-2xl p-3 shadow-lg space-y-2.5 font-mono">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="broker-platform-select" className="text-[10px] text-slate-400 uppercase tracking-wider font-bold flex items-center gap-1.5">
                <span>1. Broker / Platform</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                  analysisProfile === 'MT5'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                }`}>
                  {analysisProfile === 'MT5' ? 'MetaTrader 5' : 'Quick Trade'}
                </span>
              </label>

              {resolveBrokerDestinationUrl(currentPlatform.id, currentPlatform.referralUrl) && (
                <a
                  href={resolveBrokerDestinationUrl(currentPlatform.id, currentPlatform.referralUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold underline flex items-center gap-0.5"
                >
                  <span>Open {currentPlatform.name}</span>
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
                    {p.name} — {p.profile === 'MT5' ? 'MetaTrader 5 (Trade Plan)' : 'Quick Trade (Fixed Expiry)'}
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
          <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-1 pt-1 sm:pt-0 border-t sm:border-t-0 border-slate-800 shrink-0">
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
                  } catch (err) {
                    console.warn('[SignalEngine] Failed to save auto_scan preference:', err);
                  }
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
          </div>
        </div>

        {/* Auto-Scan Active Visual Countdown Banner */}
        {autoScanSecondsRemaining > 0 && (
          <div className="bg-amber-500/15 border border-amber-500/30 rounded-xl p-2 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-amber-300">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span className="font-bold">
                Auto-scanning… {autoScanAttempt + 1}/{MAX_AUTO_SCAN_ATTEMPTS} ({autoScanSecondsRemaining}s)
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
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* 3. STEP 2 — MODE-SPECIFIC INPUTS ONLY */}
      <div data-tour="timeframe-selector" className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2.5">
        {analysisMode === 'quick' ? (
          <>
            <div className="flex items-center justify-between gap-2 text-xs font-mono">
              <span className="font-bold text-white">2. Quick Trade — pick how long</span>
              <span className="text-[10px] text-emerald-400 font-bold bg-emerald-950/50 border border-emerald-500/30 px-2 py-0.5 rounded">
                {activeBinaryHorizonCfg.id === 'auto' ? 'Auto (1m–5m)' : activeBinaryHorizonCfg.id.toUpperCase()}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5" id="timeframe-grid">
              {BINARY_HORIZONS.map((opt) => {
                const isActive = opt.id === binaryHorizon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    id={`tf-btn-${opt.id}`}
                    onClick={() => setBinaryHorizon(opt.id)}
                    className={`py-2 px-2 rounded-xl text-xs font-mono transition-all flex flex-col items-center justify-center gap-0.5 text-center ${
                      isActive
                        ? 'bg-gradient-to-b from-slate-800 to-slate-900 border-2 border-emerald-400 text-emerald-300 font-black shadow-md shadow-emerald-500/20'
                        : 'bg-slate-950 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-[11px] font-black leading-tight">{opt.label}</span>
                    <span className="text-[9px] opacity-75 font-normal">{opt.sub}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400 font-sans leading-snug">
              How long until your trade closes. Shorter is faster and noisier, and leaves less time to place the trade.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 text-xs font-mono">
              <span className="font-bold text-white">2. Trade Plan — pick the chart and your risk</span>
              <span className="text-[10px] text-blue-300 font-bold bg-blue-950/50 border border-blue-500/30 px-2 py-0.5 rounded">
                {activeMt5HorizonCfg.sub}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2" id="timeframe-grid">
              {MT5_HORIZONS.map((opt) => {
                const isActive = opt.id === mt5Horizon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    id={`tf-btn-${opt.id}`}
                    onClick={() => setMt5Horizon(opt.id)}
                    className={`py-2 px-3 rounded-xl text-xs font-mono transition-all flex flex-col items-center justify-center gap-0.5 text-center ${
                      isActive
                        ? 'bg-gradient-to-b from-slate-800 to-slate-900 border-2 border-blue-400 text-blue-200 font-black shadow-md shadow-blue-500/20'
                        : 'bg-slate-950 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-xs font-black leading-tight">{opt.label}</span>
                    <span className="text-[10px] opacity-75 font-normal">{opt.sub}</span>
                  </button>
                );
              })}
            </div>

            {/* MT5 Account Risk Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 font-mono text-[10px]">
              <div>
                <span className="text-slate-400 block mb-1">Account Balance ({mt5AccountCurrency})</span>
                <div className="flex items-center gap-1">
                  {[100, 500, 1000, 5000, 10000].map((b) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => handleUpdateMt5Balance(b)}
                      className={`flex-1 py-1.5 rounded-lg text-center transition ${
                        mt5Balance === b ? 'bg-blue-500 text-white font-bold' : 'bg-slate-950 text-slate-400 border border-slate-800'
                      }`}
                    >
                      {b >= 1000 ? `${b / 1000}k` : b}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-slate-400 block mb-1">Risk per trade (% of balance)</span>
                <div className="flex items-center gap-1">
                  {[0.5, 1.0, 2.0, 3.0].map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => handleUpdateMt5RiskPct(r)}
                      className={`flex-1 py-1.5 rounded-lg text-center transition ${
                        mt5RiskPct === r ? 'bg-blue-500 text-white font-bold' : 'bg-slate-950 text-slate-400 border border-slate-800'
                      }`}
                    >
                      {r}%
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
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
                {analysisMode === 'quick' ? 'Auditing Tick & Candle Confluence' : 'Auditing Multi-Timeframe MT5 Candles'}
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
                {activeTrade.pipDiff > 0 ? `+${activeTrade.pipDiff}` : activeTrade.pipDiff} {formatDistanceUnitWord(activeTrade.pipDiff, assetPipSpec.distanceUnit)}
              </span>
            </div>
          </div>

          {activeTrade.status === 'IN_THE_MONEY' && !activeTrade.completed && (
            <button
              type="button"
              onClick={handleSafeCloseNow}
              className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black font-mono text-xs shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2 animate-pulse active:scale-98"
            >
              <span>⭐ LOCK PROFIT / SAFE CLOSE NOW ({activeTrade.pipDiff > 0 ? `+${activeTrade.pipDiff}` : activeTrade.pipDiff} {formatDistanceUnitWord(activeTrade.pipDiff, assetPipSpec.distanceUnit)})</span>
            </button>
          )}
        </div>
      )}

      {/* OTC Broker Warning Banner (Requirement #8) */}
      {isOtc && (
        <div className="bg-amber-950/40 border border-amber-500/50 rounded-2xl p-4 font-mono text-xs text-amber-200 flex items-start gap-3 shadow-xl">
          <span className="text-xl">⚠️</span>
          <div className="space-y-1">
            <div className="font-bold text-amber-300 uppercase tracking-wide">OTC Proprietary Broker Instrument</div>
            <p className="text-[11px] text-amber-100/90 leading-relaxed">
              OTC prices are set by your broker; we cannot analyse them. Please select a standardized market instrument (Forex, Crypto, or Commodities) from the asset picker.
            </p>
          </div>
        </div>
      )}

      {/* 3-Consecutive-Loss Take-a-Break Banner */}
      {isTakeABreakLocked && (
        <div className="bg-rose-950/50 border-2 border-rose-500/60 rounded-2xl p-4 font-mono text-xs space-y-3 shadow-2xl">
          <div className="flex items-start gap-3">
            <span className="text-xl">🛑</span>
            <div className="space-y-1">
              <div className="font-black text-rose-300 uppercase tracking-wider">
                Take a break &mdash; 3 Consecutive Losses Recorded
              </div>
              <p className="text-[11px] text-rose-100/90 leading-relaxed">
                Short-expiry binary payouts require discipline to protect capital during losing streaks. Step away from the screen for a few minutes and avoid increasing your stake size to chase losses.
              </p>
            </div>
          </div>
          <button
            type="button"
            id="btn-acknowledge-break"
            onClick={() => setBreakAcknowledged(true)}
            className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-rose-200 border border-rose-500/40 font-bold text-xs transition cursor-pointer"
          >
            Take a break acknowledged &mdash; Resume Scanning
          </button>
        </div>
      )}

      {/* 6. PRIMARY ANALYSIS CARD (BINARY QUICK TRADE vs MT5 TRADE PLAN) */}
      <div
        id="signal-display-container"
        data-tour="confluence-gate"
        className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-2xl relative overflow-hidden transition-all duration-300 space-y-3"
      >
        {/* Permanent Synthetic Indices Notice on Analysis Card */}
        {isSynthetic && (
          <div
            data-testid="synthetic-analysis-notice"
            className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-2.5 font-mono text-[11px] text-amber-200 flex items-start gap-2"
          >
            <span className="text-amber-400 shrink-0 font-bold">⚠️</span>
            <span className="leading-snug">{SYNTHETIC_INDICES_NOTICE}</span>
          </div>
        )}

        {!resultView || !signal ? (
          /* Standby State */
          <div className="text-center py-4 space-y-1.5">
            <h3 className="font-bold text-white text-xs sm:text-sm font-mono uppercase tracking-wide">
              {analysisMode === 'quick' ? 'Quick Trade Ready' : 'MT5 Trade Plan Ready'}
            </h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {analysisMode === 'quick'
                ? 'Tap Scan below for a CALL, PUT, or WAIT decision based on live candles and ticks.'
                : 'Tap Scan below for Entry, Stop-loss, TP1/TP2, Lot size, or WAIT.'}
            </p>
          </div>
        ) : resultView.kind === 'BLOCKED' ? (
          /* BLOCKED STATE */
          <div className="bg-rose-950/30 border border-rose-500/50 rounded-xl p-4 font-mono text-xs space-y-2 text-center">
            <div className="font-bold text-rose-300 text-sm">ANALYSIS PAUSED</div>
            <p className="text-slate-200 text-xs">{resultView.blockedReason}</p>
            <p className="text-[11px] text-slate-400">{resultView.plainLanguageReason}</p>
          </div>
        ) : resultView.kind === 'WAIT' ? (
          /* WAIT RESULT: Verdict, One Plain Reason, Next Check Window — Nothing Else */
          <div data-testid="wait-result-card" className="space-y-2.5">
            <div className="flex items-center gap-2.5">
              <span
                id="signal-direction-badge"
                className="text-base sm:text-lg font-black font-mono px-3.5 py-1.5 rounded-xl text-amber-200 bg-amber-500/20 border border-amber-500/40"
              >
                {resultView.verdict.badge}
              </span>
              <span className="text-xs font-mono text-slate-400">
                {signal.asset} &bull; {currentPlatform.name}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed font-medium">
              {resultView.reason}
            </p>
            <p className="text-xs font-mono text-amber-300/90">
              {resultView.checkAgainText}
            </p>
          </div>
        ) : resultView.kind === 'BINARY' ? (
          /* BINARY ("Quick Trade") ACTIONABLE RESULT */
          <div data-testid="binary-result-card" className="space-y-3">
            {/* 1. Verdict Block */}
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    id="signal-direction-badge"
                    className={`text-base sm:text-lg font-black font-mono px-3.5 py-1 rounded-xl shadow-lg ${
                      resultView.direction === 'CALL'
                        ? 'text-slate-950 bg-emerald-400 shadow-emerald-400/20'
                        : 'text-white bg-rose-500 shadow-rose-500/20'
                    }`}
                  >
                    {resultView.verdict.badge}
                  </span>
                  <span className="text-xs font-mono font-bold text-slate-300">
                    {signal.asset}
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-white font-medium leading-snug">
                  {resultView.verdict.plainSentence}
                </p>
              </div>
            </div>

            {/* 2. Single row of 3 key facts: Expiry, Enter within (live seconds), Suggested stake ($) */}
            <div className="grid grid-cols-3 gap-2 font-mono text-center">
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-2">
                <span className="text-[10px] text-slate-400 block">Expiry</span>
                <span className="text-xs sm:text-sm font-black text-cyan-300 block mt-0.5">
                  {resultView.keyFacts.expiryLabel}
                </span>
              </div>
              <div className={`bg-slate-950 border rounded-xl p-2 ${isExpired ? 'border-rose-500/50' : 'border-emerald-500/40'}`}>
                <span className="text-[10px] text-slate-400 block">Enter within</span>
                <span className={`text-xs sm:text-sm font-black block mt-0.5 tabular-nums ${isExpired ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {isExpired ? 'Expired' : `${Math.max(0, Math.ceil(freshnessSec))}s`}
                </span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-2">
                <span className="text-[10px] text-slate-400 block">Suggested stake</span>
                <span className="text-xs sm:text-sm font-black text-white block mt-0.5 tabular-nums">
                  ${resultView.keyFacts.suggestedStakeUsd.toFixed(2)}
                </span>
              </div>
            </div>

            {/* 3. Why (exactly 3 bullets, <= 90 chars each) */}
            <div className="space-y-1">
              <div className="text-[11px] font-mono font-bold text-slate-300 uppercase">Why</div>
              <ul className="space-y-1 text-xs text-slate-300">
                {resultView.whyBullets.map((bullet, idx) => (
                  <li key={idx} className="flex items-start gap-2 leading-snug">
                    <span className="text-emerald-400 font-bold shrink-0">&bull;</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 4. One strength chip (ONLY when signal.direction !== 'WAIT') + ONE break-even line */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] font-mono">
              {signal.direction !== 'WAIT' && (
                <span
                  data-testid="single-strength-chip"
                  className="inline-flex items-center gap-1.5 bg-slate-950 border border-slate-700 px-2.5 py-1 rounded-lg text-slate-300"
                >
                  <span>Setup strength (not a win probability):</span>
                  <strong className={
                    resultView.strengthChip.strength === 'High'
                      ? 'text-emerald-400'
                      : resultView.strengthChip.strength === 'Medium'
                      ? 'text-amber-300'
                      : 'text-slate-200'
                  }>
                    {resultView.strengthChip.strength}
                  </strong>
                </span>
              )}
              <span className="text-cyan-300">
                {resultView.breakEvenLine}
              </span>
            </div>

            {/* 5. One short risk line */}
            <p className="text-[11px] text-slate-400 leading-snug">
              {resultView.riskLine}
            </p>

            {/* 6. More details accordion (collapsed by default) */}
            <div className="border-t border-slate-800 pt-2">
              <button
                type="button"
                aria-expanded={isMoreDetailsOpen}
                onClick={() => setIsMoreDetailsOpen((prev) => !prev)}
                className="w-full flex items-center justify-between py-1.5 px-2.5 rounded-xl bg-slate-950 hover:bg-slate-800/70 border border-slate-800 text-xs font-mono font-semibold text-slate-200 transition cursor-pointer"
              >
                <span>More details</span>
                <span className="text-slate-400">{isMoreDetailsOpen ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {isMoreDetailsOpen && (
                <div className="mt-3 space-y-3">
                  {(signal.expiry || signal.timeframe) === '1m' && (
                    <div
                      data-testid="binary-1m-timing-notice"
                      className="px-3 py-2 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-200 font-mono text-[11px] font-semibold"
                    >
                      Open your trade within 6 seconds. 1-minute trades leave little room for delay.
                    </div>
                  )}

                  {/* Indicator Audit & Entry Quote */}
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <span className="text-slate-500 block">Entry Quote</span>
                        <span className="text-white font-bold">
                          {typeof signal.entryPrice === 'number' ? signal.entryPrice.toFixed(assetPipSpec.decimals) : currentPrice}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">RSI (14)</span>
                        <span className="text-slate-200 font-bold">{liveAudit.rsi.toFixed(1)}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">EMA Trend</span>
                        <span className="text-slate-200 font-bold">{liveAudit.emaTrend}</span>
                      </div>
                    </div>
                    <div className="text-slate-300 border-t border-slate-800 pt-1.5">
                      Last 60 seconds of ticks:{' '}
                      <strong className="text-emerald-400">{last60sTickStats.buyPct}% up</strong>,{' '}
                      <strong className="text-rose-400">{last60sTickStats.sellPct}% down</strong>{' '}
                      <span className="text-slate-400">(not a forecast)</span>
                    </div>
                  </div>

                  {/* Stake Calculator & 1%-2% Risk Cap */}
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300 font-bold text-[11px]">Stake calculator (1%–2% cap):</span>
                      <span className="text-emerald-400 font-black text-sm">
                        ${resultView.keyFacts.suggestedStakeUsd.toFixed(2)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div>
                        <label htmlFor="binary-balance-input" className="text-slate-400 block mb-1">
                          Account Balance ($)
                        </label>
                        <input
                          id="binary-balance-input"
                          type="number"
                          min="1"
                          value={binaryBalance}
                          onChange={(e) => setBinaryBalance(Math.max(0, Number(e.target.value)))}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 text-xs text-white font-bold focus:border-emerald-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <span className="text-slate-400 block mb-1">Stake Risk Cap</span>
                        <div className="grid grid-cols-2 gap-1.5">
                          {[1, 2].map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => setBinaryRiskPct(pct)}
                              className={`py-1.5 rounded-lg font-bold transition ${
                                binaryRiskPct === pct
                                  ? 'bg-emerald-500 text-slate-950'
                                  : 'bg-slate-900 text-slate-300 border border-slate-800'
                              }`}
                            >
                              {pct}% (${((Math.max(0, binaryBalance) * pct) / 100).toFixed(2)})
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Broker & Live Delta Tracker CTAs */}
                  {!activeTrade && !isExpired && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono">
                      {resolveBrokerDestinationUrl(currentPlatform.id, currentPlatform.referralUrl) && (
                        <a
                          href={resolveBrokerDestinationUrl(currentPlatform.id, currentPlatform.referralUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-xs transition flex items-center justify-center gap-1.5"
                        >
                          <span>TRADE ON {currentPlatform.name.toUpperCase()}</span>
                          <span>↗</span>
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={handleExecuteTrade}
                        className="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-500/40 font-black text-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <span>TRACK LIVE DELTA ({resultView.keyFacts.expiryLabel})</span>
                        <span>⚡</span>
                      </button>
                    </div>
                  )}

                  {/* Market Context (inside collapsed More details) */}
                  <MarketContextPanel context={marketContext} isLoading={isLoadingContext} />
                </div>
              )}
            </div>
          </div>
        ) : (
          /* MT5 ("Trade Plan") ACTIONABLE RESULT */
          <div data-testid="mt5-result-card" className="space-y-3">
            {/* Prominent Small Account Warning Box at TOP (when lotSize === 0) */}
            {resultView.accountTooSmallWarning && (
              <div
                data-testid="mt5-account-too-small-warning"
                className="p-3 rounded-xl bg-amber-950/50 border-2 border-amber-500/60 text-amber-200 font-mono text-xs flex items-start gap-2.5 shadow-lg"
              >
                <span className="text-base shrink-0">⚠️</span>
                <span className="font-bold leading-snug">{resultView.accountTooSmallWarning}</span>
              </div>
            )}

            {/* 1. Verdict Block */}
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  id="signal-direction-badge"
                  className={`text-base sm:text-lg font-black font-mono px-3.5 py-1 rounded-xl shadow-lg ${
                    resultView.direction === 'BUY'
                      ? 'text-slate-950 bg-emerald-400 shadow-emerald-400/20'
                      : 'text-white bg-rose-500 shadow-rose-500/20'
                  }`}
                >
                  {resultView.verdict.badge}
                </span>
                <span className="text-xs font-mono font-bold text-slate-300">
                  {signal.asset} &bull; {signal.timeframe.toUpperCase()}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-white font-medium leading-snug">
                {resultView.verdict.plainSentence}
              </p>
            </div>

            {/* 2. Order Ticket Card (Exact fields to type into MT5) */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2.5 font-mono">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs tabular-nums">
                <div>
                  <span className="text-[10px] text-slate-400 block">Entry</span>
                  <span className="font-bold text-white">{resultView.orderTicket.entryText}</span>
                </div>
                <div>
                  <span className="text-[10px] text-rose-400 block">Stop-loss</span>
                  <span className="font-bold text-rose-300">{resultView.orderTicket.stopLossPriceText}</span>
                  <span className="text-[10px] text-rose-400/80 block">{resultView.orderTicket.stopLossDistanceText}</span>
                </div>
                <div>
                  <span className="text-[10px] text-emerald-400 block">TP1</span>
                  <span className="font-bold text-emerald-300">{resultView.orderTicket.tp1PriceText}</span>
                  <span className="text-[10px] text-emerald-400/80 block">{resultView.orderTicket.tp1DistanceText}</span>
                </div>
                <div>
                  <span className="text-[10px] text-teal-400 block">TP2</span>
                  <span className="font-bold text-teal-300">{resultView.orderTicket.tp2PriceText}</span>
                  <span className="text-[10px] text-teal-400/80 block">{resultView.orderTicket.tp2DistanceText}</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-xs tabular-nums">
                <div>
                  <span className="text-[10px] text-slate-400 block">Lot size</span>
                  <span className="font-bold text-white">{resultView.orderTicket.lotSizeText}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Risk in money</span>
                  <span className="font-bold text-amber-300">{resultView.orderTicket.riskMoneyText}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Reward:Risk</span>
                  <span className="font-bold text-emerald-400">{resultView.orderTicket.rewardRiskText}</span>
                </div>
              </div>

              {resultView.orderTicket.canCopyOrder ? (
                <button
                  type="button"
                  onClick={handleCopyMt5Setup}
                  className="w-full py-2.5 px-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
                >
                  {copiedMt5Text ? <span>✓ Copied order</span> : <span>{resultView.orderTicket.primaryButtonLabel}</span>}
                </button>
              ) : (
                <div
                  data-testid="mt5-copy-disabled-note"
                  className="w-full py-2.5 px-3 bg-slate-900 border border-slate-700 text-slate-400 font-mono font-semibold text-xs rounded-xl text-center"
                >
                  {resultView.orderTicket.cannotCopyReason || "Can't copy: lot size is below your broker's minimum"}
                </div>
              )}
            </div>

            {/* 3. One Validity Line */}
            <p data-testid="mt5-validity-line" className="text-xs font-mono text-blue-200 leading-snug">
              {resultView.validityLine}
            </p>

            {/* 4. Why (3 bullets including higher-timeframe bias) */}
            <div className="space-y-1">
              <div className="text-[11px] font-mono font-bold text-slate-300 uppercase">Why</div>
              <ul className="space-y-1 text-xs text-slate-300">
                {resultView.whyBullets.map((bullet, idx) => (
                  <li key={idx} className="flex items-start gap-2 leading-snug">
                    <span className="text-blue-400 font-bold shrink-0">&bull;</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 5. Single strength chip (ONLY when signal.direction !== 'WAIT') */}
            {signal.direction !== 'WAIT' && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                <span
                  data-testid="single-strength-chip"
                  className="inline-flex items-center gap-1.5 bg-slate-950 border border-slate-700 px-2.5 py-1 rounded-lg text-slate-300"
                >
                  <span>Setup strength (not a win probability):</span>
                  <strong className={
                    resultView.strengthChip.strength === 'High'
                      ? 'text-emerald-400'
                      : resultView.strengthChip.strength === 'Medium'
                      ? 'text-amber-300'
                      : 'text-slate-200'
                  }>
                    {resultView.strengthChip.strength}
                  </strong>
                </span>
              </div>
            )}

            {/* 6. More details accordion (collapsed by default) */}
            <div className="border-t border-slate-800 pt-2">
              <button
                type="button"
                aria-expanded={isMoreDetailsOpen}
                onClick={() => setIsMoreDetailsOpen((prev) => !prev)}
                className="w-full flex items-center justify-between py-1.5 px-2.5 rounded-xl bg-slate-950 hover:bg-slate-800/70 border border-slate-800 text-xs font-mono font-semibold text-slate-200 transition cursor-pointer"
              >
                <span>More details</span>
                <span className="text-slate-400">{isMoreDetailsOpen ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {isMoreDetailsOpen && (
                <div className="mt-3 space-y-3">
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] space-y-2 text-slate-300">
                    <div className="text-cyan-300 font-semibold">
                      {resultView.moreDetails.needsAtLeastWinRateLine}
                    </div>
                    <div>
                      <span className="text-slate-400 font-bold">Trade management: </span>
                      <span>{resultView.moreDetails.tradeManagement}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-bold">Spread &amp; session: </span>
                      <span>{resultView.moreDetails.spreadAndSessionNotes}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-bold">Invalidation rule: </span>
                      <span>{resultView.moreDetails.invalidationRule}</span>
                    </div>
                    {resultView.moreDetails.accountSizingWarning && (
                      <div className="p-2 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-300">
                        ⚠️ {resultView.moreDetails.accountSizingWarning}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={handleCopyMt5Json}
                      className="py-1.5 px-3 bg-slate-900 hover:bg-slate-800 text-slate-200 font-bold text-[11px] rounded-lg border border-slate-700 transition cursor-pointer"
                    >
                      {copiedMt5Json ? '✓ Copied EA JSON' : 'Copy EA JSON'}
                    </button>
                  </div>

                  {/* Market Context (inside collapsed More details) */}
                  <MarketContextPanel context={marketContext} isLoading={isLoadingContext} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Hidden compatibility marker note for Stage 4F feed audit (kept concise only on actionable or non-WAIT audit, omitted on pure WAIT per Krug rule) */}
        {signal && resultView?.kind !== 'WAIT' && (
          <div className="pt-2 border-t border-slate-800/80 text-[10px] font-mono text-slate-400 flex flex-wrap items-center justify-between gap-2">
            <span>
              {analysisMode === 'quick'
                ? "Prices from Deriv public feed; broker fills may differ."
                : "Candles from Deriv public feed; MT5 broker spread may differ."}
            </span>
            {analysisMode === 'quick' && !isMoreDetailsOpen && (
              <span className="text-slate-500">
                Last 60 seconds of ticks: {last60sTickStats.buyPct}% up, {last60sTickStats.sellPct}% down (not a forecast)
              </span>
            )}
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
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+56px)] md:static z-20 pt-2 pb-2 bg-slate-950/90 md:bg-transparent backdrop-blur-md md:backdrop-blur-none -mx-1 px-1">
        <button
          type="button"
          id="btn-analyse-trigger"
          data-tour="generate-signal"
          onClick={handleTriggerAnalysis}
          disabled={
            isLocked ||
            isRechecking ||
            Boolean(activeTrade) ||
            isOtc ||
            isTakeABreakLocked ||
            isFeedBlockedForProfile ||
            (analysisProfile === 'BINARY_QUICK' && safeTicks.length < 5)
          }
          className={`w-full py-3.5 px-4 rounded-2xl font-black font-mono text-xs sm:text-sm uppercase tracking-wider shadow-2xl transition-all duration-200 flex items-center justify-center gap-2 ${
            isOtc
              ? 'bg-amber-950/40 text-amber-300 border border-amber-500/50 cursor-not-allowed opacity-90'
              : isTakeABreakLocked
              ? 'bg-rose-950/40 text-rose-300 border border-rose-500/50 cursor-not-allowed opacity-90'
              : feedHealthStatus === 'MARKET_CLOSED'
              ? 'bg-amber-950/30 text-amber-300 border border-amber-600/40 cursor-not-allowed'
              : isFeedBlockedForProfile
              ? 'bg-rose-950/40 text-rose-300 border border-rose-500/50 cursor-not-allowed opacity-80'
              : analysisProfile === 'BINARY_QUICK' && safeTicks.length < 5
              ? 'bg-slate-800 text-slate-400 border border-slate-700 cursor-not-allowed'
              : isLocked || Boolean(activeTrade)
              ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
              : isRechecking
              ? 'bg-emerald-500/20 text-emerald-300 border-2 border-emerald-400 cursor-wait'
              : analysisMode === 'quick'
              ? 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 shadow-emerald-500/30 active:scale-98 cursor-pointer'
              : 'bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-400 hover:from-blue-400 hover:to-indigo-400 text-white shadow-blue-500/30 active:scale-98 cursor-pointer'
          }`}
        >
          {isOtc ? (
            <span>🚫 OTC ASSET — PROPRIETARY BROKER PRICING</span>
          ) : isTakeABreakLocked ? (
            <span>🛑 TAKE A BREAK REQUIRED ABOVE TO RESUME</span>
          ) : feedHealthStatus === 'MARKET_CLOSED' ? (
            <span>🏛️ FOREX MARKET CLOSED (SWITCH TO 24/7 ASSET)</span>
          ) : isFeedBlockedForProfile ? (
            feedHealthStatus === 'IDLE' ? (
              <span>Idle &mdash; pick an asset</span>
            ) : feedHealthStatus === 'DELAYED' ? (
              <span>⏳ FEED QUIET — BINARY REQUIRES LIVE TICKS</span>
            ) : feedHealthStatus === 'OFFLINE' ? (
              <span>⚠️ FEED OFFLINE — RETRYING...</span>
            ) : (
              <span>⚡ CONNECTING TO LIVE FEED...</span>
            )
          ) : analysisProfile === 'BINARY_QUICK' && safeTicks.length < 5 ? (
            <span>⏳ COLLECTING LIVE TICKS ({safeTicks.length}/5)...</span>
          ) : isRechecking ? (
            <>
              <svg className="animate-spin h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>AUDITING MARKET DATA...</span>
            </>
          ) : isLocked ? (
            <span>🔒 AWAITING SESSION OUTCOME FEEDBACK</span>
          ) : activeTrade ? (
            <span>⚡ TRADE ACTIVE — TRACKING IN-FLIGHT DELTA</span>
          ) : analysisMode === 'quick' ? (
            <>
              <span>⚡ SCAN BINARY SIGNAL</span>
              <span className="text-xs opacity-75">
                ({activeAsset?.name || 'EUR/USD'} &bull; {binaryHorizon === 'auto' ? 'Auto' : binaryHorizon.toUpperCase()})
              </span>
            </>
          ) : (
            <>
              <span>📊 SCAN MT5 SETUP</span>
              <span className="text-xs opacity-75">
                ({activeAsset?.name || 'EUR/USD'} &bull; {mt5Horizon === 'M15' ? 'Intraday M15' : 'Swing H1'})
              </span>
            </>
          )}
        </button>
      </div>

      {/* 9. SIGNAL HISTORY TABLE */}
      <SignalHistory signals={signalHistory} activeAsset={activeAsset} onUpdateOutcome={handleUpdateHistoryOutcome} />
    </div>
  );
}
