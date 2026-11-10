'use client';

// Continue Watching on the Dashboard, drawn like the Now Playing banner: the
// latest title as one wide banner or the first card of the row (Settings →
// Themes → Continue Watching first card), the rest as smaller banners in a
// row. Each says who and which profile, the episode, where they stopped, and
// has a Resume (or Play) button - visible everywhere, not only on hover.
//
// Settings → Themes → Continue Watching, ... progress, ... time left: who is
// watching, the bar with where they stopped, and the time left with the
// episode each sit on the picture or in lines under the card (the default).
// The title, Resume and the ... button always stay on the card.
// Tapping the card opens its details; the ... button (or right-click, or a
// long press) offers Details and Remove from Continue Watching.
//
// Settings → Themes → Card backgrounds: the show's picture behind the words
// (the default), or plain, with the poster beside the words instead.
//
// The row sizes with Arrange's stretch handle (the page puts cardAttrs and
// <StretchHandle> on it); the cards tighten when narrow and grow when wide
// (.cwb in globals.css, by container width).

import { memo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { EllipsisHorizontalIcon, InformationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { ContinueWatchingItem } from '@/lib/api';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { pointAnchor, HIDDEN_ANCHOR } from '@/lib/pointAnchor';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import { formatClock } from '@/components/ui/NowPlayingPosition';
import { useArtworkFallback } from '@/lib/hooks/useArtworkFallback';
import { useCardBackground, useCwProgress, useCwTime, useCwWho } from '@/lib/arrange';
import { cachedImageUrl } from '@/lib/posterUrl';
import { providerTypeLabel } from '@/lib/providers';

const LONG_PRESS_MS = 500;
const imdbOf = (id: string) => /^tt\d+/.exec(id || '')?.[0] || null;

/** "6 min left", "2 h 3 min left"; Up next for the next episode. */
export function timeLeftChip(item: ContinueWatchingItem): string {
  if (!item.resume) return 'Up next';
  const m = item.remainingMinutes;
  if (m != null) return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''} left` : `${m} min left`;
  return item.progressPercent != null ? `${item.progressPercent}% watched` : 'Resume';
}

export function agoText(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  return `${Math.round(h / 24)} days ago`;
}

/** The line under the episode: where they stopped, or that the next episode waits. */
export function stoppedLine(item: ContinueWatchingItem, now = Date.now()): string {
  const ago = agoText(item.lastWatchedAt, now);
  if (!item.resume) return `Next episode · watched ${ago}`;
  if (item.positionMs && item.durationMs) return `Stopped at ${formatClock(item.positionMs / 1000)} of ${formatClock(item.durationMs / 1000)} · ${ago}`;
  return `${timeLeftChip(item)} · ${ago}`;
}

/** "S1 E4 · The Band", or "Movie": the episode beside the time left under the card. */
function episodeShort(item: ContinueWatchingItem): string {
  const e = item.nextEpisode;
  if (item.contentType === 'series' && e) return `S${e.season} E${e.episode}${e.title ? ` · ${e.title}` : ''}`;
  return item.contentType === 'movie' ? 'Movie' : '';
}

function episodeLong(item: ContinueWatchingItem): string {
  const e = item.nextEpisode;
  if (item.contentType === 'series' && e) return `Season ${e.season}, Episode ${e.episode}${e.title ? ` · ${e.title}` : ''}`;
  return item.contentType === 'movie' ? 'Movie' : '';
}

/** What the button says and where it goes. */
function playOf(item: ContinueWatchingItem) {
  const app = providerTypeLabel(item.providerType || 'stremio');
  const href = item.appUrl || item.webUrl || null;
  const e = item.nextEpisode;
  const what = item.resume ? 'Resume' : (item.contentType === 'series' && e ? `Play S${e.season} E${e.episode}` : 'Play');
  return { href, inApp: !!item.appUrl, text: item.appUrl ? `${what} in ${app}` : what };
}

/** Picture behind the words: the backdrop first, as Now Playing does. Plain: the poster. */
function useCardArt(item: ContinueWatchingItem, plain: boolean) {
  const imdb = imdbOf(item.showId);
  return useArtworkFallback(plain
    ? [item.poster, imdb ? `https://images.metahub.space/poster/medium/${imdb}/img` : null]
    : [item.background, imdb ? `https://images.metahub.space/background/medium/${imdb}/img` : null, item.nextEpisode?.thumbnail, item.poster]);
}

