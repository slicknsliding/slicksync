'use client';

import { useEffect, useState } from 'react';

// True on devices whose main pointer cannot hover - phones and tablets, and
// TVs driven by a remote. False on the server and on the first client
// render, so server-rendered HTML and the first paint agree; the real
// answer lands one effect later, which is before anything here is animated.
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(hover: none)');
    const apply = () => setCoarse(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);
  return coarse;
}
