/**
 * Pure, deterministic indicator calculations over Candle[] and price arrays.
 * Zero randomness, zero volume/order-book fabrication.
 */

import type { Candle } from '../../services/liveFeed.ts';
import type { KeyLevels } from './types.ts';
import type { PriceDistributionProxy } from '../../types.ts';

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) {
    return prices.reduce((acc, val) => acc + val, 0) / prices.length;
  }
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((acc, val) => acc + val, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateEMASeries(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let ema = prices[0];
  for (let i = 0; i < prices.length; i++) {
    if (i < period) {
      ema = prices.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    } else {
      ema = prices[i] * k + ema * (1 - k);
    }
    out.push(ema);
  }
  return out;
}

export function calculateRSI(prices: number[], period = 14): number {
  if (prices.length <= period) return 50.0;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return avgGain === 0 ? 50.0 : 100.0;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

export function calculateBollingerBands(
  prices: number[],
  period = 20,
  stdDevMultiplier = 2.0
): { upper: number; middle: number; lower: number; bandwidth: number; pctB: number } {
  if (prices.length === 0) {
    return { upper: 0, middle: 0, lower: 0, bandwidth: 0, pctB: 0.5 };
  }
  const safePeriod = Math.min(period, prices.length);
  const slice = prices.slice(-safePeriod);
  const mean = slice.reduce((a, b) => a + b, 0) / safePeriod;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / safePeriod;
  const stdDev = Math.sqrt(variance);

  const upper = mean + stdDevMultiplier * stdDev;
  const lower = mean - stdDevMultiplier * stdDev;
  const bandwidth = (upper - lower) / (mean || 1);
  const currentPrice = slice[slice.length - 1];
  const pctB = upper === lower ? 0.5 : (currentPrice - lower) / (upper - lower);

  return { upper, middle: mean, lower, bandwidth, pctB };
}

/**
 * Average True Range (Wilder smoothing) on OHLC candles.
 */
export function calculateATRSeries(candles: Candle[], period = 14): number[] {
  if (candles.length < 2) return [];
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    const avg = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    return [avg];
  }

  const atrSeries: number[] = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrSeries.push(atr);

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrSeries.push(atr);
  }
  return atrSeries;
}

export function calculateATR(candles: Candle[], period = 14): number {
  const series = calculateATRSeries(candles, period);
  return series.length > 0 ? series[series.length - 1] : 0;
}

/**
 * Percentile rank [0..100] of current ATR(14) vs historical ATR values in lookback.
 */
export function calculateATRPercentile(candles: Candle[], period = 14, lookback = 80): number {
  const series = calculateATRSeries(candles, period);
  if (series.length < 2) return 50;
  const recent = series.slice(-lookback);
  const current = recent[recent.length - 1];
  const belowOrEqual = recent.filter((v) => v <= current).length;
  return parseFloat(((belowOrEqual / recent.length) * 100).toFixed(1));
}

/**
 * Detect recent swing highs & lows from OHLC candles (fractal pivot width = 2).
 */
