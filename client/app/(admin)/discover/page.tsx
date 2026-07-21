'use client';

import { useState, useEffect, memo } from 'react';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [detailItem, setDetailItem] = useState<DiscoverItem | null>(null);

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

  useEffect(() => {
    if (source !== 'discover') return;
    let cancelled = false;
    setIsLoading(true);

    const request = debouncedQuery
      ? api.discoverSearch(type, debouncedQuery)
      : api.discoverBrowse(type, { catalog });

    request.then((results) => {
      if (cancelled) return;
      setItems(results);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [type, catalog, debouncedQuery, source]);

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
          <PageSection delay={0.08} className="mb-6">
            <div className="flex gap-2">
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
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
              {displayedItems.map((item) => (
                <PosterCard key={item.id} item={item} ratings={ratingsById[item.id]} onOpenDetails={setDetailItem} />
              ))}
            </div>
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
