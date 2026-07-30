'use client';

import { useEffect, useState, memo, useCallback, useRef } from 'react';
import { CalendarDaysIcon, TvIcon, XCircleIcon, SpeakerXMarkIcon, SpeakerWaveIcon } from '@heroicons/react/24/outline';
import { Card, MediaDetailModal, ContextMenu, useContextMenu, Modal, Button } from '@/components/ui';
import { api, UpcomingEpisode, MutedShow } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl } from '@/lib/posterUrl';

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

// Day-header label for the full-calendar agenda: relative word (Today/Tomorrow/
// weekday) plus the concrete date, so scanning down the list still reads like a
// calendar rather than a pile of "Monday"s across different weeks.
function dayHeaderLabel(iso: string): { text: string; soon: boolean } {
  const now = new Date();
  const air = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfAir = new Date(air.getFullYear(), air.getMonth(), air.getDate()).getTime();
  const days = Math.round((startOfAir - startOfToday) / (24 * 60 * 60 * 1000));
  const date = air.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (days <= 0) return { text: `Today · ${date}`, soon: true };
  if (days === 1) return { text: `Tomorrow · ${date}`, soon: true };
  return { text: date, soon: days < 7 };
}

// Bucket already-air-date-sorted items into per-calendar-day groups (stable
// order preserved within each day). Keyed on local Y/M/D so "airs today" and
// "airs tomorrow" split cleanly regardless of the wall-clock time of day.
function groupByDay(items: UpcomingEpisode[]): { key: string; ts: number; items: UpcomingEpisode[] }[] {
  const groups = new Map<string, { key: string; ts: number; items: UpcomingEpisode[] }>();
  for (const it of items) {
    const air = new Date(it.airDate);
    const ts = new Date(air.getFullYear(), air.getMonth(), air.getDate()).getTime();
    const key = String(ts);
    if (!groups.has(key)) groups.set(key, { key, ts, items: [] });
    groups.get(key)!.items.push(it);
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

// A single row. Extracted so each has its own context-menu hook, otherwise the
// menu's shared position would jump to whichever row was right-clicked last.
const UpcomingRow = memo(function UpcomingRow({
  item,
  onOpen,
  onDismiss,
  onMute,
}: {
  item: UpcomingEpisode;
  onOpen: (item: UpcomingEpisode) => void;
  onDismiss: (item: UpcomingEpisode) => void;
  onMute: (item: UpcomingEpisode) => void;
}) {
  const { isOpen, position, handleContextMenu, close } = useContextMenu();
  const label = airLabel(item.airDate);
  const { rpdbEnabled } = usePersonalFeatures();

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
        className="w-full flex items-center gap-3 p-2 rounded-lg text-left hover:bg-surface-hover transition-colors tap-card"
      >
        <div className="w-10 h-14 rounded-md overflow-hidden bg-surface-hover flex-shrink-0 flex items-center justify-center">
          {item.poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterUrl({ id: item.showId, poster: item.poster }, rpdbEnabled)} alt="" className="w-full h-full object-cover" />
          ) : (
            <TvIcon className="w-5 h-5 text-subtle" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span
            className={`inline-block px-2 py-0.5 mb-1 rounded-full text-xs font-medium ${
              label.soon ? 'bg-primary/15 text-primary' : 'bg-surface-hover text-muted'
            }`}
          >
            {label.text}
          </span>
          <p className="text-sm font-medium text-default truncate">{item.showName || 'Unknown show'}</p>
          <p className="text-xs text-muted truncate">
            {epLabel(item.season, item.episode)}{item.title ? ` · ${item.title}` : ''}
          </p>
        </div>
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
        <button
          type="button"
          onClick={() => { close(); onMute(item); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <SpeakerXMarkIcon className="w-4 h-4" />
          Stop tracking this series
        </button>
      </ContextMenu>
    </div>
  );
});

export const UpcomingEpisodesPanel = memo(function UpcomingEpisodesPanel() {
  const [items, setItems] = useState<UpcomingEpisode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<UpcomingEpisode | null>(null);
  const [mutedShows, setMutedShows] = useState<MutedShow[]>([]);
  const [isMutedModalOpen, setIsMutedModalOpen] = useState(false);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);

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

  // Mutes the whole show, not just this one episode - removes every row for
  // it (there's only ever one per show anyway) and stops future new-episode
  // alerts server-side too. See utils/episodeAlerts.js's muteShow.
  const handleMute = useCallback((item: UpcomingEpisode) => {
    setItems((prev) => prev.filter((i) => i.showId !== item.showId));
    api.muteShow(item.showId, item.showName || undefined, item.poster || undefined).catch(() => {});
    toast.success(`Won't track new episodes for ${item.showName || 'this show'} anymore`);
  }, []);

  const openMutedModal = useCallback(() => {
    api.getMutedShows().then(setMutedShows).catch(() => setMutedShows([]));
    setIsMutedModalOpen(true);
  }, []);

  const handleUnmute = useCallback((show: MutedShow) => {
    setMutedShows((prev) => prev.filter((s) => s.id !== show.id));
    api.unmuteShow(show.showId).catch(() => {});
    toast.success(`${show.showName || 'Show'} will show up again once it has a new episode`);
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
          <button
            type="button"
            onClick={() => setIsCalendarOpen(true)}
            className="ml-auto text-xs font-medium text-primary hover:underline"
          >
            Full calendar
          </button>
          <button
            type="button"
            onClick={openMutedModal}
            title="Manage muted shows"
            className="p-1.5 rounded-lg text-muted hover:text-default hover:bg-surface-hover transition-colors"
          >
            <SpeakerXMarkIcon className="w-4 h-4" />
          </button>
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
              onMute={handleMute}
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

      {/* Full airing calendar: every tracked show's next episode, grouped by
          the day it airs. Reuses the same rows (open detail, hide, mute) as the
          compact dashboard card, but shows the whole agenda rather than the
          first eight. */}
      <Modal isOpen={isCalendarOpen} onClose={() => setIsCalendarOpen(false)} title="Airing Calendar" size="lg">
        {items.length === 0 ? (
          <p className="text-sm text-muted py-4 text-center">Nothing on the calendar right now.</p>
        ) : (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            {groupByDay(items).map((group) => {
              const header = dayHeaderLabel(group.items[0].airDate);
              return (
                <div key={group.key}>
                  <div className="flex items-center gap-2 mb-1.5 sticky top-0 bg-surface z-10 py-1">
                    <CalendarDaysIcon className={`w-4 h-4 ${header.soon ? 'text-primary' : 'text-muted'}`} />
                    <h4 className={`text-sm font-semibold ${header.soon ? 'text-primary' : 'text-default'}`}>{header.text}</h4>
                    <span className="text-xs text-subtle">{group.items.length} episode{group.items.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    {group.items.map((item) => (
                      <UpcomingRow
                        key={`${item.showId}-${item.season}-${item.episode}`}
                        item={item}
                        onOpen={(it) => { setIsCalendarOpen(false); setDetail(it); }}
                        onDismiss={handleDismiss}
                        onMute={handleMute}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      <Modal isOpen={isMutedModalOpen} onClose={() => setIsMutedModalOpen(false)} title="Muted Shows" size="md">
        {mutedShows.length === 0 ? (
          <p className="text-sm text-muted py-4 text-center">No muted shows — "Stop tracking this series" on any Coming Up entry adds it here.</p>
        ) : (
          <div className="space-y-2">
            {mutedShows.map((show) => (
              <div key={show.id} className="flex items-center gap-3 p-2 rounded-lg bg-surface-hover">
                <div className="w-8 h-11 rounded-md overflow-hidden bg-surface flex-shrink-0 flex items-center justify-center">
                  {show.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={show.poster} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <TvIcon className="w-4 h-4 text-subtle" />
                  )}
                </div>
                <p className="flex-1 min-w-0 text-sm font-medium text-default truncate">{show.showName || 'Unknown show'}</p>
                <Button variant="secondary" size="sm" leftIcon={<SpeakerWaveIcon className="w-4 h-4" />} onClick={() => handleUnmute(show)}>
                  Unmute
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
});
