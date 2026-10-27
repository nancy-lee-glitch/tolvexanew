<?php
/**
 * PulseTrade Pro - Secure Authentication Gate
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

$error = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $identity = trim((string)($_POST['identity'] ?? ''));
    $password = (string)($_POST['password'] ?? '');

    $pdo = getDatabaseConnection();
    $stmt = $pdo->prepare("SELECT id, username, email, password_hash FROM users WHERE username = ? OR email = ? LIMIT 1");
    $stmt->execute([$identity, $identity]);
    $found = $stmt->fetch();

    if ($found && password_verify($password, $found['password_hash'])) {
        $_SESSION['user_id'] = (int)$found['id'];
        header("Location: index.php");
        exit;
    } else {
        $error = "Invalid credentials entered.";
    }
}
?>
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sign In - PulseTrade Pro</title>
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
            <h1 class="text-xl font-black text-white tracking-wide">PulseTrade Pro</h1>
            <p class="text-xs text-slate-400 font-mono">Sign in to sync your credits and active signals.</p>
        </div>

        <?php if ($error): ?>
            <div class="bg-rose-950/60 border border-rose-800 text-rose-300 px-3.5 py-2.5 rounded-xl text-xs font-mono">
                <?= htmlspecialchars($error) ?>
            </div>
        <?php endif; ?>

        <form method="POST" action="login.php" class="space-y-4">
            <div>
                <label class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-1">Handle or Email</label>
                <input type="text" name="identity" placeholder="username or email" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
            </div>

            <div>
                <label class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-1">Password</label>
                <input type="password" name="password" placeholder="••••••••" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none">
            </div>

            <button type="submit" class="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-xl font-mono transition shadow-lg shadow-emerald-500/20">
                Authenticate &rarr;
            </button>
        </form>

        <div class="border-t border-slate-800 pt-4 text-center text-xs text-slate-400 font-mono flex justify-between">
            <a href="register.php" class="text-emerald-400 hover:underline">Create account</a>
            <a href="index.php" class="text-slate-400 hover:underline">Trade as guest</a>
        </div>
    </div>
</body>
</html>
