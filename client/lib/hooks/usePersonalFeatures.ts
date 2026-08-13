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
  // Trailer in the detail modal starts playing automatically instead of
  // waiting for a "Play Trailer" click. Default false (opt-in, not
  // opt-out) - unlike the other three SlickTrax flags above, autoplaying
  // audio/video the instant a modal opens is disruptive enough that it
  // shouldn't happen until someone explicitly asks for it in Settings.
  enableAutoplayTrailer: boolean;
  // Whether that autoplay starts muted (true, default) or with sound
  // (false) - a separate choice, not decided for the viewer. Only read when
  // enableAutoplayTrailer is on; an explicit "Play Trailer" click always
  // starts with sound regardless of this.
  autoplayTrailerStartMuted: boolean;
  // Whether to actually route a title's poster through RPDB's rating-
  // embedded art (/api/poster/{imdbId}) instead of its own stored poster.
  // Requires BOTH a configured RPDB key AND enablePosterRatings below -
  // RPDB's whole product is posters with ratings baked into the image, so
  // turning "Poster ratings" off is expected to hide those too, not just
  // this app's own overlay badges (confirmed live: a key alone was still
  // showing rating-embedded posters everywhere with the toggle off).
  // Deliberately just a boolean: the raw key stays server-side / confined
  // to the Settings page's own edit form, never round-tripped here.
  rpdbEnabled: boolean;
  // IMDb/Rotten Tomatoes/Metacritic badges on every poster card. Default
  // false (opt-in, like Autoplay trailer) - showing scores before anyone's
  // read anything about a title is enough of a judgment call that it
  // shouldn't happen until someone explicitly asks for it in Settings.
  enablePosterRatings: boolean;
  // Thumbs up/down reactions on the detail modal - feeds /recommendations scoring
  // (recommendationEngine.js's computeSignedAdjustments), not just
  // decorative. Default true, same as Watchlist/Watched indicators/
  // Recommendations above. Personal 1-10 ratings share the same backend
  // and toggle but have no UI yet (see MediaDetailModal.tsx).
  enableReactions: boolean;
}

const DEFAULT: PersonalFeatures = {
  enableWatchlist: true,
  enableWatchedIndicators: true,
  enableRecommendations: true,
  enableAutoplayTrailer: false,
  autoplayTrailerStartMuted: true,
  rpdbEnabled: false,
  enablePosterRatings: false,
  enableReactions: true,
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
        enableAutoplayTrailer: s?.enableAutoplayTrailer === true,
        autoplayTrailerStartMuted: s?.autoplayTrailerStartMuted !== false,
        rpdbEnabled: !!(s?.rpdbApiKey && s.rpdbApiKey.trim()) && s?.enablePosterRatings === true,
        enablePosterRatings: s?.enablePosterRatings === true,
        enableReactions: s?.enableReactions !== false,
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
