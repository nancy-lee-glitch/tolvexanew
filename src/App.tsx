import React, { useState, useEffect } from 'react';
import type {
  AssetConfig,
  SignalData,
  SessionStats,
  UserProfile,
  BlogArticle,
  PageView,
  AuthModalMode,
  SiteSettings,
  ExternalBrokerConfig,
  BrokersSettings,
} from './types.ts';
import { MarketRadar } from './components/MarketRadar.tsx';
import { LiveTicker, ASSETS } from './components/LiveTicker.tsx';
import { SignalEngine } from './components/SignalEngine.tsx';
import { RiskAdvisor } from './components/RiskAdvisor.tsx';
import { CryptoCheckout } from './components/CryptoCheckout.tsx';
import { AdminCenter } from './components/AdminCenter.tsx';
import { LandingPage } from './components/LandingPage.tsx';
import { BlogSection } from './components/BlogSection.tsx';
import { AboutPage } from './components/AboutPage.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { VipSafeRadarModal } from './components/VipSafeRadarModal.tsx';
import { GuidedTourCoachMark } from './components/GuidedTourCoachMark.tsx';
import { PWAInstallButton } from './components/PWAInstallButton.tsx';
import { FloatingSupportFAB } from './components/FloatingSupportFAB.tsx';
import {
  getSiteSettings,
  fetchRemoteSiteSettings,
  applyDocumentBranding,
  getBrokerConfig,
  fetchRemoteBrokerConfig,
  getBrokersSettings,
  fetchRemoteBrokersSettings,
} from './utils/siteConfigManager.ts';
import {
  sendSupabasePresence,
  getCurrentSupabaseUser,
  getSupabaseClient,
  deductCreditWithSupabase,
} from './utils/supabaseClient.ts';

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageView>('landing');
  const [authModalMode, setAuthModalMode] = useState<AuthModalMode>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<BlogArticle | null>(null);
  const [isVipRadarOpen, setIsVipRadarOpen] = useState<boolean>(false);
  const [isTutorialOpen, setIsTutorialOpen] = useState<boolean>(false);
  const [isMobileMoreOpen, setIsMobileMoreOpen] = useState<boolean>(false);

  // Broker & Referral Integration State
  const [brokersSettings, setBrokersSettings] = useState<BrokersSettings>(getBrokersSettings());

  useEffect(() => {
    fetchRemoteBrokersSettings().then((cfg) => {
      if (cfg) setBrokersSettings(cfg);
    });
    const handleBrokersChanged = (e: any) => {
      if (e.detail) setBrokersSettings(e.detail);
    };
    window.addEventListener('pulsetrade_brokers_changed', handleBrokersChanged);
    return () => window.removeEventListener('pulsetrade_brokers_changed', handleBrokersChanged);
  }, []);

  // Check secret URL param ?view=admin or ?view=pricing on initial load
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const viewParam = params.get('view');
      if (viewParam === 'admin') {
        setCurrentPage('admin');
      } else if (viewParam === 'pricing') {
        setCurrentPage('pricing');
      }
    }
  }, []);

  // Guided coach-mark tour trigger on first visit to cockpit
  useEffect(() => {
    try {
      const completed = localStorage.getItem('pulsetrade_tour_completed');
      if (!completed && currentPage === 'cockpit') {
        setIsTutorialOpen(true);
      }
    } catch {}
  }, [currentPage]);

  const handleCloseTutorial = () => {
    setIsTutorialOpen(false);
    try {
      localStorage.setItem('pulsetrade_tour_completed', 'true');
    } catch {}
  };

  // Dynamic Branding & Platform Settings
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(getSiteSettings());
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);

  // Trading engine states
  const [activeAsset, setActiveAsset] = useState<AssetConfig>(ASSETS[0]);
  const [currentPrice, setCurrentPrice] = useState<number>(1.08542);
  const [liveTicks, setLiveTicks] = useState<number[]>([]);
  const [credits, setCredits] = useState<number>(10);
  const [isVIP, setIsVIP] = useState<boolean>(false);
  const [onlineUsers, setOnlineUsers] = useState<number>(1);

  const [stats, setStats] = useState<SessionStats>({
    total: 0,
    wins: 0,
    losses: 0,
    winRate: 85.7,
  });

  // Check initial user authentication & VIP 30-day status via Supabase Auth
  useEffect(() => {
    let isMounted = true;

    const checkAuthStatus = async () => {
      try {
        const supaUser = await getCurrentSupabaseUser();
        if (isMounted && supaUser) {
          setUser(supaUser);
          setCredits(supaUser.credits);
          setIsVIP(Boolean(supaUser.is_vip));
          return;
        }
      } catch (err) {
        console.warn('[Supabase Auth Bootstrap]', err);
      }
    };

    checkAuthStatus();

    // Listen to Supabase Auth state changes across tabs/devices in real time
    const client = getSupabaseClient();
    if (client) {
      const { data: authListener } = client.auth.onAuthStateChange(async (event, session) => {
        if (!isMounted) return;
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          if (session?.user) {
            const freshUser = await getCurrentSupabaseUser();
            if (isMounted && freshUser) {
              setUser(freshUser);
              setCredits(freshUser.credits);
              setIsVIP(Boolean(freshUser.is_vip));
            }
          }
        } else if (event === 'SIGNED_OUT') {
          setUser(null);
          setCredits(10);
          setIsVIP(false);
        }
      });

      return () => {
        isMounted = false;
        authListener?.subscription.unsubscribe();
      };
    }

    return () => {
      isMounted = false;
    };
  }, []);

  // Live dynamic presence tracking: connects to Supabase active_sessions (100% Genuine)
  useEffect(() => {
    let sessionId = '';
    try {
      sessionId = localStorage.getItem('pulsetrade_session_id') || '';
      if (!sessionId) {
        sessionId = 'sess_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
        localStorage.setItem('pulsetrade_session_id', sessionId);
      }
    } catch {
      sessionId = 'sess_' + Date.now();
    }

    const fetchHeartbeat = async () => {
      try {
        const presenceCount = await sendSupabasePresence(sessionId, user?.id || null, activeAsset.symbol);
        if (typeof presenceCount === 'number' && presenceCount > 0) {
          setOnlineUsers(presenceCount);
        }
      } catch {
        // Silently handled
      }
    };

    fetchHeartbeat();
    const interval = setInterval(fetchHeartbeat, 10000);
    return () => clearInterval(interval);
  }, [user?.id, activeAsset.symbol]);

  // Synchronize dynamic site settings & branding
  useEffect(() => {
    fetchRemoteSiteSettings().then((s) => {
      setSiteSettings(s);
      applyDocumentBranding(s);
    });

    const handleSettingsChange = (e: any) => {
      if (e.detail) {
        setSiteSettings(e.detail);
        applyDocumentBranding(e.detail);
      }
    };

    window.addEventListener('pulsetrade_settings_changed', handleSettingsChange as EventListener);
    return () => window.removeEventListener('pulsetrade_settings_changed', handleSettingsChange as EventListener);
  }, []);

  // Handle credit deduction per signal in database
  const handleDeductCredit = async (): Promise<boolean> => {
    if (isVIP || (user && user.is_vip)) return true;
    if (credits <= 0) {
      setCurrentPage('pricing');
      return false;
    }

    if (user) {
      const res = await deductCreditWithSupabase(user);
      if (res.success) {
        setCredits(res.credits);
        setUser({ ...user, credits: res.credits });
        return true;
      } else {
        setCurrentPage('pricing');
        return false;
      }
    }

    // Guest trader deduction
    setCredits((c) => Math.max(0, c - 1));
    return true;
  };

  const handleLogOutcome = (outcome: 'WIN' | 'LOSS', _signal: SignalData) => {
    setStats((prev) => {
      const wins = outcome === 'WIN' ? prev.wins + 1 : prev.wins;
      const losses = outcome === 'LOSS' ? prev.losses + 1 : prev.losses;
      const total = wins + losses;
      const winRate = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 85.7;
      return { total, wins, losses, winRate };
    });
  };

  const handleCreditsPurchased = (added: number) => {
    setCredits((prev) => prev + added);
    if (user) {
      setUser({ ...user, credits: user.credits + added });
    }
    setCurrentPage('cockpit');
  };

  const handleVipPurchased = () => {
    setIsVIP(true);
    if (user) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 30);
      setUser({
        ...user,
        is_vip: true,
        vip_days_left: 30,
        vip_hours_left: 0,
        vip_seconds_left: 30 * 86400,
        vip_expires_at: expiry.toISOString(),
      });
    }
    setCurrentPage('cockpit');
  };

  const handleUserUpdated = (updatedUser: UserProfile | null) => {
    setUser(updatedUser);
    if (updatedUser) {
      setCredits(updatedUser.credits);
      setIsVIP(Boolean(updatedUser.is_vip));
      // Auto-route to Trading Cockpit as default post-login destination
      setCurrentPage('cockpit');
    } else {
      setCredits(10);
      setIsVIP(false);
    }
  };

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-950 text-slate-100 font-sans antialiased selection:bg-emerald-500 selection:text-slate-950 flex flex-col justify-between">
      {/* Top Announcement Banner (Configurable in Admin) */}
      {siteSettings.bannerEnabled && siteSettings.bannerText && !bannerDismissed && (
        <div className="bg-gradient-to-r from-amber-500/20 via-emerald-500/20 to-amber-500/20 border-b border-amber-500/30 px-3 py-1.5 text-xs font-mono flex items-center justify-between text-amber-200">
          <div className="max-w-6xl mx-auto flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span className="font-bold truncate">{siteSettings.bannerText}</span>
          </div>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            className="text-amber-400 hover:text-white shrink-0 px-2 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Floating Market Radar */}
      <MarketRadar />

      {/* Global Navigation Header */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-3.5 sm:px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          {/* Logo & Brand Identity */}
          <div
            onClick={() => setCurrentPage('landing')}
            className="flex items-center gap-2.5 cursor-pointer select-none group"
          >
            {siteSettings.logoUrl ? (
              <div className="w-9 h-9 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center overflow-hidden p-1 shadow-lg shadow-emerald-500/10 group-hover:scale-105 transition">
                <img
                  src={siteSettings.logoUrl}
                  alt={siteSettings.siteName}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : (
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-black shadow-lg shadow-emerald-500/20 group-hover:scale-105 transition">
                {siteSettings.logoIcon === 'activity' ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                ) : siteSettings.logoIcon === 'shield' ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                ) : siteSettings.logoIcon === 'trending' ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-black text-sm sm:text-base font-mono tracking-wider text-white">
                  {siteSettings.siteName}
                </span>
                {siteSettings.badgeText && (
                  <span className="text-[9px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.2 rounded font-bold hidden sm:inline">
                    {siteSettings.badgeText}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>{onlineUsers} Active Trader{onlineUsers === 1 ? '' : 's'} Online</span>
              </div>
            </div>
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden lg:flex items-center gap-1 font-mono text-xs">
            <button
              type="button"
              onClick={() => setCurrentPage('landing')}
              className={`px-3 py-1.5 rounded-lg transition ${
                currentPage === 'landing' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage('cockpit')}
              className={`px-3 py-1.5 rounded-lg transition ${
                currentPage === 'cockpit' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Trading Cockpit
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedArticle(null);
                setCurrentPage('blog');
              }}
              className={`px-3 py-1.5 rounded-lg transition ${
                currentPage === 'blog' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Blog &amp; SEO
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage('about')}
              className={`px-3 py-1.5 rounded-lg transition ${
                currentPage === 'about' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              About &amp; Science
            </button>
            <button
              type="button"
              data-tour="pricing-btn"
              onClick={() => setCurrentPage('pricing')}
              className={`px-3 py-1.5 rounded-lg transition ${
                currentPage === 'pricing' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              VIP &amp; Pricing
            </button>
          </nav>

          {/* User Auth & Actions Controls */}
          {/* User Auth & Actions Controls */}
          <div data-tour="credits-control" className="flex items-center gap-2 font-mono shrink-0">
            {/* External Partner Broker CTAs (Desktop only) */}
            {brokersSettings.brokers.deriv.enabled && brokersSettings.brokers.deriv.referralUrl && (
              <a
                href={brokersSettings.brokers.deriv.referralUrl}
                target={brokersSettings.brokers.deriv.openInNewTab ? '_blank' : '_self'}
                rel="noopener noreferrer"
                className="hidden lg:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white font-black text-xs transition shadow-md shadow-rose-500/20"
                title={brokersSettings.brokers.deriv.label || 'Open Deriv'}
              >
                <span>⚡</span>
                <span>{brokersSettings.brokers.deriv.label || 'Open Deriv'}</span>
                <span className="text-[10px]">↗</span>
              </a>
            )}

            {brokersSettings.brokers.expertOption.enabled && brokersSettings.brokers.expertOption.referralUrl && (
              <a
                href={brokersSettings.brokers.expertOption.referralUrl}
                target={brokersSettings.brokers.expertOption.openInNewTab ? '_blank' : '_self'}
                rel="noopener noreferrer"
                className="hidden lg:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 text-white font-black text-xs transition shadow-md shadow-blue-500/20"
                title={brokersSettings.brokers.expertOption.label || 'Open ExpertOption'}
              >
                <span>⚡</span>
                <span>{brokersSettings.brokers.expertOption.label || 'Open ExpertOption'}</span>
                <span className="text-[10px]">↗</span>
              </a>
            )}

            {/* PWA In-App Install Button (Desktop/Tablet) */}
            <div className="hidden sm:block">
              <PWAInstallButton />
            </div>

            {/* Interactive Guided Tour (Desktop/Tablet; lives under More on mobile) */}
            <button
              type="button"
              data-tour="help-btn"
              onClick={() => setIsTutorialOpen(true)}
              className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-700/80 hover:border-slate-600 text-slate-300 hover:text-white text-xs font-mono transition"
              title="Interactive Step-by-Step Guided Tour"
            >
              <span>💡</span>
              <span>Tour</span>
            </button>

            {user ? (
              <div className="flex items-center gap-2">
                {/* Admin Portal Button - Strictly visible ONLY to Master Admin */}
                {user.role === 'ADMIN' && (
                  <button
                    type="button"
                    onClick={() => setCurrentPage('admin')}
                    className={`flex items-center gap-1 px-2 py-1 rounded-xl font-bold text-xs transition shadow-sm ${
                      currentPage === 'admin'
                        ? 'bg-amber-400 text-slate-950 shadow-amber-500/20'
                        : 'bg-amber-500/20 border border-amber-500/50 text-amber-300 hover:bg-amber-500/30'
                    }`}
                    title="Master Admin Dashboard"
                  >
                    <span>👑</span>
                    <span className="hidden sm:inline">Admin</span>
                  </button>
                )}

                {/* VIP 30-Day Protected Status or Credits Remaining */}
                {user.is_vip ? (
                  <button
                    type="button"
                    data-tour="credits-badge"
                    onClick={() => setAuthModalMode('profile')}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-amber-500/20 border border-amber-500/50 text-amber-300 text-xs font-bold shadow-md shadow-amber-950/40 hover:bg-amber-500/30 transition min-h-[34px]"
                    title={`Strict 30-Day Window: ${user.vip_days_left}d ${user.vip_hours_left}h remaining`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                    <span>★ VIP {user.vip_days_left}d</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    data-tour="credits-badge"
                    onClick={() => setCurrentPage('pricing')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-emerald-500/40 text-emerald-400 text-xs font-bold hover:bg-slate-850 transition shadow-sm min-h-[34px]"
                    title="Available Trading Credits — Tap to top-up"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                    <span>{credits} Credits</span>
                    <span className="text-[10px] text-emerald-500 font-black">+</span>
                  </button>
                )}
              </div>
            ) : (
              /* Logged-OUT header: Show ONLY Logo + Log In (No Get Started in top bar) */
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAuthModalMode('login')}
                  className="px-3.5 py-1.5 text-xs text-slate-200 hover:text-white font-bold transition rounded-xl bg-slate-900 border border-slate-700/80 hover:border-slate-600 min-h-[34px] cursor-pointer"
                >
                  Log In
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Responsive View Container: full-bleed on mobile (360-430px) with bottom nav clearance */}
      <main className="flex-1 w-full max-w-none md:max-w-6xl mx-0 md:mx-auto px-2.5 sm:px-4 py-2 sm:py-4 pb-28 md:pb-6 overflow-visible">
        {/* VIEW 1: LANDING PAGE */}
        {currentPage === 'landing' && (
          <LandingPage
            user={user}
            onGetStarted={() => setAuthModalMode('register')}
            onOpenLogin={() => setAuthModalMode('login')}
            onLaunchCockpit={() => setCurrentPage('cockpit')}
            onSelectArticle={(article) => {
              setSelectedArticle(article);
              setCurrentPage('blog');
            }}
            onNavigateToPricing={() => setCurrentPage('pricing')}
            onNavigateToAbout={() => setCurrentPage('about')}
          />
        )}

        {/* VIEW 2: TRADING COCKPIT (The Mobile-First Cockpit) */}
        {currentPage === 'cockpit' && (
          <div className="max-w-xl mx-auto space-y-3.5 animate-in fade-in duration-200">
            {/* Quick Context Bar */}
            <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-2xl px-4 py-2.5 font-mono text-xs">
              <div className="flex items-center gap-2 text-slate-300">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-bold text-white">Live Execution Cockpit</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Balance:</span>
                <span className="font-black text-emerald-400 font-mono">
                  {isVIP || user?.is_vip ? 'UNLIMITED' : `${credits} CR`}
                </span>
                {!isVIP && !user?.is_vip && (
                  <button
                    type="button"
                    onClick={() => setCurrentPage('pricing')}
                    className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold hover:bg-emerald-500/30"
                  >
                    + Top-Up
                  </button>
                )}
              </div>
            </div>

            {/* Deriv WebSocket Ticker & Asset Switcher */}
            <LiveTicker
              activeAsset={activeAsset}
              onAssetChange={setActiveAsset}
              onPriceUpdate={setCurrentPrice}
              onTicksUpdate={setLiveTicks}
              isVIP={isVIP || Boolean(user?.is_vip)}
              onOpenVipRadar={() => setIsVipRadarOpen(true)}
            />

            {/* Multi-Timeframe Algorithmic Signal Engine & Lockout Loop */}
            <SignalEngine
              activeAsset={activeAsset}
              currentPrice={currentPrice}
              credits={credits}
              isVIP={isVIP || Boolean(user?.is_vip)}
              onDeductCredit={handleDeductCredit}
              onLogOutcome={handleLogOutcome}
              stats={stats}
              ticks={liveTicks}
              user={user}
              onOpenAuth={(mode) => setAuthModalMode(mode)}
              onOpenVipRadar={() => setIsVipRadarOpen(true)}
            />

            {/* Risk Advisor & 2% Stake Protection */}
            <RiskAdvisor />
          </div>
        )}

        {/* VIEW 3: EDUCATIONAL BLOG & SEO ACADEMY */}
        {currentPage === 'blog' && (
          <BlogSection
            selectedArticle={selectedArticle}
            onSelectArticle={setSelectedArticle}
            onGetStarted={() => setAuthModalMode('register')}
            onLaunchCockpit={() => setCurrentPage('cockpit')}
          />
        )}

        {/* VIEW 4: ABOUT & METHODOLOGY */}
        {currentPage === 'about' && (
          <AboutPage
            onGetStarted={() => setAuthModalMode('register')}
            onLaunchCockpit={() => setCurrentPage('cockpit')}
          />
        )}

        {/* VIEW 5: VIP & PRICING (Crypto Checkout & 30-Day VIP Pass) */}
        {currentPage === 'pricing' && (
          <div className="max-w-xl mx-auto space-y-4 animate-in fade-in duration-200">
            <CryptoCheckout
              user={user}
              onCreditsPurchased={handleCreditsPurchased}
              onVipPurchased={handleVipPurchased}
              onClose={() => setCurrentPage('cockpit')}
            />
          </div>
        )}

        {/* VIEW 6: MASTER ADMIN COMMAND CENTER (RESTRICTED GATEWAY) */}
        {currentPage === 'admin' && (
          <div className="max-w-5xl mx-auto animate-in fade-in duration-200">
            <AdminCenter
              user={user}
              onUserUpdated={handleUserUpdated}
              onExitAdmin={() => setCurrentPage('cockpit')}
              onlineUsers={onlineUsers}
            />
          </div>
        )}

        {/* Redirect for deprecated legacy views */}
        {(currentPage === 'files' || currentPage === 'supabase') && (
          <div className="max-w-5xl mx-auto animate-in fade-in duration-200">
            <AdminCenter
              user={user}
              onUserUpdated={handleUserUpdated}
              onExitAdmin={() => setCurrentPage('cockpit')}
              onlineUsers={onlineUsers}
            />
          </div>
        )}
      </main>

      {/* Global Auth Modal (Register / Login / 30-Day VIP Profile) */}
      <AuthModal
        mode={authModalMode}
        user={user}
        onClose={() => setAuthModalMode(null)}
        onUserUpdated={handleUserUpdated}
        onNavigateToCheckout={() => setCurrentPage('pricing')}
      />

      {/* Real-time VIP Safe Market Screener / Radar Modal */}
      <VipSafeRadarModal
        isOpen={isVipRadarOpen}
        onClose={() => setIsVipRadarOpen(false)}
        isVIP={isVIP || Boolean(user?.is_vip)}
        onSelectAsset={(asset) => {
          setActiveAsset(asset);
          setIsVipRadarOpen(false);
          setCurrentPage('cockpit');
        }}
        onUpgradeVip={() => {
          setIsVipRadarOpen(false);
          setCurrentPage('pricing');
        }}
      />

      {/* Global Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/80 px-4 py-6 font-mono text-xs text-slate-400">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <span className="font-bold text-white">{siteSettings.siteName} Citadel</span>
              <span>•</span>
              <span className="text-emerald-400">{siteSettings.badgeText || 'Deriv WebSocket Sync'}</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {siteSettings.siteTagline}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 text-[11px]">
            <button
              type="button"
              onClick={() => setCurrentPage('landing')}
              className="hover:text-white transition"
            >
              Overview
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={() => {
                setSelectedArticle(null);
                setCurrentPage('blog');
              }}
              className="hover:text-white transition"
            >
              Research Blog
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={() => setCurrentPage('about')}
              className="hover:text-white transition"
            >
              About &amp; Methodology
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={() => setCurrentPage('pricing')}
              className="hover:text-white transition"
            >
              VIP Access
            </button>
            {user?.role === 'ADMIN' && (
              <>
                <span>•</span>
                <button
                  type="button"
                  onClick={() => setCurrentPage('admin')}
                  className="text-amber-400 hover:text-amber-300 font-bold transition flex items-center gap-1"
                >
                  <span>👑 Admin Center</span>
                </button>
              </>
            )}
            {siteSettings.supportTelegram && (
              <>
                <span>•</span>
                <a
                  href={siteSettings.supportTelegram}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:underline"
                >
                  Telegram
                </a>
              </>
            )}
            {siteSettings.supportWhatsapp && (
              <>
                <span>•</span>
                <a
                  href={siteSettings.supportWhatsapp}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:underline"
                >
                  WhatsApp
                </a>
              </>
            )}
          </div>
        </div>
      </footer>

      {/* ========================================================================= */}
      {/* MOBILE BOTTOM NAVIGATION BAR (< 768px Viewports, Safe-Area Compliant)     */}
      {/* ========================================================================= */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 md:hidden bg-slate-950/95 backdrop-blur-xl border-t border-slate-800/90 px-1 py-1 pb-[max(env(safe-area-inset-bottom,0px),8px)] flex items-center justify-around shadow-2xl select-none"
      >
        {/* 1. Cockpit */}
        <button
          type="button"
          onClick={() => {
            setCurrentPage('cockpit');
            setIsMobileMoreOpen(false);
          }}
          className={`flex flex-col items-center justify-center flex-1 min-h-[48px] rounded-xl transition active:scale-95 ${
            currentPage === 'cockpit' && !isMobileMoreOpen
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span className="text-[10px] tracking-tight mt-0.5">Cockpit</span>
        </button>

        {/* 2. Safe Radar (with VIP indicator) */}
        <button
          type="button"
          data-tour="radar-control"
          onClick={() => {
            setIsVipRadarOpen(true);
            setIsMobileMoreOpen(false);
          }}
          className="flex flex-col items-center justify-center flex-1 min-h-[48px] rounded-xl text-amber-400 hover:text-amber-300 transition active:scale-95 relative"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
          <span className="text-[10px] tracking-tight mt-0.5">Radar</span>
          {(!user?.is_vip && !isVIP) ? (
            <span className="absolute top-1.5 right-4 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-slate-950 animate-pulse" />
          ) : (
            <span className="absolute top-1.5 right-4 text-[8px] bg-amber-500/30 text-amber-300 px-1 rounded font-bold">★</span>
          )}
        </button>

        {/* 3. VIP & Pricing */}
        <button
          type="button"
          onClick={() => {
            setCurrentPage('pricing');
            setIsMobileMoreOpen(false);
          }}
          className={`flex flex-col items-center justify-center flex-1 min-h-[48px] rounded-xl transition active:scale-95 ${
            currentPage === 'pricing' && !isMobileMoreOpen
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[10px] tracking-tight mt-0.5">Pricing</span>
        </button>

        {/* 4. Profile / Sign In */}
        <button
          type="button"
          onClick={() => {
            setAuthModalMode(user ? 'profile' : 'login');
            setIsMobileMoreOpen(false);
          }}
          className="flex flex-col items-center justify-center flex-1 min-h-[48px] rounded-xl text-slate-400 hover:text-slate-200 transition active:scale-95"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <span className="text-[10px] tracking-tight mt-0.5">{user ? 'Profile' : 'Sign In'}</span>
        </button>

        {/* 5. More / Menu */}
        <button
          type="button"
          onClick={() => setIsMobileMoreOpen((prev) => !prev)}
          className={`flex flex-col items-center justify-center flex-1 min-h-[48px] rounded-xl transition active:scale-95 ${
            isMobileMoreOpen
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span className="text-[10px] tracking-tight mt-0.5">More</span>
        </button>
      </nav>

      {/* Mobile More Bottom Sheet Drawer */}
      {isMobileMoreOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex flex-col justify-end bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="fixed inset-0"
            onClick={() => setIsMobileMoreOpen(false)}
          />
          <div className="relative bg-slate-900 border-t border-slate-800 rounded-t-3xl p-4 pb-8 space-y-3 shadow-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="font-bold text-white text-sm font-mono uppercase tracking-wide">
                  Navigation &amp; Controls
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsMobileMoreOpen(false)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <button
                type="button"
                onClick={() => {
                  setCurrentPage('landing');
                  setIsMobileMoreOpen(false);
                }}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition ${
                  currentPage === 'landing'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-bold'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span>🏠</span>
                <span>Overview</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedArticle(null);
                  setCurrentPage('blog');
                  setIsMobileMoreOpen(false);
                }}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition ${
                  currentPage === 'blog'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-bold'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span>📰</span>
                <span>Research Blog</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setCurrentPage('about');
                  setIsMobileMoreOpen(false);
                }}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition ${
                  currentPage === 'about'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-bold'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span>🔬</span>
                <span>Methodology</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsTutorialOpen(true);
                  setIsMobileMoreOpen(false);
                }}
                className="p-3 rounded-xl border bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700 flex items-center gap-2.5 transition"
              >
                <span>💡</span>
                <span>Take App Tour</span>
              </button>
            </div>

            {/* External Partner Broker CTAs (When enabled in Admin) */}
            {brokersSettings.brokers.deriv.enabled && brokersSettings.brokers.deriv.referralUrl && (
              <a
                href={brokersSettings.brokers.deriv.referralUrl}
                target={brokersSettings.brokers.deriv.openInNewTab ? '_blank' : '_self'}
                rel="noopener noreferrer"
                onClick={() => setIsMobileMoreOpen(false)}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-500 to-red-600 text-white font-black text-xs flex items-center justify-center gap-2 shadow-md shadow-rose-500/20"
              >
                <span>⚡</span>
                <span>{brokersSettings.brokers.deriv.label || 'Open Deriv'}</span>
                <span>↗</span>
              </a>
            )}

            {brokersSettings.brokers.expertOption.enabled && brokersSettings.brokers.expertOption.referralUrl && (
              <a
                href={brokersSettings.brokers.expertOption.referralUrl}
                target={brokersSettings.brokers.expertOption.openInNewTab ? '_blank' : '_self'}
                rel="noopener noreferrer"
                onClick={() => setIsMobileMoreOpen(false)}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-black text-xs flex items-center justify-center gap-2 shadow-md shadow-blue-500/20"
              >
                <span>⚡</span>
                <span>{brokersSettings.brokers.expertOption.label || 'Open ExpertOption'}</span>
                <span>↗</span>
              </a>
            )}

            {/* Master Admin Portal button for logged-in Admin */}
            {user?.role === 'ADMIN' && (
              <button
                type="button"
                onClick={() => {
                  setCurrentPage('admin');
                  setIsMobileMoreOpen(false);
                }}
                className="w-full py-3 px-4 rounded-xl bg-amber-500/20 border border-amber-500/50 text-amber-300 font-bold text-xs flex items-center justify-center gap-2 hover:bg-amber-500/30 transition"
              >
                <span>👑</span>
                <span>Master Admin Command Center</span>
              </button>
            )}

            {/* User Session Footer */}
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
              {user ? (
                <>
                  <span className="truncate max-w-[150px]">Signed in as: <strong className="text-white">{user.username}</strong></span>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthModalMode('profile');
                      setIsMobileMoreOpen(false);
                    }}
                    className="text-emerald-400 hover:underline font-bold"
                  >
                    Manage Profile &rarr;
                  </button>
                </>
              ) : (
                <div className="flex items-center justify-between w-full gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthModalMode('register');
                      setIsMobileMoreOpen(false);
                    }}
                    className="py-2 px-3 bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-black rounded-lg text-xs"
                  >
                    Get Started (10 Free CR)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthModalMode('login');
                      setIsMobileMoreOpen(false);
                    }}
                    className="text-emerald-400 hover:underline font-bold text-xs"
                  >
                    Sign In &rarr;
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Guided Walkthrough Coach Mark Tour */}
      <GuidedTourCoachMark
        isOpen={isTutorialOpen}
        onClose={handleCloseTutorial}
        onNavigateToPricing={() => setCurrentPage('pricing')}
        currentPage={currentPage}
        onSetPage={(page) => setCurrentPage(page as any)}
        onOpenRadar={() => setIsVipRadarOpen(true)}
      />

      {/* Floating WhatsApp & Telegram Support Stack */}
      <FloatingSupportFAB settings={siteSettings} />
    </div>
  );
}
