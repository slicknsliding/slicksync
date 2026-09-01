'use client';

import { useEffect, useState } from 'react';

// Beginner Mode - surfaces short inline explanations on pages that otherwise
// assume you already know what a manifest URL, a group, or the Vault is.
//
// Stored per-device in localStorage rather than as an account setting, on
// purpose: this is about how ONE person reads the UI, and a household where
// one member is new and another is not should not have to argue about a
// shared switch. It also means no server round-trip before first paint, so
// hints never pop in a moment after the page settles.
//
// The hint text itself is deliberately thin - one sentence plus a link into
// the real guide (there are 86 of them), rather than a second, parallel body
// of documentation that would drift out of step with the guides.

const KEY = 'slicksync-beginner-mode';
const EVENT = 'slicksync-beginner-mode-change';

export function isBeginnerMode(): boolean {
  if (typeof window === 'undefined') return false;
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setBeginnerMode(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* private mode - the toggle just won't persist */ }
  // Same-tab listeners don't get the native `storage` event (that only fires
  // in OTHER tabs), so every mounted hint is told directly.
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* SSR */ }
}

/** Subscribes to the toggle so hints appear/disappear without a reload. */
export function useBeginnerMode(): boolean {
  // Starts false and syncs on mount rather than reading localStorage during
  // render: the server render has no localStorage, and disagreeing with it
  // would be a hydration mismatch.
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(isBeginnerMode());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync); // other tabs
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return on;
}
