'use client';

import { useEffect, useState, memo } from 'react';
import { CalendarDaysIcon, TvIcon } from '@heroicons/react/24/outline';
import { Card, MediaDetailModal } from '@/components/ui';
import { api, UpcomingEpisode } from '@/lib/api';

// Dashboard "Coming up" calendar: the next upcoming episode for every show
// someone here is mid-season on. Data is precomputed server-side by the
// episode-alerts poller (utils/episodeAlerts.js) and read straight from the
// DB — no Cinemeta call on page load. Renders nothing when there's nothing
// upcoming, so it never shows an empty shell.

function epLabel(season: number, episode: number) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

// "Today" / "Tomorrow" / weekday within a week / short date beyond that.
function airLabel(iso: string): { text: string; soon: boolean } {
  const now = new Date();
  const air = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfAir = new Date(air.getFullYear(), air.getMonth(), air.getDate()).getTime();
  const days = Math.round((startOfAir - startOfToday) / (24 * 60 * 60 * 1000));
  if (days <= 0) return { text: 'Today', soon: true };
  if (days === 1) return { text: 'Tomorrow', soon: true };
  if (days < 7) return { text: air.toLocaleDateString(undefined, { weekday: 'long' }), soon: false };
  return { text: air.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), soon: false };
}

export const UpcomingEpisodesPanel = memo(function UpcomingEpisodesPanel() {
  const [items, setItems] = useState<UpcomingEpisode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<UpcomingEpisode | null>(null);

  useEffect(() => {
    api.getUpcomingEpisodes()
      .then((r) => setItems(Array.isArray(r) ? r : []))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded || items.length === 0) return null;

  return (
    <div className="mb-6">
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDaysIcon className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold font-display text-default">Coming up</h3>
          <span className="text-xs text-muted">New episodes for shows you&apos;re watching</span>
        </div>

        <div className="space-y-1.5">
          {items.slice(0, 8).map((item) => {
            const label = airLabel(item.airDate);
            return (
              <button
                key={`${item.showId}-${item.season}-${item.episode}`}
                type="button"
                onClick={() => setDetail(item)}
                className="w-full flex items-center gap-3 p-2 rounded-lg text-left hover:bg-surface-hover transition-colors"
              >
                <div className="w-10 h-14 rounded-md overflow-hidden bg-surface-hover flex-shrink-0 flex items-center justify-center">
                  {item.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.poster} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <TvIcon className="w-5 h-5 text-subtle" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-default truncate">{item.showName || 'Unknown show'}</p>
                  <p className="text-xs text-muted truncate">
                    {epLabel(item.season, item.episode)}{item.title ? ` · ${item.title}` : ''}
                  </p>
                </div>
                <span
                  className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${
                    label.soon ? 'bg-primary/15 text-primary' : 'bg-surface-hover text-muted'
                  }`}
                >
                  {label.text}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.showId}
          itemType="series"
          fallbackTitle={detail.showName || 'Upcoming episode'}
          fallbackPoster={detail.poster}
        />
      )}
    </div>
  );
});
