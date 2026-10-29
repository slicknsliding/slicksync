'use client';

// A person's numbers in one compact row: this week, today, streak, all time.

import type { UserActivityStats, WatchTimeByDay } from '@/lib/user-api';

function hm(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function HomeNumbers({ stats, byDay }: { stats: UserActivityStats; byDay: WatchTimeByDay[] }) {
  const weekSeconds = byDay.reduce((sum, d) => sum + (d.hours || 0) * 3600 + (d.minutes || 0) * 60, 0);
  const cells: [string, string][] = [
    ['This week', hm(weekSeconds)],
    ['Today', hm(stats.watchTimeTodaySeconds)],
    ['Streak', `${stats.currentStreak} ${stats.currentStreak === 1 ? 'day' : 'days'}`],
    ['All time', hm(stats.totalWatchTimeSeconds)],
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr] gap-3 mb-8">
      {cells.map(([label, value]) => (
        <div key={label} className="px-4 py-3 rounded-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{label}</p>
          <p className="text-base sm:text-lg font-bold mt-0.5" style={{ color: 'var(--color-text)' }}>{value}</p>
        </div>
      ))}
    </div>
  );
}
