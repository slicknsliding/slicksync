'use client';

import { useEffect, useRef, useState } from 'react';
import { api, RatingsBatchEntry } from '@/lib/api';

/**
 * Fetches Rotten Tomatoes/Metacritic/IMDb ratings for a set of IMDb IDs and
 * returns a lookup map. Re-fetches only for IDs it hasn't already resolved
 * (or attempted and gotten nothing back for) - a grid re-rendering with the
 * same items, or a superset of previously-seen items, doesn't re-request
 * anything already known.
 */
export function useRatingsBatch(imdbIds: (string | null | undefined)[]): Record<string, RatingsBatchEntry> {
  const [ratings, setRatings] = useState<Record<string, RatingsBatchEntry>>({});
  const knownIdsRef = useRef<Set<string>>(new Set());

  const dedupedKey = [...new Set(imdbIds.filter((id): id is string => !!id))].sort().join(',');

  useEffect(() => {
    const ids = dedupedKey ? dedupedKey.split(',') : [];
    const unknownIds = ids.filter((id) => !knownIdsRef.current.has(id));
    if (unknownIds.length === 0) return;

    unknownIds.forEach((id) => knownIdsRef.current.add(id));

    let cancelled = false;
    api.getRatingsBatch(unknownIds).then((result) => {
      if (cancelled) return;
      setRatings((prev) => ({ ...prev, ...result.ratings }));
    }).catch(() => {
      // Ratings are decorative - a failed batch just means those cards render
      // without badges, not an error state worth surfacing to the user.
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dedupedKey]);

  return ratings;
}
