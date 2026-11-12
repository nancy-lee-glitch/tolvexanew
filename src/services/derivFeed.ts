/**
 * derivFeed.ts — Thin compatibility adapter around the singleton LiveFeed.
 *
 * Requirements:
 * - Use LiveFeed AS-IS as the only WebSocket market data client.
 * - Zero fake prices, zero Math.random, zero hardcoded gold prices, zero sine-wave seeding.
 * - Map FeedStatus to existing UI status types ('LIVE' | 'CONNECTING' | 'DELAYED' | 'RECONNECTING' | 'OFFLINE' | 'MARKET_CLOSED').
 * - Store optional user account token in sessionStorage (never localStorage) and clear on logout.
 */

import {
  getLiveFeed,
  subscribeTicks,
  subscribeStatus,
  PRIMARY_ENDPOINT,
  FALLBACK_ENDPOINT,
} from './feedSingleton.ts';
import type { Tick, StatusEvent, FeedStatus } from './liveFeed.ts';
import { getOrFetchCandles } from './candleStore.ts';

export type FeedHealthStatus = FeedStatus | 'STALE';

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

const ENV_APP_ID = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DERIV_APP_ID : '';
export const ACTIVE_APP_ID = (ENV_APP_ID || '1089').trim();
export const IS_CUSTOM_APP_ID_CONFIGURED = Boolean(ENV_APP_ID);
export const DERIV_ENDPOINTS = [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT];

const SESSION_TOKEN_KEY = 'tickvere_deriv_token';

/**
 * Thin adapter around LiveFeed.
 */
export class DerivFeedService {
  private activeSymbol = 'frxEURUSD';
  private callbacks: DerivFeedCallbacks;
  private unsubscribeTick: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private isDestroyed = false;
  private accountInfo: DerivAccountInfo | null = null;
  private accountToken = '';

  constructor(initialSymbol: string, callbacks: DerivFeedCallbacks) {
    this.activeSymbol = initialSymbol || 'frxEURUSD';
    this.callbacks = callbacks;

    // Optional Deriv account token: strictly sessionStorage, never localStorage
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        this.accountToken = sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
      } catch (err) {
        console.warn('[DerivFeed] sessionStorage access notice:', err);
      }
    }

    const feed = getLiveFeed();
    feed.setActive(this.activeSymbol);

    // Initial historical candles request to hydrate buffers
    this.hydrateHistory(this.activeSymbol);

    // Subscribe to shared feed ticks
    this.unsubscribeTick = subscribeTicks((tick: Tick) => {
      if (this.isDestroyed) return;
      if (tick.symbol === this.activeSymbol) {
        this.callbacks.onTick({
          price: tick.price,
          time: tick.epoch,
          symbol: tick.symbol,
        });
      }
    });

    // Subscribe to shared feed status
    this.unsubscribeStatus = subscribeStatus((event: StatusEvent) => {
      if (this.isDestroyed) return;
      const ageSec = event.tickAgeMs !== null ? Math.round(event.tickAgeMs / 1000) : 0;
      this.callbacks.onStatusChange(event.status, ageSec, event.endpoint);
    });
  }

  private async hydrateHistory(symbol: string) {
    try {
      const candles = await getOrFetchCandles(symbol, 60, 120);
      if (this.isDestroyed || !candles || candles.length === 0) return;
      const prices = candles.map((c) => c.close);
      const times = candles.map((c) => c.time);
      this.callbacks.onHistory?.({
        prices,
        times,
        symbol,
      });
    } catch (err) {
      console.warn(`[DerivFeed] History hydration notice for ${symbol}:`, err);
    }
  }

  public setSymbol(newSymbol: string) {
    if (!newSymbol || this.activeSymbol === newSymbol || this.isDestroyed) return;
    const oldSymbol = this.activeSymbol;
    this.activeSymbol = newSymbol;

    const feed = getLiveFeed();
    feed.unsubscribe(oldSymbol);
    feed.setActive(newSymbol);

    this.hydrateHistory(newSymbol);
  }

  public manualRetry() {
    getLiveFeed().manualRetry();
  }

  /**
   * Optional Deriv account token authorization.
   * Enforces security rule 10: stored strictly in sessionStorage, never localStorage.
   */
  public authorizeAccount(token: string) {
    this.accountToken = (token || '').trim();
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        if (this.accountToken) {
          sessionStorage.setItem(SESSION_TOKEN_KEY, this.accountToken);
        } else {
          sessionStorage.removeItem(SESSION_TOKEN_KEY);
        }
      } catch (err) {
        console.warn('[DerivFeed] sessionStorage error:', err);
      }
    }
    // LiveFeed uses Deriv public socket; token is kept client-side for optional account balance telemetry
  }

  public disconnectAccount() {
    this.accountToken = '';
    this.accountInfo = null;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
      } catch {}
    }
    this.callbacks.onAccountUpdate?.(null);
  }

  public getAccountInfo(): DerivAccountInfo | null {
    return this.accountInfo;
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.unsubscribeTick) {
      this.unsubscribeTick();
      this.unsubscribeTick = null;
    }
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus();
      this.unsubscribeStatus = null;
    }
  }
}
