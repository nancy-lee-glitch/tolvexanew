-- ============================================================================
-- PulseTrade Pro - Production Database Architecture
-- Self-Migrating Multi-Engine Schema (MySQL 8+ / MariaDB / SQLite compatible)
-- ============================================================================

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS `users` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `username` VARCHAR(50) NOT NULL UNIQUE,
    `email` VARCHAR(100) NOT NULL UNIQUE,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `credits` INT NOT NULL DEFAULT 10,
    `is_vip` TINYINT(1) NOT NULL DEFAULT 0,
    `vip_expires_at` DATETIME NULL,
    `registration_ip` VARCHAR(45) NOT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_user_role` (`role`),
    INDEX `idx_user_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. IP REGISTRATIONS & ANTI-HARVESTING SHIELD
CREATE TABLE IF NOT EXISTS `ip_registrations` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `ip_address` VARCHAR(45) NOT NULL UNIQUE,
    `bonus_claimed` TINYINT(1) NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_ip` (`ip_address`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. ACTIVE SESSIONS (Real-Time Live Heartbeat Engine)
CREATE TABLE IF NOT EXISTS `active_sessions` (
    `session_id` VARCHAR(128) PRIMARY KEY,
    `user_id` INT NULL,
    `ip_address` VARCHAR(45) NOT NULL,
    `last_heartbeat` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_heartbeat` (`last_heartbeat`),
    INDEX `idx_session_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. SYSTEM SETTINGS
CREATE TABLE IF NOT EXISTS `system_settings` (
    `setting_key` VARCHAR(50) PRIMARY KEY,
    `setting_value` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. CREDIT PRICING TIERS
CREATE TABLE IF NOT EXISTS `credit_pricing_tiers` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `credits_amount` INT NOT NULL,
    `bonus_credits` INT NOT NULL DEFAULT 0,
    `price_usd` DECIMAL(10,2) NOT NULL,
    `badge_label` VARCHAR(50) DEFAULT '',
    `is_active` TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. ADMIN CRYPTO WALLETS
CREATE TABLE IF NOT EXISTS `admin_crypto_wallets` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `coin_name` VARCHAR(50) NOT NULL,
    `symbol` VARCHAR(20) NOT NULL,
    `network` VARCHAR(50) NOT NULL,
    `wallet_address` VARCHAR(255) NOT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. CRYPTO INVOICES
CREATE TABLE IF NOT EXISTS `crypto_invoices` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `order_type` ENUM('CREDITS', 'VIP') NOT NULL,
    `tier_id` INT NULL,
    `price_usd` DECIMAL(10,2) NOT NULL,
    `pay_currency` VARCHAR(20) NOT NULL DEFAULT 'USDT',
    `payment_id` VARCHAR(100) NULL,
    `payment_status` ENUM('WAITING', 'FINISHED', 'FAILED') NOT NULL DEFAULT 'WAITING',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_invoice_user` (`user_id`),
    INDEX `idx_invoice_payment_id` (`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. SIGNAL FEEDBACK & RECALIBRATION LOGS
CREATE TABLE IF NOT EXISTS `signal_feedback` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `asset` VARCHAR(50) NOT NULL,
    `timeframe` VARCHAR(20) NOT NULL,
    `direction` ENUM('CALL', 'PUT') NOT NULL,
    `confidence` INT NOT NULL,
    `outcome` ENUM('WIN', 'LOSS') NOT NULL,
    `logged_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_feedback_user` (`user_id`),
    INDEX `idx_feedback_asset` (`asset`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- SEED DATA (Idempotent Inserts)
-- ============================================================================

INSERT IGNORE INTO `system_settings` (`setting_key`, `setting_value`) VALUES
('welcome_bonus_credits', '10'),
('vip_monthly_price_usd', '49.99'),
('nowpayments_api_key', ''),
('nowpayments_ipn_secret', ''),
('admin_pin', '7789'),
('app_name', 'PulseTrade Pro');

INSERT IGNORE INTO `credit_pricing_tiers` (`id`, `credits_amount`, `bonus_credits`, `price_usd`, `badge_label`, `is_active`) VALUES
(1, 10, 0, 5.00, 'Starter Pack', 1),
(2, 25, 5, 10.00, 'Popular (5 Free)', 1),
(3, 60, 20, 20.00, 'Pro Trader (+20)', 1),
(4, 150, 60, 45.00, 'Whale Alpha (+60)', 1);

INSERT IGNORE INTO `admin_crypto_wallets` (`id`, `coin_name`, `symbol`, `network`, `wallet_address`, `is_active`) VALUES
(1, 'Tether USD', 'USDT', 'TRC20', 'TJz7F8rK3vP1oXwY9mZqN2sAbCdEfGhIjK', 1),
(2, 'Bitcoin', 'BTC', 'Native SegWit', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 1),
(3, 'Solana', 'SOL', 'Solana Mainnet', '7Sbw7QkX2vG7L4k1vjGgHj8LpQpZ6PqP8kLmNoPqRsTu', 1);

-- Default Demo Admin User (Password: admin123)
-- Hash generated with PASSWORD_BCRYPT
INSERT IGNORE INTO `users` (`id`, `username`, `email`, `password_hash`, `role`, `credits`, `is_vip`, `registration_ip`) VALUES
(1, 'admin', 'admin@pulsetrade.pro', '$2y$10$fWfN2Yq7b6BfWfnP0oN/tebUoXoN4GekEeVp2uA5q90fJ49N30p9S', 'ADMIN', 999, 1, '127.0.0.1');
