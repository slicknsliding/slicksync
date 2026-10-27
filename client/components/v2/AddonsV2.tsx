'use client';

// Addons in the v2 page design: sorted by what they give (Streams, Catalogs,
// Subtitles, Other), with health in words and which groups have each one.
// Sections can be moved, folded and hidden, and single addons hidden, through
// the page's Arrange mode.

import Link from 'next/link';
import { ArrowPathIcon, EyeIcon, PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { avatarColorFill } from '@/components/ui/Avatar';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { V2Button, V2Card, V2Grid, V2List, V2Status } from './V2Bits';

export type V2Addon = {
  id: string;
  name: string;
  version?: string;
  logo?: string | null;
  resources: string[];
  hasCatalogs: boolean;
  isActive: boolean;
  isOnline?: boolean;
  healthError?: string;
  groups: { name: string; colorIndex?: number }[];
  groupCount: number;
};

export const ADDON_KINDS = [
  { key: 'k:streams', label: 'Streams' },
  { key: 'k:catalogs', label: 'Catalogs' },
  { key: 'k:subtitles', label: 'Subtitles' },
  { key: 'k:other', label: 'Other' },
] as const;

/** The one section an addon sits in: what it mainly gives. */
export function addonKind(a: V2Addon) {
  if (a.resources.includes('stream')) return 'k:streams';
  if (a.hasCatalogs || a.resources.includes('catalog')) return 'k:catalogs';
  if (a.resources.includes('subtitles')) return 'k:subtitles';
  return 'k:other';
}

const KIND_WORD: Record<string, string> = { 'k:streams': 'Streams', 'k:catalogs': 'Catalogs', 'k:subtitles': 'Subtitles', 'k:other': 'Other' };

function Health({ a }: { a: V2Addon }) {
  if (!a.isActive) return <V2Status tone="off">Switched off</V2Status>;
  if (a.isOnline === false) return <V2Status tone="bad">Not answering</V2Status>;
  if (a.isOnline === true) return <V2Status tone="live">Online</V2Status>;
  return <V2Status tone="ok">Not checked yet</V2Status>;
}

function Logo({ a, size }: { a: V2Addon; size: number }) {
  return (
    <span className="rounded-[14px] flex items-center justify-center shrink-0 overflow-hidden text-muted" style={{ width: size, height: size, background: 'var(--color-surface-elevated, var(--color-surface-hover))' }}>
      {a.logo
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={a.logo} alt="" className="w-full h-full object-contain p-1.5" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        : <PuzzlePieceIcon className="w-1/2 h-1/2" />}
    </span>
  );
}

function GivenTo({ a, max }: { a: V2Addon; max?: number }) {
  if (a.groups.length === 0) {
    return <span className="text-muted text-[13px]">{a.groupCount ? `${a.groupCount} group${a.groupCount === 1 ? '' : 's'}` : 'Not given to a group'}</span>;
  }
  const list = max ? a.groups.slice(0, max) : a.groups;
  return (
    <span className="flex gap-1.5 flex-wrap items-center">
      {list.map((g, i) => (
        <span key={`${g.name}-${i}`} className="v2-chip text-default" style={{ borderColor: `color-mix(in srgb, ${avatarColorFill(g.colorIndex ?? 0)} 55%, transparent)` }}>{g.name}</span>
      ))}
      {max && a.groups.length > max && <span className="v2-chip text-muted">+{a.groups.length - max}</span>}
    </span>
  );
}

export function AddonsV2({ addons, arrange, addonArrange, view, reloading, onReload }: {
  addons: V2Addon[];
  arrange: PageArrange;
  addonArrange: PageArrange;
  view: 'grid' | 'list';
  reloading: Set<string>;
  onReload: (a: V2Addon) => void;
}) {
  const hidden = new Set(addonArrange.hidden);
  const action = (a: V2Addon) => {
    if (arrange.arranging) {
      return (
        <button type="button" className="arrange-icon" aria-label={`Hide ${a.name}`} title="Hide on this page"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); addonArrange.hide(a.id); }}>
          <EyeIcon className="w-4 h-4" />
        </button>
      );
    }
    const busy = reloading.has(a.id);
    return (
      <V2Button onClick={() => onReload(a)} disabled={busy} icon={<ArrowPathIcon className={`w-4 h-4${busy ? ' animate-spin' : ''}`} />}>
        {busy ? 'Reloading' : 'Reload'}
      </V2Button>
    );
  };
  const tile = (a: V2Addon) => (
    <Link key={a.id} href={`/addons/${a.id}`} className="v2-link">
      <V2Card action={action(a)}>
        <div className="flex items-center gap-3.5 min-w-0">
          <Logo a={a} size={48} />
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-semibold text-default truncate">{a.name}</div>
            <div className="text-muted text-[12.5px] truncate">{[a.version && `v${a.version.replace(/^v/i, '')}`, KIND_WORD[addonKind(a)]].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
        <Health a={a} />
        <div className="flex gap-1.5 flex-wrap items-center">
          <span className="text-muted text-[13px]">Given to</span>
          <GivenTo a={a} />
        </div>
      </V2Card>
    </Link>
  );
  const row = (a: V2Addon) => (
    <Link key={a.id} href={`/addons/${a.id}`} className="v2-row">
      <Logo a={a} size={38} />
      <div className="flex-1 min-w-0">
        <b className="text-default block truncate">{a.name}</b>
        <div className="text-muted text-[12.5px] truncate">{a.version ? `v${a.version.replace(/^v/i, '')}` : KIND_WORD[addonKind(a)]}</div>
      </div>
      <div className="v2-col w-[170px]"><Health a={a} /></div>
      <div className="v2-col w-[220px]"><GivenTo a={a} max={3} /></div>
      {action(a)}
    </Link>
  );

  return (
    <div>
      {arrange.shown.map((key) => {
        const all = addons.filter((a) => addonKind(a) === key);
        if (all.length === 0) return null;
        const members = all.filter((a) => !hidden.has(a.id));
        const label = KIND_WORD[key];
        return (
          <ArrangeSection key={key} arrange={arrange} id={key} title={label} meta={`${all.length}`} noun="section">
            {members.length === 0
              ? <p className="text-sm text-muted py-2">Every addon here is hidden on this page.</p>
              : view === 'grid' ? <V2Grid>{members.map(tile)}</V2Grid> : <V2List>{members.map(row)}</V2List>}
          </ArrangeSection>
        );
      })}
    </div>
  );
}
