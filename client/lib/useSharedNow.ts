'use client';

import { useSyncExternalStore } from 'react';

// One clock for every Now Playing card on the page: a single timer that ticks
// while at least one card is listening, instead of a timer per card.
const TICK_MS = 5000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  now = Date.now();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', tick);
    }
  };
}

/** The current time in ms, refreshed every few seconds and shared by all callers. */
export function useSharedNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => 0);
}
