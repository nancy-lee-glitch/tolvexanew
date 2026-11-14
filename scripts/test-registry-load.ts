import assert from 'node:assert/strict';
import type { Clock, WebSocketLike } from '../src/services/liveFeed.ts';
import {
  configureFeedSingletonForTest,
  destroySharedFeed,
  getFeedDiagnostics,
  getLiveFeed,
  REGISTRY_RETRY_DELAYS_MS,
} from '../src/services/feedSingleton.ts';
import {
  getAssetRegistryInfo,
  resetAssetRegistry,
} from '../src/services/assetRegistry.ts';

class FakeClock implements Clock {
  t = 1_000_000;
  private id = 0;
  private q: { id: number; at: number; fn: () => void }[] = [];

  now() {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number) {
    const id = ++this.id;
    this.q.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(id: unknown) {
    this.q = this.q.filter((x) => x.id !== id);
  }

  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

class FakeWS implements WebSocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(public url: string) {}

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  respond(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const SAMPLE_LIVE_SYMBOLS = [
  {
    exchange_is_open: 0,
    is_trading_suspended: 0,
    market: 'forex',
    pip_size: 0.0001,
    submarket: 'major_pairs',
    underlying_symbol: 'frxEURUSD',
    underlying_symbol_name: 'EUR/USD',
  },
  {
    exchange_is_open: 1,
    is_trading_suspended: 0,
    market: 'cryptocurrency',
    pip_size: 0.01,
    submarket: 'non_stable_coin',
    underlying_symbol: 'cryBTCUSD',
    underlying_symbol_name: 'BTC/USD',
  },
  {
    exchange_is_open: 1,
    is_trading_suspended: 0,
    market: 'synthetic_index',
    pip_size: 0.01,
    submarket: 'random_index',
    underlying_symbol: 'R_100',
    underlying_symbol_name: 'Volatility 100 Index',
  },
];

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function activeSymbolRequests(ws: FakeWS) {
  return ws.sent.filter((m) => m && m.active_symbols === 'brief');
}

async function run() {
  console.log('============================================================');
  console.log('  TICKVERE STAGE 3.2: REGISTRY LOAD ON MARKET_CLOSED TESTS');
  console.log('============================================================');

  // Assert exact retry schedule
  assert.deepEqual([...REGISTRY_RETRY_DELAYS_MS], [1000, 3000, 6000, 12000, 24000]);

  // Test 1: MARKET_CLOSED with an open socket triggers immediate registry load -> 'live'
  {
    destroySharedFeed();
    resetAssetRegistry();
    const clock = new FakeClock();
    const sockets: FakeWS[] = [];

    configureFeedSingletonForTest({
      endpoints: ['wss://primary.test'],
      clock,
      isMarketOpen: () => false,
      wsFactory: (u) => {
        const ws = new FakeWS(u);
        sockets.push(ws);
        return ws;
      },
    });

    const feed = getLiveFeed();
    const ws = sockets[0];
    assert.ok(ws, 'Expected singleton feed to create WebSocket');
    ws.open();
    assert.equal(getAssetRegistryInfo().source, 'bootstrap');

    // Weekend forex closed market status transition
    feed.setActive('frxEURUSD');
    assert.equal(feed.getStatus().status, 'MARKET_CLOSED');
    assert.equal(activeSymbolRequests(ws).length, 1, 'Expected MARKET_CLOSED status to request active_symbols');

    const req = activeSymbolRequests(ws)[0];
    ws.respond({
      msg_type: 'active_symbols',
      req_id: req.req_id,
      active_symbols: SAMPLE_LIVE_SYMBOLS,
    });
    await flushMicrotasks();

    const info = getAssetRegistryInfo();
    const diag = getFeedDiagnostics();
    assert.equal(info.source, 'live', `Expected registry source 'live', got '${info.source}'`);
    assert.equal(diag.status, 'MARKET_CLOSED');
    assert.equal(diag.registry.source, 'live');
    assert.equal(info.total, 3);
    console.log('  ✓ [PASS] Test 1: MARKET_CLOSED with open socket loads registry to live');
  }

  // Test 2: MARKET_CLOSED before socket opens skips while closed, then loads on 1s retry once open
  {
    destroySharedFeed();
    resetAssetRegistry();
    const clock = new FakeClock();
    const sockets: FakeWS[] = [];

    configureFeedSingletonForTest({
      endpoints: ['wss://primary.test'],
      clock,
      isMarketOpen: () => false,
      wsFactory: (u) => {
        const ws = new FakeWS(u);
        sockets.push(ws);
        return ws;
      },
    });

    const feed = getLiveFeed();
    const ws = sockets[0];

    // Market is closed before socket completes handshake
    feed.setActive('frxEURUSD');
    assert.equal(feed.getStatus().status, 'MARKET_CLOSED');
    assert.equal(activeSymbolRequests(ws).length, 0, 'Must skip active_symbols while socket is not open');

    // Socket opens at 500ms
    clock.advance(500);
    ws.open();

    // 1s retry triggers load
    clock.advance(500);
    assert.equal(activeSymbolRequests(ws).length, 1, '1s retry must trigger load once socket is open');

    const req = activeSymbolRequests(ws)[0];
    ws.respond({
      msg_type: 'active_symbols',
      req_id: req.req_id,
      active_symbols: SAMPLE_LIVE_SYMBOLS,
    });
    await flushMicrotasks();

    assert.equal(getAssetRegistryInfo().source, 'live');

    // Subsequent retries (3s, 6s, 12s, 24s) must NOT issue duplicate fetches once live
    clock.advance(25000);
    await flushMicrotasks();
    assert.equal(activeSymbolRequests(ws).length, 1, 'Retries must stop after registry reaches live');
    console.log('  ✓ [PASS] Test 2: Skips while closed, loads on 1s retry after open, stops remaining retries');
  }

  // Test 3: Never runs two fetches at once and retries through 1s/3s/6s/12s/24s
  {
    destroySharedFeed();
    resetAssetRegistry();
    const clock = new FakeClock();
    const sockets: FakeWS[] = [];

    configureFeedSingletonForTest({
      endpoints: ['wss://primary.test'],
      clock,
      isMarketOpen: () => false,
      wsFactory: (u) => {
        const ws = new FakeWS(u);
        sockets.push(ws);
        return ws;
      },
    });

    const feed = getLiveFeed();
    const ws = sockets[0];
    feed.setActive('frxEURUSD');

    // At 1s socket is still closed -> skipped
    clock.advance(1000);
    assert.equal(activeSymbolRequests(ws).length, 0);

    // Open socket at 2s; 3s retry fires request #1
    clock.advance(1000);
    ws.open();
    clock.advance(1000);
    assert.equal(activeSymbolRequests(ws).length, 1, '3s retry must trigger fetch #1');

    // At 6s request #1 is STILL in-flight (no response yet) -> must NOT launch fetch #2 concurrently
    clock.advance(3000);
    assert.equal(activeSymbolRequests(ws).length, 1, 'Must never run two fetches at once');

    // Request #1 fails with transient error; registry stays bootstrap
    const req1 = activeSymbolRequests(ws)[0];
    ws.respond({
      msg_type: 'active_symbols',
      req_id: req1.req_id,
      error: { code: 'RateLimit', message: 'Temporary rate limit' },
    });
    await flushMicrotasks();
    assert.equal(getAssetRegistryInfo().source, 'bootstrap');

    // 12s retry fires request #2 and succeeds
    clock.advance(6000);
    assert.equal(activeSymbolRequests(ws).length, 2, '12s retry must fire fetch #2 after failure');
    const req2 = activeSymbolRequests(ws)[1];
    ws.respond({
      msg_type: 'active_symbols',
      req_id: req2.req_id,
      active_symbols: SAMPLE_LIVE_SYMBOLS,
    });
    await flushMicrotasks();

    assert.equal(getAssetRegistryInfo().source, 'live');

    // 24s timer should do nothing since source is already live
    clock.advance(15000);
    await flushMicrotasks();
    assert.equal(activeSymbolRequests(ws).length, 2);
    console.log('  ✓ [PASS] Test 3: Single-flight lock prevents concurrent fetches and retries through 12s/24s');
  }

  destroySharedFeed();
  configureFeedSingletonForTest(null);
  console.log('------------------------------------------------------------');
  console.log('Registry Load Tests: 3/3 scenarios passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
