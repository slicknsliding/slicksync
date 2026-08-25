'use client';

import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';

// Instant navigation, page side. Applies the api client's last-known
// response for an endpoint (api.peekGet - see lastKnown's comment in
// api.ts) into the page's own state on mount, so returning to a page shows
// its previous content immediately instead of a loading spinner. The page's
// normal fetch-on-mount keeps running unchanged and overwrites this with
// fresh data when it lands.
//
// Mechanics worth knowing before reusing:
// - Deferred one tick, deliberately: applying synchronously in the effect
//   both trips the lint config's set-state-in-effect rule and, if done via
//   useState initializers instead, would desync server-rendered HTML from
//   the client's first paint (the server can never see localStorage). One
//   frame of spinner replaces hundreds of ms of network wait.
// - The one-tick delay also can't clobber fresh data: the page's own fetch
//   resolves through promise microtasks, so if it somehow wins the race,
//   peekGet reads the store that fetch just updated - applying the same
//   fresh value again is a no-op.
// - `apply` is captured once on mount (ref), so callers can pass an inline
//   closure over their setters without needing useCallback.
export function useLastKnown<T>(endpoint: string, apply: (value: T) => void) {
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const id = setTimeout(() => {
      const cached = api.peekGet<T>(endpoint);
      if (cached !== undefined) applyRef.current(cached);
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- endpoint is a per-page constant; re-peeking on change is not a real case
  }, []);
}
