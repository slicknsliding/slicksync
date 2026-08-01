'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { StarIcon, ClockIcon, FilmIcon, PlayIcon, XMarkIcon, BookmarkIcon as BookmarkSolidIcon } from '@heroicons/react/24/solid';
import { BookmarkIcon as BookmarkOutlineIcon, ChevronLeftIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { Modal } from './Modal';
import { Badge } from './Badge';
import { AddToListButton } from './AddToListButton';
import { metacriticColor as metacriticTextColor } from './RatingBadges';
import { api, MediaDetails, DiscoverItem } from '@/lib/api';
import { buildStremioAppUrl, buildNuvioAppUrl } from '@/lib/appLinks';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl } from '@/lib/posterUrl';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useDragScroll } from '@/lib/hooks/useDragScroll';
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
  // Same "grid already knows, don't wait on / overwrite it" reasoning as
  // fallbackRating above, but for OMDb's Rotten Tomatoes/Metacritic scores.
  // The modal's own detail lookup (Cinemeta) never returns these at all, so
  // without a caller-supplied value the row falls back to the bare IMDb
  // number even when the caller already fetched a fuller RatingBadges-style
  // batch (Discover's useRatingsBatch) for the same item.
  fallbackRottenTomatoes?: string | null;
  fallbackMetacritic?: string | null;
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
  fallbackRottenTomatoes,
  fallbackMetacritic,
  onWatchlistChange,
}: MediaDetailModalProps) {
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);
  // Set exactly once per play session (auto-trigger or manual click) and
  // never recomputed afterward - critically, NOT derived reactively from
  // mute state. Confirmed real bug: unmuting via fullscreen used to update a
  // `trailerMuted` state that the iframe's `src` read from, so React changed
  // the iframe's src attribute, the browser reloaded the iframe's document
  // to apply it, and that reload forcibly killed fullscreen and restarted
  // the video right back at the embedded (non-fullscreen) view. All
  // muting/unmuting after the iframe exists must go through the YouTube
  // Player API (trailerPlayerRef below) instead, never by changing src.
  const [trailerSrc, setTrailerSrc] = useState<string | null>(null);
  // Real YouTube IFrame Player API controller, attached to the trailer
  // iframe once it's playing - needed to call unMute() on fullscreen (see
  // the effect near trailerId below for why a raw <iframe src> alone can't
  // do this).
  const trailerIframeRef = useRef<HTMLIFrameElement>(null);
  const trailerPlayerRef = useRef<any>(null);

  const buildTrailerSrc = useCallback((id: string, muted: boolean) => {
    const origin = typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';
    return `https://www.youtube.com/embed/${id}?autoplay=1${muted ? '&mute=1' : ''}&enablejsapi=1&origin=${origin}`;
  }, []);

  // "More Like This" drill-down - clicking a related poster swaps the
  // modal's effective item in place instead of closing and asking whatever
  // opened this modal (5 different callers: Dashboard, Discover, Activity,
  // Settings, UpcomingEpisodesPanel) to manage a second item. Self-contained
  // here so none of them need changes. null = showing the item the caller
  // actually opened; set = drilled into a related title. Reset whenever the
  // EXTERNAL itemId changes (see the effect below) so reopening the modal
  // for a different poster doesn't carry over a stale drill-down.
  const [overrideItem, setOverrideItem] = useState<{
    id: string;
    type: 'movie' | 'series';
    name: string;
    poster: string | null;
    imdbRating?: string | null;
    releaseInfo?: string | null;
  } | null>(null);
  // Cast/crew deep-dive: when a cast member with a TMDb id is clicked, load
  // their filmography into this panel (optional feature - see discover.js's
  // /person route; null credits + unavailable=true means no TMDb key is set,
  // which the render below treats as "feature off" rather than an error).
  const [personView, setPersonView] = useState<null | {
    id: number | string;
    name: string;
    loading: boolean;
    credits: Array<{ tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: string | null; poster: string | null; role: string | null }>;
    unavailable?: boolean;
  }>(null);

  const openPerson = useCallback(async (member: { name: string; tmdbId?: number | string | null }) => {
    if (member.tmdbId == null || member.tmdbId === '') return;
    setPersonView({ id: member.tmdbId, name: member.name, loading: true, credits: [] });
    const res = await api.getPersonCredits(member.tmdbId);
    if (!res) {
      setPersonView({ id: member.tmdbId, name: member.name, loading: false, credits: [], unavailable: true });
      return;
    }
    setPersonView({ id: member.tmdbId, name: res.person?.name || member.name, loading: false, credits: res.credits });
  }, []);

  // Mouse grab-drag for the person-filmography row (touch/trackpad scroll it
  // natively already; this adds the desktop drag affordance it was missing).
  const creditsDrag = useDragScroll();

  const openCredit = useCallback(async (credit: { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; poster: string | null }) => {
    // Suppress the click that ends a drag-scroll (otherwise dragging the row
    // and releasing over a poster would also navigate).
    if (creditsDrag.isDragging()) return;
    const res = await api.resolveImdbId(credit.tmdbId, credit.mediaType);
    if (res?.imdbId) {
      setOverrideItem({ id: res.imdbId, type: res.type, name: credit.title, poster: credit.poster });
      setPersonView(null);
    }
  }, [creditsDrag]);

  useEffect(() => {
    if (!isOpen) return;
    setOverrideItem(null);
    setPersonView(null);
  }, [isOpen, itemId, itemType, videoId]);
  const effectiveId = overrideItem?.id ?? itemId;
  const effectiveType = overrideItem?.type ?? itemType;
  const effectiveVideoId = overrideItem ? null : videoId;
  const effectiveFallbackTitle = overrideItem?.name ?? fallbackTitle;
  const effectiveFallbackPoster = overrideItem?.poster ?? fallbackPoster;
  const effectiveFallbackRating = overrideItem ? (overrideItem.imdbRating ?? null) : fallbackRating;
  const effectiveFallbackReleaseInfo = overrideItem ? (overrideItem.releaseInfo ?? null) : fallbackReleaseInfo;
  // Drill-down (cast credit) items never carry a Rotten Tomatoes/Metacritic
  // fallback of their own - details.rottenTomatoes/metacritic (if OMDb ever
  // starts returning them there) is all a drilled-into item can show.
  const effectiveFallbackRottenTomatoes = overrideItem ? null : fallbackRottenTomatoes;
  const effectiveFallbackMetacritic = overrideItem ? null : fallbackMetacritic;

  const { enableWatchlist, rpdbEnabled, enableAutoplayTrailer, autoplayTrailerStartMuted } = usePersonalFeatures();
  const isTV = useIsTV();

  // usePersonalFeatures resolves asynchronously (starts from a default of
  // true, then updates once the real Settings value loads) - the
  // item-fetch effect below isn't keyed on these values (that would
  // needlessly re-fetch/reset an already-playing trailer whenever a
  // background settings refresh resolves), so it reads these refs instead
  // of closing over the hook values directly. Otherwise, if getMediaDetails
  // resolves before usePersonalFeatures does, the autoplay decision would
  // fire using the stale default and never get re-checked - a real,
  // confirmed case of the autoplay setting appearing to be ignored.
  const enableAutoplayTrailerRef = useRef(enableAutoplayTrailer);
  const autoplayTrailerStartMutedRef = useRef(autoplayTrailerStartMuted);
  useEffect(() => { enableAutoplayTrailerRef.current = enableAutoplayTrailer; }, [enableAutoplayTrailer]);
  useEffect(() => { autoplayTrailerStartMutedRef.current = autoplayTrailerStartMuted; }, [autoplayTrailerStartMuted]);

  // TV mode: the whole modal body (trailer button, Watchlist / Open in
  // Stremio / Open in Nuvio) is one focus group, so D-pad up/down/left/
  // right moves naturally between them by actual on-screen position - this
  // is the actual payoff moment ("read it, watch the trailer, pick an
  // app") the TV app exists for, so it shouldn't require hunting for it
  // with the remote first. Retries on a backoff for the same reason
  // TVPageProvider does - details load asynchronously, so a single
  // fixed-delay focusSelf() could fire before any button exists yet.
  const { ref: modalRef, focusKey: modalFocusKey, focusSelf: focusModal, hasFocusedChild } = useFocusable<object, HTMLDivElement>({ trackChildren: true });
  const hasFocusedChildRef = useRef(false);
  useEffect(() => {
    hasFocusedChildRef.current = hasFocusedChild;
  }, [hasFocusedChild]);
  useEffect(() => {
    if (!isTV || !isOpen || !details) return;
    const delays = [50, 200, 500, 1000];
    const timers = delays.map((delay) => setTimeout(() => {
      if (!hasFocusedChildRef.current) focusModal();
    }, delay));
    return () => timers.forEach(clearTimeout);
  }, [isTV, isOpen, details, focusModal]);

  // Watchlist state — optimistic-toggle so the icon flips instantly on click
  // and the request happens in the background. Reset on effectiveId change
  // (not just itemId) so drilling into a related title via "More Like This"
  // re-checks watchlist status for THAT title, not the originally-opened
  // one. Skipped entirely when the Watchlist personal feature is disabled.
  const [inWatchlist, setInWatchlist] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  useEffect(() => {
    if (!isOpen || !effectiveId || !enableWatchlist) return;
    // Ask the watchlist for our current status. Cheap round-trip since we
    // only care about one id — the batched watched-status endpoint isn't
    // needed here.
    let cancelled = false;
    api.getWatchlist().then((list) => {
      if (cancelled) return;
      setInWatchlist(list.some((i) => i.itemId === effectiveId));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, effectiveId, enableWatchlist]);
  const toggleWatchlist = async () => {
    if (watchlistBusy) return;
    setWatchlistBusy(true);
    const next = !inWatchlist;
    setInWatchlist(next); // optimistic
    onWatchlistChange?.(effectiveId, next);
    try {
      if (next) {
        await api.addToWatchlist({
          itemId: effectiveId,
          itemType: effectiveType,
          name: details?.title || effectiveFallbackTitle,
          poster: details?.poster || effectiveFallbackPoster || null,
        });
      } else {
        await api.removeFromWatchlist(effectiveId);
      }
    } catch {
      setInWatchlist(!next); // revert on failure
      onWatchlistChange?.(effectiveId, !next);
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

  // Same mouse-drag-scroll treatment as the Cast row above, for the "More
  // Like This" poster row - separate refs since it's a different DOM node.
  const similarRowRef = useRef<HTMLDivElement>(null);
  const isSimilarPointerDownRef = useRef(false);
  const similarDragStartXRef = useRef(0);
  const similarDragStartScrollLeftRef = useRef(0);
  const hasCapturedSimilarPointerRef = useRef(false);

  const handleSimilarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !similarRowRef.current) return;
    isSimilarPointerDownRef.current = true;
    hasCapturedSimilarPointerRef.current = false;
    similarDragStartXRef.current = e.clientX;
    similarDragStartScrollLeftRef.current = similarRowRef.current.scrollLeft;
  }, []);

  const handleSimilarPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !isSimilarPointerDownRef.current || !similarRowRef.current) return;
    if ((e.buttons & 1) === 0) {
      isSimilarPointerDownRef.current = false;
      return;
    }
    const dx = e.clientX - similarDragStartXRef.current;
    if (Math.abs(dx) > 5 && !hasCapturedSimilarPointerRef.current) {
      similarRowRef.current.setPointerCapture(e.pointerId);
      hasCapturedSimilarPointerRef.current = true;
    }
    similarRowRef.current.scrollLeft = similarDragStartScrollLeftRef.current - dx;
  }, []);

  const handleSimilarPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    isSimilarPointerDownRef.current = false;
    if (hasCapturedSimilarPointerRef.current) {
      similarRowRef.current?.releasePointerCapture(e.pointerId);
      hasCapturedSimilarPointerRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !effectiveId) return;
    // Reset per-item, since the same modal instance is reused across clicks
    // (and across "More Like This" drill-downs, via effectiveId/effectiveType)
    setDetails(null);
    setHasFetched(false);
    setIsLoading(true);
    setIsTrailerPlaying(false);
    setTrailerSrc(null);

    let cancelled = false;
    api.getMediaDetails(effectiveId, effectiveType, effectiveVideoId).then((result) => {
      if (cancelled) return;
      setDetails(result);
      setIsLoading(false);
      setHasFetched(true);
      // Auto-start the moment a trailer is actually available - no separate
      // "wait for it to load, then play" step needed since this runs right
      // where the trailer id first becomes known.
      const autoTrailerId = result?.trailers?.[0];
      if (enableAutoplayTrailerRef.current && autoTrailerId) {
        setTrailerSrc(buildTrailerSrc(autoTrailerId, autoplayTrailerStartMutedRef.current));
        setIsTrailerPlaying(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, effectiveId, effectiveType, effectiveVideoId]);

  // SlickTrax "More Like This" - always fresh, always unwatched by anyone
  // in the household (see the /similar route's own comment for why real
  // affinity only biases the genre search rather than supplying items
  // directly). Keyed on effectiveId so a "More Like This" click re-runs
  // this for the newly drilled-into title too, letting you chain through
  // related titles.
  const [similarItems, setSimilarItems] = useState<DiscoverItem[]>([]);
  const [similarHasRealSignal, setSimilarHasRealSignal] = useState(false);
  const [similarLoading, setSimilarLoading] = useState(false);
  // Collapsed by default - a full poster row made this the tallest thing in
  // the popup even for a title with no other details worth reading yet.
  // Data still loads eagerly in the background (cheap for this instance's
  // scale, see the route's own comment) so expanding is instant rather than
  // showing a spinner on click; only the disclosure's OPEN state is what's
  // deferred. Collapses again on every item change, including a "More Like
  // This" drill-down, so it never opens already-expanded on a fresh title.
  const [similarExpanded, setSimilarExpanded] = useState(false);
  useEffect(() => {
    setSimilarExpanded(false);
  }, [effectiveId]);
  useEffect(() => {
    if (!isOpen || !effectiveId) return;
    setSimilarItems([]);
    setSimilarLoading(true);
    let cancelled = false;
    api.getSimilarItems(effectiveId, effectiveType).then((result) => {
      if (cancelled) return;
      setSimilarItems(result.items);
      setSimilarHasRealSignal(result.hasRealSignal);
    }).finally(() => {
      if (!cancelled) setSimilarLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, effectiveId, effectiveType]);

  const title = details?.episode?.title
    ? `${details?.title || effectiveFallbackTitle} — ${details.episode.title}`
    : (details?.title || effectiveFallbackTitle);
  // The title above already shows the episode NAME ("Cape Fear — The Scar"),
  // but not which episode that is - parsed from videoId (standard Cinemeta
  // format "tt1234567:season:episode") since the episode metadata endpoint
  // itself doesn't return the numbers, only title/overview/thumbnail. Kitsu
  // IDs ("kitsu:50008:4") have no season component, so this only matches the
  // 3-part numeric form both formats happen to share positionally - safe
  // since a non-matching id just renders nothing rather than a wrong number.
  const episodeLabel = (() => {
    if (!effectiveVideoId || !details?.episode) return null;
    const parts = effectiveVideoId.split(':');
    if (parts.length !== 3) return null;
    const season = parseInt(parts[1], 10);
    const episode = parseInt(parts[2], 10);
    if (Number.isNaN(episode)) return null;
    return Number.isNaN(season) || effectiveVideoId.startsWith('kitsu:')
      ? `E${String(episode).padStart(2, '0')}`
      : `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  })();
  const heroImage = details?.episode?.thumbnail || details?.backdrop || details?.background || details?.poster || effectiveFallbackPoster;
  const overview = details?.episode?.overview || details?.description;
  const trailerId = details?.trailers?.[0];

  // Attaches the real YouTube IFrame Player API to the trailer iframe once
  // it's playing, purely so fullscreen can unmute it - going fullscreen via
  // the player's own button does NOT unmute a muted embed on its own (a raw
  // <iframe src> has no way to detect fullscreen or call unMute() at all).
  // Requires enablejsapi=1 in the iframe's src (see the src below) for the
  // API to actually take control of an already-existing iframe.
  useEffect(() => {
    if (!isTrailerPlaying || !trailerId) return;
    let cancelled = false;

    function attach() {
      if (cancelled || !trailerIframeRef.current) return;
      try {
        trailerPlayerRef.current = new (window as any).YT.Player(trailerIframeRef.current, {});
      } catch {}
    }

    if ((window as any).YT && (window as any).YT.Player) {
      attach();
    } else {
      if (!document.getElementById('youtube-iframe-api')) {
        const tag = document.createElement('script');
        tag.id = 'youtube-iframe-api';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.body.appendChild(tag);
      }
      const previous = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        previous?.();
        attach();
      };
    }

    const handleFullscreenChange = () => {
      if (document.fullscreenElement && document.fullscreenElement === trailerIframeRef.current) {
        // Only the real player API call here - never touch trailerSrc/React
        // state in response to this. Changing the iframe's src is what
        // forced a reload that killed fullscreen in the first place (see
        // trailerSrc's own comment above).
        try { trailerPlayerRef.current?.unMute?.(); } catch {}
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      cancelled = true;
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      trailerPlayerRef.current = null;
    };
  }, [isTrailerPlaying, trailerId]);

  // TV mode: one focus group for the whole modal body, so D-pad navigation
  // moves between the trailer button and the action row by actual on-
  // screen position instead of needing separate scopes stitched together.
  const TVScope = isTV ? FocusContext.Provider : Fragment;
  const tvScopeProps = isTV ? { value: modalFocusKey } : {};

  // Stop the trailer THE INSTANT a close is triggered (X/backdrop/Escape all
  // route through Modal's onClose uniformly), not just when reopening for a
  // new item. Otherwise the YouTube iframe stays live and keeps decoding
  // video for the whole ~150ms exit transition, competing with the panel's
  // own transform/opacity animation for the same compositor - a real,
  // reported cause of the modal feeling like it lags on close specifically
  // after watching a trailer.
  const handleClose = useCallback(() => {
    setIsTrailerPlaying(false);
    setTrailerSrc(null);
    onClose();
  }, [onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="full" hideCloseButton={isTrailerPlaying} backdropImage={!isTrailerPlaying ? (heroImage || undefined) : undefined}>
      <TVScope {...(tvScopeProps as any)}>
      <div className="-mx-6 -mt-6" ref={isTV ? modalRef : undefined}>
        {isTrailerPlaying && trailerId && trailerSrc ? (
          // aspect-video (not a fixed height like the static hero below) -
          // YouTube's player always keeps its actual video content at 16:9
          // internally, so a fixed short height on a wide modal (size="full")
          // squished the container into a much wider-than-16:9 box and the
          // player letterboxed down to a thin strip in the middle of it.
          // Deriving height from width keeps the video itself full-size.
          <div className="relative w-full aspect-video max-h-[60vh] overflow-hidden rounded-t-2xl bg-black">
            <iframe
              ref={trailerIframeRef}
              src={trailerSrc}
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
            {trailerId && (isTV ? (
              <TVFocusable onEnterPress={() => { setTrailerSrc(buildTrailerSrc(trailerId, false)); setIsTrailerPlaying(true); }} className="absolute inset-0 flex items-center justify-center">
                <span
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full font-medium text-sm"
                  style={{ background: 'color-mix(in srgb, var(--color-surface) 60%, transparent)', color: 'white', backdropFilter: 'blur(4px)' }}
                >
                  <PlayIcon className="w-5 h-5" />
                  Play Trailer
                </span>
              </TVFocusable>
            ) : (
              <button
                type="button"
                onClick={() => { setTrailerSrc(buildTrailerSrc(trailerId, false)); setIsTrailerPlaying(true); }}
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
            ))}
          </div>
        )}

        <div className="px-6 pb-2 pt-4">
          {/* Only shown mid drill-down (came here via a "More Like This"
              poster) - closing the modal from a related title would
              otherwise just lose the original one entirely, one click from
              a poster grid or not. */}
          {overrideItem && (isTV ? (
            <TVFocusable onEnterPress={() => setOverrideItem(null)} className="inline-block mb-2">
              <span className="flex items-center gap-1 text-sm font-medium text-muted">
                <ChevronLeftIcon className="w-4 h-4" />
                Back to {fallbackTitle}
              </span>
            </TVFocusable>
          ) : (
            <button
              type="button"
              onClick={() => setOverrideItem(null)}
              className="flex items-center gap-1 mb-2 text-sm font-medium text-muted hover:text-default transition-colors"
            >
              <ChevronLeftIcon className="w-4 h-4" />
              Back to {fallbackTitle}
            </button>
          ))}
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
                {episodeLabel && (
                  <span className="px-2 py-0.5 rounded-md text-sm font-semibold bg-surface-hover text-default border border-default">
                    {episodeLabel}
                  </span>
                )}
                {(effectiveFallbackReleaseInfo || details.releaseInfo) && <span>{effectiveFallbackReleaseInfo || details.releaseInfo}</span>}
                {details.runtime && (
                  <span className="flex items-center gap-1.5">
                    <ClockIcon className="w-5 h-5" />
                    {details.runtime}
                  </span>
                )}
                {(effectiveFallbackRating || details.imdbRating) && (
                  <span className="flex items-center gap-1.5 text-amber-400 font-medium">
                    <StarIcon className="w-5 h-5" />
                    {effectiveFallbackRating || details.imdbRating}
                    <span className="text-muted font-normal">/10</span>
                  </span>
                )}
                {(effectiveFallbackRottenTomatoes || details.rottenTomatoes) && (
                  <span className="flex items-center gap-1.5 font-medium" style={{ color: '#fa320a' }} title="Rotten Tomatoes">
                    <span aria-hidden>🍅</span>
                    {effectiveFallbackRottenTomatoes || details.rottenTomatoes}
                  </span>
                )}
                {(effectiveFallbackMetacritic || details.metacritic) && (
                  <span className="flex items-center gap-1.5 font-medium" style={{ color: metacriticTextColor(effectiveFallbackMetacritic || details.metacritic || '') }} title="Metacritic score">
                    <span aria-hidden>Ⓜ</span>
                    {effectiveFallbackMetacritic || details.metacritic}
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
                    href={`https://www.themoviedb.org/${effectiveType === 'movie' ? 'movie' : 'tv'}/${details.moviedb_id}`}
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
                    href={buildStremioAppUrl(details.imdb_id, effectiveType)}
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
                    href={buildNuvioAppUrl(details.imdb_id, effectiveType)}
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
                    <div className="flex flex-wrap gap-2 items-center">
                      {enableWatchlist && (
                        <TVFocusable onEnterPress={toggleWatchlist}>{watchlistBtn}</TVFocusable>
                      )}
                      <TVFocusable onEnterPress={() => { window.location.href = buildStremioAppUrl(details.imdb_id!, effectiveType); }}>
                        {stremioBtn}
                      </TVFocusable>
                      <TVFocusable onEnterPress={() => { window.location.href = buildNuvioAppUrl(details.imdb_id!, effectiveType); }}>
                        {nuvioBtn}
                      </TVFocusable>
                    </div>
                  );
                }

                return (
                  <div className="flex flex-wrap gap-2 items-center">
                    {watchlistBtn}
                    <AddToListButton item={{ id: effectiveId, type: effectiveType, name: effectiveFallbackTitle, poster: effectiveFallbackPoster || null }} />
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
                    {details.cast.slice(0, 10).map((member) => {
                      const clickable = member.tmdbId != null && member.tmdbId !== '';
                      return (
                      <button
                        key={member.name}
                        type="button"
                        // Only a real click (not a drag) fires - the cast row's
                        // drag-scroll only captures the pointer after 5px of
                        // movement, so a stationary click still reaches here.
                        onClick={() => { if (clickable) openPerson(member); }}
                        disabled={!clickable}
                        title={clickable ? `See ${member.name}'s other titles` : member.name}
                        className={`shrink-0 w-24 text-center ${clickable ? 'cursor-pointer group/cast' : 'cursor-default'}`}
                      >
                        {member.photo ? (
                          <img
                            src={member.photo}
                            alt={member.name}
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                            onDragStart={(e) => e.preventDefault()}
                            className={`w-20 h-20 rounded-full object-cover mx-auto bg-surface-hover pointer-events-none transition-transform ${clickable ? 'group-hover/cast:scale-105 group-hover/cast:ring-2 group-hover/cast:ring-primary' : ''}`}
                          />
                        ) : (
                          <div className="w-20 h-20 rounded-full mx-auto bg-surface-hover flex items-center justify-center text-muted text-xl font-medium">
                            {member.name.charAt(0)}
                          </div>
                        )}
                        <p
                          className={`mt-2 text-sm font-medium leading-tight ${clickable ? 'text-default group-hover/cast:text-primary transition-colors' : 'text-default'}`}
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
                      </button>
                      );
                    })}
                  </div>

                  {/* Filmography deep-dive for a clicked cast member. Inline
                      under the Cast row so it reads as an expansion of it, not
                      a context switch. Clicking a title resolves its IMDb id
                      and re-drives the whole modal to that title (setOverrideItem),
                      same navigation "More Like This" uses. */}
                  {personView && (
                    <div className="mt-4 rounded-xl border border-default bg-surface-hover/40 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-semibold text-default">
                          {personView.name}
                          <span className="text-muted font-normal"> — more titles</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => setPersonView(null)}
                          className="text-xs text-muted hover:text-default transition-colors"
                        >
                          Close
                        </button>
                      </div>
                      {personView.loading ? (
                        <p className="text-sm text-muted py-4 text-center">Loading filmography…</p>
                      ) : personView.unavailable ? (
                        <p className="text-xs text-subtle py-3">
                          Cast deep-dive needs a TMDb API key (Settings → add one, or set TMDB_API_KEY).
                        </p>
                      ) : personView.credits.length === 0 ? (
                        <p className="text-sm text-muted py-3">No other titles found.</p>
                      ) : (
                        <div
                          ref={creditsDrag.ref}
                          onPointerDown={creditsDrag.handlers.onPointerDown}
                          onPointerMove={creditsDrag.handlers.onPointerMove}
                          onPointerUp={creditsDrag.handlers.onPointerUp}
                          onPointerLeave={creditsDrag.handlers.onPointerLeave}
                          className="flex gap-3 overflow-x-auto pb-1 no-scrollbar cursor-grab active:cursor-grabbing select-none"
                        >
                          {personView.credits.map((c) => (
                            <button
                              key={`${c.mediaType}-${c.tmdbId}`}
                              type="button"
                              onClick={() => openCredit(c)}
                              title={`${c.title}${c.role ? ` · ${c.role}` : ''}`}
                              className="shrink-0 w-20 text-left group/cred"
                            >
                              <div className="aspect-[2/3] rounded-lg overflow-hidden bg-surface border border-default">
                                {c.poster ? (
                                  <img src={c.poster} alt={c.title} loading="lazy" decoding="async" draggable={false} className="w-full h-full object-cover transition-transform group-hover/cred:scale-105" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-muted text-xs p-1 text-center">{c.title}</div>
                                )}
                              </div>
                              <p className="mt-1 text-[11px] font-medium text-default leading-tight line-clamp-2 group-hover/cred:text-primary transition-colors">{c.title}</p>
                              {c.year && <p className="text-[10px] text-subtle">{c.year}</p>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {details.awards && (
                <p className="text-sm text-muted flex items-start gap-1.5">
                  <FilmIcon className="w-5 h-5 shrink-0 mt-0.5" />
                  {details.awards}
                </p>
              )}

              {/* SlickTrax "More Like This" - a disclosure, collapsed by
                  default, rather than an always-open poster row that made
                  this the tallest section in the whole popup regardless of
                  whether anyone wanted it. Hidden entirely once loaded if
                  the /similar route came back empty (a title Cinemeta has no
                  genre data for, on top of nobody in the household having
                  watched it) - no point showing a toggle for nothing.
                  hasRealSignal swaps the label - real household affinity is
                  a stronger, more specific claim than the generic
                  genre-backfill copy. */}
              {(similarLoading || similarItems.length > 0) && (
                <div>
                  {(() => {
                    const toggleLabel = (
                      <span className="flex items-center justify-between w-full py-1 text-base text-muted hover:text-default transition-colors">
                        <span className="flex items-center gap-2">
                          {similarHasRealSignal ? "Because you're into titles like this" : 'More Like This'}
                          {!similarLoading && (
                            <span className="text-xs text-subtle">({similarItems.length})</span>
                          )}
                        </span>
                        {similarLoading ? (
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <ChevronDownIcon className={`w-4 h-4 transition-transform ${similarExpanded ? 'rotate-180' : ''}`} />
                        )}
                      </span>
                    );
                    const onToggle = () => { if (!similarLoading) setSimilarExpanded((v) => !v); };
                    return isTV ? (
                      <TVFocusable onEnterPress={onToggle} className="block w-full">
                        {toggleLabel}
                      </TVFocusable>
                    ) : (
                      <button type="button" onClick={onToggle} disabled={similarLoading} className="block w-full">
                        {toggleLabel}
                      </button>
                    );
                  })()}
                  {similarExpanded && !similarLoading && (
                    <div
                      ref={similarRowRef}
                      onPointerDown={handleSimilarPointerDown}
                      onPointerMove={handleSimilarPointerMove}
                      onPointerUp={handleSimilarPointerUp}
                      className="flex gap-3 overflow-x-auto pb-1 pr-6 mt-2 no-scrollbar cursor-grab active:cursor-grabbing select-none"
                    >
                      {similarItems.map((item) => {
                        const goToItem = () => setOverrideItem({
                          id: item.id,
                          type: item.type,
                          name: item.name,
                          poster: item.poster,
                          imdbRating: item.imdbRating,
                          releaseInfo: item.releaseInfo,
                        });
                        const card = (
                          <button
                            type="button"
                            onClick={goToItem}
                            tabIndex={isTV ? -1 : undefined}
                            className="shrink-0 w-28 text-left group tap-card"
                          >
                            <div className="w-28 h-40 rounded-lg overflow-hidden bg-surface-hover">
                              {item.poster ? (
                                <img
                                  src={posterUrl(item, rpdbEnabled)}
                                  alt={item.name}
                                  loading="lazy"
                                  decoding="async"
                                  draggable={false}
                                  onDragStart={(e) => e.preventDefault()}
                                  className="w-full h-full object-cover pointer-events-none transition-transform group-hover:scale-105"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-muted">
                                  <FilmIcon className="w-8 h-8" />
                                </div>
                              )}
                            </div>
                            <p
                              className="mt-1.5 text-sm font-medium text-default leading-tight group-hover:text-primary transition-colors"
                              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                              title={item.name}
                            >
                              {item.name}
                            </p>
                          </button>
                        );
                        return isTV ? (
                          <TVFocusable key={item.id} onEnterPress={goToItem}>{card}</TVFocusable>
                        ) : (
                          <Fragment key={item.id}>{card}</Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      </TVScope>
    </Modal>
  );
}
