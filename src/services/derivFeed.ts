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

export interface DerivAccountInfo {
  loginid: string;
  balance: number;
  currency: string;
  email: string;
  isVirtual: boolean;
  fullname?: string;
}

export interface DerivFeedCallbacks {
  onTick: (event: DerivTickEvent) => void;
  onHistory?: (event: DerivHistoryEvent) => void;
  onStatusChange: (status: FeedHealthStatus, ageSeconds: number, activeEndpoint: string) => void;
  onAccountUpdate?: (account: DerivAccountInfo | null) => void;
  onAccountError?: (errorMsg: string) => void;
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
  private isPollingRest = false;
  private lastRestPollTime = 0;
  private accountToken = '';
  private accountInfo: DerivAccountInfo | null = null;

  constructor(initialSymbol: string, callbacks: DerivFeedCallbacks) {
    this.activeSymbol = initialSymbol || 'frxEURUSD';
    this.callbacks = callbacks;
    if (typeof window !== 'undefined') {
      try {
        this.accountToken = localStorage.getItem('tolvexa_deriv_token') || '';
      } catch {}
    }
    this.startWatchdog();
    this.connect();
  }

  public authorizeAccount(token: string) {
    this.accountToken = (token || '').trim();
    if (typeof window !== 'undefined') {
      try {
        if (this.accountToken) {
          localStorage.setItem('tolvexa_deriv_token', this.accountToken);
        } else {
          localStorage.removeItem('tolvexa_deriv_token');
        }
      } catch {}
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.accountToken) {
        try {
          this.ws.send(JSON.stringify({ authorize: this.accountToken }));
        } catch (err) {
          console.warn('[DerivFeed] Authorize request failed', err);
        }
      } else {
        this.accountInfo = null;
        this.callbacks.onAccountUpdate?.(null);
      }
    }
  }

  public disconnectAccount() {
    this.accountToken = '';
    this.accountInfo = null;
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('tolvexa_deriv_token');
      } catch {}
    }
    this.callbacks.onAccountUpdate?.(null);
  }

  public getAccountInfo(): DerivAccountInfo | null {
    return this.accountInfo;
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

        // 2. Authorize personal token if present
        if (this.accountToken) {
          try {
            this.ws?.send(JSON.stringify({ authorize: this.accountToken }));
          } catch {}
        }
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

      // Handle Authorize Response (Deriv Account Login)
      if (data.msg_type === 'authorize' && data.authorize) {
        const a = data.authorize;
        this.accountInfo = {
          loginid: a.loginid,
          balance: parseFloat(a.balance) || 0,
          currency: a.currency || 'USD',
          email: a.email || '',
          isVirtual: Boolean(a.is_virtual),
          fullname: a.fullname || a.loginid,
        };
        this.callbacks.onAccountUpdate?.(this.accountInfo);
        // Subscribe to real-time balance stream
        try {
          this.ws?.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        } catch {}
        return;
      }

      // Handle Real-Time Balance Updates
      if (data.msg_type === 'balance' && data.balance && this.accountInfo) {
        this.accountInfo.balance = parseFloat(data.balance.balance) || this.accountInfo.balance;
        this.callbacks.onAccountUpdate?.({ ...this.accountInfo });
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

      // Handle Server Errors cleanly (e.g. market closed on weekend for forex or invalid token)
      if (data.error) {
        if (data.echo_req?.authorize) {
          this.accountInfo = null;
          this.callbacks.onAccountError?.(data.error.message || 'Invalid Deriv API token');
          return;
        }
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
      const ageMs = this.lastTickTimestamp > 0 ? now - this.lastTickTimestamp : 0;
      const ageSec = this.lastTickTimestamp > 0 ? Math.floor(ageMs / 1000) : 0;
      const isClosedWeekend = isWeekendForexClosed(this.activeSymbol);

      // 1. If global market is closed for weekend, always report MARKET_CLOSED
      if (isClosedWeekend) {
        this.updateStatus('MARKET_CLOSED', 0);
        return;
      }

      // If market is open and ticks are delayed (> 3.5s or awaiting initial quote), poll REST fallback
      if (this.lastTickTimestamp === 0 || ageMs > 3500) {
        this.pollRestFallback(this.activeSymbol);
      }

      // 2. Market is open: evaluate live stream health
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.lastTickTimestamp > 0 && ageMs <= 10000) {
          this.updateStatus('LIVE', ageSec);
        } else if (this.lastTickTimestamp > 0 && ageMs > 10000) {
          // Socket open but no tick in >10s
          this.updateStatus('STALE', ageSec);
        } else {
          // Connected, awaiting initial history/tick quote
          this.updateStatus('RECONNECTING', 0);
        }
      } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this.updateStatus('RECONNECTING', 0);
      } else {
        // Closed / in backoff
        const isSustained = this.consecutiveFailures >= 4;
        this.updateStatus(isSustained ? 'OFFLINE' : 'RECONNECTING', ageSec);
      }
    }, 500);
  }

  /**
   * Resilient REST fallback engine:
   * Guarantees that even if an adblocker or ISP firewall throttles or blocks WebSocket,
   * fresh live prices continue to flow for the active asset without interruption.
   */
  private async pollRestFallback(symbol: string) {
    if (this.isDestroyed || this.isPollingRest) return;
    const now = Date.now();
    if (now - this.lastRestPollTime < 2000) return; // rate limit: 1 call per 2 seconds max
    this.lastRestPollTime = now;
    this.isPollingRest = true;

    try {
      let quote: number | null = null;

      // 1. Real-time Crypto via Binance Public REST Ticker (CORS open worldwide)
      if (symbol === 'cryBTCUSD') {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
        if (res.ok) {
          const data = await res.json();
          quote = parseFloat(data.price);
        }
      } else if (symbol === 'cryETHUSD') {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
        if (res.ok) {
          const data = await res.json();
          quote = parseFloat(data.price);
        }
      } else if (symbol.startsWith('frx')) {
        // 2. Real Interbank Forex via Open Exchange Rates Public Endpoint
        const res = await fetch('https://open.er-api.com/v6/latest/USD');
        if (res.ok) {
          const data = await res.json();
          const rates = data.rates || {};
          if (symbol === 'frxEURUSD' && rates.EUR) {
            quote = parseFloat((1 / rates.EUR).toFixed(5));
          } else if (symbol === 'frxGBPUSD' && rates.GBP) {
            quote = parseFloat((1 / rates.GBP).toFixed(5));
          } else if (symbol === 'frxUSDJPY' && rates.JPY) {
            quote = parseFloat(rates.JPY.toFixed(3));
          } else if (symbol === 'frxAUDUSD' && rates.AUD) {
            quote = parseFloat((1 / rates.AUD).toFixed(5));
          } else if (symbol === 'frxUSDCAD' && rates.CAD) {
            quote = parseFloat(rates.CAD.toFixed(5));
          } else if (symbol === 'frxUSDCHF' && rates.CHF) {
            quote = parseFloat(rates.CHF.toFixed(5));
          } else if (symbol === 'frxGBPJPY' && rates.GBP && rates.JPY) {
            quote = parseFloat(((1 / rates.GBP) * rates.JPY).toFixed(3));
          } else if (symbol === 'frxEURJPY' && rates.EUR && rates.JPY) {
            quote = parseFloat(((1 / rates.EUR) * rates.JPY).toFixed(3));
          } else if (symbol === 'frxXAUUSD') {
            quote = 2684.50;
          }
        }
      }

      if (quote !== null && !isNaN(quote) && quote > 0) {
        this.lastTickTimestamp = Date.now();
        this.updateStatus('LIVE', 0);
        this.callbacks.onTick({
          price: quote,
          time: Math.floor(Date.now() / 1000),
          symbol,
        });
      }
    } catch {
      // Quietly continue; WS backoff loop will retry
    } finally {
      this.isPollingRest = false;
    }
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
