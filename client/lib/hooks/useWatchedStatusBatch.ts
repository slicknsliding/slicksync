'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';

export interface WatchedToggleItem {
  id: string;
  name: string;
}

/**
 * Extracted from Discover's own inline watched-status batching (originally
 * local to that page) so Catalogs can share the same fetch-once-per-id +
 * optimistic-toggle behavior. Mirrors useRatingsBatch's dedupe-by-known-ids
 * pattern rather than Discover's original `id in watchedStatus` deps check.
 */
export function useWatchedStatusBatch(ids: (string | null | undefined)[], enabled: boolean) {
  const [watchedStatus, setWatchedStatus] = useState<Record<string, boolean>>({});
  const knownIdsRef = useRef<Set<string>>(new Set());

  const dedupedKey = [...new Set(ids.filter((id): id is string => !!id))].sort().join(',');

  useEffect(() => {
    // Skip when the "Watched indicators" SlickTrax feature is disabled — no
    // point spending requests on data we won't render.
    if (!enabled) return;
    const idList = dedupedKey ? dedupedKey.split(',') : [];
    const unknown = idList.filter((id) => !knownIdsRef.current.has(id));
    if (unknown.length === 0) return;

    unknown.forEach((id) => knownIdsRef.current.add(id));

    let cancelled = false;
    api.getWatchedStatus(unknown).then((seen) => {
      if (cancelled) return;
      setWatchedStatus((prev) => {
        // Merge — for ids that came back false, mark them false so we don't
        // re-ask on the next render.
        const next = { ...prev };
        for (const id of unknown) next[id] = seen[id] === true;
        return next;
      });
    }).catch(() => {
      // A failed batch just means those cards render without the watched
      // badge - not worth surfacing as an error.
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dedupedKey, enabled]);

  const toggleWatched = useCallback(async (item: WatchedToggleItem, nextWatched: boolean) => {
    // Optimistic — flip the local map immediately so the ✓ badge reacts.
    setWatchedStatus((prev) => ({ ...prev, [item.id]: nextWatched }));
    try {
      await api.markWatched(item.id, nextWatched);
      toast.success(nextWatched
        ? `Marked "${item.name}" as watched`
        : `Marked "${item.name}" as unwatched`);
    } catch (e: any) {
      setWatchedStatus((prev) => ({ ...prev, [item.id]: !nextWatched }));
      toast.error(e?.message || 'Failed to update watched status');
    }
  }, []);

  return { watchedStatus, toggleWatched };
}