type CardProps = {
  item: ContinueWatchingItem;
  wasDraggedRef: RefObject<boolean>;
  onRemove: (item: ContinueWatchingItem) => void;
  /** Tapping the card. Without it (a person's own Home) a tap opens the menu. */
  onOpenDetails?: (item: ContinueWatchingItem) => void;
  /** The first cards: fetched at once rather than when seen. */
  priority?: boolean;
  /** A person's own Home: the profile only, not their name and picture on every card. */
  self?: boolean;
  /** The caller draws the menu (a person's Home: Resume, Choose app..., Remove), hung from this button. */
  onMore?: (item: ContinueWatchingItem, anchor: HTMLElement) => void;
};

/** Right-click, long press and the ... button all open the same anchored menu. */
function useCardMenu(wasDraggedRef: RefObject<boolean>, onMore?: (anchor: HTMLElement) => void) {
  const [open, setOpenState] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // With a caller-drawn menu, opening hands it the ... button instead.
  const setOpen = (v: boolean) => {
    if (v && onMore) { if (anchorRef.current) onMore(anchorRef.current); return; }
    setOpenState(v);
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const opened = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } start.current = null; };
  return {
    open,
    setOpen,
    anchorRef,
    /** Swallows the click that follows a long press. */
    justOpened: () => { const o = opened.current; opened.current = false; return o; },
    handlers: {
      // A tap that opens the menu (a person's Home) opens it where it landed too.
      onPointerDown: (e: React.PointerEvent) => pointAnchor(anchorRef.current, e),
      onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (!wasDraggedRef.current) { pointAnchor(anchorRef.current, e); setOpen(true); } },
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        start.current = { x: t.clientX, y: t.clientY };
        const at = { clientX: t.clientX, clientY: t.clientY };
        timer.current = setTimeout(() => { timer.current = null; opened.current = true; pointAnchor(anchorRef.current, at); setOpen(true); }, LONG_PRESS_MS);
      },
      onTouchMove: (e: React.TouchEvent) => {
        const t = e.touches[0];
        if (!t || !start.current || !timer.current) return;
        if (Math.abs(t.clientX - start.current.x) > 10 || Math.abs(t.clientY - start.current.y) > 10) clear();
      },
      onTouchEnd: clear,
      onTouchCancel: clear,
    },
  };
}

function Who({ item, extra, onPicture, self, under }: { item: ContinueWatchingItem; extra?: string; onPicture: boolean; self?: boolean; under?: boolean }) {
  const where = [extra, item.profileLabel || providerTypeLabel(item.providerType || 'stremio')].filter(Boolean).join(' · ');
  const size = under ? 'text-[13.5px] mt-0.5' : 'text-[12.5px]';
  if (self) return <p className={`cwb-who ${size} break-words`} style={{ color: onPicture ? '#e5e7eb' : 'var(--color-text-muted)' }}>{where}</p>;
  return (
    <div className={`cwb-who flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 ${size}`} style={{ color: onPicture ? '#e5e7eb' : 'var(--color-text-muted)' }}>
      <UserAvatar userId={item.userId} name={item.username} size="xs" />
      <b className="break-words min-w-0" style={{ color: onPicture ? '#fff' : 'var(--color-text)' }}>{item.username.split(' ')[0]}</b>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 break-words">{where}</span>
    </div>
  );
}

