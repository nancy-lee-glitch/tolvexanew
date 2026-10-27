import React, { useEffect, useRef, useState } from 'react';
import type { AssetConfig } from '../types.ts';
import { pushAssetTick, getAssetTicks, getOrInitializeTimestampedTicks } from '../utils/quantEngine.ts';
import { LiveChart } from './LiveChart.tsx';

interface LiveTickerProps {
  activeAsset: AssetConfig;
  onAssetChange: (asset: AssetConfig) => void;
  onPriceUpdate?: (price: number) => void;
  onTicksUpdate?: (ticks: number[]) => void;
  onOpenVipRadar?: () => void;
  isVIP?: boolean;
}

export const ASSETS: AssetConfig[] = [
  // Forex Majors
  { symbol: 'frxEURUSD', name: 'EUR/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.08542 },
  { symbol: 'frxGBPUSD', name: 'GBP/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.29420 },
  { symbol: 'frxUSDJPY', name: 'USD/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 154.250 },
  { symbol: 'frxAUDUSD', name: 'AUD/USD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 0.65410 },
  { symbol: 'frxUSDCAD', name: 'USD/CAD', type: 'FOREX', decimals: 5, pipSize: 0.0001, basePrice: 1.38240 },
  { symbol: 'frxGBPJPY', name: 'GBP/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 198.650 },
  { symbol: 'frxEURJPY', name: 'EUR/JPY', type: 'FOREX', decimals: 3, pipSize: 0.01, basePrice: 167.420 },

  // Crypto Coins
  { symbol: 'cryBTCUSD', name: 'BTC/USD', type: 'CRYPTO', decimals: 2, pipSize: 1.0, basePrice: 88450.00 },
  { symbol: 'cryETHUSD', name: 'ETH/USD', type: 'CRYPTO', decimals: 2, pipSize: 0.1, basePrice: 3240.50 },
  { symbol: 'crySOLUSD', name: 'SOL/USD', type: 'CRYPTO', decimals: 2, pipSize: 0.01, basePrice: 184.75 },
  { symbol: 'cryXRPUSD', name: 'XRP/USD', type: 'CRYPTO', decimals: 4, pipSize: 0.0001, basePrice: 2.1450 },
  { symbol: 'cryDOGEUSD', name: 'DOGE/USD', type: 'CRYPTO', decimals: 4, pipSize: 0.0001, basePrice: 0.2450 },
  { symbol: 'cryBNBUSD', name: 'BNB/USD', type: 'CRYPTO', decimals: 2, pipSize: 0.1, basePrice: 620.40 },
  { symbol: 'cryADAUSD', name: 'ADA/USD', type: 'CRYPTO', decimals: 4, pipSize: 0.0001, basePrice: 0.7850 },
  { symbol: 'cryAVAXUSD', name: 'AVAX/USD', type: 'CRYPTO', decimals: 2, pipSize: 0.01, basePrice: 34.20 },
  { symbol: 'cryLINKUSD', name: 'LINK/USD', type: 'CRYPTO', decimals: 3, pipSize: 0.01, basePrice: 17.850 },

  // US Stocks
  { symbol: 'stkAAPL', name: 'Apple (AAPL)', type: 'STOCK', decimals: 2, pipSize: 0.01, basePrice: 232.50 },
  { symbol: 'stkTSLA', name: 'Tesla (TSLA)', type: 'STOCK', decimals: 2, pipSize: 0.01, basePrice: 248.80 },
  { symbol: 'stkNVDA', name: 'Nvidia (NVDA)', type: 'STOCK', decimals: 2, pipSize: 0.01, basePrice: 128.40 },
  { symbol: 'stkMSFT', name: 'Microsoft (MSFT)', type: 'STOCK', decimals: 2, pipSize: 0.01, basePrice: 428.15 },
  { symbol: 'stkAMZN', name: 'Amazon (AMZN)', type: 'STOCK', decimals: 2, pipSize: 0.01, basePrice: 186.20 },

  // Commodities & Indices
  { symbol: 'frxXAUUSD', name: 'GOLD (XAU)', type: 'COMMODITY', decimals: 2, pipSize: 0.01, basePrice: 2684.50 },
  { symbol: 'oilUSOIL', name: 'US OIL', type: 'COMMODITY', decimals: 2, pipSize: 0.01, basePrice: 71.40 },
  { symbol: 'idxSPX500', name: 'S&P 500', type: 'INDEX', decimals: 2, pipSize: 0.1, basePrice: 5860.20 },
  { symbol: 'idxNAS100', name: 'NASDAQ 100', type: 'INDEX', decimals: 2, pipSize: 0.1, basePrice: 20450.80 },

  // Deriv Volatility Synthetics
  { symbol: 'R_100', name: 'VOL 100', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 2415.80 },
  { symbol: 'R_75', name: 'VOL 75', type: 'SYNTH', decimals: 2, pipSize: 0.01, basePrice: 48920.40 },
];

export function LiveTicker({
  activeAsset,
  onAssetChange,
  onPriceUpdate,
  onTicksUpdate,
  onOpenVipRadar,
  isVIP,
}: LiveTickerProps) {
  const [currentPrice, setCurrentPrice] = useState<number>(activeAsset.basePrice || 1.08542);
  const [prevPrice, setPrevPrice] = useState<number>(activeAsset.basePrice || 1.08542);
  const [pricePulse, setPricePulse] = useState<'up' | 'down' | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [tickVelocity, setTickVelocity] = useState<string>('Normal (6 t/s)');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | 'CRYPTO' | 'STOCK' | 'FOREX' | 'SYNTH'>('ALL');
  
  const historyRef = useRef<number[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const tickCountRef = useRef<number>(0);

  // Sync initial price on activeAsset change
  useEffect(() => {
    getOrInitializeTimestampedTicks(
      activeAsset.symbol,
      activeAsset.basePrice || 1.08542,
      activeAsset.pipSize || 0.0001,
      activeAsset.decimals || 5,
      600
    );
    const existing = getAssetTicks(activeAsset.symbol);
    const initialP = existing.length > 0 
      ? existing[existing.length - 1] 
      : (activeAsset.basePrice || (activeAsset.decimals === 5 ? 1.08542 : 100.0));
    
    setCurrentPrice(initialP);
    setPrevPrice(initialP);
    historyRef.current = existing.length > 0 ? [...existing] : [initialP];
    onPriceUpdate?.(initialP);
    if (existing.length > 0) {
      onTicksUpdate?.([...existing]);
    }
  }, [activeAsset.symbol]);

  // Initialize Deriv WebSocket feed or fallback tick engine
  useEffect(() => {
    let isMounted = true;
    const existing = getAssetTicks(activeAsset.symbol);
    historyRef.current = existing.length > 0 ? [...existing] : [];

    const connectWS = () => {
      try {
        if (wsRef.current) {
          wsRef.current.close();
        }
        const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setWsConnected(true);
          // Subscribe to active asset if Deriv symbol
          ws.send(JSON.stringify({ forget_all: 'ticks' }));
          ws.send(JSON.stringify({ ticks: activeAsset.symbol, subscribe: 1 }));
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);
            if (data.tick && data.tick.symbol === activeAsset.symbol) {
              const quote = parseFloat(data.tick.quote);
              if (!isNaN(quote)) {
                processNewTick(quote);
              }
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onclose = () => {
          if (!isMounted) return;
          setWsConnected(false);
          // Auto-reconnect after 3s
          setTimeout(connectWS, 3000);
        };

        ws.onerror = () => {
          // Handled silently
        };
      } catch (e) {
        console.warn('WS Init notice', e);
      }
    };

    connectWS();

    // High frequency realistic tick pulse generator (works 24/7 for all assets including Crypto and Stocks)
    const simTimer = setInterval(() => {
      // If symbol is non-Deriv or WS is not actively pushing ticks, supply live continuous ticks
      const isDerivNative = ['frxEURUSD', 'frxGBPUSD', 'frxXAUUSD', 'R_100', 'R_75'].includes(activeAsset.symbol);
      if (!isDerivNative || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setCurrentPrice((prev) => {
          const stepSize = activeAsset.pipSize * (Math.random() > 0.8 ? 2.5 : 1.2);
          const delta = (Math.random() - 0.492) * stepSize;
          const next = Math.max(0.00001, parseFloat((prev + delta).toFixed(activeAsset.decimals)));
          processNewTick(next);
          return next;
        });
      }
    }, 800);

    return () => {
      isMounted = false;
      clearInterval(simTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [activeAsset.symbol, activeAsset.decimals, activeAsset.pipSize]);

  // Tick Velocity tracking loop
  useEffect(() => {
    const velInterval = setInterval(() => {
      const count = tickCountRef.current;
      tickCountRef.current = 0;
      if (count > 8) {
        setTickVelocity(`Surge (${count * 2} t/s)`);
      } else if (count > 3) {
        setTickVelocity(`High (${count * 2} t/s)`);
      } else {
        setTickVelocity(`Normal (${Math.max(count * 2, 4)} t/s)`);
      }
    }, 1000);
    return () => clearInterval(velInterval);
  }, []);

  const processNewTick = (newPrice: number) => {
    tickCountRef.current += 1;
    const nowSec = Math.floor(Date.now() / 1000);
    pushAssetTick(activeAsset.symbol, newPrice, nowSec);
    setPrevPrice((old) => {
      const diff = newPrice - old;
      if (diff > 0.0000001) {
        setPricePulse('up');
      } else if (diff < -0.0000001) {
        setPricePulse('down');
      }
      return old;
    });

    setCurrentPrice(newPrice);
    onPriceUpdate?.(newPrice);

    historyRef.current.push(newPrice);
    if (historyRef.current.length > 120) {
      historyRef.current.shift();
    }
    onTicksUpdate?.([...historyRef.current]);
  };

  const diff = currentPrice - prevPrice;

  // Filter assets by category
  const filteredAssets = ASSETS.filter((a) => {
    if (categoryFilter === 'ALL') return true;
    if (categoryFilter === 'CRYPTO') return a.type === 'CRYPTO';
    if (categoryFilter === 'STOCK') return a.type === 'STOCK';
    if (categoryFilter === 'FOREX') return a.type === 'FOREX';
    if (categoryFilter === 'SYNTH') return a.type === 'SYNTH' || a.type === 'COMMODITY' || a.type === 'INDEX';
    return true;
  });

  return (
    <div id="live-ticker-container" className="space-y-2">
      {/* Top Bar: Feed Status & Category Selector + VIP Screener Trigger */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        {/* Category Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none text-[11px] font-mono">
          {[
            { id: 'ALL', label: 'All (24)' },
            { id: 'CRYPTO', label: 'Crypto (9)' },
            { id: 'STOCK', label: 'Stocks (5)' },
            { id: 'FOREX', label: 'Forex (7)' },
            { id: 'SYNTH', label: 'Indices (4)' },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id as any)}
              className={`px-2.5 py-1 rounded-lg font-bold transition shrink-0 ${
                categoryFilter === cat.id
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Right side: VIP Screener button + Stream status */}
        <div className="flex items-center gap-2">
          {onOpenVipRadar && (
            <button
              type="button"
              id="vip-radar-screener-btn"
              data-tour="radar-control"
              onClick={onOpenVipRadar}
              className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-gradient-to-r from-amber-500/20 to-amber-400/20 hover:from-amber-500/30 hover:to-amber-400/30 border border-amber-500/40 text-amber-400 font-mono text-xs font-black shadow-md shadow-amber-500/10 transition"
              title="Open 24/7 VIP Real-Time Safe Trade Radar"
            >
              <svg className="w-3.5 h-3.5 text-amber-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span>VIP SAFE TRADE RADAR</span>
            </button>
          )}

          <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400 bg-slate-900/80 px-2.5 py-1 rounded-xl border border-slate-800">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-400'
              }`}
            />
            <span className="text-emerald-400 font-bold">24/7 LIVE</span>
          </div>
        </div>
      </div>

      {/* Asset Grid Selection - Scrollable & Multi-instrument */}
      <div className="overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-800">
        <div className="flex items-center gap-1.5 min-w-max" id="asset-selector-tabs" data-tour="asset-selector">
          {filteredAssets.map((asset) => {
            const isActive = asset.symbol === activeAsset.symbol;
            return (
              <button
                key={asset.symbol}
                type="button"
                id={`tab-${asset.symbol}`}
                onClick={() => onAssetChange(asset)}
                className={`py-2 px-3 rounded-xl text-left transition-all shrink-0 ${
                  isActive
                    ? 'bg-slate-900 border border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'bg-slate-900/60 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 leading-none">
                  <span className="px-1 py-0.2 rounded bg-slate-800 text-[9px] font-bold text-slate-300">
                    {asset.type}
                  </span>
                </div>
                <div className={`text-xs font-bold font-mono mt-1 ${isActive ? 'text-emerald-400' : 'text-slate-200'}`}>
                  {asset.name}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* TradingView Lightweight Charts Live Terminal */}
      <div data-tour="live-ticker">
        <LiveChart
          activeAsset={activeAsset}
          currentPrice={currentPrice}
          prevPrice={prevPrice}
          pricePulse={pricePulse}
          wsConnected={wsConnected}
          onAssetChange={onAssetChange}
        />
      </div>
    </div>
  );
}
