'use client';

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