function ProgressBar({ item, onPicture, under }: { item: ContinueWatchingItem; onPicture: boolean; under?: boolean }) {
  if (!item.resume || item.progressPercent == null) return null;
  return (
    <div className={`h-1.5 rounded-full ${under ? '' : 'mt-1.5'}`} style={{ background: onPicture ? 'rgba(255,255,255,.18)' : 'var(--color-surface-hover)' }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(3, item.progressPercent))}%`, background: 'var(--color-progress, linear-gradient(90deg, var(--color-primary), var(--color-secondary)))' }} />
    </div>
  );
}

function PlayButton({ item, wasDraggedRef, big }: { item: ContinueWatchingItem; wasDraggedRef: RefObject<boolean>; big?: boolean }) {
  const p = playOf(item);
  if (!p.href) return null;
  return (
    <a
      href={p.href}
      target={p.inApp ? undefined : '_blank'}
      rel={p.inApp ? undefined : 'noopener noreferrer'}
      draggable={false}
      onClick={(e) => { e.stopPropagation(); if (wasDraggedRef.current) e.preventDefault(); }}
      className={`cwb-play inline-flex items-center gap-1.5 rounded-full font-semibold text-white self-start ${big ? 'px-4 py-2 text-sm' : 'px-3 py-1 text-xs'}`}
      style={{ background: 'var(--color-primary)' }}
    >
      <PlayIcon className={big ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      {p.text}
    </a>
  );
}

function Chip({ item, onPicture }: { item: ContinueWatchingItem; onPicture: boolean }) {
  return (
    <span
      className="cwb-chip px-2 py-[3px] rounded-full text-[11.5px] font-semibold pointer-events-none whitespace-nowrap"
      style={item.resume
        ? { background: onPicture ? 'rgba(0,0,0,0.6)' : 'var(--color-surface-hover)', color: onPicture ? '#fff' : 'var(--color-text)' }
        : { background: 'var(--color-primary)', color: '#fff' }}
    >
      {timeLeftChip(item)}
    </span>
  );
}

function MoreButton({ anchorRef, open, onToggle, label, onPicture }: { anchorRef: RefObject<HTMLButtonElement | null>; open: boolean; onToggle: () => void; label: string; onPicture: boolean }) {
  const isTV = useIsTV();
  // Right-click or a long press opens the menu where it happened; a remote has
  // neither, so only TV shows the button.
  if (!isTV) return <button ref={anchorRef} type="button" tabIndex={-1} aria-hidden="true" className={HIDDEN_ANCHOR} />;
  return (
    <button
      ref={anchorRef}
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-label={`More for ${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      className="absolute top-2 right-2 z-[2] w-9 h-9 rounded-full flex items-center justify-center"
      style={{ background: onPicture ? 'rgba(0,0,0,0.5)' : 'var(--color-surface-hover)', color: onPicture ? '#fff' : 'var(--color-text)' }}
    >
      <EllipsisHorizontalIcon className="w-5 h-5" />
    </button>
  );
}

function CardMenu({ anchorRef, open, onClose, item, onRemove, onOpenDetails }: { anchorRef: RefObject<HTMLButtonElement | null>; open: boolean; onClose: () => void; item: ContinueWatchingItem; onRemove: CardProps['onRemove']; onOpenDetails?: CardProps['onOpenDetails'] }) {
  if (!open) return null;
  const row = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[15px] text-left text-default hover:bg-surface-hover transition-colors';
  const icon = 'w-[18px] h-[18px] shrink-0 text-muted';
  const close = onClose;
  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={close} title={item.showName} width={280} align="end">
      <div className="space-y-1 -mx-1">
        {onOpenDetails && (
          <button type="button" className={row} onClick={() => { close(); onOpenDetails(item); }}>
            <InformationCircleIcon className={icon} />
            Details
          </button>
        )}
        <button type="button" className={row} onClick={() => { close(); onRemove(item); }}>
          <XMarkIcon className={icon} />
          Remove from Continue Watching
        </button>
        <p className="px-3 pt-1 text-xs" style={{ color: 'var(--color-text-subtle)' }}>Their watch history is kept.</p>
      </div>
    </AnchoredPopup>
  );
}

/** The card's own frame: tap for details, right-click or long press for the menu. */
function Frame({ item, handlers, ignoreClick, wasDraggedRef, onActivate, className, style, children }: {
  item: ContinueWatchingItem;
  handlers: ReturnType<typeof useCardMenu>['handlers'];
  /** True for the click that follows a long press, or while the menu is open. */
  ignoreClick: () => boolean;
  wasDraggedRef: RefObject<boolean>;
  /** A tap on the card itself: its details, or its menu. */
  onActivate: () => void;
  className: string;
  style: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      {...handlers}
      onClick={(e) => {
        if (ignoreClick() || wasDraggedRef.current) return;
        if ((e.target as HTMLElement).closest('a,button')) return;
        onActivate();
      }}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      className={`cwb relative min-w-0 overflow-hidden select-none cursor-pointer tap-card ${className}`}
      style={{ border: '1px solid var(--color-surface-border)', ...style }}
      data-continue-card={item.showId}
    >
      {children}
    </div>
  );
}

/** Which parts sit under the card rather than on it (Settings → Themes → Continue Watching). */
function useUnderParts() {
  const who = useCwWho().where === 'under';
  const progress = useCwProgress().where === 'under';
  const time = useCwTime().where === 'under';
  return { who, progress, time, any: who || progress || time };
}

/** The lines under the card, each where its own switch puts it: the bar, the
 *  time left with the episode, where they stopped, and who is watching. */
