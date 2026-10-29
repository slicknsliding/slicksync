'use client';

// Upcoming on a person's own Home: the next episodes of the shows they watch.
// A strip of the dates that have episodes (dots for how many), then the
// episodes - cards in grid view, rows in list view. Hidden when nothing is due.

import { useEffect, useMemo, useState } from 'react';
import { useUserAuth } from '@/lib/hooks/useUserAuth';
import { cachedImageUrl } from '@/lib/posterUrl';
import { useSharedNow } from '@/lib/useSharedNow';
import { userUpcoming, type UpcomingEpisodeItem } from '@/lib/user-api';

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function relative(at: Date, now: number): string {
  const ms = at.getTime() - now;
  if (ms <= 0) return 'Out now';
  const h = Math.round(ms / 3600000);
  if (h < 24) return `in ${Math.max(1, h)} h`;
  const days = Math.round(ms / 86400000);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function whenLabel(at: Date, now: number): string {
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = dayKey(new Date(now)) === dayKey(at);
  return `${today ? 'Today' : at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${time}`;
}

const code = (e: UpcomingEpisodeItem) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}`;

export function UpcomingSection({ view }: { view: 'grid' | 'list' }) {
  const { userId, authKey } = useUserAuth();
  const now = useSharedNow();
  const [items, setItems] = useState<{ forUser: string; list: UpcomingEpisodeItem[] } | null>(null);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !authKey) return;
    let stale = false;
    userUpcoming.list(userId, authKey).then((r) => { if (!stale) setItems({ forUser: userId, list: r.items }); }).catch(() => {});
    return () => { stale = true; };
  }, [userId, authKey]);

  const list = useMemo(() => (items && items.forUser === userId ? items.list : []), [items, userId]);
  const days = useMemo(() => {
    const m = new Map<string, { date: Date; count: number }>();
    for (const e of list) {
      const d = new Date(e.airDate);
      const k = dayKey(d);
      const cur = m.get(k);
      if (cur) cur.count++; else m.set(k, { date: d, count: 1 });
    }
    return [...m.entries()].slice(0, 8);
  }, [list]);
  if (list.length === 0) return null;

  const todayKey = dayKey(new Date(now));
  const shown = day ? list.filter((e) => dayKey(new Date(e.airDate)) === day) : list;

  return (
    <section className="mb-8" aria-label="Upcoming">
      <h3 className="text-lg font-semibold mb-3" style={{ color: 'var(--color-text)' }}>Upcoming</h3>
      <div className="flex gap-2 overflow-x-auto pb-1 mb-3" role="tablist" aria-label="Days">
        {days.map(([k, { date, count }]) => {
          const on = day === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setDay(on ? null : k)}
              className={`shrink-0 w-[74px] py-2.5 rounded-2xl text-center border transition-colors ${on ? 'upcoming-day-on' : ''}`}
              style={{ background: on ? 'var(--color-primary-muted)' : 'var(--color-surface)', borderColor: on ? 'var(--color-primary)' : 'var(--color-surface-border)' }}
            >
              <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>{k === todayKey ? 'Today' : date.toLocaleDateString([], { weekday: 'short' })}</span>
              <span className="block text-[22px] font-bold" style={{ color: 'var(--color-text)' }}>{date.getDate()}</span>
              <span className="flex gap-[3px] justify-center mt-1" aria-label={`${count} ${count === 1 ? 'episode' : 'episodes'}`}>
                {Array.from({ length: Math.min(count, 3) }, (_, i) => <span key={i} className="w-[5px] h-[5px] rounded-full" style={{ background: 'var(--color-primary)' }} />)}
              </span>
            </button>
          );
        })}
      </div>
      {view === 'list' ? (
        <div className="rounded-2xl px-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
          {shown.map((e) => {
            const at = new Date(e.airDate);
            return (
              <div key={`${e.showId}-${e.season}-${e.episode}`} className="flex items-center gap-4 px-2 py-2.5 border-b last:border-b-0" style={{ borderColor: 'var(--color-surface-border)' }}>
                <span className="w-24 shrink-0 text-[13px] font-semibold" style={{ color: 'var(--color-primary)' }}>{relative(at, now)}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {e.poster ? <img src={cachedImageUrl(e.poster, 64) || e.poster} alt="" className="w-[30px] h-[44px] rounded object-cover shrink-0" /> : <span className="w-[30px] h-[44px] rounded shrink-0" style={{ background: 'var(--color-surface-elevated)' }} />}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>{e.showName || e.showId}</span>
                  <span className="block text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{code(e)}</span>
                </span>
                <span className="hidden sm:block text-xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>{whenLabel(at, now)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {shown.map((e) => {
            const at = new Date(e.airDate);
            return (
              <div key={`${e.showId}-${e.season}-${e.episode}`} className="shrink-0 w-[260px] sm:w-[280px] flex gap-3 p-3 rounded-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {e.poster ? <img src={cachedImageUrl(e.poster, 154) || e.poster} alt="" className="w-[52px] h-[78px] rounded-lg object-cover shrink-0" /> : <span className="w-[52px] h-[78px] rounded-lg shrink-0" style={{ background: 'var(--color-surface-elevated)' }} />}
                <span className="min-w-0">
                  <span className="block text-xs font-semibold" style={{ color: 'var(--color-primary)' }}>{relative(at, now)}</span>
                  <span className="block text-sm font-semibold truncate mt-0.5" style={{ color: 'var(--color-text)' }}>{e.showName || e.showId}</span>
                  <span className="block text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{code(e)}</span>
                  <span className="block text-xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>{whenLabel(at, now)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
