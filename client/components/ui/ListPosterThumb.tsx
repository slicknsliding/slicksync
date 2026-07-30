import { FilmIcon, TvIcon } from '@heroicons/react/24/outline';
import { CustomListItem } from '@/lib/api';

// Small poster tile shared between the Lists index and a list's own detail
// page (roadmap #7) - kept out of either page.tsx since Next's App Router
// only expects a fixed set of named exports from a page file.
export function PosterThumb({ item, className = '' }: { item: CustomListItem; className?: string }) {
  return (
    <div className={`rounded-md overflow-hidden bg-surface-hover flex items-center justify-center ${className}`}>
      {item.poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.poster} alt="" className="w-full h-full object-cover" />
      ) : (
        item.type === 'series'
          ? <TvIcon className="w-5 h-5 text-subtle" />
          : <FilmIcon className="w-5 h-5 text-subtle" />
      )}
    </div>
  );
}
