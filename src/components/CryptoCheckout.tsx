import React, { useState, useEffect, useRef } from 'react';
import type { PricingTier, CryptoWallet, NowPaymentsPayment, PricingPackage, UserProfile } from '../types.ts';
import {
  getNowPaymentsConfig,
  fetchRemoteNowPaymentsConfig,
  createNowPaymentsPayment,
  checkNowPaymentsStatus,
  fetchPricingPackages,
  getPricingPackages,
  DEFAULT_PRICING_PACKAGES,
  submitDirectWalletOrder,
} from '../utils/siteConfigManager.ts';
import { logOutcomeToSupabase } from '../utils/supabaseClient.ts';

interface CryptoCheckoutProps {
  user?: UserProfile | null;
  onCreditsPurchased: (credits: number) => void;
  onVipPurchased?: () => void;
  onClose: () => void;
  onOpenAdmin?: () => void;
}

const TIERS: PricingTier[] = [
  { id: 1, credits: 10, bonus: 0, price: 5.0, label: 'Starter Pack' },
  { id: 2, credits: 25, bonus: 5, price: 10.0, label: 'Popular (5 Free)', badge: 'MOST POPULAR' },
  { id: 3, credits: 60, bonus: 20, price: 20.0, label: 'Pro Trader (+20)' },
  { id: 4, credits: 150, bonus: 60, price: 45.0, label: 'Whale Alpha (+60)' },
  { id: 5, credits: 9999, bonus: 0, price: 49.0, label: '★ 30-Day VIP Pass', badge: '30-DAY LIMIT' },
];

const MANUAL_WALLETS: CryptoWallet[] = [
  {
    id: 1,
    coinName: 'USDT (TRC20)',
    symbol: 'USDT',
    network: 'TRON / TRC-20',
    address: 'TYDzsxdUKGptqTxb3g58FjBvh3y8kK5n2o',
    active: true,
  },
  {
    id: 2,
    coinName: 'Bitcoin',
    symbol: 'BTC',
    network: 'Bitcoin Native SegWit',
    address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    active: true,
  },
  {
    id: 3,
    coinName: 'Ethereum',
    symbol: 'ETH',
    network: 'Ethereum (ERC-20)',
    address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    active: true,
  },
];

const NOWPAYMENTS_COINS = [
  { code: 'usdttrc20', name: 'USDT (TRC-20)', network: 'Tron', badge: 'FAST & CHEAP' },
  { code: 'usdtbsc', name: 'USDT (BEP-20)', network: 'BNB Smart Chain', badge: 'LOW FEE' },
  { code: 'btc', name: 'Bitcoin (BTC)', network: 'Bitcoin', badge: 'NATIVE' },
  { code: 'eth', name: 'Ethereum (ETH)', network: 'Ethereum', badge: 'ERC-20' },
  { code: 'ton', name: 'TON (The Open Network)', network: 'TON', badge: 'INSTANT' },
  { code: 'sol', name: 'Solana (SOL)', network: 'Solana', badge: 'FAST' },
  { code: 'ltc', name: 'Litecoin (LTC)', network: 'Litecoin', badge: 'LOW FEE' },
];

