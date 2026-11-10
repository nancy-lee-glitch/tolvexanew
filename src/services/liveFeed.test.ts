import assert from 'node:assert/strict';
import { LiveFeed, FeedStatus, WebSocketLike, Clock } from './liveFeed.ts';

class FakeClock implements Clock {
  t = 1_000_000; private id = 0; private q: { id: number; at: number; fn: () => void }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.id; this.q.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.q = this.q.filter((x) => x.id !== id); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.q[0];
      if (!n || n.at > end) break;
      this.q.shift(); this.t = n.at; n.fn();
    }
    this.t = end;
  }
}

class FakeWS implements WebSocketLike {
  readyState = 0; sent: any[] = [];
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(public url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  // test controls
  open() { this.readyState = 1; this.onopen?.(); }
  msg(o: object) { this.onmessage?.({ data: JSON.stringify(o) }); }
  tick(symbol: string, quote: number, id = 'sub-' + symbol) { this.msg({ msg_type: 'tick', tick: { symbol, quote, epoch: 1 }, subscription: { id } }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

function rig(extra: any = {}) {
  const clock = new FakeClock(); const sockets: FakeWS[] = []; const statuses: FeedStatus[] = []; const ticks: any[] = [];
  const feed = new LiveFeed({
    endpoints: ['wss://primary', 'wss://fallback'], clock, random: () => 0.5,
    wsFactory: (u) => { const s = new FakeWS(u); sockets.push(s); return s; },
    onTick: (t) => ticks.push(t), onStatus: (e) => statuses.push(e.status), ...extra,
  });
  return { clock, sockets, statuses, ticks, feed, last: () => sockets[sockets.length - 1] };
}
const run = (name: string, fn: () => void) => { fn(); console.log('PASS', name); };

run('1. normal session: LIVE, never RECONNECTING', () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open();
  for (let i = 0; i < 60; i++) { r.last().tick('R_100', 100 + i); r.clock.advance(1000); }
  assert.deepEqual(r.statuses, ['LIVE']);
  assert.equal(r.sockets.length, 1);
});

run('2. 2-second drop never shows RECONNECTING', () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open(); r.last().tick('R_100', 1);
  r.clock.advance(1000); r.last().drop(); r.clock.advance(1100); // backoff 1s -> new socket
  assert.equal(r.sockets.length, 2); r.last().open(); r.last().tick('R_100', 2); r.clock.advance(2000);
  assert.ok(!r.statuses.includes('RECONNECTING'), r.statuses.join());
  assert.equal(r.statuses[r.statuses.length - 1], 'LIVE');
});

run('3. 30-second outage shows RECONNECTING after the hold, then recovers', () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open(); r.last().tick('R_100', 1);
  r.clock.advance(3000); r.last().drop();
  for (let i = 0; i < 30; i++) { r.clock.advance(1000); const s = r.last(); if (s.readyState === 0) s.drop(); }
  assert.ok(r.statuses.includes('RECONNECTING'));
  while (r.last().readyState !== 0) r.clock.advance(500); // wait for the next connection attempt
  r.last().open(); r.last().tick('R_100', 5); r.clock.advance(1000);
  assert.equal(r.statuses[r.statuses.length - 1], 'LIVE');
});

run('4. quiet but healthy market: DELAYED + ping, NO reconnect', () => {
  const r = rig(); r.feed.setActive('frxEURUSD'); r.last().open(); r.last().tick('frxEURUSD', 1);
  for (let i = 0; i < 40; i++) { r.clock.advance(1000); if (r.last().sent.some((m) => m.ping)) r.last().msg({ msg_type: 'ping', ping: 'pong' }); }
  assert.ok(r.statuses.includes('DELAYED')); assert.equal(r.sockets.length, 1);
  assert.ok(!r.statuses.includes('RECONNECTING'));
});

run('5. zombie socket (silent, no pong) is replaced', () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open(); r.last().tick('R_100', 1);
  r.clock.advance(30000);
  assert.ok(r.sockets.length >= 2, 'expected a reconnect, sockets=' + r.sockets.length);
});

run('6. backoff resets only after a message; endpoint rotates after 3 dead connects', () => {
  const r = rig(); r.feed.setActive('R_100');
  const urls: string[] = [r.sockets[0].url];
  for (let i = 0; i < 4; i++) { const s = r.last(); s.open(); s.drop(); r.clock.advance(20000); urls.push(r.last().url); }
  assert.equal(urls[0], 'wss://primary'); assert.ok(urls.includes('wss://fallback'));
  const gaps: number[] = []; // verify growing delay without messages
  const r2 = rig(); r2.feed.setActive('R_100');
  for (let i = 0; i < 3; i++) { const before = r2.sockets.length; r2.last().open(); r2.last().drop();
    let waited = 0; while (r2.sockets.length === before && waited < 30000) { r2.clock.advance(100); waited += 100; } gaps.push(waited); }
  assert.ok(gaps[0] < gaps[1] && gaps[1] < gaps[2], gaps.join());
});

run('7. symbol switch: one subscription per symbol, old one forgotten, stale ticks ignored', () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open(); r.last().tick('R_100', 1);
  r.feed.unsubscribe('R_100'); r.feed.setActive('R_50'); r.last().tick('R_50', 9);
  const subs = r.last().sent.filter((m) => m.ticks);
  assert.deepEqual(subs.map((m) => m.ticks), ['R_100', 'R_50']);
  assert.ok(r.last().sent.some((m) => m.forget === 'sub-R_100'));
  const before = r.ticks.length; r.last().tick('R_100', 2); assert.equal(r.ticks.length, before);
});

run('8. offline => OFFLINE and no retry storm; online => immediate reconnect', () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open(); r.last().tick('R_100', 1);
  r.feed.handleOffline(); r.last().drop(); const n = r.sockets.length; r.clock.advance(60000);
  assert.equal(r.statuses[r.statuses.length - 1], 'OFFLINE'); assert.equal(r.sockets.length, n);
  r.feed.handleOnline(); assert.equal(r.sockets.length, n + 1);
});

run('9. market closed: MARKET_CLOSED, socket left alone', () => {
  const r = rig({ isMarketOpen: () => false }); r.feed.setActive('frxEURUSD'); r.last().open();
  for (let i = 0; i < 60; i++) { r.clock.advance(1000); if (r.last().sent.some((m) => m.ping)) { r.last().sent.length = 0; r.last().msg({ msg_type: 'ping', ping: 'pong' }); } }
  assert.equal(r.statuses[r.statuses.length - 1], 'MARKET_CLOSED'); assert.equal(r.sockets.length, 1);
});

(async () => {
  const r = rig(); r.feed.setActive('R_100'); r.last().open();
  const p = r.feed.getCandles('R_100', 3600, 3);
  const req = r.last().sent.find((m) => m.ticks_history);
  r.last().msg({ msg_type: 'candles', req_id: req.req_id, candles: [{ epoch: 1, open: '1', high: '2', low: '0.5', close: '1.5' }] });
  const c = await p; assert.equal(c[0].high, 2); assert.equal(req.granularity, 3600);
  const p2 = r.feed.getCandles('R_100', 60); r.clock.advance(11000);
  await assert.rejects(p2, /timed out/);
  console.log('PASS 10. candles request resolves; times out when silent');
  console.log('\nALL FEED TESTS PASSED');
})();
