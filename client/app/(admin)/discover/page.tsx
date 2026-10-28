'use client';

/*
 * DISCOVER, ONE PAGE OF POSTERS.
 *
 * The search across the top with Movies / Shows / Both, then what you are
 * looking through - Titles, People, For you, Nobody's seen it, Watchlist -
 * with the order and the filters beside it as two buttons, and a line that
 * says what the grid holds: "Popular 1990s comedy movies rated 7+".
 * Everything else is posters, opened in the title popup.
 *
 * The filters a catalog can't apply itself (decade, rating, length) and
 * Movies + Shows together are the server's (utils/discoverFacets.js), so
 * paging works the same with any of them on. A person - from People, or
 * from "See more about" on a title's cast - gets a page of
 * their own at the top: who they are, and everything they've been in.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { Header } from '@/components/layout/Header';
import { useLayoutMode } from '@/lib/layout-mode';
import { MediaDetailModal, Badge, PosterCard, PosterCardItem, VirtualPosterGrid, PageToolbar } from '@/components/ui';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { SortableItem, usePageArrangement, usePageDesign } from '@/lib/arrange';
import { ArrangeBar, ArrangeButton, ArrangeGrip, ArrangeSection, HiddenTray, StretchHandle } from '@/components/ui/Arrange';
import { V2Button } from '@/components/v2/V2Bits';
import { api, DiscoverItem, RecommendationRow, User, SimklDiscoverItem, SeasonalAnime, PersonSearchResult, DiscoverPerson, DiscoverFacets } from '@/lib/api';
import { useLastKnown } from '@/lib/hooks/useLastKnown';
import { useRatingsBatch } from '@/lib/hooks/useRatingsBatch';
import { useWatchlistState } from '@/lib/hooks/useWatchlistState';
import { useWatchedStatusBatch } from '@/lib/hooks/useWatchedStatusBatch';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import {
  GENRES, SORTS, WATCHLIST_SORTS, DECADES, RATINGS, LENGTHS, KINDS, describeGrid, uniqueById, mergeNew, retryDelay, pickSurprise,
  type Kind, type SortKey, type Decade, type Length, type WatchedFilter, type WatchlistSort,
} from '@/lib/discoverWords';
import { workAsPerson, bornLine, wikipediaLine } from '@/lib/personFacts';
import {
  MagnifyingGlassIcon, SparklesIcon, UserIcon, ChevronDownIcon, AdjustmentsHorizontalIcon, XMarkIcon,
  ArrowsRightLeftIcon, CheckIcon, CalendarDaysIcon, MapPinIcon, BellIcon, EyeIcon,
} from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { ScrollRow } from '@/components/ui/ScrollRow';

type Lens = 'titles' | 'people' | 'foryou' | 'nobody' | 'watchlist';
type PersonResult = { person: DiscoverPerson; results: PersonSearchResult[]; source?: 'lumiere' };

const GRID = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3';
const SORT_STORE = 'slicksync-discover-sort';

/**
 * A panel that drops from its button and closes on a tap elsewhere or
 * Escape. `fit` goes on the panel: it never runs past the bottom of the
 * window - it scrolls inside instead.
 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.style.maxHeight = `${Math.max(220, window.innerHeight - el.getBoundingClientRect().top - 16)}px`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, ref, fit: panel };
}

/** D-pad reachable in TV mode, a plain element everywhere else. */
function Focus({ tv, onEnter, children }: { tv: boolean; onEnter: () => void; children: React.ReactElement }) {
  return tv ? <TVFocusable onEnterPress={onEnter}>{children}</TVFocusable> : children;
}

function Pill({ on, onClick, children, tv = false }: { on: boolean; onClick: () => void; children: React.ReactNode; tv?: boolean }) {
  return (
    <Focus tv={tv} onEnter={onClick}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={on}
        className={`h-8 px-3 rounded-full text-[13px] font-medium transition-colors ${on ? 'text-default disc-pill-on' : 'text-muted hover:text-default disc-pill-off'}`}
      >
        {children}
      </button>
    </Focus>
  );
}

