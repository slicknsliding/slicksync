'use client';

import { useState, useEffect, memo } from 'react';
import { Header } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
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
  const [type, setType] = useState<'movie' | 'series'>('movie');
  const [catalog, setCatalog] = useState('top');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [detailItem, setDetailItem] = useState<DiscoverItem | null>(null);
  const ratingsById = useRatingsBatch(items.map((i) => i.id));

  // Debounce typing so search isn't firing a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  useEffect(() => {
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
  }, [type, catalog, debouncedQuery]);

  const searchConfig: PageToolbarProps['searchConfig'] = {
    value: searchQuery,
    onChange: setSearchQuery,
    placeholder: `Search ${type === 'movie' ? 'movies' : 'series'}...`,
  };

  return (
    <>
      <Header
        title="Discover"
        subtitle="Browse or search for something to watch, then open it straight in Stremio or Nuvio"
      />

      <div className="p-8">
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

        {!debouncedQuery && (
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
          {isLoading ? (
            <div className="flex items-center justify-center py-24 text-muted">
              <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-24 text-muted">
              <MagnifyingGlassIcon className="w-10 h-10 mx-auto mb-3 text-subtle" />
              <p>No results found.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
              {items.map((item) => (
                <PosterCard key={item.id} item={item} ratings={ratingsById[item.id]} onOpenDetails={setDetailItem} />
              ))}
            </div>
          )}
        </PageSection>
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
