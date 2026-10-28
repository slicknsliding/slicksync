'use client';

// A group in the v2 page design: its colour, name and one status with the
// facts under it, Sync and Edit up top (the rest in ⋯), a strip of numbers,
// then People, Addons and Watching as sections that can be moved, folded and
// hidden. Every action the Classic page has is still here: the page owns the
// data, handlers and modals, this only draws them.

import { useEffect, useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowPathIcon, ArrowUturnLeftIcon, Bars3Icon, PencilIcon, PlusIcon, PowerIcon,
  PhotoIcon, PuzzlePieceIcon, TrashIcon, UserMinusIcon, UsersIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragEndEvent } from '@dnd-kit/core';
import { useVaultDrag } from '@/components/providers/VaultDragContext';
import { UserAvatar } from '@/components/ui';
import { GroupPicture, groupWash } from './GroupPicture';
import { ArrangeBar, ArrangeButton, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import { usePageArrangement } from '@/lib/arrange';
import { formatLastSync } from '@/lib/relativeTime';
import type { Addon, Group, User } from '@/lib/api';
import { V2Button, V2Status } from './V2Bits';
import { V2TitleEdit, type TitlePatch } from './V2TitleEdit';
import { V2DetailHead, V2MoreMenu, V2Numbers, V2Tiles, type V2MenuItem } from './V2Detail';

export type GroupV2Watch = {
  /** Minutes watched in the last seven days, all members together. */
  weekMinutes: number;
  /** The member who watched most that week, and how long. */
  top: { name: string; minutes: number } | null;
  /** Share of movies out of movies and shows that week, as a whole percent (null with none). */
  moviePercent: number | null;
};

type Props = {
  group: (Group & { colorIndex?: number; avatarUrl?: string | null }) | null;
  isLoading: boolean;
  people: User[];
  addons: Addon[];
  watch: GroupV2Watch;
  /** The charts, drawn by the page. */
  charts: ReactNode;
  isSyncing: boolean;
  /** Members being synced right now (one by one, or everyone after a change). */
  syncingUsers: Set<string>;
  usersSyncing: boolean;
  onSync: () => void;
  onEdit: () => void;
  /** Saves a new name and/or description (the pencil on the title); false when it failed. */
  onRename: (patch: TitlePatch) => Promise<boolean>;
  onChangePicture: () => void;
  onToggleActive: () => void;
  onClearMembers: () => void;
  onClearAddons: () => void;
  onDelete: () => void;
  onAddPerson: () => void;
  onAddAddon: () => void;
  onSyncUser: (id: string, name: string) => void;
  onRemoveUser: (id: string, name: string) => void;
  onRemoveAddon: (id: string) => void;
  onReorder: (event: DragEndEvent) => void;
};

const SECTION_KEYS = ['people', 'addons', 'watching'];

function minutesText(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

function kindOf(addon: Addon) {
  const names: Record<string, string> = { stream: 'Streams', catalog: 'Catalogs', subtitles: 'Subtitles', meta: 'Details', addon_catalog: 'Addon catalogs' };
  const kinds = Array.from(new Set((addon.resources || []).map((r) => names[r] || '').filter(Boolean)));
  return kinds.slice(0, 2).join(' · ') || 'Addon';
}

const TILE = 'flex items-center gap-3 min-w-0 rounded-2xl border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3.5 py-3';
const ADD_TILE = 'flex items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--color-surface-border)] px-3.5 py-3 min-h-[64px] text-muted hover:text-default hover:border-[var(--color-primary)] transition-colors cursor-pointer';

function AddonTile({ addon, onRemove }: { addon: Addon; onRemove: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(addon.id) });
  const any = addon as unknown as { customLogo?: string; manifest?: { logo?: string }; iconUrl?: string };
  const logo = any.customLogo || any.manifest?.logo || addon.logo || any.iconUrl;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: isDragging ? 'none' : transition, zIndex: isDragging ? 100 : undefined, isolation: 'isolate' }}
      className={`${TILE}${isDragging ? ' shadow-lg ring-2 ring-primary' : ''}`}
    >
      <span {...attributes} {...listeners} style={{ touchAction: 'none' }} aria-label={`Drag ${addon.name || 'addon'} to reorder`} title="Drag to reorder" className="shrink-0 cursor-grab active:cursor-grabbing p-1 rounded text-subtle">
        <Bars3Icon className="w-4 h-4" />
      </span>
      <Link href={`/addons/${addon.id}`} className="flex items-center gap-3 flex-1 min-w-0">
        <span className="shrink-0 w-9 h-9 rounded-[11px] bg-[var(--color-surface-elevated)] flex items-center justify-center text-muted">
          {logo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logo} alt="" className="w-7 h-7 object-contain" />
            : <PuzzlePieceIcon className="w-[18px] h-[18px]" />}
        </span>
        <span className="flex-1 min-w-0">
          <b className="block text-default truncate">{addon.name || 'Unnamed addon'}</b>
          <span className="block text-muted text-[12.5px] truncate">{kindOf(addon)}</span>
        </span>
      </Link>
      <V2MoreMenu
        label={`${addon.name || 'Addon'} options`}
        items={[{ label: 'Remove from group', icon: <XMarkIcon className="w-4 h-4" />, danger: true, onClick: () => addon.id && onRemove(addon.id) }]}
      />
    </div>
  );
}

