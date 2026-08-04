'use client';

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { Header } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { PageToolbar, MediaDetailModal, PageToolbarProps, Badge, PosterCard, PosterCardItem } from '@/components/ui';
import { api, DiscoverItem, RecommendationRow, User } from '@/lib/api';
import { useRatingsBatch } from '@/lib/hooks/useRatingsBatch';
import { useWatchlistState } from '@/lib/hooks/useWatchlistState';
import { useWatchedStatusBatch } from '@/lib/hooks/useWatchedStatusBatch';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { FilmIcon, TvIcon, MagnifyingGlassIcon, SparklesIcon, UserIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { TVFocusable } from '@/components/tv/TVFocusable';

// Only "top" (Popular) supports search per Cinemeta's own manifest - "year"
// and "imdbRating" only support genre/skip. Browse-mode catalog picker is
// hidden entirely once a search is active, since it wouldn't apply anyway.
const CATALOGS = [
  { key: 'top', label: 'Popular' },
  { key: 'year', label: 'New' },
  { key: 'imdbRating', label: 'Top Rated' },
];

// Cinemeta's catalogs accept these genre extras verbatim (documented in the
// v3-cinemeta manifest.json's genres array). Kept flat here rather than
// fetching from the manifest at load time — the list is stable and adding
// a network round-trip on every visit isn't worth the freshness.
const GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery',
  'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western',
];

// Client-side re-sort options for whatever's currently loaded/filtered.
// "Default" is server/catalog order (Popular/New/Top Rated already are a
// sort, and Watchlist keeps the order items were added in). The others sort
// in place — exact for Watchlist and search results (both fully loaded, no
// pagination), and a "sort what's loaded so far" reorder for infinite-scroll
// browse mode, same caveat any client-side sort over a paginated API has.
const SORT_OPTIONS = [
  { key: 'default', label: 'Default order' },
  { key: 'title', label: 'Title (A-Z)' },
  { key: 'year-desc', label: 'Year (Newest)' },
  { key: 'year-asc', label: 'Year (Oldest)' },
  { key: 'rating-desc', label: 'Rating (Highest)' },
] as const;
type SortKey = typeof SORT_OPTIONS[number]['key'];

function extractYear(releaseInfo: string | null | undefined): number {
  if (!releaseInfo) return 0;
  const match = releaseInfo.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : 0;
}

const PAGE_SIZE = 100; // Cinemeta serves 100 items per catalog page
// Some catalog+genre combos have legitimately small pages (e.g. Western +
// Top Rated has < 100 real IMDb items after our filter). A fixed high
// threshold (was 50) prematurely stopped pagination for those. Trust
// Cinemeta's own end-signal instead: as long as the previous page returned
// ANYTHING, ask for more; only stop when a page comes back empty.

