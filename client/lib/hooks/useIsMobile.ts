'use client';

import { useEffect, useState } from 'react';

// Mirrors Tailwind's `md` breakpoint (768px) - true below it, false at/above.
// Starts false (desktop) until the effect resolves post-mount, so a caller
// gating which of two DOM locations actually mounts a component (rather
// than just CSS-hiding a duplicate) doesn't double-render on the very first
// paint. The brief window before resolution is an imperceptible one-frame
// gap, not a hydration mismatch, since this never touches server-rendered
// markup either side depends on.
export function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    setIsMobile(query.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [breakpointPx]);

  return isMobile;
}
