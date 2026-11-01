/**
 * Deriv Public WebSocket Feed Client
 * Official, free ticks, zero user login required.
 *
 * Primary Endpoint: wss://ws.derivws.com/websockets/v3?app_id=${app_id}
 * Fallback 1:       wss://api.derivws.com/trading/v1/options/ws/public?app_id=${app_id}
 * Fallback 2:       wss://ws.binaryws.com/websockets/v3?app_id=${app_id}&l=EN&brand=deriv
 */

import { isWeekendForexClosed } from './symbolMap.ts';

export type FeedHealthStatus = 'LIVE' | 'RECONNECTING' | 'STALE' | 'OFFLINE' | 'MARKET_CLOSED';

export interface DerivTickEvent {
  price: number;
  time: number;
  symbol: string;
}

export interface DerivHistoryEvent {
  prices: number[];
  times: number[];
  symbol: string;
}

export interface DerivFeedCallbacks {
  onTick: (event: DerivTickEvent) => void;
  onHistory?: (event: DerivHistoryEvent) => void;
  onStatusChange: (status: FeedHealthStatus, ageSeconds: number, activeEndpoint: string) => void;
}

// Production App ID from env with fallback to Deriv official public test ID (1089)
const ENV_APP_ID = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DERIV_APP_ID)
  ? String(import.meta.env.VITE_DERIV_APP_ID).trim()
  : '';

export const ACTIVE_APP_ID = ENV_APP_ID || '1089';
export const IS_CUSTOM_APP_ID_CONFIGURED = Boolean(ENV_APP_ID);

export const DERIV_ENDPOINTS = [
  `wss://ws.derivws.com/websockets/v3?app_id=${ACTIVE_APP_ID}&l=EN`,
  `wss://api.derivws.com/trading/v1/options/ws/public?app_id=${ACTIVE_APP_ID}`,
  `wss://ws.binaryws.com/websockets/v3?app_id=${ACTIVE_APP_ID}&l=EN&brand=deriv`,
];

export class DerivFeedService {
  private ws: WebSocket | null = null;
  private currentEndpointIndex = 0;
  private activeSymbol = 'frxEURUSD';
  private callbacks: DerivFeedCallbacks;
  private status: FeedHealthStatus = 'RECONNECTING';

  private lastTickTimestamp = 0;
  private consecutiveFailures = 0;
  private backoffMs = 1000;
  private isDestroyed = false;

  private pingInterval: any = null;
  private watchdogInterval: any = null;
  private reconnectTimer: any = null;
  private lastPingSentTime = 0;

  constructor(initialSymbol: string, callbacks: DerivFeedCallbacks) {
    this.activeSymbol = initialSymbol || 'frxEURUSD';
    this.callbacks = callbacks;
    this.startWatchdog();
    this.connect();
  }

