'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { StarIcon, ClockIcon, FilmIcon, PlayIcon, XMarkIcon, BookmarkIcon as BookmarkSolidIcon } from '@heroicons/react/24/solid';
import { BookmarkIcon as BookmarkOutlineIcon } from '@heroicons/react/24/outline';
import { Modal } from './Modal';
import { Badge } from './Badge';
import { metacriticColor as metacriticTextColor } from './RatingBadges';
import { api, MediaDetails } from '@/lib/api';
import { buildStremioAppUrl, buildNuvioAppUrl } from '@/lib/appLinks';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';

interface MediaDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  itemId: string;
  itemType: 'movie' | 'series';
  videoId?: string | null;
  fallbackTitle: string;
  fallbackPoster?: string | null;
  // Rating/year OVERRIDES — not just fallbacks for when details is missing
  // them. Cinemeta runs two separate backends that can genuinely disagree
  // on the same title (confirmed real example: Americana showed 2023/★5.9
  // in the Discover grid, sourced from v3-cinemeta.strem.io's catalog, but
  // 2025/★6.0 in this modal, sourced from cinemeta-live.strem.io's per-item
  // lookup — same IMDb id, two different answers). Rather than silently
  // overwrite the number a user just saw in the grid with the OTHER
  // backend's answer for the same field, callers that already know the
  // grid's numbers (Discover, Recommendations, Watchlist) pass them here
  // and they win over `details`. Cast/genres/runtime/trailer still only
  // exist on the detail lookup, so those are unaffected either way.
  fallbackRating?: string | null;
  fallbackReleaseInfo?: string | null;
  // Fires after the modal's own watchlist toggle succeeds (or fails and
  // reverts), so a caller with its own watchlist list/grid — Discover, in
  // practice — can stay in sync. Without this the modal's add/remove was a
  // dead end: it really did persist to the account's watchlist, but nothing
  // told the page that opened the modal, so its poster-card badges and its
  // Watchlist tab (both reading from the page's own already-fetched list,
  // not a fresh request) kept showing the old state until a full reload.
  onWatchlistChange?: (itemId: string, inWatchlist: boolean) => void;
}

