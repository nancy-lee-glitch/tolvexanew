import React, { useState } from 'react';
import type { UserProfile, AuthModalMode } from '../types.ts';
import {
  signUpWithSupabase,
  signInWithSupabase,
  signOutSupabase,
  redeemVipKeyWithSupabase,
} from '../utils/supabaseClient.ts';
import { getBrokersSettings } from '../utils/siteConfigManager.ts';

interface AuthModalProps {
  mode: AuthModalMode;
  user: UserProfile | null;
  onClose: () => void;
  onUserUpdated: (user: UserProfile | null) => void;
  onNavigateToCheckout: () => void;
}

export function AuthModal({
  mode,
  user,
  onClose,
  onUserUpdated,
  onNavigateToCheckout,
}: AuthModalProps) {
  const [currentMode, setCurrentMode] = useState<'login' | 'register' | 'profile' | 'redeem-vip'>(
    mode === 'register' ? 'register' : mode === 'login' ? 'login' : user ? 'profile' : 'register'
  );

  // Synchronize internal mode whenever modal is opened or mode prop changes
  React.useEffect(() => {
    if (mode === 'register') {
      setCurrentMode('register');
    } else if (mode === 'login') {
      setCurrentMode('login');
    } else if (mode === 'profile' || user) {
      setCurrentMode('profile');
    } else if (mode === 'redeem-vip') {
      setCurrentMode('redeem-vip');
    }
    setErrorMessage(null);
    setSuccessMessage(null);
  }, [mode, user]);

  // Form states
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState('');
  const [vipKey, setVipKey] = useState('');
  const [referralCode, setReferralCode] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('ref') || sessionStorage.getItem('pulsetrade_ref_code') || '';
    }
    return '';
  });
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const brokersSettings = getBrokersSettings();

  if (!mode) return null;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      let extraCredits = 0;
      const cleanRef = referralCode.trim().toUpperCase();
      const targetRef = (brokersSettings.referralBonus.referralCode || 'TOLVEXA').toUpperCase();

      if (brokersSettings.referralBonus.enabled && (cleanRef === targetRef || cleanRef === 'TOLVEXA' || cleanRef === 'DERIV')) {
        extraCredits = brokersSettings.referralBonus.extraCredits || 5;
      }

      const res = await signUpWithSupabase(email, password, username, vipKey.trim(), extraCredits);

      if (res.success && res.user) {
        if (extraCredits > 0) {
          setSuccessMessage(`Account created! You received 10 starter credits + ${extraCredits} referral bonus credits! Total: ${10 + extraCredits} CR.`);
        } else {
          setSuccessMessage(res.message);
        }
        onUserUpdated(res.user);
        setTimeout(() => {
          setCurrentMode('profile');
        }, 1200);
      } else {
        setErrorMessage(res.message || 'Registration failed. Please check your credentials.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Network error during registration. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      // Direct Supabase Auth (supports email OR username)
      const res = await signInWithSupabase(identity, password);

      if (res.success && res.user) {
        setSuccessMessage('Authentication successful!');
        onUserUpdated(res.user);
        setTimeout(() => {
          setCurrentMode('profile');
        }, 800);
      } else {
        setErrorMessage(res.message || 'Invalid username/email or password.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Connection failed. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  const handleRedeemVip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vipKey.trim()) return;
    setLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await redeemVipKeyWithSupabase(vipKey.trim(), user);

      if (res.success && res.user) {
        setSuccessMessage(res.message);
        onUserUpdated(res.user);
        setVipKey('');
      } else {
        setErrorMessage(res.message || 'Invalid VIP key. Valid keys include VIP-ALPHA-30D or PULSE-VIP-2026.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to validate VIP key.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOutSupabase();
    } catch {}

    onUserUpdated(null);
    setCurrentMode('login');
    setSuccessMessage('Logged out safely.');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-2xl space-y-5 my-auto relative">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1.5 rounded-xl hover:bg-slate-800 transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 border-b border-slate-800/80 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-black shadow-lg shadow-emerald-500/20">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-bold text-white font-mono uppercase tracking-wide">
              {currentMode === 'register' && 'Create Trader Account'}
              {currentMode === 'login' && 'Sign In to Cockpit'}
              {currentMode === 'profile' && 'Trader Citadel Profile'}
              {currentMode === 'redeem-vip' && 'Redeem 30-Day VIP Pass'}
            </h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] font-mono text-emerald-400">
                {currentMode === 'register' && '10 Free Starter Credits on Registration'}
                {currentMode === 'login' && 'Sync Credits, Signals & VIP Status'}
                {currentMode === 'profile' && `User: ${user?.username || 'Trader'}`}
                {currentMode === 'redeem-vip' && 'Strict 30-Day Timeframe Protection'}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>SSL Encrypted</span>
              </span>
            </div>
          </div>
        </div>

        {/* Alerts */}
        {errorMessage && (
          <div className="bg-rose-950/80 border border-rose-500/50 text-rose-300 text-xs font-mono p-3 rounded-xl flex items-start gap-2.5">
            <svg className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="leading-relaxed">{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div className="bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 text-xs font-mono p-3 rounded-xl flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
            </svg>
            <span>{successMessage}</span>
          </div>
        )}

        {/* MODE: REGISTER */}
        {currentMode === 'register' && (
          <form onSubmit={handleRegister} className="space-y-3.5">
            {/* Admin-Configured Referral Bonus Promo Banner */}
            {brokersSettings.referralBonus.enabled && (
              <div className="p-3 bg-gradient-to-r from-amber-500/15 via-amber-600/10 to-slate-950 border border-amber-500/30 rounded-2xl space-y-1">
                <div className="flex items-center gap-1.5 text-amber-300 font-bold text-xs font-mono">
                  <span>🎁</span>
                  <span>Partner Referral Promo: +{brokersSettings.referralBonus.extraCredits} Extra Credits</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-snug font-sans">
                  {brokersSettings.referralBonus.message ||
                    `Sign up using the partner referral link or enter code ${brokersSettings.referralBonus.referralCode || 'TOLVEXA'} to receive +${brokersSettings.referralBonus.extraCredits} bonus credits!`}
                </p>
              </div>
            )}

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Trader Handle / Username
              </label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={30}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. QuantAlpha"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="trader@domain.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Secure Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            {/* Referral / Partner Promo Code */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-mono uppercase text-slate-400 tracking-wider">
                  Referral / Affiliate Code (Optional)
                </label>
                {brokersSettings.referralBonus.enabled && (
                  <span className="text-[10px] font-mono text-amber-400 font-bold">
                    +{brokersSettings.referralBonus.extraCredits} Extra CR
                  </span>
                )}
              </div>
              <input
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                placeholder={`e.g. ${brokersSettings.referralBonus.referralCode || 'TOLVEXA'} (or leave blank)`}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-amber-300 font-mono focus:border-amber-500 focus:outline-none uppercase"
              />
            </div>

            {/* VIP Activation Pass */}
            <div className="bg-slate-950/70 border border-amber-500/30 rounded-xl p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-mono uppercase text-amber-300 font-bold flex items-center gap-1.5">
                  <span>★ VIP Key (Optional)</span>
                </label>
                <span className="text-[9px] font-mono text-slate-400">Strict 30-Day Pass</span>
              </div>
              <input
                type="text"
                value={vipKey}
                onChange={(e) => setVipKey(e.target.value)}
                placeholder="e.g. VIP-ALPHA-30D (or leave blank)"
                className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-amber-200 font-mono focus:border-amber-400 focus:outline-none uppercase"
              />
              <p className="text-[10px] text-slate-400 leading-tight">
                Enter a 30-day VIP activation key to instantly unlock unlimited signals. If left blank, you will receive 10 free starter credits!
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20 disabled:opacity-50 cursor-pointer"
            >
              {loading
                ? 'Creating Trader Account...'
                : brokersSettings.referralBonus.enabled && referralCode.trim()
                ? `Get Started & Claim ${10 + brokersSettings.referralBonus.extraCredits} Free Credits →`
                : 'Get Started & Claim 10 Free Credits →'}
            </button>

            <div className="text-center text-xs font-mono text-slate-400 pt-1">
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => setCurrentMode('login')}
                className="text-emerald-400 hover:underline font-bold"
              >
                Sign In
              </button>
            </div>
          </form>
        )}

        {/* MODE: LOGIN */}
        {currentMode === 'login' && (
          <form onSubmit={handleLogin} className="space-y-3.5">
            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Username or Email
              </label>
              <input
                type="text"
                required
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="Username or email"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              {loading ? 'Authenticating...' : 'Sign In to Cockpit →'}
            </button>

            <div className="text-center text-xs font-mono text-slate-400 pt-1">
              Need an account?{' '}
              <button
                type="button"
                onClick={() => setCurrentMode('register')}
                className="text-emerald-400 hover:underline font-bold"
              >
                Get Started (10 Free Credits)
              </button>
            </div>
          </form>
        )}

        {/* MODE: PROFILE */}
        {currentMode === 'profile' && user && (
          <div className="space-y-4 font-mono">
            {/* User Details Card */}
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-slate-400">Authenticated Trader</span>
                  <div className="text-base font-black text-white">{user.username}</div>
                  <div className="text-[10px] text-slate-500">{user.email}</div>
                </div>
                <div className="text-right">
                  <span className="text-xs text-slate-400 block">Current Balance</span>
                  <span className="text-xl font-black text-emerald-400">
                    {user.is_vip ? 'UNLIMITED' : `${user.credits} CR`}
                  </span>
                </div>
              </div>

              {/* VIP 30-Day Status Banner */}
              {user.is_vip ? (
                <div className="bg-gradient-to-r from-amber-950/60 to-slate-900 border border-amber-500/50 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black text-amber-300 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      ★ VIP ACCESS (30-DAY TIMEFRAME)
                    </span>
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded font-bold">
                      ACTIVE
                    </span>
                  </div>

                  {/* 30-Day Countdown Breakdown */}
                  <div className="grid grid-cols-2 gap-2 text-center pt-1">
                    <div className="bg-slate-950/80 border border-amber-500/30 rounded-lg p-2">
                      <span className="text-[9px] text-slate-400 uppercase block">Time Remaining</span>
                      <span className="text-lg font-black text-amber-300 font-mono">
                        {user.vip_days_left}d {user.vip_hours_left}h
                      </span>
                    </div>
                    <div className="bg-slate-950/80 border border-amber-500/30 rounded-lg p-2">
                      <span className="text-[9px] text-slate-400 uppercase block">Expires On</span>
                      <span className="text-xs font-bold text-slate-200 block mt-1">
                        {user.vip_expires_at ? new Date(user.vip_expires_at).toLocaleDateString() : '30 Days'}
                      </span>
                    </div>
                  </div>

                  <p className="text-[10px] text-amber-200/80 leading-relaxed">
                    Strict 30-day enforcement active. When the 30-day period elapses, VIP limits revert automatically.
                  </p>
                </div>
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Standard Tier</span>
                    <span className="text-slate-400">Consumes 1 credit/signal</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onNavigateToCheckout();
                      }}
                      className="flex-1 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold rounded-lg transition"
                    >
                      Top-Up Credits
                    </button>
                    <button
                      type="button"
                      onClick={() => setCurrentMode('redeem-vip')}
                      className="py-2 px-3 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-xs font-bold rounded-lg transition"
                    >
                      Redeem VIP Key
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={handleLogout}
                className="text-xs text-rose-400 hover:text-rose-300 hover:underline"
              >
                Sign Out
              </button>
              <button
                type="button"
                onClick={onClose}
                className="py-2 px-4 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition"
              >
                Enter Cockpit →
              </button>
            </div>
          </div>
        )}

        {/* MODE: REDEEM VIP CODE */}
        {currentMode === 'redeem-vip' && (
          <form onSubmit={handleRedeemVip} className="space-y-3.5 font-mono">
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 text-xs text-slate-300 space-y-1">
              <div className="text-amber-300 font-bold">30-Day VIP Pass Verification</div>
              <p className="text-[11px] text-slate-400">
                Enter your 30-day VIP pass activation code. Sample verified keys: <code className="text-amber-300">VIP-ALPHA-30D</code> or <code className="text-amber-300">PULSE-VIP-2026</code>.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Activation Code
              </label>
              <input
                type="text"
                required
                value={vipKey}
                onChange={(e) => setVipKey(e.target.value)}
                placeholder="VIP-ALPHA-30D"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-amber-300 font-mono uppercase focus:border-amber-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !vipKey.trim()}
              className="w-full py-3.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-amber-500/20 disabled:opacity-50"
            >
              {loading ? 'Validating Key...' : 'Activate 30-Day VIP Slot →'}
            </button>

            <div className="flex justify-between items-center text-xs pt-1">
              <button
                type="button"
                onClick={() => setCurrentMode('profile')}
                className="text-slate-400 hover:text-white"
              >
                ← Back to Profile
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateToCheckout();
                }}
                className="text-emerald-400 hover:underline"
              >
                Buy VIP via Crypto
              </button>
            </div>
          </form>
        )}

        {/* Disclaimer */}
        <p className="text-[10px] text-center text-slate-500 font-mono border-t border-slate-800/60 pt-3">
          Risk Notice: Trading digital options and Forex involves financial risk. Quantitative signals do not constitute financial advice.
        </p>
      </div>
    </div>
  );
}
