<?php
/**
 * PulseTrade Pro - Unified PDO Database Abstraction
 * Seamlessly connects to PostgreSQL (Supabase/Neon), MySQL/MariaDB, or embedded SQLite.
 */

declare(strict_types=1);

if (session_status() === PHP_SESSION_NONE) {
    ini_set('session.cookie_httponly', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.cookie_samesite', 'Lax');
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        ini_set('session.cookie_secure', '1');
    }
    session_start();
}

/**
 * Returns a shared PDO instance configured for the active database environment.
 */
function getDatabaseConnection(): PDO {
    static $pdoInstance = null;
    if ($pdoInstance instanceof PDO) {
        return $pdoInstance;
    }

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    // 1. Check PostgreSQL (Supabase or Neon connection string)
    $dbUrl = getenv('DATABASE_URL') ?: (getenv('POSTGRES_URL') ?: (getenv('SUPABASE_DB_URL') ?: ''));
    if (!empty($dbUrl) && extension_loaded('pdo_pgsql')) {
        try {
            $parsed = parse_url($dbUrl);
            if ($parsed && isset($parsed['host'])) {
                $pgHost = $parsed['host'];
                $pgPort = $parsed['port'] ?? 5432;
                $pgUser = $parsed['user'] ?? '';
                $pgPass = $parsed['pass'] ?? '';
                $pgDb   = ltrim($parsed['path'] ?? '', '/');
                $sslMode = 'require';
                if (!empty($parsed['query'])) {
                    parse_str($parsed['query'], $query);
                    if (isset($query['sslmode'])) {
                        $sslMode = $query['sslmode'];
                    }
                }
                $dsn = "pgsql:host={$pgHost};port={$pgPort};dbname={$pgDb};sslmode={$sslMode}";
                $pdoInstance = new PDO($dsn, $pgUser, $pgPass, $options);
                initializeSchemaIfMissing($pdoInstance, 'pgsql');
                return $pdoInstance;
            }
        } catch (Throwable $e) {
            error_log("[PulseTrade PDO] PostgreSQL connection failed: " . $e->getMessage() . ". Falling back to SQLite.");
        }
    }

    // 2. Check MySQL / MariaDB
    $dbDriver = getenv('DB_DRIVER') ?: ((getenv('DB_HOST') || getenv('MYSQL_HOST')) ? 'mysql' : 'sqlite');
    if ($dbDriver === 'mysql' && extension_loaded('pdo_mysql')) {
        try {
            $myHost = getenv('DB_HOST') ?: (getenv('MYSQL_HOST') ?: '127.0.0.1');
            $myPort = getenv('DB_PORT') ?: '3306';
            $myDb   = getenv('DB_NAME') ?: 'pulsetrade_pro';
            $myUser = getenv('DB_USER') ?: 'root';
            $myPass = getenv('DB_PASS') ?: '';
            $dsn = "mysql:host={$myHost};port={$myPort};dbname={$myDb};charset=utf8mb4";
            $pdoInstance = new PDO($dsn, $myUser, $myPass, $options);
            initializeSchemaIfMissing($pdoInstance, 'mysql');
            return $pdoInstance;
        } catch (Throwable $e) {
            error_log("[PulseTrade PDO] MySQL connection failed: " . $e->getMessage() . ". Falling back to SQLite.");
        }
    }

    // 3. Resilient Embedded SQLite Engine (Fast, zero setup, portable)
    $sqlitePath = dirname(__DIR__) . '/pulsetrade.sqlite';
    try {
        $dsn = "sqlite:" . $sqlitePath;
        $pdoInstance = new PDO($dsn, null, null, $options);
        $pdoInstance->exec("PRAGMA journal_mode = WAL;");
        $pdoInstance->exec("PRAGMA foreign_keys = ON;");
        initializeSchemaIfMissing($pdoInstance, 'sqlite');
        return $pdoInstance;
    } catch (Throwable $e) {
        $dsn = "sqlite::memory:";
        $pdoInstance = new PDO($dsn, null, null, $options);
        initializeSchemaIfMissing($pdoInstance, 'sqlite');
        return $pdoInstance;
    }
}

