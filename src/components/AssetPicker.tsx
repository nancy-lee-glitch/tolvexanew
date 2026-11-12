import React, { useState, useEffect, useMemo } from 'react';
import type { AssetConfig, UserProfile } from '../types.ts';
import {
  getRegisteredAssets,
  subscribeAssetRegistry,
  isSymbolMarketOpen,
  type DynamicAsset,
  type AssetCategory,
} from '../services/assetRegistry.ts';
import { useFavorites } from '../services/favorites.ts';

interface AssetPickerProps {
  activeAsset: AssetConfig;
  onSelectAsset: (asset: AssetConfig) => void;
  user?: UserProfile | null;
  onClose?: () => void;
}

const CATEGORIES: { id: 'ALL' | 'FAVORITES' | AssetCategory; label: string; icon?: string }[] = [
  { id: 'ALL', label: 'All Markets' },
  { id: 'FAVORITES', label: '★ Favorites' },
  { id: 'Forex', label: 'Forex' },
  { id: 'Synthetics', label: 'Synthetics (24/7)' },
  { id: 'Crypto', label: 'Crypto (24/7)' },
  { id: 'Commodities', label: 'Commodities' },
  { id: 'Indices', label: 'Indices' },
  { id: 'Stocks', label: 'Stocks' },
];

export function AssetPicker({ activeAsset, onSelectAsset, user, onClose }: AssetPickerProps) {
  const [assets, setAssets] = useState<DynamicAsset[]>(() => getRegisteredAssets());
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | 'FAVORITES' | AssetCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [openOnly, setOpenOnly] = useState(false);

  const { favorites, isFavorite, toggleFavorite } = useFavorites(user);

  useEffect(() => {
    return subscribeAssetRegistry((updated) => setAssets(updated));
  }, []);

  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return assets.filter((asset) => {
      // 1. Search Query Filter
      if (q) {
        const matchesName = asset.name.toLowerCase().includes(q);
        const matchesSymbol = asset.symbol.toLowerCase().includes(q);
        const matchesCategory = asset.categoryName.toLowerCase().includes(q);
        if (!matchesName && !matchesSymbol && !matchesCategory) return false;
      }

      // 2. Category Tab Filter
      if (selectedCategory === 'FAVORITES') {
        if (!isFavorite(asset.symbol)) return false;
      } else if (selectedCategory !== 'ALL') {
        if (asset.categoryName !== selectedCategory) return false;
      }

      // 3. Open Now Toggle Filter
      if (openOnly) {
        if (!isSymbolMarketOpen(asset.symbol)) return false;
      }

      return true;
    });
  }, [assets, searchQuery, selectedCategory, openOnly, isFavorite]);

  const handleSelect = (asset: DynamicAsset) => {
    onSelectAsset(asset);
    onClose?.();
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-5 shadow-2xl space-y-4">
      {/* Search Header */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <svg
            className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search symbol, forex pair, index, or crypto (e.g. EUR/USD, R_100, BTC)..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:border-emerald-500 focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs font-mono"
            >
              ✕
            </button>
          )}
        </div>

        {/* "Open Now" Toggle */}
        <button
          type="button"
          onClick={() => setOpenOnly((prev) => !prev)}
          className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl border text-xs font-mono transition cursor-pointer shrink-0 ${
            openOnly
              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-bold'
              : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
          }`}
          title="Show only open markets"
        >
          <span className={`w-2 h-2 rounded-full ${openOnly ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          <span>Open Now</span>
        </button>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
          >
            ✕
          </button>
        )}
      </div>

      {/* Category Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-800">
        {CATEGORIES.map((cat) => {
          const isActive = selectedCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-mono transition-all shrink-0 cursor-pointer ${
                isActive
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 font-bold'
                  : 'bg-slate-950 text-slate-400 border border-slate-800 hover:border-slate-700 hover:text-slate-200'
              }`}
            >
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Asset Grid / List */}
      <div className="max-h-72 sm:max-h-80 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
        {filteredAssets.length === 0 ? (
          <div className="py-8 text-center text-xs font-mono text-slate-500 space-y-1">
            <div>No matching assets found.</div>
            {openOnly && <div className="text-[11px] text-slate-600">Try turning off the &quot;Open Now&quot; filter.</div>}
          </div>
        ) : (
          filteredAssets.map((asset) => {
            const isSelected = asset.symbol === activeAsset.symbol;
            const isOpen = isSymbolMarketOpen(asset.symbol);
            const isFav = isFavorite(asset.symbol);
            const isOtc = Boolean(asset.is_otc);

            return (
              <div
                key={asset.symbol}
                className={`flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                  isSelected
                    ? 'bg-emerald-950/30 border-emerald-500/50 text-white'
                    : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/40 text-slate-300'
                }`}
              >
                {/* Left: Star + Info */}
                <div
                  className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
                  onClick={() => handleSelect(asset)}
                >
                  {/* Star Favorite Button */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(asset.symbol);
                    }}
                    className={`p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer ${
                      isFav ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
                    }`}
                    title={isFav ? 'Remove from favorites' : 'Star to add to favorites'}
                  >
                    ★
                  </button>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs font-mono truncate">{asset.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 shrink-0">
                        {asset.categoryName}
                      </span>
                      {isOtc && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-500/40 shrink-0">
                          OTC
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-slate-500 flex items-center gap-2 mt-0.5">
                      <span>{asset.symbol}</span>
                      <span>•</span>
                      <span>Pip: {asset.pipSize}</span>
                      <span>•</span>
                      <span className="text-slate-400">Source: Deriv feed</span>
                    </div>
                  </div>
                </div>

                {/* Right: Market Status & Select */}
                <div className="flex items-center gap-2 shrink-0">
                  {isOpen ? (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-emerald-950/60 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>{asset.categoryName === 'Synthetics' || asset.categoryName === 'Crypto' ? '24/7 LIVE' : 'OPEN'}</span>
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-rose-950/60 text-rose-300 border border-rose-500/30">
                      {asset.categoryName === 'Forex' || asset.categoryName === 'Commodities'
                        ? 'Closed — opens Sun 21:00 UTC'
                        : 'Market closed'}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => handleSelect(asset)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition cursor-pointer ${
                      isSelected
                        ? 'bg-emerald-500 text-slate-950'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {isSelected ? 'Active' : 'Select'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Info */}
      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 border-t border-slate-800/80 pt-2.5">
        <span>Showing {filteredAssets.length} assets</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span>Real-Time Broker Telemetry</span>
        </span>
      </div>
    </div>
  );
}