function UnderParts({ item, parts, extra, self }: { item: ContinueWatchingItem; parts: ReturnType<typeof useUnderParts>; extra?: string; self?: boolean }) {
  const ep = episodeShort(item);
  // "Up next" already says the next episode waits.
  const stopped = parts.time ? stoppedLine(item).replace(/^Next episode · w/, 'W') : stoppedLine(item);
  return (
    <div className="cwb-under flex flex-col gap-1 px-1 mt-2.5 min-w-0">
      {/* No bar (Up next): the same room, so every card in the row stays one height. */}
      {parts.progress && (item.resume && item.progressPercent != null ? <ProgressBar item={item} onPicture={false} under /> : <div className="h-1.5" aria-hidden="true" />)}
      {parts.time && (
        <p className="text-[13.5px] leading-snug break-words" style={{ color: 'var(--color-text-muted)' }}>
          <b className="font-bold" style={{ color: item.resume ? 'var(--color-text)' : 'var(--color-primary)' }}>{timeLeftChip(item)}</b>
          {ep && ` · ${ep}`}
        </p>
      )}
      {parts.progress && <p className="text-[12.5px] leading-snug break-words" style={{ color: 'var(--color-text)' }}>{stopped}</p>}
      {parts.who && <Who item={item} extra={extra} onPicture={false} self={self} under />}
    </div>
  );
}

/** The card with its lines under it, as one cell of the row. Without any
 *  lines under it, the card alone. */
function Cell({ under, children }: { under: ReactNode | null; children: ReactNode }) {
  if (!under) return <>{children}</>;
  return <div className="cwb-cell flex flex-col min-w-0 h-full select-none">{children}{under}</div>;
}

/** One of the smaller banners in the row. */
export const ContinueBannerCard = memo(function ContinueBannerCard({ item, wasDraggedRef, onRemove, onOpenDetails, priority = false, self, onMore }: CardProps) {
  const plain = useCardBackground().bg === 'plain';
  const parts = useUnderParts();
  const { url: art, onError } = useCardArt(item, plain);
  const { open, setOpen, anchorRef, justOpened, handlers } = useCardMenu(wasDraggedRef, onMore ? (a) => onMore(item, a) : undefined);
  const onPicture = !plain;
  const ep = episodeLong(item);
  return (
    <>
      <Cell under={parts.any ? <UnderParts item={item} parts={parts} self={self} /> : null}>
      <Frame item={item} handlers={handlers} ignoreClick={() => justOpened() || open} wasDraggedRef={wasDraggedRef} onActivate={() => (onOpenDetails ? onOpenDetails(item) : setOpen(true))}
        className={`rounded-2xl flex flex-col ${parts.any ? 'flex-1' : 'h-full'} ${plain ? '' : 'min-h-[230px] sm:min-h-[250px]'}`}
        style={{ background: plain ? 'var(--color-surface-elevated, var(--color-surface))' : 'var(--color-surface)' }}>
        {onPicture && art && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cachedImageUrl(art, 500) || art} onError={onError} alt="" draggable={false} loading={priority ? 'eager' : 'lazy'} decoding="async" className="art-fill absolute inset-0 w-full h-full object-cover pointer-events-none" />
        )}
        {onPicture && <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(0deg, rgba(10,12,20,.97) 0%, rgba(10,12,20,.82) 45%, rgba(10,12,20,.1) 100%)' }} />}
        {onPicture ? (
          // The chip sits in its own strip, so long titles push the card taller instead of under it.
          <div className="relative h-12 shrink-0">{!parts.time && <span className="absolute left-2.5 top-2.5 z-[1]"><Chip item={item} onPicture /></span>}</div>
        ) : (
          <div className="relative flex items-start gap-2.5 pt-3 pl-3.5 pr-12">
            {art ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cachedImageUrl(art, 154) || art} onError={onError} alt="" draggable={false} loading={priority ? 'eager' : 'lazy'} decoding="async" className="w-11 h-[66px] rounded-lg object-cover shrink-0 pointer-events-none" style={{ boxShadow: '0 2px 8px rgba(0,0,0,.35)' }} />
            ) : <span className="w-11 h-[66px] rounded-lg shrink-0" style={{ background: 'var(--color-surface-hover)' }} />}
            {!parts.time && <Chip item={item} onPicture={false} />}
          </div>
        )}
        <MoreButton anchorRef={anchorRef} open={open} onToggle={() => setOpen(!open)} label={item.showName} onPicture={onPicture} />
        <div className={`relative mt-auto flex flex-col gap-[3px] px-3.5 pb-3.5 ${plain ? "pt-3" : "pt-0"}`}>
          {!parts.who && <Who item={item} onPicture={onPicture} self={self} />}
          <p className="cwb-title font-bold leading-tight break-words mt-0.5" style={{ color: onPicture ? '#fff' : 'var(--color-text)' }}>{item.showName}</p>
          {ep && !parts.time && <p className="text-[12.5px] break-words" style={{ color: onPicture ? '#d1d5db' : 'var(--color-text-muted)' }}>{ep}</p>}
          {!parts.progress && <ProgressBar item={item} onPicture={onPicture} />}
          {!parts.progress && <p className="cwb-line text-xs break-words mt-0.5" style={{ color: onPicture ? '#e5e7eb' : 'var(--color-text-muted)' }}>{stoppedLine(item)}</p>}
          <div className="mt-2"><PlayButton item={item} wasDraggedRef={wasDraggedRef} /></div>
        </div>
      </Frame>
      </Cell>
      {!onMore && <CardMenu anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} item={item} onRemove={onRemove} onOpenDetails={onOpenDetails} />}
    </>
  );
});

