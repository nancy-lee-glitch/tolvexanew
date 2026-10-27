<?php
/**
 * PulseTrade Pro - Citadel Protected Registration
 * Anti-Harvesting IP Detection & Welcome Bonus Gate
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

$error = null;
$success = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim((string)($_POST['username'] ?? ''));
    $email    = trim((string)($_POST['email'] ?? ''));
    $password = (string)($_POST['password'] ?? '');

    $result = registerUserDefensive($username, $email, $password);
    if ($result['success']) {
        header("Location: index.php?registered=1");
        exit;
    } else {
        $error = $result['message'];
    }
}
?>
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Account - PulseTrade Pro</title>
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
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
    <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
        <div class="text-center space-y-1">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-800/80 text-[11px] font-mono text-emerald-400">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                Citadel Shield Active
            </div>
            <h1 class="text-xl font-black text-white tracking-wide">Join PulseTrade Pro</h1>
            <p class="text-xs text-slate-400">First-time IPs automatically qualify for free algorithmic starter credits.</p>
        </div>

        <?php if ($error): ?>
            <div class="bg-rose-950/60 border border-rose-800 text-rose-300 px-3.5 py-2.5 rounded-xl text-xs font-mono">
                <?= htmlspecialchars($error) ?>
            </div>
        <?php endif; ?>

        <form method="POST" action="register.php" class="space-y-4">
            <div>
                <label class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-1">Trader Handle</label>
                <input type="text" name="username" placeholder="e.g. QuantAlpha" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
            </div>

            <div>
                <label class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-1">Email Address</label>
                <input type="email" name="email" placeholder="trader@domain.com" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
            </div>

            <div>
                <label class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-1">Secure Password</label>
                <input type="password" name="password" placeholder="••••••••" required minlength="6" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
            </div>

            <button type="submit" class="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-xl font-mono transition shadow-lg shadow-emerald-500/20">
                Create Account & Unlock Signals &rarr;
            </button>
        </form>

        <div class="border-t border-slate-800 pt-4 text-center text-xs text-slate-400 font-mono">
            Already have an account? <a href="login.php" class="text-emerald-400 hover:underline">Log in</a> or <a href="index.php" class="text-slate-300 hover:underline">trade as guest</a>.
        </div>
    </div>
</body>
</html>
