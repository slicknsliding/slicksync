'use client';

import { useEffect, useState, memo } from 'react';
import { SparklesIcon, FilmIcon, TvIcon } from '@heroicons/react/24/outline';
import { Card, MediaDetailModal } from '@/components/ui';
import { api, DiscoverItem, RecommendationRow } from '@/lib/api';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';

// "Because you watched X" recommendations on the Dashboard. Server picks up
// to 3 recent watches with distinct genres, and for each fetches Cinemeta
// Top Rated in that genre filtered to unwatched. Renders one horizontally-
// scrolling row per recommendation (same interaction as Continue Watching).
// Panel renders nothing when the server has no rows to suggest (no watch
// history yet, or every recommended item is already watched).

const RecPoster = memo(function RecPoster({
  item,
  onOpen,
}: {
  item: DiscoverItem;
  onOpen: (item: DiscoverItem) => void;
}) {
  const [imageError, setImageError] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="group relative shrink-0 w-32 md:w-36 text-left"
      title={item.name}
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-slate-800 shadow-md">
        {item.poster && !imageError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.poster}
            alt={item.name}
            loading="lazy"
            decoding="async"
            onError={() => setImageError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-slate-800">
            {item.type === 'movie'
              ? <FilmIcon className="w-8 h-8 text-slate-600" />
              : <TvIcon className="w-8 h-8 text-slate-600" />}
          </div>
        )}
      </div>
      <p className="mt-1.5 text-xs font-medium text-default line-clamp-2 leading-tight">
        {item.name}
      </p>
      {item.releaseInfo && (
        <p className="text-[11px] text-subtle">{item.releaseInfo}</p>
      )}
    </button>
  );
});

export const RecommendationsPanel = memo(function RecommendationsPanel() {
  const { enableRecommendations } = usePersonalFeatures();
  const [rows, setRows] = useState<RecommendationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<DiscoverItem | null>(null);

  useEffect(() => {
    if (!enableRecommendations) { setRows([]); setLoaded(true); return; }
    api.getRecommendations()
      .then((r) => setRows(Array.isArray(r?.rows) ? r.rows : []))
      .catch(() => setRows([]))
      .finally(() => setLoaded(true));
  }, [enableRecommendations]);

  if (!enableRecommendations || !loaded || rows.length === 0) return null;

  return (
    <>
      <div className="mb-6 space-y-4">
        {rows.map((row) => (
          <Card padding="lg" key={row.seedId}>
            <div className="flex items-center gap-2 mb-3">
              <SparklesIcon className="w-5 h-5 text-primary" />
              <h3 className="text-base font-semibold font-display text-default">{row.reason}</h3>
              <span className="text-xs text-muted">· Top Rated {row.genre}</span>
            </div>
            {/* Horizontally-scrolling poster row, same interaction as
                Continue Watching. Overflow hidden vertically so a tall
                title doesn't push the panel height around. */}
            <div className="flex gap-3 overflow-x-auto pb-1 no-scrollbar">
              {row.items.map((item) => (
                <RecPoster key={item.id} item={item} onOpen={setDetail} />
              ))}
            </div>
          </Card>
        ))}
      </div>

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.id}
          itemType={detail.type}
          fallbackTitle={detail.name}
          fallbackPoster={detail.poster}
        />
      )}
    </>
  );
});
