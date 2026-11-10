'use client';

import { useEffect, useState } from 'react';

// Detects whether the app is running inside a TV context - a third layout
// mode alongside mobile/desktop, but auto-detected the same way those are
// (no Settings toggle, nobody picks it). Three signals, checked in order:
//   1. window.__SLICKSYNC_TV__ - a hard flag the Android TV/Fire TV native
//      shell (Capacitor) sets before the page loads. Not a guess - once
//      that shell exists this is the only signal that actually matters.
//   2. A `?tv=1` query param, persisted to sessionStorage for the rest of
//      the tab - lets this be tested today, on any device, in any browser,
//      with nothing installed yet. `?tv=0` clears it.
//   3. Known TV WebView user-agent markers (Fire TV's "AFT<model>" prefix,
//      "Android TV", Sony BRAVIA, Google TV) - so opening the site directly
//      in the TV's own browser already lands in TV mode with zero setup,
//      before any native app exists at all.
declare global {
  interface Window {
    __SLICKSYNC_TV__?: boolean;
  }
}

const TV_UA_PATTERNS = [/\bAFT[A-Z]/i, /Android TV/i, /\bBRAVIA\b/i, /GoogleTV/i];
const SESSION_KEY = 'slicksync-tv-mode';

function detectTV(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__SLICKSYNC_TV__ === true) return true;

  const fromQuery = new URLSearchParams(window.location.search).get('tv');
  if (fromQuery === '1') {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch {}
    return true;
  }
  if (fromQuery === '0') {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    return false;
  }
  try {
    if (sessionStorage.getItem(SESSION_KEY) === '1') return true;
  } catch {}

  return TV_UA_PATTERNS.some((p) => p.test(navigator.userAgent));
}

// The answer once any component has worked it out - it can't change while
// the app is open.
let known: boolean | null = null;

// Starts false until the effect resolves post-mount - same reasoning as
// useIsMobile, avoids a hydration mismatch since detection depends on
// window/navigator that don't exist during SSR. Only for what renders with
// the first page, though: anything mounted later (the title popup) starts
// with the known answer. Starting it false too flipped the popup's isTV on
// its second render, and its TV-only focus hook with it - a hook appearing
// between renders, which crashed every title opened in TV mode.
export function useIsTV(): boolean {
  const [isTV, setIsTV] = useState(() => known ?? false);
  useEffect(() => {
    known = detectTV();
    // Lets CSS tell a TV apart (globals.css .hover-reveal): some TV browsers
    // report a mouse, so (hover: hover) alone can't.
    if (known) document.documentElement.setAttribute('data-tv', '');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the browser once hydrated is the point
    setIsTV(known);
  }, []);
  return isTV;
}
