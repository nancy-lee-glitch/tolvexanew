/**
 * favorites.ts — User asset favorites service.
 *
 * Requirements:
 * - Star-to-favorite stored in Supabase `user_favorites` when logged in.
 * - Falling back to in-memory session when logged out.
 */

import { useState, useEffect, useCallback } from 'react';
import { getSupabaseClient } from '../utils/supabaseClient.ts';
import type { UserProfile } from '../types.ts';

let inMemoryFavorites = new Set<string>(['frxEURUSD', 'R_100', 'cryBTCUSD']);
const listeners = new Set<(favs: Set<string>) => void>();

function notifyListeners() {
  const snap = new Set(inMemoryFavorites);
  for (const fn of listeners) fn(snap);
}

export async function fetchUserFavorites(userId?: number | string | null): Promise<Set<string>> {
  if (!userId) {
    return inMemoryFavorites;
  }
  const client = getSupabaseClient();
  if (!client) {
    return inMemoryFavorites;
  }

  try {
    const { data, error } = await client
      .from('user_favorites')
      .select('symbol');

    if (!error && Array.isArray(data)) {
      inMemoryFavorites = new Set(data.map((r) => r.symbol));
      notifyListeners();
    }
  } catch (err) {
    console.warn('[Favorites] Failed to load user favorites from Supabase:', err);
  }

  return inMemoryFavorites;
}

export async function toggleUserFavorite(
  symbol: string,
  user?: UserProfile | null
): Promise<boolean> {
  const isFav = inMemoryFavorites.has(symbol);
  if (isFav) {
    inMemoryFavorites.delete(symbol);
  } else {
    inMemoryFavorites.add(symbol);
  }
  notifyListeners();

  if (!user) {
    // Logged out: keep in session memory only
    return !isFav;
  }

  const client = getSupabaseClient();
  if (!client) return !isFav;

  try {
    if (isFav) {
      await client
        .from('user_favorites')
        .delete()
        .eq('symbol', symbol);
    } else {
      await client
        .from('user_favorites')
        .insert({ symbol });
    }
  } catch (err) {
    console.warn('[Favorites] DB sync error for favorite:', err);
  }

  return !isFav;
}

export function useFavorites(user?: UserProfile | null) {
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(inMemoryFavorites));

  useEffect(() => {
    fetchUserFavorites(user?.id);
    const listener = (updated: Set<string>) => setFavorites(updated);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [user?.id]);

  const toggle = useCallback(
    async (symbol: string) => {
      return toggleUserFavorite(symbol, user);
    },
    [user]
  );

  return {
    favorites,
    isFavorite: (sym: string) => favorites.has(sym),
    toggleFavorite: toggle,
  };
}
