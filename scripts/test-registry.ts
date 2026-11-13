import assert from 'node:assert/strict';
import {
  ingestActiveSymbols,
  getAssetRegistryInfo,
  isSymbolMarketOpen,
  resetAssetRegistry,
} from '../src/services/assetRegistry.ts';

const run = (name: string, fn: () => void) => {
  fn();
  console.log('PASS', name);
};

run('1. Live Deriv underlying_symbol shape & market-only categorization', () => {
  resetAssetRegistry();

  const liveShapePayload = [
    // Exact shape verified from Deriv endpoint (note underlying_symbol_type="stockindex" must be ignored!)
    {
      exchange_is_open: 1,
      is_trading_suspended: 0,
      market: 'synthetic_index',
      pip_size: 0.01,
      subgroup: 'synthetics',
      submarket: 'random_index',
      trade_count: 4946570,
      underlying_symbol: '1HZ100V',
      underlying_symbol_name: 'Volatility 100 (1s) Index',
      underlying_symbol_type: 'stockindex',
    },
    {
      exchange_is_open: true,
      is_trading_suspended: false,
      market: 'Forex',
      pip_size: 0.0001,
      underlying_symbol: 'frxEURUSD',
      underlying_symbol_name: 'EUR/USD',
      underlying_symbol_type: 'forex',
    },
    {
      exchange_is_open: '1',
      is_trading_suspended: 0,
      market: 'CRYPTO',
      pip_size: 1,
      underlying_symbol: 'cryBTCUSD',
      underlying_symbol_name: 'BTC/USD',
    },
    {
      exchange_is_open: 0,
      is_trading_suspended: 0,
      market: 'stock',
      pip_size: 0.01,
      underlying_symbol: 'AAPL',
      underlying_symbol_name: 'Apple Inc.',
    },
    {
      exchange_is_open: 1,
      is_trading_suspended: 1, // suspended overrides exchange_is_open=1
      market: 'index',
      pip_size: 0.1,
      underlying_symbol: 'OTC_SPX',
      underlying_symbol_name: 'US 500',
    },
    {
      exchange_is_open: true,
      is_trading_suspended: '1', // string "1" suspended
      market: 'commodity',
      pip_size: 0.01,
      underlying_symbol: 'frxXAUUSD',
      underlying_symbol_name: 'Gold/USD',
    },
  ];

  const assets = ingestActiveSymbols(liveShapePayload);
  const info = getAssetRegistryInfo();

  assert.equal(info.source, 'live');
  assert.equal(info.total, 6);
  assert.deepEqual(info.categoryCounts, {
    Forex: 1,
    Stocks: 1,
    Indices: 1,
    Commodities: 1,
    Crypto: 1,
    Synthetics: 1,
  });

  const v100 = assets.find((a) => a.symbol === '1HZ100V');
  assert.ok(v100);
  assert.equal(v100.categoryName, 'Synthetics');
  assert.equal(v100.name, 'Volatility 100 (1s) Index');
  assert.equal(v100.pipSize, 0.01);
  assert.equal(v100.exchange_is_open, true);
  assert.equal(isSymbolMarketOpen('1HZ100V'), true);

  const eurusd = assets.find((a) => a.symbol === 'frxEURUSD');
  assert.ok(eurusd);
  assert.equal(eurusd.exchange_is_open, true);
  assert.equal(isSymbolMarketOpen('frxEURUSD'), true);

  const btc = assets.find((a) => a.symbol === 'cryBTCUSD');
  assert.ok(btc);
  assert.equal(btc.categoryName, 'Crypto');
  assert.equal(isSymbolMarketOpen('cryBTCUSD'), true);

  const aapl = assets.find((a) => a.symbol === 'AAPL');
  assert.ok(aapl);
  assert.equal(aapl.categoryName, 'Stocks');
  assert.equal(aapl.exchange_is_open, false);
  assert.equal(isSymbolMarketOpen('AAPL'), false);

  const spx = assets.find((a) => a.symbol === 'OTC_SPX');
  assert.ok(spx);
  assert.equal(spx.is_trading_suspended, true);
  assert.equal(spx.exchange_is_open, false);
  assert.equal(isSymbolMarketOpen('OTC_SPX'), false);

  const gold = assets.find((a) => a.symbol === 'frxXAUUSD');
  assert.ok(gold);
  assert.equal(gold.categoryName, 'Commodities');
  assert.equal(gold.is_trading_suspended, true);
  assert.equal(gold.exchange_is_open, false);
  assert.equal(isSymbolMarketOpen('frxXAUUSD'), false);
});

run('2. Legacy symbol/display_name/pip shape fallback & market aliases', () => {
  resetAssetRegistry();

  const legacyShapePayload = [
    {
      symbol: 'frxGBPUSD',
      display_name: 'GBP/USD',
      market: 'forex',
      pip: 0.0001,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      symbol: 'R_100',
      name: 'Volatility 100 Index',
      market: 'synthetic',
      pip_value: 0.01,
      exchange_is_open: true,
      is_trading_suspended: false,
    },
    {
      symbol: 'cryETHUSD',
      display_name: 'ETH/USD',
      market: 'cryptocurrency',
      pip: 0.1,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      symbol: 'NVDA',
      display_name: 'NVIDIA Corp',
      market: 'stocks',
      pip: 0.01,
      exchange_is_open: 0,
      is_trading_suspended: 0,
    },
    {
      symbol: 'DJI',
      display_name: 'Wall Street 30',
      market: 'indices',
      pip: 1,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      symbol: 'XAGUSD',
      display_name: 'Silver/USD',
      market: 'commodities',
      pip: 0.001,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
  ];

  const assets = ingestActiveSymbols(legacyShapePayload);
  const info = getAssetRegistryInfo();

  assert.equal(info.source, 'live');
  assert.equal(info.total, 6);
  assert.deepEqual(info.categoryCounts, {
    Forex: 1,
    Stocks: 1,
    Indices: 1,
    Commodities: 1,
    Crypto: 1,
    Synthetics: 1,
  });

  assert.equal(isSymbolMarketOpen('frxGBPUSD'), true);
  assert.equal(isSymbolMarketOpen('R_100'), true);
  assert.equal(isSymbolMarketOpen('NVDA'), false);
  assert.equal(assets.find((a) => a.symbol === 'R_100')?.pipSize, 0.01);
  assert.equal(assets.find((a) => a.symbol === 'R_100')?.name, 'Volatility 100 Index');
});

run('3. Empty or unusable symbols keep bootstrap list and record registrySource = bootstrap', () => {
  resetAssetRegistry();

  const fallbackEmpty = ingestActiveSymbols([]);
  assert.ok(fallbackEmpty.length >= 17);
  let info = getAssetRegistryInfo();
  assert.equal(info.source, 'bootstrap');
  assert.ok(info.reason.length > 0);

  resetAssetRegistry();
  const fallbackInvalid = ingestActiveSymbols([{ market: 'forex' }, null, {}]);
  assert.ok(fallbackInvalid.length >= 17);
  info = getAssetRegistryInfo();
  assert.equal(info.source, 'bootstrap');
  assert.ok(info.reason.includes('0 usable'));
});

console.log('ALL REGISTRY TESTS PASSED');