export function GroupV2(p: Props) {
  const { group } = p;
  const arrange = usePageArrangement('group', SECTION_KEYS);
  const { registerDragEndHandler } = useVaultDrag();
  const { onReorder } = p;
  useEffect(() => registerDragEndHandler(onReorder), [onReorder, registerDragEndHandler]);

  const active = group?.isActive !== false;
  const nPeople = p.people.length;
  const nAddons = p.addons.length;
  const addonIds = useMemo(() => p.addons.filter((a) => a.id).map((a) => String(a.id)), [p.addons]);

  const more: V2MenuItem[] = [
    { label: active ? 'Switch off' : 'Switch on', icon: <PowerIcon className="w-4 h-4" />, onClick: p.onToggleActive },
    { label: 'Change picture or colour', icon: <PhotoIcon className="w-4 h-4" />, onClick: p.onChangePicture },
    { label: 'Clear all members', icon: <UserMinusIcon className="w-4 h-4" />, onClick: p.onClearMembers, disabled: nPeople === 0 },
    { label: 'Clear all addons', icon: <ArrowUturnLeftIcon className="w-4 h-4" />, onClick: p.onClearAddons, disabled: nAddons === 0 },
    { label: 'Delete', icon: <TrashIcon className="w-4 h-4" />, onClick: p.onDelete, danger: true },
  ];

  const lead = (
    <GroupPicture name={group?.name || 'Group'} avatarUrl={group?.avatarUrl} colorIndex={group?.colorIndex} size="xl" dim={!active} />
  );

  const head = (
    <V2TitleEdit name={group?.name || 'Group'} description={group?.description} canEdit={!!group} onSave={p.onRename} label="name">
    {(edit) => (
    <V2DetailHead
      lead={lead}
      style={groupWash(group?.colorIndex)}
      title={p.isLoading && !group ? 'Loading...' : edit.title}
      status={(
        <>
          {edit.description && <div className="basis-full min-w-0 mb-0.5">{edit.description}</div>}
          <V2Status tone={active ? 'ok' : 'off'}>{active ? 'All synced' : 'Switched off'}</V2Status>
        </>
      )}
      facts={`${nPeople} ${nPeople === 1 ? 'person' : 'people'} · ${nAddons} ${nAddons === 1 ? 'addon' : 'addons'} · synced ${formatLastSync(group?.lastSyncedAt)}`}
      actions={(
        <>
          <ArrangeButton arrange={arrange} />
          <V2Button
            primary
            onClick={p.onSync}
            disabled={p.isSyncing}
            icon={<ArrowPathIcon className={`w-4 h-4${p.isSyncing ? ' animate-spin' : ''}`} />}
          >
            {p.isSyncing ? 'Syncing' : 'Sync'}
          </V2Button>
          <V2Button onClick={p.onEdit} icon={<PencilIcon className="w-4 h-4" />}>Edit</V2Button>
        </>
      )}
      more={more}
    />
    )}
    </V2TitleEdit>
  );

  const numbers = (
    <div className="mb-6">
      <V2Numbers
        items={[
          { label: 'Watched this week', value: minutesText(p.watch.weekMinutes) },
          { label: 'Most active', value: p.watch.top ? p.watch.top.name : '–', sub: p.watch.top ? minutesText(p.watch.top.minutes) : undefined },
          { label: 'Movies / shows', value: p.watch.moviePercent === null ? '–' : `${p.watch.moviePercent}% / ${100 - p.watch.moviePercent}%` },
        ]}
      />
    </div>
  );

  const personTile = (u: User) => {
    const name = u.name || u.username || 'Unknown';
    const busy = p.syncingUsers.has(u.id) || p.usersSyncing;
    const broken = !!(u as unknown as { providerConnectionError?: string | null }).providerConnectionError;
    const off = u.status === 'inactive';
    const st = off
      ? <V2Status tone="off">Switched off</V2Status>
      : broken
        ? <V2Status tone="warn">Needs a fix</V2Status>
        : busy
          ? <V2Status tone="ok">Syncing</V2Status>
          : <V2Status tone="ok">All synced</V2Status>;
    return (
      <div key={u.id} className={TILE}>
        <Link href={`/users/${u.id}`} className="flex items-center gap-3 flex-1 min-w-0">
          <UserAvatar userId={u.id} name={name} email={u.email} src={u.avatarUrl ?? undefined} useGravatar={u.useGravatar} colorIndex={u.colorIndex} size="md" />
          <span className="flex-1 min-w-0">
            <b className="block text-default truncate">{name}</b>
            <span className="block mt-0.5">{st}</span>
          </span>
        </Link>
        <V2MoreMenu
          label={`${name} options`}
          items={[
            { label: 'Sync', icon: <ArrowPathIcon className="w-4 h-4" />, disabled: busy, onClick: () => p.onSyncUser(u.id, name) },
            { label: 'Remove from group', icon: <UserMinusIcon className="w-4 h-4" />, danger: true, onClick: () => p.onRemoveUser(u.id, name) },
          ]}
        />
      </div>
    );
  };

  const addTile = (text: string, onClick: () => void) => (
    <button type="button" className={ADD_TILE} onClick={onClick}>
      <PlusIcon className="w-4 h-4" />
      {text}
    </button>
  );

  const sections: Record<string, ReactNode> = {
    people: (
      <ArrangeSection key="people" arrange={arrange} id="people" title="People" meta={String(nPeople)} noun="section">
        <V2Tiles wide={3}>
          {p.people.map(personTile)}
          {addTile('Add a person', p.onAddPerson)}
        </V2Tiles>
        {nPeople === 0 && !p.isLoading && (
          <p className="text-sm text-muted mt-3 flex items-center gap-2"><UsersIcon className="w-4 h-4" />Nobody is in this group yet.</p>
        )}
      </ArrangeSection>
    ),
    addons: (
      <ArrangeSection key="addons" arrange={arrange} id="addons" title="Addons" meta={nAddons > 0 ? `${nAddons}, in this order on their apps` : '0'} noun="section">
        <SortableContext items={addonIds} strategy={rectSortingStrategy}>
          <V2Tiles wide={3}>
            {p.addons.filter((a) => a.id).map((a) => <AddonTile key={a.id} addon={a} onRemove={p.onRemoveAddon} />)}
            {addTile('Add an addon', p.onAddAddon)}
          </V2Tiles>
        </SortableContext>
        {nAddons === 0 && !p.isLoading && (
          <p className="text-sm text-muted mt-3 flex items-center gap-2"><PuzzlePieceIcon className="w-4 h-4" />No addons in this group yet.</p>
        )}
      </ArrangeSection>
    ),
    watching: (
      <ArrangeSection key="watching" arrange={arrange} id="watching" title="Watching" meta="per person, last 30 days" noun="section">
        {p.charts}
      </ArrangeSection>
    ),
  };

  return (
    <>
      {head}
      <ArrangeBar arrange={arrange} />
      {numbers}
      <div className="space-y-6">
        {arrange.shown.map((k) => sections[k] ?? null)}
      </div>
      <div className="mt-4">
        <HiddenTray arrange={arrange} labelOf={(id) => (id === 'people' ? 'People' : id === 'addons' ? 'Addons' : 'Watching')} />
      </div>
    </>
  );
}
