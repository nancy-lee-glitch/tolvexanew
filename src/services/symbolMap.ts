import type { AssetConfig } from '../types.ts';

export interface DerivSymbolDefinition {
  derivSymbol: string;
  uiLabel: string;
  name: string;
  category: 'FOREX' | 'COMMODITY' | 'CRYPTO' | 'SYNTH';
  decimals: number;
  pipSize: number;
  basePrice: number;
  description: string;
  is24x7: boolean;
}

/**
 * Exhaustive extensible symbol registry mapping human UI labels to native Deriv symbols.
 * Supports Forex majors, Spot Metals, Crypto, and 24/7 Volatility Indices.
 */
export const SYMBOL_REGISTRY: DerivSymbolDefinition[] = [
  // Forex Majors (Native Deriv WebSocket Feed: frxPREFIX)
  { derivSymbol: 'frxEURUSD', uiLabel: 'EUR/USD', name: 'EUR/USD', category: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.08542, description: 'Euro / US Dollar', is24x7: false },
  { derivSymbol: 'frxGBPUSD', uiLabel: 'GBP/USD', name: 'GBP/USD', category: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.29420, description: 'British Pound / US Dollar', is24x7: false },
  { derivSymbol: 'frxUSDJPY', uiLabel: 'USD/JPY', name: 'USD/JPY', category: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 154.250, description: 'US Dollar / Japanese Yen', is24x7: false },
  { derivSymbol: 'frxAUDUSD', uiLabel: 'AUD/USD', name: 'AUD/USD', category: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 0.65410, description: 'Australian Dollar / US Dollar', is24x7: false },
  { derivSymbol: 'frxUSDCAD', uiLabel: 'USD/CAD', name: 'USD/CAD', category: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.38240, description: 'US Dollar / Canadian Dollar', is24x7: false },
  { derivSymbol: 'frxUSDCHF', uiLabel: 'USD/CHF', name: 'USD/CHF', category: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 0.86520, description: 'US Dollar / Swiss Franc', is24x7: false },
  { derivSymbol: 'frxGBPJPY', uiLabel: 'GBP/JPY', name: 'GBP/JPY', category: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 198.650, description: 'British Pound / Japanese Yen', is24x7: false },
  { derivSymbol: 'frxEURJPY', uiLabel: 'EUR/JPY', name: 'EUR/JPY', category: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 167.420, description: 'Euro / Japanese Yen', is24x7: false },

  // Commodities & Spot Metals
  { derivSymbol: 'frxXAUUSD', uiLabel: 'GOLD (XAU)', name: 'GOLD (XAU/USD)', category: 'COMMODITY', decimals: 2, pipSize: 0.01, basePrice: 2684.50, description: 'Gold / US Dollar', is24x7: false },

  // Crypto Coins (24/7 Continuous Feed)
  { derivSymbol: 'cryBTCUSD', uiLabel: 'BTC/USD', name: 'BTC/USD', category: 'CRYPTO', decimals: 2, pipSize: 1.0, basePrice: 88450.00, description: 'Bitcoin / US Dollar', is24x7: true },
  { derivSymbol: 'cryETHUSD', uiLabel: 'ETH/USD', name: 'ETH/USD', category: 'CRYPTO', decimals: 2, pipSize: 0.1, basePrice: 3240.50, description: 'Ethereum / US Dollar', is24x7: true },

  // Deriv Volatility Synthetics (24/7 Guaranteed Continuous Real-Time Ticks)
  { derivSymbol: 'R_100', uiLabel: 'VOL 100', name: 'Volatility 100', category: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 2415.80, description: 'Volatility 100 Index (24/7)', is24x7: true },
  { derivSymbol: 'R_75', uiLabel: 'VOL 75', name: 'Volatility 75', category: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 48920.40, description: 'Volatility 75 Index (24/7)', is24x7: true },
  { derivSymbol: 'R_50', uiLabel: 'VOL 50', name: 'Volatility 50', category: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 341.20, description: 'Volatility 50 Index (24/7)', is24x7: true },
  { derivSymbol: 'R_25', uiLabel: 'VOL 25', name: 'Volatility 25', category: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 1820.60, description: 'Volatility 25 Index (24/7)', is24x7: true },
  { derivSymbol: 'R_10', uiLabel: 'VOL 10', name: 'Volatility 10', category: 'SYNTH', decimals: 3, pipSize: 0.001, basePrice: 6542.10, description: 'Volatility 10 Index (24/7)', is24x7: true },
  { derivSymbol: '1HZ100V', uiLabel: 'VOL 100 (1s)', name: 'Volatility 100 (1s)', category: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 840.10, description: 'Volatility 100 (1s) Index (24/7)', is24x7: true },
];

/**
 * Default AssetConfig array for UI selection tabs and dropdowns
 */
export const ASSETS: AssetConfig[] = SYMBOL_REGISTRY.map((item) => ({
  symbol: item.derivSymbol,
  name: item.uiLabel,
  type: item.category,
  decimals: item.decimals,
  pipSize: item.pipSize,
  basePrice: item.basePrice,
}));

/**
 * Maps any UI label or symbol name to Deriv official symbol format
 */
export function getDerivSymbolForLabel(label: string): string {
  if (!label) return 'frxEURUSD';
  const clean = label.trim().toUpperCase();
  const match = SYMBOL_REGISTRY.find(
    (s) =>
      s.uiLabel.toUpperCase() === clean ||
      s.name.toUpperCase() === clean ||
      s.derivSymbol.toUpperCase() === clean ||
      s.derivSymbol.replace(/^frx|^cry/, '').toUpperCase() === clean
  );
  return match ? match.derivSymbol : label;
}

/**
 * Returns full AssetConfig by Deriv symbol or label
 */
export function getAssetConfigBySymbol(symbolOrLabel: string): AssetConfig | undefined {
  if (!symbolOrLabel) return undefined;
  const target = getDerivSymbolForLabel(symbolOrLabel);
  return ASSETS.find((a) => a.symbol === target || a.name === symbolOrLabel);
}

/**
 * Checks if the global interbank Forex market is closed for the weekend.
 * Forex & Spot Gold close Friday 21:00 UTC (5 PM EST) and reopen Sunday 21:00 UTC (5 PM EST).
 * Crypto (BTC/USD, ETH/USD) and Deriv Volatility Synthetics (R_10 to R_100) are OPEN 24/7/365.
 */
export function isWeekendForexClosed(symbolOrLabel: string): boolean {
  if (!symbolOrLabel) return false;
  const derivSym = getDerivSymbolForLabel(symbolOrLabel);
  // Synthetics and Crypto are open 24/7/365 without exception
  if (derivSym.startsWith('R_') || derivSym.startsWith('1HZ') || derivSym.startsWith('cry')) {
    return false;
  }
  const now = new Date();
  const day = now.getUTCDay(); // 0 is Sunday, 6 is Saturday
  const hour = now.getUTCHours();
  if (day === 6) return true; // All Saturday
  if (day === 5 && hour >= 21) return true; // Friday evening
  if (day === 0 && hour < 21) return true; // Sunday before 21:00 UTC
  return false;
}

/**
 * Intelligently defaults to an active 24/7 market on weekends so the user
 * immediately experiences live streaming ticks without waiting for closed markets.
 */
export function getDefaultActiveAsset(): AssetConfig {
  const isWeekend = isWeekendForexClosed('frxEURUSD');
  if (isWeekend) {
    const active24x7 = ASSETS.find((a) => a.symbol === 'R_100' || a.symbol === 'cryBTCUSD');
    if (active24x7) return active24x7;
  }
  return ASSETS[0];
}
