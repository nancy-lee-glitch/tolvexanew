/**
 * feedSingleton.ts — Application-wide singleton for LiveFeed.
 *
 * Rules:
 * - ONE socket, ONE subscription per symbol.
 * - Primary endpoint: wss://api.derivws.com/trading/v1/options/ws/public (configurable via VITE_DERIV_WS_PRIMARY)
 * - Fallback endpoint: wss://ws.derivws.com/websockets/v3?app_id=${VITE_DERIV_APP_ID} (configurable via VITE_DERIV_WS_FALLBACK)
 * - React StrictMode safe: cleanup does not kill the shared socket if listeners remain.
 * - attachBrowserEvents() wired once.
 * - Tracks non-sensitive feed diagnostics for ?debug=1 view.
 */

import {
  LiveFeed,
  attachBrowserEvents,
  type Tick,
  type StatusEvent,
  type FeedStatus,
  type FeedOptions,
} from './liveFeed.ts';
import {
  isSymbolMarketOpen,
  initializeAssetRegistry,
  getAssetRegistryInfo,
  type AssetRegistryInfo,
} from './assetRegistry.ts';

const ENV_PRIMARY = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DERIV_WS_PRIMARY : undefined;
const ENV_FALLBACK = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DERIV_WS_FALLBACK : undefined;
const APP_ID = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DERIV_APP_ID) || '1089';

