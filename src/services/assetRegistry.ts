/**
 * assetRegistry.ts — Dynamic asset registry straight from Deriv's active_symbols.
 *
 * Requirements:
 * - On startup call feed.getActiveSymbols(), map market → category
 *   (Forex, Stocks, Indices, Commodities, Crypto, Synthetics).
 * - Use exchange_is_open to drive isMarketOpen.
 * - Cache the list in memory for the session.
 * - Keep symbolMap.ts only for friendly names, decimals, pip sizes, and FX weekend fallback
 *   (Fri 21:00 UTC to Sun 21:00 UTC).
 * - If a symbol is not in the registry, derive decimals from the tick quote string.
 * - Remove all `basePrice` usage as a displayed price.
 */

import type { AssetConfig } from '../types.ts';
import { SYMBOL_REGISTRY, isWeekendForexClosed } from './symbolMap.ts';

export type AssetCategory = 'Forex' | 'Stocks' | 'Indices' | 'Commodities' | 'Crypto' | 'Synthetics';

export interface DynamicAsset extends AssetConfig {
  market: string;
  submarket: string;
  categoryName: AssetCategory;
  exchange_is_open: boolean;
  is_trading_suspended: boolean;
  pipSize: number;
  decimals: number;
  is_otc?: boolean;
}

// In-memory session cache
let sessionAssetRegistry: DynamicAsset[] = [];
const symbolOpenMap = new Map<string, boolean>();
const listeners = new Set<(assets: DynamicAsset[]) => void>();
let isFetching = false;
let hasInitialized = false;

/**
 * Map Deriv market code to human category tab
 */
export function mapDerivMarketToCategory(market: string): AssetCategory {
  switch ((market || '').toLowerCase()) {
    case 'forex':
      return 'Forex';
    case 'indices':
      return 'Indices';
    case 'commodities':
      return 'Commodities';
    case 'stocks':
      return 'Stocks';
    case 'cryptocurrency':
      return 'Crypto';
    case 'synthetic_index':
    default:
      return 'Synthetics';
  }
}

/**
 * Derives number of decimal places from a pip size (e.g. 0.0001 -> 4, 0.00001 -> 5, 0.01 -> 2)
 */
export function deriveDecimalsFromPip(pip: number): number {
  if (!pip || !Number.isFinite(pip)) return 2;
  const str = pip.toString();
  if (str.includes('e-')) {
    const parts = str.split('e-');
    return parseInt(parts[1], 10) || 2;
  }
  const dot = str.indexOf('.');
  return dot === -1 ? 0 : str.length - dot - 1;
}

/**
 * Derives decimals from quote string or number when no metadata exists
 */
export function deriveDecimalsFromQuote(quote: number | string): number {
  if (quote === null || quote === undefined) return 2;
  const s = String(quote);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : Math.min(s.length - dot - 1, 8);
}

/**
 * Checks if a symbol's exchange is currently open.
 * Uses Deriv's exchange_is_open flag when loaded, with conservative FX weekend fallback.
 */
export function isSymbolMarketOpen(symbol: string): boolean {
  if (!symbol) return false;
  // Always open 24/7/365
  if (symbol.startsWith('R_') || symbol.startsWith('1HZ') || symbol.startsWith('cry')) {
    return true;
  }

  if (symbolOpenMap.has(symbol)) {
    return symbolOpenMap.get(symbol) === true;
  }

  // Fallback for forex and metals: closed Fri 21:00 UTC to Sun 21:00 UTC
  return !isWeekendForexClosed(symbol);
}

/**
 * Builds initial bootstrap assets from the curated symbolMap
 * (guarantees instant zero-delay render before WebSocket brief resolves)
 */
function buildBootstrapAssets(): DynamicAsset[] {
  return SYMBOL_REGISTRY.map((def) => {
    let cat: AssetCategory = 'Synthetics';
    if (def.category === 'FOREX') cat = 'Forex';
    else if (def.category === 'COMMODITY') cat = 'Commodities';
    else if (def.category === 'CRYPTO') cat = 'Crypto';

    const isOpen = isSymbolMarketOpen(def.derivSymbol);
    symbolOpenMap.set(def.derivSymbol, isOpen);

    return {
      symbol: def.derivSymbol,
      name: def.uiLabel,
      type: def.category,
      categoryName: cat,
      decimals: def.decimals,
      pipSize: def.pipSize,
      exchange_is_open: isOpen,
      is_trading_suspended: false,
      market: def.category.toLowerCase(),
      submarket: 'standard',
    };
  });
}

