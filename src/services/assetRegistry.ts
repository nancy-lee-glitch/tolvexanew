/**
 * assetRegistry.ts — Dynamic asset registry straight from Deriv's active_symbols.
 *
 * Requirements:
 * - On startup call feed.getActiveSymbols(), map market → category
 *   (Forex, Stocks, Indices, Commodities, Crypto, Synthetics).
 * - Support both live Deriv shape (underlying_symbol, underlying_symbol_name, pip_size)
 *   and legacy shape (symbol, display_name, pip) with fallback.
 * - Use item.market only (never underlying_symbol_type) to determine category.
 * - Track registrySource ('live' | 'bootstrap') and reason + category counts.
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

export interface AssetRegistryInfo {
  source: 'live' | 'bootstrap';
  reason: string;
  total: number;
  categoryCounts: Record<AssetCategory, number>;
}

const ALL_CATEGORIES: AssetCategory[] = ['Forex', 'Stocks', 'Indices', 'Commodities', 'Crypto', 'Synthetics'];

function emptyCategoryCounts(): Record<AssetCategory, number> {
  return {
    Forex: 0,
    Stocks: 0,
    Indices: 0,
    Commodities: 0,
    Crypto: 0,
    Synthetics: 0,
  };
}

function computeCategoryCounts(assets: DynamicAsset[]): Record<AssetCategory, number> {
  const counts = emptyCategoryCounts();
  for (const a of assets) {
    if (ALL_CATEGORIES.includes(a.categoryName)) {
      counts[a.categoryName] += 1;
    }
  }
  return counts;
}

// In-memory session cache
let sessionAssetRegistry: DynamicAsset[] = [];
const symbolOpenMap = new Map<string, boolean>();
const listeners = new Set<(assets: DynamicAsset[]) => void>();
let isFetching = false;
let hasInitialized = false;
let registrySource: 'live' | 'bootstrap' = 'bootstrap';
let registryReason = 'not yet fetched';

function isTruthyFlag(val: unknown): boolean {
  return val === 1 || val === true || val === '1';
}

/**
 * Map Deriv market code to human category tab (normalizes case & singular/plural).
 * Uses `item.market` ONLY (never underlying_symbol_type).
 */