export function MediaDetailModal({
  isOpen,
  onClose,
  itemId,
  itemType,
  videoId,
  fallbackTitle,
  fallbackPoster,
  fallbackRating,
  fallbackReleaseInfo,
  onWatchlistChange,
}: MediaDetailModalProps) {
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);

  const { enableWatchlist } = usePersonalFeatures();
  const isTV = useIsTV();

  // TV mode: the action row (Watchlist / Open in Stremio / Open in Nuvio)
  // is its own focus group so D-pad left/right moves between them, and
  // gets focus automatically the moment details finish loading - this is
  // the actual payoff moment ("read it, watch the trailer, pick an app")
  // the TV app exists for, so it shouldn't require hunting for it with the
  // remote first.
  const { ref: actionsRef, focusKey: actionsFocusKey, focusSelf: focusActions } = useFocusable<object, HTMLDivElement>({ trackChildren: true });
  useEffect(() => {
    if (!isTV || !isOpen || !details) return;
    const id = setTimeout(() => focusActions(), 50);
    return () => clearTimeout(id);
  }, [isTV, isOpen, details, focusActions]);

  // Watchlist state — optimistic-toggle so the icon flips instantly on click
  // and the request happens in the background. Reset on itemId change so the
  // modal doesn't carry the previous title's state when reopened. Skipped
  // entirely when the Watchlist personal feature is disabled.
  const [inWatchlist, setInWatchlist] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  useEffect(() => {
    if (!isOpen || !itemId || !enableWatchlist) return;
    // Ask the watchlist for our current status. Cheap round-trip since we
    // only care about one id — the batched watched-status endpoint isn't
    // needed here.
    let cancelled = false;
    api.getWatchlist().then((list) => {
      if (cancelled) return;
      setInWatchlist(list.some((i) => i.itemId === itemId));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, itemId, enableWatchlist]);
  const toggleWatchlist = async () => {
    if (watchlistBusy) return;
    setWatchlistBusy(true);
    const next = !inWatchlist;
    setInWatchlist(next); // optimistic
    onWatchlistChange?.(itemId, next);
    try {
      if (next) {
        await api.addToWatchlist({
          itemId,
          itemType,
          name: details?.title || fallbackTitle,
          poster: details?.poster || fallbackPoster || null,
        });
      } else {
        await api.removeFromWatchlist(itemId);
      }
    } catch {
      setInWatchlist(!next); // revert on failure
      onWatchlistChange?.(itemId, !next);
    } finally {
      setWatchlistBusy(false);
    }
  };

  // Mouse-only grab-and-drag horizontal scrolling for the Cast row, matching
  // the Dashboard's Continue Watching row. Pointer capture is deliberately
  // deferred until an actual drag crosses the 5px threshold, not engaged on
  // every mouse-down - Continue Watching's fix (see page.tsx) found that
  // capturing eagerly on a plain click blocks Firefox's external-protocol
  // handoff for nuvio://\stremio:// links elsewhere in this same modal, and
  // there's no reason for this row to behave differently just because it
  // has no links of its own. Touch/pen are left alone - overflow-x-auto's
  // native scroll already handles those, and capturing every pointer type
  // fights the page's own vertical touch scroll.
  const castRowRef = useRef<HTMLDivElement>(null);
  const isCastPointerDownRef = useRef(false);
  const castDragStartXRef = useRef(0);
  const castDragStartScrollLeftRef = useRef(0);
  const hasCapturedCastPointerRef = useRef(false);

  const handleCastPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !castRowRef.current) return;
    isCastPointerDownRef.current = true;
    hasCapturedCastPointerRef.current = false;
    castDragStartXRef.current = e.clientX;
    castDragStartScrollLeftRef.current = castRowRef.current.scrollLeft;
  }, []);

  const handleCastPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !isCastPointerDownRef.current || !castRowRef.current) return;
    // Same recovery as Continue Watching's row (see page.tsx): capture is
    // deferred until the drag threshold, so a release before that point (e.g.
    // mostly-vertical movement off the row) never reaches handleCastPointerUp.
    // Catch it here via e.buttons instead of letting a later hover compute
    // scrollLeft from a stale drag-start.
    if ((e.buttons & 1) === 0) {
      isCastPointerDownRef.current = false;
      return;
    }
    const dx = e.clientX - castDragStartXRef.current;
    if (Math.abs(dx) > 5 && !hasCapturedCastPointerRef.current) {
      castRowRef.current.setPointerCapture(e.pointerId);
      hasCapturedCastPointerRef.current = true;
    }
    castRowRef.current.scrollLeft = castDragStartScrollLeftRef.current - dx;
  }, []);

  const handleCastPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    isCastPointerDownRef.current = false;
    if (hasCapturedCastPointerRef.current) {
      castRowRef.current?.releasePointerCapture(e.pointerId);
      hasCapturedCastPointerRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    // Reset per-item, since the same modal instance is reused across clicks
    setDetails(null);
    setHasFetched(false);
    setIsLoading(true);
    setIsTrailerPlaying(false);

    let cancelled = false;
    api.getMediaDetails(itemId, itemType, videoId).then((result) => {
      if (cancelled) return;
      setDetails(result);
      setIsLoading(false);
      setHasFetched(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, itemId, itemType, videoId]);

  const title = details?.episode?.title
    ? `${details?.title || fallbackTitle} — ${details.episode.title}`
    : (details?.title || fallbackTitle);
  const heroImage = details?.episode?.thumbnail || details?.background || details?.poster || fallbackPoster;
  const overview = details?.episode?.overview || details?.description;
  const trailerId = details?.trailers?.[0];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" hideCloseButton={isTrailerPlaying}>
      <div className="-mx-6 -mt-6">
        {isTrailerPlaying && trailerId ? (
          // aspect-video (not a fixed height like the static hero below) -
          // YouTube's player always keeps its actual video content at 16:9
          // internally, so a fixed short height on a wide modal (size="full")
          // squished the container into a much wider-than-16:9 box and the
          // player letterboxed down to a thin strip in the middle of it.
          // Deriving height from width keeps the video itself full-size.
          <div className="relative w-full aspect-video max-h-[60vh] overflow-hidden rounded-t-2xl bg-black">
            <iframe
              src={`https://www.youtube.com/embed/${trailerId}?autoplay=1`}
              title="Trailer"
              className="w-full h-full"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
            {/* Fades the video's bottom edge into the surface color below,
                matching the static hero's gradient - a hard cut from a black
                video box straight into the text content looked disjointed. */}
            <div
              className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
              style={{ background: 'linear-gradient(180deg, transparent, var(--color-surface))' }}
            />
            {/* Positioned low and to the right, clear of YouTube's own
                top-right controls (volume/CC/settings) - roughly level with
                YouTube's own bottom-row icons (share/save), past the right
                edge of its scrub bar. YouTube's own overlay isn't something
                we control, so this is an approximation, not a guarantee.
                Goes back to the poster/details view, not a full close -
                backdrop click and Escape still fully close the modal. */}
            <button
              type="button"
              onClick={() => setIsTrailerPlaying(false)}
              className="absolute bottom-9 right-2 z-10 p-1 rounded-md transition-colors"
              style={{ color: 'white', background: 'rgba(0,0,0,0.6)' }}
              aria-label="Back to details"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
        ) : heroImage && (
          <div className="relative w-full h-40 sm:h-56 overflow-hidden rounded-t-2xl">
            <img
              src={heroImage}
              alt=""
              decoding="async"
              className="w-full h-full object-cover"
              style={{ objectPosition: 'center 15%' }}
            />
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(180deg, transparent 40%, var(--color-surface) 100%)' }}
            />
            {trailerId && (
              <button
                type="button"
                onClick={() => setIsTrailerPlaying(true)}
                className="absolute inset-0 flex items-center justify-center group"
                aria-label="Play trailer"
              >
                <span
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full font-medium text-sm transition-transform group-hover:scale-105"
                  style={{ background: 'color-mix(in srgb, var(--color-surface) 60%, transparent)', color: 'white', backdropFilter: 'blur(4px)' }}
                >
                  <PlayIcon className="w-5 h-5" />
                  Play Trailer
                </span>
              </button>
            )}
          </div>
        )}

        <div className="px-6 pb-2 pt-4">
          <h2 className="text-2xl font-bold font-display text-default">{title}</h2>

          {isLoading && (
            <div className="flex items-center gap-2 mt-4 text-base text-muted">
              <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Loading details…
            </div>
          )}

          {!isLoading && hasFetched && !details && (
            <p className="mt-4 text-base text-muted">
              No additional details found for this title.
            </p>
          )}

          {!isLoading && details && (
            <div className="mt-3 space-y-4">
              {/* releaseInfo/imdbRating prefer the grid's own values (see the
                  fallbackRating/fallbackReleaseInfo prop comment) — Cinemeta's
                  two backends can disagree, and showing a different number
                  than what the user just clicked reads as a bug. */}
              <div className="flex flex-wrap items-center gap-3 text-base text-muted">
                {(fallbackReleaseInfo || details.releaseInfo) && <span>{fallbackReleaseInfo || details.releaseInfo}</span>}
                {details.runtime && (
                  <span className="flex items-center gap-1.5">
                    <ClockIcon className="w-5 h-5" />
                    {details.runtime}
                  </span>
                )}
                {(fallbackRating || details.imdbRating) && (
                  <span className="flex items-center gap-1.5 text-amber-400 font-medium">
                    <StarIcon className="w-5 h-5" />
                    {fallbackRating || details.imdbRating}
                    <span className="text-muted font-normal">/10</span>
                  </span>
                )}
                {details.rottenTomatoes && (
                  <span className="flex items-center gap-1.5 font-medium" style={{ color: '#fa320a' }} title="Rotten Tomatoes">
                    <span aria-hidden>🍅</span>
                    {details.rottenTomatoes}
                  </span>
                )}
                {details.metacritic && (
                  <span className="flex items-center gap-1.5 font-medium" style={{ color: metacriticTextColor(details.metacritic) }} title="Metacritic score">
                    <span aria-hidden>Ⓜ</span>
                    {details.metacritic}
                  </span>
                )}
                {details.imdb_id && (
                  <a
                    href={`https://www.imdb.com/title/${details.imdb_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    IMDb
                  </a>
                )}
                {details.moviedb_id && (
                  <a
                    href={`https://www.themoviedb.org/${itemType === 'movie' ? 'movie' : 'tv'}/${details.moviedb_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    TMDb
                  </a>
                )}
              </div>

              {/* Neither link can "detect and fall back" if the target app
                  isn't installed/registered - a plain native <a href>, same
                  as Continue Watching's card, since JS-driven interception
                  of this exact kind of click has broken it before. Offered
                  as two plain options rather than picking one, since this
                  modal isn't tied to a specific managed user/provider the
                  way Continue Watching is. */}
              {/* Same fixed, theme-independent colors as each provider's
                  identity Badge elsewhere (Users page, next to "Synced") -
                  purple for Stremio, blue/orange for Nuvio - rather than the
                  generic accent color, so these read as "this specific
                  provider" the same way the badges already do. */}
              {details.imdb_id && (() => {
                const watchlistBtn = enableWatchlist && (
                  <button
                    type="button"
                    onClick={toggleWatchlist}
                    disabled={watchlistBusy}
                    aria-label={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    title={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      inWatchlist
                        ? 'bg-primary text-white'
                        : 'bg-surface-hover text-default hover:bg-primary/20 hover:text-primary'
                    } ${watchlistBusy ? 'opacity-60 cursor-wait' : ''}`}
                  >
                    {inWatchlist
                      ? <BookmarkSolidIcon className="w-4 h-4" />
                      : <BookmarkOutlineIcon className="w-4 h-4" />}
                    {inWatchlist ? 'In Watchlist' : 'Add to Watchlist'}
                  </button>
                );
                const stremioBtn = (
                  <a
                    href={buildStremioAppUrl(details.imdb_id, itemType)}
                    tabIndex={isTV ? -1 : undefined}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={{
                      background: 'rgba(167, 139, 250, 0.15)',
                      color: 'rgb(196, 181, 253)',
                      border: '1px solid rgba(167, 139, 250, 0.25)',
                    }}
                  >
                    <PlayIcon className="w-4 h-4" />
                    Open in Stremio
                  </a>
                );
                const nuvioBtn = (
                  <a
                    href={buildNuvioAppUrl(details.imdb_id, itemType)}
                    tabIndex={isTV ? -1 : undefined}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={{
                      // Blue/orange Nuvio identity split by a `/` diagonal
                      // (see Badge.tsx's 'nuvio' variant for the same treatment).
                      background: 'linear-gradient(115deg, rgba(56, 89, 158, 0.22) 0%, rgba(56, 89, 158, 0.22) 50%, rgba(255, 152, 0, 0.10) 50%, rgba(255, 152, 0, 0.10) 100%)',
                      color: 'rgb(186, 208, 240)',
                      border: '1px solid rgba(255, 152, 0, 0.18)',
                    }}
                  >
                    <PlayIcon className="w-4 h-4" />
                    Open in Nuvio
                  </a>
                );

                // TV mode: Norigin owns keyboard focus/activation itself
                // (it doesn't ride native DOM Tab order or native Enter-on-
                // link behavior) - so each control needs an explicit
                // onEnterPress that does what the click/native nav would
                // have done. tabIndex={-1} above keeps a stray native Tab
                // press from also landing on the underlying <a> and
                // double-handling the same keystroke.
                if (isTV) {
                  return (
                    <FocusContext.Provider value={actionsFocusKey}>
                      <div ref={actionsRef} className="flex flex-wrap gap-2 items-center">
                        {enableWatchlist && (
                          <TVFocusable onEnterPress={toggleWatchlist}>{watchlistBtn}</TVFocusable>
                        )}
                        <TVFocusable onEnterPress={() => { window.location.href = buildStremioAppUrl(details.imdb_id!, itemType); }}>
                          {stremioBtn}
                        </TVFocusable>
                        <TVFocusable onEnterPress={() => { window.location.href = buildNuvioAppUrl(details.imdb_id!, itemType); }}>
                          {nuvioBtn}
                        </TVFocusable>
                      </div>
                    </FocusContext.Provider>
                  );
                }

                return (
                  <div className="flex flex-wrap gap-2 items-center">
                    {watchlistBtn}
                    {stremioBtn}
                    {nuvioBtn}
                  </div>
                );
              })()}

              {details.genres && details.genres.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {details.genres.map((genre) => (
                    <Badge key={genre} variant="default" size="md">{genre}</Badge>
                  ))}
                </div>
              )}

              {overview && (
                <p className="text-base leading-relaxed text-default">{overview}</p>
              )}

              {details.director && details.director.length > 0 && (
                <p className="text-base">
                  <span className="text-muted">Director: </span>
                  <span className="text-default">{details.director.join(', ')}</span>
                </p>
              )}

              {details.cast && details.cast.length > 0 && (
                <div>
                  <p className="text-base text-muted mb-2">Cast</p>
                  <div
                    ref={castRowRef}
                    onPointerDown={handleCastPointerDown}
                    onPointerMove={handleCastPointerMove}
                    onPointerUp={handleCastPointerUp}
                    className="flex gap-4 overflow-x-auto pb-1 pr-6 no-scrollbar cursor-grab active:cursor-grabbing select-none"
                  >
                    {details.cast.slice(0, 10).map((member) => (
                      <div key={member.name} className="shrink-0 w-24 text-center">
                        {member.photo ? (
                          <img
                            src={member.photo}
                            alt={member.name}
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                            onDragStart={(e) => e.preventDefault()}
                            className="w-20 h-20 rounded-full object-cover mx-auto bg-surface-hover pointer-events-none"
                          />
                        ) : (
                          <div className="w-20 h-20 rounded-full mx-auto bg-surface-hover flex items-center justify-center text-muted text-xl font-medium">
                            {member.name.charAt(0)}
                          </div>
                        )}
                        <p
                          className="mt-2 text-sm font-medium text-default leading-tight"
                          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                          title={member.name}
                        >
                          {member.name}
                        </p>
                        {member.character && (
                          <p
                            className="text-xs text-subtle leading-tight"
                            style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                            title={member.character}
                          >
                            {member.character}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {details.awards && (
                <p className="text-sm text-muted flex items-start gap-1.5">
                  <FilmIcon className="w-5 h-5 shrink-0 mt-0.5" />
                  {details.awards}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
