'use client';

// A person's Shares in the v2 page design: Sent to you and You sent as two
// tabs, new ones first with a New badge, each with Open. Add to library, Mark
// as viewed and Remove sit in each share's ⋯; Select picks several for the
// bulk bar. Search, the person filter and grid / list stay on this page.

import type { CSSProperties, ReactNode } from 'react';
import { BookmarkIcon, CheckIcon, FilmIcon, MagnifyingGlassIcon, TrashIcon, TvIcon } from '@heroicons/react/24/outline';
import { ViewModeToggle } from '@/components/ui';
import { ArrangeButton, ArrangeBar, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { useIsPhoneWidth } from '@/lib/pageHeader';
import type { Share } from '@/lib/user-api';
import { FiltersMenu, MeHead, MeSeg } from './MeBits';
import { V2List } from './V2Bits';
import { V2MoreMenu } from './V2Detail';

export const SHARE_SECTIONS = ['new', 'earlier', 'sent'] as const;
const LABELS: Record<string, string> = { new: 'New', earlier: 'Earlier', sent: 'Sent' };

export type SharesTab = 'received' | 'sent';

export function MeSharesV2({
  arrange, tab, onTab, received, sent, receivedCount, sentCount, unviewed, view, onView, toolbar, bulkBar, members,
  selecting, onSelecting, selected, onToggle, busy, inLibrary, linkOf, when,
  onAddToLibrary, onMarkViewed, onRemove, onClear, empty, phoneBar,
}: {
  arrange: PageArrange;
  tab: SharesTab;
  onTab: (t: SharesTab) => void;
  /** After the search and person filter. */
  received: Share[];
  sent: Share[];
  receivedCount: number;
  sentCount: number;
  unviewed: number;
  view: 'grid' | 'list';
  onView: (v: 'grid' | 'list') => void;
  /** Search and the person filter, as the page draws them. */
  toolbar: ReactNode;
  /** The bar for the shares picked (empty when none is). */
  bulkBar: ReactNode;
  members: ReactNode;
  selecting: boolean;
  onSelecting: (on: boolean) => void;
  selected: Set<string>;
  onToggle: (id: string) => void;
  busy: string | null;
  inLibrary: (itemId: string) => boolean;
  linkOf: (share: Share) => string;
  when: (iso: string) => string;
  onAddToLibrary: (s: Share) => void;
  onMarkViewed: (id: string) => void;
  onRemove: (id: string, type: SharesTab) => void;
  onClear: () => void;
  empty: ReactNode;
  /** The search and person filter, for the phone's two-row toolbar. */
  phoneBar?: {
    search: string;
    onSearch: (v: string) => void;
    /** Usernames to filter by; none means no Filters button. */
    people: string[];
    person: string;
    onPerson: (v: string) => void;
  };
}) {
  const phone = useIsPhoneWidth();
  const fresh = received.filter((s) => !s.viewedAt);
  const earlier = received.filter((s) => !!s.viewedAt);

  const poster = (s: Share, w: string) => (
    <span className={`${w} rounded-lg overflow-hidden shrink-0 flex items-center justify-center`} style={{ background: 'var(--color-surface-elevated)' }}>
      {s.poster
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={s.poster} alt="" className="w-full h-full object-cover" />
        : s.itemType === 'series' ? <TvIcon className="w-6 h-6 text-subtle" /> : <FilmIcon className="w-6 h-6 text-subtle" />}
    </span>
  );

  const menu = (s: Share, type: SharesTab) => (
    <V2MoreMenu
      label={`More for ${s.itemName}`}
      items={[
        { label: inLibrary(s.itemId) ? 'In your library' : 'Add to library', icon: <BookmarkIcon className="w-4 h-4" />, disabled: busy === s.id || inLibrary(s.itemId), onClick: () => onAddToLibrary(s) },
        ...(type === 'received' && !s.viewedAt ? [{ label: 'Mark as viewed', icon: <CheckIcon className="w-4 h-4" />, disabled: busy === s.id, onClick: () => onMarkViewed(s.id) }] : []),
        { label: 'Remove', icon: <TrashIcon className="w-4 h-4" />, danger: true, disabled: busy === s.id, onClick: () => onRemove(s.id, type) },
      ]}
    />
  );

  const who = (s: Share, type: SharesTab) => `${type === 'received' ? 'from' : 'to'} ${(type === 'received' ? s.fromUsername : s.toUsername) || 'someone'}`;
  const state = (s: Share, type: SharesTab) => type === 'received'
    ? (!s.viewedAt ? <span className="v2-chip" style={{ color: '#22c55e', borderColor: 'color-mix(in srgb, #22c55e 35%, transparent)' }}>New</span> : null)
    : (s.viewedAt ? <span className="v2-chip" style={{ color: '#22c55e', borderColor: 'color-mix(in srgb, #22c55e 35%, transparent)' }}>Viewed</span> : null);

  const open = (s: Share) => <a href={linkOf(s)} className="v2-btn" onClick={(e) => e.stopPropagation()}>Open</a>;
  const pick = (s: Share) => selecting ? () => onToggle(s.id) : undefined;
  const ring = (s: Share): CSSProperties | undefined => selected.has(s.id) ? { outline: '2px solid var(--color-primary)', outlineOffset: -1 } : undefined;

  const tile = (s: Share, type: SharesTab) => (
    <div key={s.id} className="v2-tool" style={{ cursor: selecting ? 'pointer' : 'default', padding: 10, ...ring(s) }} onClick={pick(s)}>
      {poster(s, 'w-[52px] h-[76px]')}
      <span className="flex-1 min-w-0 text-left">
        <span className="flex items-center gap-2 flex-wrap"><b className="text-[14.5px] text-default truncate">{s.itemName}</b>{state(s, type)}</span>
        <span className="block text-muted text-[12.5px] mt-0.5">{who(s, type)} · {when(s.createdAt)}</span>
        <span className="block text-muted text-[12px] mt-0.5">{s.itemType === 'series' ? 'Show' : 'Movie'}{inLibrary(s.itemId) ? ' · In your library' : ''}</span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        {open(s)}
        {menu(s, type)}
      </span>
    </div>
  );

  const row = (s: Share, type: SharesTab) => (
    <div key={s.id} className="v2-row" style={ring(s)} onClick={pick(s)}>
      {poster(s, 'w-10 h-14')}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2"><b className="text-[14.5px] text-default truncate">{s.itemName}</b>{state(s, type)}</div>
        <div className="text-muted text-[12.5px] truncate">{who(s, type)} · {when(s.createdAt)}</div>
      </div>
      <span className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        {open(s)}
        {menu(s, type)}
      </span>
    </div>
  );

  const list = (items: Share[], type: SharesTab) => view === 'grid'
    ? <div className="v2-tiles v2-tiles-2">{items.map((s) => tile(s, type))}</div>
    : <V2List>{items.map((s) => row(s, type))}</V2List>;

  const keys = arrange.shown.filter((k) => (tab === 'received' ? k !== 'sent' : k === 'sent'));
  const shown = (k: string) => (k === 'new' ? fresh : k === 'earlier' ? earlier : sent);
  const anyShown = keys.some((k) => shown(k).length > 0);

  return (
    <div>
      <MeHead
        title="Shares"
        sub={unviewed > 0 ? `${unviewed} new` : 'Nothing new'}
        actions={<ArrangeButton arrange={arrange} />}
      />
      <ArrangeBar arrange={arrange} />

      {(() => {
        const seg = (
          <MeSeg
            value={tab}
            onChange={onTab}
            options={[
              { key: 'received', label: <>Sent to you <span className="opacity-80">{receivedCount}</span></> },
              { key: 'sent', label: <>You sent <span className="opacity-80">{sentCount}</span></> },
            ]}
          />
        );
        const selectBtn = <button type="button" className="v2-btn shrink-0" aria-pressed={selecting} onClick={() => { onSelecting(!selecting); if (selecting) onClear(); }}>{selecting ? 'Done' : 'Select'}</button>;
        // A phone: row 1 is the search, Filters (with a count) and grid / list;
        // row 2 is the tabs, Select at the end.
        if (phone && phoneBar) {
          return (
            <>
              <div className="flex items-center gap-2 mb-2.5">
                <label className="relative flex-1 min-w-0">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
                  <input
                    type="text"
                    value={phoneBar.search}
                    onChange={(e) => phoneBar.onSearch(e.target.value)}
                    placeholder="Find a title"
                    aria-label="Find a title"
                    className="w-full min-w-0 pl-9 pr-3 py-2 rounded-xl text-sm"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                  />
                </label>
                {phoneBar.people.length > 0 && (
                  <FiltersMenu
                    title="From"
                    all="all"
                    value={phoneBar.person}
                    onChange={phoneBar.onPerson}
                    options={[{ key: 'all', label: 'Everyone' }, ...phoneBar.people.map((n) => ({ key: n, label: n }))]}
                  />
                )}
                <ViewModeToggle mode={view} onChange={onView} />
              </div>
              <div className="flex items-center gap-2 mb-3">
                {seg}
                <span className="flex-1" />
                {selectBtn}
              </div>
            </>
          );
        }
        return (
          <>
            <div className="flex flex-wrap items-center gap-2.5 mb-3">
              {seg}
              {selectBtn}
              <ViewModeToggle mode={view} onChange={onView} />
            </div>
            {toolbar}
          </>
        );
      })()}
      {bulkBar}

      {keys.map((k) => {
        const items = shown(k);
        if (items.length === 0) return null;
        return (
          <ArrangeSection key={k} arrange={arrange} id={k} title={LABELS[k]} meta={`${items.length}`} noun="section">
            {list(items, tab)}
          </ArrangeSection>
        );
      })}
      {!anyShown && empty}
      <HiddenTray arrange={arrange} labelOf={(id) => LABELS[id] || id} />
      {members}
    </div>
  );
}
