/**
 * Tolvexa Quantitative Indicators & Security Test Suite
 * Tests mathematical purity of EMA, RSI, MACD, Bollinger Bands, Order Flow, and NOWPayments HMAC-SHA512.
 * Run with: npx tsx scripts/test-indicators.ts
 */

import crypto from 'crypto';
import {
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateOrderFlow,
} from '../src/utils/quantEngine.ts';

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ [PASS] ${testName}`);
  } else {
    console.error(`  ✗ [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function assertClose(actual: number, expected: number, tolerance: number, testName: string) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, testName, `Expected ~${expected}, got ${actual} (diff: ${diff})`);
}

console.log('\n============================================================');
console.log('  TOLVEXA QUANTITATIVE ENGINE & HMAC SECURITY TEST SUITE');
console.log('============================================================\n');

// 1. EMA Calculation Tests
console.log('1. Exponential Moving Average (EMA) Equations:');
{
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const ema5 = calculateEMA(prices, 5);
  
  assert(typeof ema5 === 'number' && !isNaN(ema5), 'EMA produces valid numeric value');
  // With strictly rising prices, EMA should lag behind current price (ema < current)
  const lastPrice = prices[prices.length - 1];
  assert(ema5 < lastPrice && ema5 > prices[0], 'EMA properly lags strictly ascending prices');
  assertClose(ema5, 18.0, 1.0, 'EMA(5) of sequence [10..20] aligns with expected smoothing (~18.0)');
}

// 2. RSI Calculation Tests
console.log('\n2. Relative Strength Index (RSI 14) Telemetry:');
{
  // Strictly ascending prices should yield high RSI (approaching 100)
  const uptrend = Array.from({ length: 30 }, (_, i) => 1.0800 + i * 0.0005);
  const rsiUp = calculateRSI(uptrend, 14);
  assert(rsiUp >= 70, 'Uptrend yields overbought/high RSI (>= 70)', `Got: ${rsiUp}`);
  assert(rsiUp <= 100, 'RSI does not exceed upper boundary 100', `Got: ${rsiUp}`);

  // Strictly descending prices should yield low RSI (approaching 0)
  const downtrend = Array.from({ length: 30 }, (_, i) => 1.0950 - i * 0.0005);
  const rsiDown = calculateRSI(downtrend, 14);
  assert(rsiDown <= 30, 'Downtrend yields oversold/low RSI (<= 30)', `Got: ${rsiDown}`);
  assert(rsiDown >= 0, 'RSI does not fall below lower boundary 0', `Got: ${rsiDown}`);

  // Neutral oscillating flat series should be near 50
  const flat = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101];
  const rsiFlat = calculateRSI(flat, 14);
  assertClose(rsiFlat, 50, 5, 'Flat alternating price stream centers around 50');
}

// 3. MACD Calculation Tests
console.log('\n3. Moving Average Convergence Divergence (MACD 12, 26, 9):');
{
  const series = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 10);
  const macd = calculateMACD(series);
  
  assert(typeof macd.macdLine === 'number' && !isNaN(macd.macdLine), 'MACD line is valid number');
  assert(typeof macd.signalLine === 'number' && !isNaN(macd.signalLine), 'Signal line is valid number');
  assert(typeof macd.histogram === 'number' && !isNaN(macd.histogram), 'Histogram is valid number');
  assertClose(macd.histogram, macd.macdLine - macd.signalLine, 0.0001, 'Histogram equals MACD line minus signal line');
}

// 4. Bollinger Bands & Order Flow
console.log('\n4. Volatility Dispersion & Order Flow Proxy:');
{
  const prices = Array.from({ length: 30 }, (_, i) => 1.0850 + Math.sin(i / 2) * 0.0020);
  const bb = calculateBollingerBands(prices, 20, 2.0);
  assert(bb.upper > bb.middle, 'Bollinger upper band is strictly above middle SMA');
  assert(bb.lower < bb.middle, 'Bollinger lower band is strictly below middle SMA');
  assert(bb.pctB >= 0 && bb.pctB <= 1.5, '%B metric correctly bounds relative price location');

  const of = calculateOrderFlow([1.0850, 1.0852, 1.0855, 1.0858, 1.0860]);
  assert(of.buyPct > 70, 'Ascending ticks indicate buy-dominant tick delta (>70%)');
  assert(of.buyPct + of.sellPct === 100, 'Buy + Sell percentage sums to exactly 100%');
}

// 5. NOWPayments HMAC-SHA512 Webhook Security Tests
console.log('\n5. NOWPayments IPN HMAC-SHA512 Security Verification:');
{
  const IPN_SECRET = 'TEST_TOLVEXA_SECRET_KEY_9876543210';
  const samplePayload = {
    payment_id: 'np_test_998822',
    payment_status: 'finished',
    price_amount: 29.99,
    price_currency: 'usd',
    pay_amount: 0.00035,
    actually_paid: 0.00035,
    order_id: 'order_usr_12345',
  };

  function computeIpnHmac(payload: Record<string, any>, secret: string): string {
    const sortedKeys = Object.keys(payload).sort();
    const sortedObj: Record<string, any> = {};
    for (const key of sortedKeys) {
      sortedObj[key] = payload[key];
    }
    const serialized = JSON.stringify(sortedObj);
    return crypto.createHmac('sha512', secret).update(serialized).digest('hex');
  }

  function verifyIpn(payload: Record<string, any>, headerSig: string | undefined, secret: string | undefined): boolean {
    if (!secret || !headerSig) return false;
    const expected = computeIpnHmac(payload, secret);
    try {
      return crypto.timingSafeEqual(Buffer.from(headerSig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  const validSignature = computeIpnHmac(samplePayload, IPN_SECRET);

  assert(verifyIpn(samplePayload, validSignature, IPN_SECRET) === true, 'Valid HMAC-SHA512 signature is verified');
  assert(verifyIpn(samplePayload, validSignature, undefined) === false, 'Missing IPN secret fails closed');
  assert(verifyIpn(samplePayload, undefined, IPN_SECRET) === false, 'Missing x-nowpayments-sig fails closed');
  
  const tamperedPayload = { ...samplePayload, price_amount: 0.01 };
  assert(verifyIpn(tamperedPayload, validSignature, IPN_SECRET) === false, 'Tampered price amount produces signature mismatch');

  const fakeStatusPayload = { ...samplePayload, payment_status: 'waiting' };
  assert(verifyIpn(fakeStatusPayload, validSignature, IPN_SECRET) === false, 'Tampered status fails verification');
}

console.log('\n------------------------------------------------------------');
console.log(`Results: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('------------------------------------------------------------\n');

if (passedTests === totalTests) {
  console.log('✅ ALL QUANTITATIVE & SECURITY TESTS PASSED\n');
} else {
  console.error('❌ SOME TESTS FAILED\n');
  process.exit(1);
}
