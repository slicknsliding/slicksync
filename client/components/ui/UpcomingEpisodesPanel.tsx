'use client';

import { PanelControls } from '@/components/ui/Arrange';
import { useEffect, useState, useMemo, memo, useCallback, useRef } from 'react';
import { CalendarDaysIcon, TvIcon, XCircleIcon, SpeakerXMarkIcon, SpeakerWaveIcon } from '@heroicons/react/24/outline';
import { Card, MediaDetailModal, ContextMenu, useContextMenu, Modal, Button } from '@/components/ui';
import { ScrollRow } from '@/components/ui/ScrollRow';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { api, UpcomingEpisode, MutedShow } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { posterUrl } from '@/lib/posterUrl';

// Dashboard "Coming up" calendar: the next upcoming episode for every show
// someone here is mid-season on. Data is precomputed server-side by the
// episode-alerts poller (utils/episodeAlerts.js) and read straight from the
// DB — no Cinemeta call on page load. With nothing upcoming the card stays
// (so Muted shows is still reachable) and says so in one line.
//
// A strip of date tiles sits above the list: "All upcoming" (the default) plus
// one tile for each date that actually has an episode - no empty calendar
// cells. Picking a tile filters the list below it to that day; busy days carry
// a count badge and today is outlined. The list shows a handful of rows with a
// "Show more" button. This replaced the old agenda popup.
//
// Right-click (desktop) or long-press (touch) any row to hide it. Dismissals
// are keyed by (showId, season, episode) and persisted server-side, so a hide
// carries across devices AND automatically clears itself when the poller
// advances the show to a new next episode (that new one isn't in the dismiss
// list, so it re-appears without any manual reset).

const LONG_PRESS_MS = 500;
// Rows shown before "Show more" - fewer on a phone, where each row is full width.
const ROWS_DESKTOP = 6;
const ROWS_MOBILE = 3;

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

// Caption for the selected date: relative word (Today/Tomorrow/weekday) plus
// the concrete date, so it still reads like a calendar rather than a pile of
// "Monday"s across different weeks.
function dayHeaderLabel(iso: string): { text: string; soon: boolean } {
  const now = new Date();
  const air = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfAir = new Date(air.getFullYear(), air.getMonth(), air.getDate()).getTime();
  const days = Math.round((startOfAir - startOfToday) / (24 * 60 * 60 * 1000));
  const sameYear = air.getFullYear() === now.getFullYear();
  const date = air.toLocaleDateString(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (days <= 0) return { text: `Today · ${date}`, soon: true };
  if (days === 1) return { text: `Tomorrow · ${date}`, soon: true };
  return { text: date, soon: days < 7 };
}

// Bucket already-air-date-sorted items into per-calendar-day groups (stable
// order preserved within each day). Keyed on local Y/M/D so "airs today" and
// "airs tomorrow" split cleanly regardless of the wall-clock time of day.
function groupByDay(items: UpcomingEpisode[]): { key: string; ts: number; items: UpcomingEpisode[] }[] {
  const groups = new Map<string, { key: string; ts: number; items: UpcomingEpisode[] }>();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const it of items) {
    const air = new Date(it.airDate);
    // Anything already past counts as today, same as airLabel() above.
    const ts = Math.max(new Date(air.getFullYear(), air.getMonth(), air.getDate()).getTime(), startOfToday);
    const key = String(ts);
    if (!groups.has(key)) groups.set(key, { key, ts, items: [] });
    groups.get(key)!.items.push(it);
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

// Tile text: weekday / day number / month (plus the year once it isn't this year).
function tileParts(ts: number) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    day: d.getDate(),
    month: d.toLocaleDateString(undefined, sameYear ? { month: 'short' } : { month: 'short', year: 'numeric' }),
  };
}

// v2 tiles: "Tonight, 9 PM" / "Tomorrow, 9 PM" / "Thursday, 9 PM". The time is
// left off when the air date has none (midnight).
function airWhen(iso: string): string {
  const air = new Date(iso);
  const day = airLabel(iso).text;
  const hasTime = air.getHours() !== 0 || air.getMinutes() !== 0;
  const word = day === 'Today' && hasTime && air.getHours() >= 17 ? 'Tonight' : day;
  if (!hasTime) return word;
  return `${word}, ${air.toLocaleTimeString(undefined, { hour: 'numeric', minute: air.getMinutes() ? '2-digit' : undefined })}`;
}

