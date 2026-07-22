'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// Feature flags for the SlickSync-native personal features (Watchlist,
// Watched indicators, Recommendations). Live on AppAccount.sync JSON —
// this hook fetches them once, caches in-module so every consumer shares
// the same state, and refreshes when the Settings page dispatches the
// bump event below. Default TRUE on missing / error / still-loading, so
// nothing hides while we're waiting for the first fetch.

export interface PersonalFeatures {
  enableWatchlist: boolean;
  enableWatchedIndicators: boolean;
  enableRecommendations: boolean;
}

const DEFAULT: PersonalFeatures = {
  enableWatchlist: true,
  enableWatchedIndicators: true,
  enableRecommendations: true,
};

// One in-flight promise + one cached value shared across every hook
// consumer. Prevents each Discover PosterCard / Dashboard panel from
// firing its own /account-sync call on mount.
let cached: PersonalFeatures | null = null;
let inFlight: Promise<PersonalFeatures> | null = null;
const listeners = new Set<(v: PersonalFeatures) => void>();
const REFRESH_EVENT = 'slicksync:personal-features-changed';

async function fetchOnce(): Promise<PersonalFeatures> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = api.getSyncSettings()
    .then((s) => {
      cached = {
        enableWatchlist: s?.enableWatchlist !== false,
        enableWatchedIndicators: s?.enableWatchedIndicators !== false,
        enableRecommendations: s?.enableRecommendations !== false,
      };
      inFlight = null;
      return cached;
    })
    .catch(() => {
      cached = DEFAULT;
      inFlight = null;
      return cached;
    });
  return inFlight;
}

/** Call from Settings after saving one of the toggles to invalidate the cache. */
export function invalidatePersonalFeatures() {
  cached = null;
  inFlight = null;
  // Re-fetch immediately + notify every mounted subscriber so they re-render.
  fetchOnce().then((v) => listeners.forEach((l) => l(v)));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

export function usePersonalFeatures(): PersonalFeatures {
  const [value, setValue] = useState<PersonalFeatures>(cached || DEFAULT);

  useEffect(() => {
    let mounted = true;
    fetchOnce().then((v) => { if (mounted) setValue(v); });
    listeners.add(setValue);
    // Also listen to the cross-window custom event so the Settings page
    // and a Discover tab in the same window both react to an edit.
    const onChange = () => { if (mounted && cached) setValue(cached); };
    if (typeof window !== 'undefined') window.addEventListener(REFRESH_EVENT, onChange);
    return () => {
      mounted = false;
      listeners.delete(setValue);
      if (typeof window !== 'undefined') window.removeEventListener(REFRESH_EVENT, onChange);
    };
  }, []);

  return value;
}