/**
 * Returns current cached assets synchronously (starts with bootstrap list)
 */
export function getRegisteredAssets(): DynamicAsset[] {
  if (sessionAssetRegistry.length === 0) {
    sessionAssetRegistry = buildBootstrapAssets();
  }
  return sessionAssetRegistry;
}

/**
 * Subscribes to registry updates when active_symbols resolves
 */
export function subscribeAssetRegistry(callback: (assets: DynamicAsset[]) => void): () => void {
  listeners.add(callback);
  callback(getRegisteredAssets());
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Ingest raw active_symbols list from Deriv feed and populate session cache
 */
export function ingestActiveSymbols(rawSymbols: any[]): DynamicAsset[] {
  if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) {
    return getRegisteredAssets();
  }

  const knownBySymbol = new Map(SYMBOL_REGISTRY.map((s) => [s.derivSymbol, s]));
  const seenSymbols = new Set<string>();
  const list: DynamicAsset[] = [];

  for (const item of rawSymbols) {
    const symbol: string = item.symbol;
    if (!symbol || seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);

    const known = knownBySymbol.get(symbol);
    const categoryName = mapDerivMarketToCategory(item.market);
    const isOpen = Boolean(item.exchange_is_open === 1);
    const isSuspended = Boolean(item.is_trading_suspended === 1);

    symbolOpenMap.set(symbol, isOpen && !isSuspended);

    const pipSize = Number(item.pip) || known?.pipSize || 0.0001;
    const decimals = known?.decimals ?? deriveDecimalsFromPip(pipSize);
    const displayName = known?.uiLabel || item.display_name || symbol;

    let type: AssetConfig['type'] = 'SYNTH';
    if (categoryName === 'Forex') type = 'FOREX';
    else if (categoryName === 'Commodities') type = 'COMMODITY';
    else if (categoryName === 'Crypto') type = 'CRYPTO';
    else if (categoryName === 'Stocks') type = 'STOCK';
    else if (categoryName === 'Indices') type = 'INDEX';

    list.push({
      symbol,
      name: displayName,
      type,
      categoryName,
      decimals,
      pipSize,
      exchange_is_open: isOpen && !isSuspended,
      is_trading_suspended: isSuspended,
      market: item.market || 'synthetic_index',
      submarket: item.submarket || '',
    });
  }

  // Ensure our curated core assets appear first in order
  const priorityOrder = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD', 'cryBTCUSD', 'cryETHUSD', 'R_100', 'R_75', 'R_50', 'R_25', 'R_10', '1HZ100V'];
  list.sort((a, b) => {
    const idxA = priorityOrder.indexOf(a.symbol);
    const idxB = priorityOrder.indexOf(b.symbol);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  sessionAssetRegistry = list;
  hasInitialized = true;

  for (const listener of listeners) {
    try {
      listener(list);
    } catch (err) {
      console.warn('[AssetRegistry] Listener error', err);
    }
  }

  return list;
}

/**
 * Initializes registry from LiveFeed on startup. Safe to call multiple times.
 */
export async function initializeAssetRegistry(feed: { getActiveSymbols: (timeoutMs?: number) => Promise<any[]> }): Promise<DynamicAsset[]> {
  if (hasInitialized && sessionAssetRegistry.length > 0) {
    return sessionAssetRegistry;
  }
  if (isFetching) {
    return getRegisteredAssets();
  }
  isFetching = true;
  try {
    const raw = await feed.getActiveSymbols(8000);
    return ingestActiveSymbols(raw);
  } catch (err) {
    console.warn('[AssetRegistry] getActiveSymbols fallback to bootstrap registry:', err);
    return getRegisteredAssets();
  } finally {
    isFetching = false;
  }
}
