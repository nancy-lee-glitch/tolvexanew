/**
 * liveFeed.ts — reference implementation of a stable Deriv public-WebSocket client.
 *
 * Design goals
 *  - ONE socket, ONE subscription per symbol, no duplicate ticks.
 *  - The UI only sees RECONNECTING when the link has really been down for a while.
 *  - A quiet market is NOT a broken connection: we ping first, reconnect only if the ping is not answered.
 *  - Backoff resets only after a real message arrives (not on "open").
 *  - No fabricated prices, ever. If there is no data, we say so.
 *
 * Framework-free (no React, no deps). Clock and WebSocket are injectable so it can be unit-tested.
 */

export type FeedStatus = 'CONNECTING' | 'LIVE' | 'DELAYED' | 'RECONNECTING' | 'OFFLINE' | 'MARKET_CLOSED';

export interface Tick { symbol: string; price: number; epoch: number }
export interface Candle { time: number; open: number; high: number; low: number; close: number }
export interface StatusEvent { status: FeedStatus; tickAgeMs: number | null; endpoint: string; reason: string }

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface FeedOptions {
  /** Ordered list: first is primary. Verify against https://developers.deriv.com before shipping. */
  endpoints: string[];
  onTick: (t: Tick) => void;
  onStatus: (e: StatusEvent) => void;
  onError?: (symbol: string | null, code: string, message: string) => void;
  /** Return false when you KNOW the market is closed (e.g. weekend FX, or active_symbols exchange_is_open=0). */
  isMarketOpen?: (symbol: string) => boolean;
  /** Per-symbol "no tick for this long = DELAYED". */
  staleAfterMs?: (symbol: string) => number;
  wsFactory?: (url: string) => WebSocketLike;
  clock?: Clock;
  random?: () => number;
  /** Down for less than this => keep showing the previous status (no flicker). Default 4000. */
  reconnectHoldMs?: number;
  /** Minimum time in LIVE before we allow a downgrade. Default 2000. */
  minLiveDwellMs?: number;
  /** Ping must be answered within this. Default 5000. */
  pingTimeoutMs?: number;
}

const OPEN = 1;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 15000];

export function defaultStaleAfterMs(symbol: string): number {
  if (symbol.startsWith('1HZ')) return 5000;
  if (symbol.startsWith('cry')) return 5000;
  if (symbol.startsWith('R_') || /^(BOOM|CRASH|JD|stpRNG|RDBEAR|RDBULL)/.test(symbol)) return 8000;
  return 15000; // forex, metals, indices, stocks: ticks can be sparse
}

interface Sub { wanted: boolean; id?: string }
interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: unknown }

export class LiveFeed {
  private o: Required<Pick<FeedOptions, 'reconnectHoldMs' | 'minLiveDwellMs' | 'pingTimeoutMs'>> & FeedOptions;
  private clock: Clock;
  private rnd: () => number;
  private ws: WebSocketLike | null = null;
  private endpointIdx = 0;
  private destroyed = false;
  private online = true;

  private status: FeedStatus = 'CONNECTING';
  private statusSince = 0;
  private everLive = false;

  private subs = new Map<string, Sub>();
  private active = '';
  private lastTickAt = new Map<string, number>();
  private serverClosed = new Set<string>();

  private failures = 0;            // consecutive connects that never delivered a message
  private gotMessageThisSocket = false;
  private downSince = 0;
  private openedAt = 0;
  private lastMessageAt = 0;
  private pingSince: number | null = null;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;

  private reqId = 0;
  private pending = new Map<number, Pending>();

