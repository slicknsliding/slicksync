'use client';

import { useSyncExternalStore } from 'react';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useSharedNow } from '@/lib/useSharedNow';
import { playbackFreshness, type FreshnessRow } from '@/lib/playbackFreshness';

/** The pulse dot on a Now Playing card: beats only while the row is live,
 *  a quiet grey otherwise so a stale card does not look live. */
export function PlaybackDot({ row, liveClassName = 'bg-secondary', className = 'w-2 h-2' }: { row: FreshnessRow; liveClassName?: string; className?: string }) {
  const live = playbackFreshness(row, useSharedNow())?.pulse === true;
  return (
    <div
      className={`${className} rounded-full ${live ? `${liveClassName} animate-pulse` : ''}`}
      style={live ? undefined : { background: 'var(--color-text-subtle)' }}
      aria-hidden="true"
    />
  );
}

/** The small muted line under a card: "Live · updated 8 s ago". */
export function PlaybackFreshnessLine({ row, className = '' }: { row: FreshnessRow; className?: string }) {
  const isTV = useIsTV();
  const fresh = playbackFreshness(row, useSharedNow());
  if (!fresh) return null;
  return (
    <p className={`${isTV ? 'text-base' : 'text-xs'} text-subtle mt-0.5 ${className}`} data-freshness={fresh.state}>
      {fresh.text}
    </p>
  );
}

// ---- "Updated just now" beside a page heading ----
// One clock for every such line: it ticks every 10 seconds, and only while the
// tab is on screen, so a page left open in the background does no work.

const FRESH_TICK_MS = 10000;
let freshNow = 0;
let freshTimer: ReturnType<typeof setInterval> | null = null;
const freshListeners = new Set<() => void>();

function freshTick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  freshNow = Date.now();
  freshListeners.forEach((l) => l());
}

function freshSubscribe(listener: () => void) {
  freshListeners.add(listener);
  if (!freshTimer) {
    freshNow = Date.now();
    freshTimer = setInterval(freshTick, FRESH_TICK_MS);
    document.addEventListener('visibilitychange', freshTick);
  }
  return () => {
    freshListeners.delete(listener);
    if (freshListeners.size === 0 && freshTimer) {
      clearInterval(freshTimer);
      freshTimer = null;
      document.removeEventListener('visibilitychange', freshTick);
    }
  };
}

/** "Updated just now", "Updated 20s ago", "Updated 3m ago", "Updated 2h ago". */
export function freshnessText(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 10) return 'Updated just now';
  if (s < 60) return `Updated ${Math.floor(s / 10) * 10}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m}m ago`;
  return `Updated ${Math.floor(m / 60)}h ago`;
}

/** A quiet line for beside a page heading: a small green dot and when the
 *  page's data last refreshed. `at` is that time in ms (a Date.now() taken
 *  when the data arrived). The dot greys once the data is over two minutes old. */
export function Freshness({ at, className = '' }: { at: number | null | undefined; className?: string }) {
  const now = useSyncExternalStore(freshSubscribe, () => freshNow, () => 0);
  const isTV = useIsTV();
  if (!at || isTV) return null;
  const age = now > 0 ? now - at : 0;
  return (
    <span className={`freshness ${className}`} data-freshness-line="">
      <i aria-hidden="true" style={age > 120000 ? { background: 'var(--color-text-subtle)' } : undefined} />
      {freshnessText(age)}
    </span>
  );
}
