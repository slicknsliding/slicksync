'use client';

import { useState, useEffect, memo, useRef, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaTopbar, NebulaPageHeading, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { PageToolbar, MediaDetailModal, PageToolbarProps, RatingBadges } from '@/components/ui';
import { api, DiscoverItem, RatingsBatchEntry } from '@/lib/api';
import { useRatingsBatch } from '@/lib/hooks/useRatingsBatch';
import { FilmIcon, TvIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';

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
// Threshold below which we treat a page as the LAST page. Cinemeta returns
// 100 items per page, but our server filters out non-IMDb results, so a full
// page can shrink to ~90 after filtering — comparing exactly against
// PAGE_SIZE would falsely stop pagination on the first page. Anything above
// half a page = "there was more here, keep asking"; below = "at the end".
const MORE_PAGES_THRESHOLD = 50;

const PosterCard = memo(function PosterCard({
  item,
  ratings,
  onOpenDetails,
}: {
  item: DiscoverItem;
  ratings?: RatingsBatchEntry;
  onOpenDetails: (item: DiscoverItem) => void;
}) {
  const [imageError, setImageError] = useState(false);

  return (
    <div className="group relative cursor-pointer" onClick={() => onOpenDetails(item)}>
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

  // "Your Watchlist" source, powered by Trakt (only offered when connected).
  const [source, setSource] = useState<'discover' | 'watchlist'>('discover');
  const [traktConnected, setTraktConnected] = useState(false);
  const [watchlistItems, setWatchlistItems] = useState<DiscoverItem[]>([]);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [watchlistError, setWatchlistError] = useState(false);

  // What's actually on screen: the browse/search results, or the Trakt
  // watchlist filtered by the movie/series tab + search box (client-side).
  const displayedItems = source === 'watchlist'
    ? watchlistItems.filter((i) =>
        i.type === type &&
        (!debouncedQuery || i.name.toLowerCase().includes(debouncedQuery.toLowerCase())))
    : items;
  const loading = source === 'watchlist' ? !watchlistLoaded : isLoading;
  const ratingsById = useRatingsBatch(displayedItems.map((i) => i.id));

  // Debounce typing so search isn't firing a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Is Trakt connected? Gates whether the Watchlist source is offered at all.
  useEffect(() => {
    api.getTraktStatus().then((s) => setTraktConnected(s.connected)).catch(() => setTraktConnected(false));
  }, []);

  // Load the Trakt watchlist once, the first time the user switches to it.
  useEffect(() => {
    if (source !== 'watchlist' || watchlistLoaded) return;
    let cancelled = false;
    api.getTraktWatchlist()
      .then((r) => { if (!cancelled) { setWatchlistItems(Array.isArray(r) ? r : []); setWatchlistError(false); } })
      .catch(() => { if (!cancelled) { setWatchlistItems([]); setWatchlistError(true); } })
      .finally(() => { if (!cancelled) setWatchlistLoaded(true); });
    return () => { cancelled = true; };
  }, [source, watchlistLoaded]);

  // First-page fetch — reruns whenever type/catalog/genre/search changes.
  // Search hits a different endpoint and doesn't support pagination, so it
  // just replaces items and marks the list as complete.
  useEffect(() => {
    if (source !== 'discover') return;
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
      const gotFullPage = !debouncedQuery && results.length >= MORE_PAGES_THRESHOLD;
      setHasMore(gotFullPage);
      setSkip(results.length);
    });

    return () => {
      cancelled = true;
    };
  }, [type, catalog, genre, debouncedQuery, source]);

  // Load the next page and append. No-op if already loading, search-mode
  // (no pagination on Cinemeta's search), or the last page came back short.
  const loadMore = useCallback(async () => {
    if (source !== 'discover' || debouncedQuery || !hasMore || loadMoreLock.current) return;
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
      setHasMore(next.length >= MORE_PAGES_THRESHOLD);
    } finally {
      setIsLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [source, debouncedQuery, hasMore, type, catalog, genre, skip]);

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

        {/* Source: Cinemeta catalogs vs. your own Trakt watchlist (only shown
            once Trakt is connected). */}
        {traktConnected && (
          <PageSection delay={0.07} className="mb-4">
            <div className="flex gap-2">
              {([['discover', 'Discover'], ['watchlist', '★ Your Watchlist']] as const).map(([key, label]) => (
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
                </button>
              ))}
            </div>
          </PageSection>
        )}

        {source === 'discover' && !debouncedQuery && (
          <PageSection delay={0.08} className="mb-4">
            <div className="flex gap-2 flex-wrap">
              {CATALOGS.map((c) => (
                <button
                  key={c.key}
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
              ))}
            </div>
          </PageSection>
        )}

        {/* Genre pills — only meaningful in Discover browse mode. Hidden
            during search (Cinemeta's search endpoint ignores genre extras)
            and on the watchlist source (client-side title filter only). */}
        {source === 'discover' && !debouncedQuery && (
          <PageSection delay={0.09} className="mb-6">
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setGenre('')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  genre === ''
                    ? 'bg-primary text-white'
                    : 'bg-surface-hover text-muted hover:text-default'
                }`}
              >
                All genres
              </button>
              {GENRES.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGenre(g)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    genre === g
                      ? 'bg-primary text-white'
                      : 'bg-surface-hover text-muted hover:text-default'
                  }`}
                >
                  {g}
                </button>
              ))}
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
                {source === 'watchlist'
                  ? (watchlistError
                      ? 'Couldn’t load your Trakt watchlist.'
                      : `Nothing in your watchlist${debouncedQuery ? ' matches your search' : type === 'movie' ? ' under Movies' : ' under Series'}.`)
                  : 'No results found.'}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
                {displayedItems.map((item) => (
                  <PosterCard key={item.id} item={item} ratings={ratingsById[item.id]} onOpenDetails={setDetailItem} />
                ))}
              </div>

              {/* Infinite-scroll sentinel + spinner. Only rendered in Discover
                  browse mode (watchlist is fully-loaded client-side, search
                  doesn't paginate). The sentinel sits ~400px below the grid's
                  end so we start fetching before the user hits true bottom. */}
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