export const PRIMARY_ENDPOINT = ENV_PRIMARY || 'wss://api.derivws.com/trading/v1/options/ws/public';
export const FALLBACK_ENDPOINT = ENV_FALLBACK || `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
export const REGISTRY_RETRY_DELAYS_MS = [1000, 3000, 6000, 12000, 24000] as const;

export interface FeedDiagnosticsSnapshot {
  endpoint: string;
  status: FeedStatus;
  reason: string;
  lastTickAtMs: number | null;
  tickAgeSec: number | null;
  reconnectCount: number;
  lastError: string | null;
  registry: AssetRegistryInfo;
}

export interface FeedSingletonOverrides {
  endpoints?: string[];
  wsFactory?: FeedOptions['wsFactory'];
  clock?: FeedOptions['clock'];
  isMarketOpen?: FeedOptions['isMarketOpen'];
  random?: FeedOptions['random'];
}

let sharedFeed: LiveFeed | null = null;
let detachEvents: (() => void) | null = null;
let singletonOverrides: FeedSingletonOverrides | null = null;

const tickListeners = new Set<(tick: Tick) => void>();
const statusListeners = new Set<(event: StatusEvent) => void>();
const diagListeners = new Set<(diag: FeedDiagnosticsSnapshot) => void>();

let latestStatus: StatusEvent = {
  status: 'CONNECTING',
  tickAgeMs: null,
  endpoint: PRIMARY_ENDPOINT,
  reason: 'initial',
};
let lastTickAtMs: number | null = null;
let reconnectCount = 0;
let lastError: string | null = null;

let registryFetchPromise: Promise<void> | null = null;
let registryRetryTimers: unknown[] = [];

function getTimerApi() {
  const clock = singletonOverrides?.clock;
  if (clock) {
    return {
      setTimeout: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
      clearTimeout: (id: unknown) => clock.clearTimeout(id),
    };
  }
  return {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as any),
  };
}

function clearRegistryRetryTimers() {
  const { clearTimeout: clearT } = getTimerApi();
  for (const id of registryRetryTimers) {
    clearT(id);
  }
  registryRetryTimers = [];
}

function triggerRegistryLoad(): Promise<void> {
  if (!sharedFeed) return Promise.resolve();
  if (getAssetRegistryInfo().source === 'live') {
    clearRegistryRetryTimers();
    return Promise.resolve();
  }
  if (!sharedFeed.isSocketOpen()) {
    return Promise.resolve();
  }
  if (registryFetchPromise) {
    return registryFetchPromise;
  }

  const targetFeed = sharedFeed;
  registryFetchPromise = initializeAssetRegistry(targetFeed)
    .then(() => {
      if (getAssetRegistryInfo().source === 'live') {
        clearRegistryRetryTimers();
      }
      notifyDiagListeners();
    })
    .catch(() => {})
    .finally(() => {
      registryFetchPromise = null;
    });

  return registryFetchPromise;
}

function scheduleRegistryRetries() {
  clearRegistryRetryTimers();
  const { setTimeout: setT } = getTimerApi();
  for (const delayMs of REGISTRY_RETRY_DELAYS_MS) {
    const timerId = setT(() => {
      if (!sharedFeed || getAssetRegistryInfo().source === 'live') {
        clearRegistryRetryTimers();
        return;
      }
      if (!sharedFeed.isSocketOpen()) {
        return;
      }
      void triggerRegistryLoad();
    }, delayMs);
    registryRetryTimers.push(timerId);
  }
}

function buildDiagnosticsSnapshot(): FeedDiagnosticsSnapshot {
  const now = singletonOverrides?.clock ? singletonOverrides.clock.now() : Date.now();
  const ageSec =
    lastTickAtMs !== null
      ? Math.max(0, Math.round((now - lastTickAtMs) / 1000))
      : latestStatus.tickAgeMs !== null
      ? Math.max(0, Math.round(latestStatus.tickAgeMs / 1000))
      : null;

  return {
    endpoint: latestStatus.endpoint,
    status: latestStatus.status,
    reason: latestStatus.reason,
    lastTickAtMs,
    tickAgeSec: ageSec,
    reconnectCount,
    lastError,
    registry: getAssetRegistryInfo(),
  };
}

function notifyDiagListeners() {
  const snap = buildDiagnosticsSnapshot();
  for (const listener of diagListeners) {
    try {
      listener(snap);
    } catch (err) {
      console.warn('[feedSingleton] Diagnostics listener error', err);
    }
  }
}

/**
 * Optional configuration overrides for tests (must be called before getLiveFeed()).
 */
export function configureFeedSingletonForTest(overrides: FeedSingletonOverrides | null): void {
  singletonOverrides = overrides;
}

/**
 * Returns or creates the module-level singleton LiveFeed instance.
 */
export function getLiveFeed(): LiveFeed {
  if (!sharedFeed) {
    const endpoints = singletonOverrides?.endpoints ?? [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT];
    latestStatus = {
      status: 'CONNECTING',
      tickAgeMs: null,
      endpoint: endpoints[0] || PRIMARY_ENDPOINT,
      reason: 'initial',
    };

    sharedFeed = new LiveFeed({
      endpoints,
      wsFactory: singletonOverrides?.wsFactory,
      clock: singletonOverrides?.clock,
      random: singletonOverrides?.random,
      isMarketOpen: singletonOverrides?.isMarketOpen ?? ((symbol: string) => isSymbolMarketOpen(symbol)),
      onTick: (tick: Tick) => {
        lastTickAtMs = singletonOverrides?.clock ? singletonOverrides.clock.now() : Date.now();
        // Ensure active_symbols is loaded once socket proves live
        if (getAssetRegistryInfo().source !== 'live' && sharedFeed) {
          void triggerRegistryLoad();
        }
        for (const listener of tickListeners) {
          try {
            listener(tick);
          } catch (err) {
            console.warn('[feedSingleton] Tick listener error', err);
          }
        }
      },
      onStatus: (event: StatusEvent) => {
        const prevStatus = latestStatus.status;
        latestStatus = event;
        if (event.status === 'RECONNECTING' && prevStatus !== 'RECONNECTING') {
          reconnectCount += 1;
        }
        if (
          (event.status === 'LIVE' || event.status === 'DELAYED' || event.status === 'MARKET_CLOSED' || event.status === 'IDLE') &&
          getAssetRegistryInfo().source !== 'live' &&
          sharedFeed
        ) {
          void triggerRegistryLoad();
        }
        for (const listener of statusListeners) {
          try {
            listener(event);
          } catch (err) {
            console.warn('[feedSingleton] Status listener error', err);
          }
        }
        notifyDiagListeners();
      },
      onError: (symbol: string | null, code: string, message: string) => {
        lastError = symbol ? `[${symbol}] ${code}: ${message}` : `${code}: ${message}`;
        notifyDiagListeners();
      },
    });

    detachEvents = attachBrowserEvents(sharedFeed);
    scheduleRegistryRetries();
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
 * Returns diagnostics snapshot for ?debug=1 panel.
 */
export function getFeedDiagnostics(): FeedDiagnosticsSnapshot {
  getLiveFeed();
  return buildDiagnosticsSnapshot();
}

/**
 * Subscribe to diagnostics updates.
 */
export function subscribeDiagnostics(listener: (diag: FeedDiagnosticsSnapshot) => void): () => void {
  getLiveFeed();
  diagListeners.add(listener);
  listener(buildDiagnosticsSnapshot());
  return () => {
    diagListeners.delete(listener);
  };
}

/**
 * Teardown helper for full unmount or tests.
 */
export function destroySharedFeed(): void {
  clearRegistryRetryTimers();
  registryFetchPromise = null;
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
  diagListeners.clear();
  latestStatus = {
    status: 'CONNECTING',
    tickAgeMs: null,
    endpoint: singletonOverrides?.endpoints?.[0] || PRIMARY_ENDPOINT,
    reason: 'initial',
  };
  lastTickAtMs = null;
  reconnectCount = 0;
  lastError = null;
}
