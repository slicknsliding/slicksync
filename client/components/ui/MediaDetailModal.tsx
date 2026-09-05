'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { StarIcon, ClockIcon, FilmIcon, PlayIcon, XMarkIcon, BookmarkIcon as BookmarkSolidIcon } from '@heroicons/react/24/solid';
import { BookmarkIcon as BookmarkOutlineIcon, ChevronLeftIcon, ChevronDownIcon, HandThumbUpIcon, HandThumbDownIcon, CheckCircleIcon, CheckIcon as CheckIconMini, BellIcon } from '@heroicons/react/24/outline';
import { Modal } from './Modal';
import { Badge } from './Badge';
import { AddToListButton } from './AddToListButton';
import { metacriticColor as metacriticTextColor } from './RatingBadges';
import { api, MediaDetails, DiscoverItem, SeriesSeason } from '@/lib/api';
import { toast } from './Toast';
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
    // Clicking the same cast member again closes the filmography row
    // instead of re-fetching the same data - reads as a toggle, same as
    // any other disclosure in this modal.
    if (personView && personView.id === member.tmdbId) {
      setPersonView(null);
      return;
    }
    setPersonView({ id: member.tmdbId, name: member.name, loading: true, credits: [] });
    const res = await api.getPersonCredits(member.tmdbId);
    if (!res) {
      setPersonView({ id: member.tmdbId, name: member.name, loading: false, credits: [], unavailable: true });
      return;
    }
    setPersonView({ id: member.tmdbId, name: res.person?.name || member.name, loading: false, credits: res.credits });
  }, [personView]);

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

  const { enableWatchlist, rpdbEnabled, enableAutoplayTrailer, autoplayTrailerStartMuted, enableReactions, enableWatchProviders, enableWatchedIndicators, enableWatchTogether } = usePersonalFeatures();
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
  // TV-only. On phone/desktop init() never runs, so registering here feeds
  // an engine with no layout adapter - every mount/unmount then dies inside
  // its async measureLayout ('this.layoutAdapter' undefined), confirmed by
  // betatest stall telemetry as co-timed with multi-second iOS freezes on
  // modal open AND close. isTV is stable for the entire session (see
  // useIsTV), so the conditional hook call below never changes order for a
  // mounted component in practice.
  const fallbackModalRef = useRef<HTMLDivElement>(null);
  const noopFocusModal = useCallback(() => {}, []);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const tvFocus = isTV ? useFocusable<object, HTMLDivElement>({ trackChildren: true }) : null;
  const modalRef = tvFocus ? tvFocus.ref : fallbackModalRef;
  const modalFocusKey = tvFocus?.focusKey ?? 'media-detail-modal';
  const focusModal = tvFocus ? tvFocus.focusSelf : noopFocusModal;
  const hasFocusedChild = tvFocus ? tvFocus.hasFocusedChild : false;
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
  // Following a SHOW: alerts when it is renewed, canceled, or gets a
  // premiere date - the gap the episode calendar doesn't cover, because it
  // only knows about shows that are already airing. Movies aren't followable
  // (there is no ongoing status to report), so this only appears for series.
  const [followRow, setFollowRow] = useState<{ id: string; muted: boolean } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  useEffect(() => {
    if (!isOpen || !effectiveId || effectiveType !== 'series') { setFollowRow(null); return; }
    let cancelled = false;
    api.getFollows()
      .then((rows) => {
        if (cancelled) return;
        const hit = rows.find((r) => r.kind === 'show' && r.subjectId === effectiveId);
        setFollowRow(hit ? { id: hit.id, muted: hit.muted } : null);
      })
      .catch(() => { /* following is additive - a failure just hides the state */ });
    return () => { cancelled = true; };
  }, [isOpen, effectiveId, effectiveType]);

  const toggleFollow = async () => {
    if (!effectiveId || followBusy) return;
    setFollowBusy(true);
    try {
      if (!followRow) {
        const row = await api.followSubject('show', effectiveId, details?.title || effectiveFallbackTitle || effectiveId, details?.poster || effectiveFallbackPoster || null);
        setFollowRow({ id: row.id, muted: row.muted });
        toast.success('Following - you\'ll hear when it\'s renewed, canceled or dated');
      } else if (followRow.muted) {
        await api.muteFollow(followRow.id, false);
        setFollowRow({ ...followRow, muted: false });
        toast.success('Alerts for this show turned back on');
      } else {
        // Mute rather than unfollow: the row survives, so turning it back on
        // doesn't replay news already announced.
        await api.muteFollow(followRow.id, true);
        setFollowRow({ ...followRow, muted: true });
        toast.success('Muted - still followed, just quiet');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update following');
    } finally {
      setFollowBusy(false);
    }
  };

  // Anime extras (AniList): only ever attempted for series whose genres say
  // Animation, so a normal show never pays a lookup for nothing. Everything
  // here is additive - if AniList has no match, the modal is unchanged.
  const [anime, setAnime] = useState<{ anilistId: number; nextEpisode: { episode: number; label: string } | null; siteUrl: string | null } | null>(null);
  const [animeOrder, setAnimeOrder] = useState<{ mainLine: Array<{ anilistId: number; name: string; episodes: number | null; year: number | null }> } | null>(null);
  useEffect(() => {
    const looksAnimated = Array.isArray(details?.genres) && details.genres.some((g) => /animation|anime/i.test(String(g)));
    if (!isOpen || effectiveType !== 'series' || !looksAnimated || !details?.title) { setAnime(null); setAnimeOrder(null); return; }
    let cancelled = false;
    // MediaDetails carries releaseInfo ("2023-" / "2023"), not a year field.
    const yearMatch = String(details.releaseInfo || '').match(/\d{4}/);
    api.lookupAnime(details.title, yearMatch ? Number(yearMatch[0]) : undefined)
      .then((r) => {
        if (cancelled || !r.found || !r.anilistId) return;
        setAnime({ anilistId: r.anilistId, nextEpisode: r.nextEpisode || null, siteUrl: r.siteUrl || null });
        return api.getAnimeWatchOrder(r.anilistId).then((o) => { if (!cancelled) setAnimeOrder({ mainLine: o.mainLine }); });
      })
      .catch(() => { /* additive only */ });
    return () => { cancelled = true; };
  }, [isOpen, effectiveType, details?.title, details?.releaseInfo, details?.genres]);

  // Seasons and episodes (series only). Lazy on purpose: a long-running show
  // has hundreds of episodes, and the detail popup is opened far more often
  // to glance at a title than to browse its season list - so this is fetched
  // when someone actually expands it, not on every open.
  const [seasons, setSeasons] = useState<SeriesSeason[] | null>(null);
  const [seasonsOpen, setSeasonsOpen] = useState(false);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  const [activeSeason, setActiveSeason] = useState<number | null>(null);
  useEffect(() => {
    // Reset whenever the modal moves to a different title.
    setSeasons(null); setSeasonsOpen(false); setActiveSeason(null);
  }, [effectiveId]);
  const loadSeasons = async () => {
    setSeasonsOpen((v) => !v);
    if (seasons || seasonsLoading || !effectiveId) return;
    setSeasonsLoading(true);
    try {
      const r = await api.getMediaEpisodes(effectiveId);
      setSeasons(r.seasons || []);
      // Open on the season the current episode belongs to, falling back to
      // the first - landing on season 1 of a show you are deep into is the
      // kind of small wrongness that makes a feature feel unfinished.
      // MediaDetails carries the episode's title but not its numbers; the
      // season comes from the videoId the modal was opened with
      // (tt123:2:5), when there is one.
      const current = Number(String(effectiveVideoId || '').split(':')[1]);
      setActiveSeason(Number.isFinite(current) && r.seasons.some((x) => x.season === current) ? current : (r.seasons[0]?.season ?? null));
    } catch {
      setSeasons([]);
    } finally {
      setSeasonsLoading(false);
    }
  };

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

  // Reactions (thumbs up/down) - SlickTrax feedback that feeds recommendation
  // scoring (server/utils/recommendationEngine.js's computeSignedAdjustments),
  // not just decoration. Deliberately binary, replacing an earlier 👍/❤️/👎
  // (like/love/dislike) three-tier version that read as clutter - the
  // 'happy'/'sad' state values are a holdover from a brief face-emoji design
  // in between, kept as-is since they're what's already stored server-side;
  // only the icon changed. Same effectiveId-scoped reset and
  // optimistic-update-with-revert pattern as Watchlist above. Personal
  // ratings (1-10, per-season) stay backend-only for now - no UI yet, see
  // client/lib/api.ts's setRating/getRatings if that changes.
  const [reaction, setReactionState] = useState<'happy' | 'sad' | null>(null);
  const [reactionBusy, setReactionBusy] = useState(false);

  // Watched state + the unwatch option. The mechanism (ManualWatchOverride,
  // winning over polled history in either direction) predates this UI - the
  // poster context menu on Discover could already toggle it, but the detail
  // modal, the one place you're actually LOOKING at a title, had no way to
  // say "I didn't really watch this". Account-level, same as the indicators.
  const [selfWatched, setSelfWatched] = useState<boolean | null>(null);
  const [selfWatchedBusy, setSelfWatchedBusy] = useState(false);
  // Per-part watched map for the collection row's "watched X of N".
  const [partsWatched, setPartsWatched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen || !effectiveId) return;
    let cancelled = false;
    setSelfWatched(null);
    api.getWatchedStatus([effectiveId])
      .then((m) => { if (!cancelled) setSelfWatched(!!m[effectiveId]); })
      .catch(() => { if (!cancelled) setSelfWatched(null); });
    return () => { cancelled = true; };
  }, [isOpen, effectiveId]);

  useEffect(() => {
    const parts = details?.collection?.parts;
    if (!isOpen || !parts || parts.length === 0) { setPartsWatched({}); return; }
    let cancelled = false;
    api.getWatchedStatus(parts.map((pt) => pt.id))
      .then((m) => { if (!cancelled) setPartsWatched(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, details?.collection]);

  const toggleSelfWatched = async () => {
    if (selfWatchedBusy || selfWatched === null) return;
    setSelfWatchedBusy(true);
    const next = !selfWatched;
    setSelfWatched(next); // optimistic, same pattern as watchlist above
    try {
      await api.markWatched(effectiveId, next);
    } catch {
      setSelfWatched(!next);
    } finally {
      setSelfWatchedBusy(false);
    }
  };

  // Watching Together (series only) - watch-ahead protection's management
  // surface. A pact = this show + the members watching it together; once
  // saved, anyone starting an episode another member hasn't seen triggers
  // the household alert (server/utils/watchTogether.js). Data loads lazily
  // on first expand - most modal opens never touch this.
  const [wtOpen, setWtOpen] = useState(false);
  const [wtLoaded, setWtLoaded] = useState(false);
  const [wtUsers, setWtUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [wtSelected, setWtSelected] = useState<Set<string>>(new Set());
  const [wtHasPact, setWtHasPact] = useState(false);
  const [wtFrontier, setWtFrontier] = useState<{ season: number; episode: number } | null>(null);
  const [wtWaitingOn, setWtWaitingOn] = useState<string[]>([]);
  const [wtBusy, setWtBusy] = useState(false);

  useEffect(() => {
    // Reset per title so a "More Like This" drill-down never shows the
    // previous show's pact.
    setWtOpen(false); setWtLoaded(false); setWtSelected(new Set());
    setWtHasPact(false); setWtFrontier(null); setWtWaitingOn([]);
  }, [effectiveId]);

  const loadWatchTogether = async () => {
    if (wtLoaded) return;
    try {
      const [users, pacts] = await Promise.all([api.getUsers(), api.getWatchTogether()]);
      setWtUsers(users.map((u) => ({ id: u.id, username: u.username || 'Unnamed' })));
      const pact = pacts.find((pt) => pt.showId === effectiveId);
      if (pact) {
        setWtHasPact(true);
        setWtSelected(new Set(pact.members.map((m) => m.userId)));
        setWtFrontier(pact.frontier);
        setWtWaitingOn(pact.waitingOn);
      }
      setWtLoaded(true);
    } catch { setWtLoaded(true); }
  };

  const saveWatchTogether = async () => {
    setWtBusy(true);
    try {
      await api.saveWatchTogether(effectiveId, details?.title || effectiveFallbackTitle || effectiveId, Array.from(wtSelected));
      setWtHasPact(true);
      toast.success('Spoiler guard on - anyone getting ahead now sets off the alarm');
      // Frontier may exist immediately (members may have history) - refresh.
      const pacts = await api.getWatchTogether().catch(() => []);
      const pact = pacts.find((pt) => pt.showId === effectiveId);
      if (pact) { setWtFrontier(pact.frontier); setWtWaitingOn(pact.waitingOn); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally { setWtBusy(false); }
  };

  const removeWatchTogether = async () => {
    setWtBusy(true);
    try {
      await api.deleteWatchTogether(effectiveId);
      setWtHasPact(false); setWtSelected(new Set()); setWtFrontier(null); setWtWaitingOn([]);
      toast.success('Spoiler guard off - everyone is free to run ahead');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove');
    } finally { setWtBusy(false); }
  };

  useEffect(() => {
    if (!isOpen || !effectiveId || !enableReactions) return;
    let cancelled = false;
    setReactionState(null);
    api.getReactions([effectiveId]).then((r) => { if (!cancelled) setReactionState(r.reactions[effectiveId] || null); }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, effectiveId, enableReactions]);

  const toggleReaction = async (next: 'happy' | 'sad') => {
    if (reactionBusy) return;
    setReactionBusy(true);
    const prev = reaction;
    const willClear = reaction === next; // tapping the active reaction again clears it
    setReactionState(willClear ? null : next); // optimistic
    try {
      if (willClear) {
        await api.clearReaction(effectiveId);
      } else {
        await api.setReaction(effectiveId, effectiveType, next, details?.title || effectiveFallbackTitle, details?.poster || effectiveFallbackPoster || null);
      }
    } catch {
      setReactionState(prev); // revert on failure
    } finally {
      setReactionBusy(false);
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

  // Same mouse-drag-scroll treatment, for the "Part of the X Collection" row.
  const collectionRowRef = useRef<HTMLDivElement>(null);
  const isCollectionPointerDownRef = useRef(false);
  const collectionDragStartXRef = useRef(0);
  const collectionDragStartScrollLeftRef = useRef(0);
  const hasCapturedCollectionPointerRef = useRef(false);

  const handleCollectionPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !collectionRowRef.current) return;
    isCollectionPointerDownRef.current = true;
    hasCapturedCollectionPointerRef.current = false;
    collectionDragStartXRef.current = e.clientX;
    collectionDragStartScrollLeftRef.current = collectionRowRef.current.scrollLeft;
  }, []);

  const handleCollectionPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !isCollectionPointerDownRef.current || !collectionRowRef.current) return;
    if ((e.buttons & 1) === 0) {
      isCollectionPointerDownRef.current = false;
      return;
    }
    const dx = e.clientX - collectionDragStartXRef.current;
    if (Math.abs(dx) > 5 && !hasCapturedCollectionPointerRef.current) {
      collectionRowRef.current.setPointerCapture(e.pointerId);
      hasCapturedCollectionPointerRef.current = true;
    }
    collectionRowRef.current.scrollLeft = collectionDragStartScrollLeftRef.current - dx;
  }, []);

  const handleCollectionPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    isCollectionPointerDownRef.current = false;
    if (hasCapturedCollectionPointerRef.current) {
      collectionRowRef.current?.releasePointerCapture(e.pointerId);
      hasCapturedCollectionPointerRef.current = false;
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
  // Same collapsed-by-default disclosure treatment as "More Like This" -
  // "Part of the X Collection" can run to 10+ posters (long-running
  // franchises) and shouldn't dominate the popup for a title with no other
  // details worth reading yet. Data (details.collection) already loads
  // eagerly with the rest of the details fetch, so this only defers the
  // OPEN state, not the fetch itself.
  const [collectionExpanded, setCollectionExpanded] = useState(false);
  useEffect(() => {
    setCollectionExpanded(false);
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
    // Tell the YouTube player to stop BEFORE clearing the state that unmounts
    // its iframe - not destroy() (that would let the YouTube API physically
    // remove the same DOM node React's own reconciler still owns, which can
    // throw on React's next commit). stopVideo() halts the actual decode/
    // playback work cheaply through the API that already has control of it,
    // so the iframe React removes a moment later is already idle rather than
    // still mid-decode. The comment above already identified iframe teardown
    // as a real, reported cause of a slow-feeling close after a trailer had
    // been playing; this is the part that comment's fix never actually did -
    // clearing trailerSrc unmounts the iframe promptly, but nothing ever told
    // the still-live embed to stop before that happened.
    try { trailerPlayerRef.current?.stopVideo?.(); } catch {}
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
          //
          // max-w-[calc(60vh*16/9)] (not max-h-[60vh] directly on this box) -
          // capping height alone while width stays w-full breaks the
          // aspect-video ratio on a wide viewport (size="full" modal), which
          // recreated the exact letterboxing this was meant to avoid:
          // YouTube's player still renders the real 16:9 video inside a now
          // too-wide box, adding its own black bars to compensate. Capping
          // width to the aspect-consistent value for a 60vh-tall box instead
          // lets aspect-video derive an exactly-60vh height with no conflict,
          // centered via mx-auto (the modal's own surface fills the sides).
          <div className="relative w-full max-w-[calc(60vh*16/9)] aspect-video mx-auto overflow-hidden rounded-t-2xl bg-black">
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
            {/* Positioned low and to the right, in the gradient fade zone
                below YouTube's own bottom-row icons (share/save) rather than
                overlapping them - past the right edge of its scrub bar.
                YouTube's own overlay isn't something we control, so this is
                an approximation, not a guarantee. Goes back to the poster/
                details view, not a full close - backdrop click and Escape
                still fully close the modal. */}
            <button
              type="button"
              onClick={() => setIsTrailerPlaying(false)}
              className="absolute bottom-2 right-2 z-10 p-1 rounded-md transition-colors"
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
                {details.rated && (
                  <span
                    className="px-2 py-0.5 rounded-md text-sm font-semibold border"
                    style={{ color: 'var(--color-text)', borderColor: 'var(--color-surface-border)' }}
                    title="Content rating"
                  >
                    {details.rated}
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
                {typeof details.mdblistScore === 'number' && (
                  <span className="flex items-center gap-1.5 font-medium text-primary" title="MDBList Score (blended across multiple rating sources)">
                    <span aria-hidden className="text-[10px] font-bold px-1 py-0.5 rounded border border-current leading-none">MDB</span>
                    {details.mdblistScore}%
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

                {/* Reactions - moved in next to the rating row (reads as
                    "your own rating," right next to everyone else's) rather
                    than a standalone row competing with the action buttons
                    below. Feeds recommendation scoring (see the state block
                    above), not just decoration. No TV-focus wiring yet
                    (unlike the action row below) - visible and usable with a
                    mouse/touch on PC and Mobile, just not yet D-pad-reachable
                    on TV. ml-auto pins it to the row's right edge on wide
                    screens; it simply wraps onto its own line on narrow ones. */}
                {enableReactions && (
                  <div className="flex items-center gap-1.5 ml-auto">
                    <button
                      type="button"
                      onClick={() => toggleReaction('happy')}
                      disabled={reactionBusy}
                      aria-label="Thumbs up"
                      title="Thumbs up"
                      className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
                        reaction === 'happy' ? 'bg-success/20 ring-1 ring-success text-success' : 'bg-surface-hover hover:bg-success/10 text-muted'
                      } ${reactionBusy ? 'opacity-60 cursor-wait' : ''}`}
                    >
                      <HandThumbUpIcon className="w-5 h-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleReaction('sad')}
                      disabled={reactionBusy}
                      aria-label="Thumbs down"
                      title="Thumbs down"
                      className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
                        reaction === 'sad' ? 'bg-error/20 ring-1 ring-error text-error' : 'bg-surface-hover hover:bg-error/10 text-muted'
                      } ${reactionBusy ? 'opacity-60 cursor-wait' : ''}`}
                    >
                      <HandThumbDownIcon className="w-5 h-5" />
                    </button>
                  </div>
                )}
              </div>

              {/* "You might not even need an addon for this" - shown
                  unconditionally (not behind a disclosure like Collection
                  below) since it's meant to be seen at a glance, not opted
                  into. Subscription/free tiers only, see the type's own
                  comment for why rent/buy is excluded. Links to TMDb's
                  JustWatch attribution page, required by their API terms
                  when this data is displayed. */}
              {/* Seasons and episodes. Series only, collapsed by default, and
                  the list is only fetched on expand - see loadSeasons. */}
              {effectiveType === 'series' && (
                <div className="rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
                  <button
                    type="button"
                    onClick={loadSeasons}
                    className="w-full flex items-center justify-between gap-3 p-3 text-left"
                  >
                    <span className="text-sm font-medium text-default">
                      Seasons &amp; episodes
                      {seasons && seasons.length > 0 && (
                        <span className="text-xs text-muted font-normal"> · {seasons.length} season{seasons.length === 1 ? '' : 's'}</span>
                      )}
                    </span>
                    <ChevronDownIcon className={`w-4 h-4 shrink-0 transition-transform ${seasonsOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--color-text-muted)' }} />
                  </button>

                  {seasonsOpen && (
                    <div className="px-3 pb-3">
                      {seasonsLoading && <p className="text-xs text-muted py-2">Loading episodes…</p>}
                      {!seasonsLoading && seasons && seasons.length === 0 && (
                        <p className="text-xs text-muted py-2">No episode list is available for this title.</p>
                      )}
                      {!seasonsLoading && seasons && seasons.length > 0 && (
                        <>
                          <div className="flex gap-1.5 overflow-x-auto pb-2">
                            {seasons.map((s) => (
                              <button
                                key={s.season}
                                type="button"
                                onClick={() => setActiveSeason(s.season)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap ${activeSeason === s.season ? 'bg-primary text-white' : 'text-muted'}`}
                                style={activeSeason === s.season ? undefined : { background: 'var(--color-surface)' }}
                              >
                                Season {s.season}
                                {s.watchedCount > 0 && (
                                  <span className={activeSeason === s.season ? 'opacity-80' : 'opacity-60'}> · {s.watchedCount}/{s.episodes.length}</span>
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="max-h-64 overflow-y-auto space-y-0.5">
                            {seasons.find((s) => s.season === activeSeason)?.episodes.map((ep) => (
                              <div
                                key={`${ep.season}-${ep.episode}`}
                                className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg"
                                style={{ background: ep.watched ? 'color-mix(in srgb, var(--color-success) 10%, transparent)' : 'transparent' }}
                              >
                                <span className="text-xs shrink-0 w-10 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                                  E{String(ep.episode).padStart(2, '0')}
                                </span>
                                <span className="text-xs flex-1 min-w-0 truncate text-default">{ep.title || `Episode ${ep.episode}`}</span>
                                {ep.released && (
                                  <span className="text-[11px] shrink-0" style={{ color: 'var(--color-text-subtle)' }}>
                                    {new Date(ep.released).getFullYear() || ''}
                                  </span>
                                )}
                                {ep.watched && <CheckCircleIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-success)' }} />}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Anime extras: the next-episode countdown AniList publishes
                  exact air times for (better than a vague date), and the
                  franchise's real watch order - the thing people otherwise
                  go and google a chart for. Only ever present when AniList
                  matched an animated series. */}
              {anime && (anime.nextEpisode || (animeOrder?.mainLine?.length ?? 0) > 1) && (
                <div className="rounded-xl p-3" style={{ background: 'var(--color-surface-hover)' }}>
                  {anime.nextEpisode && (
                    <p className="text-sm text-default">
                      <span className="font-medium">Episode {anime.nextEpisode.episode}</span>
                      <span className="text-muted"> airs in {anime.nextEpisode.label}</span>
                    </p>
                  )}
                  {(animeOrder?.mainLine?.length ?? 0) > 1 && (
                    <div className={anime.nextEpisode ? 'mt-2' : ''}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-muted)' }}>Watch order</p>
                      <ol className="space-y-0.5">
                        {animeOrder!.mainLine.map((entry, i) => (
                          <li key={entry.anilistId} className="text-xs text-muted">
                            <span className="text-default">{i + 1}. {entry.name}</span>
                            {entry.episodes ? ` · ${entry.episodes} eps` : ''}{entry.year ? ` · ${entry.year}` : ''}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}

              {enableWatchProviders && details.watchProviders && details.watchProviders.providers.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted">Also streaming on</span>
                  {details.watchProviders.providers.map((p) => (
                    <a
                      key={p.name}
                      href={details.watchProviders!.link || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={p.name}
                      className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border transition-colors hover:border-primary"
                      style={{ borderColor: 'var(--color-surface-border)', background: 'var(--color-surface-hover)' }}
                    >
                      {p.logo ? (
                        <img src={p.logo} alt="" className="w-5 h-5 rounded-full" />
                      ) : null}
                      <span className="text-xs font-medium text-default">{p.name}</span>
                    </a>
                  ))}
                </div>
              )}

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
                // sm:w-auto justify-center on each control - the mobile
                // grid below (2 columns) needs every cell's control to fill
                // its cell to actually read as a 2x2 grid rather than 4
                // left-aligned buttons in narrow cells; sm:contents/w-auto
                // hands width back to flex-wrap's own auto-sizing at the
                // desktop breakpoint where the old single-row layout stays.
                const watchlistBtn = enableWatchlist && (
                  <button
                    type="button"
                    onClick={toggleWatchlist}
                    disabled={watchlistBusy}
                    aria-label={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    title={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    className={`flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full sm:w-auto ${
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
                const watchedBtn = enableWatchedIndicators && selfWatched !== null && (
                  <button
                    type="button"
                    onClick={toggleSelfWatched}
                    disabled={selfWatchedBusy}
                    aria-label={selfWatched ? 'Mark as unwatched' : 'Mark as watched'}
                    title={selfWatched ? 'Marks this title unwatched for the household - the underlying watch history is kept, only the indicator changes' : 'Marks this title watched for the household, e.g. seen on another service'}
                    className={`flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full sm:w-auto ${selfWatchedBusy ? 'opacity-60 cursor-wait' : ''}`}
                    style={selfWatched
                      ? { color: 'var(--color-success)', background: 'color-mix(in srgb, var(--color-success) 15%, transparent)' }
                      : { color: 'var(--color-text-muted)', background: 'var(--color-surface-hover)' }}
                  >
                    <CheckCircleIcon className="w-4 h-4" />
                    {selfWatched ? 'Watched' : 'Unwatched'}
                  </button>
                );
                // Series only: a movie has no ongoing status to report on.
                const followBtn = effectiveType === 'series' && (
                  <button
                    type="button"
                    onClick={toggleFollow}
                    disabled={followBusy}
                    title={!followRow
                      ? 'Get told when this show is renewed, canceled, or gets a premiere date'
                      : followRow.muted ? 'Alerts are muted - turn them back on' : 'Mute alerts for this show (it stays followed)'}
                    className={`flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full sm:w-auto ${followBusy ? 'opacity-60 cursor-wait' : ''}`}
                    style={followRow && !followRow.muted
                      ? { color: 'var(--color-primary)', background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)' }
                      : { color: 'var(--color-text-muted)', background: 'var(--color-surface-hover)' }}
                  >
                    <BellIcon className="w-4 h-4" />
                    {!followRow ? 'Follow' : followRow.muted ? 'Muted' : 'Following'}
                  </button>
                );
                const stremioBtn = (
                  <a
                    href={buildStremioAppUrl(details.imdb_id, effectiveType)}
                    tabIndex={isTV ? -1 : undefined}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full sm:w-auto"
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
                    className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full sm:w-auto"
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
                      {enableWatchedIndicators && selfWatched !== null && (
                        <TVFocusable onEnterPress={toggleSelfWatched}>{watchedBtn}</TVFocusable>
                      )}
                      {followBtn && (
                        <TVFocusable onEnterPress={toggleFollow}>{followBtn}</TVFocusable>
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
                  // 2 columns on mobile (Watchlist+catalog, Stremio+Nuvio -
                  // 2 rows instead of 4 full-width stacked buttons), back to
                  // the original single-row flex-wrap from sm: up.
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    {watchlistBtn}
                    {watchedBtn}
                    {followBtn}
                    <div className="flex justify-center sm:contents">
                      <AddToListButton item={{ id: effectiveId, type: effectiveType, name: effectiveFallbackTitle, poster: effectiveFallbackPoster || null }} />
                    </div>
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

              {effectiveType === 'series' && enableWatchTogether && (
                <div className="rounded-xl border border-default bg-surface-hover/40">
                  <button
                    type="button"
                    onClick={() => { setWtOpen((v) => !v); if (!wtOpen) loadWatchTogether(); }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-default">Spoiler guard</span>
                      {wtHasPact && (
                        <span className="text-xs text-muted truncate">
                          {wtSelected.size} people
                          {wtFrontier
                            ? ` · everyone is at S${wtFrontier.season}E${wtFrontier.episode}${wtWaitingOn.length ? ` (waiting on ${wtWaitingOn.join(', ')})` : ''}`
                            : ' · not everyone has started yet'}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted shrink-0">{wtOpen ? 'Hide' : wtHasPact ? 'Edit' : 'Set up'}</span>
                  </button>
                  {wtOpen && (
                    <div className="px-3 pb-3">
                      <p className="text-xs text-muted mb-2">
                        Pick who is watching this show together. When anyone starts an episode someone else here has not seen, the household gets told - by name.
                      </p>
                      {!wtLoaded ? (
                        <p className="text-xs text-subtle">Loading...</p>
                      ) : wtUsers.length < 2 ? (
                        <p className="text-xs text-subtle">The spoiler guard takes at least two users on this instance.</p>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-2 mb-3">
                            {wtUsers.map((u) => {
                              const on = wtSelected.has(u.id);
                              return (
                                <button
                                  key={u.id}
                                  type="button"
                                  onClick={() => setWtSelected((prev) => { const n = new Set(prev); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}
                                  className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                                  style={{
                                    background: on ? 'var(--color-primary)' : 'var(--color-surface)',
                                    color: on ? 'var(--color-bg)' : 'var(--color-text-muted)',
                                    border: '1px solid',
                                    borderColor: on ? 'var(--color-primary)' : 'var(--color-surface-border)',
                                  }}
                                >
                                  {u.username}
                                </button>
                              );
                            })}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={wtBusy || wtSelected.size < 2}
                              onClick={saveWatchTogether}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity disabled:opacity-40"
                              style={{ background: 'var(--color-primary)', color: 'var(--color-bg)' }}
                            >
                              {wtHasPact ? 'Update' : 'Turn on spoiler guard'}
                            </button>
                            {wtHasPact && (
                              <button
                                type="button"
                                disabled={wtBusy}
                                onClick={removeWatchTogether}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted hover:text-default transition-colors"
                              >
                                Stop
                              </button>
                            )}
                            {wtSelected.size === 1 && (
                              <span className="text-xs text-subtle">Pick at least one more person</span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
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

              {details.boxOffice && (
                <p className="text-sm text-muted flex items-start gap-1.5">
                  <span className="w-5 h-5 shrink-0 mt-0.5 flex items-center justify-center" aria-hidden>💰</span>
                  Box office: {details.boxOffice}
                </p>
              )}

              {/* TMDb "belongs_to_collection" grouping - e.g. Dune (2021) ->
                  "Part of the Dune Collection" -> the other films in it,
                  each clickable via the same setOverrideItem navigation
                  "More Like This" already uses to swap the modal's content
                  in place. Movies only; null entirely for TV or a movie
                  not part of one, so this section just doesn't render. */}
              {details.collection && details.collection.parts.length > 0 && (
                <div>
                  {(() => {
                    const toggleLabel = (
                      <span className="flex items-center justify-between w-full py-1 text-base text-muted hover:text-default transition-colors">
                        <span className="flex items-center gap-2">
                          Part of the {details.collection.name}
                          {(() => {
                            // Membership = this title + the other parts; the
                            // completion count is the collection's entire
                            // reason to exist as a stat.
                            const others = details.collection.parts;
                            const watchedOthers = others.filter((pt) => partsWatched[pt.id]).length;
                            const watchedTotal = watchedOthers + (selfWatched ? 1 : 0);
                            const total = others.length + 1;
                            const done = watchedTotal >= total;
                            return (
                              <span className="text-xs" style={{ color: done ? 'var(--color-success)' : undefined }}>
                                {done ? 'saga complete' : `watched ${watchedTotal} of ${total}`}
                              </span>
                            );
                          })()}
                        </span>
                        <ChevronDownIcon className={`w-4 h-4 transition-transform ${collectionExpanded ? 'rotate-180' : ''}`} />
                      </span>
                    );
                    const onToggle = () => setCollectionExpanded((v) => !v);
                    return isTV ? (
                      <TVFocusable onEnterPress={onToggle} className="block w-full">
                        {toggleLabel}
                      </TVFocusable>
                    ) : (
                      <button type="button" onClick={onToggle} className="block w-full">
                        {toggleLabel}
                      </button>
                    );
                  })()}
                  {collectionExpanded && (
                    <div
                      ref={collectionRowRef}
                      onPointerDown={handleCollectionPointerDown}
                      onPointerMove={handleCollectionPointerMove}
                      onPointerUp={handleCollectionPointerUp}
                      className="flex gap-3 overflow-x-auto pb-1 pr-6 mt-2 no-scrollbar cursor-grab active:cursor-grabbing select-none"
                    >
                      {details.collection.parts.map((part) => {
                        const goToPart = () => setOverrideItem({
                          id: part.id,
                          type: 'movie',
                          name: part.title,
                          poster: part.poster,
                          releaseInfo: part.releaseYear || undefined,
                        });
                        return (
                          <button
                            key={part.id}
                            type="button"
                            onClick={goToPart}
                            className="shrink-0 w-28 text-left group tap-card"
                          >
                            <div className="w-28 h-40 rounded-lg overflow-hidden bg-surface-hover relative">
                              {partsWatched[part.id] && (
                                <span className="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'var(--color-success)' }}>
                                  <CheckIconMini className="w-3.5 h-3.5 text-white" />
                                </span>
                              )}
                              {part.poster ? (
                                <img
                                  src={part.poster}
                                  alt={part.title}
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
                            <p className="mt-1.5 text-sm font-medium text-default leading-tight group-hover:text-primary transition-colors line-clamp-2">
                              {part.title}
                            </p>
                            {part.releaseYear && <p className="text-xs text-subtle">{part.releaseYear}</p>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
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
