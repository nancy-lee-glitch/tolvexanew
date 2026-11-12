/**
 * feedSingleton.ts — Application-wide singleton for LiveFeed.
 *
 * Rules:
 * - ONE socket, ONE subscription per symbol.
 * - Primary endpoint: wss://api.derivws.com/trading/v1/options/ws/public (configurable via VITE_DERIV_WS_PRIMARY)
 * - Fallback endpoint: wss://ws.derivws.com/websockets/v3?app_id=${VITE_DERIV_APP_ID} (configurable via VITE_DERIV_WS_FALLBACK)
 * - React StrictMode safe: cleanup does not kill the shared socket if listeners remain.
 * - attachBrowserEvents() wired once.
 */

import { LiveFeed, attachBrowserEvents, type Tick, type StatusEvent, type FeedStatus } from './liveFeed.ts';
import { isSymbolMarketOpen, initializeAssetRegistry } from './assetRegistry.ts';

const ENV_PRIMARY = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DERIV_WS_PRIMARY : undefined;
const ENV_FALLBACK = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DERIV_WS_FALLBACK : undefined;
const APP_ID = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DERIV_APP_ID) || '1089';

export const PRIMARY_ENDPOINT = ENV_PRIMARY || 'wss://api.derivws.com/trading/v1/options/ws/public';
export const FALLBACK_ENDPOINT = ENV_FALLBACK || `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

let sharedFeed: LiveFeed | null = null;
let detachEvents: (() => void) | null = null;

const tickListeners = new Set<(tick: Tick) => void>();
const statusListeners = new Set<(event: StatusEvent) => void>();
let latestStatus: StatusEvent = {
  status: 'CONNECTING',
  tickAgeMs: null,
  endpoint: PRIMARY_ENDPOINT,
  reason: 'initial',
};

/**
 * Returns or creates the module-level singleton LiveFeed instance.
 */
export function getLiveFeed(): LiveFeed {
  if (!sharedFeed) {
    sharedFeed = new LiveFeed({
      endpoints: [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT],
      isMarketOpen: (symbol: string) => isSymbolMarketOpen(symbol),
      onTick: (tick: Tick) => {
        for (const listener of tickListeners) {
          try {
            listener(tick);
          } catch (err) {
            console.warn('[feedSingleton] Tick listener error', err);
          }
        }
      },
      onStatus: (event: StatusEvent) => {
        latestStatus = event;
        for (const listener of statusListeners) {
          try {
            listener(event);
          } catch (err) {
            console.warn('[feedSingleton] Status listener error', err);
          }
        }
      },
    });

    detachEvents = attachBrowserEvents(sharedFeed);

    // Bootstrap dynamic active symbols once feed initializes
    initializeAssetRegistry(sharedFeed).catch((err) => {
      console.warn('[feedSingleton] Dynamic asset discovery notice:', err);
    });
  }

  return sharedFeed;
}

/**
 * Subscribe a component or service to incoming live ticks across all subscribed symbols.
 */
export function subscribeTicks(listener: (tick: Tick) => void): () => void {
  getLiveFeed(); // ensure started
  tickListeners.add(listener);
  return () => {
    tickListeners.delete(listener);
  };
}

/**
 * Subscribe to feed health status events.
 */
export function subscribeStatus(listener: (event: StatusEvent) => void): () => void {
  getLiveFeed();
  statusListeners.add(listener);
  // Immediately dispatch current status snapshot
  listener(latestStatus);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * Returns current snapshot of feed status.
 */
export function getCurrentFeedStatus(): StatusEvent {
  return latestStatus;
}

/**
 * Teardown helper for full unmount or tests.
 */
export function destroySharedFeed(): void {
  if (detachEvents) {
    detachEvents();
    detachEvents = null;
  }
  if (sharedFeed) {
    sharedFeed.destroy();
    sharedFeed = null;
  }
  tickListeners.clear();
  statusListeners.clear();
}
