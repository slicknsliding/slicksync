'use client';

import { useEffect } from 'react';
import { API_BASE } from '@/lib/api';

// Bridges the server's SSE live-update stream (/api/events) to window
// events any component can listen for. One connection per tab, mounted once
// in the admin layout.
//
// Strictly an accelerant: every consumer keeps its existing polling, and an
// event only means "refetch now instead of waiting for your next tick" - so
// a dropped stream, a buffering proxy, or a browser without EventSource
// degrades to exactly the pre-SSE behavior. Events carry a type and nothing
// else; data always comes from the same authenticated endpoints as before.
//
// EventSource reconnects on its own after a drop (browser-native backoff),
// and auth rides the session cookie via withCredentials.
export const LIVE_EVENT_PREFIX = 'slicksync:live-';

export function LiveEventsBridge() {
  useEffect(() => {
    let source: EventSource | null = null;
    try {
      source = new EventSource(`${API_BASE}/events`, { withCredentials: true });
      source.onmessage = (e) => {
        try {
          const { type } = JSON.parse(e.data || '{}');
          if (type) window.dispatchEvent(new Event(`${LIVE_EVENT_PREFIX}${type}`));
        } catch { /* malformed frame - ignore, polling still covers it */ }
      };
      // No onerror handling on purpose: EventSource retries itself, and
      // polling covers any gap - surfacing transient reconnects would just
      // be noise.
    } catch { /* EventSource unsupported - polling alone, as before */ }
    return () => { try { source?.close(); } catch { /* already closed */ } };
  }, []);

  return null;
}
