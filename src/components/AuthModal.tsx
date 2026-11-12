import React, { useState } from 'react';
import type { UserProfile, AuthModalMode } from '../types.ts';
import {
  signUpWithSupabase,
  signInWithSupabase,
  signOutSupabase,
  redeemVipKeyWithSupabase,
  sendPasswordResetEmail,
  updateUserPassword,
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
  const [currentMode, setCurrentMode] = useState<
    'login' | 'register' | 'profile' | 'redeem-vip' | 'forgot-password' | 'reset-password'
  >(
    mode === 'register'
      ? 'register'
      : mode === 'login'
      ? 'login'
      : mode === 'forgot-password'
      ? 'forgot-password'
      : mode === 'reset-password'
      ? 'reset-password'
      : user
      ? 'profile'
      : 'register'
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
    } else if (mode === 'forgot-password') {
      setCurrentMode('forgot-password');
    } else if (mode === 'reset-password') {
      setCurrentMode('reset-password');
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
  const [resetEmail, setResetEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
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

  // Security & Bot Defense
  const [honeypot, setHoneypot] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [emailConfirmationRequired, setEmailConfirmationRequired] = useState(false);
  const turnstileContainerRef = React.useRef<HTMLDivElement>(null);

  const brokersSettings = getBrokersSettings();

  // Cloudflare Turnstile initialization
  React.useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
    if (!siteKey || currentMode !== 'register' || emailConfirmationRequired) return;

    let widgetId: string | undefined;

    const renderWidget = () => {
      if (typeof window !== 'undefined' && (window as any).turnstile && turnstileContainerRef.current) {
        try {
          // Clear container in case of re-render
          turnstileContainerRef.current.innerHTML = '';
          widgetId = (window as any).turnstile.render(turnstileContainerRef.current, {
            sitekey: siteKey,
            callback: (token: string) => setTurnstileToken(token),
            'expired-callback': () => setTurnstileToken(''),
            'error-callback': () => setTurnstileToken(''),
          });
        } catch (e) {
          console.warn('[Turnstile render error]', e);
        }
      }
    };

    if (typeof window !== 'undefined' && !(window as any).turnstile) {
      const existingScript = document.getElementById('cloudflare-turnstile-script');
      if (!existingScript) {
        const script = document.createElement('script');
        script.id = 'cloudflare-turnstile-script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => renderWidget();
        document.head.appendChild(script);
      } else {
        existingScript.addEventListener('load', renderWidget);
      }
    } else {
      renderWidget();
    }

    return () => {
      if (widgetId && typeof window !== 'undefined' && (window as any).turnstile) {
        try {
          (window as any).turnstile.remove(widgetId);
        } catch (err) {
          console.warn('[Turnstile cleanup warning]', err);
        }
      }
    };
  }, [currentMode, emailConfirmationRequired]);

  const getPasswordStrength = (pwd: string): { score: number; label: string; color: string } => {
    if (!pwd) return { score: 0, label: '', color: 'bg-slate-700' };
    if (pwd.length < 8) return { score: 1, label: 'Too short (min 8 characters)', color: 'bg-rose-500' };

    let score = 1;
    if (pwd.length >= 12) score += 1;
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score += 1;
    if (/[0-9]/.test(pwd)) score += 1;
    if (/[^A-Za-z0-9]/.test(pwd)) score += 1;

    if (score <= 2) return { score: 2, label: 'Weak', color: 'bg-amber-500' };
    if (score <= 3) return { score: 3, label: 'Fair', color: 'bg-yellow-400' };
    return { score: 4, label: 'Strong', color: 'bg-emerald-400' };
  };

  if (!mode) return null;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ageConfirmed) {
      setErrorMessage('You must confirm you are at least 18 years old and in an eligible jurisdiction to continue.');
      return;
    }
    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }
    if (password.length > 128) {
      setErrorMessage('Password cannot exceed 128 characters.');
      return;
    }

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

      const res = await signUpWithSupabase(
        email,
        password,
        username,
        vipKey.trim(),
        extraCredits,
        turnstileToken,
        honeypot
      );

      if (res.success) {
        if (res.requireEmailConfirmation) {
          setEmailConfirmationRequired(true);
          setSuccessMessage('Account created! Please check your email to confirm your registration before signing in.');
        } else if (res.user) {
          if (extraCredits > 0) {
            setSuccessMessage(`Account created! You received 10 starter credits + ${extraCredits} referral bonus credits! Total: ${10 + extraCredits} CR.`);
          } else {
            setSuccessMessage(res.message);
          }
          onUserUpdated(res.user);
          setTimeout(() => {
            setCurrentMode('profile');
          }, 1200);
        }
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
    } catch (err: any) {
      console.warn('[SignOut Warning]', err);
      setErrorMessage(err?.message || 'Warning: Failed to invalidate session on server. Local session cleared.');
    }

    onUserUpdated(null);
    setCurrentMode('login');
    setSuccessMessage('Logged out safely.');
  };

  const handleSendReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) {
      setErrorMessage('Please enter your account email address.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await sendPasswordResetEmail(resetEmail.trim());
      if (res.success) {
        setSuccessMessage(res.message);
      } else {
        setErrorMessage(res.message || 'Failed to send reset link. Please verify your email.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Error processing reset request.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 6) {
      setErrorMessage('Password must be at least 6 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Passwords do not match. Please ensure both passwords match.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await updateUserPassword(newPassword);
      if (res.success) {
        setSuccessMessage(res.message);
        setTimeout(() => {
          setCurrentMode('login');
        }, 1500);
      } else {
        setErrorMessage(res.message || 'Could not update password.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Error updating password.');
    } finally {
      setLoading(false);
    }
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
              {currentMode === 'forgot-password' && 'Reset Password'}
              {currentMode === 'reset-password' && 'Set New Password'}
            </h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] font-mono text-emerald-400">
                {currentMode === 'register' && '10 Free Starter Credits on Registration'}
                {currentMode === 'login' && 'Sync Credits, Signals & VIP Status'}
                {currentMode === 'profile' && `User: ${user?.username || 'Trader'}`}
                {currentMode === 'redeem-vip' && 'Strict 30-Day Timeframe Protection'}
                {currentMode === 'forgot-password' && 'Receive secure recovery instructions via email'}
                {currentMode === 'reset-password' && 'Enter your new secure password'}
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
          emailConfirmationRequired ? (
            <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-2xl p-5 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center mx-auto text-2xl font-mono">
                ✉️
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-white text-base font-mono">Confirm Your Email Address</h3>
                <p className="text-xs text-slate-300 font-sans leading-relaxed">
                  We sent a confirmation link to <strong className="text-emerald-400">{email}</strong>. Please check your inbox and verify your address before logging in.
                </p>
              </div>
              <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl text-[11px] text-slate-400 font-mono text-left space-y-1">
                <div>• Verification ensures honest ownership of your trading records.</div>
                <div>• Once confirmed, log in to claim your 10 free algorithmic computation credits.</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEmailConfirmationRequired(false);
                  setCurrentMode('login');
                  setIdentity(email);
                  setPassword('');
                }}
                className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs font-mono uppercase rounded-xl transition shadow-lg shadow-emerald-500/20 cursor-pointer"
              >
                Proceed to Sign In →
              </button>
            </div>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3.5">
              {/* Bot defense honeypot */}
              <div style={{ display: 'none' }} aria-hidden="true">
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </div>

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
                  minLength={8}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
                />
                {/* Password Strength Indicator */}
                <div className="mt-1.5 space-y-1">
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-slate-400">Password Strength:</span>
                    <span className={password ? getPasswordStrength(password).color.replace('bg-', 'text-') : 'text-slate-500'}>
                      {password ? getPasswordStrength(password).label : 'Min 8 characters'}
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex gap-1">
                    {[1, 2, 3, 4].map((step) => {
                      const strength = getPasswordStrength(password);
                      const active = strength.score >= step;
                      return (
                        <div
                          key={step}
                          className={`h-full flex-1 transition-all duration-300 rounded-full ${
                            active ? strength.color : 'bg-slate-800'
                          }`}
                        />
                      );
                    })}
                  </div>
                </div>
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

              {/* Cloudflare Turnstile Verification Widget */}
              {typeof window !== 'undefined' && import.meta.env.VITE_TURNSTILE_SITE_KEY && (
                <div className="flex flex-col items-center justify-center my-2">
                  <div ref={turnstileContainerRef} />
                </div>
              )}

              {/* Age & Jurisdiction Confirmation */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-950/60 border border-slate-800 cursor-pointer select-none">
                <input
                  type="checkbox"
                  required
                  checked={ageConfirmed}
                  onChange={(e) => setAgeConfirmed(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-700 text-emerald-500 focus:ring-emerald-500 bg-slate-900"
                />
                <span className="text-xs text-slate-300 leading-relaxed font-sans">
                  I confirm I am at least <strong className="text-white">18 years old</strong> and reside in an eligible jurisdiction where trading digital contracts is permitted by local law.
                </span>
              </label>

              <button
                type="submit"
                disabled={loading || !ageConfirmed}
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
          )
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
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-mono uppercase text-slate-400 tracking-wider">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setCurrentMode('forgot-password');
                    setErrorMessage(null);
                    setSuccessMessage(null);
                    if (identity && identity.includes('@')) {
                      setResetEmail(identity);
                    }
                  }}
                  className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer"
                >
                  Forgot password?
                </button>
              </div>
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
              className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Authenticating...' : 'Sign In to Cockpit →'}
            </button>

            <div className="text-center text-xs font-mono text-slate-400 pt-1">
              Need an account?{' '}
              <button
                type="button"
                onClick={() => setCurrentMode('register')}
                className="text-emerald-400 hover:underline font-bold cursor-pointer"
              >
                Get Started (10 Free Credits)
              </button>
            </div>
          </form>
        )}

        {/* MODE: FORGOT PASSWORD */}
        {currentMode === 'forgot-password' && (
          <form onSubmit={handleSendReset} className="space-y-4 font-mono">
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-300 space-y-1">
              <div className="text-emerald-400 font-bold flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <span>Password Recovery</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                Enter your account email. We will generate and dispatch a secure single-use recovery link directly to your inbox.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Account Email Address
              </label>
              <input
                type="email"
                required
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="trader@domain.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Sending Recovery Link...' : 'Send Reset Link →'}
            </button>

            <div className="flex justify-between items-center text-xs pt-1">
              <button
                type="button"
                onClick={() => {
                  setCurrentMode('login');
                  setErrorMessage(null);
                  setSuccessMessage(null);
                }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                ← Back to Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setCurrentMode('register');
                  setErrorMessage(null);
                  setSuccessMessage(null);
                }}
                className="text-emerald-400 hover:underline cursor-pointer"
              >
                Create Account
              </button>
            </div>
          </form>
        )}

        {/* MODE: RESET PASSWORD (NEW PASSWORD INPUT) */}
        {currentMode === 'reset-password' && (
          <form onSubmit={handleUpdatePassword} className="space-y-4 font-mono">
            <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-xl p-3.5 text-xs text-slate-300 space-y-1">
              <div className="text-emerald-400 font-bold flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <span>Set New Password</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                Choose a strong new password with at least 6 characters. Once saved, you can log in immediately.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                New Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-400 tracking-wider mb-1">
                Confirm New Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Saving New Password...' : 'Save Password & Enter Cockpit →'}
            </button>

            <div className="text-center text-xs pt-1">
              <button
                type="button"
                onClick={() => {
                  setCurrentMode('login');
                  setErrorMessage(null);
                  setSuccessMessage(null);
                }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                ← Back to Sign In
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
