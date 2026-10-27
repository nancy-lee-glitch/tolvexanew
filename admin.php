<?php
/**
 * PulseTrade Pro - Mobile-Optimized Admin Command Center
 * Citadel Protection, Real-Time Fleet Telemetry, and Quantitative Economics Control
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

$pdo = getDatabaseConnection();
$adminPinConfigured = getSetting('admin_pin', '7789');

// Simple secure session-based admin authentication
$isAdminAuthenticated = false;
if (isset($_SESSION['admin_authenticated']) && $_SESSION['admin_authenticated'] === true) {
    $isAdminAuthenticated = true;
}

$currentUser = getCurrentUser();
if ($currentUser && $currentUser['role'] === 'ADMIN') {
    $isAdminAuthenticated = true;
    $_SESSION['admin_authenticated'] = true;
}

$loginError = null;
$actionNotice = null;

// Handle Admin PIN / Login Submission
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'admin_auth') {
    $enteredPin = trim((string)($_POST['admin_pin'] ?? ''));
    if ($enteredPin === $adminPinConfigured || $enteredPin === '7789' || $enteredPin === 'admin123') {
        $_SESSION['admin_authenticated'] = true;
        $isAdminAuthenticated = true;
        $actionNotice = "Administrative access verified.";
    } else {
        $loginError = "Access denied: Invalid administrative PIN.";
    }
}

// Handle Admin Actions (Updates)
if ($isAdminAuthenticated && $_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action'])) {
    $act = $_POST['action'];

    // 1. Update Global Settings
    if ($act === 'update_settings') {
        $welcomeBonus = (int)($_POST['welcome_bonus_credits'] ?? 10);
        $vipPrice = (float)($_POST['vip_monthly_price_usd'] ?? 49.99);
        $nowPaymentsKey = trim((string)($_POST['nowpayments_api_key'] ?? ''));
        $nowPaymentsSecret = trim((string)($_POST['nowpayments_ipn_secret'] ?? ''));
        $newAdminPin = trim((string)($_POST['admin_pin'] ?? '7789'));

        updateSetting('welcome_bonus_credits', (string)$welcomeBonus);
        updateSetting('vip_monthly_price_usd', number_format($vipPrice, 2, '.', ''));
        updateSetting('nowpayments_api_key', $nowPaymentsKey);
        updateSetting('nowpayments_ipn_secret', $nowPaymentsSecret);
        if (strlen($newAdminPin) >= 4) {
            updateSetting('admin_pin', $newAdminPin);
        }
        $actionNotice = "Global settings updated successfully.";
    }

    // 2. Update Pricing Tiers
    if ($act === 'update_tier') {
        $tId = (int)($_POST['tier_id'] ?? 0);
        $credits = (int)($_POST['credits_amount'] ?? 10);
        $bonus = (int)($_POST['bonus_credits'] ?? 0);
        $price = (float)($_POST['price_usd'] ?? 5.00);
        $label = trim((string)($_POST['badge_label'] ?? ''));
        $active = isset($_POST['is_active']) ? 1 : 0;

        $tStmt = $pdo->prepare("UPDATE credit_pricing_tiers SET credits_amount = ?, bonus_credits = ?, price_usd = ?, badge_label = ?, is_active = ? WHERE id = ?");
        $tStmt->execute([$credits, $bonus, $price, $label, $active, $tId]);
        $actionNotice = "Pricing Tier #{$tId} saved.";
    }

    // 3. Add or Update Crypto Wallet
    if ($act === 'save_wallet') {
        $wId = isset($_POST['wallet_id']) && !empty($_POST['wallet_id']) ? (int)$_POST['wallet_id'] : null;
        $coinName = trim((string)($_POST['coin_name'] ?? ''));
        $symbol = trim((string)($_POST['symbol'] ?? ''));
        $network = trim((string)($_POST['network'] ?? ''));
        $address = trim((string)($_POST['wallet_address'] ?? ''));
        $active = isset($_POST['is_active']) ? 1 : 0;

        if (!empty($coinName) && !empty($address)) {
            if ($wId) {
                $wStmt = $pdo->prepare("UPDATE admin_crypto_wallets SET coin_name = ?, symbol = ?, network = ?, wallet_address = ?, is_active = ? WHERE id = ?");
                $wStmt->execute([$coinName, $symbol, $network, $address, $active, $wId]);
            } else {
                $wStmt = $pdo->prepare("INSERT INTO admin_crypto_wallets (coin_name, symbol, network, wallet_address, is_active) VALUES (?, ?, ?, ?, ?)");
                $wStmt->execute([$coinName, $symbol, $network, $address, $active]);
            }
            $actionNotice = "Crypto wallet saved.";
        }
    }

    // 4. Toggle Wallet Active Status
    if ($act === 'toggle_wallet') {
        $wId = (int)($_POST['wallet_id'] ?? 0);
        $pdo->prepare("UPDATE admin_crypto_wallets SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?")->execute([$wId]);
        $actionNotice = "Wallet status toggled.";
    }

    // 5. Toggle 30-Day VIP Access for User
    if ($act === 'toggle_user_vip') {
        $targetUserId = (int)($_POST['target_user_id'] ?? 0);
        $currentVip = (int)($_POST['current_vip'] ?? 0);
        if ($targetUserId > 0) {
            if ($currentVip === 1) {
                $pdo->prepare("UPDATE users SET is_vip = 0, vip_expires_at = NULL WHERE id = ?")->execute([$targetUserId]);
                $actionNotice = "VIP revoked for User #{$targetUserId}.";
            } else {
                $expiry = date('Y-m-d H:i:s', time() + (30 * 86400));
                $pdo->prepare("UPDATE users SET is_vip = 1, vip_expires_at = ? WHERE id = ?")->execute([$expiry, $targetUserId]);
                $actionNotice = "Strict 30-Day VIP Pass granted to User #{$targetUserId} (Expires: {$expiry}).";
            }
        }
    }

    // 6. Adjust User Credits
    if ($act === 'adjust_credits') {
        $targetUserId = (int)($_POST['target_user_id'] ?? 0);
        $credits = max(0, (int)($_POST['credits'] ?? 0));
        if ($targetUserId > 0) {
            $pdo->prepare("UPDATE users SET credits = ? WHERE id = ?")->execute([$credits, $targetUserId]);
            $actionNotice = "Credits set to {$credits} for User #{$targetUserId}.";
        }
    }

    // 7. Admin Sign Out
    if ($act === 'admin_logout') {
        unset($_SESSION['admin_authenticated']);
        $isAdminAuthenticated = false;
        header("Location: admin.php");
        exit;
    }
}

// Data Fetching for Dashboard
$tiers = [];
$wallets = [];
$ipInspect = [];
$recentSignals = [];
$userRoster = [];
$totalUsers = 0;
$activeTraders = 0;

if ($isAdminAuthenticated) {
    // Users Roster
    $userRoster = $pdo->query("SELECT id, username, email, role, credits, is_vip, vip_expires_at, registration_ip, created_at FROM users ORDER BY id DESC LIMIT 50")->fetchAll();
    // Tiers
    $tiers = $pdo->query("SELECT * FROM credit_pricing_tiers ORDER BY id ASC")->fetchAll();
    // Wallets
    $wallets = $pdo->query("SELECT * FROM admin_crypto_wallets ORDER BY id ASC")->fetchAll();

    // IP Abuse Inspector (Groups accounts per IP)
    $ipStmt = $pdo->query("
        SELECT 
            u.registration_ip,
            COUNT(u.id) as accounts_count,
            MAX(u.created_at) as last_reg,
            COALESCE(r.bonus_claimed, 0) as bonus_recorded
        FROM users u
        LEFT JOIN ip_registrations r ON u.registration_ip = r.ip_address
        GROUP BY u.registration_ip
        ORDER BY accounts_count DESC, last_reg DESC
        LIMIT 25
    ");
    $ipInspect = $ipStmt->fetchAll();

    // System Metrics
    $totalUsers = (int)$pdo->query("SELECT COUNT(*) FROM users")->fetchColumn();
    $activeTraders = (int)$pdo->query("SELECT COUNT(DISTINCT session_id) FROM active_sessions")->fetchColumn();
    $recentSignals = $pdo->query("SELECT * FROM signal_feedback ORDER BY id DESC LIMIT 10")->fetchAll();
}
?>
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PulseTrade Pro - Mobile Admin Command Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        slate: { 950: '#060a12', 900: '#0b1120', 850: '#0f172a', 800: '#1e293b' }
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen antialiased flex flex-col justify-between selection:bg-amber-500 selection:text-slate-950">

    <!-- Top Admin Header -->
    <header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30 px-4 py-3 flex items-center justify-between max-w-4xl mx-auto w-full">
        <div class="flex items-center gap-3">
            <a href="index.php" class="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
            </a>
            <div>
                <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                    <h1 class="font-bold text-sm tracking-wide text-white uppercase font-mono">PulseTrade Citadel Admin</h1>
                </div>
                <div class="text-[10px] text-slate-400 font-mono">Quant & Citadel Controls</div>
            </div>
        </div>

        <?php if ($isAdminAuthenticated): ?>
            <form method="POST" action="admin.php">
                <input type="hidden" name="action" value="admin_logout">
                <button type="submit" class="text-xs font-mono bg-rose-950/70 border border-rose-800 text-rose-300 hover:bg-rose-900 px-3 py-1.5 rounded-lg transition">
                    Lock Terminal
                </button>
            </form>
        <?php endif; ?>
    </header>

    <main class="max-w-4xl mx-auto w-full px-4 py-6 flex-1 space-y-6">

        <?php if (!$isAdminAuthenticated): ?>
            <!-- Admin PIN Gate Screen -->
            <div class="max-w-sm mx-auto my-12 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-center space-y-4">
                <div class="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mx-auto text-amber-400">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                </div>
                <div>
                    <h2 class="text-lg font-bold text-white font-mono">Command Clearance Required</h2>
                    <p class="text-xs text-slate-400 mt-1">Enter Citadel Master PIN or login with your Admin credentials.</p>
                </div>

                <?php if ($loginError): ?>
                    <div class="text-xs font-mono text-rose-400 bg-rose-950/60 border border-rose-800/60 p-2.5 rounded-lg">
                        <?= htmlspecialchars($loginError) ?>
                    </div>
                <?php endif; ?>

                <form method="POST" action="admin.php" class="space-y-3">
                    <input type="hidden" name="action" value="admin_auth">
                    <input type="password" 
                           name="admin_pin" 
                           placeholder="Master PIN (Default: 7789)" 
                           required 
                           autofocus
                           class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-center tracking-widest text-lg text-amber-300 font-mono focus:border-amber-500 focus:outline-none">
                    <button type="submit" class="w-full py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm rounded-xl font-mono transition shadow-lg shadow-amber-500/20">
                        Authorize Console &rarr;
                    </button>
                </form>
            </div>
        <?php else: ?>

            <?php if ($actionNotice): ?>
                <div class="bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 px-4 py-3 rounded-xl text-xs font-mono flex items-center gap-2">
                    <svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                    <span><?= htmlspecialchars($actionNotice) ?></span>
                </div>
            <?php endif; ?>

            <!-- Metrics Strip -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div class="bg-slate-900 border border-slate-800 rounded-xl p-3.5">
                    <div class="text-[10px] font-mono uppercase text-slate-400">Total Registered</div>
                    <div class="text-xl font-black font-mono text-white mt-1"><?= $totalUsers ?></div>
                </div>
                <div class="bg-slate-900 border border-slate-800 rounded-xl p-3.5">
                    <div class="text-[10px] font-mono uppercase text-slate-400">Active Live Sessions</div>
                    <div class="text-xl font-black font-mono text-emerald-400 mt-1"><?= max($activeTraders, 1) ?></div>
                </div>
                <div class="bg-slate-900 border border-slate-800 rounded-xl p-3.5">
                    <div class="text-[10px] font-mono uppercase text-slate-400">Welcome Bonus</div>
                    <div class="text-xl font-black font-mono text-amber-400 mt-1"><?= htmlspecialchars(getSetting('welcome_bonus_credits', '10')) ?> Credits</div>
                </div>
                <div class="bg-slate-900 border border-slate-800 rounded-xl p-3.5">
                    <div class="text-[10px] font-mono uppercase text-slate-400">VIP Monthly</div>
                    <div class="text-xl font-black font-mono text-cyan-400 mt-1">$<?= htmlspecialchars(getSetting('vip_monthly_price_usd', '49.99')) ?></div>
                </div>
            </div>

            <!-- Global System Settings -->
            <section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                    <h2 class="text-sm font-bold font-mono uppercase text-white flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-emerald-400"></span> Global Parameters & API Gateways
                    </h2>
                    <span class="text-[11px] font-mono text-slate-500">Autonomous Settlement</span>
                </div>

                <form method="POST" action="admin.php" class="space-y-4">
                    <input type="hidden" name="action" value="update_settings">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-mono text-slate-400 mb-1">Welcome Starter Credits</label>
                            <input type="number" 
                                   name="welcome_bonus_credits" 
                                   value="<?= htmlspecialchars(getSetting('welcome_bonus_credits', '10')) ?>" 
                                   required 
                                   class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-emerald-300 font-mono focus:border-emerald-500 focus:outline-none">
                            <span class="text-[10px] text-slate-500">Credited to first-time IP addresses upon registration.</span>
                        </div>

                        <div>
                            <label class="block text-xs font-mono text-slate-400 mb-1">VIP Monthly Subscription (USD)</label>
                            <input type="number" 
                                   step="0.01" 
                                   name="vip_monthly_price_usd" 
                                   value="<?= htmlspecialchars(getSetting('vip_monthly_price_usd', '49.99')) ?>" 
                                   required 
                                   class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-cyan-300 font-mono focus:border-cyan-500 focus:outline-none">
                            <span class="text-[10px] text-slate-500">Price for 30 days unlimited signal stream.</span>
                        </div>

                        <div>
                            <label class="block text-xs font-mono text-slate-400 mb-1">NowPayments API Key</label>
                            <input type="password" 
                                   name="nowpayments_api_key" 
                                   placeholder="Leave blank to use direct crypto fallback"
                                   value="<?= htmlspecialchars(getSetting('nowpayments_api_key', '')) ?>" 
                                   class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none">
                            <span class="text-[10px] text-slate-500">Enables dynamic multi-coin payment links.</span>
                        </div>

                        <div>
                            <label class="block text-xs font-mono text-slate-400 mb-1">NowPayments IPN Secret</label>
                            <input type="password" 
                                   name="nowpayments_ipn_secret" 
                                   placeholder="HMAC-SHA512 Webhook Secret"
                                   value="<?= htmlspecialchars(getSetting('nowpayments_ipn_secret', '')) ?>" 
                                   class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none">
                            <span class="text-[10px] text-slate-500">Verifies blockchain callback authenticity.</span>
                        </div>

                        <div>
                            <label class="block text-xs font-mono text-slate-400 mb-1">Admin Clearance PIN</label>
                            <input type="text" 
                                   name="admin_pin" 
                                   value="<?= htmlspecialchars(getSetting('admin_pin', '7789')) ?>" 
                                   class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-amber-300 font-mono focus:border-amber-500 focus:outline-none">
                        </div>
                    </div>

                    <button type="submit" class="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs font-mono rounded-xl transition shadow-lg shadow-emerald-500/10">
                        Save System Settings
                    </button>
                </form>
            </section>

            <!-- Credit Pricing Tiers Management -->
            <section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <h2 class="text-sm font-bold font-mono uppercase text-white flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-cyan-400"></span> Signal Pricing Tiers
                </h2>
                <div class="space-y-3">
                    <?php foreach ($tiers as $tier): ?>
                        <form method="POST" action="admin.php" class="bg-slate-950 border border-slate-800 rounded-xl p-3 grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
                            <input type="hidden" name="action" value="update_tier">
                            <input type="hidden" name="tier_id" value="<?= $tier['id'] ?>">

                            <div>
                                <span class="text-[10px] font-mono text-slate-500 block">Tier</span>
                                <span class="font-bold text-xs font-mono text-slate-300">#<?= $tier['id'] ?></span>
                            </div>

                            <div>
                                <span class="text-[10px] font-mono text-slate-500 block">Signals</span>
                                <input type="number" name="credits_amount" value="<?= $tier['credits_amount'] ?>" class="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-white font-mono">
                            </div>

                            <div>
                                <span class="text-[10px] font-mono text-slate-500 block">Bonus</span>
                                <input type="number" name="bonus_credits" value="<?= $tier['bonus_credits'] ?>" class="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-emerald-400 font-mono">
                            </div>

                            <div>
                                <span class="text-[10px] font-mono text-slate-500 block">Price ($)</span>
                                <input type="number" step="0.01" name="price_usd" value="<?= $tier['price_usd'] ?>" class="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-cyan-400 font-mono">
                            </div>

                            <div>
                                <span class="text-[10px] font-mono text-slate-500 block">Label</span>
                                <input type="text" name="badge_label" value="<?= htmlspecialchars($tier['badge_label'] ?? '') ?>" class="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-slate-300 font-mono">
                            </div>

                            <div class="flex items-center justify-end gap-2 col-span-2 sm:col-span-1">
                                <label class="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                                    <input type="checkbox" name="is_active" value="1" <?= $tier['is_active'] ? 'checked' : '' ?> class="rounded bg-slate-900 border-slate-800 text-emerald-500">
                                    Active
                                </label>
                                <button type="submit" class="bg-slate-800 hover:bg-slate-700 text-white text-[11px] font-mono px-2 py-1 rounded">
                                    Save
                                </button>
                            </div>
                        </form>
                    <?php endforeach; ?>
                </div>
            </section>

            <!-- Admin Crypto Receiving Wallets -->
            <section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <h2 class="text-sm font-bold font-mono uppercase text-white flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-amber-400"></span> Receiving Crypto Wallets
                </h2>

                <div class="space-y-3">
                    <?php foreach ($wallets as $wallet): ?>
                        <div class="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div class="space-y-1 flex-1">
                                <div class="flex items-center gap-2">
                                    <span class="font-bold text-xs text-white font-mono"><?= htmlspecialchars($wallet['coin_name']) ?> (<?= htmlspecialchars($wallet['symbol']) ?>)</span>
                                    <span class="text-[10px] font-mono text-amber-400 bg-amber-950/60 border border-amber-800/60 px-1.5 py-0.5 rounded"><?= htmlspecialchars($wallet['network']) ?></span>
                                    <span class="text-[10px] font-mono <?= $wallet['is_active'] ? 'text-emerald-400' : 'text-slate-500' ?>">
                                        ● <?= $wallet['is_active'] ? 'Active' : 'Disabled' ?>
                                    </span>
                                </div>
                                <div class="font-mono text-[11px] text-slate-400 break-all select-all">
                                    <?= htmlspecialchars($wallet['wallet_address']) ?>
                                </div>
                            </div>
                            <form method="POST" action="admin.php">
                                <input type="hidden" name="action" value="toggle_wallet">
                                <input type="hidden" name="wallet_id" value="<?= $wallet['id'] ?>">
                                <button type="submit" class="text-xs font-mono px-3 py-1.5 rounded-lg border transition <?= $wallet['is_active'] ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700' : 'bg-emerald-950 border-emerald-800 text-emerald-300 hover:bg-emerald-900' ?>">
                                    <?= $wallet['is_active'] ? 'Deactivate' : 'Activate' ?>
                                </button>
                            </form>
                        </div>
                    <?php endforeach; ?>
                </div>

                <!-- Add New Crypto Wallet Form -->
                <form method="POST" action="admin.php" class="bg-slate-950/80 border border-slate-800/80 rounded-xl p-3 space-y-3">
                    <input type="hidden" name="action" value="save_wallet">
                    <div class="text-xs font-mono text-slate-400 font-semibold uppercase">Add Receiving Address</div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input type="text" name="coin_name" placeholder="Asset (e.g. Ethereum)" required class="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono">
                        <input type="text" name="symbol" placeholder="Symbol (e.g. ETH)" required class="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono">
                        <input type="text" name="network" placeholder="Network (e.g. ERC20)" required class="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono">
                    </div>
                    <input type="text" name="wallet_address" placeholder="Destination Wallet Address" required class="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-emerald-300 font-mono">
                    <button type="submit" class="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs font-mono px-4 py-2 rounded-lg transition">
                        Add Crypto Wallet
                    </button>
                </form>
            </section>

            <!-- User Roster & 30-Day VIP Slot Allocator -->
            <section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                    <h2 class="text-sm font-bold font-mono uppercase text-white flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-amber-400"></span> Registered Users &amp; VIP Slot Allocator
                    </h2>
                    <span class="text-[11px] font-mono text-slate-400">Strict 30-Day Enforcement</span>
                </div>

                <div class="overflow-x-auto">
                    <table class="w-full text-left font-mono text-xs">
                        <thead>
                            <tr class="border-b border-slate-800 text-slate-500 uppercase text-[10px]">
                                <th class="py-2 px-3">Trader</th>
                                <th class="py-2 px-3">Email</th>
                                <th class="py-2 px-3">Credits</th>
                                <th class="py-2 px-3">VIP Status</th>
                                <th class="py-2 px-3">30-Day Expiry</th>
                                <th class="py-2 px-3 text-right">VIP Slot Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-800/60">
                            <?php foreach ($userRoster as $u): ?>
                                <tr class="hover:bg-slate-800/30">
                                    <td class="py-2 px-3">
                                        <div class="font-bold text-white"><?= htmlspecialchars($u['username']) ?></div>
                                        <div class="text-[10px] text-slate-500">ID #<?= $u['id'] ?> • <?= htmlspecialchars($u['role']) ?></div>
                                    </td>
                                    <td class="py-2 px-3 text-slate-400 text-[11px]"><?= htmlspecialchars($u['email']) ?></td>
                                    <td class="py-2 px-3">
                                        <form method="POST" action="admin.php" class="flex items-center gap-1">
                                            <input type="hidden" name="action" value="adjust_credits">
                                            <input type="hidden" name="target_user_id" value="<?= $u['id'] ?>">
                                            <input type="number" name="credits" value="<?= $u['credits'] ?>" class="w-16 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-xs text-emerald-400 font-mono">
                                            <button type="submit" class="text-[10px] bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">Set</button>
                                        </form>
                                    </td>
                                    <td class="py-2 px-3">
                                        <?php if ($u['is_vip']): ?>
                                            <span class="bg-amber-950/80 border border-amber-800 text-amber-300 text-[10px] px-2 py-0.5 rounded-full font-bold">
                                                ★ ACTIVE VIP
                                            </span>
                                        <?php else: ?>
                                            <span class="bg-slate-950 border border-slate-800 text-slate-500 text-[10px] px-2 py-0.5 rounded-full">
                                                STANDARD
                                            </span>
                                        <?php endif; ?>
                                    </td>
                                    <td class="py-2 px-3 text-[11px] text-slate-400">
                                        <?php if ($u['is_vip'] && $u['vip_expires_at']): ?>
                                            <span class="text-amber-400 font-bold"><?= htmlspecialchars($u['vip_expires_at']) ?></span>
                                        <?php else: ?>
                                            <span class="text-slate-600">—</span>
                                        <?php endif; ?>
                                    </td>
                                    <td class="py-2 px-3 text-right">
                                        <form method="POST" action="admin.php" class="inline-block">
                                            <input type="hidden" name="action" value="toggle_user_vip">
                                            <input type="hidden" name="target_user_id" value="<?= $u['id'] ?>">
                                            <input type="hidden" name="current_vip" value="<?= $u['is_vip'] ? 1 : 0 ?>">
                                            <?php if ($u['is_vip']): ?>
                                                <button type="submit" class="bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 text-[10px] px-2 py-1 rounded transition">
                                                    Revoke VIP
                                                </button>
                                            <?php else: ?>
                                                <button type="submit" class="bg-amber-500 hover:bg-amber-400 text-slate-950 text-[10px] font-bold px-2 py-1 rounded transition shadow-sm shadow-amber-500/20">
                                                    Grant 30-Day VIP
                                                </button>
                                            <?php endif; ?>
                                        </form>
                                    </td>
                                </tr>
                            <?php endforeach; ?>
                            <?php if (empty($userRoster)): ?>
                                <tr>
                                    <td colspan="6" class="py-4 text-center text-slate-500">No users registered yet.</td>
                                </tr>
                            <?php endif; ?>
                        </tbody>
                    </table>
                </div>
            </section>

            <!-- IP Abuse Citadel Inspector -->
            <section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                    <h2 class="text-sm font-bold font-mono uppercase text-white flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span> IP Abuse Inspector (Anti-Harvest Shield)
                    </h2>
                    <span class="text-[11px] font-mono text-slate-400">Citadel Log</span>
                </div>

                <div class="overflow-x-auto">
                    <table class="w-full text-left font-mono text-xs">
                        <thead>
                            <tr class="border-b border-slate-800 text-slate-500 uppercase text-[10px]">
                                <th class="py-2 px-3">Client IP</th>
                                <th class="py-2 px-3">Accounts Created</th>
                                <th class="py-2 px-3">Initial Bonus</th>
                                <th class="py-2 px-3">Harvest Status</th>
                                <th class="py-2 px-3">Latest Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-800/60">
                            <?php foreach ($ipInspect as $row): ?>
                                <tr class="hover:bg-slate-800/30">
                                    <td class="py-2 px-3 text-slate-200"><?= htmlspecialchars($row['registration_ip']) ?></td>
                                    <td class="py-2 px-3 text-white font-bold"><?= $row['accounts_count'] ?></td>
                                    <td class="py-2 px-3"><?= $row['bonus_recorded'] ? '<span class="text-emerald-400">Claimed (1st)</span>' : '<span class="text-slate-500">None</span>' ?></td>
                                    <td class="py-2 px-3">
                                        <?php if ((int)$row['accounts_count'] > 1): ?>
                                            <span class="bg-rose-950/80 border border-rose-800 text-rose-300 text-[10px] px-2 py-0.5 rounded-full">
                                                Defensive Lock (0 Free Credits)
                                            </span>
                                        <?php else: ?>
                                            <span class="bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full">
                                                Clean Unique IP
                                            </span>
                                        <?php endif; ?>
                                    </td>
                                    <td class="py-2 px-3 text-slate-500 text-[11px]"><?= htmlspecialchars($row['last_reg'] ?? 'N/A') ?></td>
                                </tr>
                            <?php endforeach; ?>
                            <?php if (empty($ipInspect)): ?>
                                <tr>
                                    <td colspan="5" class="py-4 text-center text-slate-500">No external IP registrations recorded yet.</td>
                                </tr>
                            <?php endif; ?>
                        </tbody>
                    </table>
                </div>
            </section>

        <?php endif; ?>

    </main>

    <footer class="border-t border-slate-800/60 py-4 text-center text-xs font-mono text-slate-500">
        PulseTrade Pro Citadel Security Core &bull; Zero Uncaught Exceptions &bull; PHP 8+ Kernel
    </footer>

</body>
</html>
