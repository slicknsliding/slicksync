import { FilmIcon, TvIcon } from '@heroicons/react/24/outline';
import { CustomListItem } from '@/lib/api';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl } from '@/lib/posterUrl';
import { HoverTrailerPreview } from './HoverTrailerPreview';

// Small poster tile shared between the Lists index and a list's own detail
// page (roadmap #7) - kept out of either page.tsx since Next's App Router
// only expects a fixed set of named exports from a page file.
export function PosterThumb({ item, className = '' }: { item: CustomListItem; className?: string }) {
  const { rpdbEnabled } = usePersonalFeatures();
  const src = posterUrl(item, rpdbEnabled);
  return (
    <div className={`rounded-md overflow-hidden bg-surface-hover flex items-center justify-center ${className}`}>
      {src ? (
        <HoverTrailerPreview itemId={item.id} itemType={item.type} className="w-full h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" className="w-full h-full object-cover" />
        </HoverTrailerPreview>
      ) : (
        item.type === 'series'
          ? <TvIcon className="w-5 h-5 text-subtle" />
          : <FilmIcon className="w-5 h-5 text-subtle" />
      )}
    </div>
  );
}
