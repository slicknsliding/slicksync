'use client';

// A person's Activity in the v2 page design: the Now Playing banner when
// something is on, their numbers in one strip, the watch-time charts, then
// what they watched grouped by day. Each of those is a section they can move,
// fold and hide; the search and the grid / list switch stay on this page.

import type { ReactNode } from 'react';
import { ClockIcon, FilmIcon, MagnifyingGlassIcon, TvIcon } from '@heroicons/react/24/outline';
import { ViewModeToggle } from '@/components/ui';
import { ArrangeButton, ArrangeBar, ArrangePanel, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import { NowPlayingBanner } from '@/components/user/home/NowPlayingBanner';
import type { PageArrange } from '@/lib/arrange';
import type { NowPlayingItem, WatchSession } from '@/lib/user-api';
import { MeHead, MePoster, POSTER_GRID } from './MeBits';
import { V2List, V2Status } from './V2Bits';
import { V2Numbers } from './V2Detail';

export const ACTIVITY_LABELS: Record<string, string> = {
  nowPlaying: 'Now Playing', numbers: 'Your numbers', charts: 'This week', feed: 'What you watched',
};

export type ActivityGroup = {
  dateKey: string;
  label: string;
  sessions: WatchSession[];
  totalDuration: number;
};

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function episodeOf(s: WatchSession): string | null {
  if (s.itemType !== 'series' || !s.episode || s.episode <= 0) return null;
  return s.season && s.season > 0 ? `S${s.season} E${s.episode}` : `E${s.episode}`;
}

export function MeActivityV2({
  arrange, shown, nowPlaying, provider, profileLabel, numbers, charts, groups, empty,
  search, onSearch, view, onView, onFilterByContent,
}: {
  arrange: PageArrange;
  /** Keys the page offers, in default order. */
  shown: string[];
  nowPlaying: NowPlayingItem[];
  provider: string | null;
  profileLabel?: string | null;
  numbers: { label: string; value: string; sub?: string }[] | null;
  charts: ReactNode;
  groups: ActivityGroup[];
  /** Said where the feed would be (nothing watched yet, or nothing matches). */
  empty: ReactNode;
  search: string;
  onSearch: (v: string) => void;
  view: 'grid' | 'list';
  onView: (v: 'grid' | 'list') => void;
  onFilterByContent: (name: string) => void;
}) {
  const count = groups.reduce((n, g) => n + g.sessions.length, 0);

  const row = (s: WatchSession) => {
    const start = new Date(s.startTime);
    const end = s.endTime ? new Date(s.endTime) : null;
    const ep = episodeOf(s);
    const length = !s.isSynthetic && s.durationSeconds !== undefined ? (s.durationSeconds > 0 ? duration(s.durationSeconds) : 'under 1 min') : null;
    return (
      <div key={s.id} className="v2-row">
        <button type="button" className="relative w-10 h-14 rounded-md overflow-hidden shrink-0 flex items-center justify-center" style={{ background: 'var(--color-surface-elevated)' }} onClick={() => onFilterByContent(s.itemName)} aria-label={`Show only ${s.itemName}`}>
          {s.poster
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={s.poster} alt="" className="w-full h-full object-cover" />
            : s.itemType === 'movie' ? <FilmIcon className="w-5 h-5 text-subtle" /> : <TvIcon className="w-5 h-5 text-subtle" />}
        </button>
        <div className="flex-1 min-w-0">
          <button type="button" className="font-semibold text-[14.5px] text-default block break-words max-w-full text-left" onClick={() => onFilterByContent(s.itemName)}>
            {s.itemName}{ep && <span className="text-muted font-normal"> · {ep}</span>}
          </button>
          <div className="text-muted text-[12.5px] truncate">
            {length && <>{length} · </>}{clock(start)}{end && !s.isSynthetic ? ` → ${clock(end)}` : ''}
          </div>
        </div>
      </div>
    );
  };

  const tile = (s: WatchSession) => {
    const ep = episodeOf(s);
    return (
      <MePoster
        key={s.id}
        poster={s.poster}
        name={s.itemName}
        type={s.itemType}
        line={[ep, !s.isSynthetic && s.durationSeconds > 0 ? duration(s.durationSeconds) : null, clock(new Date(s.startTime))].filter(Boolean).join(' · ')}
        selecting
        onSelect={() => onFilterByContent(s.itemName)}
      />
    );
  };

  return (
    <div>
      <MeHead
        title="Your activity"
        sub={nowPlaying.length > 0 ? <V2Status tone="live">Watching now</V2Status> : 'What you’ve watched and how much'}
        actions={<ArrangeButton arrange={arrange} />}
      />
      <ArrangeBar arrange={arrange} />

      {shown.map((key) => {
        if (key === 'nowPlaying') {
          if (nowPlaying.length === 0) return null;
          return (
            <ArrangePanel key={key} arrange={arrange} id={key} label={ACTIVITY_LABELS[key]} ownHeading={false}>
              {nowPlaying.map((np, i) => <NowPlayingBanner key={`${np.item.id}-${i}`} row={np} provider={provider} profileLabel={profileLabel} />)}
            </ArrangePanel>
          );
        }
        if (key === 'numbers') {
          if (!numbers) return null;
          return (
            <ArrangePanel key={key} arrange={arrange} id={key} label={ACTIVITY_LABELS[key]} ownHeading={false}>
              <div className="mb-6"><V2Numbers items={numbers} /></div>
            </ArrangePanel>
          );
        }
        if (key === 'charts') {
          if (!numbers) return null;
          return (
            <ArrangeSection key={key} arrange={arrange} id={key} title="This week" meta="watch time" noun="section">
              {charts}
            </ArrangeSection>
          );
        }
        if (key === 'feed') {
          return (
            <ArrangeSection key={key} arrange={arrange} id={key} title="What you watched" meta={count > 0 ? `${count}` : undefined} noun="section">
              <div className="flex flex-wrap items-center gap-2.5 mb-4">
                <label className="relative flex-1 min-w-[200px] sm:flex-none sm:w-[320px]">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    placeholder="Find a title"
                    aria-label="Find a title"
                    className="w-full pl-9 pr-3 py-2 rounded-xl text-sm"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                  />
                </label>
                <span className="flex-1 max-sm:hidden" />
                <ViewModeToggle mode={view} onChange={onView} />
              </div>
              {groups.map((g) => (
                <div key={g.dateKey} className="mb-5">
                  <div className="flex items-baseline gap-2.5 mb-2.5">
                    <ClockIcon className="w-4 h-4 text-muted self-center" />
                    <h3 className="text-[15px] font-semibold">{g.label}</h3>
                    <span className="text-muted text-[13px]">{duration(g.totalDuration)} · {g.sessions.length}</span>
                  </div>
                  {view === 'grid'
                    ? <div className={POSTER_GRID}>{g.sessions.map(tile)}</div>
                    : <V2List>{g.sessions.map(row)}</V2List>}
                </div>
              ))}
              {groups.length === 0 && empty}
            </ArrangeSection>
          );
        }
        return null;
      })}
      <HiddenTray arrange={arrange} labelOf={(id) => ACTIVITY_LABELS[id] || id} />
    </div>
  );
}
