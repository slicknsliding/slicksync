'use client';

import { useEffect, useState } from 'react';
import { StarIcon, ClockIcon, FilmIcon, PlayIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { Modal } from './Modal';
import { Badge } from './Badge';
import { api, MediaDetails } from '@/lib/api';

interface MediaDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  itemId: string;
  itemType: 'movie' | 'series';
  videoId?: string | null;
  fallbackTitle: string;
  fallbackPoster?: string | null;
}

export function MediaDetailModal({
  isOpen,
  onClose,
  itemId,
  itemType,
  videoId,
  fallbackTitle,
  fallbackPoster,
}: MediaDetailModalProps) {
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Reset per-item, since the same modal instance is reused across clicks
    setDetails(null);
    setHasFetched(false);
    setIsLoading(true);
    setIsTrailerPlaying(false);

    let cancelled = false;
    api.getMediaDetails(itemId, itemType, videoId).then((result) => {
      if (cancelled) return;
      setDetails(result);
      setIsLoading(false);
      setHasFetched(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, itemId, itemType, videoId]);

  const title = details?.episode?.title
    ? `${details?.title || fallbackTitle} — ${details.episode.title}`
    : (details?.title || fallbackTitle);
  const heroImage = details?.episode?.thumbnail || details?.background || details?.poster || fallbackPoster;
  const overview = details?.episode?.overview || details?.description;
  const trailerId = details?.trailers?.[0];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" hideCloseButton={isTrailerPlaying}>
      <div className="-mx-6 -mt-6">
        {isTrailerPlaying && trailerId ? (
          // aspect-video (not a fixed height like the static hero below) -
          // YouTube's player always keeps its actual video content at 16:9
          // internally, so a fixed short height on a wide modal (size="full")
          // squished the container into a much wider-than-16:9 box and the
          // player letterboxed down to a thin strip in the middle of it.
          // Deriving height from width keeps the video itself full-size.
          <div className="relative w-full aspect-video max-h-[60vh] overflow-hidden rounded-t-2xl bg-black">
            <iframe
              src={`https://www.youtube.com/embed/${trailerId}?autoplay=1`}
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
            {/* Positioned low and to the right, clear of YouTube's own
                top-right controls (volume/CC/settings) - roughly level with
                YouTube's own bottom-row icons (share/save), past the right
                edge of its scrub bar. YouTube's own overlay isn't something
                we control, so this is an approximation, not a guarantee.
                Goes back to the poster/details view, not a full close -
                backdrop click and Escape still fully close the modal. */}
            <button
              type="button"
              onClick={() => setIsTrailerPlaying(false)}
              className="absolute bottom-9 right-2 z-10 p-1 rounded-md transition-colors"
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
              className="w-full h-full object-cover"
              style={{ objectPosition: 'center 15%' }}
            />
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(180deg, transparent 40%, var(--color-surface) 100%)' }}
            />
            {trailerId && (
              <button
                type="button"
                onClick={() => setIsTrailerPlaying(true)}
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
            )}
          </div>
        )}

        <div className="px-6 pb-2 pt-4">
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
              <div className="flex flex-wrap items-center gap-3 text-base text-muted">
                {details.releaseInfo && <span>{details.releaseInfo}</span>}
                {details.runtime && (
                  <span className="flex items-center gap-1.5">
                    <ClockIcon className="w-5 h-5" />
                    {details.runtime}
                  </span>
                )}
                {details.imdbRating && (
                  <span className="flex items-center gap-1.5 text-amber-400 font-medium">
                    <StarIcon className="w-5 h-5" />
                    {details.imdbRating}
                    <span className="text-muted font-normal">/10</span>
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
                    href={`https://www.themoviedb.org/${itemType === 'movie' ? 'movie' : 'tv'}/${details.moviedb_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    TMDb
                  </a>
                )}
              </div>

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

              {details.cast && details.cast.length > 0 && (
                <div>
                  <p className="text-base text-muted mb-2">Cast</p>
                  <div className="flex gap-4 overflow-x-auto pb-1 pr-6 no-scrollbar">
                    {details.cast.slice(0, 10).map((member) => (
                      <div key={member.name} className="shrink-0 w-24 text-center">
                        {member.photo ? (
                          <img
                            src={member.photo}
                            alt={member.name}
                            className="w-20 h-20 rounded-full object-cover mx-auto bg-surface-hover"
                          />
                        ) : (
                          <div className="w-20 h-20 rounded-full mx-auto bg-surface-hover flex items-center justify-center text-muted text-xl font-medium">
                            {member.name.charAt(0)}
                          </div>
                        )}
                        <p
                          className="mt-2 text-sm font-medium text-default leading-tight"
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
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {details.awards && (
                <p className="text-sm text-muted flex items-start gap-1.5">
                  <FilmIcon className="w-5 h-5 shrink-0 mt-0.5" />
                  {details.awards}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
