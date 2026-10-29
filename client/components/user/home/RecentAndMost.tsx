'use client';

// Recently watched (back-to-back episodes folded into one entry) next to the
// top five Most Watched. Side by side on a computer, stacked on a phone.

import Link from 'next/link';
import { Badge } from '@/components/ui';
import { cachedImageUrl } from '@/lib/posterUrl';
import { providerBadgeVariant, providerTypeLabel } from '@/lib/providers';
import type { MostWatchedItem, RecentlyWatchedGroup } from '@/lib/user-api';

function Poster({ src }: { src: string | null | undefined }) {
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={cachedImageUrl(src, 64) || src} alt="" className="w-9 h-[52px] rounded-md object-cover shrink-0" />
    : <span className="w-9 h-[52px] rounded-md shrink-0" style={{ background: 'var(--color-surface-elevated)' }} />;
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })}, ${time}`;
}

function what(g: RecentlyWatchedGroup): string {
  if (g.type === 'movie') return 'Movie';
  const s = g.season != null ? `S${String(g.season).padStart(2, '0')}` : '';
  const e = g.fromEpisode != null
    ? (g.toEpisode != null && g.toEpisode !== g.fromEpisode ? `E${String(g.fromEpisode).padStart(2, '0')}–E${String(g.toEpisode).padStart(2, '0')}` : `E${String(g.fromEpisode).padStart(2, '0')}`)
    : '';
  const range = [s, e].filter(Boolean).join(' · ');
  return g.count > 1 ? `${range} (${g.count} episodes)` : range || 'Episode';
}

const box = { background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' };

export function RecentAndMost({ recent, most, provider }: { recent: RecentlyWatchedGroup[]; most: MostWatchedItem[]; provider: string | null }) {
  if (recent.length === 0 && most.length === 0) return null;
  const app = providerTypeLabel(provider || 'stremio');
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
      {recent.length > 0 && (
        <section className="rounded-2xl p-4 sm:p-5" style={box} aria-label="Recently watched">
          <div className="flex items-center mb-1.5">
            <h3 className="font-semibold flex-1" style={{ color: 'var(--color-text)' }}>Recently watched</h3>
            <Link href="/user/activity" className="text-xs hover:underline" style={{ color: 'var(--color-text-muted)' }}>All history ›</Link>
          </div>
          {recent.map((g) => (
            <div key={`${g.id}-${g.watchedAt}`} className="flex items-center gap-3 py-2">
              <Poster src={g.poster} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>{g.name}</p>
                <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{what(g)} · {when(g.watchedAt)}</p>
              </div>
              <Badge variant={providerBadgeVariant({ providerType: provider || 'stremio' })} size="sm" className="shrink-0">{app}</Badge>
            </div>
          ))}
        </section>
      )}
      {most.length > 0 && (
        <section className="rounded-2xl p-4 sm:p-5" style={box} aria-label="Most Watched">
          <h3 className="font-semibold mb-1.5" style={{ color: 'var(--color-text)' }}>Most Watched</h3>
          {most.map((m, i) => (
            <div key={m.id} className="flex items-center gap-3 py-2">
              <span className="w-3.5 text-[13px]" style={{ color: 'var(--color-text-muted)' }}>{i + 1}</span>
              <Poster src={m.poster} />
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>{m.name}</p>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{m.count} {m.count === 1 ? 'play' : 'plays'}</p>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
