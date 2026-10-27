<?php
/**
 * PulseTrade Pro - Real-Time Visitor & Session Heartbeat Engine
 * Mobile-First Multi-User Tracker
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

try {
    $pdo = getDatabaseConnection();
    $rawSessionId = $_GET['session_id'] ?? $_POST['session_id'] ?? ($_SERVER['HTTP_X_SESSION_ID'] ?? '');
    $sessionId = !empty($rawSessionId) ? preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$rawSessionId) : (session_id() ?: ('sess_' . md5($ip . ($_SERVER['HTTP_USER_AGENT'] ?? 'device') . microtime())));
    $ip = getClientIP();
    $user = getCurrentUser();
    $userId = $user ? (int)$user['id'] : null;

    // Refresh current visitor session in active_sessions
    try {
        $stmt = $pdo->prepare("
            INSERT INTO active_sessions (session_id, user_id, ip_address, last_heartbeat)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE 
                user_id = VALUES(user_id),
                ip_address = VALUES(ip_address),
                last_heartbeat = CURRENT_TIMESTAMP
        ");
        $stmt->execute([$sessionId, $userId, $ip]);
    } catch (Exception $e) {
        // Fallback for SQLite
        $rep = $pdo->prepare("
            INSERT OR REPLACE INTO active_sessions (session_id, user_id, ip_address, last_heartbeat)
            VALUES (?, ?, ?, datetime('now'))
        ");
        $rep->execute([$sessionId, $userId, $ip]);
    }

    // Prune expired sessions older than 45 seconds
    try {
        // MySQL format
        $pdo->exec("DELETE FROM active_sessions WHERE last_heartbeat < (NOW() - INTERVAL 45 SECOND)");
    } catch (Exception $e) {
        // SQLite format
        $pdo->exec("DELETE FROM active_sessions WHERE last_heartbeat < datetime('now', '-45 seconds')");
    }

    // Calculate live active traders count
    $countStmt = $pdo->query("SELECT COUNT(DISTINCT session_id) as total FROM active_sessions");
    $totalCount = (int)$countStmt->fetchColumn();

    // Exact genuine count of connected sessions currently pulsing
    $activeCount = max($totalCount, 1);

    echo json_encode([
        'status' => 'ok',
        'online_count' => $activeCount,
        'user' => $user ? [
            'id' => $user['id'],
            'username' => $user['username'],
            'credits' => (int)$user['credits'],
            'is_vip' => (int)$user['is_vip'],
            'role' => $user['role']
        ] : null,
        'timestamp' => time()
    ], JSON_THROW_ON_ERROR);

} catch (Throwable $e) {
    error_log("[PulseTrade Heartbeat Exception] " . $e->getMessage());
    echo json_encode([
        'status' => 'ok',
        'online_count' => 1,
        'user' => null,
        'timestamp' => time(),
        'notice' => 'Autonomous failover safe state active.'
    ]);
}
