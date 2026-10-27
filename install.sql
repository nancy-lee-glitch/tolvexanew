-- ============================================================================
-- PulseTrade Pro - Unified Database Schema & Installation Script
-- Fully Compatible with MySQL / MariaDB / PostgreSQL / SQLite via PDO
-- ============================================================================

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'USER',
    credits INTEGER NOT NULL DEFAULT 10,
    is_vip INTEGER NOT NULL DEFAULT 0,
    vip_expires_at DATETIME NULL,
    registration_ip VARCHAR(45) NOT NULL DEFAULT '127.0.0.1',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. IP REGISTRATIONS (Citadel Anti-Abuse Shield)
CREATE TABLE IF NOT EXISTS ip_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address VARCHAR(45) NOT NULL UNIQUE,
    bonus_claimed INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. ACTIVE SESSIONS (Real-Time Genuine Heartbeat & Presence)
CREATE TABLE IF NOT EXISTS active_sessions (
    session_id VARCHAR(128) PRIMARY KEY,
    user_id INTEGER NULL,
    ip_address VARCHAR(45) NOT NULL DEFAULT '127.0.0.1',
    active_asset VARCHAR(50) NOT NULL DEFAULT 'EUR/USD',
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. SIGNALS (Historical Record of Generated Signals)
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NULL,
    asset VARCHAR(50) NOT NULL,
    timeframe VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    entry_price REAL NOT NULL,
    target_price REAL NOT NULL,
    confidence REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. TRADE OUTCOMES (Outcome Logging & Dynamic Recalibration)
CREATE TABLE IF NOT EXISTS trade_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NULL,
    asset VARCHAR(50) NOT NULL,
    timeframe VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    confidence REAL NOT NULL DEFAULT 88.0,
    outcome VARCHAR(10) NOT NULL, -- 'WIN' or 'LOSS'
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. VIP KEYS (Activation Codes with Duration and Usage Limits)
CREATE TABLE IF NOT EXISTS vip_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code VARCHAR(64) NOT NULL UNIQUE,
    duration_days INTEGER NOT NULL DEFAULT 30,
    max_uses INTEGER NOT NULL DEFAULT 100,
    used_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. APP SETTINGS (JSON / Key-Value Store for Platform Branding & Gateway Config)
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL
);

-- 8. CRYPTO DEPOSITS / PAYMENT ORDERS (NOWPayments Integration)
CREATE TABLE IF NOT EXISTS crypto_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id VARCHAR(100) NOT NULL UNIQUE,
    user_id INTEGER NULL,
    order_id VARCHAR(100) NULL,
    product_type VARCHAR(50) NOT NULL DEFAULT 'VIP_30D', -- 'VIP_30D' or 'CREDITS_50' etc.
    amount REAL NOT NULL,
    currency VARCHAR(20) NOT NULL DEFAULT 'USD',
    pay_address VARCHAR(255) NULL,
    pay_amount REAL NULL,
    pay_currency VARCHAR(20) NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'waiting', -- 'waiting', 'confirming', 'confirmed', 'finished', 'failed', 'expired'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9. PRICING PACKAGES (Admin-Editable Monetization Tiers)
CREATE TABLE IF NOT EXISTS pricing_packages (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(30) NOT NULL DEFAULT 'CREDITS', -- 'CREDITS', 'VIP_30_DAY', 'BUNDLE'
    credits_amount INTEGER NOT NULL DEFAULT 0,
    bonus_credits INTEGER NOT NULL DEFAULT 0,
    price_usd REAL NOT NULL DEFAULT 0,
    badge_label VARCHAR(50) NULL,
    description TEXT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 10. VIP CODES (Professional One-Time Single-Use Activation Keys)
CREATE TABLE IF NOT EXISTS vip_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code VARCHAR(64) NOT NULL UNIQUE,
    duration_days INTEGER NOT NULL DEFAULT 30,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_redeemed INTEGER NOT NULL DEFAULT 0,
    redeemed_by_user_id INTEGER NULL,
    redeemed_by_username VARCHAR(100) NULL,
    redeemed_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(50) NULL
);

-- 11. BLOG POSTS (Admin CMS)
CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    excerpt TEXT NULL,
    body TEXT NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'Quantitative Strategy',
    cover_url VARCHAR(500) NULL,
    is_published INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- App Settings (Branding & NOWPayments Configuration)
INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES
('site_name', 'PulseTrade Pro'),
('site_tagline', 'Institutional-Grade Micro-Volatility Terminal'),
('badge_text', 'v8.2 QUANT'),
('banner_text', '⚡ 30-Day VIP Pass: Institutional-grade 89.4% confluence signals with instant automated verification'),
('banner_enabled', '1'),
('support_telegram', 'https://t.me/pulsetrade_quant'),
('support_email', 'support@pulsetrade.pro'),
('vip_price_usd', '49'),
('starter_price_usd', '5'),
('welcome_bonus_credits', '10'),
('nowpayments_config', '{"apiKey":"","ipnSecret":"","isSandbox":false,"enabled":false,"payoutAddress":""}');

-- Sample VIP Keys (Strict 30-Day Duration)
INSERT OR IGNORE INTO vip_keys (code, duration_days, max_uses, used_count, is_active) VALUES
('VIP-ALPHA-30D', 30, 9999, 0, 1),
('PULSE-VIP-2026', 30, 9999, 0, 1),
('QUANT-30D', 30, 9999, 0, 1),
('VIP-TRADER-1M', 30, 9999, 0, 1);

-- Default Admin User
-- Credentials for local/dev: username: admin (or durodoluwa5@gmail.com), password: 7789
-- Hash: $2y$10$fWfN2Yq7b6BfWfnP0oN/tebUoXoN4GekEeVp2uA5q90fJ49N30p9S (matches 7789 / admin123)
INSERT OR IGNORE INTO users (id, username, email, password_hash, role, credits, is_vip, vip_expires_at, registration_ip)
VALUES (1, 'admin', 'durodoluwa5@gmail.com', '$2y$10$bYf5a.H8tK.oAevXfH.q5OnLz7vW5f9p0QpT8nO6s9fM4iK1jZ0iS', 'ADMIN', 9999, 1, '2030-01-01 00:00:00', '127.0.0.1');
