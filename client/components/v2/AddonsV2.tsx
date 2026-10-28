'use client';

// Addons in the v2 page design: every addon together in one grid or list (the
// page's filter tabs narrow it), with health in words, what each one gives
// under its name and which groups have it. Pinned addons come first; single
// addons can be pinned or hidden through the page's Arrange mode.

import Link from 'next/link';
import { ArrowPathIcon, EyeIcon, MapPinIcon, PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { MapPinIcon as MapPinSolid } from '@heroicons/react/24/solid';
import { avatarColorFill } from '@/components/ui/Avatar';
import type { PageArrange } from '@/lib/arrange';
import { pinFirst } from '@/lib/arrange-core';
import { GroupPicture } from './GroupPicture';
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
  groups: { name: string; colorIndex?: number; avatarUrl?: string | null }[];
  groupCount: number;
};

/** What an addon mainly gives, in a word. */
export function addonKind(a: V2Addon) {
  if (a.resources.includes('stream')) return 'Streams';
  if (a.hasCatalogs || a.resources.includes('catalog')) return 'Catalogs';
  if (a.resources.includes('subtitles')) return 'Subtitles';
  return 'Other';
}

/** "v1.2.0 · Streams" */
const kindLine = (a: V2Addon) => [a.version && `v${a.version.replace(/^v/i, '')}`, addonKind(a)].filter(Boolean).join(' · ');

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

function Groups({ a, max }: { a: V2Addon; max?: number }) {
  if (a.groups.length === 0) {
    return <span className="text-muted text-[13px]">{a.groupCount ? `${a.groupCount} group${a.groupCount === 1 ? '' : 's'}` : 'No group yet'}</span>;
  }
  const list = max ? a.groups.slice(0, max) : a.groups;
  return (
    <span className="flex gap-1.5 flex-wrap items-center">
      {list.map((g, i) => (
        <span key={`${g.name}-${i}`} className="v2-chip gap-1.5 !pl-[3px] text-default" style={{ borderColor: `color-mix(in srgb, ${avatarColorFill(g.colorIndex ?? 0)} 55%, transparent)` }}>
          <GroupPicture name={g.name} avatarUrl={g.avatarUrl} colorIndex={g.colorIndex} size="xs" ring={false} />
          {g.name}
        </span>
      ))}
      {max && a.groups.length > max && <span className="v2-chip text-muted">+{a.groups.length - max}</span>}
    </span>
  );
}

export function AddonsV2({ addons, arrange, addonArrange, view, reloading, onReload, pins }: {
  addons: V2Addon[];
  arrange: PageArrange;
  addonArrange: PageArrange;
  view: 'grid' | 'list';
  reloading: Set<string>;
  onReload: (a: V2Addon) => void;
  /** Pinned addons sit first. */
  pins: { isPinned: (id: string) => boolean; toggle: (id: string) => void; pinned: string[] };
}) {
  const pinBtn = (id: string, name: string) => {
    const on = pins.isPinned(id);
    return (
      <button type="button" className={`arrange-icon${on ? ' arrange-icon-on' : ''}`} aria-pressed={on} aria-label={on ? `Unpin ${name}` : `Pin ${name}`} title={on ? 'Unpin' : 'Pin to the front'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pins.toggle(id); }}>
        <MapPinIcon className="w-4 h-4" />
      </button>
    );
  };
  const pinMark = (a: V2Addon) => pins.isPinned(a.id) ? <MapPinSolid className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} aria-label="Pinned" /> : null;
  const hidden = new Set(addonArrange.hidden);
  const action = (a: V2Addon) => {
    if (arrange.arranging) {
      return (
        <span className="flex gap-1.5">
          {pinBtn(a.id, a.name)}
          <button type="button" className="arrange-icon" aria-label={`Hide ${a.name}`} title="Hide on this page"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); addonArrange.hide(a.id); }}>
            <EyeIcon className="w-4 h-4" />
          </button>
        </span>
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
            <div className="flex items-center gap-1.5 min-w-0"><span className="text-[17px] font-semibold text-default truncate">{a.name}</span>{pinMark(a)}</div>
            <div className="text-muted text-[12.5px] truncate">{kindLine(a)}</div>
          </div>
        </div>
        <Health a={a} />
        <Groups a={a} />
      </V2Card>
    </Link>
  );
  const row = (a: V2Addon) => (
    <Link key={a.id} href={`/addons/${a.id}`} className="v2-row">
      <Logo a={a} size={38} />
      <div className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5 min-w-0"><b className="text-default truncate">{a.name}</b>{pinMark(a)}</span>
        <div className="text-muted text-[12.5px] truncate">{kindLine(a)}</div>
      </div>
      <div className="v2-col w-[170px]"><Health a={a} /></div>
      <div className="v2-col w-[220px]"><Groups a={a} max={3} /></div>
      {action(a)}
    </Link>
  );

  const members = pinFirst(addons.filter((a) => !hidden.has(a.id)), (a) => a.id, pins.pinned);
  if (addons.length === 0) return null;
  if (members.length === 0) return <p className="text-sm text-muted py-2">Every addon here is hidden on this page.</p>;
  return view === 'grid' ? <V2Grid>{members.map(tile)}</V2Grid> : <V2List>{members.map(row)}</V2List>;
}
