'use client';

// Addons in the v2 page design: every addon together in one grid or list (the
// page's filter tabs narrow it), with health in words, what each one gives
// under its name and which groups have it. Pinned addons come first; single
// addons can be pinned or hidden through the page's Arrange mode.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowPathIcon, ArrowTopRightOnSquareIcon, Cog6ToothIcon, EyeIcon, LockClosedIcon, MapPinIcon, PencilIcon, PlusIcon,
  PowerIcon, PuzzlePieceIcon, ShieldCheckIcon, ShieldExclamationIcon, Square2StackIcon, TagIcon, TrashIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { MapPinIcon as MapPinSolid } from '@heroicons/react/24/solid';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { avatarColorFill } from '@/components/ui/Avatar';
import type { PageArrange } from '@/lib/arrange';
import { pinFirst } from '@/lib/arrange-core';
import { GroupPicture } from './GroupPicture';
import { V2Button, V2Card, V2DragHint, V2Grid, V2Grip, V2Item, V2List, V2NameField, V2Status, type V2CardMenuItem } from './V2Bits';

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
  /** Its label (a tag), if it has one. */
  tag?: string | null;
  isProtected?: boolean;
  /** The addon's own configuration page, when it has one. */
  configUrl?: string | null;
};

/** What the ⋯ menu does; the page owns every handler and modal. */
export type V2AddonActions = {
  rename: (a: V2Addon, name: string) => Promise<void>;
  clone: (a: V2Addon) => void;
  toggleActive: (a: V2Addon) => void;
  toggleProtect: (a: V2Addon) => void;
  setTag: (a: V2Addon, tag: string | null) => void;
  createTag: (a: V2Addon, name: string) => void;
  moveToVault: (a: V2Addon) => void;
  remove: (a: V2Addon) => void;
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

export function AddonsV2({ addons, arrange, addonArrange, view, reloading, onReload, pins, tags, tagColors, actions, selecting, selectedIds, onToggleSelect }: {
  addons: V2Addon[];
  tags: string[];
  tagColors: Record<string, string>;
  actions: V2AddonActions;
  /** Select mode: a circle on each card and a tap picks. */
  selecting: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
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
  const router = useRouter();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const action = (a: V2Addon) => {
    if (arrange.arranging) {
      return (
        <span className="flex gap-1.5">
          <V2Grip label={`Drag ${a.name}`} />
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

  const menuOf = (a: V2Addon): V2CardMenuItem[] => {
    const none = 'var(--color-text-muted)';
    return [
      { label: 'Open', icon: <ArrowTopRightOnSquareIcon className="w-4 h-4" />, onClick: () => router.push(`/addons/${a.id}`) },
      { label: 'Rename', icon: <PencilIcon className="w-4 h-4" />, onClick: () => setRenamingId(a.id) },
      { label: 'Configure', icon: <Cog6ToothIcon className="w-4 h-4" />, disabled: !a.configUrl, onClick: () => { if (a.configUrl) window.open(a.configUrl, '_blank', 'noopener,noreferrer'); } },
      { label: 'Reload', icon: <ArrowPathIcon className="w-4 h-4" />, disabled: reloading.has(a.id), onClick: () => onReload(a) },
      { label: 'Clone', icon: <Square2StackIcon className="w-4 h-4" />, onClick: () => actions.clone(a) },
      { label: a.isProtected ? 'Unprotect' : 'Protect', icon: a.isProtected ? <ShieldExclamationIcon className="w-4 h-4" /> : <ShieldCheckIcon className="w-4 h-4" />, onClick: () => actions.toggleProtect(a) },
      {
        label: 'Label',
        icon: <TagIcon className="w-4 h-4" />,
        sub: {
          title: 'Label',
          items: [
            ...tags.map((t): V2CardMenuItem => ({ label: t, dot: tagColors[t] || none, checked: a.tag === t, onClick: () => actions.setTag(a, a.tag === t ? null : t) })),
            { label: 'New tag…', icon: <PlusIcon className="w-4 h-4" />, divider: tags.length > 0, input: { placeholder: 'Tag name…', onSubmit: (text) => actions.createTag(a, text) } },
            { label: 'No tag', icon: <XMarkIcon className="w-4 h-4" />, disabled: !a.tag, onClick: () => actions.setTag(a, null) },
          ],
        },
      },
      { label: a.isActive ? 'Switch off' : 'Switch on', icon: <PowerIcon className="w-4 h-4" />, onClick: () => actions.toggleActive(a) },
      { label: 'Move to Vault', icon: <LockClosedIcon className="w-4 h-4" />, onClick: () => actions.moveToVault(a) },
      { label: 'Delete', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => actions.remove(a) },
    ];
  };

  /** Its label: colour and dot. */
  const tagChip = (a: V2Addon) => {
    if (!a.tag) return null;
    const c = tagColors[a.tag] || 'var(--color-text-muted)';
    return (
      <span
        className="v2-chip gap-1.5"
        data-tag={a.tag}
        style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 14%, transparent)` }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 99, background: c, display: 'inline-block' }} />
        {a.tag}
      </span>
    );
  };
  const shield = (a: V2Addon) => a.isProtected
    ? <ShieldCheckIcon className="w-4 h-4 shrink-0 text-muted" aria-label="Protected" title="Protected" />
    : null;

  /** The name: a field while renaming, a link to the addon's own configuration page when it has one, else plain. */
  const nameOf = (a: V2Addon, cls: string) => {
    if (renamingId === a.id) {
      return (
        <V2NameField
          value={a.name}
          label={`Name for ${a.name}`}
          size={16}
          onCancel={() => setRenamingId(null)}
          onSave={(name) => { setRenamingId(null); actions.rename(a, name).catch(() => {}); }}
        />
      );
    }
    if (!a.configUrl) return <span className={cls}>{a.name}</span>;
    return (
      <button
        type="button"
        className={`${cls} text-left hover:underline underline-offset-2`}
        title="Open configuration"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(a.configUrl!, '_blank', 'noopener,noreferrer'); }}
      >
        {a.name}
      </button>
    );
  };

  const itemProps = (a: V2Addon, v: 'card' | 'row') => ({
    href: `/addons/${a.id}`,
    view: v,
    items: menuOf(a),
    menuLabel: `${a.name} options`,
    selecting,
    selected: selectedIds.has(a.id),
    onToggle: () => onToggleSelect(a.id),
    sortId: a.id,
    arranging: arrange.arranging,
  });
  const tile = (a: V2Addon) => (
    <V2Item key={a.id} {...itemProps(a, 'card')}>
      <V2Card action={selecting ? undefined : action(a)} footer={selecting ? 'Tap to pick' : undefined}>
        <div className="flex items-center gap-3.5 min-w-0">
          <Logo a={a} size={48} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">{nameOf(a, 'text-[17px] font-semibold text-default truncate')}{shield(a)}{pinMark(a)}</div>
            <div className="text-muted text-[12.5px] truncate">{kindLine(a)}</div>
          </div>
        </div>
        <div className="flex items-center gap-x-2.5 gap-y-1.5 flex-wrap"><Health a={a} />{tagChip(a)}</div>
        <Groups a={a} />
      </V2Card>
    </V2Item>
  );
  const row = (a: V2Addon) => (
    <V2Item key={a.id} {...itemProps(a, 'row')}>
      <Logo a={a} size={38} />
      <div className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">{nameOf(a, 'font-bold text-default truncate')}{shield(a)}{pinMark(a)}</span>
        <div className="text-muted text-[12.5px] flex items-center gap-2 min-w-0"><span className="truncate">{kindLine(a)}</span>{tagChip(a)}</div>
      </div>
      <div className="v2-col w-[170px]"><Health a={a} /></div>
      <div className="v2-col w-[220px]"><Groups a={a} max={3} /></div>
      {selecting ? null : action(a)}
    </V2Item>
  );

  const members = pinFirst(addons.filter((a) => !hidden.has(a.id)), (a) => a.id, pins.pinned);
  if (addons.length === 0) return null;
  if (members.length === 0) return <p className="text-sm text-muted py-2">Every addon here is hidden on this page.</p>;
  const hint = (_active: string, over: string | null) => {
    if (!over) return null;
    if (over === 'addon-filter-protected') return 'Drop to protect it';
    if (over.startsWith('addon-tag-')) return `Drop to label it ${decodeURIComponent(over.replace('addon-tag-', ''))}`;
    return null;
  };
  return (
    <>
      <SortableContext items={members.map((a) => a.id)} strategy={view === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}>
        {view === 'grid' ? <V2Grid stretch={{ arrange: addonArrange, id: 'cards', label: 'addons' }}>{members.map(tile)}</V2Grid> : <V2List>{members.map(row)}</V2List>}
      </SortableContext>
      <V2DragHint hint={hint} />
    </>
  );
}
