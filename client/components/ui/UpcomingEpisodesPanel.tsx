'use client';

import { useEffect, useState, memo, useCallback, useRef } from 'react';
import { CalendarDaysIcon, TvIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { Card, MediaDetailModal, ContextMenu, useContextMenu } from '@/components/ui';
import { api, UpcomingEpisode } from '@/lib/api';
import { toast } from '@/components/ui/Toast';

// Dashboard "Coming up" calendar: the next upcoming episode for every show
// someone here is mid-season on. Data is precomputed server-side by the
// episode-alerts poller (utils/episodeAlerts.js) and read straight from the
// DB — no Cinemeta call on page load. Renders nothing when there's nothing
// upcoming, so it never shows an empty shell.
//
// Right-click (desktop) or long-press (touch) any row to hide it. Dismissals
// are keyed by (showId, season, episode) and persisted server-side, so a hide
// carries across devices AND automatically clears itself when the poller
// advances the show to a new next episode (that new one isn't in the dismiss
// list, so it re-appears without any manual reset).

const LONG_PRESS_MS = 500;

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

// A single row. Extracted so each has its own context-menu hook, otherwise the
// menu's shared position would jump to whichever row was right-clicked last.
const UpcomingRow = memo(function UpcomingRow({
  item,
  onOpen,
  onDismiss,
}: {
  item: UpcomingEpisode;
  onOpen: (item: UpcomingEpisode) => void;
  onDismiss: (item: UpcomingEpisode) => void;
}) {
  const { isOpen, position, handleContextMenu, close } = useContextMenu();
  const label = airLabel(item.airDate);

  // Long-press → context menu for touch devices. Cancel on move/scroll so a
  // scroll gesture doesn't get hijacked into a menu open. Track start position
  // so tiny finger jitter still counts as a press, not a scroll.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    startPos.current = null;
  };
  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startPos.current = { x: t.clientX, y: t.clientY };
    pressTimer.current = setTimeout(() => {
      // Manually invoke the hook's opener — position from the initial touch,
      // then a synthetic preventDefault to keep the click from also firing.
      handleContextMenu(e as unknown as Event, t.clientX, t.clientY);
      pressTimer.current = null;
    }, LONG_PRESS_MS);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!startPos.current || !pressTimer.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - startPos.current.x);
    const dy = Math.abs(t.clientY - startPos.current.y);
    if (dx > 10 || dy > 10) clearPress();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          // Suppress the click that fires immediately after a long-press.
          if (isOpen) return;
          onOpen(item);
        }}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={clearPress}
        onTouchCancel={clearPress}
        onTouchMove={handleTouchMove}
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
        {/* No flex-1 here — this used to stretch to fill the row (which can
            be very wide with only one item, e.g. a single-column Coming Up
            list), shoving the air-date badge all the way to the far right
            with a huge empty gap. min-w-0 alone still lets a long show name
            truncate correctly; the date now just sits right after it. */}
        <div className="min-w-0 max-w-[60%]">
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

      <ContextMenu isOpen={isOpen} position={position} onClose={close}>
        <button
          type="button"
          onClick={() => { close(); onDismiss(item); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <XCircleIcon className="w-4 h-4" />
          Hide this episode
        </button>
      </ContextMenu>
    </div>
  );
});

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

  const handleDismiss = useCallback((item: UpcomingEpisode) => {
    setItems((prev) => prev.filter((i) => !(i.showId === item.showId && i.season === item.season && i.episode === item.episode)));
    api.dismissUpcomingEpisode(item.showId, item.season, item.episode).catch(() => {});
    toast.success(`Hidden ${item.showName || 'episode'} ${epLabel(item.season, item.episode)}`);
  }, []);

  if (!loaded || items.length === 0) return null;

  return (
    <div className="mb-6">
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDaysIcon className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold font-display text-default">Coming up</h3>
          <span className="text-xs text-muted hidden sm:inline">New episodes for shows you&apos;re watching · right-click or long-press to hide</span>
          <span className="text-xs text-muted sm:hidden">Long-press to hide</span>
        </div>

        {/* Grid on desktop (two columns from md up) so a healthy watchlist
            doesn't turn into a long vertical rail; single column on mobile
            where narrow rows already read cleanly. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
          {items.slice(0, 8).map((item) => (
            <UpcomingRow
              key={`${item.showId}-${item.season}-${item.episode}`}
              item={item}
              onOpen={setDetail}
              onDismiss={handleDismiss}
            />
          ))}
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
