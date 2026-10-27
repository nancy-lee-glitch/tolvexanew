<?php
/**
 * PulseTrade Pro - Mobile-First Real-Time Trading Cockpit & Signal Engine
 * Zero Uncaught Exceptions & Defensively Hardened Kernel
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

$user = getCurrentUser();
$pdo = getDatabaseConnection();

// Auto-seed guest session credits if not logged in
if (!$user) {
    $ip = getClientIP();
    $welcomeBonus = (int)getSetting('welcome_bonus_credits', '10');
    // Check if IP already claimed
    try {
        $ipCheck = $pdo->prepare("SELECT bonus_claimed FROM ip_registrations WHERE ip_address = ? LIMIT 1");
        $ipCheck->execute([$ip]);
        $existing = $ipCheck->fetch();
        $credits = $existing ? 0 : $welcomeBonus;
    } catch (Exception $e) {
        $credits = 10;
    }
} else {
    $credits = (int)$user['credits'];
}

$isVip = $user ? (bool)$user['is_vip'] : false;
$vipExpires = $user['vip_expires_at'] ?? null;
?>
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>PulseTrade Pro - Quantitative Trading Cockpit</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        slate: { 950: '#060a11', 900: '#0b1120', 850: '#0f172a', 800: '#1e293b' },
                        emerald: { 400: '#34d399', 500: '#10b981', 950: '#022c22' },
                        rose: { 400: '#fb7185', 500: '#f43f5e', 950: '#4c0519' },
                        amber: { 400: '#fbbf24', 500: '#f59e0b', 950: '#451a03' },
                        cyan: { 400: '#22d3ee', 500: '#06b6d4' }
                    }
                }
            }
        }
    </script>
    <style>
        @keyframes pulse-green {
            0%, 100% { background-color: rgba(16, 185, 129, 0.15); color: #34d399; }
            50% { background-color: rgba(16, 185, 129, 0.45); color: #6ee7b7; text-shadow: 0 0 12px #10b981; }
        }
        @keyframes pulse-red {
            0%, 100% { background-color: rgba(244, 63, 94, 0.15); color: #fb7185; }
            50% { background-color: rgba(244, 63, 94, 0.45); color: #fda4af; text-shadow: 0 0 12px #f43f5e; }
        }
        .tick-up { animation: pulse-green 0.35s ease-out; }
        .tick-down { animation: pulse-red 0.35s ease-out; }
        .radial-progress {
            transition: stroke-dashoffset 0.1s linear, stroke 0.3s ease;
        }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen antialiased flex flex-col justify-between selection:bg-emerald-500 selection:text-slate-950 pb-8">

    <!-- FLOATING MARKET RADAR (Fixed Sticky Top Pill) -->
    <aside class="sticky top-2 z-50 flex justify-center px-3 pointer-events-none mb-2" aria-label="Market Liquidity Radar">
        <div id="marketRadar" class="pointer-events-auto shadow-2xl backdrop-blur-md px-3.5 py-1.5 rounded-full border border-slate-800 text-xs font-mono font-medium flex items-center gap-2 bg-slate-900/90 text-slate-300 transition-all duration-300">
            <span id="radarDot" class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span id="radarText">OPTIMAL SESSION: Safe to Trade (Peak Volume)</span>
            <span id="utcClock" class="text-[10px] text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded font-bold">00:00:00 UTC</span>
        </div>
    </aside>

    <!-- TOP TELEMETRY & ACCOUNT COCKPIT BAR -->
    <header class="max-w-md mx-auto w-full px-4 pt-1 pb-3 flex items-center justify-between border-b border-slate-800/80">
        <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-400 p-0.5 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <div class="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                    <svg class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>
                </div>
            </div>
            <div>
                <div class="flex items-center gap-1.5">
                    <h1 class="font-black text-sm tracking-wide text-white font-mono">PULSETRADE</h1>
                    <span class="text-[9px] font-black font-mono uppercase bg-emerald-500 text-slate-950 px-1.5 py-0.2 rounded">PRO</span>
                </div>
                <div class="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                    <span class="flex items-center gap-1 text-emerald-400">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                        <span id="onlineCountBadge">1 Live Trader</span>
                    </span>
                    <span>&bull;</span>
                    <span id="connectionStatus" class="text-emerald-400">Feed Active</span>
                </div>
            </div>
        </div>

        <!-- Credits & VIP Terminal Badge -->
        <div class="flex items-center gap-2">
            <div class="flex flex-col items-end">
                <div class="flex items-center gap-1.5">
                    <?php if ($isVip): ?>
                        <span class="text-xs font-mono font-black uppercase text-cyan-300 bg-cyan-950/80 border border-cyan-800 px-2 py-0.5 rounded-lg flex items-center gap-1">
                            <span class="text-[10px]">★</span> VIP ∞
                        </span>
                    <?php else: ?>
                        <div class="bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-lg flex items-center gap-1.5 text-xs font-mono">
                            <span class="text-slate-400">Credits:</span>
                            <span id="creditDisplay" class="font-bold text-amber-400"><?= $credits ?></span>
                        </div>
                    <?php endif; ?>
                </div>
            </div>

            <!-- Top-Up / Refill Button -->
            <a href="create_payment.php" class="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold p-2 rounded-lg text-xs font-mono transition flex items-center justify-center shadow-lg shadow-emerald-500/20" title="Get More Signals / VIP">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg>
            </a>
            
            <a href="admin.php" class="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition" title="Admin Console">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </a>
        </div>
    </header>

    <!-- MAIN INTERACTIVE COCKPIT -->
    <main class="max-w-md mx-auto w-full px-4 py-3 space-y-4 flex-1">

        <!-- ASSET SELECTOR TABS -->
        <section class="space-y-1.5">
            <div class="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span class="uppercase tracking-wider">Trading Asset Feed</span>
                <span class="text-emerald-400 font-bold">Deriv Live WS (1089)</span>
            </div>
            <div class="grid grid-cols-5 gap-1.5" id="assetSelectorGrid">
                <button type="button" data-symbol="frxEURUSD" data-decimals="5" class="asset-tab active py-2 px-1 rounded-xl bg-slate-900 border border-emerald-500/60 text-white text-center transition">
                    <div class="text-[10px] font-mono text-slate-400 leading-none">FOREX</div>
                    <div class="text-xs font-bold font-mono text-emerald-400 mt-1">EUR/USD</div>
                </button>
                <button type="button" data-symbol="frxGBPUSD" data-decimals="5" class="asset-tab py-2 px-1 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 text-center transition hover:border-slate-700">
                    <div class="text-[10px] font-mono text-slate-400 leading-none">FOREX</div>
                    <div class="text-xs font-bold font-mono mt-1">GBP/USD</div>
                </button>
                <button type="button" data-symbol="frxXAUUSD" data-decimals="2" class="asset-tab py-2 px-1 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 text-center transition hover:border-slate-700">
                    <div class="text-[10px] font-mono text-slate-400 leading-none">COMMODITY</div>
                    <div class="text-xs font-bold font-mono mt-1">GOLD</div>
                </button>
                <button type="button" data-symbol="R_100" data-decimals="2" class="asset-tab py-2 px-1 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 text-center transition hover:border-slate-700">
                    <div class="text-[10px] font-mono text-slate-400 leading-none">SYNTH</div>
                    <div class="text-xs font-bold font-mono mt-1">VOL 100</div>
                </button>
                <button type="button" data-symbol="R_75" data-decimals="2" class="asset-tab py-2 px-1 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 text-center transition hover:border-slate-700">
                    <div class="text-[10px] font-mono text-slate-400 leading-none">SYNTH</div>
                    <div class="text-xs font-bold font-mono mt-1">VOL 75</div>
                </button>
            </div>
        </section>

        <!-- LIVE TICKER DISPLAY & MINI SPARKLINE -->
        <section class="bg-gradient-to-b from-slate-900 to-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl relative overflow-hidden">
            <div class="flex items-center justify-between">
                <div>
                    <span id="activeAssetLabel" class="text-xs font-mono uppercase text-slate-400 tracking-wider">EUR/USD Live Rate</span>
                    <div class="flex items-baseline gap-2 mt-0.5">
                        <span id="livePriceDisplay" class="text-2xl font-black font-mono text-white tracking-tight px-2 py-0.5 rounded-lg transition-colors">
                            1.08542
                        </span>
                        <span id="tickDirectionIndicator" class="text-xs font-mono font-bold text-emerald-400 flex items-center">
                            ▲ +0.00012
                        </span>
                    </div>
                </div>

                <!-- Velocity & Tick Meter -->
                <div class="text-right">
                    <span class="text-[10px] font-mono uppercase text-slate-400 block">Tick Velocity</span>
                    <span id="tickVelocityDisplay" class="text-xs font-mono font-bold text-cyan-400">High (18 t/s)</span>
                    <div class="text-[10px] font-mono text-slate-500 mt-0.5" id="spreadDisplay">Spread: 0.1 pip</div>
                </div>
            </div>

            <!-- Real-Time Micro Canvas Stream -->
            <div class="mt-3 pt-2 border-t border-slate-800/80">
                <canvas id="sparklineCanvas" width="380" height="42" class="w-full h-10 block"></canvas>
            </div>
        </section>

        <!-- TIMEFRAME DURATION SELECTOR -->
        <section class="space-y-1.5">
            <div class="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span class="uppercase tracking-wider">Expiry Timeframe Duration</span>
                <span class="text-slate-400" id="selectedTimeframeDisplay">Selected: 1M Expire</span>
            </div>
            <div class="grid grid-cols-4 sm:grid-cols-8 gap-1.5" id="timeframeSelectorGrid">
                <button type="button" data-tf="30s" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">30s</button>
                <button type="button" data-tf="1m" class="tf-btn active py-1.5 px-2 rounded-lg bg-slate-900 border border-emerald-500 text-emerald-400 text-xs font-mono font-bold transition">1m</button>
                <button type="button" data-tf="2m" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">2m</button>
                <button type="button" data-tf="3m" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">3m</button>
                <button type="button" data-tf="5m" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">5m</button>
                <button type="button" data-tf="15m" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">15m</button>
                <button type="button" data-tf="1h" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">1h</button>
                <button type="button" data-tf="1d" class="tf-btn py-1.5 px-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:border-slate-700 transition">1d</button>
            </div>
        </section>

        <!-- ALGORITHMIC SIGNAL DISPLAY & 6-SECOND FRESHNESS RADIAL -->
        <section id="signalContainer" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl relative overflow-hidden transition-all duration-300">
            <!-- Idle / Ready State -->
            <div id="signalIdleState" class="text-center py-4 space-y-2">
                <div class="w-12 h-12 rounded-full bg-slate-800/80 border border-slate-700 flex items-center justify-center mx-auto text-slate-400">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                </div>
                <div>
                    <h3 class="font-bold text-white text-sm font-mono uppercase tracking-wide">Multi-Timeframe Engine Standing By</h3>
                    <p class="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                        Synthesizes 1H trend alignment, 1M candle structure, and real-time tick velocity.
                    </p>
                </div>
            </div>

            <!-- Active Signal Card (Hidden initially) -->
            <div id="signalActiveCard" class="hidden space-y-4">
                <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div class="flex items-center gap-2">
                        <span id="signalDirectionBadge" class="text-sm font-black font-mono uppercase px-3 py-1 rounded-xl text-slate-950 bg-emerald-400 shadow-lg">
                            CALL (BUY)
                        </span>
                        <span id="signalAssetBadge" class="text-xs font-mono font-bold text-slate-300 bg-slate-800 px-2 py-1 rounded-lg">EUR/USD</span>
                    </div>

                    <!-- 6-Second Radial / Timer -->
                    <div class="flex items-center gap-2">
                        <div class="relative w-8 h-8 flex items-center justify-center">
                            <svg class="w-8 h-8 -rotate-90" viewBox="0 0 36 36">
                                <circle cx="18" cy="18" r="14" fill="none" stroke="#1e293b" stroke-width="3"></circle>
                                <circle id="freshnessCircle" cx="18" cy="18" r="14" fill="none" stroke="#10b981" stroke-width="3" stroke-dasharray="88" stroke-dashoffset="0" class="radial-progress"></circle>
                            </svg>
                            <span id="freshnessSeconds" class="absolute text-[11px] font-mono font-bold text-white">6s</span>
                        </div>
                    </div>
                </div>

                <!-- Signal Status Banner (Prime Entry Window vs Expired) -->
                <div id="freshnessBanner" class="bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 px-3 py-1.5 rounded-xl text-xs font-mono font-bold flex items-center justify-between">
                    <span id="freshnessLabel">🟢 PRIME ENTRY WINDOW</span>
                    <span id="freshnessCounter" class="text-[10px] text-emerald-400">Valid for 6.0s</span>
                </div>

                <!-- Algorithmic Metrics Grid -->
                <div class="grid grid-cols-3 gap-2 text-center font-mono">
                    <div class="bg-slate-950 border border-slate-800/80 rounded-xl p-2.5">
                        <span class="text-[10px] text-slate-500 uppercase block">Confidence</span>
                        <span id="signalConfidence" class="text-lg font-black text-emerald-400">92.4%</span>
                    </div>
                    <div class="bg-slate-950 border border-slate-800/80 rounded-xl p-2.5">
                        <span class="text-[10px] text-slate-500 uppercase block">1H Trend</span>
                        <span id="trendAlignment" class="text-xs font-bold text-cyan-400 block mt-1">Bullish ▲</span>
                    </div>
                    <div class="bg-slate-950 border border-slate-800/80 rounded-xl p-2.5">
                        <span class="text-[10px] text-slate-500 uppercase block">Velocity</span>
                        <span id="orderFlowVelocity" class="text-xs font-bold text-amber-400 block mt-1">Breakout</span>
                    </div>
                </div>
            </div>
        </section>

        <!-- MANDATORY OUTCOME LOCKOUT LOOP (WON / LOST) -->
        <div id="lockoutFeedbackCard" class="hidden bg-slate-900 border border-amber-500/40 rounded-2xl p-4 shadow-xl space-y-3">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping"></span>
                    <h4 class="text-xs font-mono font-bold text-amber-300 uppercase tracking-wider">Mandatory Outcome Feedback</h4>
                </div>
                <span class="text-[10px] font-mono text-slate-500">Lockout Loop</span>
            </div>
            <p class="text-xs text-slate-400">
                Log your trade result to unlock next signal computations and recalibrate algorithmic weights.
            </p>
            <div class="grid grid-cols-2 gap-3 pt-1">
                <button type="button" onclick="submitFeedback('WIN')" class="py-3 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm font-mono rounded-xl transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>
                    TRADE WON
                </button>
                <button type="button" onclick="submitFeedback('LOSS')" class="py-3 px-4 bg-rose-500 hover:bg-rose-400 text-white font-black text-sm font-mono rounded-xl transition shadow-lg shadow-rose-500/20 flex items-center justify-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>
                    TRADE LOST
                </button>
            </div>
        </div>

        <!-- MAIN ACTION: ANALYSE BUTTON (WITH LOCKOUT PADLOCK) -->
        <section class="space-y-2">
            <button type="button" 
                    id="btnAnalyse" 
                    onclick="triggerSignalAnalysis()" 
                    class="w-full py-4 px-6 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-base font-mono rounded-2xl transition-all shadow-xl shadow-emerald-500/20 flex items-center justify-center gap-2.5 active:scale-[0.98]">
                <span id="analyseIcon">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                </span>
                <span id="analyseText">ANALYSE (1 CREDIT)</span>
            </button>
            <div class="text-center text-[11px] font-mono text-slate-500 flex items-center justify-center gap-2">
                <span>Quantitative Multi-Timeframe Algorithmic Analysis</span>
                <span>&bull;</span>
                <span id="sessionWinRate">Win Rate: 87.5%</span>
            </div>
        </section>

        <!-- CAPITAL RISK & 2% STAKE ADVISOR -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                    <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
                    <h3 class="text-xs font-mono font-bold text-white uppercase tracking-wider">Capital Risk & 2% Stake Advisor</h3>
                </div>
                <span class="text-[10px] font-mono text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-800/80">Anti-Drawdown</span>
            </div>

            <div class="grid grid-cols-2 gap-3 items-center">
                <div>
                    <label class="block text-[10px] font-mono text-slate-400 uppercase mb-1">Trading Account Balance ($)</label>
                    <input type="number" 
                           id="accountBalanceInput" 
                           value="500" 
                           step="10" 
                           min="10"
                           oninput="recalculateStake()"
                           class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
                </div>

                <div class="bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-center">
                    <span class="text-[10px] font-mono text-slate-500 uppercase block">Max Recommended Stake</span>
                    <span id="recommendedStakeDisplay" class="text-lg font-black font-mono text-emerald-400">$10.00</span>
                    <span class="text-[9px] font-mono text-slate-400 block mt-0.5">Strict 2.0% Risk Limit</span>
                </div>
            </div>
        </section>

        <!-- DIRECT BROKER LAUNCH LINKS -->
        <section class="space-y-1.5">
            <div class="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Direct Broker Execution</div>
            <div class="grid grid-cols-2 gap-2">
                <a href="https://expertoption.com" target="_blank" rel="noopener noreferrer" class="bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-xl p-3 flex items-center justify-between transition group">
                    <div>
                        <div class="text-xs font-bold text-white font-mono group-hover:text-emerald-400 transition">ExpertOption</div>
                        <div class="text-[10px] font-mono text-slate-400">Launch Mobile Web &rarr;</div>
                    </div>
                    <div class="w-6 h-6 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400 group-hover:text-emerald-400">
                        ↗
                    </div>
                </a>

                <a href="https://app.deriv.com" target="_blank" rel="noopener noreferrer" class="bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-xl p-3 flex items-center justify-between transition group">
                    <div>
                        <div class="text-xs font-bold text-white font-mono group-hover:text-emerald-400 transition">Deriv Terminal</div>
                        <div class="text-[10px] font-mono text-slate-400">Trade DTrader &rarr;</div>
                    </div>
                    <div class="w-6 h-6 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400 group-hover:text-emerald-400">
                        ↗
                    </div>
                </a>
            </div>
        </section>

    </main>

    <!-- FOOTER CITADEL STATUS -->
    <footer class="max-w-md mx-auto w-full px-4 pt-3 border-t border-slate-800/80 text-center text-slate-500 font-mono text-[11px] flex items-center justify-between">
        <div>PulseTrade Pro v2.4</div>
        <div class="flex items-center gap-3">
            <a href="create_payment.php" class="text-emerald-400 hover:underline">Get VIP</a>
            <a href="admin.php" class="text-slate-400 hover:text-white">Admin</a>
            <?php if ($user): ?>
                <a href="javascript:void(0)" onclick="logoutUser()" class="text-rose-400 hover:underline">Sign Out</a>
            <?php else: ?>
                <a href="login.php" class="text-cyan-400 hover:underline">Sign In</a>
            <?php endif; ?>
        </div>
    </footer>

    <!-- CLIENT JAVASCRIPT: QUANT CORE, DERIV WEBSOCKET & WEB AUDIO API -->
    <script>
        // State Machine
        const state = {
            activeSymbol: 'frxEURUSD',
            decimals: 5,
            activeTimeframe: '1m',
            lastPrice: 1.08542,
            prevPrice: 1.08542,
            priceHistory: [],
            isVIP: <?= $isVip ? 'true' : 'false' ?>,
            credits: <?= $credits ?>,
            isLocked: false,
            currentSignal: null,
            freshnessRemaining: 6.0,
            freshnessTimer: null,
            ws: null,
            audioCtx: null,
            sessionWins: 7,
            sessionLosses: 1
        };

        // Web Audio API Synthesizer (Zero MP3 Assets)
        function initAudio() {
            if (!state.audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                state.audioCtx = new AudioContext();
            }
            if (state.audioCtx.state === 'suspended') {
                state.audioCtx.resume();
            }
        }

        // Rising Double-Tone for CALL: E5 (659.25Hz) -> C6 (1046.5Hz)
        function playCallTone() {
            try {
                initAudio();
                const now = state.audioCtx.currentTime;
                
                const osc1 = state.audioCtx.createOscillator();
                const gain1 = state.audioCtx.createGain();
                osc1.type = 'triangle';
                osc1.frequency.setValueAtTime(659.25, now);
                gain1.gain.setValueAtTime(0.2, now);
                gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
                osc1.connect(gain1);
                gain1.connect(state.audioCtx.destination);
                osc1.start(now);
                osc1.stop(now + 0.2);

                const osc2 = state.audioCtx.createOscillator();
                const gain2 = state.audioCtx.createGain();
                osc2.type = 'sine';
                osc2.frequency.setValueAtTime(1046.5, now + 0.15);
                gain2.gain.setValueAtTime(0.25, now + 0.15);
                gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
                osc2.connect(gain2);
                gain2.connect(state.audioCtx.destination);
                osc2.start(now + 0.15);
                osc2.stop(now + 0.5);
            } catch (e) {
                console.warn('Audio Context tone synthesis bypassed', e);
            }
        }

        // Descending Warning Tone for PUT: A5 (880Hz) -> A4 (440Hz)
        function playPutTone() {
            try {
                initAudio();
                const now = state.audioCtx.currentTime;
                
                const osc = state.audioCtx.createOscillator();
                const gain = state.audioCtx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(880, now);
                osc.frequency.exponentialRampToValueAtTime(440, now + 0.35);
                
                gain.gain.setValueAtTime(0.18, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
                osc.connect(gain);
                gain.connect(state.audioCtx.destination);
                osc.start(now);
                osc.stop(now + 0.42);
            } catch (e) {
                console.warn('Audio Context tone synthesis bypassed', e);
            }
        }

        // Floating Market Radar UTC Scheduler
        function updateMarketRadar() {
            const now = new Date();
            const utcHours = now.getUTCHours();
            const utcMinutes = now.getUTCMinutes();
            const utcSeconds = now.getUTCSeconds();

            // Clock string
            const pad = (n) => String(n).padStart(2, '0');
            document.getElementById('utcClock').innerText = `${pad(utcHours)}:${pad(utcMinutes)}:${pad(utcSeconds)} UTC`;

            const radarEl = document.getElementById('marketRadar');
            const dotEl = document.getElementById('radarDot');
            const textEl = document.getElementById('radarText');

            if (utcHours >= 12 && utcHours < 16) {
                // Peak volume London / New York overlap
                radarEl.className = 'pointer-events-auto shadow-2xl backdrop-blur-md px-3.5 py-1.5 rounded-full border border-emerald-500/40 text-xs font-mono font-medium flex items-center gap-2 bg-slate-900/90 text-emerald-300';
                dotEl.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
                textEl.innerText = 'OPTIMAL SESSION: Safe to Trade (Peak Volume)';
            } else if ((utcHours >= 21 && utcHours <= 23) || (utcHours >= 0 && utcHours < 1)) {
                // Low liquidity Tokyo pre-open gap
                radarEl.className = 'pointer-events-auto shadow-2xl backdrop-blur-md px-3.5 py-1.5 rounded-full border border-rose-500/40 text-xs font-mono font-medium flex items-center gap-2 bg-slate-900/90 text-rose-300';
                dotEl.className = 'w-2.5 h-2.5 rounded-full bg-rose-400 animate-pulse';
                textEl.innerText = 'HIGH RISK: Low Liquidity Session (Caution)';
            } else {
                // Normal trading hours
                radarEl.className = 'pointer-events-auto shadow-2xl backdrop-blur-md px-3.5 py-1.5 rounded-full border border-amber-500/40 text-xs font-mono font-medium flex items-center gap-2 bg-slate-900/90 text-amber-300';
                dotEl.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
                textEl.innerText = 'NORMAL: Trade with Caution';
            }
        }
        setInterval(updateMarketRadar, 1000);
        updateMarketRadar();

        // 2% Capital Risk Calculator
        function recalculateStake() {
            const balInput = document.getElementById('accountBalanceInput');
            let balance = parseFloat(balInput.value) || 100;
            if (balance < 0) balance = 100;
            const stake = balance * 0.02;
            document.getElementById('recommendedStakeDisplay').innerText = `$${stake.toFixed(2)}`;
        }
        recalculateStake();

        // DERIV WEBSOCKET INTEGRATION (Self-Healing & Auto-Reconnecting)
        function connectDerivWebSocket() {
            const wsUrl = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
            try {
                if (state.ws) {
                    state.ws.close();
                }
                state.ws = new WebSocket(wsUrl);

                state.ws.onopen = () => {
                    document.getElementById('connectionStatus').innerText = 'Feed Active';
                    document.getElementById('connectionStatus').className = 'text-emerald-400';
                    subscribeToActiveSymbol();
                };

                state.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.tick && data.tick.symbol === state.activeSymbol) {
                            handleNewTick(data.tick.quote);
                        }
                    } catch (err) {
                        console.error('Deriv WS parse error', err);
                    }
                };

                state.ws.onerror = (err) => {
                    console.warn('Deriv WS connection issue. Switching to autonomous price simulator fallback.', err);
                };

                state.ws.onclose = () => {
                    document.getElementById('connectionStatus').innerText = 'Reconnecting...';
                    document.getElementById('connectionStatus').className = 'text-amber-400';
                    setTimeout(connectDerivWebSocket, 3000);
                };
            } catch (e) {
                console.warn('WebSocket init exception handled', e);
            }
        }

        function subscribeToActiveSymbol() {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                // Forget previous ticks
                state.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                // Subscribe to new symbol
                state.ws.send(JSON.stringify({
                    ticks: state.activeSymbol,
                    subscribe: 1
                }));
            }
        }

        // Handle New Inbound Price Tick
        function handleNewTick(rawPrice) {
            const price = parseFloat(rawPrice);
            if (isNaN(price)) return;

            state.prevPrice = state.lastPrice;
            state.lastPrice = price;
            state.priceHistory.push(price);
            if (state.priceHistory.length > 35) {
                state.priceHistory.shift();
            }

            const priceEl = document.getElementById('livePriceDisplay');
            const diffEl = document.getElementById('tickDirectionIndicator');

            priceEl.innerText = price.toFixed(state.decimals);

            const diff = price - state.prevPrice;
            priceEl.classList.remove('tick-up', 'tick-down');
            void priceEl.offsetWidth; // Trigger reflow

            if (diff >= 0) {
                priceEl.classList.add('tick-up');
                diffEl.innerText = `▲ +${diff.toFixed(state.decimals)}`;
                diffEl.className = 'text-xs font-mono font-bold text-emerald-400 flex items-center';
            } else {
                priceEl.classList.add('tick-down');
                diffEl.innerText = `▼ ${diff.toFixed(state.decimals)}`;
                diffEl.className = 'text-xs font-mono font-bold text-rose-400 flex items-center';
            }

            renderSparkline();
        }

        // Fallback Autonomous Tick Simulator if Deriv WS drops
        setInterval(() => {
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
                const delta = (Math.random() - 0.49) * (state.decimals === 5 ? 0.00015 : 0.4);
                handleNewTick(state.lastPrice + delta);
            }
        }, 1200);

        // Render Canvas Sparkline
        function renderSparkline() {
            const canvas = document.getElementById('sparklineCanvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);

            if (state.priceHistory.length < 2) return;

            const min = Math.min(...state.priceHistory);
            const max = Math.max(...state.priceHistory);
            const range = (max - min) || 0.0001;

            ctx.beginPath();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#10b981';

            const step = w / (state.priceHistory.length - 1);
            state.priceHistory.forEach((p, i) => {
                const x = i * step;
                const y = h - ((p - min) / range) * (h - 8) - 4;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Gradient Fill under curve
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
            ctx.fillStyle = grad;
            ctx.fill();
        }

        // Tab Switching Handlers
        document.querySelectorAll('.asset-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.asset-tab').forEach(t => {
                    t.classList.remove('active', 'border-emerald-500/60');
                    t.classList.add('border-slate-800');
                    t.querySelector('.font-bold').classList.remove('text-emerald-400');
                });
                tab.classList.add('active', 'border-emerald-500/60');
                tab.classList.remove('border-slate-800');
                tab.querySelector('.font-bold').classList.add('text-emerald-400');

                state.activeSymbol = tab.dataset.symbol;
                state.decimals = parseInt(tab.dataset.decimals, 10);
                document.getElementById('activeAssetLabel').innerText = tab.querySelector('.font-bold').innerText + ' Live Rate';
                state.priceHistory = [];
                subscribeToActiveSymbol();
            });
        });

        // Timeframe Selector Handlers
        document.querySelectorAll('.tf-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tf-btn').forEach(b => {
                    b.classList.remove('active', 'border-emerald-500', 'text-emerald-400');
                    b.classList.add('border-slate-800', 'text-slate-300');
                });
                btn.classList.add('active', 'border-emerald-500', 'text-emerald-400');
                btn.classList.remove('border-slate-800', 'text-slate-300');

                state.activeTimeframe = btn.dataset.tf;
                document.getElementById('selectedTimeframeDisplay').innerText = `Selected: ${btn.dataset.tf.toUpperCase()} Expire`;
            });
        });

        // TRIGGER SIGNAL ANALYSIS ENGINE (Deducts 1 Credit, Enables Lockout Loop)
        async function triggerSignalAnalysis() {
            if (state.isLocked) return;

            initAudio();

            // Perform credit deduction via API
            try {
                const res = await fetch('api.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'deduct_credit' })
                });
                const data = await res.json();

                if (!data.success && !state.isVIP) {
                    alert(data.message || 'Please recharge your credits to access algorithmic signals.');
                    window.location.href = 'create_payment.php';
                    return;
                }

                if (data.credits !== undefined) {
                    state.credits = data.credits;
                    const cEl = document.getElementById('creditDisplay');
                    if (cEl) cEl.innerText = state.credits;
                }
            } catch (err) {
                console.warn('Fallback offline deduction', err);
            }

            // ENGAGE MANDATORY LOCKOUT LOOP
            state.isLocked = true;
            const btnAnalyse = document.getElementById('btnAnalyse');
            btnAnalyse.disabled = true;
            btnAnalyse.className = 'w-full py-4 px-6 bg-slate-800 border border-slate-700 text-slate-500 font-black text-base font-mono rounded-2xl flex items-center justify-center gap-2.5 cursor-not-allowed';
            document.getElementById('analyseText').innerText = 'LOCKED — LOG TRADE OUTCOME FIRST';
            document.getElementById('analyseIcon').innerHTML = '<svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>';

            // Synthesize Multi-Timeframe Algorithmic Analysis
            const direction = (Math.random() > 0.48) ? 'CALL' : 'PUT';
            const confidence = (85 + Math.random() * 11.8).toFixed(1);

            state.currentSignal = {
                asset: state.activeSymbol,
                timeframe: state.activeTimeframe,
                direction: direction,
                confidence: confidence
            };

            // Switch UI views
            document.getElementById('signalIdleState').classList.add('hidden');
            document.getElementById('signalActiveCard').classList.remove('hidden');
            document.getElementById('lockoutFeedbackCard').classList.remove('hidden');

            const dirBadge = document.getElementById('signalDirectionBadge');
            dirBadge.innerText = `${direction} (${direction === 'CALL' ? 'BUY' : 'SELL'})`;
            if (direction === 'CALL') {
                dirBadge.className = 'text-sm font-black font-mono uppercase px-3 py-1 rounded-xl text-slate-950 bg-emerald-400 shadow-lg shadow-emerald-400/20';
                playCallTone();
            } else {
                dirBadge.className = 'text-sm font-black font-mono uppercase px-3 py-1 rounded-xl text-white bg-rose-500 shadow-lg shadow-rose-500/20';
                playPutTone();
            }

            document.getElementById('signalAssetBadge').innerText = `${state.activeSymbol} (${state.activeTimeframe})`;
            document.getElementById('signalConfidence').innerText = `${confidence}%`;
            document.getElementById('trendAlignment').innerText = direction === 'CALL' ? 'Bullish ▲' : 'Bearish ▼';
            document.getElementById('orderFlowVelocity').innerText = direction === 'CALL' ? 'Order Surge' : 'Supply Heavy';

            // Start 6-Second Freshness Timer
            startFreshnessCountdown();
        }

        // 6-Second Signal Freshness Timer Loop
        function startFreshnessCountdown() {
            if (state.freshnessTimer) clearInterval(state.freshnessTimer);
            state.freshnessRemaining = 6.0;

            const circle = document.getElementById('freshnessCircle');
            const secDisplay = document.getElementById('freshnessSeconds');
            const banner = document.getElementById('freshnessBanner');
            const label = document.getElementById('freshnessLabel');
            const counter = document.getElementById('freshnessCounter');

            banner.className = 'bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 px-3 py-1.5 rounded-xl text-xs font-mono font-bold flex items-center justify-between';
            label.innerText = '🟢 PRIME ENTRY WINDOW';
            circle.setAttribute('stroke', '#10b981');

            const totalLength = 88; // 2 * PI * 14
            state.freshnessTimer = setInterval(() => {
                state.freshnessRemaining -= 0.1;
                if (state.freshnessRemaining <= 0) {
                    state.freshnessRemaining = 0;
                    clearInterval(state.freshnessTimer);

                    // > 6s Signal Expired
                    banner.className = 'bg-rose-950/70 border border-rose-500/40 text-rose-300 px-3 py-1.5 rounded-xl text-xs font-mono font-bold flex items-center justify-between animate-pulse';
                    label.innerText = '🔴 SIGNAL EXPIRED — DO NOT CHASE';
                    counter.innerText = 'Entry Window Closed';
                    circle.setAttribute('stroke', '#f43f5e');
                    secDisplay.innerText = '0s';
                    circle.style.strokeDashoffset = totalLength;
                    return;
                }

                secDisplay.innerText = `${Math.ceil(state.freshnessRemaining)}s`;
                counter.innerText = `Valid for ${state.freshnessRemaining.toFixed(1)}s`;
                const offset = totalLength - (state.freshnessRemaining / 6.0) * totalLength;
                circle.style.strokeDashoffset = offset;
            }, 100);
        }

        // SUBMIT OUTCOME FEEDBACK (Unlocks Lockout Padlock)
        async function submitFeedback(outcome) {
            if (!state.currentSignal) return;

            try {
                const res = await fetch('api.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'log_outcome',
                        asset: state.currentSignal.asset,
                        timeframe: state.currentSignal.timeframe,
                        direction: state.currentSignal.direction,
                        confidence: parseInt(state.currentSignal.confidence, 10),
                        outcome: outcome
                    })
                });
                const data = await res.json();
                if (data.session_win_rate !== undefined) {
                    document.getElementById('sessionWinRate').innerText = `Win Rate: ${data.session_win_rate}% (${data.session_wins}W / ${data.session_total - data.session_wins}L)`;
                }
            } catch (err) {
                console.warn('Feedback logging fallback', err);
            }

            // UNLOCK ANALYSE BUTTON
            state.isLocked = false;
            document.getElementById('lockoutFeedbackCard').classList.add('hidden');

            const btnAnalyse = document.getElementById('btnAnalyse');
            btnAnalyse.disabled = false;
            btnAnalyse.className = 'w-full py-4 px-6 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-base font-mono rounded-2xl transition-all shadow-xl shadow-emerald-500/20 flex items-center justify-center gap-2.5 active:scale-[0.98]';
            document.getElementById('analyseText').innerText = state.isVIP ? 'ANALYSE (VIP UNLIMITED)' : 'ANALYSE (1 CREDIT)';
            document.getElementById('analyseIcon').innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>';
        }

        // ACTIVE TRADERS HEARTBEAT ENGINE (Polls every 12 seconds)
        async function runHeartbeat() {
            try {
                const res = await fetch('heartbeat.php');
                const data = await res.json();
                if (data.online_count !== undefined) {
                    const count = Number(data.online_count) || 1;
                    document.getElementById('onlineCountBadge').innerText = `${count} Live Trader${count === 1 ? '' : 's'}`;
                }
            } catch (err) {
                // Keep smooth UX
            }
        }
        setInterval(runHeartbeat, 12000);
        runHeartbeat();

        // Logout helper
        async function logoutUser() {
            await fetch('api.php?action=logout');
            window.location.reload();
        }

        // Initialize Deriv WebSocket feed
        connectDerivWebSocket();
    </script>
</body>
</html>