export function CryptoCheckout({ user, onCreditsPurchased, onVipPurchased, onClose, onOpenAdmin }: CryptoCheckoutProps) {
  const [packagesList, setPackagesList] = useState<PricingPackage[]>(() => {
    const list = getPricingPackages().filter((p) => p.is_active);
    return list.length > 0 ? list : DEFAULT_PRICING_PACKAGES;
  });

  // Default to VIP package if present, or last package
  const [selectedPackage, setSelectedPackage] = useState<PricingPackage>(() => {
    const list = getPricingPackages().filter((p) => p.is_active);
    const vip = list.find((p) => p.type === 'VIP_30_DAY');
    return vip || list[list.length - 1] || DEFAULT_PRICING_PACKAGES[4];
  });

  // Backward compatibility alias for selectedTier
  const selectedTier = {
    id: selectedPackage.id,
    credits: selectedPackage.credits_amount,
    bonus: selectedPackage.bonus_credits,
    price: selectedPackage.price_usd,
    label: selectedPackage.name,
    badge: selectedPackage.badge_label,
  };

  const [activeMode, setActiveMode] = useState<'nowpayments' | 'manual'>('nowpayments');

  // NOWPayments states
  const [nowConfig, setNowConfig] = useState(getNowPaymentsConfig());
  const [selectedCoin, setSelectedCoin] = useState<string>('usdttrc20');
  const [generatingPayment, setGeneratingPayment] = useState<boolean>(false);
  const [activePayment, setActivePayment] = useState<NowPaymentsPayment | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [isSuccess, setIsSuccess] = useState<boolean>(false);

  // Manual wallet states
  const [selectedWallet, setSelectedWallet] = useState<CryptoWallet>(MANUAL_WALLETS[0]);
  const [txHash, setTxHash] = useState<string>('');
  const [manualSubmitted, setManualSubmitted] = useState<boolean>(false);
  const [manualSubmitting, setManualSubmitting] = useState<boolean>(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const pollIntervalRef = useRef<any>(null);
  const processedPaymentsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetchRemoteNowPaymentsConfig().then((config) => {
      setNowConfig(config);
      if (!config.enabled || !config.apiKey) {
        setActiveMode('nowpayments');
      }
    });

    fetchPricingPackages().then((pkgs) => {
      const activePkgs = pkgs.filter((p) => p.is_active);
      if (activePkgs.length > 0) {
        setPackagesList(activePkgs);
        // keep current selection if valid, else pick VIP
        setSelectedPackage((curr) => {
          const match = activePkgs.find((p) => p.id === curr.id);
          if (match) return match;
          const vip = activePkgs.find((p) => p.type === 'VIP_30_DAY');
          return vip || activePkgs[0];
        });
      }
    });

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Poll NOWPayments status
  useEffect(() => {
    if (!activePayment?.paymentId) return;

    const pollStatus = async () => {
      try {
        const res = await checkNowPaymentsStatus(activePayment.paymentId);
        if (res.success && res.data) {
          const updated = res.data;
          setActivePayment((prev) => (prev ? { ...prev, ...updated } : updated));

          // Strict rule: only grant if status is confirmed or finished, and only once per paymentId
          if (updated.paymentStatus === 'confirmed' || updated.paymentStatus === 'finished') {
            if (processedPaymentsRef.current.has(activePayment.paymentId)) {
              return;
            }
            processedPaymentsRef.current.add(activePayment.paymentId);
            setIsSuccess(true);
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

            // Trigger activation
            setTimeout(() => {
              if (selectedPackage.type === 'VIP_30_DAY' && onVipPurchased) {
                onVipPurchased();
              } else {
                onCreditsPurchased(selectedPackage.credits_amount + selectedPackage.bonus_credits);
              }
            }, 1200);
          }
        }
      } catch (err) {
        // Ignored
      }
    };

    pollIntervalRef.current = setInterval(pollStatus, 4000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [activePayment?.paymentId, selectedPackage, onVipPurchased, onCreditsPurchased]);

  const handleCreateNowPayment = async () => {
    setGeneratingPayment(true);
    setPaymentError(null);

    const isVip = selectedPackage.type === 'VIP_30_DAY';
    const orderId = `${isVip ? 'VIP30D' : 'CREDIT'}_PKG${selectedPackage.id}_${Date.now()}`;
    const orderDesc = `${selectedPackage.name} (${isVip ? '30-Day VIP Pass' : `${selectedPackage.credits_amount + selectedPackage.bonus_credits} Signals`})`;

    const res = await createNowPaymentsPayment({
      priceAmount: selectedPackage.price_usd,
      priceCurrency: 'usd',
      payCurrency: selectedCoin,
      orderId,
      orderDescription: orderDesc,
    });

    setGeneratingPayment(false);

    if (res.success && res.data) {
      setActivePayment(res.data);
    } else {
      setPaymentError(res.message || 'Could not initiate NOWPayments invoice.');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Critical product rule: Never grant VIP or credits automatically on direct wallet submit.
  // Direct transfers are queued as pending_admin for manual verification.
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!txHash.trim() || manualSubmitting) return;
    setManualSubmitting(true);
    setManualError(null);

    try {
      const isVip = selectedPackage.type === 'VIP_30_DAY';
      await submitDirectWalletOrder({
        userId: user?.id || 'guest',
        username: user?.username || user?.email || 'Anonymous Trader',
        userEmail: user?.email,
        packageType: isVip ? 'VIP_30' : 'CREDITS',
        packageName: selectedPackage.name,
        amountUsd: selectedPackage.price_usd,
        creditsAmount: isVip ? 9999 : (selectedPackage.credits_amount + selectedPackage.bonus_credits),
        coinSymbol: selectedWallet.symbol,
        network: selectedWallet.network,
        depositAddress: selectedWallet.address,
        txHash: txHash.trim(),
      });
      setManualSubmitted(true);
    } catch (err: any) {
      setManualError(err?.message || 'Failed to submit proof. Please check your connection.');
    } finally {
      setManualSubmitting(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl space-y-5 font-mono max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-black text-white uppercase tracking-wider">
              Instant Crypto Checkout
            </h3>
            <span className="text-[10px] text-slate-400">
              Automated Blockchain Verification Engine
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Mode Switcher */}
      <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
        <button
          type="button"
          onClick={() => {
            setActiveMode('nowpayments');
            setActivePayment(null);
          }}
          className={`py-2 px-3 rounded-lg font-bold transition flex items-center justify-center gap-1.5 ${
            activeMode === 'nowpayments'
              ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <span>⚡ NOWPayments</span>
          <span className="text-[9px] bg-slate-950/40 text-emerald-950 px-1 rounded uppercase font-black">
            Instant
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveMode('manual')}
          className={`py-2 px-3 rounded-lg font-bold transition flex items-center justify-center gap-1.5 ${
            activeMode === 'manual'
              ? 'bg-slate-800 text-white shadow-md'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <span>🏦 Direct Wallet Transfer</span>
        </button>
      </div>

      {/* Select Tier */}
      <div className="space-y-2">
        <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
          Step 1: Select Your Package
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {packagesList.map((pkg) => {
            const isSelected = selectedPackage.id === pkg.id;
            const isVipPkg = pkg.type === 'VIP_30_DAY';
            return (
              <div
                key={pkg.id}
                onClick={() => {
                  setSelectedPackage(pkg);
                  setActivePayment(null);
                }}
                className={`p-3 rounded-xl border cursor-pointer transition select-none ${
                  isSelected
                    ? isVipPkg
                      ? 'border-amber-400 bg-amber-500/10 text-white ring-1 ring-amber-400/50'
                      : 'border-emerald-500 bg-emerald-500/10 text-white ring-1 ring-emerald-500/50'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                } ${isVipPkg ? 'sm:col-span-2' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-black text-xs">{pkg.name}</span>
                  <span className={`text-xs font-bold ${isVipPkg ? 'text-amber-400' : 'text-emerald-400'}`}>
                    ${pkg.price_usd.toFixed(2)}
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 mt-1 flex items-center justify-between">
                  <span>
                    {isVipPkg
                      ? 'Strict 30-Day Unlimited VIP Pass'
                      : pkg.bonus_credits > 0
                      ? `${pkg.credits_amount} + ${pkg.bonus_credits} Bonus Signals`
                      : `${pkg.credits_amount} Signal Executions`}
                  </span>
                  {pkg.badge_label && (
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                        isVipPkg ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {pkg.badge_label}
                    </span>
                  )}
                </div>
                {pkg.description && (
                  <p className="text-[9px] text-slate-500 mt-1 line-clamp-1">{pkg.description}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* NOWPAYMENTS INSTANT AUTOMATED VERIFICATION FLOW                           */}
      {/* ========================================================================= */}
      {activeMode === 'nowpayments' && (
        <div className="space-y-4">
          {!nowConfig.enabled ? (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs space-y-2.5 font-mono">
              <div className="text-slate-200 font-bold flex items-center gap-1.5">
                <span>⚡ Instant Node Synchronization In Progress</span>
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                The automated gateway is currently finalizing on-chain node sync. Please use the <strong>Direct Wallet Transfer</strong> option to complete your payment with instant verification by our trading desk.
              </p>
              <button
                type="button"
                onClick={() => setActiveMode('manual')}
                className="py-2 px-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs transition inline-flex items-center gap-1.5 shadow-md shadow-emerald-500/20"
              >
                <span>Switch to Direct Wallet Transfer</span>
                <span>→</span>
              </button>
            </div>
          ) : !activePayment ? (
            /* Coin selection and invoice creation */
            <div className="space-y-3">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Step 2: Choose Payment Cryptocurrency
              </label>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {NOWPAYMENTS_COINS.map((coin) => (
                  <button
                    key={coin.code}
                    type="button"
                    onClick={() => setSelectedCoin(coin.code)}
                    className={`p-2.5 rounded-xl border text-left transition select-none ${
                      selectedCoin === coin.code
                        ? 'border-emerald-400 bg-emerald-500/10 text-white font-bold'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-white'
                    }`}
                  >
                    <div className="text-xs font-bold text-white">{coin.name}</div>
                    <div className="text-[9px] text-slate-500 flex items-center justify-between mt-0.5">
                      <span>{coin.network}</span>
                      <span className="text-emerald-400 font-bold">{coin.badge}</span>
                    </div>
                  </button>
                ))}
              </div>

              {paymentError && (
                <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs">
                  {paymentError}
                </div>
              )}

              <button
                type="button"
                onClick={handleCreateNowPayment}
                disabled={generatingPayment}
                className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-xs uppercase rounded-xl transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
              >
                {generatingPayment ? (
                  <>
                    <span className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    <span>Generating Secure Blockchain Invoice...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span>Proceed with {selectedCoin.toUpperCase()} (${selectedTier.price.toFixed(2)})</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            /* Active Live Invoice Display */
            <div className="space-y-4 bg-slate-950 border border-slate-800 rounded-xl p-4">
              {/* Radar Status Bar */}
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    isSuccess
                      ? 'bg-emerald-400'
                      : activePayment.paymentStatus === 'confirming'
                      ? 'bg-amber-400 animate-ping'
                      : 'bg-emerald-400 animate-pulse'
                  }`} />
                  <span className="text-xs font-bold text-white uppercase tracking-wide">
                    {isSuccess
                      ? 'Payment Verified & Confirmed!'
                      : activePayment.paymentStatus === 'confirming'
                      ? 'Confirming on Blockchain...'
                      : 'Awaiting Blockchain Transfer'}
                  </span>
                </div>

                <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                  ID: {activePayment.paymentId}
                </span>
              </div>

              {isSuccess ? (
                <div className="text-center py-6 space-y-2">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center mx-auto text-emerald-400 text-xl font-bold">
                    ✓
                  </div>
                  <h4 className="text-base font-black text-white">Payment Confirmed!</h4>
                  <p className="text-xs text-slate-400">
                    Your {selectedTier.label} has been immediately activated!
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Amount and Address */}
                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    {/* QR Code */}
                    <div className="w-32 h-32 bg-white rounded-xl p-2 flex items-center justify-center shadow-lg shrink-0">
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(
                          activePayment.payAddress
                        )}`}
                        alt="Deposit QR"
                        className="w-full h-full object-contain"
                      />
                    </div>

                    <div className="flex-1 space-y-2 w-full">
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-slate-500 uppercase block">Send Exactly</span>
                        <div className="text-base font-black text-white flex items-center gap-1.5">
                          <span>{activePayment.payAmount}</span>
                          <span className="text-emerald-400 uppercase">{activePayment.payCurrency}</span>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[10px] text-slate-500 uppercase block">Deposit Address</span>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            readOnly
                            value={activePayment.payAddress}
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg py-1 px-2 text-[11px] text-slate-200 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => copyToClipboard(activePayment.payAddress)}
                            className="text-xs bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-3 py-1 rounded-lg transition"
                          >
                            {copied ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Live Status Radar */}
                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-[11px] space-y-1.5">
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Network Status:</span>
                      <span className="text-emerald-400 font-bold uppercase">
                        {activePayment.paymentStatus === 'waiting' && '⏳ Listening to Mempool / Network...'}
                        {activePayment.paymentStatus === 'confirming' && '🔄 Confirming Block Hashes...'}
                        {activePayment.paymentStatus === 'confirmed' && '🟢 Confirmed!'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 leading-normal">
                      The system polls NOWPayments every 4 seconds. Once your transfer is broadcast to the network, your pass will unlock automatically.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActivePayment(null)}
                    className="text-xs text-slate-500 hover:text-slate-300 underline block text-center w-full pt-1"
                  >
                    Cancel or Change Cryptocurrency
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* DIRECT COLD WALLET MANUAL TRANSFER FLOW                                   */}
      {/* ========================================================================= */}
      {activeMode === 'manual' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
              Select Wallet Currency
            </label>
            <div className="grid grid-cols-3 gap-2">
              {MANUAL_WALLETS.map((wallet) => (
                <button
                  key={wallet.id}
                  type="button"
                  onClick={() => setSelectedWallet(wallet)}
                  className={`p-2 rounded-xl border text-center transition ${
                    selectedWallet.id === wallet.id
                      ? 'border-emerald-400 bg-emerald-500/10 text-white font-bold'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-white'
                  }`}
                >
                  <div className="text-xs">{wallet.symbol}</div>
                  <div className="text-[9px] text-slate-500">{wallet.network}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Wallet Address */}
          <div className="bg-slate-950 border border-slate-800 p-3.5 rounded-xl space-y-2">
            <span className="text-[10px] text-slate-500 uppercase block">Deposit Address ({selectedWallet.network})</span>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={selectedWallet.address}
                className="flex-1 bg-slate-900 border border-slate-800 rounded-lg py-1 px-2 text-[11px] text-slate-300 font-mono"
              />
              <button
                type="button"
                onClick={() => copyToClipboard(selectedWallet.address)}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-white px-3 py-1 rounded-lg transition"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Hash Submission Form */}
          {manualSubmitted ? (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-center space-y-2">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 font-bold text-xs uppercase tracking-wider">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                Status: Pending Admin Approval
              </div>
              <p className="text-xs text-white font-bold">
                Transfer Proof Submitted!
              </p>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Your transaction hash has been recorded in the admin pending approval queue. An administrator will verify the on-chain deposit and activate your pass shortly.
              </p>
              <div className="pt-2 text-[10px] text-slate-500 font-mono break-all bg-slate-950 p-2 rounded-lg border border-slate-800">
                TXID: {txHash}
              </div>
              <button
                type="button"
                onClick={() => {
                  setManualSubmitted(false);
                  setTxHash('');
                }}
                className="mt-2 text-xs text-slate-400 hover:text-white underline"
              >
                Submit another transaction
              </button>
            </div>
          ) : (
            <form onSubmit={handleManualSubmit} className="space-y-2">
              <label htmlFor="tx-hash-input" className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Transaction Hash / TXID (Proof of Payment)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  id="tx-hash-input"
                  required
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder="Paste blockchain transaction hash..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={manualSubmitting || !txHash.trim()}
                  className="py-2 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-black text-xs uppercase rounded-xl transition whitespace-nowrap"
                >
                  {manualSubmitting ? 'Submitting...' : 'Submit Proof'}
                </button>
              </div>
              {manualError && (
                <p className="text-[11px] text-rose-400">{manualError}</p>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
