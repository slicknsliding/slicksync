'use client';

// Activity's "This week": the week's total and the seven days as bars that
// spread to fill the width. Folds to one line; the fold is remembered on this
// device. `embedded` is for the v2 design, whose section already has the
// name and the fold.

import { useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import type { WatchTimeByDay } from '@/lib/user-api';

const FOLD_KEY = 'slicksync-activity-this-week-open';
const FOLD_EVENT = 'slicksync-this-week-fold';

// The fold is read from this device's storage after load (open until then),
// and kept in memory too so it still folds when storage is blocked.
let remembered: boolean | null = null;

function subscribe(cb: () => void) {
  window.addEventListener('storage', cb);
  window.addEventListener(FOLD_EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(FOLD_EVENT, cb);
  };
}

function readOpen(): boolean {
  if (remembered !== null) return remembered;
  try {
    return localStorage.getItem(FOLD_KEY) !== 'folded';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  remembered = open;
  try {
    localStorage.setItem(FOLD_KEY, open ? 'open' : 'folded');
  } catch { /* not remembered, still folds */ }
  window.dispatchEvent(new Event(FOLD_EVENT));
}

function total(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

function short(minutes: number): string {
  if (minutes <= 0) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function ThisWeekPanel({ days, embedded = false }: { days: WatchTimeByDay[]; embedded?: boolean }) {
  const open = useSyncExternalStore(subscribe, readOpen, () => true);

  const toggle = () => writeOpen(!open);

  const minutes = days.reduce((n, d) => n + (d.minutes || 0), 0);
  const movies = days.reduce((n, d) => n + (d.movies || 0), 0);
  const episodes = days.reduce((n, d) => n + (d.series || 0), 0);
  const counts = `${movies} ${movies === 1 ? 'movie' : 'movies'} · ${episodes} ${episodes === 1 ? 'episode' : 'episodes'}`;
  const busiest = Math.max(0, ...days.map((d) => d.minutes || 0));
  const shown = embedded || open;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="rounded-xl"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-surface-border)',
        padding: shown ? '20px' : '12px 20px',
      }}
    >
      {shown ? (
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-[150px]">
            {!embedded && (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={true}
                className="flex items-center gap-1 text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <ChevronDownIcon className="w-3.5 h-3.5" />
                This week
              </button>
            )}
            <div className="font-bold" style={{ fontSize: 20, color: 'var(--color-text)' }}>{total(minutes)}</div>
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{counts}</div>
          </div>

          <div className="flex gap-2" style={{ flex: '1 1 280px', minWidth: 0 }}>
            {days.map((d, i) => {
              const mins = d.minutes || 0;
              const isToday = i === days.length - 1;
              return (
                <div key={`${d.date}-${i}`} className="flex flex-col items-center gap-1" style={{ flex: '1 1 0', minWidth: 0 }}>
                  <div className="text-[11px] leading-none h-3 whitespace-nowrap" style={{ color: 'var(--color-text-muted)' }}>{short(mins)}</div>
                  <div className="flex items-end justify-center w-full" style={{ height: 56 }}>
                    <div
                      style={{
                        width: 'min(40px, 60%)',
                        height: mins > 0 && busiest > 0 ? Math.max(6, Math.round((mins / busiest) * 56)) : 3,
                        borderRadius: 6,
                        background: mins > 0 ? 'var(--color-primary)' : 'var(--color-surface-border)',
                      }}
                    />
                  </div>
                  <div
                    className={`text-[11px] leading-none ${isToday ? 'font-bold' : ''}`}
                    style={{ color: isToday ? 'var(--color-text)' : 'var(--color-text-muted)' }}
                  >
                    {isToday ? 'Today' : d.date}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={false}
          className="flex items-center gap-2 w-full text-left text-sm"
        >
          <ChevronDownIcon className="w-4 h-4 shrink-0 -rotate-90" style={{ color: 'var(--color-text-muted)' }} />
          <span className="font-bold" style={{ color: 'var(--color-text)' }}>This week</span>
          <span className="min-w-0 truncate" style={{ color: 'var(--color-text-muted)' }}>{total(minutes)} · {counts}</span>
        </button>
      )}
    </motion.div>
  );
}
