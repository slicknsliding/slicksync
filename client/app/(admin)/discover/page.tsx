'use client';

import { useState, useEffect, memo, useRef, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaTopbar, NebulaPageHeading, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { PageToolbar, MediaDetailModal, PageToolbarProps, RatingBadges, ContextMenu, useContextMenu } from '@/components/ui';
import { api, DiscoverItem, RatingsBatchEntry, WatchlistItem } from '@/lib/api';
import { useRatingsBatch } from '@/lib/hooks/useRatingsBatch';
import { FilmIcon, TvIcon, MagnifyingGlassIcon, CheckBadgeIcon, BookmarkIcon as BookmarkOutlineIcon, XCircleIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkSolidIcon } from '@heroicons/react/24/solid';
import { toast } from '@/components/ui/Toast';

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

const PAGE_SIZE = 100; // Cinemeta serves 100 items per catalog page
// Some catalog+genre combos have legitimately small pages (e.g. Western +
// Top Rated has < 100 real IMDb items after our filter). A fixed high
// threshold (was 50) prematurely stopped pagination for those. Trust
// Cinemeta's own end-signal instead: as long as the previous page returned
// ANYTHING, ask for more; only stop when a page comes back empty.

const PosterCard = memo(function PosterCard({
  item,
  ratings,
  watched,
  inWatchlist,
  onOpenDetails,
  onToggleWatchlist,
  onToggleWatched,
}: {
  item: DiscoverItem;
  ratings?: RatingsBatchEntry;
  /** True when this account has watch history for this item's id. */
  watched?: boolean;
  /** True when this item is currently saved to the account's watchlist. */
  inWatchlist?: boolean;
  onOpenDetails: (item: DiscoverItem) => void;
  /** Adds or removes from the watchlist based on current state. */
  onToggleWatchlist: (item: DiscoverItem, next: boolean) => void;
  /** Flips the watched marker between true and false. */
  onToggleWatched: (item: DiscoverItem, nextWatched: boolean) => void;
}) {
  const [imageError, setImageError] = useState(false);
  // Right-click context menu — add or remove watchlist depending on state.
  const { isOpen, position, handleContextMenu, close } = useContextMenu();

  return (
    <div
      className="group relative cursor-pointer"
      onClick={() => onOpenDetails(item)}
      onContextMenu={handleContextMenu}
    >
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-slate-800 shadow-xl">
        {item.poster && !imageError ? (
          <>
            <img
              src={item.poster}
              alt={item.name}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover transition-all duration-700 group-hover:scale-110"
              onError={() => setImageError(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/50 to-transparent opacity-40 group-hover:opacity-60 transition-opacity" />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-slate-800">
            {item.type === 'movie' ? (
              <FilmIcon className="w-12 h-12 text-slate-600" />
            ) : (
              <TvIcon className="w-12 h-12 text-slate-600" />
            )}
          </div>
        )}

        {/* Watched-status corner badge — subtle checkmark on the top-right so
            you can see at a glance while browsing what you've already seen.
            Layered above the poster's dark gradient so it stays visible on
            both light and dark posters. */}
        {watched && (
          <div
            className="absolute top-1.5 right-1.5 flex items-center justify-center rounded-full bg-emerald-500/90 text-white shadow-lg backdrop-blur-sm"
            style={{ width: 24, height: 24 }}
            title="You've watched this"
          >
            <CheckBadgeIcon className="w-4 h-4" />
          </div>
        )}

        {/* Watchlist bookmark indicator — smaller than the watched badge and
            in the opposite corner so both can coexist on the same card. */}
        {inWatchlist && !watched && (
          <div
            className="absolute top-1.5 left-1.5 flex items-center justify-center rounded-full bg-primary/90 text-white shadow-lg backdrop-blur-sm"
            style={{ width: 22, height: 22 }}
            title="In your watchlist"
          >
            <BookmarkSolidIcon className="w-3.5 h-3.5" />
          </div>
        )}

        <div className="absolute bottom-1.5 left-1.5 right-1.5">
          <RatingBadges
            imdbRating={item.imdbRating}
            rottenTomatoes={ratings?.rottenTomatoes}
            metacritic={ratings?.metacritic}
          />
        </div>
      </div>

      <div className="mt-2 space-y-0.5 text-center">
        <h4 className="font-semibold text-sm text-slate-300 leading-tight line-clamp-2">
          {item.name}
        </h4>
        {item.releaseInfo && (
          <p className="text-xs text-slate-500">{item.releaseInfo}</p>
        )}
      </div>

      <ContextMenu isOpen={isOpen} position={position} onClose={close}>
        <button
          type="button"
          onClick={() => { close(); onToggleWatchlist(item, !inWatchlist); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          {inWatchlist
            ? <><XCircleIcon className="w-4 h-4" /> Remove from Watchlist</>
            : <><BookmarkOutlineIcon className="w-4 h-4" /> Add to Watchlist</>}
        </button>
        <button
          type="button"
          onClick={() => { close(); onToggleWatched(item, !watched); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          {watched
            ? <><EyeSlashIcon className="w-4 h-4" /> Mark as unwatched</>
            : <><EyeIcon className="w-4 h-4" /> Mark as watched</>}
        </button>
      </ContextMenu>
    </div>
  );
});

export default function DiscoverPage() {
  const { layoutMode } = useLayoutMode();
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
  const [detailItem, setDetailItem] = useState<DiscoverItem | null>(null);

  // Pagination state — Cinemeta returns 100 items per page; ask for more via
  // ?skip=N. hasMore flips false when a page returned <PAGE_SIZE (end of
  // catalog) so the sentinel stops firing.
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Guards against the sentinel firing repeatedly while a fetch is in flight.
  const loadMoreLock = useRef(false);

  // "Your Watchlist" is a native SlickSync source (no external service, unlike
  // the removed Trakt watchlist). Always available in the source toggle.
  const [source, setSource] = useState<'discover' | 'watchlist'>('discover');
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  // Watched-status filter for the Discover grid — hide things you've seen,
  // OR flip it to only see things you have.
  const [watchedFilter, setWatchedFilter] = useState<'all' | 'hide' | 'only'>('all');
  const [watchedStatus, setWatchedStatus] = useState<Record<string, boolean>>({});

  // Convert saved WatchlistItem[] into DiscoverItem[] so the same grid + card
  // component renders both sources with no branching in the render tree.
  const watchlistAsDiscover: DiscoverItem[] = watchlist.map((w) => ({
    id: w.itemId, type: w.itemType, name: w.name, poster: w.poster,
    releaseInfo: null, imdbRating: null, genres: [],
  }));

  const inWatchlistIds = new Set(watchlist.map((w) => w.itemId));

  // Source + type + watched filter applied. Watchlist mode filters by the
  // Movies/Series tab client-side and search box; browse mode uses items
  // fetched from Cinemeta directly.
  const sourceItems = source === 'watchlist'
    ? watchlistAsDiscover.filter((i) => i.type === type && (!debouncedQuery || i.name.toLowerCase().includes(debouncedQuery.toLowerCase())))
    : items;
  const displayedItems = sourceItems.filter((i) => {
    if (watchedFilter === 'all') return true;
    const seen = !!watchedStatus[i.id];
    return watchedFilter === 'hide' ? !seen : seen;
  });
  const loading = source === 'watchlist' ? !watchlistLoaded : isLoading;
  const ratingsById = useRatingsBatch(displayedItems.map((i) => i.id));

  // Debounce typing so search isn't firing a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Load the watchlist once on mount so the ✓ In-Watchlist badges + source
  // toggle react without a per-source-switch fetch. Re-fetched only when
  // toggleWatchlist mutates (below).
  const refreshWatchlist = useCallback(async () => {
    try {
      const list = await api.getWatchlist();
      setWatchlist(list);
    } finally {
      setWatchlistLoaded(true);
    }
  }, []);
  useEffect(() => { refreshWatchlist(); }, [refreshWatchlist]);

  // Batch-check watched status for whatever's currently on screen. Only IDs
  // we haven't queried yet get sent, so scrolling doesn't re-ask about
  // items we already know the answer for.
  useEffect(() => {
    const unknown = displayedItems
      .map((i) => i.id)
      .filter((id) => !(id in watchedStatus));
    if (unknown.length === 0) return;
    let cancelled = false;
    api.getWatchedStatus(unknown).then((seen) => {
      if (cancelled) return;
      setWatchedStatus((prev) => {
        // Merge — for ids that came back false, mark them false so we don't
        // re-ask on the next render.
        const next = { ...prev };
        for (const id of unknown) next[id] = seen[id] === true;
        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [displayedItems, watchedStatus]);

  const handleToggleWatched = useCallback(async (item: DiscoverItem, nextWatched: boolean) => {
    // Optimistic — flip the local map immediately so the ✓ badge reacts.
    setWatchedStatus((prev) => ({ ...prev, [item.id]: nextWatched }));
    try {
      await api.markWatched(item.id, nextWatched);
      toast.success(nextWatched
        ? `Marked "${item.name}" as watched`
        : `Marked "${item.name}" as unwatched`);
    } catch (e: any) {
      setWatchedStatus((prev) => ({ ...prev, [item.id]: !nextWatched }));
      toast.error(e?.message || 'Failed to update watched status');
    }
  }, []);

  const handleToggleWatchlist = useCallback(async (item: DiscoverItem, next: boolean) => {
    // Optimistic — flip the local set immediately so the badge reacts.
    setWatchlist((prev) => next
      ? [...prev, { id: item.id, itemId: item.id, itemType: item.type, name: item.name, poster: item.poster, addedAt: new Date().toISOString() }]
      : prev.filter((w) => w.itemId !== item.id));
    try {
      if (next) {
        await api.addToWatchlist({ itemId: item.id, itemType: item.type, name: item.name, poster: item.poster });
        toast.success(`Added "${item.name}" to Watchlist`);
      } else {
        await api.removeFromWatchlist(item.id);
        toast.success(`Removed "${item.name}" from Watchlist`);
      }
    } catch (e: any) {
      // Revert on failure.
      refreshWatchlist();
      toast.error(e?.message || 'Failed to update watchlist');
    }
  }, [refreshWatchlist]);

  // First-page fetch — reruns whenever type/catalog/genre/search changes.
  // Search hits a different endpoint and doesn't support pagination, so it
  // just replaces items and marks the list as complete.
  useEffect(() => {
    let cancelled = false;
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
  }, [type, catalog, genre, debouncedQuery]);

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
    placeholder: `Search ${type === 'movie' ? 'movies' : 'series'}...`,
  };

  return (
    <>
      {layoutMode === 'nebula' ? (
        <NebulaTopbar />
      ) : (
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
        </PageSection>

        {/* Source: Cinemeta catalogs vs. your own Watchlist. Always shown —
            no external service to gate on (unlike the removed Trakt version). */}
        <PageSection delay={0.07} className="mb-4">
          <div className="flex gap-2 flex-wrap items-center">
            {([['discover', 'Discover'], ['watchlist', '★ Watchlist']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSource(key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  source === key
                    ? 'bg-primary text-white'
                    : 'bg-surface-hover text-muted hover:text-default'
                }`}
              >
                {label}
                {key === 'watchlist' && watchlist.length > 0 && (
                  <span className={`ml-1.5 text-xs ${source === 'watchlist' ? 'opacity-80' : 'opacity-60'}`}>({watchlist.length})</span>
                )}
              </button>
            ))}

            {/* Watched filter — right side of the same row, subtle. */}
            <div className="ml-auto flex gap-1 items-center">
              <span className="text-xs text-muted mr-1 hidden sm:inline">Show:</span>
              {([['all', 'All'], ['hide', 'Unwatched'], ['only', 'Watched']] as const).map(([key, label]) => (
                <button
                  key={key}
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
              ))}
            </div>
          </div>
        </PageSection>

        {source === 'discover' && !debouncedQuery && (
          <PageSection delay={0.08} className="mb-6">
            {/* Catalog picker + genre dropdown on the SAME row: catalog is
                the primary filter (Popular / New / Top Rated), genre is a
                secondary refinement sitting immediately after it. On a
                narrow screen the dropdown wraps below thanks to flex-wrap. */}
            <div className="flex gap-2 flex-wrap items-center">
              {CATALOGS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => {
                    setCatalog(c.key);
                    // Cinemeta's "year" (New) catalog returns EMPTY for every
                    // specific genre (probed against all 18) — their data,
                    // not our code. Auto-clear any picked genre when the user
                    // switches to New so they aren't stuck on a permanently-
                    // empty grid.
                    if (c.key === 'year') setGenre('');
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    catalog === c.key
                      ? 'bg-primary text-white'
                      : 'bg-surface-hover text-muted hover:text-default'
                  }`}
                >
                  {c.label}
                </button>
              ))}

              {/* Genre picker — dropdown, not pills. Stacks with catalog
                  (Top Rated + Horror = top-rated horror). Disabled on New
                  since Cinemeta doesn't populate that combo (see above). */}
              <select
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={catalog === 'year'}
                title={catalog === 'year' ? 'Cinemeta doesn’t provide genre-filtered results for the New catalog' : 'Filter by genre'}
                aria-label="Filter by genre"
                className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  catalog === 'year'
                    ? 'bg-surface-hover text-subtle border-default cursor-not-allowed opacity-60'
                    : genre
                      ? 'bg-primary text-white border-transparent cursor-pointer'
                      : 'bg-surface-hover text-muted hover:text-default border-default cursor-pointer'
                }`}
              >
                <option value="">All genres</option>
                {GENRES.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
          </PageSection>
        )}

        <PageSection delay={0.1}>
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
                {displayedItems.map((item) => (
                  <PosterCard
                    key={item.id}
                    item={item}
                    ratings={ratingsById[item.id]}
                    watched={watchedStatus[item.id]}
                    inWatchlist={inWatchlistIds.has(item.id)}
                    onOpenDetails={setDetailItem}
                    onToggleWatchlist={handleToggleWatchlist}
                    onToggleWatched={handleToggleWatched}
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
        </PageSection>
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
        />
      )}
    </>
  );
}