export function mapDerivMarketToCategory(market: string): AssetCategory {
  switch ((market || '').trim().toLowerCase()) {
    case 'forex':
      return 'Forex';
    case 'indices':
    case 'index':
      return 'Indices';
    case 'commodities':
    case 'commodity':
      return 'Commodities';
    case 'stocks':
    case 'stock':
      return 'Stocks';
    case 'cryptocurrency':
    case 'crypto':
      return 'Crypto';
    case 'synthetic_index':
    case 'synthetic':
    case 'synthetics':
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
 * Authoritative registry state takes priority when available; falls back to 24/7 or FX weekend hours.
 */
export function isSymbolMarketOpen(symbol: string): boolean {
  if (!symbol) return false;
  if (symbolOpenMap.has(symbol)) {
    return symbolOpenMap.get(symbol) === true;
  }

  // Always open 24/7/365 fallback before live registry loads
  if (symbol.startsWith('R_') || symbol.startsWith('1HZ') || symbol.startsWith('cry')) {
    return true;
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

    const isOpen =
      def.derivSymbol.startsWith('R_') || def.derivSymbol.startsWith('1HZ') || def.derivSymbol.startsWith('cry')
        ? true
        : !isWeekendForexClosed(def.derivSymbol);
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

function notifyListeners(assets: DynamicAsset[]) {
  for (const listener of listeners) {
    try {
      listener(assets);
    } catch (err) {
      console.warn('[AssetRegistry] Listener error', err);
    }
  }
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
 * Returns registry source ('live' | 'bootstrap'), reason, and per-category counts.
 */
export function getAssetRegistryInfo(): AssetRegistryInfo {
  const assets = getRegisteredAssets();
  return {
    source: registrySource,
    reason: registryReason,
    total: assets.length,
    categoryCounts: computeCategoryCounts(assets),
  };
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
 * Resets in-memory registry state (for unit tests)
 */
export function resetAssetRegistry(): void {
  sessionAssetRegistry = [];
  symbolOpenMap.clear();
  isFetching = false;
  hasInitialized = false;
  registrySource = 'bootstrap';
  registryReason = 'reset';
}

/**
 * Ingest raw active_symbols list from Deriv feed and populate session cache.
 * Supports both live Deriv shape (`underlying_symbol`, `underlying_symbol_name`, `pip_size`)
 * and legacy shape (`symbol`, `display_name`, `pip`).
 */
export function ingestActiveSymbols(rawSymbols: any[]): DynamicAsset[] {
  if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) {
    const bootstrap = getRegisteredAssets();
    registrySource = 'bootstrap';
    registryReason = 'active_symbols returned empty response';
    notifyListeners(bootstrap);
    return bootstrap;
  }

  const knownBySymbol = new Map(SYMBOL_REGISTRY.map((s) => [s.derivSymbol, s]));
  const seenSymbols = new Set<string>();
  const list: DynamicAsset[] = [];

  for (const item of rawSymbols) {
    if (!item || typeof item !== 'object') continue;
    const rawSym = item.underlying_symbol ?? item.symbol;
    const symbol = typeof rawSym === 'string' ? rawSym.trim() : '';
    if (!symbol || seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);

    const known = knownBySymbol.get(symbol);
    // IMPORTANT: Use item.market ONLY (never underlying_symbol_type)
    const categoryName = mapDerivMarketToCategory(item.market);
    const exchangeOpen = isTruthyFlag(item.exchange_is_open);
    const isSuspended = isTruthyFlag(item.is_trading_suspended);
    const isOpen = exchangeOpen && !isSuspended;

    symbolOpenMap.set(symbol, isOpen);

    const rawPip = item.pip ?? item.pip_size ?? item.pip_value;
    const parsedPip = Number(rawPip);
    const pipSize = Number.isFinite(parsedPip) && parsedPip > 0 ? parsedPip : (known?.pipSize ?? 0.0001);
    const decimals = Number.isFinite(parsedPip) && parsedPip > 0
      ? deriveDecimalsFromPip(parsedPip)
      : (known?.decimals ?? deriveDecimalsFromPip(pipSize));

    const displayName = String(
      item.underlying_symbol_name ?? item.display_name ?? item.name ?? known?.uiLabel ?? symbol
    );

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
      exchange_is_open: isOpen,
      is_trading_suspended: isSuspended,
      market: String(item.market || 'synthetic_index'),
      submarket: String(item.submarket || ''),
    });
  }

  if (list.length === 0) {
    const bootstrap = getRegisteredAssets();
    registrySource = 'bootstrap';
    registryReason = 'active_symbols yielded 0 usable symbols';
    notifyListeners(bootstrap);
    return bootstrap;
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
  registrySource = 'live';
  registryReason = `loaded ${list.length} active symbols from Deriv`;

  notifyListeners(list);
  return list;
}

/**
 * Initializes registry from LiveFeed on startup. Safe to call multiple times.
 */
export async function initializeAssetRegistry(feed: { getActiveSymbols: (timeoutMs?: number) => Promise<any[]> }): Promise<DynamicAsset[]> {
  if (hasInitialized && registrySource === 'live' && sessionAssetRegistry.length > 0) {
    return sessionAssetRegistry;
  }
  if (isFetching) {
    return getRegisteredAssets();
  }
  isFetching = true;
  try {
    const raw = await feed.getActiveSymbols(8000);
    return ingestActiveSymbols(raw);
  } catch (err: any) {
    registrySource = 'bootstrap';
    registryReason = err?.message || 'getActiveSymbols request failed';
    console.warn('[AssetRegistry] getActiveSymbols fallback to bootstrap registry:', registryReason);
    const bootstrap = getRegisteredAssets();
    notifyListeners(bootstrap);
    return bootstrap;
  } finally {
    isFetching = false;
  }
}
