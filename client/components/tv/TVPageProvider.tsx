'use client';

import { ReactNode, useEffect } from 'react';
import { FocusContext, useFocusable, init } from '@noriginmedia/norigin-spatial-navigation';

// init() wires up the library's own global keydown listener (arrow keys +
// Enter) - called once per app lifetime, guarded here since a page using
// TVPageProvider can mount/unmount as you navigate. Only ever imported by
// components already gated behind useIsTV(), so this never runs (and the
// library never attaches a listener) on PC/mobile.
let initialized = false;

// Root focus scope for a TV-mode page - establishes the FocusContext every
// TVFocusable descendant on the page navigates within. One of these per
// page, wrapping everything that should be D-pad-reachable on it.
//
// Arrow keys move focus FROM something - nothing is focused by default, so
// without an explicit initial focusSelf() call the very first key press
// does nothing at all (confirmed live: pressing Down on a freshly loaded
// Discover page produced no focus ring anywhere). focusSelf() on a
// trackChildren group delegates focus to its first focusable descendant,
// but the grid it needs to land on loads asynchronously - a single call
// right on mount can fire before any poster has rendered. Retries on a
// short backoff instead of a single fixed delay, so this keeps working
// however long the page's own data takes, without every TV page needing
// its own bespoke "focus once loaded" wiring.
const RETRY_DELAYS_MS = [50, 200, 500, 1000, 2000];

export function TVPageProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    init({ debug: false, visualDebug: false, distanceCalculationMethod: 'center' });
  }, []);

  const { ref, focusKey, focusSelf, getCurrentFocusKey } = useFocusable<object, HTMLDivElement>({ focusable: false, trackChildren: true });

  useEffect(() => {
    const timers = RETRY_DELAYS_MS.map((delay) => setTimeout(() => {
      // Stop once something already has focus - either an earlier retry
      // succeeded, or the user already moved focus themselves.
      if (getCurrentFocusKey() === focusKey) focusSelf();
    }, delay));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref}>{children}</div>
    </FocusContext.Provider>
  );
}
