'use client';

// Where playback is on a Now Playing card. While it plays live: "About 19:04
// of 1:35:50 (20%)" - the server cannot see the player's spot during
// playback, so it is the last checkpoint plus the time played since, and says
// "About". Resume buttons only once it is paused or stopped, with the exact
// checkpoint: a Resume button on something playing right now has nothing to
// resume. Shared by the Dashboard and Activity cards.

import { PlayIcon } from '@heroicons/react/24/outline';
import { playbackFreshness, type FreshnessRow } from '@/lib/playbackFreshness';
import { useSharedNow } from '@/lib/useSharedNow';

export interface NowPlayingPositionRow extends FreshnessRow {
  lastPosition?: number | null;
  totalDuration?: number | null;
  /** When playback stood at lastPosition, in ms - set for live proxy rows. */
  positionAt?: number | null;
  stremioAppUrl?: string | null;
  nuvioAppUrl?: string | null;
}

/** Clock-style H:MM:SS / M:SS. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
}

/** The estimated spot while playing, in ms, or null when there is no basis for one. */
export function estimatedPosition(row: NowPlayingPositionRow, now: number): number | null {
  if (typeof row.lastPosition !== 'number' || typeof row.positionAt !== 'number' || typeof row.totalDuration !== 'number' || row.totalDuration <= 0) return null;
  // A stream the server stopped confirming stops advancing too.
  const until = row.elapsedFrozen && typeof row.reportedAtTimestamp === 'number' ? Math.min(now, row.reportedAtTimestamp) : now;
  return Math.min(row.totalDuration, row.lastPosition + Math.max(0, until - row.positionAt));
}

export function NowPlayingPosition({ row, className = '' }: { row: NowPlayingPositionRow; className?: string }) {
  const now = useSharedNow();
  const total = row.totalDuration;
  if (typeof row.lastPosition !== 'number' || typeof total !== 'number' || total <= 0) return null;
  const state = playbackFreshness(row, now)?.state;
  const playing = state === 'live' || state === 'playing-estimated';

  if (playing) {
    const at = estimatedPosition(row, now);
    if (at == null) return null;
    return (
      <p className={`text-xs text-subtle mt-1.5 ${className}`}>
        About {formatClock(at / 1000)} of {formatClock(total / 1000)} ({Math.round((at / total) * 100)}%)
      </p>
    );
  }

  if (!row.stremioAppUrl && !row.nuvioAppUrl) return null;
  return (
    <div className={`flex items-center gap-2 mt-1.5 flex-wrap ${className}`}>
      <span className="text-xs text-subtle">
        {/* A proxy stream that has gone quiet was not necessarily paused:
            its checkpoint is only where playback last stood. */}
        {row.source === 'aiostreams-proxy' && row.paused !== true ? 'Last known position' : 'Paused at'}{' '}
        {formatClock(row.lastPosition / 1000)} of {formatClock(total / 1000)}
        {' '}({Math.round((row.lastPosition / total) * 100)}%)
      </span>
      {row.stremioAppUrl && (
        <a
          href={row.stremioAppUrl}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors"
          style={{ background: 'rgba(167, 139, 250, 0.15)', color: 'rgb(196, 181, 253)', border: '1px solid rgba(167, 139, 250, 0.25)' }}
        >
          <PlayIcon className="w-3 h-3" />
          Resume in Stremio
        </a>
      )}
      {row.nuvioAppUrl && (
        <a
          href={row.nuvioAppUrl}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors"
          style={{
            background: 'linear-gradient(115deg, rgba(56, 89, 158, 0.22) 0%, rgba(56, 89, 158, 0.22) 50%, rgba(255, 152, 0, 0.10) 50%, rgba(255, 152, 0, 0.10) 100%)',
            color: 'rgb(186, 208, 240)', border: '1px solid rgba(255, 152, 0, 0.18)',
          }}
        >
          <PlayIcon className="w-3 h-3" />
          Resume in Nuvio
        </a>
      )}
    </div>
  );
}

/** The Nuvio (or AIOStreams) profile a viewing is under, as a small chip. */
export function ProfileChip({ label }: { label?: string | null }) {
  if (!label) return null;
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-300 whitespace-nowrap">{label}</span>;
}