/** The latest title, as wide as the section: the same shape as Now Playing's first banner. */
export const ContinueLeadBanner = memo(function ContinueLeadBanner({ item, wasDraggedRef, onRemove, onOpenDetails, self, onMore }: CardProps) {
  const plain = useCardBackground().bg === 'plain';
  const parts = useUnderParts();
  const { url: art, onError } = useCardArt(item, plain);
  const { open, setOpen, anchorRef, justOpened, handlers } = useCardMenu(wasDraggedRef, onMore ? (a) => onMore(item, a) : undefined);
  const onPicture = !plain;
  const ep = episodeLong(item);
  const extra = 'Pick up where you left off';
  return (
    <>
      <Cell under={parts.any ? <UnderParts item={item} parts={parts} extra={extra} self={self} /> : null}>
      <Frame item={item} handlers={handlers} ignoreClick={() => justOpened() || open} wasDraggedRef={wasDraggedRef} onActivate={() => (onOpenDetails ? onOpenDetails(item) : setOpen(true))}
        className={`rounded-[20px] flex flex-col min-h-[230px] sm:min-h-[250px] ${parts.any ? 'flex-1' : ''}`}
        style={{ background: plain ? 'var(--color-surface-elevated, var(--color-surface))' : 'var(--color-surface)' }}>
        {onPicture && art && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cachedImageUrl(art, 780) || art} onError={onError} alt="" draggable={false} loading="eager" decoding="async" className="art-fill absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ objectPosition: 'right center', ['--art-r' as string]: '20px' }} />
        )}
        {onPicture && <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(90deg, rgba(10,12,20,.96) 0%, rgba(10,12,20,.85) 45%, rgba(10,12,20,.15) 100%)' }} />}
        {plain && art && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cachedImageUrl(art, 342) || art} onError={onError} alt="" draggable={false} decoding="async"
            className="absolute right-3.5 top-14 w-[60px] h-[90px] sm:right-16 sm:top-1/2 sm:-translate-y-1/2 sm:w-[130px] sm:h-[195px] rounded-lg object-cover pointer-events-none"
            style={{ boxShadow: '0 2px 8px rgba(0,0,0,.35)' }} />
        )}
        <MoreButton anchorRef={anchorRef} open={open} onToggle={() => setOpen(!open)} label={item.showName} onPicture={onPicture} />
        <div className={`relative flex-1 flex flex-col justify-end gap-1.5 p-[18px] sm:p-[26px] max-w-full sm:max-w-[60%] ${plain ? 'pr-[92px] sm:pr-[26px]' : ''}`}>
          {!parts.who && <Who item={item} extra={extra} onPicture={onPicture} self={self} />}
          <h4 className="text-2xl sm:text-[30px] font-bold leading-tight break-words" style={{ color: onPicture ? '#fff' : 'var(--color-text)' }}>{item.showName}</h4>
          {ep && !parts.time && <p className="text-sm break-words" style={{ color: onPicture ? '#d1d5db' : 'var(--color-text-muted)' }}>{ep}</p>}
          {!parts.progress && <ProgressBar item={item} onPicture={onPicture} />}
          {!parts.progress && <p className="text-[12.5px] break-words" style={{ color: onPicture ? '#e5e7eb' : 'var(--color-text-muted)' }}>{stoppedLine(item)}</p>}
          <div className="mt-1.5"><PlayButton item={item} wasDraggedRef={wasDraggedRef} big /></div>
        </div>
      </Frame>
      </Cell>
      {!onMore && <CardMenu anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} item={item} onRemove={onRemove} onOpenDetails={onOpenDetails} />}
    </>
  );
});
