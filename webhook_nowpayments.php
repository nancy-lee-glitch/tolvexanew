<?php
/**
 * PulseTrade Pro - NowPayments Instant Blockchain Webhook Handler
 * Automated Account Crediting & VIP Status Provisioner
 */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');

try {
    $rawPayload = file_get_contents('php://input');
    if (empty($rawPayload)) {
        http_response_code(400);
        echo json_encode(['error' => 'Empty webhook payload']);
        exit;
    }

    $ipnSecret = getSetting('nowpayments_ipn_secret', '');
    
    // Validate HMAC-SHA512 Signature if secret is configured
    if (!empty($ipnSecret)) {
        $receivedSig = $_SERVER['HTTP_X_NOWPAYMENTS_SIG'] ?? '';
        $data = json_decode($rawPayload, true);
        if (is_array($data)) {
            ksort($data);
            $sortedJson = json_encode($data, JSON_UNESCAPED_SLASHES);
            $calculatedSig = hash_hmac('sha512', (string)$sortedJson, $ipnSecret);
            if (!hash_equals($calculatedSig, (string)$receivedSig)) {
                error_log("[PulseTrade Webhook] Invalid HMAC signature received.");
                http_response_code(403);
                echo json_encode(['error' => 'Signature verification failed']);
                exit;
            }
        }
    }

    $payload = json_decode($rawPayload, true);
    if (!is_array($payload)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON']);
        exit;
    }

    $paymentStatus = strtoupper((string)($payload['payment_status'] ?? ''));
    $paymentId     = (string)($payload['payment_id'] ?? ($payload['invoice_id'] ?? ''));
    $orderId       = (string)($payload['order_id'] ?? '');

    $pdo = getDatabaseConnection();

    // Look up matching invoice
    $stmt = $pdo->prepare("SELECT id, user_id, order_type, tier_id, price_usd, payment_status FROM crypto_invoices WHERE payment_id = ? OR id = ? LIMIT 1");
    $stmt->execute([$paymentId, (int)$orderId]);
    $invoice = $stmt->fetch();

    if (!$invoice) {
        error_log("[PulseTrade Webhook] Unrecognized invoice for payment ID: $paymentId");
        // Acknowledge receipt to avoid webhook re-send storms
        echo json_encode(['status' => 'acknowledged', 'note' => 'Invoice record not found']);
        exit;
    }

    // Process only if status is FINISHED and hasn't already been processed
    if ($paymentStatus === 'FINISHED' && $invoice['payment_status'] !== 'FINISHED') {
        $userId = (int)$invoice['user_id'];
        $orderType = $invoice['order_type'];
        $tierId = (int)$invoice['tier_id'];

        if ($orderType === 'VIP') {
            // Extend or grant VIP for 30 days
            try {
                // MySQL syntax
                $upd = $pdo->prepare("
                    UPDATE users 
                    SET is_vip = 1, 
                        vip_expires_at = CASE 
                            WHEN is_vip = 1 AND vip_expires_at > NOW() THEN DATE_ADD(vip_expires_at, INTERVAL 30 DAY)
                            ELSE DATE_ADD(NOW(), INTERVAL 30 DAY)
                        END
                    WHERE id = ?
                ");
                $upd->execute([$userId]);
            } catch (Exception $e) {
                // SQLite syntax
                $upd = $pdo->prepare("
                    UPDATE users 
                    SET is_vip = 1, 
                        vip_expires_at = datetime('now', '+30 days')
                    WHERE id = ?
                ");
                $upd->execute([$userId]);
            }
        } elseif ($orderType === 'CREDITS') {
            // Fetch credits to add from tier
            $tierStmt = $pdo->prepare("SELECT credits_amount, bonus_credits FROM credit_pricing_tiers WHERE id = ?");
            $tierStmt->execute([$tierId]);
            $tier = $tierStmt->fetch();

            $creditsToAdd = $tier ? ((int)$tier['credits_amount'] + (int)$tier['bonus_credits']) : 25;

            $upd = $pdo->prepare("UPDATE users SET credits = credits + ? WHERE id = ?");
            $upd->execute([$creditsToAdd, $userId]);
        }

        // Mark invoice as FINISHED
        $invUpd = $pdo->prepare("UPDATE crypto_invoices SET payment_status = 'FINISHED' WHERE id = ?");
        $invUpd->execute([$invoice['id']]);

        error_log("[PulseTrade Webhook] Successfully processed payment #{$paymentId} for User #{$userId} ($orderType)");
    }

    echo json_encode([
        'status' => 'success',
        'payment_id' => $paymentId,
        'state' => $paymentStatus
    ]);

} catch (Throwable $e) {
    error_log("[PulseTrade Webhook Fatal] " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Internal processing error']);
}
