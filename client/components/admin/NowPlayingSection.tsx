'use client';

import { PlaybackFreshnessLine } from '@/components/ui/PlaybackFreshness';
import { NowPlayingV2, type NowPlayingRows } from '@/components/v2/DashboardV2';

interface NowPlayingSectionProps {
  items: NowPlayingRows;
  /** Current time - the "watching for" figure is the server's plus the time
   *  since, so it keeps moving between polls without a fetch. Optional;
   *  without it the server's figure is shown as-is. */
  now?: number;
  fetchedAt?: number;
  /** Which app each person is in, for the banners. */
  providerByUser?: Map<string, string>;
}

const formatElapsed = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

// The Dashboard's Now Playing: the same banners as a person's Home (see
// NowPlayingV2), the first one large, then smaller ones, then a pointer at
// Activity. Under each banner, the line the old cards had: how long they have
// been watching, and how fresh the report is.
export function NowPlayingSection({ items, now, providerByUser }: NowPlayingSectionProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted">
        No one is currently watching
      </div>
    );
  }

  // How long this has been playing, worked out the way the Activity page
  // does: a stream the proxy is still confirming counts up from when it
  // started; once it stops confirming, the server's last figure stands.
  const watchingFor = (item: NowPlayingRows[number]): string | null => {
    const startMs = typeof item.watchedAtTimestamp === 'number' ? item.watchedAtTimestamp : null;
    if (item.source === 'aiostreams-proxy' && typeof item.elapsedSeconds === 'number') {
      const live = !item.elapsedFrozen && startMs && now ? Math.max(0, Math.floor((now - startMs) / 1000)) : item.elapsedSeconds;
      return formatElapsed(Math.max(live, 0));
    }
    if (startMs && now) return formatElapsed(Math.max(0, Math.floor((now - startMs) / 1000)));
    return null;
  };

  return (
    <NowPlayingV2
      rows={items}
      providerByUser={providerByUser ?? new Map()}
      moreHref="/activity"
      detail={(np) => {
        const f = watchingFor(np);
        return (
          <>
            {f && <p className="text-xs text-subtle">Watching for {f}</p>}
            <PlaybackFreshnessLine row={np} />
          </>
        );
      }}
    />
  );
}