  public setSymbol(newSymbol: string) {
    if (this.activeSymbol === newSymbol) return;
    this.activeSymbol = newSymbol;
    this.lastTickTimestamp = 0; // reset for new asset

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Forget previous tick subscriptions cleanly
        this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
        this.requestHistoryAndSubscribe(this.activeSymbol);
      } catch (err) {
        console.warn('[DerivFeed] Symbol switch send notice', err);
      }
    }
  }

  public manualRetry() {
    this.consecutiveFailures = 0;
    this.backoffMs = 1000;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connect();
  }

  public destroy() {
    this.isDestroyed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private getActiveEndpoint(): string {
    return DERIV_ENDPOINTS[this.currentEndpointIndex % DERIV_ENDPOINTS.length];
  }

  private connect() {
    if (this.isDestroyed) return;

    this.clearSocket();
    const endpoint = this.getActiveEndpoint();
    this.updateStatus('RECONNECTING');

    try {
      const ws = new WebSocket(endpoint);
      this.ws = ws;

      ws.onopen = () => {
        if (this.isDestroyed || this.ws !== ws) return;
        this.consecutiveFailures = 0;
        this.backoffMs = 1000;
        this.startHeartbeat();

        // 1. Prefill with ~500 ticks history & subscribe
        this.requestHistoryAndSubscribe(this.activeSymbol);
      };

      ws.onmessage = (event) => {
        if (this.isDestroyed || this.ws !== ws) return;
        this.handleMessage(event.data);
      };

      ws.onerror = (e) => {
        if (this.isDestroyed || this.ws !== ws) return;
        this.consecutiveFailures += 1;
        console.warn(`[DerivFeed] Error on ${endpoint}:`, e);
      };

      ws.onclose = () => {
        if (this.isDestroyed || this.ws !== ws) return;
        this.handleClose();
      };
    } catch (err) {
      console.warn('[DerivFeed] Socket constructor error', err);
      this.handleClose();
    }
  }

  private requestHistoryAndSubscribe(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      // Send ticks_history with subscribe=1 (Deriv official API pattern)
      this.ws.send(
        JSON.stringify({
          ticks_history: symbol,
          adjust_start_time: 1,
          count: 500,
          end: 'latest',
          start: 1,
          style: 'ticks',
          subscribe: 1,
        })
      );

      // Backup standalone tick subscription
      this.ws.send(
        JSON.stringify({
          ticks: symbol,
          subscribe: 1,
        })
      );
    } catch (err) {
      console.warn('[DerivFeed] Subscription send failure', err);
    }
  }

  private handleMessage(raw: string) {
    try {
      const data = JSON.parse(raw);

      // Handle Ping Heartbeat
      if (data.msg_type === 'ping') {
        return;
      }

      // Handle Historical Ticks Prefill
      if (data.msg_type === 'history' && data.history && Array.isArray(data.history.prices)) {
        const prices = data.history.prices.map((p: any) => parseFloat(p)).filter((p: number) => !isNaN(p));
        const times = (data.history.times || []).map((t: any) => parseInt(t, 10));
        const sym = data.echo_req?.ticks_history || this.activeSymbol;

        if (prices.length > 0) {
          this.lastTickTimestamp = Date.now();
          this.updateStatus('LIVE');

          if (this.callbacks.onHistory) {
            this.callbacks.onHistory({ prices, times, symbol: sym });
          }

          // Emit latest price as tick to initialize quote
          const latestPrice = prices[prices.length - 1];
          const latestTime = times.length > 0 ? times[times.length - 1] : Math.floor(Date.now() / 1000);
          this.callbacks.onTick({ price: latestPrice, time: latestTime, symbol: sym });
        }
        return;
      }

      // Handle Streaming Tick
      if ((data.msg_type === 'tick' || data.tick) && data.tick) {
        const t = data.tick;
        const sym = t.symbol || this.activeSymbol;

        if (sym === this.activeSymbol) {
          const quote = parseFloat(t.quote);
          const epoch = parseInt(t.epoch, 10) || Math.floor(Date.now() / 1000);

          if (!isNaN(quote)) {
            this.lastTickTimestamp = Date.now();
            this.updateStatus('LIVE');
            this.callbacks.onTick({ price: quote, time: epoch, symbol: sym });
          }
        }
        return;
      }

      // Handle Server Errors cleanly (e.g. market closed on weekend for forex)
      if (data.error) {
        const errorMsg = String(data.error.message || '').toLowerCase();
        const errorCode = String(data.error.code || '').toLowerCase();
        if (errorCode.includes('marketclosed') || errorMsg.includes('closed') || errorMsg.includes('trading is not allowed')) {
          this.updateStatus('MARKET_CLOSED');
          return;
        }
        console.info(`[DerivFeed Notice for ${this.activeSymbol}]:`, data.error.message);
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  private handleClose() {
    this.consecutiveFailures += 1;

    // Rotate to fallback endpoint after 2 failures on current endpoint
    if (this.consecutiveFailures >= 2) {
      this.currentEndpointIndex = (this.currentEndpointIndex + 1) % DERIV_ENDPOINTS.length;
    }

    const isSustainedFailure = this.consecutiveFailures >= 4;
    this.updateStatus(isSustainedFailure ? 'OFFLINE' : 'RECONNECTING');

    const delay = this.backoffMs;
    this.backoffMs = Math.min(16000, this.backoffMs * 1.5);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.lastPingSentTime = Date.now();
          this.ws.send(JSON.stringify({ ping: 1 }));
        } catch {}
      }
    }, 20000); // 20-second heartbeat prevents proxy timeouts
  }

  /**
   * Staleness Watchdog (User requirement #7):
   * LIVE if last tick age <= 10 seconds (not 2s — 2s caused false OFFLINE).
   * MARKET_CLOSED if traditional forex is inactive on weekend.
   * RECONNECTING while socket is connecting.
   * OFFLINE only after sustained failure.
   */
  private startWatchdog() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);

    this.watchdogInterval = setInterval(() => {
      if (this.isDestroyed) return;

      const now = Date.now();
      const ageMs = this.lastTickTimestamp > 0 ? now - this.lastTickTimestamp : 999999;
      const ageSec = Math.floor(ageMs / 1000);
      const isClosedWeekend = isWeekendForexClosed(this.activeSymbol);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.lastTickTimestamp > 0 && ageMs <= 10000) {
          this.updateStatus('LIVE', ageSec);
        } else if (isClosedWeekend) {
          // Connected but asset is closed for the weekend
          this.updateStatus('MARKET_CLOSED', ageSec);
        } else if (this.lastTickTimestamp > 0 && ageMs > 10000) {
          // Socket open but no tick in >10s
          this.updateStatus('STALE', ageSec);
        } else {
          // Connected, awaiting initial history/tick
          this.updateStatus('RECONNECTING', ageSec);
        }
      } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this.updateStatus(isClosedWeekend ? 'MARKET_CLOSED' : 'RECONNECTING', ageSec);
      } else {
        // Closed / in backoff
        const isSustained = this.consecutiveFailures >= 4;
        this.updateStatus(isSustained ? 'OFFLINE' : 'RECONNECTING', ageSec);
      }
    }, 500);
  }

  private updateStatus(newStatus: FeedHealthStatus, ageSec?: number) {
    this.status = newStatus;
    const computedAgeSec = ageSec !== undefined
      ? ageSec
      : this.lastTickTimestamp > 0
      ? Math.floor((Date.now() - this.lastTickTimestamp) / 1000)
      : 0;

    this.callbacks.onStatusChange(newStatus, computedAgeSec, this.getActiveEndpoint());
  }

  private clearSocket() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private clearTimers() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }
}
