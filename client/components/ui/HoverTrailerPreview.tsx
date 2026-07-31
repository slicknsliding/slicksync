'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '@/lib/api';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';

interface HoverTrailerPreviewProps {
  itemId: string | null | undefined; // IMDb id
  itemType: string;
  children: React.ReactNode; // the poster image/card content, rendered as-is
  className?: string;
}

// Delay before a hover "counts" - avoids firing a real API call + YouTube
// embed for every incidental mouse pass across a grid of posters.
const HOVER_INTENT_MS = 600;

// Wraps a poster (any poster - this makes no assumption about the
// surrounding card's own onClick/layout) with a muted hover-preview trailer
// snippet, reusing the same TMDb-sourced trailers array MediaDetailModal
// already fetches via getMediaDetails. Renders children completely
// unmodified when the feature is off (Settings -> SlickTrax) or when there's
// no itemId to look up - this should never be the reason a poster looks or
// behaves differently.
export function HoverTrailerPreview({ itemId, itemType, children, className }: HoverTrailerPreviewProps) {
  const { enableHoverPreviewTrailers } = usePersonalFeatures();
  const [trailerId, setTrailerId] = useState<string | null>(null);
  const [showTrailer, setShowTrailer] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchedForRef = useRef<string | null>(null);

  // Defensive reset if this component instance ever gets reused for a
  // different item (e.g. a virtualized/recycled list) - ordinary .map()
  // rendering with a stable key never hits this, but it's cheap insurance.
  useEffect(() => {
    fetchedForRef.current = null;
    setTrailerId(null);
    setShowTrailer(false);
  }, [itemId]);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  const handleEnter = useCallback(() => {
    if (!enableHoverPreviewTrailers || !itemId) return;
    clearTimer();
    timerRef.current = setTimeout(async () => {
      if (fetchedForRef.current !== itemId) {
        fetchedForRef.current = itemId;
        try {
          const details = await api.getMediaDetails(itemId, itemType);
          const id = details?.trailers?.[0] || null;
          setTrailerId(id);
        } catch {
          setTrailerId(null);
        }
      }
      setShowTrailer(true);
    }, HOVER_INTENT_MS);
  }, [enableHoverPreviewTrailers, itemId, itemType]);

  const handleLeave = useCallback(() => {
    clearTimer();
    setShowTrailer(false);
  }, []);

  useEffect(() => () => clearTimer(), []);

  if (!enableHoverPreviewTrailers) return <>{children}</>;

  return (
    <div className={`relative ${className || ''}`} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {showTrailer && trailerId && (
        <div className="absolute inset-0 overflow-hidden rounded-[inherit]" style={{ pointerEvents: 'none' }}>
          <iframe
            key={trailerId}
            src={`https://www.youtube.com/embed/${trailerId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerId}&modestbranding=1&rel=0`}
            title="Trailer preview"
            className="absolute inset-0 w-full h-full"
            style={{ pointerEvents: 'none' }}
            allow="autoplay; encrypted-media"
          />
        </div>
      )}
    </div>
  );
}