/**
 * Ensures required database tables and initial seed data exist.
 */
function initializeSchemaIfMissing(PDO $pdo, string $driver): void {
    try {
        $isSqlite = ($driver === 'sqlite');
        $autoInc = $isSqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : ($driver === 'pgsql' ? 'SERIAL PRIMARY KEY' : 'INT AUTO_INCREMENT PRIMARY KEY');

        // Users
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS users (
                id {$autoInc},
                username VARCHAR(50) NOT NULL UNIQUE,
                email VARCHAR(100) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'USER',
                credits INTEGER NOT NULL DEFAULT 10,
                is_vip INTEGER NOT NULL DEFAULT 0,
                vip_expires_at " . ($isSqlite ? "TEXT" : "DATETIME") . " NULL,
                registration_ip VARCHAR(45) NOT NULL DEFAULT '127.0.0.1',
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // IP Registrations
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS ip_registrations (
                id {$autoInc},
                ip_address VARCHAR(45) NOT NULL UNIQUE,
                bonus_claimed INTEGER NOT NULL DEFAULT 1,
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // Active Sessions (Heartbeat & Presence)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS active_sessions (
                session_id VARCHAR(128) PRIMARY KEY,
                user_id INTEGER NULL,
                ip_address VARCHAR(45) NOT NULL DEFAULT '127.0.0.1',
                active_asset VARCHAR(50) NOT NULL DEFAULT 'EUR/USD',
                last_heartbeat " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // Signals
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS signals (
                id {$autoInc},
                user_id INTEGER NULL,
                asset VARCHAR(50) NOT NULL,
                timeframe VARCHAR(20) NOT NULL,
                direction VARCHAR(10) NOT NULL,
                entry_price " . ($isSqlite ? "REAL" : "DOUBLE") . " NOT NULL,
                target_price " . ($isSqlite ? "REAL" : "DOUBLE") . " NOT NULL,
                confidence " . ($isSqlite ? "REAL" : "DOUBLE") . " NOT NULL,
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // Trade Outcomes
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS trade_outcomes (
                id {$autoInc},
                user_id INTEGER NULL,
                asset VARCHAR(50) NOT NULL,
                timeframe VARCHAR(20) NOT NULL,
                direction VARCHAR(10) NOT NULL,
                confidence " . ($isSqlite ? "REAL" : "DOUBLE") . " NOT NULL DEFAULT 88.0,
                outcome VARCHAR(10) NOT NULL,
                logged_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // VIP Keys
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS vip_keys (
                id {$autoInc},
                code VARCHAR(64) NOT NULL UNIQUE,
                duration_days INTEGER NOT NULL DEFAULT 30,
                max_uses INTEGER NOT NULL DEFAULT 100,
                used_count INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // App Settings
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                setting_value TEXT NOT NULL
            )
        ");

        // Crypto Deposits / Payment Orders
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS crypto_deposits (
                id {$autoInc},
                payment_id VARCHAR(100) NOT NULL UNIQUE,
                user_id INTEGER NULL,
                order_id VARCHAR(100) NULL,
                product_type VARCHAR(50) NOT NULL DEFAULT 'VIP_30D',
                amount " . ($isSqlite ? "REAL" : "DOUBLE") . " NOT NULL,
                currency VARCHAR(20) NOT NULL DEFAULT 'USD',
                pay_address VARCHAR(255) NULL,
                pay_amount " . ($isSqlite ? "REAL" : "DOUBLE") . " NULL,
                pay_currency VARCHAR(20) NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'waiting',
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . ",
                updated_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // Pricing Packages (Admin-Managed)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pricing_packages (
                id VARCHAR(64) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                type VARCHAR(30) NOT NULL DEFAULT 'CREDITS',
                credits_amount INTEGER NOT NULL DEFAULT 0,
                bonus_credits INTEGER NOT NULL DEFAULT 0,
                price_usd " . ($isSqlite ? "REAL" : "DOUBLE") . " NOT NULL DEFAULT 0,
                badge_label VARCHAR(50) NULL,
                description TEXT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // Single-Use VIP Codes
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS vip_codes (
                id {$autoInc},
                code VARCHAR(64) NOT NULL UNIQUE,
                duration_days INTEGER NOT NULL DEFAULT 30,
                is_active INTEGER NOT NULL DEFAULT 1,
                is_redeemed INTEGER NOT NULL DEFAULT 0,
                redeemed_by_user_id INTEGER NULL,
                redeemed_by_username VARCHAR(100) NULL,
                redeemed_at " . ($isSqlite ? "DATETIME NULL" : "TIMESTAMP NULL") . ",
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . ",
                created_by VARCHAR(50) NULL
            )
        ");

        // Blog Posts CMS
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS blog_posts (
                id {$autoInc},
                title VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL UNIQUE,
                excerpt TEXT NULL,
                body TEXT NOT NULL,
                category VARCHAR(50) NOT NULL DEFAULT 'Quantitative Strategy',
                cover_url VARCHAR(500) NULL,
                is_published INTEGER NOT NULL DEFAULT 1,
                created_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . ",
                updated_at " . ($isSqlite ? "DATETIME DEFAULT CURRENT_TIMESTAMP" : "TIMESTAMP DEFAULT CURRENT_TIMESTAMP") . "
            )
        ");

        // Seed App Settings
        $defaultSettings = [
            'site_name' => 'PulseTrade Pro',
            'site_tagline' => 'Institutional-Grade Micro-Volatility Terminal',
            'badge_text' => 'v8.2 QUANT',
            'banner_text' => '⚡ 30-Day VIP Pass: Institutional-grade 89.4% confluence signals with instant automated verification',
            'banner_enabled' => '1',
            'support_telegram' => 'https://t.me/pulsetrade_quant',
            'support_email' => 'support@pulsetrade.pro',
            'vip_price_usd' => '49',
            'starter_price_usd' => '5',
            'welcome_bonus_credits' => '10',
            'nowpayments_config' => json_encode([
                'apiKey' => getenv('NOWPAYMENTS_API_KEY') ?: '',
                'ipnSecret' => getenv('NOWPAYMENTS_IPN_SECRET') ?: '',
                'isSandbox' => false,
                'enabled' => !empty(getenv('NOWPAYMENTS_API_KEY')),
                'payoutAddress' => ''
            ]),
        ];

        foreach ($defaultSettings as $k => $v) {
            $stmt = $pdo->prepare("SELECT COUNT(*) FROM app_settings WHERE setting_key = ?");
            $stmt->execute([$k]);
            if ((int)$stmt->fetchColumn() === 0) {
                $ins = $pdo->prepare("INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)");
                $ins->execute([$k, $v]);
            }
        }

        // Seed VIP Keys
        $sampleKeys = ['VIP-ALPHA-30D', 'PULSE-VIP-2026', 'QUANT-30D', 'VIP-TRADER-1M'];
        foreach ($sampleKeys as $code) {
            $stmt = $pdo->prepare("SELECT COUNT(*) FROM vip_keys WHERE code = ?");
            $stmt->execute([$code]);
            if ((int)$stmt->fetchColumn() === 0) {
                $ins = $pdo->prepare("INSERT INTO vip_keys (code, duration_days, max_uses, used_count, is_active) VALUES (?, 30, 9999, 0, 1)");
                $ins->execute([$code]);
            }
        }

        // Seed Default Admin (admin / durodoluwa5@gmail.com, password: 7789)
        $adminCheck = $pdo->prepare("SELECT COUNT(*) FROM users WHERE username = 'admin' OR email = 'durodoluwa5@gmail.com'");
        $adminCheck->execute();
        if ((int)$adminCheck->fetchColumn() === 0) {
            $adminPass = password_hash('7789', PASSWORD_BCRYPT);
            $vipExp = date('Y-m-d H:i:s', time() + (365 * 86400));
            $adminIns = $pdo->prepare("
                INSERT INTO users (username, email, password_hash, role, credits, is_vip, vip_expires_at, registration_ip)
                VALUES ('admin', 'durodoluwa5@gmail.com', ?, 'ADMIN', 9999, 1, ?, '127.0.0.1')
            ");
            $adminIns->execute([$adminPass, $vipExp]);
        }

    } catch (Throwable $e) {
        error_log("[PulseTrade Schema Init Exception] " . $e->getMessage());
    }
}

/**
 * Resolves client IP address cleanly through reverse proxies and Cloudflare.
 */
function getClientIP(): string {
    $headers = [
        'HTTP_CF_CONNECTING_IP',
        'HTTP_X_REAL_IP',
        'HTTP_X_FORWARDED_FOR',
        'REMOTE_ADDR'
    ];
    foreach ($headers as $header) {
        if (!empty($_SERVER[$header])) {
            $parts = explode(',', (string)$_SERVER[$header]);
            foreach ($parts as $p) {
                $ip = trim($p);
                if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                    return $ip;
                }
            }
            $first = trim($parts[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * Get setting value from app_settings table.
 */
function getAppSetting(string $key, string $default = ''): string {
    try {
        $pdo = getDatabaseConnection();
        $stmt = $pdo->prepare("SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1");
        $stmt->execute([$key]);
        $val = $stmt->fetchColumn();
        return ($val !== false && $val !== null) ? (string)$val : $default;
    } catch (Throwable $e) {
        return $default;
    }
}

/**
 * Update or insert setting into app_settings table.
 */
function updateAppSetting(string $key, string $value): bool {
    try {
        $pdo = getDatabaseConnection();
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM app_settings WHERE setting_key = ?");
        $stmt->execute([$key]);
        if ((int)$stmt->fetchColumn() > 0) {
            $upd = $pdo->prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?");
            return $upd->execute([$value, $key]);
        } else {
            $ins = $pdo->prepare("INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)");
            return $ins->execute([$key, $value]);
        }
    } catch (Throwable $e) {
        error_log("[PulseTrade updateAppSetting Error] " . $e->getMessage());
        return false;
    }
}

/**
 * Formats a user row into the standardized user DTO.
 */
function formatUserDTO(array $user): array {
    $isVip = (int)($user['is_vip'] ?? 0) === 1;
    $vipExpiresAt = $user['vip_expires_at'] ?? null;
    $vipSecondsLeft = 0;
    $vipDaysLeft = 0;
    $vipHoursLeft = 0;

    if ($isVip && !empty($vipExpiresAt)) {
        $expires = strtotime((string)$vipExpiresAt);
        $now = time();
        if ($expires <= $now) {
            $isVip = false;
            try {
                $pdo = getDatabaseConnection();
                $pdo->prepare("UPDATE users SET is_vip = 0 WHERE id = ?")->execute([$user['id']]);
            } catch (Throwable $e) {}
        } else {
            $vipSecondsLeft = max(0, $expires - $now);
            $vipDaysLeft = (int)floor($vipSecondsLeft / 86400);
            $vipHoursLeft = (int)floor(($vipSecondsLeft % 86400) / 3600);
        }
    }

    return [
        'id' => (int)$user['id'],
        'username' => (string)$user['username'],
        'email' => (string)$user['email'],
        'role' => (string)($user['role'] ?? 'USER'),
        'credits' => (int)($user['credits'] ?? 0),
        'is_vip' => $isVip ? 1 : 0,
        'vip_expires_at' => $vipExpiresAt,
        'vip_days_left' => $vipDaysLeft,
        'vip_hours_left' => $vipHoursLeft,
        'vip_seconds_left' => $vipSecondsLeft,
    ];
}

/**
 * Returns current authenticated user based on session or null.
 */
function getCurrentUser(): ?array {
    $userId = $_SESSION['user_id'] ?? null;
    if (!$userId) {
        return null;
    }
    try {
        $pdo = getDatabaseConnection();
        $stmt = $pdo->prepare("SELECT id, username, email, role, credits, is_vip, vip_expires_at, registration_ip FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([(int)$userId]);
        $row = $stmt->fetch();
        if (!$row) {
            unset($_SESSION['user_id']);
            return null;
        }
        return formatUserDTO($row);
    } catch (Throwable $e) {
        error_log("[PulseTrade getCurrentUser Error] " . $e->getMessage());
        return null;
    }
}
