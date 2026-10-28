'use client';

// What a person has on right now, as the big picture at the top of their own
// Home: the show's artwork, how far in they are, and - once it's paused or
// stopped - Resume in their app. Nothing here while nothing plays.

import { useState, type ReactNode } from 'react';
import { PlayIcon } from '@heroicons/react/24/solid';
import { playbackFreshness } from '@/lib/playbackFreshness';
import { useSharedNow } from '@/lib/useSharedNow';
import { cachedImageUrl } from '@/lib/posterUrl';
import { useArtworkFallback } from '@/lib/hooks/useArtworkFallback';
import { estimatedPosition, formatClock } from '@/components/ui/NowPlayingPosition';
import { providerTypeLabel } from '@/lib/providers';
import type { NowPlayingItem } from '@/lib/user-api';
import { useNowPlayingProgress, useNowPlayingWho } from '@/lib/arrange';
import { MediaDetailModal } from '@/components/ui/MediaDetailModal';

// Only the two apps' own addresses may open from here.
const safeAppUrl = (u: string | null | undefined) => (u && /^(stremio|nuvio):/i.test(u) ? u : null);
const imdbOf = (id: string) => /^tt\d+/.exec(id || '')?.[0] || null;

function minutesLeft(totalMs: number, atMs: number): string {
  const m = Math.max(0, Math.round((totalMs - atMs) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
}
const minutesIn = (atMs: number) => {
  const m = Math.max(0, Math.round(atMs / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min in` : `${m} min in`;
};
const clockAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const agoText = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? 'just now' : m >= 60 ? `${Math.floor(m / 60)} h ago` : `${m} min ago`;
};

// What the banner reads from a row: a person's own Now Playing item and the
// admin pages' rows (who is watching what) both fit.
export type NowPlayingBannerRow = Pick<NowPlayingItem, 'item' | 'lastPosition' | 'totalDuration' | 'positionAt' | 'positionEstimated' | 'durationEstimated' | 'stremioAppUrl' | 'nuvioAppUrl' | 'source' | 'elapsedFrozen' | 'reportedAtTimestamp' | 'paused' | 'playingUntilTimestamp'> & {
  /** The room or device it is on, when the app reports one ("Living room"). */
  device?: { name: string | null; client: string | null } | null;
};

export function NowPlayingBanner({ row, provider, profileLabel, who, compact = false, flush = false }: {
  row: NowPlayingBannerRow;
  provider: string | null;
  profileLabel?: string | null;
  /** Admin pages: who is watching (picture and name), shown ahead of "Playing in". */
  who?: ReactNode;
  /** A smaller banner, for when several people are watching. */
  compact?: boolean;
  /** No space under it (the page spaces it). */
  flush?: boolean;
}) {
  const now = useSharedNow();
  const imdb = imdbOf(row.item.id);
  const { url: art, onError } = useArtworkFallback([
    imdb ? `https://images.metahub.space/background/medium/${imdb}/img` : null,
    row.item.poster,
  ]);
  const state = playbackFreshness(row, now)?.state;
  const playing = state === 'live' || state === 'playing-estimated';
  const app = providerTypeLabel(provider || 'stremio');
  const total = typeof row.totalDuration === 'number' && row.totalDuration > 0 ? row.totalDuration : null;
  const at = playing ? estimatedPosition(row, now) : (typeof row.lastPosition === 'number' ? row.lastPosition : null);
  const progress = total && at != null ? Math.min(100, (at / total) * 100) : null;
  const resumeUrl = !playing ? safeAppUrl(provider === 'nuvio' ? row.nuvioAppUrl : row.stremioAppUrl) : null;
  const episode = row.item.season && row.item.episode
    ? `Season ${row.item.season}, Episode ${row.item.episode}${row.item.episodeTitle ? ` · ${row.item.episodeTitle}` : ''}`
    : null;
  // How far in: the app's own numbers, or an estimate from when it started
  // (marked as one, and only while it plays).
  const estimated = !!(row.positionEstimated || row.durationEstimated);
  const progressUnder = useNowPlayingProgress().where === 'under';
  const timeLine = total && at != null ? (
    estimated && playing
      ? `About ${minutesIn(at)} · about ${minutesLeft(total, at)} · ends around ${clockAt(now + (total - at))}`
      : playing
        ? `${formatClock(at / 1000)} of ${formatClock(total / 1000)} · ${minutesLeft(total, at)} · ends ${clockAt(now + (total - at))}`
        : `Paused at ${formatClock(at / 1000)} of ${formatClock(total / 1000)} · ${minutesLeft(total, at)}${typeof row.reportedAtTimestamp === 'number' ? ` · paused ${agoText(now - row.reportedAtTimestamp)}` : ''}`
  ) : null;
  const estimateNote = estimated && playing
    ? (provider === 'nuvio' ? 'Estimated · exact once they pause' : 'Estimated from when it started')
    : null;
  const progressBlock = (onPicture: boolean) => (progress != null || timeLine) ? (
    <div className={onPicture ? '' : 'px-1 mt-2.5'}>
      {progress != null && (
        <div
          className={`h-1.5 rounded-full ${onPicture ? 'mt-1.5' : ''}`}
          style={{ background: estimated && playing
            ? `repeating-linear-gradient(90deg, ${onPicture ? 'rgba(255,255,255,.22)' : 'color-mix(in srgb, var(--color-text) 25%, transparent)'} 0 6px, transparent 6px 10px)`
            : (onPicture ? 'rgba(255,255,255,.18)' : 'var(--color-surface-hover)') }}
        >
          <div className="h-full rounded-full" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))', opacity: estimated && playing ? 0.8 : 1 }} />
        </div>
      )}
      {timeLine && <p className="text-[12.5px] mt-1.5" style={{ color: onPicture ? '#e5e7eb' : 'var(--color-text)' }}>{timeLine}</p>}
      {estimateNote && <p className="text-[11.5px]" style={{ color: onPicture ? '#9ca3af' : 'var(--color-text-muted)' }}>{estimateNote}</p>}
    </div>
  ) : null;
  const where = [app, profileLabel, row.device?.name || row.device?.client].filter(Boolean).join(' · ');
  // Who and where: on a line under the picture (the default) or on it.
  const under = useNowPlayingWho().where === 'under';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const baseId = (row.item.id || '').split(':')[0];
  const canOpen = !!baseId && !row.item.titlePending;
  const mediaType: 'movie' | 'series' = row.item.type === 'movie' ? 'movie' : 'series';
  const whoLine = (
    <div className={`flex items-center gap-2 min-w-0 ${under ? 'text-[13.5px] px-1 mt-2.5 text-default' : 'text-[13px]'}`} style={under ? undefined : { color: '#e5e7eb' }}>
      {who}
      <span className={`w-2 h-2 rounded-full shrink-0 ${playing ? 'animate-pulse' : ''}`} style={{ background: playing ? '#22c55e' : '#facc15', boxShadow: playing ? '0 0 0 4px rgba(34,197,94,.2)' : undefined }} />
      <span className="min-w-0 truncate">{playing ? `Playing in ${where}` : `Paused in ${where}`}</span>
    </div>
  );

  const banner = (
    <section
      aria-label="Now Playing"
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={canOpen ? (e) => { if (!(e.target as HTMLElement).closest('a,button')) setDetailsOpen(true); } : undefined}
      onKeyDown={canOpen ? (e) => { if (e.key === 'Enter') setDetailsOpen(true); } : undefined}
      className={`relative rounded-[20px] overflow-hidden ${canOpen ? 'cursor-pointer ' : ''}${flush || under || progressUnder ? '' : 'mb-8 '}${compact ? 'h-[176px]' : 'h-[230px] sm:h-[300px] min-[2000px]:h-[340px]'}`} style={{ border: '1px solid var(--color-surface-border)', background: 'var(--color-surface)' }}>
      {art && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cachedImageUrl(art, 780) || art} onError={onError} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: 'right center' }} />
      )}
      {/* Dark on the side the words sit on, so they read on every theme. */}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(10,12,20,.96) 0%, rgba(10,12,20,.85) 45%, rgba(10,12,20,.15) 100%)' }} />
      <div className={`relative h-full flex flex-col justify-end max-w-full ${compact ? 'p-3 gap-0.5 sm:max-w-[80%]' : 'gap-2 p-5 sm:p-8 sm:max-w-[60%]'}`}>
        {!under && whoLine}
        <h2 className={`font-bold leading-tight text-white line-clamp-2 ${compact ? 'text-lg' : 'text-2xl sm:text-[34px]'}`}>{row.item.name}</h2>
        {episode && <p className="text-sm" style={{ color: '#d1d5db' }}>{episode}</p>}
        {!progressUnder && progressBlock(true)}
        {resumeUrl && (
          <div className={`flex gap-2 ${compact ? 'mt-0.5' : 'mt-1.5'}`}>
            <a href={resumeUrl} className={`inline-flex items-center gap-2 rounded-full font-semibold text-white ${compact ? 'px-3 py-1 text-xs' : 'px-4 py-2 text-sm'}`} style={{ background: 'var(--color-primary)' }}>
              <PlayIcon className="w-4 h-4" />
              Resume in {app}
            </a>
          </div>
        )}
      </div>
    </section>
  );
  const details = detailsOpen && (
    <MediaDetailModal
      isOpen
      onClose={() => setDetailsOpen(false)}
      itemId={baseId}
      itemType={mediaType}
      videoId={row.item.season && row.item.episode ? `${baseId}:${row.item.season}:${row.item.episode}` : null}
      fallbackTitle={row.item.name}
      fallbackPoster={row.item.poster}
    />
  );
  if (!under && !progressUnder) return <>{banner}{details}</>;
  return (
    <div className={`min-w-0 ${flush ? '' : 'mb-8'}`}>
      {banner}
      {progressUnder && progressBlock(false)}
      {under && whoLine}
      {details}
    </div>
  );
}
