/**
 * instrumentMeta.ts — Canonical pip size, tick size, and distance unit resolution.
 *
 * Ensures Deriv's `pip_size` (minimum quote step, e.g. 0.00001 on 5-decimal FX)
 * is used ONLY for `decimals` and `tickSize`, while `pipSize` comes from
 * DEFAULT_INSTRUMENT_SPECS (EUR/USD = 0.0001, GBP/USD = 0.0001, USD/JPY = 0.01,
 * XAU/USD = 0.01, BTC/USD = 1.0, etc.), forex quote-currency rules (JPY -> 0.01,
 * other FX -> 0.0001), and `distanceUnit` ('pips' vs 'points').
 */

import type { AssetConfig, DistanceUnit, InstrumentSpec } from '../types.ts';

export const DEFAULT_INSTRUMENT_SPECS: Record<string, InstrumentSpec> = {
  'EUR/USD': { symbol: 'EUR/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'GBP/USD': { symbol: 'GBP/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'USD/JPY': { symbol: 'USD/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3, distanceUnit: 'pips' },
  'AUD/USD': { symbol: 'AUD/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'USD/CAD': { symbol: 'USD/CAD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'CAD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'USD/CHF': { symbol: 'USD/CHF', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'CHF', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'EUR/GBP': { symbol: 'EUR/GBP', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'GBP', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'GBP/JPY': { symbol: 'GBP/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3, distanceUnit: 'pips' },
  'EUR/JPY': { symbol: 'EUR/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3, distanceUnit: 'pips' },
  'XAU/USD': { symbol: 'XAU/USD', contractSize: 100, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.01, decimals: 2, distanceUnit: 'pips' },
  'XAG/USD': { symbol: 'XAG/USD', contractSize: 5000, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.001, decimals: 3, distanceUnit: 'pips' },
  'BTC/USD': { symbol: 'BTC/USD', contractSize: 1, minLot: 0.001, lotStep: 0.001, quoteCcy: 'USD', pipSize: 1.0, decimals: 2, distanceUnit: 'points' },
  'ETH/USD': { symbol: 'ETH/USD', contractSize: 1, minLot: 0.01, lotStep: 0.01, quoteCcy: 'USD', pipSize: 0.1, decimals: 2, distanceUnit: 'points' },
};

export function normalizeSpecKey(raw: string): string {
  const s = (raw || '').trim().toUpperCase();
  if (!s) return '';
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAU/USD';
  if (s.includes('XAG') || s.includes('SILVER')) return 'XAG/USD';

  const stripped = s.replace(/^FRX|^CRY|^WLDAUD|^WLD/, '');
  if (stripped.length === 6 && /^[A-Z]{6}$/.test(stripped)) {
    return `${stripped.slice(0, 3)}/${stripped.slice(3, 6)}`;
  }
  return s;
}

export function inferAssetCurrencies(asset: Pick<AssetConfig, 'symbol' | 'name' | 'type'>): {
  baseCcy: string;
  quoteCcy: string;
} {
  const clean = (asset.symbol || '')
    .toUpperCase()
    .replace(/^FRX|^CRY/, '')
    .replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{6}$/.test(clean)) {
    return { baseCcy: clean.slice(0, 3), quoteCcy: clean.slice(3, 6) };
  }
  const nameClean = (asset.name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (nameClean.includes('GOLD') || nameClean.includes('XAUUSD')) {
    return { baseCcy: 'XAU', quoteCcy: 'USD' };
  }
  if (nameClean.includes('SILVER') || nameClean.includes('XAGUSD')) {
    return { baseCcy: 'XAG', quoteCcy: 'USD' };
  }
  if (/^[A-Z]{6}$/.test(nameClean)) {
    return { baseCcy: nameClean.slice(0, 3), quoteCcy: nameClean.slice(3, 6) };
  }
  if (clean.startsWith('BTC') || clean.startsWith('ETH') || asset.type === 'CRYPTO') {
    return { baseCcy: clean.slice(0, 3) || 'CRYPTO', quoteCcy: 'USD' };
  }
  return { baseCcy: 'USD', quoteCcy: 'USD' };
}

export function resolveAssetPipSpec(
  asset?: Partial<Pick<AssetConfig, 'symbol' | 'name' | 'type' | 'pipSize' | 'tickSize' | 'decimals' | 'distanceUnit'>> & {
    market?: string;
  } | null
): {
  pipSize: number;
  tickSize: number;
  decimals: number;
  distanceUnit: DistanceUnit;
  unitSingular: 'pip' | 'point';
  unitShort: 'p' | 'pts';
} {
  if (!asset) {
    return {
      pipSize: 0.0001,
      tickSize: 0.00001,
      decimals: 5,
      distanceUnit: 'pips',
      unitSingular: 'pip',
      unitShort: 'p',
    };
  }

  const key = normalizeSpecKey(asset.symbol || '') || normalizeSpecKey(asset.name || '');
  const defaultSpec = key ? DEFAULT_INSTRUMENT_SPECS[key] : undefined;
  const marketLower = (asset.market || '').toLowerCase();
  const inferred = inferAssetCurrencies({
    symbol: asset.symbol || '',
    name: asset.name || '',
    type: asset.type || 'FOREX',
  });

  const validTick =
    typeof asset.tickSize === 'number' && Number.isFinite(asset.tickSize) && asset.tickSize > 0
      ? asset.tickSize
      : undefined;
  const validPipProp =
    typeof asset.pipSize === 'number' && Number.isFinite(asset.pipSize) && asset.pipSize > 0
      ? asset.pipSize
      : undefined;

  if (defaultSpec) {
    const decimals =
      typeof asset.decimals === 'number' && Number.isFinite(asset.decimals)
        ? asset.decimals
        : defaultSpec.decimals;
    const tickSize =
      validTick ?? parseFloat(Math.pow(10, -decimals).toFixed(Math.min(8, decimals)));
    const distanceUnit: DistanceUnit = defaultSpec.distanceUnit || 'pips';
    return {
      pipSize: defaultSpec.pipSize,
      tickSize,
      decimals,
      distanceUnit,
      unitSingular: distanceUnit === 'points' ? 'point' : 'pip',
      unitShort: distanceUnit === 'points' ? 'pts' : 'p',
    };
  }

  const isForex =
    asset.type === 'FOREX' ||
    marketLower === 'forex' ||
    (/^frx[A-Z]{6}$/i.test(asset.symbol || '') && !/XAU|XAG/i.test(asset.symbol || ''));

  if (isForex) {
    const isJpy = inferred.quoteCcy === 'JPY';
    const pipSize = isJpy ? 0.01 : 0.0001;
    const decimals =
      typeof asset.decimals === 'number' && Number.isFinite(asset.decimals)
        ? asset.decimals
        : isJpy
        ? 3
        : 5;
    const tickSize = validTick ?? parseFloat(Math.pow(10, -decimals).toFixed(decimals));
    return {
      pipSize,
      tickSize,
      decimals,
      distanceUnit: 'pips',
      unitSingular: 'pip',
      unitShort: 'p',
    };
  }

  // Indices, crypto, commodities not in table, stocks, synthetics -> distanceUnit = 'points'
  const decimals =
    typeof asset.decimals === 'number' && Number.isFinite(asset.decimals)
      ? asset.decimals
      : 2;
  const fallbackPointSize =
    asset.type === 'INDEX' || asset.type === 'CRYPTO' || marketLower === 'indices' || marketLower === 'cryptocurrency'
      ? 1.0
      : 0.01;
  const pipSize = validPipProp ?? validTick ?? fallbackPointSize;
  const tickSize = validTick ?? validPipProp ?? parseFloat(Math.pow(10, -decimals).toFixed(decimals));
  const distanceUnit: DistanceUnit = asset.distanceUnit === 'pips' ? 'pips' : 'points';

  return {
    pipSize,
    tickSize,
    decimals,
    distanceUnit,
    unitSingular: distanceUnit === 'points' ? 'point' : 'pip',
    unitShort: distanceUnit === 'points' ? 'pts' : 'p',
  };
}

export function formatDistanceUnitWord(value: number, unit: DistanceUnit): string {
  const isOne = Math.abs(Math.abs(value) - 1) < 1e-9;
  if (unit === 'points') {
    return isOne ? 'point' : 'points';
  }
  return isOne ? 'pip' : 'pips';
}