export function detectSwingLevels(candles: Candle[], pipSize = 0.0001): KeyLevels {
  if (candles.length < 5) {
    const lastClose = candles[candles.length - 1]?.close || 0;
    return {
      nearestSupport: lastClose - 10 * pipSize,
      nearestResistance: lastClose + 10 * pipSize,
      swingHighs: [],
      swingLows: [],
    };
  }

  const currentClose = candles[candles.length - 1].close;
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    if (
      h >= candles[i - 1].high &&
      h >= candles[i - 2].high &&
      h >= candles[i + 1].high &&
      h >= candles[i + 2].high
    ) {
      swingHighs.push(h);
    }
    if (
      l <= candles[i - 1].low &&
      l <= candles[i - 2].low &&
      l <= candles[i + 1].low &&
      l <= candles[i + 2].low
    ) {
      swingLows.push(l);
    }
  }

  const highsAbove = swingHighs.filter((h) => h > currentClose);
  const lowsBelow = swingLows.filter((l) => l < currentClose);

  const priorCandles = candles.length > 5 ? candles.slice(-24, -2) : candles;
  const priorHigh = Math.max(...priorCandles.map((c) => c.high));
  const priorLow = Math.min(...priorCandles.map((c) => c.low));
  const recentSpan = Math.max(pipSize * 15, (priorHigh - priorLow) * 0.35);

  const nearestResistance =
    highsAbove.length > 0
      ? Math.min(...highsAbove)
      : priorHigh > currentClose
      ? priorHigh
      : currentClose + recentSpan;

  const nearestSupport =
    lowsBelow.length > 0
      ? Math.max(...lowsBelow)
      : priorLow < currentClose
      ? priorLow
      : currentClose - recentSpan;

  return {
    nearestSupport,
    nearestResistance,
    swingHighs: swingHighs.slice(-5),
    swingLows: swingLows.slice(-5),
  };
}

/**
 * Price momentum proxy computed strictly from positive vs negative tick/close deltas.
 * (No true market volume or order book is implied.)
 */
export function calculatePriceMomentumProxy(
  prices: number[],
  window = 20
): { buyPct: number; sellPct: number } {
  if (prices.length < 2) return { buyPct: 50, sellPct: 50 };
  const slice = prices.slice(-Math.min(window, prices.length));
  let upMove = 0;
  let downMove = 0;

  for (let i = 1; i < slice.length; i++) {
    const delta = slice[i] - slice[i - 1];
    if (delta > 0) upMove += delta;
    else if (delta < 0) downMove += Math.abs(delta);
  }

  const total = upMove + downMove;
  if (total === 0) return { buyPct: 50, sellPct: 50 };
  const buyPct = Math.round((upMove / total) * 100);
  return { buyPct, sellPct: 100 - buyPct };
}

/**
 * Empirical price-time distribution proxy (modal dwell zone & interquartile-like band).
 */
export function calculatePriceDistributionProxy(
  prices: number[],
  pipSize: number
): PriceDistributionProxy {
  const safePrices = prices.length > 0 ? prices : [0];
  const rangeHigh = Math.max(...safePrices);
  const rangeLow = Math.min(...safePrices);
  const currentPrice = safePrices[safePrices.length - 1];

  if (rangeHigh === rangeLow) {
    return {
      modePrice: currentPrice,
      valueAreaHigh: currentPrice + 2 * pipSize,
      valueAreaLow: currentPrice - 2 * pipSize,
      highDensityNodePips: 0,
      rangeHigh,
      rangeLow,
    };
  }

  const binsCount = 10;
  const binStep = (rangeHigh - rangeLow) / binsCount;
  const bins = new Array(binsCount).fill(0);

  for (const p of safePrices) {
    const idx = Math.min(binsCount - 1, Math.max(0, Math.floor((p - rangeLow) / binStep)));
    bins[idx]++;
  }

  let maxCount = -1;
  let modeIdx = Math.floor(binsCount / 2);
  for (let i = 0; i < binsCount; i++) {
    if (bins[i] > maxCount) {
      maxCount = bins[i];
      modeIdx = i;
    }
  }

  const modePrice = parseFloat((rangeLow + (modeIdx + 0.5) * binStep).toFixed(5));
  const vahIdx = Math.min(binsCount - 1, modeIdx + 2);
  const valIdx = Math.max(0, modeIdx - 2);
  const valueAreaHigh = parseFloat((rangeLow + (vahIdx + 0.5) * binStep).toFixed(5));
  const valueAreaLow = parseFloat((rangeLow + (valIdx + 0.5) * binStep).toFixed(5));
  const highDensityNodePips = parseFloat((Math.abs(currentPrice - modePrice) / (pipSize || 0.0001)).toFixed(1));

  return {
    modePrice,
    valueAreaHigh,
    valueAreaLow,
    highDensityNodePips,
    rangeHigh,
    rangeLow,
  };
}
