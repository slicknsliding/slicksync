'use client';

// What a person has on right now, as the big picture at the top of their own
// Home: the show's artwork, how far in they are, and - once it's paused or
// stopped - Resume in their app. Nothing here while nothing plays.

import { PlayIcon } from '@heroicons/react/24/solid';
import { playbackFreshness } from '@/lib/playbackFreshness';
import { useSharedNow } from '@/lib/useSharedNow';
import { cachedImageUrl } from '@/lib/posterUrl';
import { useArtworkFallback } from '@/lib/hooks/useArtworkFallback';
import { estimatedPosition, formatClock } from '@/components/ui/NowPlayingPosition';
import { providerTypeLabel } from '@/lib/providers';
import type { NowPlayingItem } from '@/lib/user-api';

// Only the two apps' own addresses may open from here.
const safeAppUrl = (u: string | null | undefined) => (u && /^(stremio|nuvio):/i.test(u) ? u : null);
const imdbOf = (id: string) => /^tt\d+/.exec(id || '')?.[0] || null;

function minutesLeft(totalMs: number, atMs: number): string {
  const m = Math.max(0, Math.round((totalMs - atMs) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
}

export function NowPlayingBanner({ row, provider, profileLabel }: { row: NowPlayingItem; provider: string | null; profileLabel?: string | null }) {
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
  const episode = row.item.season && row.item.episode ? `Season ${row.item.season}, Episode ${row.item.episode}` : null;
  const where = [app, profileLabel].filter(Boolean).join(' · ');

  return (
    <section aria-label="Now Playing" className="relative mb-8 rounded-[20px] overflow-hidden h-[230px] sm:h-[300px] min-[2000px]:h-[340px]" style={{ border: '1px solid var(--color-surface-border)', background: 'var(--color-surface)' }}>
      {art && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cachedImageUrl(art, 780) || art} onError={onError} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: 'right center' }} />
      )}
      {/* Dark on the side the words sit on, so they read on every theme. */}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(10,12,20,.96) 0%, rgba(10,12,20,.85) 45%, rgba(10,12,20,.15) 100%)' }} />
      <div className="relative h-full flex flex-col justify-end gap-2 p-5 sm:p-8 max-w-full sm:max-w-[60%]">
        <p className="flex items-center gap-2 text-[13px]" style={{ color: '#e5e7eb' }}>
          <span className={`w-2 h-2 rounded-full ${playing ? 'animate-pulse' : ''}`} style={{ background: playing ? '#22c55e' : '#facc15', boxShadow: playing ? '0 0 0 4px rgba(34,197,94,.2)' : undefined }} />
          {playing ? `Playing in ${where}` : `Paused in ${where}`}
        </p>
        <h2 className="text-2xl sm:text-[34px] font-bold leading-tight text-white truncate">{row.item.name}</h2>
        {episode && <p className="text-sm" style={{ color: '#d1d5db' }}>{episode}</p>}
        {progress != null && (
          <div className="h-1.5 rounded-full mt-1.5" style={{ background: 'rgba(255,255,255,.18)' }}>
            <div className="h-full rounded-full" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }} />
          </div>
        )}
        {total && at != null && (
          <p className="text-[12.5px]" style={{ color: '#cbd5e1' }}>
            {playing ? 'About ' : 'Paused at '}{formatClock(at / 1000)} of {formatClock(total / 1000)} · {minutesLeft(total, at)}
          </p>
        )}
        {resumeUrl && (
          <div className="flex gap-2 mt-1.5">
            <a href={resumeUrl} className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-primary)' }}>
              <PlayIcon className="w-4 h-4" />
              Resume in {app}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