export default function DiscoverPage() {
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  const { enableWatchlist, enableWatchedIndicators, enableRecommendations } = usePersonalFeatures();
  const [type, setType] = useState<'movie' | 'series'>('movie');
  const [catalog, setCatalog] = useState('top');
  // '' = all genres (no filter). Cinemeta's genre param is optional; sending
  // an empty string omits it. Genre filtering isn't available on the "top"
  // catalog with search active, but IS available on all catalogs in browse.
  const [genre, setGenre] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Narrowed to PosterCardItem, not the full DiscoverItem - this is the only
  // shape MediaDetailModal's fallback* props below actually read, and it's
  // also what PosterCard's onOpenDetails hands back (see its own comment on
  // why it doesn't carry the full DiscoverItem shape).
  const [detailItem, setDetailItem] = useState<PosterCardItem | null>(null);
  // Person search (TMDb): typing an actor/director's name surfaces their
  // titles of the current type. Null when there's no key, no query, or no
  // person match.
  const [personSearch, setPersonSearch] = useState<{ person: { name: string; profile: string | null } | null; results: Array<{ tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: string | null; poster: string | null; role: string | null }> } | null>(null);
  // Titles vs People search mode. These used to run in parallel and render
  // together (a person's filmography row ABOVE the normal title-search grid)
  // - for a query that also loosely matched unrelated title names, that read
  // as "here's stuff this actor hasn't been in" stacked right under their
  // real filmography. Splitting them into an explicit mode means Titles
  // search never touches TMDb at all, and People search never shows a single
  // title-search result that isn't actually a verified credit.
  const [searchMode, setSearchMode] = useState<'titles' | 'people'>('titles');
  // Which poster's right-click menu is open — shared across the whole page
  // (both the main grid and the For You rows) so opening a second card's
  // menu closes whichever one was open before, same as Continue Watching.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);

  // Pagination state — Cinemeta returns 100 items per page; ask for more via
  // ?skip=N. hasMore flips false when a page returned <PAGE_SIZE (end of
  // catalog) so the sentinel stops firing.
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Guards against the sentinel firing repeatedly while a fetch is in flight.
  const loadMoreLock = useRef(false);

  // Discover source toggle: Cinemeta browse, personal Watchlist, or the
  // "For You" rec rows (moved off the Dashboard so it's opt-in rather
  // than always-in-your-face). Each source has its own SlickTrax gate — if
  // the user disables the corresponding feature while viewing it, we snap
  // back to plain Discover.
  const [source, setSource] = useState<'discover' | 'watchlist' | 'foryou'>('discover');
  useEffect(() => {
    if (!enableWatchlist && source === 'watchlist') setSource('discover');
    if (!enableRecommendations && source === 'foryou') setSource('discover');
  }, [enableWatchlist, enableRecommendations, source]);

  // For You state — fetched when the user picks the source (and the
  // feature is enabled), and re-fetched whenever the mode/user picker
  // below changes. This page has no single logged-in "current user" of its
  // own (it's the admin's account-wide view), so there's no automatic "me"
  // to default to - personal mode needs an explicit managed-user pick.
  // Defaults to personal mode per explicit preference (over household-wide
  // or picking a pairing) - remembered across visits the same way
  // viewMode/theme choices are.
  const [recRows, setRecRows] = useState<RecommendationRow[]>([]);
  const [recsLoaded, setRecsLoaded] = useState(false);
  // Household picks: unwatched-by-anyone titles in the whole house's genres.
  // Household-wide (not tied to the personal/shared user picker), so it only
  // depends on the type toggle - a lead row above the personalized rows.
  const [householdPicks, setHouseholdPicks] = useState<{ items: DiscoverItem[]; genres: string[]; memberCount: number; sharedAppeal: boolean } | null>(null);
  const [recMode, setRecMode] = useState<'personal' | 'shared'>('personal');
  const [recUserId, setRecUserId] = useState<string>('');
  const [recUserId2, setRecUserId2] = useState<string>('');
  const [recUsers, setRecUsers] = useState<User[]>([]);
  useEffect(() => {
    if (source !== 'foryou' || recUsers.length > 0) return;
    api.getUsers().then((users) => {
      setRecUsers(users);
      const stored = localStorage.getItem('slicksync-foryou-mode');
      const storedUserId = localStorage.getItem('slicksync-foryou-userId');
      const storedUserId2 = localStorage.getItem('slicksync-foryou-userId2');
      const mode = stored === 'shared' ? 'shared' : 'personal';
      setRecMode(mode);
      // Fall back to the first managed user if a previously-stored pick no
      // longer exists (deleted user, or first time ever) - always resolve
      // to SOME valid selection rather than leaving the picker empty.
      const validId = (id: string | null) => id && users.some((u) => u.id === id) ? id : '';
      setRecUserId(validId(storedUserId) || users[0]?.id || '');
      setRecUserId2(validId(storedUserId2) || (users[1]?.id ?? users[0]?.id ?? ''));
    }).catch(() => {});
  }, [source, recUsers.length]);
  useEffect(() => {
    if (source !== 'foryou' || !enableRecommendations) return;
    // Personal mode needs a user; shared mode needs two distinct users.
    // Wait for the picker to resolve (recUsers fetch above) rather than
    // firing once with empty ids and falling back to the old household-wide
    // behavior, which would flash the wrong rows before the real fetch.
    if (recMode === 'personal' && !recUserId) return;
    if (recMode === 'shared' && (!recUserId || !recUserId2 || recUserId === recUserId2)) return;
    setRecsLoaded(false);
    api.getRecommendations(
      recMode === 'personal'
        ? { mode: 'personal', userId: recUserId, type }
        : { mode: 'shared', userId: recUserId, userId2: recUserId2, type }
    )
      .then((r) => setRecRows(Array.isArray(r?.rows) ? r.rows : []))
      .catch(() => setRecRows([]))
      .finally(() => setRecsLoaded(true));
  }, [source, enableRecommendations, recMode, recUserId, recUserId2, type]);
  // Household picks - household-wide, so only re-fetch on type change (not on
  // mode/user-picker changes). Independent of the personal/shared rows below.
  useEffect(() => {
    if (source !== 'foryou' || !enableRecommendations) { setHouseholdPicks(null); return; }
    let cancelled = false;
    api.getHouseholdPicks(type)
      .then((r) => { if (!cancelled) setHouseholdPicks(r && r.items.length > 0 ? r : null); })
      .catch(() => { if (!cancelled) setHouseholdPicks(null); });
    return () => { cancelled = true; };
  }, [source, enableRecommendations, type]);
  useEffect(() => { if (recUsers.length > 0) localStorage.setItem('slicksync-foryou-mode', recMode); }, [recMode, recUsers.length]);
  useEffect(() => { if (recUserId) localStorage.setItem('slicksync-foryou-userId', recUserId); }, [recUserId]);
  useEffect(() => { if (recUserId2) localStorage.setItem('slicksync-foryou-userId2', recUserId2); }, [recUserId2]);
  // Second picker's own options exclude whoever's picked first (can't share
  // with yourself) - if that leaves the second picker's current value
  // stale, snap it to the next available person instead of leaving a
  // filtered-out value selected.
  useEffect(() => {
    if (recUserId2 && recUserId2 !== recUserId) return;
    const next = recUsers.find((u) => u.id !== recUserId);
    if (next) setRecUserId2(next.id);
  }, [recUserId, recUserId2, recUsers]);
  const { watchlist, watchlistLoaded, inWatchlistIds, toggleWatchlist: handleToggleWatchlist, applyWatchlistChange } = useWatchlistState();
  // Watched-status filter for the Discover grid — hide things you've seen,
  // OR flip it to only see things you have. Snap back to 'all' if the
  // indicator feature is turned off (a hidden filter that still applied
  // would be a nasty confusion).
  const [watchedFilter, setWatchedFilter] = useState<'all' | 'hide' | 'only'>('all');
  useEffect(() => {
    if (!enableWatchedIndicators && watchedFilter !== 'all') setWatchedFilter('all');
  }, [enableWatchedIndicators, watchedFilter]);
  const [sortBy, setSortBy] = useState<SortKey>('default');

  // Convert saved WatchlistItem[] into DiscoverItem[] so the same grid + card
  // component renders both sources with no branching in the render tree.
  const watchlistAsDiscover: DiscoverItem[] = watchlist.map((w) => ({
    id: w.itemId, type: w.itemType, name: w.name, poster: w.poster,
    releaseInfo: null, imdbRating: null, genres: [],
  }));

  // Source + type filter applied (watched filter comes after the hook below,
  // which needs sourceItems' ids as its input — not the other way around).
  // Watchlist mode filters by the Movies/Series tab client-side and search
  // box; browse mode uses items fetched from Cinemeta directly.
  const sourceItems = source === 'watchlist'
    ? watchlistAsDiscover.filter((i) => i.type === type && (!debouncedQuery || i.name.toLowerCase().includes(debouncedQuery.toLowerCase())))
    : items;
  const { watchedStatus, toggleWatched: handleToggleWatched } = useWatchedStatusBatch(sourceItems.map((i) => i.id), enableWatchedIndicators);
  const displayedItems = sourceItems.filter((i) => {
    if (watchedFilter === 'all') return true;
    const seen = !!watchedStatus[i.id];
    return watchedFilter === 'hide' ? !seen : seen;
  });
  const loading = source === 'watchlist' ? !watchlistLoaded : isLoading;
  const ratingsById = useRatingsBatch(displayedItems.map((i) => i.id));
  const sortedItems = sortBy === 'default' ? displayedItems : [...displayedItems].sort((a, b) => {
    if (sortBy === 'title') return a.name.localeCompare(b.name);
    if (sortBy === 'year-desc') return extractYear(b.releaseInfo) - extractYear(a.releaseInfo);
    if (sortBy === 'year-asc') return extractYear(a.releaseInfo) - extractYear(b.releaseInfo);
    const ratingOf = (i: DiscoverItem) => parseFloat(ratingsById[i.id]?.imdbRating || i.imdbRating || '0') || 0;
    return ratingOf(b) - ratingOf(a);
  });
  // Person-credit results have no rating field (TMDb's credits endpoint
  // doesn't return one here), so 'rating-desc' is meaningless for this list -
  // the effect below resets away from it when switching into People mode.
  const sortedPersonResults = !personSearch ? [] : sortBy === 'default' || sortBy === 'rating-desc' ? personSearch.results : [...personSearch.results].sort((a, b) => {
    if (sortBy === 'title') return a.title.localeCompare(b.title);
    if (sortBy === 'year-desc') return (parseInt(b.year || '0', 10) || 0) - (parseInt(a.year || '0', 10) || 0);
    return (parseInt(a.year || '0', 10) || 0) - (parseInt(b.year || '0', 10) || 0);
  });
  useEffect(() => {
    if (searchMode === 'people' && sortBy === 'rating-desc') setSortBy('default');
  }, [searchMode, sortBy]);

  // Debounce typing so search isn't firing a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const handleMarkNotInterested = useCallback(async (item: PosterCardItem) => {
    // Optimistic — splice it out of the current rows immediately rather than
    // refetching /recommendations, which would rerun seed selection and can
    // reshuffle every row for one dismissal.
    setRecRows((prev) => prev.map((row) => ({ ...row, items: row.items.filter((i) => i.id !== item.id) })));
    try {
      await api.markNotInterested(item.id, item.type);
      toast.success(`Won't recommend "${item.name}" again`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update');
    }
  }, []);

  // Open a person-search result: TMDb titles have no tt id, so resolve the
  // IMDb id first, then open the normal Cinemeta-backed detail modal.
  const openPersonResult = useCallback(async (r: { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; poster: string | null }) => {
    const res = await api.resolveImdbId(r.tmdbId, r.mediaType);
    if (res?.imdbId) {
      setDetailItem({ id: res.imdbId, type: res.type, name: r.title, poster: r.poster } as PosterCardItem);
    } else {
      toast.error('Couldn\'t open that title');
    }
  }, []);

  // In People mode, a query searches TMDb for a person only - the title
  // grid/browse fetch below is skipped entirely so there's never a stray
  // title-search result mixed into someone's filmography.
  const isPeopleSearch = source === 'discover' && searchMode === 'people' && !!debouncedQuery;

  // First-page fetch — reruns whenever type/catalog/genre/search changes.
  // Search hits a different endpoint and doesn't support pagination, so it
  // just replaces items and marks the list as complete.
  useEffect(() => {
    let cancelled = false;

    if (isPeopleSearch) {
      // People mode: no title fetch at all.
      setItems([]);
      setIsLoading(false);
      setHasMore(false);
      return;
    }

    setIsLoading(true);
    setSkip(0);
    setHasMore(true);
    loadMoreLock.current = false;

    const request = debouncedQuery
      ? api.discoverSearch(type, debouncedQuery)
      : api.discoverBrowse(type, { catalog, genre: genre || undefined });

    request.then((results) => {
      if (cancelled) return;
      setItems(results);
      setIsLoading(false);
      // Search endpoint doesn't paginate; browse pages are exactly PAGE_SIZE.
      const gotFullPage = !debouncedQuery && results.length > 0;
      setHasMore(gotFullPage);
      setSkip(results.length);
    });

    return () => {
      cancelled = true;
    };
  }, [type, catalog, genre, debouncedQuery, isPeopleSearch]);

  // People-mode search: only runs when the toggle is explicitly set to
  // People, never alongside a Titles search.
  const [personSearchLoading, setPersonSearchLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (isPeopleSearch) {
      setPersonSearchLoading(true);
      api.searchPerson(debouncedQuery, type)
        .then((r) => { if (!cancelled) setPersonSearch(r && r.person && r.results.length > 0 ? r : null); })
        .catch(() => { if (!cancelled) setPersonSearch(null); })
        .finally(() => { if (!cancelled) setPersonSearchLoading(false); });
    } else {
      setPersonSearch(null);
      setPersonSearchLoading(false);
    }
    return () => { cancelled = true; };
  }, [isPeopleSearch, debouncedQuery, type]);

  // Load the next page and append. No-op if already loading, search-mode
  // (no pagination on Cinemeta's search), or the last page came back short.
  const loadMore = useCallback(async () => {
    if (debouncedQuery || !hasMore || loadMoreLock.current) return;
    loadMoreLock.current = true;
    setIsLoadingMore(true);
    try {
      const next = await api.discoverBrowse(type, { catalog, genre: genre || undefined, skip });
      // De-dupe against what's already loaded — Cinemeta occasionally repeats
      // an item across pages when its catalog reshuffles between requests.
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const additions = next.filter((n) => !seen.has(n.id));
        return [...prev, ...additions];
      });
      setSkip((s) => s + next.length);
      setHasMore(next.length > 0);
    } finally {
      setIsLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [debouncedQuery, hasMore, type, catalog, genre, skip]);

  // Infinite scroll — an IntersectionObserver watches a sentinel element
  // rendered just below the grid; when it enters the viewport, fire loadMore.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '400px' /* start fetching before it's actually in view */ });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const searchConfig: PageToolbarProps['searchConfig'] = {
    value: searchQuery,
    onChange: setSearchQuery,
    placeholder: searchMode === 'people'
      ? 'Search for an actor or director...'
      : `Search ${type === 'movie' ? 'movies' : 'series'}...`,
  };

  // TV mode wraps the whole page in the D-pad focus root; PC/mobile get a
  // plain Fragment, same tree either way with no separate render path.
  const Wrapper = isTV ? TVPageProvider : Fragment;

  return (
    <Wrapper>
      {layoutMode !== 'nebula' && (
        <Header
          title="Discover"
          subtitle="Browse or search for something to watch, then open it straight in Stremio or Nuvio"
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading
          title="Discover"
          subtitle="Browse or search for something to watch, then open it straight in Stremio or Nuvio"
        />
      )}
      <div className={layoutMode === 'nebula' ? `${NEBULA_GLASS_CLASS} p-5` : ''} style={layoutMode === 'nebula' ? nebulaGlassStyle : undefined}>
      {layoutMode === 'nebula' && <NebulaGlassStripe />}
        <PageSection delay={0.05} className="mb-6">
          {isTV ? (
            // PageToolbar's filterTabs render through FilterTabs, which has
            // no D-pad wiring - same reason the genre <select> gets swapped
            // out below. Search is skipped entirely on TV (typing on a
            // remote isn't worth building for yet), so this is just the
            // Movies/Series toggle, D-pad reachable.
            <div className="flex gap-2">
              {([['movie', 'Movies', FilmIcon], ['series', 'Series', TvIcon]] as const).map(([key, label, Icon]) => (
                <TVFocusable key={key} onEnterPress={() => setType(key)}>
                  <button
                    type="button"
                    onClick={() => setType(key)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${
                      type === key ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:text-default'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                </TVFocusable>
              ))}
            </div>
          ) : (
            <PageToolbar
              animate={false}
              searchConfig={searchConfig}
              filterTabs={{
                options: [
                  { key: 'movie', label: 'Movies', icon: <FilmIcon className="w-4 h-4" /> },
                  { key: 'series', label: 'Series', icon: <TvIcon className="w-4 h-4" /> },
                ],
                activeKey: type,
                onChange: (key) => setType(key as 'movie' | 'series'),
                layoutId: 'discover-type-tabs',
              }}
            />
          )}

          {/* Titles vs People search mode - only relevant to the plain
              Discover source (Watchlist/For You have no person search).
              Explicitly separate, not run in parallel: a Titles search never
              touches TMDb, and a People search only ever shows that person's
              actual verified credits - no stray title-search result can
              land next to a filmography it doesn't belong to. */}
          {!isTV && source === 'discover' && (
            <div className="flex items-center gap-2 mt-3">
              <span className="text-xs text-muted">Search:</span>
              <button
                type="button"
                onClick={() => setSearchMode('titles')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  searchMode === 'titles' ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:text-default'
                }`}
              >
                <MagnifyingGlassIcon className="w-3.5 h-3.5" />
                Titles
              </button>
              <button
                type="button"
                onClick={() => setSearchMode('people')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  searchMode === 'people' ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:text-default'
                }`}
              >
                <UserIcon className="w-3.5 h-3.5" />
                People
              </button>
            </div>
          )}
        </PageSection>

        {/* Source: Cinemeta catalogs vs. your own Watchlist + optional
            watched filter. Each half is independently gated by the
            personal-features settings — if BOTH are disabled the whole
            row disappears (no visual weight from an empty control bar). */}
        {(enableWatchlist || enableWatchedIndicators || enableRecommendations) && (
          <PageSection delay={0.07} className="mb-4">
            <div className="flex gap-2 flex-wrap items-center">
              {/* Discover source is always shown when any SlickTrax feature is
                  on — otherwise the toggle row disappears entirely. Watchlist
                  and For You each appear only when their feature is enabled. */}
              {(enableWatchlist || enableRecommendations) && (() => {
                const btn = (
                  <button
                    type="button"
                    onClick={() => setSource('discover')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      source === 'discover'
                        ? 'bg-primary text-white'
                        : 'bg-surface-hover text-muted hover:text-default'
                    }`}
                  >
                    Discover
                  </button>
                );
                return isTV ? <TVFocusable onEnterPress={() => setSource('discover')}>{btn}</TVFocusable> : btn;
              })()}
              {enableWatchlist && (() => {
                const btn = (
                  <button
                    type="button"
                    onClick={() => setSource('watchlist')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      source === 'watchlist'
                        ? 'bg-primary text-white'
                        : 'bg-surface-hover text-muted hover:text-default'
                    }`}
                  >
                    ★ Watchlist
                    {watchlist.length > 0 && (
                      <span className={`ml-1.5 text-xs ${source === 'watchlist' ? 'opacity-80' : 'opacity-60'}`}>({watchlist.length})</span>
                    )}
                  </button>
                );
                return isTV ? <TVFocusable onEnterPress={() => setSource('watchlist')}>{btn}</TVFocusable> : btn;
              })()}
              {enableRecommendations && (() => {
                const btn = (
                  <button
                    type="button"
                    onClick={() => setSource('foryou')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      source === 'foryou'
                        ? 'bg-primary text-white'
                        : 'bg-surface-hover text-muted hover:text-default'
                    }`}
                  >
                    ✨ For You
                  </button>
                );
                return isTV ? <TVFocusable onEnterPress={() => setSource('foryou')}>{btn}</TVFocusable> : btn;
              })()}

              {/* Watched filter + sort — right side of the same row, stacked
                  (Show above Sort) rather than crammed side by side. Sort/
                  watched filter only apply to the flat grid views (Discover
                  browse+search, Watchlist) - For You renders as personalized
                  rows, not a single sortable/filterable list. Watched filter
                  additionally hides in People mode - watchedStatus is keyed
                  by IMDb id, and person-credit results only carry a TMDb id,
                  so it could never actually match anything there. */}
              {source !== 'foryou' && (
              <div className="ml-auto flex flex-col items-end gap-1.5">
                {enableWatchedIndicators && searchMode !== 'people' && (
                  <div className="flex gap-1 items-center">
                    <span className="text-xs text-muted mr-1 hidden sm:inline">Show:</span>
                    {([['all', 'All'], ['hide', 'Unwatched'], ['only', 'Watched']] as const).map(([key, label]) => {
                      const btn = (
                        <button
                          type="button"
                          onClick={() => setWatchedFilter(key)}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                            watchedFilter === key
                              ? 'bg-primary/20 text-primary'
                              : 'text-muted hover:text-default'
                          }`}
                        >
                          {label}
                        </button>
                      );
                      return isTV ? (
                        <TVFocusable key={key} onEnterPress={() => setWatchedFilter(key)}>{btn}</TVFocusable>
                      ) : (
                        <Fragment key={key}>{btn}</Fragment>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted hidden sm:inline">Sort:</span>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortKey)}
                    aria-label="Sort results"
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-surface-hover text-muted hover:text-default border border-default cursor-pointer"
                  >
                    {SORT_OPTIONS.filter((opt) => searchMode !== 'people' || opt.key !== 'rating-desc').map((opt) => (
                      <option key={opt.key} value={opt.key}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              )}
            </div>
          </PageSection>
        )}

        {source === 'discover' && !debouncedQuery && (
          <PageSection delay={0.08} className="mb-6">
            {/* Catalog picker + genre dropdown on the SAME row: catalog is
                the primary filter (Popular / New / Top Rated), genre is a
                secondary refinement sitting immediately after it. On a
                narrow screen the dropdown wraps below thanks to flex-wrap. */}
            <div className="flex gap-2 flex-wrap items-center">
              {CATALOGS.map((c) => {
                const btn = (
                  <button
                    type="button"
                    onClick={() => setCatalog(c.key)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      catalog === c.key
                        ? 'bg-primary text-white'
                        : 'bg-surface-hover text-muted hover:text-default'
                    }`}
                  >
                    {c.label}
                  </button>
                );
                return isTV ? (
                  <TVFocusable key={c.key} onEnterPress={() => setCatalog(c.key)}>{btn}</TVFocusable>
                ) : (
                  <Fragment key={c.key}>{btn}</Fragment>
                );
              })}

              {/* Genre picker — always enabled. Server-side, catalog+genre
                  combos that return empty from Cinemeta (New+anything,
                  imdbRating+Documentary, etc.) transparently fall back to
                  Popular in that genre so the grid isn't stuck empty.
                  TV mode swaps the native <select> for a focusable chip
                  row — Norigin's spatial nav has no way to reach into (or
                  drive) an OS-native dropdown popup, same reason the
                  catalog tabs above are plain buttons rather than a select
                  in the first place. */}
              {isTV ? (
                <div className="flex gap-2 flex-wrap items-center">
                  {[{ key: '', label: 'All genres' }, ...GENRES.map((g) => ({ key: g, label: g }))].map((g) => {
                    const chip = (
                      <button
                        type="button"
                        onClick={() => setGenre(g.key)}
                        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          genre === g.key
                            ? 'bg-primary text-white border-transparent'
                            : 'bg-surface-hover text-muted hover:text-default border-default'
                        }`}
                      >
                        {g.label}
                      </button>
                    );
                    return (
                      <TVFocusable key={g.key || 'all'} onEnterPress={() => setGenre(g.key)}>
                        {chip}
                      </TVFocusable>
                    );
                  })}
                </div>
              ) : (
                <select
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  aria-label="Filter by genre"
                  className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${
                    genre
                      ? 'bg-primary text-white border-transparent'
                      : 'bg-surface-hover text-muted hover:text-default border-default'
                  }`}
                >
                  <option value="">All genres</option>
                  {GENRES.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              )}
            </div>
          </PageSection>
        )}

        {source === 'foryou' ? (
          <PageSection delay={0.1}>
            {/* Personal (one managed user's own watch history) vs Shared
                (combined signal + real overlap from exactly two picked
                users) - this page has no single "current user" of its own,
                so there's no automatic default beyond picking Personal mode
                itself. Mirrors the Movies/Series and catalog picker's own
                pill-row + native-select pattern used elsewhere on this
                page rather than introducing a new control style. TV mode
                swaps both native <select>s for focusable chip rows, same
                reason (and same pattern) as the genre picker below. */}
            {recUsers.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-4">
                {(recUsers.length > 1 ? (['personal', 'shared'] as const) : (['personal'] as const)).map((m) => {
                  const btn = (
                    <button
                      type="button"
                      onClick={() => setRecMode(m)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        recMode === m
                          ? 'bg-primary text-white'
                          : 'bg-surface-hover text-muted hover:text-default'
                      }`}
                    >
                      {m === 'personal' ? 'Personal' : 'Shared with…'}
                    </button>
                  );
                  return isTV ? (
                    <TVFocusable key={m} onEnterPress={() => setRecMode(m)}>{btn}</TVFocusable>
                  ) : (
                    <Fragment key={m}>{btn}</Fragment>
                  );
                })}
                {isTV ? (
                  <div className="flex gap-2 flex-wrap items-center">
                    {recUsers.map((u) => {
                      const chip = (
                        <button
                          type="button"
                          onClick={() => setRecUserId(u.id)}
                          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                            recUserId === u.id
                              ? 'bg-primary text-white border-transparent'
                              : 'bg-surface-hover text-muted hover:text-default border-default'
                          }`}
                        >
                          {u.name || u.username}
                        </button>
                      );
                      return (
                        <TVFocusable key={u.id} onEnterPress={() => setRecUserId(u.id)}>
                          {chip}
                        </TVFocusable>
                      );
                    })}
                  </div>
                ) : (
                  <select
                    value={recUserId}
                    onChange={(e) => setRecUserId(e.target.value)}
                    aria-label={recMode === 'personal' ? 'Show recommendations for' : 'First person'}
                    className="px-3 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer bg-surface-hover text-default border-default"
                  >
                    {recUsers.map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.username}</option>
                    ))}
                  </select>
                )}
                {recMode === 'shared' && (
                  <>
                    <span className="text-sm text-muted">and</span>
                    {isTV ? (
                      <div className="flex gap-2 flex-wrap items-center">
                        {recUsers.filter((u) => u.id !== recUserId).map((u) => {
                          const chip = (
                            <button
                              type="button"
                              onClick={() => setRecUserId2(u.id)}
                              className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                                recUserId2 === u.id
                                  ? 'bg-primary text-white border-transparent'
                                  : 'bg-surface-hover text-muted hover:text-default border-default'
                              }`}
                            >
                              {u.name || u.username}
                            </button>
                          );
                          return (
                            <TVFocusable key={u.id} onEnterPress={() => setRecUserId2(u.id)}>
                              {chip}
                            </TVFocusable>
                          );
                        })}
                      </div>
                    ) : (
                    <select
                      value={recUserId2}
                      onChange={(e) => setRecUserId2(e.target.value)}
                      aria-label="Second person"
                      className="px-3 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer bg-surface-hover text-default border-default"
                    >
                      {recUsers.filter((u) => u.id !== recUserId).map((u) => (
                        <option key={u.id} value={u.id}>{u.name || u.username}</option>
                      ))}
                    </select>
                    )}
                  </>
                )}
              </div>
            )}
            {/* Household picks - unwatched by ANYONE, in genres the whole
                house likes. Lead row, above the personal/shared rows, and
                independent of them (shows even if the personal picker's own
                rows are empty). Something single-user Trakt can't do. */}
            {householdPicks && householdPicks.items.length > 0 && (
              <div className="mb-8">
                <div className="flex items-baseline gap-2 mb-3 flex-wrap">
                  <h3 className="text-base font-semibold font-display text-default">✨ Nobody&apos;s seen it yet</h3>
                  {householdPicks.sharedAppeal && householdPicks.memberCount > 1 && (
                    <Badge
                      variant="primary"
                      size="sm"
                      icon={<SparklesIcon className="w-3 h-3" />}
                      title="In genres shared across multiple household members - broad appeal, and no one's watched it"
                    >
                      House pick
                    </Badge>
                  )}
                  <span className="text-xs text-muted">· {householdPicks.genres.join(', ')} the whole house likes</span>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
                  {householdPicks.items.map((item) => (
                    <PosterCard
                      key={item.id}
                      item={item}
                      ratings={ratingsById[item.id]}
                      watched={watchedStatus[item.id]}
                      inWatchlist={inWatchlistIds.has(item.id)}
                      showWatchlistMenu={enableWatchlist}
                      showWatchlistBadge={enableWatchlist}
                      showWatchedMenu={enableWatchedIndicators}
                      showWatchedBadge={enableWatchedIndicators}
                      showNotInterested
                      onMarkNotInterested={handleMarkNotInterested}
                      onOpenDetails={setDetailItem}
                      onToggleWatchlist={handleToggleWatchlist}
                      onToggleWatched={handleToggleWatched}
                      isMenuOpen={openMenuKey === item.id}
                      onMenuOpenChange={(open) => setOpenMenuKey(open ? item.id : null)}
                      focusable={isTV}
                    />
                  ))}
                </div>
              </div>
            )}

            {!recsLoaded ? (
              <div className="flex items-center justify-center py-24 text-muted">
                <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
              </div>
            ) : recRows.length === 0 ? (
              // Only show the empty message when there's ALSO no household-
              // picks row above - otherwise the page isn't actually empty.
              !householdPicks || householdPicks.items.length === 0 ? (
                <div className="text-center py-24 text-muted">
                  <p>No recommendations yet — watch a few things first, and we&apos;ll suggest more.</p>
                </div>
              ) : null
            ) : (
              <div className="space-y-8">
                {recRows.map((row) => (
                  <div key={row.seedId}>
                    <div className="flex items-baseline gap-2 mb-3 flex-wrap">
                      <h3 className="text-base font-semibold font-display text-default">{row.reason}</h3>
                      {/* Confidence-visible recommendations: the reason text
                          alone only reads differently when a real pairwise
                          match was found ("X and Y both loved Z") - a row
                          resting on just this seed's own score with zero
                          real cross-item affinity behind it still gets the
                          same-looking generic "Because you watched X" text.
                          This badge surfaces that distinction directly
                          instead of leaving it invisible, using the same
                          hasRealSignal signal "More Like This" already
                          computes - no new data, just showing what's
                          already there. */}
                      {row.hasRealSignal && (
                        <Badge
                          variant="primary"
                          size="sm"
                          icon={<SparklesIcon className="w-3 h-3" />}
                          title="Backed by real watch-time overlap in your household, not just this title's own score"
                        >
                          Real match
                        </Badge>
                      )}
                      <span className="text-xs text-muted">· Top Rated {row.genre}</span>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
                      {row.items.map((item) => (
                        <PosterCard
                          key={item.id}
                          item={item}
                          ratings={ratingsById[item.id]}
                          watched={watchedStatus[item.id]}
                          inWatchlist={inWatchlistIds.has(item.id)}
                          showWatchlistMenu={enableWatchlist}
                          showWatchlistBadge={enableWatchlist}
                          showWatchedMenu={enableWatchedIndicators}
                          showWatchedBadge={enableWatchedIndicators}
                          showNotInterested
                          onMarkNotInterested={handleMarkNotInterested}
                          onOpenDetails={setDetailItem}
                          onToggleWatchlist={handleToggleWatchlist}
                          onToggleWatched={handleToggleWatched}
                          isMenuOpen={openMenuKey === item.id}
                          onMenuOpenChange={(open) => setOpenMenuKey(open ? item.id : null)}
                          focusable={isTV}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted italic text-center pt-2">
                  Powered by SlickTrax — rows are based on the genres you actually spend the most time watching (weighted toward recent viewing), plus what's on your Watchlist. Up to three at a time, and they shift as your habits do.
                </p>
              </div>
            )}
          </PageSection>
        ) : (
        <PageSection delay={0.1}>
          {source === 'discover' && searchMode === 'people' ? (
            // People mode: exclusively a person's own verified TMDb credits -
            // never a title-search result mixed in (see the searchMode
            // comment above for why that combination was removed).
            <>
              {!debouncedQuery ? (
                <div className="text-center py-24 text-muted">
                  <UserIcon className="w-10 h-10 mx-auto mb-3 text-subtle" />
                  <p>Type an actor or director&apos;s name to see what they&apos;ve been in.</p>
                </div>
              ) : personSearchLoading ? (
                <div className="flex items-center justify-center py-24 text-muted">
                  <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !personSearch || !personSearch.person || personSearch.results.length === 0 ? (
                <div className="text-center py-24 text-muted">
                  <UserIcon className="w-10 h-10 mx-auto mb-3 text-subtle" />
                  <p>No match for &quot;{debouncedQuery}&quot; — or nothing of that type ({type === 'series' ? 'series' : 'movies'}) in their credits.</p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    {personSearch.person.profile && (
                      <img src={personSearch.person.profile} alt={personSearch.person.name} className="w-8 h-8 rounded-full object-cover" />
                    )}
                    <h3 className="text-base font-semibold font-display text-default">
                      {personSearch.person.name}
                      <span className="text-muted font-normal"> — {type === 'series' ? 'series' : 'movies'} they&apos;re in</span>
                    </h3>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
                    {sortedPersonResults.map((r) => (
                      <button
                        key={`${r.mediaType}-${r.tmdbId}`}
                        type="button"
                        onClick={() => openPersonResult(r)}
                        title={`${r.title}${r.role ? ` · ${r.role}` : ''}`}
                        className="text-left group/pr"
                      >
                        <div className="aspect-[2/3] rounded-xl overflow-hidden bg-slate-800 shadow-lg">
                          {r.poster ? (
                            <img src={r.poster} alt={r.title} loading="lazy" className="w-full h-full object-cover transition-transform group-hover/pr:scale-105" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-muted text-xs p-2 text-center">{r.title}</div>
                          )}
                        </div>
                        <p className="mt-1 text-xs font-medium text-default leading-tight line-clamp-2 group-hover/pr:text-primary transition-colors text-center">{r.title}</p>
                        {r.year && <p className="text-[10px] text-subtle text-center">{r.year}</p>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
          <>

          {loading ? (
            <div className="flex items-center justify-center py-24 text-muted">
              <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
            </div>
          ) : displayedItems.length === 0 ? (
            <div className="text-center py-24 text-muted">
              <MagnifyingGlassIcon className="w-10 h-10 mx-auto mb-3 text-subtle" />
              <p>
                {source === 'watchlist' && watchlist.length === 0
                  ? 'Your watchlist is empty. Add items with the bookmark button on any title.'
                  : source === 'watchlist'
                    ? `Nothing in your watchlist matches this view.`
                    : watchedFilter !== 'all'
                      ? `Nothing matches the "${watchedFilter === 'hide' ? 'Unwatched' : 'Watched'}" filter here.`
                      : 'No results found.'}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
                {sortedItems.map((item) => (
                  <PosterCard
                    key={item.id}
                    item={item}
                    ratings={ratingsById[item.id]}
                    watched={watchedStatus[item.id]}
                    inWatchlist={inWatchlistIds.has(item.id)}
                    showWatchlistMenu={enableWatchlist}
                    showWatchlistBadge={enableWatchlist}
                    showWatchedMenu={enableWatchedIndicators}
                    showWatchedBadge={enableWatchedIndicators}
                    onOpenDetails={setDetailItem}
                    onToggleWatchlist={handleToggleWatchlist}
                    onToggleWatched={handleToggleWatched}
                    isMenuOpen={openMenuKey === item.id}
                    onMenuOpenChange={(open) => setOpenMenuKey(open ? item.id : null)}
                    focusable={isTV}
                  />
                ))}
              </div>

              {/* Infinite-scroll sentinel + spinner. Discover browse-mode only
                  — Watchlist is fully-loaded client-side and search doesn't
                  paginate. Sentinel sits ~400px below the grid's end so we
                  start fetching before the user hits true bottom. */}
              {source === 'discover' && !debouncedQuery && (
                <div className="mt-8 flex flex-col items-center justify-center gap-3 py-6">
                  {isLoadingMore && (
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Loading more…
                    </div>
                  )}
                  {!hasMore && displayedItems.length >= PAGE_SIZE && (
                    <p className="text-xs text-muted">That&apos;s everything Cinemeta has for this catalog{genre ? ` in ${genre}` : ''}.</p>
                  )}
                  {/* The observer target — a zero-height marker. */}
                  <div ref={sentinelRef} aria-hidden className="h-px w-full" />
                </div>
              )}
            </>
          )}
          </>
          )}
        </PageSection>
        )}
      </div>
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
