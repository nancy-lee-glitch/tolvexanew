<?php
/**
 * PulseTrade Pro - Production Configuration & Defensive Kernel
 * Abstract DB via lib/db.php supporting SQLite, MySQL, and PostgreSQL (Supabase/Neon)
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/db.php';

// Global Exception & Error Trapping
set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    error_log("[PulseTrade Kernel Notice] $message in $file:$line");
    return true;
});

/**
 * System Settings Helper (bridges to app_settings via lib/db.php)
 */
function getSetting(string $key, string $default = ''): string {
    return getAppSetting($key, $default);
}

/**
 * Update or Set a System Setting
 */
function updateSetting(string $key, string $value): bool {
    return updateAppSetting($key, $value);
}

/**
 * Validates a VIP activation key against vip_keys table and system settings.
 */
function isValidVipKey(string $key): bool {
    $cleanKey = strtoupper(trim($key));
    if ($cleanKey === '') {
        return false;
    }

    try {
        $pdo = getDatabaseConnection();
        $stmt = $pdo->prepare("SELECT id, max_uses, used_count, is_active FROM vip_keys WHERE code = ? AND is_active = 1 LIMIT 1");
        $stmt->execute([$cleanKey]);
        $row = $stmt->fetch();
        if ($row) {
            if ((int)$row['max_uses'] === 0 || (int)$row['used_count'] < (int)$row['max_uses']) {
                return true;
            }
        }
    } catch (Throwable $e) {}

    // Fallback standard keys
    $fallbackKeys = [
        'VIP-ALPHA-30D',
        'PULSE-VIP-2026',
        'QUANT-30D',
        'VIP-TRADER-1M'
    ];
    return in_array($cleanKey, $fallbackKeys, true);
}

/**
 * Anti-Abuse Registration Engine
 */
function registerUserDefensive(string $username, string $email, string $password, string $vipKey = ''): array {
    $username = trim($username);
    $email = trim(strtolower($email));
    $ip = getClientIP();

    if (strlen($username) < 3 || strlen($username) > 30) {
        return ['success' => false, 'message' => 'Username must be between 3 and 30 characters.'];
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return ['success' => false, 'message' => 'Invalid email address provided.'];
    }
    if (strlen($password) < 6) {
        return ['success' => false, 'message' => 'Password must be at least 6 characters long.'];
    }

    try {
        $pdo = getDatabaseConnection();

        // Check for duplicate username or email
        $check = $pdo->prepare("SELECT id, username, email FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1");
        $check->execute([$username, $email]);
        if ($row = $check->fetch()) {
            if (strtolower($row['username']) === strtolower($username)) {
                return ['success' => false, 'message' => 'Username already in use.'];
            }
            return ['success' => false, 'message' => 'Email already registered.'];
        }

        // Citadel Anti-Abuse IP Check
        $ipCheck = $pdo->prepare("SELECT id FROM ip_registrations WHERE ip_address = ? LIMIT 1");
        $ipCheck->execute([$ip]);
        $existingIP = $ipCheck->fetch();

        $welcomeBonus = (int)getAppSetting('welcome_bonus_credits', '10');
        $grantedCredits = $welcomeBonus;
        $bonusHarvestDetected = false;

        if ($existingIP) {
            $grantedCredits = 0;
            $bonusHarvestDetected = true;
        } else {
            $logIP = $pdo->prepare("INSERT INTO ip_registrations (ip_address, bonus_claimed) VALUES (?, 1)");
            $logIP->execute([$ip]);
        }

        $isVip = 0;
        $vipExpiresAt = null;
        $vipGrantedMsg = '';

        if (!empty($vipKey)) {
            $cleanKey = strtoupper(trim($vipKey));
            if (isValidVipKey($cleanKey)) {
                $isVip = 1;
                $vipExpiresAt = date('Y-m-d H:i:s', time() + (30 * 86400));
                $vipGrantedMsg = " ★ 30-Day VIP Pass activated! Valid until " . date('M d, Y', strtotime($vipExpiresAt)) . ".";

                // Increment used count on key
                try {
                    $updKey = $pdo->prepare("UPDATE vip_keys SET used_count = used_count + 1 WHERE code = ?");
                    $updKey->execute([$cleanKey]);
                } catch (Throwable $e) {}
            } else {
                $vipGrantedMsg = " (Notice: Invalid VIP code provided. Standard free starter credits granted).";
            }
        }

        $passwordHash = password_hash($password, PASSWORD_BCRYPT);
        $insert = $pdo->prepare("INSERT INTO users (username, email, password_hash, role, credits, is_vip, vip_expires_at, registration_ip) VALUES (?, ?, ?, 'USER', ?, ?, ?, ?)");
        $insert->execute([$username, $email, $passwordHash, $grantedCredits, $isVip, $vipExpiresAt, $ip]);

        $newUserId = (int)$pdo->lastInsertId();
        $_SESSION['user_id'] = $newUserId;

        $userDto = [
            'id' => $newUserId,
            'username' => $username,
            'email' => $email,
            'role' => 'USER',
            'credits' => $grantedCredits,
            'is_vip' => $isVip,
            'vip_expires_at' => $vipExpiresAt,
            'vip_days_left' => $isVip ? 30 : 0,
            'vip_hours_left' => 0,
            'vip_seconds_left' => $isVip ? (30 * 86400) : 0,
        ];

        return [
            'success' => true,
            'user' => $userDto,
            'credits' => $grantedCredits,
            'is_vip' => $isVip,
            'vip_expires_at' => $vipExpiresAt,
            'vip_days_left' => $isVip ? 30 : 0,
            'anti_abuse_triggered' => $bonusHarvestDetected,
            'message' => $bonusHarvestDetected
                ? 'Account created! Welcome bonus bypassed (IP already registered previously).' . $vipGrantedMsg
                : "Account created successfully with {$grantedCredits} free starter credits!" . $vipGrantedMsg
        ];
    } catch (Throwable $e) {
        error_log("[PulseTrade Registration Exception] " . $e->getMessage());
        return ['success' => false, 'message' => 'System error during registration: ' . $e->getMessage()];
    }
}