// A single row. Extracted so each has its own context-menu hook, otherwise the
// menu's shared position would jump to whichever row was right-clicked last.
const UpcomingRow = memo(function UpcomingRow({
  item,
  onOpen,
  onDismiss,
  onMute,
  v2 = false,
  who,
}: {
  item: UpcomingEpisode;
  onOpen: (item: UpcomingEpisode) => void;
  onDismiss: (item: UpcomingEpisode) => void;
  onMute: (item: UpcomingEpisode) => void;
  /** Page design v2: a tile with a small poster, the title and episode, and when and who. */
  v2?: boolean;
  /** v2: who is partway through this show. */
  who?: string;
}) {
  const { isOpen, position, handleContextMenu, close } = useContextMenu();
  const label = airLabel(item.airDate);
  const { rpdbEnabled } = usePersonalFeatures();
  const isTV = useIsTV();

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

  const rowButton = v2 ? (
    <button
      type="button"
      onClick={() => {
        if (isOpen) return;
        onOpen(item);
      }}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={clearPress}
      onTouchCancel={clearPress}
      onTouchMove={handleTouchMove}
      title={item.title ? `${item.showName || 'Unknown show'} · ${item.title}` : undefined}
      className="v2-tool text-left tap-card"
      style={{ alignItems: 'center' }}
    >
      <div className="w-[34px] h-[50px] rounded-md overflow-hidden bg-surface-hover flex-shrink-0 flex items-center justify-center">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl({ id: item.showId, poster: item.poster }, rpdbEnabled)} alt="" className="w-full h-full object-cover" />
        ) : (
          <TvIcon className="w-4 h-4 text-subtle" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-semibold text-default truncate">
          {item.showName || 'Unknown show'} S{item.season} E{item.episode}
        </p>
        <p className="text-[12.5px] text-muted truncate">{airWhen(item.airDate)}{who ? ` · ${who}` : ''}</p>
      </div>
    </button>
  ) : (
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
  );

  return (
    <div className="relative">
      {isTV ? <TVFocusable onEnterPress={() => onOpen(item)}>{rowButton}</TVFocusable> : rowButton}

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

// Classic keeps the panel in its card; v2 sits straight in the page's own section.
function Shell({ v2, children }: { v2: boolean; children: React.ReactNode }) {
  return v2 ? <>{children}</> : <Card padding="lg">{children}</Card>;
}

// `className` is the outer spacing; the Dashboard's arranged grid spaces its
// panels itself and passes ''.
export const UpcomingEpisodesPanel = memo(function UpcomingEpisodesPanel({ className = 'mb-6', v2 = false, watchers }: {
  className?: string;
  /** Page design v2: tiles under the section’s own heading (the page draws the card and title). */
  v2?: boolean;
  /** v2: show id to the first names of the people partway through it. */
  watchers?: Record<string, string>;
} = {}) {
  const [items, setItems] = useState<UpcomingEpisode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<UpcomingEpisode | null>(null);
  const [mutedShows, setMutedShows] = useState<MutedShow[]>([]);
  const [isMutedModalOpen, setIsMutedModalOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const isTV = useIsTV();
  const isMobile = useIsMobile();

  const groups = useMemo(() => groupByDay(items.filter((i) => Number.isFinite(Date.parse(i.airDate)))), [items]);
  // If the selected day's last episode gets hidden, fall back to everything.
  const activeGroup = selectedDay === 'all' ? undefined : groups.find((g) => g.key === selectedDay);
  const activeDay = activeGroup ? activeGroup.key : 'all';
  const visibleItems = activeGroup ? activeGroup.items : groups.flatMap((g) => g.items);
  const rowLimit = isMobile ? ROWS_MOBILE : ROWS_DESKTOP;
  const shownItems = expanded ? visibleItems : visibleItems.slice(0, rowLimit);
  const nowDate = new Date();
  const todayTs = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();

  const pickDay = useCallback((key: string) => {
    setSelectedDay(key);
    setExpanded(false);
  }, []);

  useEffect(() => {
    api.getUpcomingEpisodes()
      .then((r) => setItems(Array.isArray(r) ? r : []))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);

  // Optimistically removes the row, but only keeps it gone (and only tells
  // the user it worked) once the server call actually confirms it - a
  // silently-swallowed failure here used to still show a success toast and
  // hide the row for the rest of this session, so a real (if rare) failure
  // read as "I hid it but it came back" on the next visit, with no error
  // ever shown.
  const handleDismiss = useCallback(async (item: UpcomingEpisode) => {
    setItems((prev) => prev.filter((i) => !(i.showId === item.showId && i.season === item.season && i.episode === item.episode)));
    try {
      await api.dismissUpcomingEpisode(item.showId, item.season, item.episode);
      toast.success(`Hidden ${item.showName || 'episode'} ${epLabel(item.season, item.episode)}`);
    } catch {
      setItems((prev) => [...prev, item]);
      toast.error(`Couldn’t hide ${item.showName || 'that episode'}`, { line: 'Try again.' });
    }
  }, []);

  // Mutes the whole show, not just this one episode - removes every row for
  // it (there's only ever one per show anyway) and stops future new-episode
  // alerts server-side too. See utils/episodeAlerts.js's muteShow. Same
  // confirm-before-celebrating pattern as handleDismiss above.
  const handleMute = useCallback(async (item: UpcomingEpisode) => {
    setItems((prev) => prev.filter((i) => i.showId !== item.showId));
    try {
      await api.muteShow(item.showId, item.showName || undefined, item.poster || undefined);
      toast.success(`Stopped tracking ${item.showName || 'this show'}`, { line: 'No more new-episode alerts for it.' });
    } catch {
      setItems((prev) => [...prev, item]);
      toast.error(`Couldn’t stop tracking ${item.showName || 'that show'}`, { line: 'Try again.' });
    }
  }, []);

  const openMutedModal = useCallback(() => {
    api.getMutedShows().then(setMutedShows).catch(() => setMutedShows([]));
    setIsMutedModalOpen(true);
  }, []);

  const handleUnmute = useCallback(async (show: MutedShow) => {
    setMutedShows((prev) => prev.filter((s) => s.id !== show.id));
    try {
      await api.unmuteShow(show.showId);
      toast.success(`Unmuted ${show.showName || 'show'}`, { line: 'It’ll show up again once it has a new episode.' });
    } catch {
      setMutedShows((prev) => [...prev, show]);
      toast.error(`Couldn’t unmute ${show.showName || 'that show'}`, { line: 'Try again.' });
    }
  }, []);

  if (!loaded) return null;

  const mutedButton = (
    <Button variant="secondary" size="sm" leftIcon={<SpeakerXMarkIcon className="w-4 h-4" />} onClick={openMutedModal} aria-label="Manage muted shows">
      Muted shows
    </Button>
  );

  const allTile = (
    <button
      type="button"
      aria-pressed={activeDay === 'all'}
      onClick={() => pickDay('all')}
      className="airing-date airing-date-all"
    >
      <CalendarDaysIcon className="w-5 h-5" />
      <span className="text-xs font-medium">All upcoming</span>
    </button>
  );

  return (
    <>
    <section aria-label="Upcoming episodes" className={className || undefined}>
      <Shell v2={v2}>
        {v2 ? (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {groups.length > 0 && (
              <>
                <span className="text-xs text-muted hidden sm:inline">Right-click or long-press an episode to hide it</span>
                <span className="text-xs text-muted sm:hidden">Long-press an episode to hide it</span>
              </>
            )}
            <div className="ml-auto">
              {mutedButton}
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {/* The fold chevron and ⋯ menu when the Dashboard is arranging it. */}
          <PanelControls side="start" />
          <CalendarDaysIcon className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold font-display text-default">Coming up</h3>
          {groups.length > 0 && (
            <>
              <span className="text-xs text-muted hidden sm:inline">Right-click or long-press an episode to hide it</span>
              <span className="text-xs text-muted sm:hidden">Long-press an episode to hide it</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {isTV ? <TVFocusable onEnterPress={openMutedModal}>{mutedButton}</TVFocusable> : mutedButton}
            <PanelControls side="end" />
          </div>
        </div>
        )}

        {groups.length === 0 ? (
          <p className="text-sm text-muted py-1">Nothing is scheduled for the shows you watch right now.</p>
        ) : (
          <>
            <fieldset className="min-w-0 border-0 p-0 m-0">
              <legend className="sr-only">Choose an airing date</legend>
              <ScrollRow arrows wrapperClassName="airing-strip mb-2" className="flex gap-2.5 p-1.5 pb-3">
                {isTV
                  ? <TVFocusable className="shrink-0" onEnterPress={() => pickDay('all')}>{allTile}</TVFocusable>
                  : <div className="shrink-0">{allTile}</div>}
                {groups.map((group) => {
                  const parts = tileParts(group.ts);
                  const label = dayHeaderLabel(group.items[0].airDate);
                  const count = group.items.length;
                  const btn = (
                    <button
                      type="button"
                      aria-pressed={activeDay === group.key}
                      aria-label={`${label.text}, ${count} episode${count === 1 ? '' : 's'}`}
                      onClick={() => pickDay(group.key)}
                      className={`airing-date airing-date-day ${group.ts === todayTs ? 'airing-date-today' : ''}`}
                    >
                      {count > 1 && <span className="airing-date-count" aria-hidden="true">{count}</span>}
                      <span className="text-xs font-medium" aria-hidden="true">{parts.weekday}</span>
                      <span className="font-display font-semibold text-2xl leading-tight tracking-tight" aria-hidden="true">{parts.day}</span>
                      <span className="text-xs" aria-hidden="true">{parts.month}</span>
                    </button>
                  );
                  return isTV
                    ? <TVFocusable key={group.key} className="shrink-0" onEnterPress={() => pickDay(group.key)}>{btn}</TVFocusable>
                    : <div key={group.key} className="shrink-0">{btn}</div>;
                })}
              </ScrollRow>
            </fieldset>

            <div aria-live="polite">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-2">
                <h4 className="text-sm font-semibold text-default">
                  {activeGroup ? dayHeaderLabel(activeGroup.items[0].airDate).text : 'All upcoming'}
                </h4>
                <span className="text-xs text-subtle">{visibleItems.length} episode{visibleItems.length === 1 ? '' : 's'}</span>
              </div>
              {/* Two columns from md up so a healthy watchlist doesn't turn
                  into a long vertical rail; one column on a phone. */}
              <div className={v2 ? 'v2-tiles v2-tiles-4' : 'grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5'}>
                {shownItems.map((item) => (
                  <UpcomingRow
                    key={`${item.showId}-${item.season}-${item.episode}`}
                    item={item}
                    onOpen={setDetail}
                    onDismiss={handleDismiss}
                    onMute={handleMute}
                    v2={v2}
                    who={watchers?.[item.showId]}
                  />
                ))}
              </div>
            </div>

            {visibleItems.length > rowLimit && (
              <div className="mt-3">
                {(() => {
                  const toggle = () => setExpanded((v) => !v);
                  const moreBtn = (
                    <Button variant="secondary" size="sm" onClick={toggle} aria-expanded={expanded}>
                      {expanded ? 'Show fewer' : `Show ${visibleItems.length - rowLimit} more`}
                    </Button>
                  );
                  return isTV ? <TVFocusable className="inline-block" onEnterPress={toggle}>{moreBtn}</TVFocusable> : moreBtn;
                })()}
              </div>
            )}
          </>
        )}
      </Shell>
    </section>

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

      <Modal isOpen={isMutedModalOpen} onClose={() => setIsMutedModalOpen(false)} title="Muted Shows" size="md">
        {mutedShows.length === 0 ? (
          <p className="text-sm text-muted py-4 text-center">No muted shows — &quot;Stop tracking this series&quot; on any Coming Up entry adds it here.</p>
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
    </>
  );
});
