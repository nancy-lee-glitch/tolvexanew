<?php
/**
 * PulseTrade Pro - Crypto Payment Gateway & Multi-Network Checkout
 * Supports Automated NowPayments Invoices + Zero-Dependency Manual Crypto Wallets
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

$user = getCurrentUser();
$pdo = getDatabaseConnection();

$type = $_GET['type'] ?? ($_POST['type'] ?? 'CREDITS');
$tierId = isset($_GET['tier_id']) ? (int)$_GET['tier_id'] : (isset($_POST['tier_id']) ? (int)$_POST['tier_id'] : 2);
$successNotice = null;
$errorMessage = null;

// Determine Item Price and Description
$priceUsd = 10.00;
$title = "25 Signals (+5 Free Bonus)";
$creditsToAdd = 30;

if ($type === 'VIP') {
    $priceUsd = (float)getSetting('vip_monthly_price_usd', '49.99');
    $title = "VIP 30-Day Unlimited Terminal Access";
} else {
    $tStmt = $pdo->prepare("SELECT id, credits_amount, bonus_credits, price_usd, badge_label FROM credit_pricing_tiers WHERE id = ? LIMIT 1");
    $tStmt->execute([$tierId]);
    $tier = $tStmt->fetch();
    if ($tier) {
        $priceUsd = (float)$tier['price_usd'];
        $creditsToAdd = (int)$tier['credits_amount'] + (int)$tier['bonus_credits'];
        $title = "{$tier['credits_amount']} Signals" . ($tier['bonus_credits'] > 0 ? " (+{$tier['bonus_credits']} Free)" : "");
    }
}

// Handle Manual Payment TX Hash Submission
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'submit_tx') {
    $txHash = trim((string)($_POST['tx_hash'] ?? ''));
    $coinSymbol = trim((string)($_POST['coin_symbol'] ?? 'USDT'));
    
    if (strlen($txHash) >= 8) {
        $userId = $user ? (int)$user['id'] : 1;
        $invStmt = $pdo->prepare("
            INSERT INTO crypto_invoices (user_id, order_type, tier_id, price_usd, pay_currency, payment_id, payment_status)
            VALUES (?, ?, ?, ?, ?, ?, 'WAITING')
        ");
        $invStmt->execute([$userId, $type, $tierId, $priceUsd, $coinSymbol, "TX:" . substr($txHash, 0, 80)]);
        $successNotice = "Transaction submitted! Blockchain nodes are confirming your payment. Credits will be allocated immediately upon 1 network confirmation.";
    } else {
        $errorMessage = "Please enter a valid blockchain transaction hash / ID.";
    }
}

// NowPayments API Initiation (if configured)
$nowPaymentsKey = getSetting('nowpayments_api_key', '');
$redirectToNowPayments = false;

if (!empty($nowPaymentsKey) && isset($_GET['auto']) && $_GET['auto'] === '1') {
    $userId = $user ? (int)$user['id'] : 1;
    $orderId = "ORD-" . time() . "-" . $userId;

    $reqPayload = json_encode([
        'price_amount' => $priceUsd,
        'price_currency' => 'usd',
        'order_id' => $orderId,
        'order_description' => "PulseTrade Pro - {$title}",
        'ipn_callback_url' => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? "https" : "http") . "://{$_SERVER['HTTP_HOST']}/webhook_nowpayments.php",
        'success_url' => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? "https" : "http") . "://{$_SERVER['HTTP_HOST']}/index.php?payment_success=1",
        'cancel_url' => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? "https" : "http") . "://{$_SERVER['HTTP_HOST']}/create_payment.php?type={$type}&tier_id={$tierId}"
    ]);

    $ch = curl_init('https://api.nowpayments.io/v1/invoice');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $reqPayload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'x-api-key: ' . $nowPaymentsKey,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode >= 200 && $httpCode < 300 && $response) {
        $data = json_decode($response, true);
        if (!empty($data['invoice_url'])) {
            // Log invoice
            $invStmt = $pdo->prepare("
                INSERT INTO crypto_invoices (user_id, order_type, tier_id, price_usd, pay_currency, payment_id, payment_status)
                VALUES (?, ?, ?, ?, 'CRYPTO', ?, 'WAITING')
            ");
            $invStmt->execute([$userId, $type, $tierId, $priceUsd, (string)($data['id'] ?? '')]);
            
            header("Location: " . $data['invoice_url']);
            exit;
        }
    }
}

// Retrieve Active Admin Wallets for Manual Fallback
$walletsStmt = $pdo->query("SELECT id, coin_name, symbol, network, wallet_address FROM admin_crypto_wallets WHERE is_active = 1 ORDER BY id ASC");
$activeWallets = $walletsStmt->fetchAll();
?>
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Secure Crypto Checkout - PulseTrade Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        slate: { 950: '#070b14', 900: '#0b1120', 850: '#0f172a', 800: '#1e293b' }
                    }
                }
            }
        }
    </script>
    <style>
        .glow-emerald { box-shadow: 0 0 25px -5px rgba(16, 185, 129, 0.3); }
        .glow-cyan { box-shadow: 0 0 25px -5px rgba(6, 182, 212, 0.25); }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen antialiased flex flex-col justify-between selection:bg-emerald-500 selection:text-slate-950">

    <!-- Top Navigation -->
    <header class="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur sticky top-0 z-30 px-4 py-3 flex items-center justify-between max-w-lg mx-auto w-full">
        <a href="index.php" class="flex items-center gap-2 text-slate-300 hover:text-white transition">
            <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span class="font-mono text-xs font-semibold tracking-wider uppercase">Back to Terminal</span>
        </a>
        <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
            <span class="text-xs font-mono text-emerald-400 font-medium">SSL Encrypted Checkout</span>
        </div>
    </header>

    <main class="max-w-lg mx-auto w-full px-4 py-6 flex-1 space-y-6">

        <!-- Order Summary Card -->
        <section class="bg-gradient-to-b from-slate-900 to-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl relative overflow-hidden">
            <div class="absolute -right-10 -top-10 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none"></div>
            <div class="flex items-center justify-between mb-3">
                <span class="text-xs font-mono tracking-widest uppercase text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-1 rounded-full">
                    <?= htmlspecialchars($type) ?> PACKAGE
                </span>
                <span class="text-2xl font-black text-white font-mono">$<?= number_format($priceUsd, 2) ?></span>
            </div>
            <h1 class="text-xl font-bold text-white mb-1"><?= htmlspecialchars($title) ?></h1>
            <p class="text-xs text-slate-400">Instant on-chain settlement with zero processing delays. Full signal telemetry unlocked.</p>
        </section>

        <?php if ($successNotice): ?>
            <div class="bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 px-4 py-3 rounded-xl text-sm font-mono flex items-center gap-3">
                <svg class="w-5 h-5 flex-shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                <span><?= htmlspecialchars($successNotice) ?></span>
            </div>
        <?php endif; ?>

        <?php if ($errorMessage): ?>
            <div class="bg-rose-950/50 border border-rose-500/40 text-rose-300 px-4 py-3 rounded-xl text-sm font-mono flex items-center gap-3">
                <svg class="w-5 h-5 flex-shrink-0 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                <span><?= htmlspecialchars($errorMessage) ?></span>
            </div>
        <?php endif; ?>

        <?php if (!empty($nowPaymentsKey)): ?>
            <!-- Automated NowPayments Gateway Action -->
            <div class="bg-slate-900 border border-emerald-500/30 rounded-2xl p-5 text-center space-y-3">
                <div class="text-xs font-mono text-emerald-400 uppercase tracking-wider font-semibold">Automated Crypto Invoice</div>
                <p class="text-xs text-slate-400">Pay automatically via BTC, ETH, USDT, SOL or 100+ cryptocurrencies with instant dynamic confirmation.</p>
                <a href="create_payment.php?type=<?= urlencode($type) ?>&tier_id=<?= $tierId ?>&auto=1" 
                   class="block w-full py-3.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-xl transition shadow-lg shadow-emerald-500/20 font-mono text-center">
                    Proceed with NowPayments Gateway &rarr;
                </a>
            </div>
            <div class="relative flex items-center justify-center">
                <div class="border-t border-slate-800 w-full"></div>
                <span class="bg-slate-950 px-3 text-[11px] font-mono text-slate-500 uppercase tracking-wider">or direct wallet transfer</span>
            </div>
        <?php endif; ?>

        <!-- Direct Crypto Wallets Section -->
        <section class="space-y-4">
            <div class="flex items-center justify-between">
                <h2 class="text-xs font-mono tracking-wider uppercase text-slate-400 font-semibold">Direct Deposit Addresses</h2>
                <span class="text-[11px] text-slate-500 font-mono">Select Asset</span>
            </div>

            <div class="space-y-3">
                <?php foreach ($activeWallets as $idx => $wallet): ?>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 transition hover:border-slate-700">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-2">
                                <div class="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center font-bold text-xs text-emerald-400 font-mono">
                                    <?= htmlspecialchars($wallet['symbol']) ?>
                                </div>
                                <div>
                                    <div class="font-bold text-sm text-white"><?= htmlspecialchars($wallet['coin_name']) ?></div>
                                    <div class="text-[11px] font-mono text-slate-400"><?= htmlspecialchars($wallet['network']) ?> Network</div>
                                </div>
                            </div>
                            <span class="text-[10px] font-mono uppercase bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                                1 Confirmation
                            </span>
                        </div>

                        <!-- Address with Copy Button -->
                        <div class="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between gap-2 mt-2">
                            <span class="font-mono text-[11px] text-emerald-300 break-all select-all leading-tight" id="addr-<?= $wallet['id'] ?>">
                                <?= htmlspecialchars($wallet['wallet_address']) ?>
                            </span>
                            <button type="button" 
                                    onclick="copyAddress('<?= $wallet['id'] ?>', this)"
                                    class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-2.5 py-1.5 rounded font-mono font-medium flex-shrink-0 transition flex items-center gap-1">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                                <span>Copy</span>
                            </button>
                        </div>
                    </div>
                <?php endforeach; ?>
            </div>
        </section>

        <!-- Proof of Payment / Transaction Verification Form -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div>
                <h3 class="font-bold text-white text-sm">Verify Direct Transfer</h3>
                <p class="text-xs text-slate-400 mt-0.5">Once you have transferred the exact amount, paste your transaction hash (TxID) below for instantaneous automated crediting.</p>
            </div>

            <form method="POST" action="create_payment.php?type=<?= urlencode($type) ?>&tier_id=<?= $tierId ?>" class="space-y-3">
                <input type="hidden" name="action" value="submit_tx">
                <div>
                    <label class="block text-[11px] font-mono text-slate-400 uppercase tracking-wider mb-1">Coin Sent</label>
                    <select name="coin_symbol" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
                        <?php foreach ($activeWallets as $w): ?>
                            <option value="<?= htmlspecialchars($w['symbol']) ?>">
                                <?= htmlspecialchars($w['symbol']) ?> (<?= htmlspecialchars($w['network']) ?>)
                            </option>
                        <?php endforeach; ?>
                    </select>
                </div>

                <div>
                    <label class="block text-[11px] font-mono text-slate-400 uppercase tracking-wider mb-1">Blockchain Transaction Hash (TxID)</label>
                    <input type="text" 
                           name="tx_hash" 
                           placeholder="e.g. 0x8f3c... or 6f42b... or solana signature"
                           required
                           class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-emerald-300 font-mono placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none">
                </div>

                <button type="submit" 
                        class="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-xl font-mono transition shadow-lg shadow-emerald-500/10">
                    Verify & Allocate Credits
                </button>
            </form>
        </section>

    </main>

    <footer class="border-t border-slate-800/60 py-4 text-center text-xs font-mono text-slate-500">
        PulseTrade Citadel Gateway &bull; Defensively Isolated Blockchain Settlement
    </footer>

    <script>
        function copyAddress(id, btn) {
            const el = document.getElementById('addr-' + id);
            if (!el) return;
            navigator.clipboard.writeText(el.innerText.trim()).then(() => {
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<span class="text-emerald-400">Copied!</span>';
                btn.classList.add('border-emerald-500');
                setTimeout(() => {
                    btn.innerHTML = originalHtml;
                    btn.classList.remove('border-emerald-500');
                }, 2000);
            });
        }
    </script>
</body>
</html>
