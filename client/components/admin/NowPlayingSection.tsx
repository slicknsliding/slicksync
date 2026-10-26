'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Badge, UserAvatar } from '@/components/ui';
import { PlaybackDot, PlaybackFreshnessLine } from '@/components/ui/PlaybackFreshness';
import { PlayIcon, FilmIcon, TvIcon } from '@heroicons/react/24/outline';

interface NowPlayingItem {
  user: {
    id: string;
    username: string;
    email?: string;
    colorIndex?: number;
    avatarUrl?: string | null;
    useGravatar?: boolean;
  };
  item: {
    id: string;
    name: string;
    type: string;
    year?: number;
    poster?: string;
    season?: number;
    episode?: number;
    titlePending?: boolean;
  };
  watchedAt: string;
  watchedAtTimestamp?: number;
  source?: string;
  // Proxy-sourced entries only - real elapsed time we can stand behind,
  // frozen once proxy traffic goes quiet instead of climbing forever off
  // raw wall-clock (see server/utils/proxyNowPlaying.js). Prefer this over
  // watchedAtTimestamp whenever present.
  elapsedSeconds?: number;
  /** True once the proxy has stopped reconfirming the stream - the figure
   *  above is then final and must not be counted past. */
  elapsedFrozen?: boolean;
  // For the freshness line under the card (lib/playbackFreshness.ts).
  reportedAtTimestamp?: number;
  paused?: boolean;
  playingUntilTimestamp?: number;
  // Where playback stood at the provider's last checkpoint, and the links
  // that open the title in each app - the same fields the Activity page's
  // card shows, so the two read the same.
  lastPosition?: number | null;
  totalDuration?: number | null;
  stremioAppUrl?: string | null;
  nuvioAppUrl?: string | null;
  device?: { name: string | null; client: string | null } | null;
}

/** "Living room TV · Infuse" - the device and app a viewing is on, when known. */
function deviceLabel(device?: { name: string | null; client: string | null } | null) {
  return device ? [device.name, device.client].filter(Boolean).join(' · ') : '';
}

// How many people's cards the dashboard shows before pointing at Activity.
const MAX_SHOWN = 8;

interface NowPlayingSectionProps {
  items: NowPlayingItem[];
  /** Current time and when `items` was fetched - the elapsed counter shown
   *  per row is the server's figure plus the time since, so it keeps moving
   *  between polls without a fetch. Both optional; without them the
   *  server's figure is shown as-is. */
  now?: number;
  fetchedAt?: number;
}

export function NowPlayingSection({ items, now }: NowPlayingSectionProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted">
        No one is currently watching
      </div>
    );
  }

  // 3725 -> "1:02:05", 48 -> "0:48"
  const formatClock = (totalSeconds: number) => {
    const t = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = String(t % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  // How long this has been playing, worked out the way the Activity page
  // does: a stream the proxy is still confirming counts up from when it
  // started; once it stops confirming, the server's last figure stands.
  const watchingFor = (item: NowPlayingItem): string | null => {
    const startMs = typeof item.watchedAtTimestamp === 'number' ? item.watchedAtTimestamp : null;
    if (item.source === 'aiostreams-proxy' && typeof item.elapsedSeconds === 'number') {
      const live = !item.elapsedFrozen && startMs && now ? Math.max(0, Math.floor((now - startMs) / 1000)) : item.elapsedSeconds;
      return formatElapsed(Math.max(live, 0));
    }
    if (startMs && now) return formatElapsed(Math.max(0, Math.floor((now - startMs) / 1000)));
    return null;
  };

  const formatElapsed = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  return (
    // One card per person watching. With several people they sit side by
    // side on a wide screen instead of pushing the rest of the page down, and
    // past a screenful the rest are a tap away on the Activity page rather
    // than silently missing.
    <div className={items.length > 1 ? 'grid grid-cols-1 lg:grid-cols-2 gap-3' : 'space-y-3'}>
      {items.slice(0, MAX_SHOWN).map((item, index) => (
        <motion.div
          key={`${item.user.id}-${item.item.id}-${item.item.season ?? ''}-${item.item.episode ?? ''}-${index}`}
          initial={false}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.1 }}
          className="flex items-start gap-4 p-3 rounded-xl bg-surface-hover"
        >
          {/* User Avatar */}
          <div className="flex-shrink-0">
            <UserAvatar
              userId={item.user.id}
              name={item.user.username}
              email={item.user.email}
              src={item.user.useGravatar ? undefined : (item.user.avatarUrl ?? undefined)}
              useGravatar={item.user.useGravatar}
              colorIndex={item.user.colorIndex}
              size="md"
            />
          </div>

          {/* Item Poster */}
          <div className="flex-shrink-0 w-12 h-16 rounded-lg overflow-hidden bg-surface">
            {item.item.poster ? (
              <img
                src={item.item.poster}
                alt={item.item.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                {item.item.type === 'movie' ? (
                  <FilmIcon className="w-6 h-6 text-muted" />
                ) : (
                  <TvIcon className="w-6 h-6 text-muted" />
                )}
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <p className={`font-medium truncate ${item.item.titlePending ? 'text-muted' : 'text-default'}`}>{item.item.name}</p>
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="truncate">{item.user.username}</span>
              {item.item.type === 'series' && item.item.season && item.item.episode && (
                <>
                  <span>•</span>
                  <Badge variant="default" size="sm">
                    S{item.item.season.toString().padStart(2, '0')}E{item.item.episode.toString().padStart(2, '0')}
                  </Badge>
                </>
              )}
              {deviceLabel(item.device) && (
                <span className="truncate" title={`Playing on ${deviceLabel(item.device)}`}>• {deviceLabel(item.device)}</span>
              )}
            </div>
            {watchingFor(item) && (
              <p className="text-xs text-subtle mt-0.5">Watching for {watchingFor(item)}</p>
            )}
            <PlaybackFreshnessLine row={item} />
            {typeof item.lastPosition === 'number' && typeof item.totalDuration === 'number' && item.totalDuration > 0 && (item.stremioAppUrl || item.nuvioAppUrl) && (
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="text-xs text-subtle">
                  {/* The position is the provider's last checkpoint, written
                      at pause or stop - while the proxy shows the stream
                      live it is where playback last stood, not a pause. */}
                  {item.source === 'aiostreams-proxy' ? 'Last known position' : 'Paused at'}{' '}
                  {formatClock(item.lastPosition / 1000)} of {formatClock(item.totalDuration / 1000)}
                  {' '}({Math.round((item.lastPosition / item.totalDuration) * 100)}%)
                </span>
                {item.stremioAppUrl && (
                  <a
                    href={item.stremioAppUrl}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors"
                    style={{ background: 'rgba(167, 139, 250, 0.15)', color: 'rgb(196, 181, 253)', border: '1px solid rgba(167, 139, 250, 0.25)' }}
                  >
                    <PlayIcon className="w-3 h-3" />
                    Resume in Stremio
                  </a>
                )}
                {item.nuvioAppUrl && (
                  <a
                    href={item.nuvioAppUrl}
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
            )}
          </div>

          {/* Live indicator and Time Ago */}
          <div className="flex-shrink-0 self-center">
            <PlaybackDot row={item} />
          </div>
        </motion.div>
      ))}
      {items.length > MAX_SHOWN && (
        <Link href="/activity" className="text-sm text-muted hover:text-default transition-colors lg:col-span-2 text-center py-1">
          +{items.length - MAX_SHOWN} more watching - see Activity
        </Link>
      )}
    </div>
  );
}