  constructor(options: FeedOptions) {
    this.o = { reconnectHoldMs: 4000, minLiveDwellMs: 2000, pingTimeoutMs: 5000, ...options };
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as any),
    };
    this.rnd = options.random ?? Math.random;
    this.statusSince = this.clock.now();
    this.downSince = this.clock.now();
    this.scheduleWatchdog();
    this.connect();
  }

  // ---------- public API ----------

  /** Make `symbol` the one the status badge describes, and make sure it is subscribed. */
  setActive(symbol: string) {
    if (this.destroyed || !symbol) return;
    this.active = symbol;
    this.subscribe(symbol);
    this.evaluate('active-changed');
  }

  /** Subscribe to extra symbols (watchlist). One subscription per symbol, never duplicated. */
  subscribe(symbol: string) {
    const s = this.subs.get(symbol);
    if (s?.wanted) return;
    this.subs.set(symbol, { wanted: true });
    this.sendSubscribe(symbol); // if the socket is not open yet, onopen subscribes everything wanted
  }

  unsubscribe(symbol: string) {
    const s = this.subs.get(symbol);
    if (!s) return;
    s.wanted = false;
    if (s.id) { this.send({ forget: s.id }); this.subs.delete(symbol); }
    // if id not known yet, we forget on the first tick (see handleTick)
  }

  /** One-shot candle history. granularity in seconds: 60,120,180,300,600,900,1800,3600,7200,14400,28800,86400. */
  getCandles(symbol: string, granularity: number, count = 500, timeoutMs = 10000): Promise<Candle[]> {
    return this.request({ ticks_history: symbol, style: 'candles', granularity, count, end: 'latest', adjust_start_time: 1 }, timeoutMs)
      .then((r) => (r.candles || []).map((c: any) => ({
        time: Number(c.epoch), open: +c.open, high: +c.high, low: +c.low, close: +c.close,
      })));
  }

  /** Asset list straight from the broker (use it instead of hardcoding symbols). */
  getActiveSymbols(timeoutMs = 10000): Promise<any[]> {
    return this.request({ active_symbols: 'brief' }, timeoutMs).then((r) => r.active_symbols || []);
  }

  getStatus(): StatusEvent { return this.snapshot('snapshot'); }

  /** Call from visibilitychange (visible), online, offline. attachBrowserEvents() wires them for you. */
  handleVisible() {
    if (this.destroyed) return;
    if (this.isOpen()) this.ensurePing();
    else this.connectNow();
  }
  handleOnline() { this.online = true; if (!this.isOpen()) this.connectNow(); this.evaluate('online'); }
  handleOffline() { this.online = false; this.evaluate('offline'); }

  manualRetry() { this.failures = 0; this.connectNow(); }

  destroy() {
    this.destroyed = true;
    this.clock.clearTimeout(this.reconnectTimer);
    this.clock.clearTimeout(this.watchdogTimer);
    this.detach();
    this.rejectAll('feed destroyed');
  }

  // ---------- connection ----------

  private endpoint() { return this.o.endpoints[this.endpointIdx % this.o.endpoints.length]; }
  private isOpen() { return !!this.ws && this.ws.readyState === OPEN; }

  private connectNow() {
    this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.detach();
    this.connect();
  }

  private connect() {
    if (this.destroyed || !this.online) return;
    const url = this.endpoint();
    let ws: WebSocketLike;
    try {
      ws = (this.o.wsFactory ?? ((u: string) => new (globalThis as any).WebSocket(u)))(url);
    } catch {
      this.onSocketGone();
      return;
    }
    this.ws = ws;
    this.gotMessageThisSocket = false;
    for (const s of this.subs.values()) s.id = undefined; // old subscription ids die with the old socket
    ws.onopen = () => {
      if (this.ws !== ws || this.destroyed) return;
      this.openedAt = this.clock.now();
      this.lastMessageAt = this.openedAt; // fresh socket: no instant keep-alive ping
      // NOTE: we do NOT reset backoff here. Only a real message proves the link works.
      for (const [symbol, s] of this.subs) if (s.wanted) this.sendSubscribe(symbol);
    };
    ws.onmessage = (ev) => { if (this.ws === ws && !this.destroyed) this.onMessage(ev.data); };
    ws.onerror = () => { /* never count here; onclose always follows */ };
    ws.onclose = () => { if (this.ws === ws && !this.destroyed) this.onSocketGone(); };
  }

  private detach() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
  }

  /** Socket closed or failed. Count the failure ONCE, schedule ONE reconnect. */
  private onSocketGone() {
    if (this.destroyed) return;
    this.ws = null;
    this.pingSince = null;
    this.downSince = this.clock.now();
    this.rejectAll('socket closed');
    if (!this.gotMessageThisSocket) this.failures += 1; else this.failures = 0;
    if (this.failures >= 3 && this.failures % 3 === 0) this.endpointIdx += 1; // rotate after 3 dead connects
    const base = BACKOFF_STEPS[Math.min(Math.max(this.failures - 1, 0), BACKOFF_STEPS.length - 1)];
    const jitter = 1 + (this.rnd() * 0.4 - 0.2);
    this.clock.clearTimeout(this.reconnectTimer);
    if (this.online) this.reconnectTimer = this.clock.setTimeout(() => this.connect(), Math.round(base * jitter));
    this.evaluate('socket-closed');
  }

  // ---------- messages ----------

  private onMessage(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const now = this.clock.now();
    this.lastMessageAt = now;
    this.pingSince = null;
    if (!this.gotMessageThisSocket) { this.gotMessageThisSocket = true; this.failures = 0; } // backoff resets HERE

    if (m.req_id && this.pending.has(m.req_id)) {
      const p = this.pending.get(m.req_id)!;
      this.pending.delete(m.req_id);
      this.clock.clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${m.error.code}: ${m.error.message}`)); else p.resolve(m);
      this.evaluate('response');
      return;
    }
    if (m.msg_type === 'tick' && m.tick) { this.handleTick(m); return; }
    if (m.error) {
      const sym = m.echo_req?.ticks ?? m.echo_req?.ticks_history ?? null;
      const code = String(m.error.code || '');
      if (sym && /market.?is.?closed|MarketIsClosed/i.test(code + ' ' + m.error.message)) this.serverClosed.add(sym);
      this.o.onError?.(sym, code, String(m.error.message || ''));
      this.evaluate('error');
    }
    // pong / anything else: liveness only
  }

  private handleTick(m: any) {
    const t = m.tick;
    const symbol: string = t.symbol ?? t.underlying_symbol;
    const sub = this.subs.get(symbol);
    const subId: string | undefined = m.subscription?.id;
    if (sub && subId && !sub.id) sub.id = subId;
    if (!sub || !sub.wanted) {
      if (subId) { this.send({ forget: subId }); this.subs.delete(symbol); } // late tick for a dropped symbol
      return;
    }
    const price = Number(t.quote ?? t.price);
    if (!Number.isFinite(price)) return;
    const now = this.clock.now();
    this.lastTickAt.set(symbol, now);
    this.serverClosed.delete(symbol);
    this.o.onTick({ symbol, price, epoch: Number(t.epoch) || Math.floor(now / 1000) });
    this.evaluate('tick');
  }

  private sendSubscribe(symbol: string) {
    if (this.isOpen()) this.send({ ticks: symbol, subscribe: 1 });
  }

  private send(obj: object) {
    if (!this.isOpen()) return;
    try { this.ws!.send(JSON.stringify(obj)); } catch { /* socket will close and be handled */ }
  }

  private request(payload: object, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) { reject(new Error('feed not connected')); return; }
      const id = ++this.reqId;
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('request timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...payload, req_id: id });
    });
  }

  private rejectAll(why: string) {
    for (const [, p] of this.pending) { this.clock.clearTimeout(p.timer); p.reject(new Error(why)); }
    this.pending.clear();
  }

  // ---------- health ----------

  private ensurePing() {
    if (this.pingSince !== null || !this.isOpen()) return;
    this.pingSince = this.clock.now();
    this.send({ ping: 1 });
  }

  private scheduleWatchdog() {
    this.watchdogTimer = this.clock.setTimeout(() => {
      if (this.destroyed) return;
      this.tickWatchdog();
      this.scheduleWatchdog();
    }, 1000);
  }

  private tickWatchdog() {
    const now = this.clock.now();
    if (this.isOpen()) {
      if (this.pingSince !== null && now - this.pingSince > this.o.pingTimeoutMs) {
        // zombie socket: open but silent and not answering pings
        this.detach();
        this.gotMessageThisSocket = false;
        this.onSocketGone();
        return;
      }
      if (this.pingSince === null && now - this.lastMessageAt > 25000) this.ensurePing(); // keep-alive
    }
    this.evaluate('watchdog');
  }

  private marketClosed(symbol: string) {
    return this.serverClosed.has(symbol) || (this.o.isMarketOpen ? !this.o.isMarketOpen(symbol) : false);
  }

  private evaluate(reason: string) {
    if (this.destroyed) return;
    const now = this.clock.now();
    const stale = (this.o.staleAfterMs ?? defaultStaleAfterMs)(this.active || '');

    if (!this.online) return this.setStatus('OFFLINE', reason);
    if (this.active && this.marketClosed(this.active)) return this.setStatus('MARKET_CLOSED', reason);

    if (this.isOpen()) {
      const last = this.lastTickAt.get(this.active) ?? 0;
      if (last && now - last <= stale) return this.setStatus('LIVE', reason);
      if (!last && !this.everLive && now - this.openedAt < stale) return this.setStatus('CONNECTING', reason);
      // socket healthy but quiet: check it with a ping instead of reconnecting
      this.ensurePing();
      return this.setStatus('DELAYED', reason);
    }

    const downFor = now - this.downSince;
    if (downFor < this.o.reconnectHoldMs && this.everLive) return; // short blip: keep what the user sees
    if (downFor < this.o.reconnectHoldMs && this.status === 'CONNECTING') return;
    if (this.failures >= 6 && downFor > 60000) return this.setStatus('OFFLINE', reason);
    return this.setStatus('RECONNECTING', reason);
  }

  private setStatus(next: FeedStatus, reason: string) {
    if (next === this.status) return;
    const now = this.clock.now();
    const leavingLive = this.status === 'LIVE' && (next === 'DELAYED' || next === 'RECONNECTING');
    if (leavingLive && now - this.statusSince < this.o.minLiveDwellMs) return; // anti-flicker
    this.status = next;
    this.statusSince = now;
    if (next === 'LIVE') this.everLive = true;
    this.o.onStatus(this.snapshot(reason));
  }

  private snapshot(reason: string): StatusEvent {
    const last = this.lastTickAt.get(this.active);
    return { status: this.status, tickAgeMs: last ? this.clock.now() - last : null, endpoint: this.endpoint(), reason };
  }
}

/** Wire browser events once. Returns an unsubscribe function. */
export function attachBrowserEvents(feed: LiveFeed): () => void {
  const g: any = globalThis;
  if (!g.document || !g.window) return () => {};
  const vis = () => { if (g.document.visibilityState === 'visible') feed.handleVisible(); };
  const on = () => feed.handleOnline();
  const off = () => feed.handleOffline();
  g.document.addEventListener('visibilitychange', vis);
  g.window.addEventListener('online', on);
  g.window.addEventListener('offline', off);
  g.window.addEventListener('pagehide', () => feed.destroy());
  return () => {
    g.document.removeEventListener('visibilitychange', vis);
    g.window.removeEventListener('online', on);
    g.window.removeEventListener('offline', off);
  };
}
