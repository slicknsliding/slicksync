'use client';

// A person's Library in the v2 page design: what they're in the middle of
// first (a bar along each poster shows how far in), then what they've watched,
// then what they've only saved. Search, Everything / Shows / Movies and Select
// sit on one row; picking titles (Select) is how one or many are deleted, so
// nothing the Classic page could do is lost. Grid or list stays their own
// switch on this page. Sections can be moved, folded and hidden.

import { ArrowTopRightOnSquareIcon, MagnifyingGlassIcon, TrashIcon, PlayIcon } from '@heroicons/react/24/outline';
import { ViewModeToggle } from '@/components/ui';
import { ArrangeButton, ArrangeBar, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { useBottomBarUp, useIsPhoneWidth } from '@/lib/pageHeader';
import type { LibraryItem } from '@/lib/user-api';
import { MeHead, MePoster, MeSeg, POSTER_GRID } from './MeBits';
import { V2Button, V2List } from './V2Bits';
import { V2MoreMenu, type V2MenuItem } from './V2Detail';

export type LibraryFilter = 'all' | 'series' | 'movie';

export const LIBRARY_SECTIONS = ['inprogress', 'watched', 'saved'] as const;
const LABELS: Record<string, string> = { inprogress: 'In progress', watched: 'Watched', saved: 'Saved' };

/** How far in, as a percentage; null when unknown. */
function percentIn(item: LibraryItem): number | null {
  const s = (item.state || {}) as { timeOffset?: number; duration?: number };
  if (s.duration && s.duration > 0 && s.timeOffset && s.timeOffset > 0) return Math.min(100, (s.timeOffset / s.duration) * 100);
  if (typeof item.progress === 'number' && item.progress > 0) return Math.min(100, item.progress);
  return null;
}

function kindOf(item: LibraryItem): 'inprogress' | 'watched' | 'saved' {
  const s = (item.state || {}) as { timeOffset?: number; timesWatched?: number; flaggedWatched?: number; overallTimeWatched?: number };
  const pct = percentIn(item);
  if (pct != null && pct < 95) return 'inprogress';
  if (pct == null && (s.timeOffset || 0) > 0) return 'inprogress';
  if ((pct != null && pct >= 95) || (s.timesWatched || 0) > 0 || (s.flaggedWatched || 0) > 0 || (s.overallTimeWatched || 0) > 0) return 'watched';
  return 'saved';
}

function lineOf(item: LibraryItem, watchTime: string | null, kind: string): string {
  const s = item.state || {};
  const bits: string[] = [];
  if (item.type === 'series' && s.season && s.episode) bits.push(`S${s.season} E${s.episode}`);
  else bits.push(item.type === 'series' ? 'Show' : 'Movie');
  if (kind !== 'inprogress' && watchTime) bits.push(watchTime);
  return bits.join(' · ');
}

export function MeLibraryV2({
  items, total, arrange, view, onView, search, onSearch, filter, onFilter,
  selecting, onSelecting, selected, onToggle, onSelectAll, onClear, onDeleteSelected, deleting, canDelete, onDeleteOne,
  linkOf, watchTimeOf, appName, openAppUrl, subtitle,
}: {
  /** What the search and the Everything / Shows / Movies switch leave. */
  items: LibraryItem[];
  total: number;
  arrange: PageArrange;
  view: 'grid' | 'list';
  onView: (v: 'grid' | 'list') => void;
  search: string;
  onSearch: (v: string) => void;
  filter: LibraryFilter;
  onFilter: (f: LibraryFilter) => void;
  selecting: boolean;
  onSelecting: (on: boolean) => void;
  selected: string[];
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDeleteSelected: () => void;
  deleting: boolean;
  canDelete: boolean;
  /** Deletes one title (the poster's ⋯ menu). */
  onDeleteOne?: (id: string) => void;
  linkOf: (item: LibraryItem) => string | null;
  watchTimeOf: (item: LibraryItem) => string | null;
  appName: string | null;
  openAppUrl: string | null;
  subtitle: string;
}) {
  const groups: Record<string, LibraryItem[]> = { inprogress: [], watched: [], saved: [] };
  for (const it of items) groups[kindOf(it)].push(it);
  const allPicked = items.length > 0 && selected.length === items.length;
  // A phone: the toolbar takes two rows, and the Select bar is pinned to the
  // bottom of the screen while picking.
  const phone = useIsPhoneWidth();
  useBottomBarUp(selecting);

  // One title's ⋯: open it in their app, or take it out of the library.
  const menuFor = (it: LibraryItem): V2MenuItem[] => {
    const link = linkOf(it);
    const items: V2MenuItem[] = [];
    if (link && appName) items.push({ label: `Open in ${appName}`, icon: <ArrowTopRightOnSquareIcon className="w-4 h-4" />, onClick: () => { window.location.href = link; } });
    if (canDelete && onDeleteOne) items.push({ label: 'Delete from library', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => onDeleteOne(it._id) });
    return items;
  };

  const row = (it: LibraryItem, kind: string) => {
    const link = linkOf(it);
    const pct = percentIn(it);
    const on = selected.includes(it._id);
    return (
      <div key={it._id} className="v2-row" style={on ? { background: 'var(--color-primary-muted)' } : undefined} onClick={selecting ? () => onToggle(it._id) : undefined} role={selecting ? 'button' : undefined}>
        <span className="relative w-10 h-14 rounded-md overflow-hidden shrink-0" style={{ background: 'var(--color-surface-elevated)' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {it.poster && <img src={it.poster} alt="" className="w-full h-full object-cover" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[14.5px] text-default truncate">{it.name}</div>
          <div className="text-muted text-[12.5px] truncate">{lineOf(it, watchTimeOf(it), kind)}{kind === 'inprogress' && pct != null ? ` · ${Math.round(pct)}% in` : ''}</div>
        </div>
        {selecting
          ? <input type="checkbox" checked={on} readOnly aria-label={`Pick ${it.name}`} />
          : (
            <>
              {link && <a href={link} className="v2-btn" title="Open in your app" onClick={(e) => e.stopPropagation()}><PlayIcon className="w-4 h-4" />Open</a>}
              <span onClick={(e) => e.stopPropagation()}><V2MoreMenu items={menuFor(it)} label={`${it.name} options`} /></span>
            </>
          )}
      </div>
    );
  };

  const body = (list: LibraryItem[], kind: string) => view === 'grid' ? (
    <div className={POSTER_GRID}>
      {list.map((it) => (
        <div key={it._id} className="relative min-w-0">
        <MePoster
          poster={it.poster}
          name={it.name}
          type={it.type}
          line={lineOf(it, watchTimeOf(it), kind)}
          progress={kind === 'inprogress' ? percentIn(it) ?? undefined : undefined}
          selecting={selecting}
          selected={selected.includes(it._id)}
          onSelect={() => onToggle(it._id)}
          href={linkOf(it)}
        />
        {!selecting && (
          <span className="absolute top-1.5 right-1.5 [&_button]:!p-1 [&_button]:!rounded-full [&_button]:!bg-black/65 [&_button]:!border-transparent [&_button]:!text-white">
            <V2MoreMenu items={menuFor(it)} label={`${it.name} options`} />
          </span>
        )}
        </div>
      ))}
    </div>
  ) : <V2List>{list.map((it) => row(it, kind))}</V2List>;

  return (
    <div>
      <MeHead
        title="Your library"
        sub={subtitle}
        actions={<>
          <ArrangeButton arrange={arrange} />
          {openAppUrl && appName && <a href={openAppUrl} className="v2-btn">Open in {appName}</a>}
        </>}
      />
      <ArrangeBar arrange={arrange} />

      {(() => {
        const searchBox = (
          <label className={`relative ${phone ? 'flex-1 min-w-0' : 'flex-1 min-w-[200px] sm:flex-none sm:w-[320px]'}`}>
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Find a title"
              aria-label="Find a title"
              className="w-full min-w-0 pl-9 pr-3 py-2 rounded-xl text-sm"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
            />
          </label>
        );
        const seg = <MeSeg value={filter} onChange={onFilter} options={[{ key: 'all', label: 'Everything' }, { key: 'series', label: 'Shows' }, { key: 'movie', label: 'Movies' }]} />;
        const selectBtn = <button type="button" className="v2-btn shrink-0" aria-pressed={selecting} onClick={() => { onSelecting(!selecting); if (selecting) onClear(); }}>{selecting ? 'Done' : 'Select'}</button>;
        // Row 1: search and the grid / list switch. Row 2: the tabs, Select at the end.
        // (There is nothing else to filter here, so no Filters button.)
        if (phone) {
          return (
            <>
              <div className="flex items-center gap-2 mb-2.5">
                {searchBox}
                <ViewModeToggle mode={view} onChange={onView} />
              </div>
              <div className="flex items-center gap-2 mb-2">
                {seg}
                <span className="flex-1" />
                {selectBtn}
              </div>
            </>
          );
        }
        return (
          <div className="flex flex-wrap items-center gap-2.5 mb-2">
            {searchBox}
            <span className="flex-1 max-sm:hidden" />
            {seg}
            {selectBtn}
            <ViewModeToggle mode={view} onChange={onView} />
          </div>
        );
      })()}

      {selecting && (
        <>
          <div
            role="region"
            aria-label="Picked titles"
            className="fixed left-4 right-4 bottom-4 z-[35] mx-auto flex items-center gap-3 p-3 rounded-xl"
            style={{
              maxWidth: '36rem',
              background: 'linear-gradient(var(--color-primary-muted), var(--color-primary-muted)), var(--color-surface)',
              border: '1px solid var(--color-surface-border)',
              boxShadow: '0 12px 32px -8px rgba(0,0,0,.65)',
            }}
          >
            <span className="text-sm font-medium text-default">{selected.length === 0 ? 'Tap titles to pick them' : `${selected.length} picked`}</span>
            <button type="button" className="text-sm underline text-primary" onClick={allPicked ? onClear : onSelectAll}>{allPicked ? 'Pick none' : 'Pick all'}</button>
            <span className="flex-1" />
            {canDelete && (
              <V2Button primary disabled={selected.length === 0 || deleting} onClick={onDeleteSelected} icon={<TrashIcon className="w-4 h-4" />}>Delete</V2Button>
            )}
          </div>
        </>
      )}

      {arrange.shown.map((key) => {
        const list = groups[key];
        if (!list || list.length === 0) return null;
        return (
          <ArrangeSection key={key} arrange={arrange} id={key} title={LABELS[key]} meta={`${list.length}`} noun="section">
            {body(list, key)}
          </ArrangeSection>
        );
      })}
      {total > 0 && <HiddenTray arrange={arrange} labelOf={(id) => LABELS[id] || id} />}
      {/* Keeps the last titles clear of the pinned bar. */}
      {selecting && <div aria-hidden className="h-20" />}
    </div>
  );
}