const panelStyle: React.CSSProperties = { background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' };

/** A person asked for in the address: /discover?person=<TMDb id>&name=<name>. */
function personFromAddress(): { id: number | null; name: string } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const name = (params.get('name') ?? '').trim();
  const id = Number(params.get('person'));
  return name ? { id: Number.isFinite(id) && id > 0 ? id : null, name } : null;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const yearOf = (s: string | null | undefined) => parseInt(/\d{4}/.exec(s || '')?.[0] || '0', 10) || 0;

export default function DiscoverPage() {
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  const { design } = usePageDesign();
  const v2 = design === 'v2' && !isTV;
  const { enableWatchlist, enableWatchedIndicators, enableRecommendations } = usePersonalFeatures();

  const [address] = useState(personFromAddress);
  // Both by default, so a search or a browse finds movies and shows alike.
  const [kind, setKind] = useState<Kind>('both');
  const [lens, setLens] = useState<Lens>(address ? 'people' : 'titles');
  // Trending first where there is a LumiereDB to rank it - the server
  // answers Popular for it without one, and the effect below says so.
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const stored = localStorage.getItem(SORT_STORE) as SortKey | null;
      if (stored && SORTS.some((s) => s.key === stored)) return stored;
    } catch { /* storage blocked - the default */ }
    return 'trending';
  });
  useEffect(() => { try { localStorage.setItem(SORT_STORE, sort); } catch { /* per device only */ } }, [sort]);
  const [genre, setGenre] = useState('');
  const [decade, setDecade] = useState<Decade | null>(null);
  const [minRating, setMinRating] = useState<number | null>(null);
  const [length, setLength] = useState<Length | null>(null);
  const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>('all');
  const [watchlistSort, setWatchlistSort] = useState<WatchlistSort>('added');
  const [searchQuery, setSearchQuery] = useState(address?.name ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(address?.name ?? '');
  // The person by id, dropped the moment the search box no longer holds their name.
  const [personId, setPersonId] = useState<number | null>(address?.id ?? null);
  const personName = useRef<string | null>(address?.name ?? null);
  useEffect(() => {
    if (personId && personName.current !== null && searchQuery.trim() !== personName.current) {
      personName.current = null;
      setPersonId(null);
    }
  }, [searchQuery, personId]);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // "See more about" someone in a title's cast, while already here.
  useEffect(() => {
    const onPerson = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number | null; name: string }>).detail;
      if (!detail?.name) return;
      personName.current = detail.name;
      setPersonId(detail.id);
      setSearchQuery(detail.name);
      setDebouncedQuery(detail.name);
      setLens('people');
      // So a reload, or the link copied, is this person too.
      window.history.replaceState(null, '', `/discover?${detail.id ? `person=${detail.id}&` : ''}name=${encodeURIComponent(detail.name)}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('slicksync:discover-person', onPerson);
    return () => window.removeEventListener('slicksync:discover-person', onPerson);
  }, []);

  // Web Share Target and the command palette: /discover?q= (with t= for the
  // type), or ?st_title=&st_text=&st_url= shared from another app. An IMDb
  // link resolves to its title; a TMDb link carries a slug; anything else
  // has its links stripped and the rest searched.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) {
      const t = params.get('t');
      if (t === 'movie' || t === 'series') setKind(t);
      setSearchQuery(q);
      return;
    }
    const shared = [params.get('st_title'), params.get('st_text'), params.get('st_url')].filter(Boolean).join(' ').trim();
    if (!shared) return;
    const imdbId = shared.match(/tt\d{7,10}/)?.[0];
    const tmdbSlug = shared.match(/themoviedb\.org\/(?:movie|tv)\/\d+-([a-z0-9-]+)/i)?.[1];
    const plainText = shared.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
    if (plainText) setSearchQuery(plainText);
    else if (tmdbSlug) setSearchQuery(tmdbSlug.replace(/-/g, ' '));
    else if (imdbId) {
      const nameOf = (d: { meta?: { name?: string }; name?: string } | null) => d?.meta?.name || d?.name;
      api.getMediaDetails(imdbId, 'movie').then((d) => { const n = nameOf(d as never); if (n) setSearchQuery(n); })
        .catch(() => api.getMediaDetails(imdbId, 'series').then((d) => { const n = nameOf(d as never); if (n) setSearchQuery(n); }).catch(() => {}));
    }
  }, []);

  // Off with the feature: a lens nobody can use, or a filter that would hide
  // everything, snaps back.
  useEffect(() => {
    if (!enableRecommendations && (lens === 'foryou' || lens === 'nobody')) setLens('titles');
    if (!enableWatchlist && lens === 'watchlist') setLens('titles');
  }, [enableRecommendations, enableWatchlist, lens]);
  useEffect(() => {
    if (!enableWatchedIndicators && watchedFilter !== 'all') setWatchedFilter('all');
  }, [enableWatchedIndicators, watchedFilter]);
  useEffect(() => {
    if ((lens === 'foryou' || lens === 'nobody') && watchedFilter === 'only') setWatchedFilter('all');
  }, [lens, watchedFilter]);

  // LumiereDB: Trending, IMDb's Popular and typo-proof search.
  const [lumiereReady, setLumiereReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getDiscoverLumiere().then((r) => {
      if (cancelled) return;
      setLumiereReady(!!r.ready);
      if (!r.ready) setSort((current) => (current === 'trending' ? 'popular' : current));
    });
    return () => { cancelled = true; };
  }, []);
  const sorts = lumiereReady ? SORTS : SORTS.filter((s) => s.key !== 'trending');
  const sortInfo = SORTS.find((s) => s.key === sort) ?? SORTS[0];
  const catalog = sortInfo.catalog;
  const facets: DiscoverFacets = useMemo(() => ({ decade, minRating, length }), [decade, minRating, length]);

  const [detailItem, setDetailItem] = useState<PosterCardItem | null>(null);
  // Which poster's menu is open, across every grid on the page, so opening a
  // second closes the first. One stable callback so PosterCard's memo holds.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const handleMenuOpenChange = useCallback((open: boolean, key: string) => { setOpenMenuKey(open ? key : null); }, []);

  // "/" puts the cursor in the search, as on most sites with one.
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------- Titles ---------------- */

  const [items, setItems] = useState<DiscoverItem[]>([]);
  const itemsRef = useRef<DiscoverItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreLock = useRef(false);
  // Which listing is on screen: a later page that arrives for one since
  // replaced (another order, kind, search or filter) is dropped.
  const listingId = useRef(0);
  const pageRetries = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  const forgetRetry = useCallback(() => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    pageRetries.current = 0;
  }, []);
  useEffect(() => forgetRetry, [forgetRetry]);

  // The last-known first page, shown at once while the fetch refreshes it.
  // Not when the page opened with a search in the address.
  useLastKnown<{ items: DiscoverItem[]; nextSkip: number | null }>(`/discover/browse?type=movie&paged=1&catalog=${catalog}`, (cached) => {
    const params = new URLSearchParams(window.location.search);
    if (['q', 'st_title', 'st_text', 'st_url', 'person'].some((k) => params.has(k))) return;
    if (!cached?.items?.length || itemsRef.current.length) return;
    itemsRef.current = uniqueById(cached.items);
    setItems(itemsRef.current);
    setIsLoading(false);
  });

  const titlesKey = `${kind}|${catalog}|${genre}|${debouncedQuery}|${decade}|${minRating}|${length}`;
  useEffect(() => {
    listingId.current += 1;
    forgetRetry();
    if (lens !== 'titles') return;
    let cancelled = false;
    setIsLoading(true);
    setSkip(0);
    setHasMore(true);
    loadMoreLock.current = false;
    setIsLoadingMore(false);
    api.discoverPage(kind, debouncedQuery ? { query: debouncedQuery, genre: genre || undefined, ...facets } : { catalog, genre: genre || undefined, ...facets })
      .then(({ items: results, nextSkip }) => {
        if (cancelled) return;
        itemsRef.current = uniqueById(results);
        setItems(itemsRef.current);
        setIsLoading(false);
        setHasMore(nextSkip !== null && nextSkip > 0 && results.length > 0);
        setSkip(nextSkip ?? results.length);
      });
    return () => { cancelled = true; };
    // titlesKey carries every input the request reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, titlesKey, forgetRetry]);

  // The next page, joined to the grid. A page that failed is asked for again
  // a few times before the list is taken as finished.
  const loadMore = useCallback(async () => {
    if (lens !== 'titles' || debouncedQuery || !hasMore || loadMoreLock.current) return;
    loadMoreLock.current = true;
    setIsLoadingMore(true);
    const mine = listingId.current;
    const { items: next, nextSkip, failed } = await api.discoverPage(kind, { catalog, genre: genre || undefined, skip, ...facets });
    if (listingId.current !== mine) return;
    loadMoreLock.current = false;
    setIsLoadingMore(false);
    if (failed) {
      const wait = retryDelay(pageRetries.current);
      if (wait === null) { setHasMore(false); return; }
      pageRetries.current += 1;
      retryTimer.current = window.setTimeout(() => loadMoreRef.current(), wait);
      return;
    }
    pageRetries.current = 0;
    const additions = mergeNew(itemsRef.current, next);
    itemsRef.current = [...itemsRef.current, ...additions];
    setItems(itemsRef.current);
    setSkip((s) => nextSkip ?? s + next.length);
    // A page that brings nothing new ends it: a source that ignores skip
    // answers the same page for ever.
    const sourceMoved = nextSkip !== null ? nextSkip > skip : next.length > 0;
    setHasMore(additions.length > 0 && sourceMoved);
  }, [lens, debouncedQuery, hasMore, kind, catalog, genre, skip, facets]);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // Instant matches: the household's own titles, fetched once, matched as you
  // type, kept on screen when the wider search didn't find them too.
  const [localIndex, setLocalIndex] = useState<Array<{ id: string; name: string; type: 'movie' | 'series'; poster: string | null }>>([]);
  useEffect(() => {
    api.getLocalIndex().then((r) => setLocalIndex(r.items || [])).catch(() => setLocalIndex([]));
  }, []);
  const instantOnly = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2 || lens !== 'titles') return [];
    const shown = new Set(items.map((i) => i.id));
    return localIndex
      .filter((i) => (kind === 'both' || i.type === kind) && i.name.toLowerCase().includes(q) && !shown.has(i.id))
      .slice(0, 12)
      .map((i) => ({ id: i.id, type: i.type, name: i.name, poster: i.poster, releaseInfo: null, imdbRating: null, genres: [] } as DiscoverItem));
  }, [searchQuery, localIndex, kind, lens, items]);

  // Describe it: a plot or a feeling in, real titles out (checked against
  // TMDb). An AI round trip, so it runs only when asked for.
  const [describeResults, setDescribeResults] = useState<DiscoverItem[] | null>(null);
  const [describeBusy, setDescribeBusy] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);
  useEffect(() => { setDescribeResults(null); setDescribeError(null); }, [debouncedQuery, kind]);
  const runDescribe = useCallback(async () => {
    const text = searchQuery.trim();
    if (!text || describeBusy) return;
    setDescribeBusy(true);
    setDescribeError(null);
    try {
      const types: Array<'movie' | 'series'> = kind === 'both' ? ['movie', 'series'] : [kind];
      const answers = await Promise.all(types.map((t) => api.searchByDescription(text, t)));
      const found = answers.flatMap((r) => r.items);
      setDescribeResults(found);
      if (found.length === 0) {
        setDescribeError(answers.some((r) => r.candidates > 0)
          ? 'It had guesses, but none of them checked out against TMDb - try adding a detail you’re sure about.'
          : 'No match from that description - try naming something specific you remember.');
      }
    } catch (e) {
      setDescribeError(e instanceof Error ? e.message : 'Search failed');
      setDescribeResults([]);
    } finally {
      setDescribeBusy(false);
    }
  }, [searchQuery, describeBusy, kind]);
  const describing = lens === 'titles' && (describeBusy || describeResults !== null);

  /* ---------------- For you / Nobody's seen it ---------------- */

  const kindsFor = (k: Kind): Array<'movie' | 'series'> => (k === 'both' ? ['movie', 'series'] : [k]);
  const [recRows, setRecRows] = useState<RecommendationRow[]>([]);
  const [recsLoaded, setRecsLoaded] = useState(false);
  const [householdPicks, setHouseholdPicks] = useState<{ items: DiscoverItem[]; genres: string[]; memberCount: number; sharedAppeal: boolean } | null>(null);
  const [picksLoaded, setPicksLoaded] = useState(false);
  const [recMode, setRecMode] = useState<'personal' | 'shared'>('personal');
  const [recUserId, setRecUserId] = useState('');
  const [recUserId2, setRecUserId2] = useState('');
  const [recUsers, setRecUsers] = useState<User[]>([]);
  useEffect(() => {
    if (lens !== 'foryou' || recUsers.length > 0) return;
    api.getUsers().then((users) => {
      setRecUsers(users);
      const validId = (id: string | null) => (id && users.some((u) => u.id === id) ? id : '');
      setRecMode(localStorage.getItem('slicksync-foryou-mode') === 'shared' ? 'shared' : 'personal');
      setRecUserId(validId(localStorage.getItem('slicksync-foryou-userId')) || users[0]?.id || '');
      setRecUserId2(validId(localStorage.getItem('slicksync-foryou-userId2')) || (users[1]?.id ?? users[0]?.id ?? ''));
    }).catch(() => {});
  }, [lens, recUsers.length]);
  useEffect(() => {
    if (lens !== 'foryou' || !enableRecommendations) return;
    if (recMode === 'personal' && !recUserId) return;
    if (recMode === 'shared' && (!recUserId || !recUserId2 || recUserId === recUserId2)) return;
    let cancelled = false;
    setRecsLoaded(false);
    Promise.all(kindsFor(kind).map((t) => api.getRecommendations(
      recMode === 'personal' ? { mode: 'personal', userId: recUserId, type: t } : { mode: 'shared', userId: recUserId, userId2: recUserId2, type: t },
    ).then((r) => (Array.isArray(r?.rows) ? r.rows : [])).catch(() => [] as RecommendationRow[])))
      .then((all) => { if (!cancelled) setRecRows(all.flat()); })
      .finally(() => { if (!cancelled) setRecsLoaded(true); });
    return () => { cancelled = true; };
  }, [lens, enableRecommendations, recMode, recUserId, recUserId2, kind]);
  useEffect(() => {
    if (lens !== 'nobody' || !enableRecommendations) return;
    let cancelled = false;
    setPicksLoaded(false);
    Promise.all(kindsFor(kind).map((t) => api.getHouseholdPicks(t).catch(() => null)))
      .then((all) => {
        if (cancelled) return;
        const found = all.filter(Boolean) as NonNullable<typeof householdPicks>[];
        setHouseholdPicks(found.length ? {
          items: found.flatMap((f) => f.items),
          genres: [...new Set(found.flatMap((f) => f.genres))],
          memberCount: Math.max(...found.map((f) => f.memberCount)),
          sharedAppeal: found.some((f) => f.sharedAppeal),
        } : null);
      })
      .finally(() => { if (!cancelled) setPicksLoaded(true); });
    return () => { cancelled = true; };
  }, [lens, enableRecommendations, kind]);
  useEffect(() => { if (recUsers.length > 0) localStorage.setItem('slicksync-foryou-mode', recMode); }, [recMode, recUsers.length]);
  useEffect(() => { if (recUserId) localStorage.setItem('slicksync-foryou-userId', recUserId); }, [recUserId]);
  useEffect(() => { if (recUserId2) localStorage.setItem('slicksync-foryou-userId2', recUserId2); }, [recUserId2]);
  useEffect(() => {
    if (recUserId2 && recUserId2 !== recUserId) return;
    const next = recUsers.find((u) => u.id !== recUserId);
    if (next) setRecUserId2(next.id);
  }, [recUserId, recUserId2, recUsers]);

  // Finish the saga - franchises the household is part way through, closest
  // to finished first. Account-wide, movies only.
  const [sagas, setSagas] = useState<Awaited<ReturnType<typeof api.getFinishTheSaga>>>([]);
  const [sagasLoaded, setSagasLoaded] = useState(false);
  useEffect(() => {
    if (lens !== 'foryou' || sagasLoaded) return;
    api.getFinishTheSaga().then(setSagas).catch(() => setSagas([])).finally(() => setSagasLoaded(true));
  }, [lens, sagasLoaded]);

  // Trending on SIMKL - needs only a SIMKL Client ID; empty when there isn't one.
  const [simklTrending, setSimklTrending] = useState<Array<SimklDiscoverItem & { releaseInfo: string | null }>>([]);
  useEffect(() => {
    if (lens !== 'foryou') return;
    let cancelled = false;
    Promise.all(kindsFor(kind).map((t) => api.getSimklDiscoverRow('trending', t === 'series' ? 'shows' : 'movies')))
      .then((rows) => { if (!cancelled) setSimklTrending(rows.flat().map((i) => ({ ...i, releaseInfo: i.year }))); });
    return () => { cancelled = true; };
  }, [lens, kind]);

  // Airing this season (AniList) - opt-in per account. These carry AniList
  // ids, so a tap searches Discover for the title rather than faking a card.
  const [seasonalAnime, setSeasonalAnime] = useState<SeasonalAnime[]>([]);
  const [seasonalUnavailable, setSeasonalUnavailable] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getSyncSettings()
      .then((ss) => {
        if (cancelled || ss.animeSeasonalRow !== true) return;
        return api.getSeasonalAnime().then((r) => {
          if (cancelled) return;
          setSeasonalAnime(r.items || []);
          setSeasonalUnavailable(r.unavailable ? (r.reason || 'AniList is unavailable right now.') : null);
        });
      })
      .catch(() => { /* the row simply doesn't appear */ });
    return () => { cancelled = true; };
  }, []);

  /* ---------------- People ---------------- */

  const [person, setPerson] = useState<PersonResult | null>(null);
  const [personLoading, setPersonLoading] = useState(false);
  const [peopleNoKey, setPeopleNoKey] = useState(false);
  const [personSort, setPersonSort] = useState<'popular' | 'newest' | 'oldest'>('popular');
  const [unseenOnly, setUnseenOnly] = useState(false);
  useEffect(() => {
    if (lens !== 'people' || !debouncedQuery) { setPerson(null); setPersonLoading(false); return; }
    let cancelled = false;
    setPersonLoading(true);
    Promise.all(kindsFor(kind).map((t) => api.searchPerson(debouncedQuery, t, personId)))
      .then((answers) => {
        if (cancelled) return;
        const found = answers.filter((a) => a?.person && a.results.length > 0) as PersonResult[];
        setPeopleNoKey(answers.some((a) => a?.nokey));
        setPerson(found.length ? { person: found[0].person, results: found.flatMap((f) => f.results), source: found[0].source } : null);
      })
      .catch(() => { if (!cancelled) setPerson(null); })
      .finally(() => { if (!cancelled) setPersonLoading(false); });
    return () => { cancelled = true; };
  }, [lens, debouncedQuery, kind, personId]);

  // Following a person - the same follows the title popup's cast panel uses.
  const [personFollow, setPersonFollow] = useState<{ id: string; muted: boolean } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const followId = person?.person.id ? String(person.person.id) : null;
  useEffect(() => {
    if (!followId) { setPersonFollow(null); return; }
    let cancelled = false;
    api.getFollows().then((r) => {
      if (cancelled) return;
      const hit = (Array.isArray(r) ? r : []).find((f) => f.kind === 'person' && String(f.subjectId) === followId);
      setPersonFollow(hit ? { id: hit.id, muted: hit.muted } : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [followId]);
  const toggleFollow = async () => {
    if (!followId || !person || followBusy) return;
    const name = person.person.name;
    setFollowBusy(true);
    try {
      if (!personFollow) {
        const row = await api.followSubject('person', followId, name, person.person.profile);
        setPersonFollow({ id: row.id, muted: row.muted });
        toast.success(`Following ${name}`, { line: 'You’ll hear when they have something new out.' });
      } else {
        // Mute rather than unfollow, as everywhere: the row survives, so
        // turning it back on doesn't replay news already announced.
        await api.muteFollow(personFollow.id, !personFollow.muted);
        setPersonFollow({ ...personFollow, muted: !personFollow.muted });
        toast.success(personFollow.muted ? `Alerts for ${name} turned back on` : `Muted ${name} - still followed, just quiet`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update following');
    } finally {
      setFollowBusy(false);
    }
  };

  const openCredit = useCallback(async (r: PersonSearchResult) => {
    if (r.imdbId) {
      setDetailItem({ id: r.imdbId, type: r.mediaType === 'tv' ? 'series' : 'movie', name: r.title, poster: r.poster } as PosterCardItem);
      return;
    }
    if (r.tmdbId == null) return;
    const res = await api.resolveImdbId(r.tmdbId, r.mediaType);
    if (res?.imdbId) setDetailItem({ id: res.imdbId, type: res.type, name: r.title, poster: r.poster } as PosterCardItem);
    else toast.error('Couldn’t open that title');
  }, []);

  // A credit's IMDb id: its own when LumiereDB gave one, otherwise the
  // household's copy of that title, matched by name - which is all "watched"
  // can be known for.
  const localByName = useMemo(() => new Map(localIndex.map((i) => [`${i.type}|${fold(i.name)}`, i.id])), [localIndex]);
  const creditImdb = useCallback((r: PersonSearchResult) => r.imdbId || localByName.get(`${r.mediaType === 'tv' ? 'series' : 'movie'}|${fold(r.title)}`) || null, [localByName]);

  /* ---------------- Watchlist ---------------- */

  const { watchlist, watchlistLoaded, inWatchlistIds, toggleWatchlist: handleToggleWatchlist, applyWatchlistChange } = useWatchlistState();
  const watchlistItems = useMemo(() => {
    const q = debouncedQuery.toLowerCase();
    const list: DiscoverItem[] = watchlist
      .filter((w) => (kind === 'both' || w.itemType === kind) && (!q || w.name.toLowerCase().includes(q)))
      .map((w) => ({ id: w.itemId, type: w.itemType, name: w.name, poster: w.poster, releaseInfo: null, imdbRating: null, genres: [] }));
    if (watchlistSort === 'az') return [...list].sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [watchlist, kind, debouncedQuery, watchlistSort]);

  /* ---------------- What is on screen ---------------- */

  const creditIds = useMemo(() => (person?.results ?? []).map(creditImdb).filter(Boolean) as string[], [person, creditImdb]);
  const statusIds = useMemo(() => [
    ...items.map((i) => i.id),
    ...instantOnly.map((i) => i.id),
    ...(describeResults ?? []).map((i) => i.id),
    ...watchlistItems.map((i) => i.id),
    ...(householdPicks?.items ?? []).map((i) => i.id),
    ...recRows.flatMap((r) => r.items.map((i) => i.id)),
    ...simklTrending.map((i) => i.id),
    ...creditIds,
  ], [items, instantOnly, describeResults, watchlistItems, householdPicks, recRows, simklTrending, creditIds]);
  const { watchedStatus, toggleWatched: handleToggleWatched } = useWatchedStatusBatch(statusIds, enableWatchedIndicators);
  const ratingsById = useRatingsBatch(statusIds);
  const keepByWatched = useCallback(<T extends { id: string }>(list: T[]) => (
    watchedFilter === 'all' ? list : list.filter((i) => (watchedFilter === 'hide' ? !watchedStatus[i.id] : !!watchedStatus[i.id]))
  ), [watchedFilter, watchedStatus]);

  const shownItems = useMemo(() => {
    const kept = keepByWatched(items);
    if (debouncedQuery) return kept;
    if (sort === 'az') return [...kept].sort((a, b) => a.name.localeCompare(b.name));
    // Cinemeta's rated list is not strictly in score order. Everything loaded
    // is put in order by the IMDb score the title's own page shows (the same
    // batch as the poster badges), the catalog's score until that arrives,
    // and titles with no score last.
    if (sort === 'rated') {
      const score = (i: DiscoverItem) => {
        const n = Number.parseFloat(ratingsById[i.id]?.imdbRating ?? i.imdbRating ?? '');
        return Number.isFinite(n) ? n : -1;
      };
      return [...kept].sort((a, b) => score(b) - score(a));
    }
    return kept;
  }, [items, keepByWatched, sort, debouncedQuery, ratingsById]);
  const shownWatchlist = useMemo(() => {
    const kept = keepByWatched(watchlistItems);
    return watchlistSort === 'first' ? [...kept].reverse() : kept;
  }, [watchlistItems, keepByWatched, watchlistSort]);
  const credits = useMemo(() => {
    const list = (person?.results ?? []).filter((r) => { const id = creditImdb(r); return !unseenOnly || !(id && watchedStatus[id]); });
    if (personSort === 'popular') return [...list].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    // A title with no year yet (announced, not out) goes last either way.
    const y = (r: PersonSearchResult) => yearOf(r.year) || (personSort === 'newest' ? -1 : 9999);
    return [...list].sort((a, b) => (personSort === 'newest' ? y(b) - y(a) : y(a) - y(b)));
  }, [person, unseenOnly, watchedStatus, personSort, creditImdb]);

  const handleMarkNotInterested = useCallback(async (item: PosterCardItem) => {
    // Out of the rows at once, rather than refetching and reshuffling them all.
    setRecRows((prev) => prev.map((row) => ({ ...row, items: row.items.filter((i) => i.id !== item.id) })));
    setHouseholdPicks((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev));
    try {
      await api.markNotInterested(item.id, item.type);
      toast.success(`Won't recommend "${item.name}" again`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update');
    }
  }, []);

  // Surprise me: something from what is showing that nobody here has
  // watched, and when everything showing has been seen, something Popular.
  const surpriseSeen = useRef(new Set<string>());
  const surprise = useCallback(async () => {
    const pool: PosterCardItem[] = (lens === 'nobody' ? householdPicks?.items
      : lens === 'foryou' ? recRows.flatMap((r) => r.items)
        : lens === 'watchlist' ? watchlistItems : items) ?? [];
    let pick = pickSurprise(pool.filter((i) => !watchedStatus[i.id]), surpriseSeen.current);
    if (!pick) {
      const { items: popular } = await api.discoverPage(kind, { catalog: 'top' });
      pick = pickSurprise(popular.filter((i) => !watchedStatus[i.id]), surpriseSeen.current);
    }
    if (!pick) { toast.error('Nothing new to suggest right now'); return; }
    surpriseSeen.current.add(pick.id);
    setDetailItem(pick);
  }, [lens, householdPicks, recRows, watchlistItems, items, watchedStatus, kind]);

  /* ---------------- Controls ---------------- */

  const sortPop = usePopover();
  const filtersPop = usePopover();
  const titleFilters = lens === 'titles';
  const hasFilters = lens !== 'people' && enableWatchedIndicators || titleFilters;
  const watchedOptions: Array<{ key: WatchedFilter; label: string }> = lens === 'foryou' || lens === 'nobody'
    ? [{ key: 'all', label: 'Show everything' }, { key: 'hide', label: 'Hide watched' }]
    : [{ key: 'all', label: 'Show everything' }, { key: 'hide', label: 'Hide watched' }, { key: 'only', label: 'Only watched' }];
  const filterCount = (titleFilters ? (genre ? 1 : 0) + (decade ? 1 : 0) + (minRating ? 1 : 0) + (length ? 1 : 0) : 0) + (watchedFilter !== 'all' ? 1 : 0);
  const clearFilters = () => { setGenre(''); setDecade(null); setMinRating(null); setLength(null); setWatchedFilter('all'); };
  const applied: Array<{ key: string; label: string; clear: () => void }> = [
    ...(titleFilters && genre ? [{ key: 'genre', label: genre, clear: () => setGenre('') }] : []),
    ...(titleFilters && decade ? [{ key: 'decade', label: DECADES.find((d) => d.key === decade)?.label ?? decade, clear: () => setDecade(null) }] : []),
    ...(titleFilters && minRating ? [{ key: 'rating', label: `Rated ${minRating}+`, clear: () => setMinRating(null) }] : []),
    ...(titleFilters && length ? [{ key: 'length', label: LENGTHS.find((l) => l.key === length)?.label ?? length, clear: () => setLength(null) }] : []),
    ...(watchedFilter !== 'all' && lens !== 'people' ? [{ key: 'watched', label: watchedFilter === 'hide' ? 'Hide watched' : 'Only watched', clear: () => setWatchedFilter('all') }] : []),
  ];
  const sortOptions: Array<{ key: string; label: string }> | null = lens === 'titles' && !debouncedQuery ? sorts : lens === 'watchlist' ? WATCHLIST_SORTS : null;
  const sortValue = lens === 'watchlist' ? watchlistSort : sort;
  const sortLabel = sortOptions?.find((o) => o.key === sortValue)?.label ?? '';
  const pickSort = (key: string) => {
    if (lens === 'watchlist') setWatchlistSort(key as WatchlistSort);
    else setSort(key as SortKey);
    sortPop.setOpen(false);
  };

  const lensesAvail: Array<{ key: Lens; label: string; count?: number }> = [
    { key: 'titles', label: 'Titles' },
    // TV has no search box to type a name in; a person opened from a title's cast still shows.
    ...(!isTV || lens === 'people' ? [{ key: 'people' as const, label: 'People' }] : []),
    ...(enableRecommendations ? [{ key: 'foryou' as const, label: 'For you' }, { key: 'nobody' as const, label: 'Nobody’s seen it' }] : []),
    ...(enableWatchlist ? [{ key: 'watchlist' as const, label: 'Watchlist', count: watchlist.length }] : []),
  ];
  // Arrange (v2): the lenses can be put in another order or hidden, and each
  // lens's rows can be moved, folded and hidden. Rows are saved per lens.
  const lensArrange = usePageArrangement('discover-lenses', lensesAvail.map((l) => l.key), { layout: 'tiles' });
  const lenses = v2 ? lensArrange.shown.map((k) => lensesAvail.find((l) => l.key === k)!).filter(Boolean) : lensesAvail;
  useEffect(() => {
    if (v2 && lenses.length > 0 && !lenses.some((l) => l.key === lens)) setLens(lenses[0].key);
  }, [v2, lenses, lens]);
  const libraryOn = instantOnly.length > 0 && !describing;
  const airingOn = seasonalAnime.length > 0 || !!seasonalUnavailable;
  const trendingOn = keepByWatched(simklTrending).length > 0;
  const sagasOn = kind !== 'series' && sagas.length > 0;
  const rowKeys = !v2 ? [] : lens === 'titles' ? ['library', 'grid']
    : lens === 'foryou' ? ['airing', 'trending', 'sagas', ...recRows.map((_, i) => `rec-${i}`)]
      : lens === 'nobody' ? ['house'] : lens === 'watchlist' ? ['watchlist'] : [];
  const rowEmpty = !v2 ? [] : lens === 'titles' ? (libraryOn ? [] : ['library'])
    : lens === 'foryou' ? [
      ...(airingOn ? [] : ['airing']), ...(trendingOn ? [] : ['trending']), ...(sagasOn ? [] : ['sagas']),
      ...recRows.flatMap((r, i) => (keepByWatched(r.items).length === 0 ? [`rec-${i}`] : [])),
    ] : [];
  const rowsArrange = usePageArrangement(`discover-${lens}`, rowKeys, { empty: rowEmpty });
  // One Arrange button and bar for the page: it arranges the lenses and the rows together.
  const lensArranging = lensArrange.arranging;
  const setLensArranging = lensArrange.setArranging;
  useEffect(() => {
    if (lensArranging !== rowsArrange.arranging) setLensArranging(rowsArrange.arranging);
  }, [lensArranging, rowsArrange.arranging, setLensArranging]);
  const arrangeAll = {
    ...rowsArrange,
    reset: () => { rowsArrange.reset(); lensArrange.reset(); },
    isDefault: rowsArrange.isDefault && lensArrange.isDefault,
  };
  const arranging = v2 && rowsArrange.arranging;
  // On a phone the tabs sit in rows of equal buttons, never a strip to swipe:
  // five go three and two, four go two and two.
  const lensSpan = (i: number) => {
    const n = lenses.length;
    if (n === 5) return i < 3 ? 2 : 3;
    if (n === 4) return 3;
    return 6 / Math.max(1, n);
  };

  const filtersBody = (
    <>
      {titleFilters && (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Genre</span>
            <div className="flex flex-wrap gap-1.5">
              <Pill on={!genre} onClick={() => setGenre('')}>Any</Pill>
              {GENRES.map((g) => <Pill key={g} on={genre === g} onClick={() => setGenre(g)}>{g}</Pill>)}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Decade</span>
            <div className="flex flex-wrap gap-1.5">
              <Pill on={!decade} onClick={() => setDecade(null)}>Any</Pill>
              {DECADES.map((d) => <Pill key={d.key} on={decade === d.key} onClick={() => setDecade(d.key)}>{d.label}</Pill>)}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Rating</span>
            <div className="flex flex-wrap gap-1.5">
              <Pill on={!minRating} onClick={() => setMinRating(null)}>Any</Pill>
              {RATINGS.map((r) => <Pill key={r} on={minRating === r} onClick={() => setMinRating(r)}>{r}+</Pill>)}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Length</span>
            <div className="flex flex-wrap gap-1.5">
              <Pill on={!length} onClick={() => setLength(null)}>Any</Pill>
              {LENGTHS.map((l) => <Pill key={l.key} on={length === l.key} onClick={() => setLength(l.key)}>{l.label}</Pill>)}
            </div>
          </div>
        </>
      )}
      {enableWatchedIndicators && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Watched</span>
          <div className="flex flex-wrap gap-1.5">
            {watchedOptions.map((o) => <Pill key={o.key} on={watchedFilter === o.key} onClick={() => setWatchedFilter(o.key)}>{o.label}</Pill>)}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
        <button type="button" onClick={clearFilters} disabled={filterCount === 0} className="text-sm font-medium disabled:opacity-40" style={{ color: 'var(--color-primary)' }}>Clear all</button>
        <button type="button" onClick={() => filtersPop.setOpen(false)} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--color-primary-solid)' }}>Done</button>
      </div>
    </>
  );

  const sortFilters = !isTV && (sortOptions || hasFilters) ? (
      <div className="relative flex items-center gap-2 w-full sm:w-auto sm:ml-auto">
        {sortOptions && (
          <div ref={sortPop.ref} className="flex-1 sm:flex-none sm:relative">
            <button
              type="button"
              onClick={() => sortPop.setOpen(!sortPop.open)}
              aria-expanded={sortPop.open}
              className="w-full h-10 sm:h-9 px-3.5 sm:px-3 rounded-xl sm:rounded-[10px] text-sm font-medium text-default inline-flex items-center justify-between sm:justify-start gap-1.5"
              style={{ background: 'var(--color-surface-hover)' }}
            >
              <span><span className="text-muted">Sort</span> {sortLabel}</span>
              <ChevronDownIcon className="w-3.5 h-3.5" />
            </button>
            {sortPop.open && (
              <div ref={sortPop.fit} className="absolute left-0 right-0 sm:left-auto sm:right-0 top-full mt-2 z-30 sm:w-52 p-1.5 rounded-2xl overflow-y-auto" style={panelStyle}>
                {sortOptions.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => pickSort(o.key)}
                    className={`w-full h-10 px-3 rounded-lg text-sm text-left flex items-center justify-between ${sortValue === o.key ? 'text-default' : 'text-muted hover:text-default hover:bg-surface-hover'}`}
                  >
                    {o.label}
                    {sortValue === o.key && <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {hasFilters && (
          <div ref={filtersPop.ref} className={sortOptions ? 'sm:relative' : 'flex-1 sm:flex-none sm:relative'}>
            <button
              type="button"
              onClick={() => filtersPop.setOpen(!filtersPop.open)}
              aria-expanded={filtersPop.open}
              aria-label={filterCount > 0 ? `Filters, ${filterCount} on` : 'Filters'}
              className={`relative h-10 sm:h-9 ${sortOptions ? 'w-10 sm:w-auto justify-center' : 'w-full sm:w-auto justify-between sm:justify-start'} sm:pl-3 sm:pr-2 px-3 rounded-xl sm:rounded-[10px] text-sm font-medium text-default inline-flex items-center gap-2 disc-filters-btn ${filtersPop.open ? 'is-open' : ''}`}
              data-open={filtersPop.open || undefined}
            >
              <AdjustmentsHorizontalIcon className="w-5 h-5 sm:w-4 sm:h-4" />
              <span className={sortOptions ? 'hidden sm:inline' : ''}>Filters</span>
              {filterCount > 0 && (
                <span className={`min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold inline-flex items-center justify-center text-white ${sortOptions ? 'absolute -top-1.5 -right-1.5 sm:static' : ''}`} style={{ background: 'var(--color-primary-solid)' }}>{filterCount}</span>
              )}
            </button>
            {filtersPop.open && (
              <div ref={filtersPop.fit} data-filters-panel className="absolute left-0 right-0 sm:left-auto sm:right-0 top-full mt-2 z-30 sm:w-[min(560px,92vw)] p-5 rounded-2xl flex flex-col gap-4 overflow-y-auto overscroll-contain" style={panelStyle}>
                {filtersBody}
              </div>
            )}
          </div>
        )}
{!v2 && (
          <button type="button" onClick={() => { void surprise(); }} aria-label="Surprise me" className="sm:hidden h-10 w-10 shrink-0 rounded-xl inline-flex items-center justify-center text-default" style={{ background: 'var(--color-surface-hover)' }}>
          <ArrowsRightLeftIcon className="w-5 h-5" />
        </button>
)}
      </div>
  ) : null;

  const Wrapper = isTV ? TVPageProvider : Fragment;
  const surpriseButton = (
    <div className="flex items-center gap-2 flex-wrap">
      <ArrangeButton arrange={arrangeAll} />
      <V2Button onClick={() => { void surprise(); }} icon={<ArrowsRightLeftIcon className="w-4 h-4" />}>Surprise me</V2Button>
    </div>
  );
  const spinner = (
    <div className="flex items-center justify-center py-24 text-muted">
      <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
    </div>
  );
  // The first two rows of the grid on screen: fetched at once, ahead of the rest.
  const firstIds = useMemo(() => {
    const lead = lens === 'titles' ? (describing ? describeResults ?? [] : shownItems)
      : lens === 'watchlist' ? shownWatchlist
        : lens === 'nobody' ? householdPicks?.items ?? []
          : recRows[0]?.items ?? [];
    return new Set(lead.slice(0, 16).map((i) => i.id));
  }, [lens, describing, describeResults, shownItems, shownWatchlist, householdPicks, recRows]);
  const card = (item: PosterCardItem, key: string, notInterested = false) => (
    <PosterCard
      key={key}
      item={item}
      priority={firstIds.has(item.id)}
      ratings={ratingsById[item.id]}
      watched={watchedStatus[item.id]}
      inWatchlist={inWatchlistIds.has(item.id)}
      showWatchlistMenu={enableWatchlist}
      showWatchlistBadge={enableWatchlist}
      showWatchedMenu={enableWatchedIndicators}
      showWatchedBadge={enableWatchedIndicators}
      showNotInterested={notInterested}
      onMarkNotInterested={notInterested ? handleMarkNotInterested : undefined}
      onOpenDetails={setDetailItem}
      onToggleWatchlist={handleToggleWatchlist}
      onToggleWatched={handleToggleWatched}
      isMenuOpen={openMenuKey === key}
      menuKey={key}
      onMenuOpenChange={handleMenuOpenChange}
      focusable={isTV}
    />
  );
  const emptyNote = (text: string, Icon = MagnifyingGlassIcon) => (
    <div className="text-center py-24 text-muted">
      <Icon className="w-10 h-10 mx-auto mb-3 text-subtle" />
      <p>{text}</p>
      {filterCount > 0 && <button type="button" onClick={clearFilters} className="mt-3 text-sm font-medium" style={{ color: 'var(--color-primary)' }}>Clear filters</button>}
    </div>
  );
  const watchedNote = watchedFilter === 'hide' ? 'Hiding what you’ve watched' : watchedFilter === 'only' ? 'Only what you’ve watched' : enableWatchedIndicators ? '✓ marks what you’ve seen' : '';
  const rowHeading = (title: React.ReactNode, note?: React.ReactNode) => (
    <div className="flex items-baseline gap-2 mb-3 flex-wrap">
      {v2 ? <h2 className="text-lg font-semibold">{title}</h2> : <h3 className="text-base font-semibold font-display text-default">{title}</h3>}
      {note}
    </div>
  );
  // v2 titles each part of a lens the way the other v2 pages title their sections.
  const sectionTitle = v2 ? 'text-lg font-semibold' : 'text-lg sm:text-xl font-semibold font-display text-default';
  // One row of a lens: in v2 a section that can be moved, folded and hidden (and sized); in Classic the plain heading and body.
  const gridAttrs = (id: string) => (v2 ? rowsArrange.cardAttrs(id) : {});
  const gridHandle = (id: string, label: string) => (v2 ? <StretchHandle arrange={rowsArrange} id={id} kind="posters" label={label} /> : null);
  const row = (id: string, title: string, note: React.ReactNode, body: React.ReactNode, o: { cards?: boolean; mb?: string; actions?: React.ReactNode; empty?: string } = {}) => (
    v2 ? (
      <ArrangeSection
        key={id} arrange={rowsArrange} id={id} title={title} meta={note} cards={o.cards} actions={o.actions}
        emptyNote={rowsArrange.isEmpty(id) ? o.empty : undefined}
      >
        {body}
      </ArrangeSection>
    ) : (
      <div key={id} className={o.mb ?? 'mb-8'}>{rowHeading(title, note)}{body}</div>
    )
  );
  const gridCls = `${GRID} arrange-cardgrid`;
  const titlesHeading = describing ? 'From your description' : describeGrid({ sort, kind, genre, decade, minRating, length, query: debouncedQuery });
  const titlesDescribe = (
    <>
      {debouncedQuery && !isTV && (
        describing ? (
          <button type="button" onClick={() => { setDescribeResults(null); setDescribeError(null); }} className="text-sm font-medium" style={{ color: 'var(--color-primary)' }}>Back to title matches</button>
        ) : (
          <button type="button" onClick={() => { void runDescribe(); }} title="Describe a plot you half-remember - results are checked against TMDb, never invented" className="text-sm font-medium inline-flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
            <SparklesIcon className="w-4 h-4" />Not it? Describe it instead
          </button>
        )
      )}
    </>
  );
  const rowLabels: Record<string, string> = {
    library: 'From your library', grid: typeof titlesHeading === 'string' ? titlesHeading : 'Titles', airing: 'Airing this season', trending: 'Trending on SIMKL',
    sagas: 'Finish the saga', house: 'Nobody here has seen these', watchlist: 'Your watchlist',
    ...Object.fromEntries(recRows.map((r, i) => [`rec-${i}`, r.reason])),
  };

  return (
    <Wrapper>
      {layoutMode !== 'nebula' && (
        <Header
          title="Discover"
          subtitle={v2 ? 'Find something to watch for anyone in the house' : 'Browse or search for something to watch, then open it straight in Stremio or Nuvio'}
          actions={v2 ? surpriseButton : undefined}
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-4 md:p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && (v2
            ? <NebulaPageHeading title="Discover" subtitle="Find something to watch for anyone in the house" actions={surpriseButton} />
            : <h1 className="sr-only">Discover</h1>)}

          {v2 && <ArrangeBar arrange={arrangeAll} />}

          {/* The search, what kind, and Surprise me. TV has no search - typing on a remote isn't worth it. */}
          <div className="flex flex-wrap items-center gap-3">
            {!isTV && (
              <label className="flex-1 min-w-0 sm:min-w-[16rem] basis-full sm:basis-auto h-[52px] flex items-center gap-3 pl-4 pr-3 rounded-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
                <MagnifyingGlassIcon className="w-5 h-5 text-muted shrink-0" />
                <input
                  ref={searchRef}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // A sentence rather than a title is a description: Enter
                    // looks for what it describes.
                    if (e.key === 'Enter' && lens === 'titles' && searchQuery.trim().split(/\s+/).length >= 4) { e.preventDefault(); void runDescribe(); }
                  }}
                  placeholder={lens === 'people' ? 'Search a person' : lens === 'watchlist' ? 'Search your watchlist' : 'Search a title or a person, or describe it'}
                  aria-label="Search"
                  className="flex-1 min-w-0 bg-transparent outline-none text-default text-base"
                />
                {searchQuery ? (
                  <button type="button" onClick={() => setSearchQuery('')} aria-label="Clear search" className="p-1 rounded-md text-muted hover:text-default">
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                ) : (
                  <kbd className="h-[22px] min-w-[22px] px-1.5 rounded-md text-xs text-muted hidden sm:inline-flex items-center justify-center" style={{ border: '1px solid var(--color-surface-border)' }}>/</kbd>
                )}
              </label>
            )}
            <div role="group" aria-label="Kind" className="flex w-full sm:w-auto p-1 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
              {KINDS.map((k) => (
                <Focus key={k.key} tv={isTV} onEnter={() => setKind(k.key)}>
                  <button
                    type="button"
                    onClick={() => setKind(k.key)}
                    aria-pressed={kind === k.key}
                    className={`h-10 px-4 flex-1 sm:flex-none rounded-[10px] text-sm font-medium transition-colors ${kind === k.key ? 'text-default disc-choice-on' : 'text-muted hover:text-default'}`}
                  >
                    {k.label}
                  </button>
                </Focus>
              ))}
            </div>
            {v2 && sortFilters}
            {!v2 && <Focus tv={isTV} onEnter={() => { void surprise(); }}>
              <button type="button" onClick={() => { void surprise(); }} className="h-10 px-3.5 rounded-xl text-sm font-medium text-default hidden sm:inline-flex items-center gap-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
                <ArrowsRightLeftIcon className="w-4 h-4" />
                Surprise me
              </button>
            </Focus>}
          </div>

          {/* What you are looking through, and in what order and with what filters. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {arranging ? (
              <div className="w-full flex flex-wrap gap-2" role="group" aria-label="Arrange the lenses">
                {lenses.map((l) => (
                  <SortableItem key={l.key} scope={lensArrange.sort} itemKey={l.key}>
                    {(d) => (
                      <div
                        ref={d.ref as React.Ref<HTMLDivElement>}
                        style={d.style}
                        className={`arrange-section-on inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full ${d.className}`}

                      >
                        <ArrangeGrip drag={d} label={l.label} />
                        <span className="px-1 text-[15px] font-medium">{l.label}</span>
                        <button
                          type="button"
                          className="arrange-icon"
                          aria-label={`Hide ${l.label}`}
                          title={`Hide ${l.label}`}
                          disabled={lenses.length < 2}
                          onClick={() => lensArrange.hide(l.key)}
                        >
                          <EyeIcon className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            ) : v2 ? (
              <div className="w-full">
                <PageToolbar
                  animate={false}
                  filterTabs={{
                    options: lenses.map((l) => ({ key: l.key, label: l.label, count: l.count })),
                    activeKey: lens,
                    onChange: (key) => setLens(key as Lens),
                    layoutId: 'discover-lens-tabs',
                  }}
                />
              </div>
            ) : (
            <div className="grid grid-cols-6 gap-1.5 w-full sm:w-auto sm:flex sm:flex-wrap sm:gap-2">
              {lenses.map((l, i) => (
                <Focus key={l.key} tv={isTV} onEnter={() => setLens(l.key)}>
                  <button
                    type="button"
                    onClick={() => setLens(l.key)}
                    aria-pressed={lens === l.key}
                    className={`px-1.5 sm:px-4 py-2 sm:py-1.5 rounded-full text-[14px] sm:text-[15px] font-medium text-center whitespace-nowrap transition-colors ${lens === l.key ? 'text-default disc-choice-on' : 'text-muted hover:text-default'}`}
                    style={{ gridColumn: `span ${lensSpan(i)}` }}
                  >
                    {l.label}
                    {l.count ? <span className="ml-1.5 text-[11px] px-1.5 py-px rounded-full" style={{ background: 'rgba(255,255,255,.08)' }}>{l.count}</span> : null}
                  </button>
                </Focus>
              ))}
            </div>
            )}

            {!v2 && sortFilters}
          </div>

          {/* TV: the order and genre as rows of pills - a remote can't drive a popup. */}
          {isTV && lens === 'titles' && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">{sorts.map((o) => <Pill key={o.key} tv on={sort === o.key} onClick={() => setSort(o.key)}>{o.label}</Pill>)}</div>
              <div className="flex flex-wrap gap-2">
                <Pill tv on={!genre} onClick={() => setGenre('')}>All genres</Pill>
                {GENRES.map((g) => <Pill key={g} tv on={genre === g} onClick={() => setGenre(g)}>{g}</Pill>)}
              </div>
            </div>
          )}

          {applied.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {applied.map((a) => (
                <button key={a.key} type="button" onClick={a.clear} aria-label={`Remove ${a.label}`} className="h-7 pl-3 pr-1.5 rounded-full text-[13px] inline-flex items-center gap-1" style={{ background: 'color-mix(in srgb, var(--color-primary) 16%, transparent)', color: 'color-mix(in srgb, var(--color-primary) 40%, #ffffff)' }}>
                  {a.label}
                  <XMarkIcon className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          )}

          {/* ---------- Titles ---------- */}
          {lens === 'titles' && (
            <section className="mt-5" aria-label="Titles">
              {v2 ? rowsArrange.shown.map((id) => (id === 'library'
                ? row('library', 'From your library', null, (
                  <div className={gridCls} {...gridAttrs('library')}>{instantOnly.map((item) => card(item, `inst:${item.id}`))}{gridHandle('library', 'From your library')}</div>
                ), { cards: true, empty: 'From your library · shows when your library has a match' })
                : row('grid', typeof titlesHeading === 'string' ? titlesHeading : 'Titles', null, (
                  <>
              <p className="text-[13px] text-muted mb-4">{[describing ? 'Every one checked against TMDb, so nothing invented shows up' : debouncedQuery ? '' : sortInfo.about, watchedNote].filter(Boolean).join(' · ')}</p>
              {describing ? (
                describeBusy ? <p className="text-sm text-muted py-8 text-center">Working out what that could be…</p>
                  : describeError ? <p className="text-sm text-muted py-8 text-center max-w-lg mx-auto">{describeError}</p>
                    : <div className={GRID}>{keepByWatched(describeResults ?? []).map((item) => card(item, `desc:${item.id}`))}</div>
              ) : isLoading ? spinner : shownItems.length === 0 ? (
                emptyNote(filterCount > 0 ? 'Nothing here with these filters.' : 'No results found.')
              ) : (
                <>
                  {/* The one unbounded grid here - windowed, so only rows near the screen are real. */}
                  <VirtualPosterGrid items={shownItems} getKey={(item) => item.id} gridClassName={GRID} disabled={isTV} renderItem={(item) => card(item, `grid:${item.id}`)} />
                  {!debouncedQuery && (
                    <div className="mt-8 flex flex-col items-center justify-center gap-3 py-6">
                      {isLoadingMore && (
                        <div className="flex items-center gap-2 text-sm text-muted">
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Loading more…
                        </div>
                      )}
                      {!hasMore && shownItems.length >= 40 && <p className="text-xs text-muted">That’s everything this list has here.</p>}
                      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
                    </div>
                  )}
                </>
              )}
                  </>
                ), { actions: titlesDescribe })
              )) : (
                <>
              {instantOnly.length > 0 && !describing && (
                <div className="mb-6">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-2 text-muted">From your library</p>
                  <div className={GRID}>{instantOnly.map((item) => card(item, `inst:${item.id}`))}</div>
                </div>
              )}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className={`${sectionTitle} [text-wrap:balance]`}>
                  {describing ? 'From your description' : describeGrid({ sort, kind, genre, decade, minRating, length, query: debouncedQuery })}
                </h2>
                {debouncedQuery && !isTV && (
                  describing ? (
                    <button type="button" onClick={() => { setDescribeResults(null); setDescribeError(null); }} className="text-sm font-medium" style={{ color: 'var(--color-primary)' }}>Back to title matches</button>
                  ) : (
                    <button type="button" onClick={() => { void runDescribe(); }} title="Describe a plot you half-remember - results are checked against TMDb, never invented" className="text-sm font-medium inline-flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
                      <SparklesIcon className="w-4 h-4" />Not it? Describe it instead
                    </button>
                  )
                )}
              </div>
              <p className="text-[13px] text-muted mt-1 mb-4">{[describing ? 'Every one checked against TMDb, so nothing invented shows up' : debouncedQuery ? '' : sortInfo.about, watchedNote].filter(Boolean).join(' · ')}</p>
              {describing ? (
                describeBusy ? <p className="text-sm text-muted py-8 text-center">Working out what that could be…</p>
                  : describeError ? <p className="text-sm text-muted py-8 text-center max-w-lg mx-auto">{describeError}</p>
                    : <div className={GRID}>{keepByWatched(describeResults ?? []).map((item) => card(item, `desc:${item.id}`))}</div>
              ) : isLoading ? spinner : shownItems.length === 0 ? (
                emptyNote(filterCount > 0 ? 'Nothing here with these filters.' : 'No results found.')
              ) : (
                <>
                  {/* The one unbounded grid here - windowed, so only rows near the screen are real. */}
                  <VirtualPosterGrid items={shownItems} getKey={(item) => item.id} gridClassName={GRID} disabled={isTV} renderItem={(item) => card(item, `grid:${item.id}`)} />
                  {!debouncedQuery && (
                    <div className="mt-8 flex flex-col items-center justify-center gap-3 py-6">
                      {isLoadingMore && (
                        <div className="flex items-center gap-2 text-sm text-muted">
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Loading more…
                        </div>
                      )}
                      {!hasMore && shownItems.length >= 40 && <p className="text-xs text-muted">That’s everything this list has here.</p>}
                      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
                    </div>
                  )}
                </>
              )}
                </>
              )}
            </section>
          )}

          {/* ---------- People ---------- */}
          {lens === 'people' && (
            <section className="mt-5" aria-label="People">
              {!debouncedQuery ? emptyNote('Type a name to see everything they’ve been in.', UserIcon)
                : personLoading ? spinner
                  : !person && peopleNoKey ? emptyNote('Looking people up needs a TMDb key or a LumiereDB - add one in Settings.', UserIcon)
                  : !person ? emptyNote(`No one found by that name${kind === 'both' ? '' : ` with ${kind === 'series' ? 'shows' : 'movies'} to show`}.`, UserIcon)
                    : (
                      <>
                        {/* Who they are, on the card itself: what they do, born
                            when and where, and two or three sentences. */}
                        <div className="relative overflow-hidden flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6 p-5 sm:p-6 mb-5 rounded-2xl border border-default text-center sm:text-left" style={{ background: 'linear-gradient(120deg, color-mix(in srgb, var(--color-primary) 22%, var(--color-surface)), var(--color-surface) 60%)' }}>
                          {person.person.profile ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={person.person.profile} alt={person.person.name} className="w-[104px] h-[104px] sm:w-[132px] sm:h-[132px] rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="w-[104px] h-[104px] sm:w-[132px] sm:h-[132px] rounded-full flex items-center justify-center text-4xl font-bold shrink-0" style={{ background: 'var(--color-surface-hover)' }}>{person.person.name.slice(0, 1)}</div>
                          )}
                          <div className="min-w-0 flex-1 flex flex-col gap-3">
                            <h2 className="text-[28px] sm:text-[38px] leading-tight font-bold text-default font-display" style={{ letterSpacing: '-0.01em' }}>{person.person.name}</h2>
                            {(() => {
                              const facts = [
                                { text: workAsPerson(person.person.knownFor), Icon: UserIcon },
                                { text: bornLine(person.person), Icon: CalendarDaysIcon },
                                { text: person.person.placeOfBirth ?? null, Icon: MapPinIcon },
                              ].filter((f) => f.text);
                              return facts.length > 0 && (
                                <div className="flex flex-wrap justify-center sm:justify-start gap-x-6 gap-y-2">
                                  {facts.map(({ text, Icon }) => (
                                    <span key={text} className="flex items-center gap-2 text-[15px] sm:text-[17px] font-medium text-default">
                                      <Icon className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--color-primary)' }} aria-hidden />
                                      {text}
                                    </span>
                                  ))}
                                </div>
                              );
                            })()}
                            {person.person.bio && <p className="text-[15px] sm:text-[17px] leading-relaxed text-default" style={{ maxWidth: 720, opacity: 0.9 }}>{person.person.bio}</p>}
                            {(() => {
                              // Where the facts came from, and a way to read more: nothing
                              // when TMDb had it all and there is no IMDb page to offer. The
                              // IMDb link leaves the app, so it is not on TV.
                              const said = person.person.factsFrom === 'wikipedia' ? wikipediaLine(person.person.factsFilled) : null;
                              const none = !person.person.bio && person.source !== 'lumiere' ? 'No biography yet on TMDb or Wikipedia.' : null;
                              const note = said && none ? `${said}. ${none}` : said || none;
                              const imdb = !isTV && person.person.imdbId ? `https://www.imdb.com/name/${person.person.imdbId}/` : null;
                              if (!note && !imdb) return null;
                              return (
                                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 text-[14px] text-muted">
                                  {note && <span>{note}</span>}
                                  {imdb && (
                                    <a href={imdb} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-default text-default font-semibold no-underline hover:opacity-80">
                                      IMDb page ↗
                                    </a>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="flex flex-col items-center sm:items-end gap-3 shrink-0">
                            <span className="text-[17px] font-semibold text-default">{person.results.length} title{person.results.length === 1 ? '' : 's'}</span>
                            <div className="flex flex-wrap justify-center sm:justify-end gap-2">
                              {(['popular', 'newest', 'oldest'] as const).map((k) => (
                                <Pill key={k} tv={isTV} on={personSort === k} onClick={() => setPersonSort(k)}>{k === 'popular' ? 'Most popular' : k === 'newest' ? 'Newest' : 'Oldest'}</Pill>
                              ))}
                            </div>
                            {enableWatchedIndicators && <Pill tv={isTV} on={unseenOnly} onClick={() => setUnseenOnly(!unseenOnly)}>Only what I haven’t seen</Pill>}
                            {followId && (
                              <Focus tv={isTV} onEnter={() => { void toggleFollow(); }}>
                                <button
                                  type="button"
                                  onClick={() => { void toggleFollow(); }}
                                  disabled={followBusy}
                                  title={!personFollow ? `Follow ${person.person.name} - hear when they have something new out` : personFollow.muted ? 'Alerts muted - tap to turn them back on' : 'Following - tap to mute'}
                                  className={`h-8 px-3 rounded-full text-[13px] font-semibold inline-flex items-center gap-1.5 ${personFollow && !personFollow.muted ? 'disc-follow-on' : 'disc-follow-off'}`}
                                >
                                  <BellIcon className="w-4 h-4" />
                                  {!personFollow ? 'Follow' : personFollow.muted ? 'Muted' : 'Following'}
                                </button>
                              </Focus>
                            )}
                          </div>
                        </div>
                        {credits.length === 0 ? emptyNote('You’ve seen everything they’ve been in.') : (
                          <div className={GRID}>
                            {credits.map((r) => {
                              const id = creditImdb(r);
                              const seen = !!(id && watchedStatus[id]);
                              return (
                                <Focus key={`${r.mediaType}-${r.imdbId ?? r.tmdbId}`} tv={isTV} onEnter={() => { void openCredit(r); }}>
                                  <button type="button" onClick={() => { void openCredit(r); }} title={`${r.title}${r.role ? ` · ${r.role}` : ''}`} className="text-left group/pr min-w-0">
                                    <div className="relative aspect-[2/3] rounded-xl overflow-hidden shadow-lg" style={{ background: 'var(--color-surface-hover)' }}>
                                      {r.poster ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={r.poster} alt={r.title} loading="lazy" className="w-full h-full object-cover transition-transform group-hover/pr:scale-105" />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center text-muted text-xs p-2 text-center">{r.title}</div>
                                      )}
                                      {seen && enableWatchedIndicators && (
                                        <span className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: 'var(--color-success)' }} aria-label="Watched">
                                          <CheckIcon className="w-4 h-4 text-white" />
                                        </span>
                                      )}
                                    </div>
                                    <p className="mt-1.5 text-[13px] font-medium text-default leading-tight line-clamp-2 text-center group-hover/pr:text-primary transition-colors">{r.title}</p>
                                    <p className="text-[11px] text-subtle text-center">{[r.year, r.mediaType === 'tv' ? 'Show' : 'Movie'].filter(Boolean).join(' · ')}</p>
                                  </button>
                                </Focus>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
            </section>
          )}

          {/* ---------- For you ---------- */}
          {lens === 'foryou' && (
            <section className="mt-5" aria-label="For you">
              {recUsers.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-5">
                  {(recUsers.length > 1 ? (['personal', 'shared'] as const) : (['personal'] as const)).map((m) => (
                    <Pill key={m} tv={isTV} on={recMode === m} onClick={() => setRecMode(m)}>{m === 'personal' ? 'Personal' : 'Shared with…'}</Pill>
                  ))}
                  {isTV ? recUsers.map((u) => <Pill key={u.id} tv on={recUserId === u.id} onClick={() => setRecUserId(u.id)}>{u.name || u.username}</Pill>) : (
                    <label className={v2 ? 'v2-btn' : undefined}>
                      {v2 && <span className="text-muted">For</span>}
                      <select value={recUserId} onChange={(e) => setRecUserId(e.target.value)} aria-label={recMode === 'personal' ? 'Show recommendations for' : 'First person'} className={v2 ? 'bg-transparent text-default border-0 outline-none cursor-pointer font-medium' : 'h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer bg-surface-hover text-default border-0'}>
                        {recUsers.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                      </select>
                    </label>
                  )}
                  {recMode === 'shared' && (
                    <>
                      {!v2 && <span className="text-sm text-muted">and</span>}
                      {isTV ? recUsers.filter((u) => u.id !== recUserId).map((u) => <Pill key={u.id} tv on={recUserId2 === u.id} onClick={() => setRecUserId2(u.id)}>{u.name || u.username}</Pill>) : (
                        <label className={v2 ? 'v2-btn' : undefined}>
                          {v2 && <span className="text-muted">and</span>}
                          <select value={recUserId2} onChange={(e) => setRecUserId2(e.target.value)} aria-label="Second person" className={v2 ? 'bg-transparent text-default border-0 outline-none cursor-pointer font-medium' : 'h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer bg-surface-hover text-default border-0'}>
                            {recUsers.filter((u) => u.id !== recUserId).map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                </div>
              )}

              {rowsArrange.shown.filter((id) => !id.startsWith('rec-')).map((id) => {
                if (id === 'airing') {
                  if (!airingOn && !arranging) return null;
                  return seasonalAnime.length === 0
                    ? row(id, 'Airing this season', null, <p className="text-xs text-muted">{seasonalUnavailable}</p>, { mb: 'mb-6', empty: 'Airing this season · shows when something is airing' })
                    : row(id, 'Airing this season', <span className="text-xs text-muted">Anime airing now, newest episodes first</span>, (
                      <ScrollRow className="flex gap-3 pb-2 -mx-1 px-1">
                    {seasonalAnime.map((a) => (
                      <button key={a.anilistId} type="button" onClick={() => { setSearchQuery(a.name); setLens('titles'); }} className="w-32 sm:w-36 shrink-0 text-left group" title={`Search Discover for ${a.name}`}>
                        <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface-hover shadow-xl">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {a.poster ? <img src={a.poster} alt={a.name} loading="lazy" decoding="async" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" /> : <div className="w-full h-full flex items-center justify-center text-xs text-subtle">No art</div>}
                          {a.nextEpisode && (
                            <span className="absolute bottom-1 left-1 right-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-center truncate" style={{ background: 'rgba(0,0,0,0.72)', color: '#fff' }}>
                              Ep {a.nextEpisode.episode} in {a.nextEpisode.label}
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-1.5 truncate text-default">{a.name}</p>
                        <p className="text-[11px] text-muted truncate">{a.episodes ? `${a.episodes} eps` : a.format || ''}{a.score ? ` · ${a.score}%` : ''}</p>
                      </button>
                    ))}
                  </ScrollRow>
                    ), { empty: 'Airing this season · shows when something is airing' });
                }
                if (id === 'trending') {
                  return row(id, 'Trending on SIMKL', null, (
                    <ScrollRow className="flex gap-3 pb-2 -mx-1 px-1">
                    {keepByWatched(simklTrending).map((item) => <div key={item.id} className="w-32 sm:w-36 shrink-0">{card(item, `trend:${item.id}`)}</div>)}
                  </ScrollRow>
                  ), { empty: 'Trending on SIMKL · shows when there is something trending' });
                }
                if (id === 'sagas') {
                  return row(id, 'Finish the saga', null, (
                    <div className="space-y-8">
                      {sagas.map((saga) => (
                    <div key={saga.collectionId}>
                      {rowHeading(v2 ? saga.name : `Finish the saga: ${saga.name}`, <span className="text-xs text-muted">· watched {saga.watchedCount} of {saga.total}{saga.unwatched.length === 1 ? ' - one to go' : ''}</span>)}
                      <div className={v2 ? gridCls : GRID}>
                        {saga.unwatched.map((part) => card({ id: part.id, type: 'movie', name: part.title, poster: part.poster, releaseInfo: part.releaseYear }, `saga:${part.id}`))}
                      </div>
                    </div>
                  ))}

                    </div>
                  ), { cards: false, empty: 'Finish the saga · shows when a collection is partly watched' });
                }
                return null;
              })}

              {!recsLoaded ? spinner : recRows.length === 0 ? (
                <div className="text-center py-16 text-muted"><p>No recommendations yet - watch a few things first, and we’ll suggest more.</p></div>
              ) : (
                <div className={v2 ? '' : 'space-y-8'}>
                  {recRows.map((r, ri) => {
                    const id = `rec-${ri}`;
                    if (!rowsArrange.shown.includes(id)) return null;
                    const visible = keepByWatched(r.items);
                    if (visible.length === 0 && !arranging) return null;
                    return row(id, r.reason, (
                      <>
                        {r.hasRealSignal && (
                          <Badge variant="primary" size="sm" icon={<SparklesIcon className="w-3 h-3" />} title="Backed by real watch-time overlap in your household, not just this title's own score">Real match</Badge>
                        )}
                        <span className="text-xs text-muted">· Top rated {r.genre}</span>
                      </>
                    ), (
                      <div className={v2 ? gridCls : GRID} {...gridAttrs(id)}>{visible.map((item) => card(item, `rec:${ri}:${item.id}`, true))}{gridHandle(id, 'these titles')}</div>
                    ), { cards: true, mb: '', empty: `${r.reason} · nothing left to show here` });
                  })}
                  <p className="text-xs text-muted italic text-center pt-2">
                    Rows come from the genres you actually spend the most time watching (weighted toward recent viewing), plus what’s on your Watchlist, and they shift as your habits do.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* ---------- Nobody's seen it ---------- */}
          {lens === 'nobody' && (
            <section className="mt-5" aria-label="Nobody's seen it">
              {!picksLoaded ? spinner : !householdPicks || keepByWatched(householdPicks.items).length === 0 ? (
                <div className="text-center py-24 text-muted"><p>Nothing to suggest yet - once a few people here have watched things, this fills with what none of you has seen.</p></div>
              ) : (
                v2 ? rowsArrange.shown.map((id) => id === 'house' && row(id, 'Nobody here has seen these', (
                  <>
                    {householdPicks.sharedAppeal && householdPicks.memberCount > 1 && (
                      <Badge variant="primary" size="sm" icon={<SparklesIcon className="w-3 h-3" />} title="In genres several people here like">House pick</Badge>
                    )}
                  </>
                ), (
                  <>
                    <p className="text-[13px] text-muted mb-3">{householdPicks.genres.join(', ')}, the genres the house likes</p>
                    <div className={gridCls} {...gridAttrs('house')}>{keepByWatched(householdPicks.items).map((item) => card(item, `house:${item.id}`, true))}{gridHandle('house', 'For the household')}</div>
                  </>
                ), { cards: true })) : (
                <>
                  <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                    <h2 className={sectionTitle}>Nobody here has seen these</h2>
                    {householdPicks.sharedAppeal && householdPicks.memberCount > 1 && (
                      <Badge variant="primary" size="sm" icon={<SparklesIcon className="w-3 h-3" />} title="In genres several people here like">House pick</Badge>
                    )}
                  </div>
                  <p className="text-[13px] text-muted mb-4">{householdPicks.genres.join(', ')}, the genres the house likes</p>
                  <div className={GRID}>{keepByWatched(householdPicks.items).map((item) => card(item, `house:${item.id}`, true))}</div>
                </>
               )
              )}
            </section>
          )}

          {/* ---------- Watchlist ---------- */}
          {lens === 'watchlist' && (
            <section className="mt-5" aria-label="Watchlist">
              {!watchlistLoaded ? spinner : watchlist.length === 0 ? emptyNote('Your watchlist is empty. Add titles with the bookmark on any poster.')
                : shownWatchlist.length === 0 ? emptyNote('Nothing on your watchlist matches this view.')
                  : (
                    v2 ? rowsArrange.shown.map((id) => id === 'watchlist' && row(id, 'Your watchlist', null, (
                      <>
                        <p className="text-[13px] text-muted mb-3">{[`${shownWatchlist.length} title${shownWatchlist.length === 1 ? '' : 's'}`, watchedNote].filter(Boolean).join(' · ')}</p>
                        <div className={gridCls} {...gridAttrs('watchlist')}>{shownWatchlist.map((item) => card(item, `wl:${item.id}`))}{gridHandle('watchlist', 'Watchlist')}</div>
                      </>
                    ), { cards: true })) : (
                    <>
                      <h2 className={sectionTitle}>Your watchlist</h2>
                      <p className="text-[13px] text-muted mt-1 mb-4">{[`${shownWatchlist.length} title${shownWatchlist.length === 1 ? '' : 's'}`, watchedNote].filter(Boolean).join(' · ')}</p>
                      <div className={GRID}>{shownWatchlist.map((item) => card(item, `wl:${item.id}`))}</div>
                    </>
                   )
                  )}
            </section>
          )}
          {v2 && (
            <HiddenTray
              arrange={arrangeAll}
              labelOf={(id) => (rowLabels[id] || id)}
              extra={lensArrange.hidden.map((k) => ({ id: `lens-${k}`, label: lensesAvail.find((l) => l.key === k)?.label || k, show: () => lensArrange.show(k) }))}
            />
          )}
        </div>
      </div>

      {detailItem && (
        <MediaDetailModal
          isOpen={!!detailItem}
          onClose={() => setDetailItem(null)}
          itemId={detailItem.id}
          itemType={detailItem.type}
          fallbackTitle={detailItem.name}
          fallbackPoster={detailItem.poster}
          fallbackRating={detailItem.imdbRating}
          fallbackReleaseInfo={detailItem.releaseInfo}
          fallbackRottenTomatoes={ratingsById[detailItem.id]?.rottenTomatoes}
          fallbackMetacritic={ratingsById[detailItem.id]?.metacritic}
          onWatchlistChange={(id, next) => applyWatchlistChange(id, detailItem, next)}
        />
      )}
    </Wrapper>
  );
}
