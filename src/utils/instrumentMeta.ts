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
  'EUR/USD': { symbol: 'EUR/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'GBP/USD': { symbol: 'GBP/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'USD/JPY': { symbol: 'USD/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3, distanceUnit: 'pips' },
  'AUD/USD': { symbol: 'AUD/USD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'USD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'USD/CAD': { symbol: 'USD/CAD', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'CAD', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'USD/CHF': { symbol: 'USD/CHF', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'CHF', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'EUR/GBP': { symbol: 'EUR/GBP', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'GBP', pipSize: 0.0001, decimals: 5, distanceUnit: 'pips' },
  'GBP/JPY': { symbol: 'GBP/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3, distanceUnit: 'pips' },
  'EUR/JPY': { symbol: 'EUR/JPY', contractSize: 100000, minLot: 0.01, lotStep: 0.01, maxLot: 50, quoteCcy: 'JPY', pipSize: 0.01, decimals: 3, distanceUnit: 'pips' },
  'XAU/USD': { symbol: 'XAU/USD', contractSize: 100, minLot: 0.01, lotStep: 0.01, maxLot: 20, quoteCcy: 'USD', pipSize: 0.01, decimals: 2, distanceUnit: 'pips' },
  'XAG/USD': { symbol: 'XAG/USD', contractSize: 5000, minLot: 0.01, lotStep: 0.01, maxLot: 20, quoteCcy: 'USD', pipSize: 0.001, decimals: 3, distanceUnit: 'pips' },
  'BTC/USD': { symbol: 'BTC/USD', contractSize: 1, minLot: 0.001, lotStep: 0.001, maxLot: 100, quoteCcy: 'USD', pipSize: 1.0, decimals: 2, distanceUnit: 'points' },
  'ETH/USD': { symbol: 'ETH/USD', contractSize: 1, minLot: 0.01, lotStep: 0.01, maxLot: 100, quoteCcy: 'USD', pipSize: 0.1, decimals: 2, distanceUnit: 'points' },
};

const METAL_CODES = new Set(['XAU', 'XAG', 'XPD', 'XPT']);

export function normalizeSpecKey(raw: string): string {
  const s = (raw || '').trim().toUpperCase();
  if (!s) return '';

  // Strip Deriv market prefixes first so `frxAUDUSD` -> `AUDUSD` (never matching `XAU` across `frx` + `AU`)
  const stripped = s.replace(/^(FRX|CRY|WLDAUD|WLD)/, '');
  const compactSlash = stripped.replace(/\//g, '');

  // Map Gold / Silver only on exact symbol keys XAUUSD / XAGUSD or exact display names Gold / Silver
  if (compactSlash === 'XAUUSD' || s === 'GOLD') return 'XAU/USD';
  if (compactSlash === 'XAGUSD' || s === 'SILVER') return 'XAG/USD';

  // Exact 6-letter pair (without underscores like OTC_SPC) -> AAA/BBB
  if (/^[A-Z]{6}$/.test(compactSlash)) {
    return `${compactSlash.slice(0, 3)}/${compactSlash.slice(3, 6)}`;
  }

  return s;
}

export function inferAssetCurrencies(asset: Pick<AssetConfig, 'symbol' | 'name' | 'type'>): {
  baseCcy: string;
  quoteCcy: string;
} {
  const rawSym = (asset.symbol || '').trim().toUpperCase();
  const strippedSym = rawSym.replace(/^(FRX|CRY|WLDAUD|WLD)/, '').replace(/\//g, '');

  if (/^[A-Z]{6}$/.test(strippedSym)) {
    return { baseCcy: strippedSym.slice(0, 3), quoteCcy: strippedSym.slice(3, 6) };
  }

  const nameUpper = (asset.name || '').trim().toUpperCase();
  const nameCompactSlash = nameUpper.replace(/\//g, '');
  if (nameUpper === 'GOLD' || nameCompactSlash === 'XAUUSD') {
    return { baseCcy: 'XAU', quoteCcy: 'USD' };
  }
  if (nameUpper === 'SILVER' || nameCompactSlash === 'XAGUSD') {
    return { baseCcy: 'XAG', quoteCcy: 'USD' };
  }
  if (/^[A-Z]{6}$/.test(nameCompactSlash)) {
    return { baseCcy: nameCompactSlash.slice(0, 3), quoteCcy: nameCompactSlash.slice(3, 6) };
  }

  if (strippedSym === 'BTC' || strippedSym === 'ETH' || asset.type === 'CRYPTO') {
    const base = /^[A-Z]{3}/.test(strippedSym) ? strippedSym.slice(0, 3) : 'CRYPTO';
    return { baseCcy: base, quoteCcy: 'USD' };
  }

  return { baseCcy: 'USD', quoteCcy: 'USD' };
}

export function resolveDefaultMaxLot(
  asset: Pick<AssetConfig, 'symbol' | 'name' | 'type'>
): number {
  const key = normalizeSpecKey(asset.symbol) || normalizeSpecKey(asset.name);
  const byKey = key ? DEFAULT_INSTRUMENT_SPECS[key] : undefined;
  if (byKey?.maxLot && byKey.maxLot > 0) return byKey.maxLot;
  if (key === 'XAU/USD' || key === 'XAG/USD' || asset.type === 'COMMODITY') return 20;
  if (asset.type === 'CRYPTO') return 100;
  return 50;
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
  unitSingular: 'pip' | 'point' | '';
  unitShort: 'p' | 'pts' | '';
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

  const FIAT_CODES = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
    'SEK', 'NOK', 'SGD', 'HKD', 'MXN', 'ZAR', 'TRY', 'PLN', 'CZK', 'HUF', 'CNH', 'DKK',
  ]);
  const explicitNonForexType =
    Boolean(asset.type && asset.type !== 'FOREX') ||
    Boolean(marketLower && marketLower !== 'forex');
  const bareFx = (asset.symbol || '').trim().toUpperCase().replace(/^FRX/, '');
  const isSixLetterFx =
    /^[A-Z]{6}$/.test(bareFx) &&
    !METAL_CODES.has(bareFx.slice(0, 3)) &&
    !METAL_CODES.has(bareFx.slice(3, 6));
  const isForex =
    asset.type === 'FOREX' ||
    marketLower === 'forex' ||
    (!explicitNonForexType &&
      ((/^frx[A-Z]{6}$/i.test(asset.symbol || '') && isSixLetterFx) ||
        (FIAT_CODES.has(inferred.baseCcy) &&
          FIAT_CODES.has(inferred.quoteCcy) &&
          inferred.baseCcy !== inferred.quoteCcy)));

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

  // Synthetics, indices, commodities, stocks, and unmapped crypto without a table entry
  // have no defined pip/point value -> use plain price differences ('price').
  const decimals =
    typeof asset.decimals === 'number' && Number.isFinite(asset.decimals)
      ? asset.decimals
      : 2;
  const fallbackStep = parseFloat(Math.pow(10, -Math.min(8, Math.max(0, decimals))).toFixed(Math.min(8, Math.max(0, decimals))));
  const tickSize = validTick ?? validPipProp ?? (fallbackStep > 0 ? fallbackStep : 0.01);
  const pipSize = validPipProp ?? validTick ?? tickSize;

  return {
    pipSize,
    tickSize,
    decimals,
    distanceUnit: 'price',
    unitSingular: '',
    unitShort: '',
  };
}

export function resolveBaseInstrumentSpec(
  asset: AssetConfig,
  overrideSpec?: Partial<InstrumentSpec>,
  contractSizeOverride?: number
): InstrumentSpec {
  const key = normalizeSpecKey(asset.symbol) || normalizeSpecKey(asset.name);
  const { quoteCcy: inferredQuote } = inferAssetCurrencies(asset);
  const defaultBySymbol = DEFAULT_INSTRUMENT_SPECS[key];
  const resolvedPip = resolveAssetPipSpec(asset);
  const bareSym = (asset.symbol || '').trim().toUpperCase().replace(/^(FRX|CRY)/, '');

  let defaultContract = 1;
  if (defaultBySymbol) {
    defaultContract = defaultBySymbol.contractSize;
  } else if (asset.type === 'FOREX') {
    defaultContract = 100000;
  } else if (asset.type === 'COMMODITY') {
    defaultContract = bareSym === 'XAGUSD' ? 5000 : 100;
  } else {
    defaultContract = 1;
  }

  const baseSpec: InstrumentSpec = {
    symbol: key || asset.symbol,
    contractSize:
      overrideSpec?.contractSize && overrideSpec.contractSize > 0
        ? Number(overrideSpec.contractSize)
        : defaultContract,
    minLot:
      overrideSpec?.minLot && overrideSpec.minLot > 0
        ? Number(overrideSpec.minLot)
        : defaultBySymbol?.minLot ?? 0.01,
    lotStep:
      overrideSpec?.lotStep && overrideSpec.lotStep > 0
        ? Number(overrideSpec.lotStep)
        : defaultBySymbol?.lotStep ?? 0.01,
    maxLot:
      overrideSpec?.maxLot && overrideSpec.maxLot > 0
        ? Number(overrideSpec.maxLot)
        : resolveDefaultMaxLot(asset),
    quoteCcy: (overrideSpec?.quoteCcy || defaultBySymbol?.quoteCcy || inferredQuote || 'USD').toUpperCase(),
    pipSize:
      overrideSpec?.pipSize && overrideSpec.pipSize > 0
        ? Number(overrideSpec.pipSize)
        : resolvedPip.pipSize,
    decimals:
      typeof overrideSpec?.decimals === 'number'
        ? overrideSpec.decimals
        : resolvedPip.decimals,
    distanceUnit: overrideSpec?.distanceUnit || resolvedPip.distanceUnit,
  };

  if (typeof contractSizeOverride === 'number' && Number.isFinite(contractSizeOverride) && contractSizeOverride > 0) {
    baseSpec.contractSize = contractSizeOverride;
  }

  return baseSpec;
}

export interface SpecValidationResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Defence-in-depth spec assertion:
 * Every symbol matching /^frx[A-Z]{6}$/ other than XAUUSD/XAGUSD must have
 * contractSize === 100000 and pipSize === 0.0001 (0.01 when quote currency is JPY).
 */
export function assertSpecMatchesSymbol(
  symbol: string,
  spec: Pick<InstrumentSpec, 'contractSize' | 'pipSize' | 'quoteCcy'>
): SpecValidationResult {
  const trimmed = (symbol || '').trim();
  if (!/^frx[A-Z]{6}$/i.test(trimmed)) {
    return { ok: true };
  }
  const bare = trimmed.slice(3).toUpperCase();
  if (bare === 'XAUUSD' || bare === 'XAGUSD') {
    return { ok: true };
  }

  const quoteCcy = bare.slice(3, 6);
  const expectedContract = 100000;
  const expectedPipSize = quoteCcy === 'JPY' ? 0.01 : 0.0001;
  const contractOk = spec.contractSize === expectedContract;
  const pipOk = Math.abs(spec.pipSize - expectedPipSize) < 1e-9;

  if (!contractOk || !pipOk) {
    return {
      ok: false,
      reason: 'Instrument settings mismatch; analysis disabled for safety',
      detail: `Spec mismatch for ${trimmed}: expected contractSize=${expectedContract}, pipSize=${expectedPipSize}, got contractSize=${spec.contractSize}, pipSize=${spec.pipSize}`,
    };
  }
  return { ok: true };
}

/**
 * OTC guard: blocks ONLY when broker_assets row / asset has is_otc === true,
 * or when the display name ends in "OTC" (e.g. "EUR/USD OTC").
 * Allows real Deriv stock indices named `OTC_SPC`, `OTC_NDX`, `OTC_DJI`.
 */
export function isOtcInstrument(
  asset?: Pick<AssetConfig, 'symbol' | 'name' | 'is_otc'> | null,
  brokerIsOtc?: boolean
): boolean {
  if (brokerIsOtc || asset?.is_otc) return true;
  const displayName = (asset?.name || '').trim();
  if (!displayName) return false;
  return /(?:^|[\s-])OTC$/i.test(displayName);
}

export function formatDistanceUnitWord(value: number, unit: DistanceUnit): string {
  if (unit === 'price') {
    return '';
  }
  const isOne = Math.abs(Math.abs(value) - 1) < 1e-9;
  if (unit === 'points') {
    return isOne ? 'point' : 'points';
  }
  return isOne ? 'pip' : 'pips';
}

export function formatPriceDifference(
  priceDiff: number,
  decimals: number,
  signed = true
): string {
  const safeDec = Math.min(8, Math.max(0, decimals));
  const safeVal = Number.isFinite(priceDiff) ? priceDiff : 0;
  const sign = safeVal < 0 ? '-' : signed ? '+' : '';
  return `${sign}${Math.abs(safeVal).toFixed(safeDec)}`;
}

export function formatSignedDistance(
  pipValue: number,
  pipSize: number,
  decimals: number,
  unit: DistanceUnit,
  options?: { signed?: boolean; pipDecimals?: number }
): string {
  const signed = options?.signed ?? false;
  const pipDec = options?.pipDecimals ?? 1;
  if (unit === 'price') {
    const safePip = pipSize > 0 ? pipSize : 1;
    return formatPriceDifference(pipValue * safePip, decimals, signed);
  }
  const rounded = parseFloat(pipValue.toFixed(pipDec));
  const word = formatDistanceUnitWord(rounded, unit);
  const sign = rounded < 0 ? '-' : signed ? '+' : '';
  const numStr = Math.abs(rounded).toFixed(pipDec);
  return word ? `${sign}${numStr} ${word}` : `${sign}${numStr}`;
}

export function formatChartChangeSummary(params: {
  changePrice: number;
  changePips: number;
  changePct: number;
  decimals: number;
  distanceUnit: DistanceUnit;
}): string {
  const { changePrice, changePips, changePct, decimals, distanceUnit } = params;
  const pctSign = changePct >= 0 ? '+' : '';
  if (distanceUnit === 'price') {
    return `${formatPriceDifference(changePrice, decimals, true)} (${pctSign}${changePct}%)`;
  }
  const isPos = changePips >= 0;
  const word = formatDistanceUnitWord(changePips, distanceUnit);
  return `${isPos ? `+${changePips}` : changePips} ${word} (${pctSign}${changePct}%)`;
}
