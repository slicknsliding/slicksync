'use client';

import { useState } from 'react';

/**
 * The first picture of a list that actually loads: when one fails, the next
 * is tried (an episode still, then the show's artwork, then its poster), so a
 * card never sits empty while the show has something to show. Starts over
 * when the list itself changes.
 */
export function useArtworkFallback(candidates: (string | null | undefined)[]) {
  const urls = [...new Set(candidates.filter((u): u is string => !!u))];
  const key = urls.join('|');
  const [failed, setFailed] = useState<{ key: string; count: number }>({ key: '', count: 0 });
  const index = failed.key === key ? failed.count : 0;
  return {
    url: urls[index] ?? null,
    onError: () => setFailed({ key, count: index + 1 }),
  };
}
