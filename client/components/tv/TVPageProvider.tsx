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
export function TVPageProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    init({ debug: false, visualDebug: false, distanceCalculationMethod: 'center' });
  }, []);

  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({ focusable: false, trackChildren: true });

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref}>{children}</div>
    </FocusContext.Provider>
  );
}
