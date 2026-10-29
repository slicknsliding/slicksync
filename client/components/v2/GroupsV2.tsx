'use client';

// Groups in the v2 page design: a card per group with who is in it (pictures
// side by side), the addons it gives, whether it is in step (Synced, Unsynced,
// Syncing), and Sync. A ⋯ on each holds Open, Sync, Clone, Switch off and
// Delete. In Arrange mode each group can be dragged, moved or hidden on this
// page.

import { useRouter } from 'next/navigation';
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, PowerIcon, Square2StackIcon, TrashIcon } from '@heroicons/react/24/outline';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { UserAvatar } from '@/components/ui';
import { GroupPicture, groupWash } from './GroupPicture';
import { ArrangeControls } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { formatLastSync } from '@/lib/relativeTime';
import { V2Button, V2Card, V2Grid, V2Grip, V2Item, V2List, V2Status, type V2CardMenuItem } from './V2Bits';
import { syncWords, useV2Sync } from './V2Sync';

export type V2GroupCard = {
  id: string;
  name: string;
  colorIndex?: number;
  avatarUrl?: string | null;
  isActive: boolean;
  lastSyncedAt?: string | null;
  people: { id: string; name: string; email?: string; avatarUrl?: string | null; useGravatar?: boolean; colorIndex?: number }[];
  addonCount: number;
  /** Addon names, once loaded. */
  addonNames?: string[];
};

function Faces({ people, size }: { people: V2GroupCard['people']; size: 'xs' | 'sm' }) {
  if (people.length === 0) return <span className="text-muted text-[13px]">Nobody yet · <b className="text-default">Add a person</b></span>;
  return (
    <div className="flex gap-x-3 gap-y-2 flex-wrap">
      {people.map((p) => (
        <span key={p.id} className="inline-flex items-center gap-1.5 text-[13px] text-default min-w-0">
          <UserAvatar userId={p.id} name={p.name} email={p.email} colorIndex={p.colorIndex} src={p.avatarUrl || undefined} useGravatar={p.useGravatar} size={size} />
          <span className="truncate max-w-[9rem]">{p.name}</span>
        </span>
      ))}
    </div>
  );
}

function meta(g: V2GroupCard) {
  const synced = g.lastSyncedAt ? `synced ${formatLastSync(g.lastSyncedAt)}` : 'not synced yet';
  return `${g.people.length} ${g.people.length === 1 ? 'person' : 'people'} · ${g.addonCount} addon${g.addonCount === 1 ? '' : 's'} · ${synced}`;
}

/** The group's own state in words: switched off, or whether it is in step. */
function GroupState({ g, syncing }: { g: V2GroupCard; syncing: boolean }) {
  const sync = useV2Sync({ groupId: g.id, syncing, enabled: g.isActive });
  if (!g.isActive) return <V2Status tone="off">Switched off</V2Status>;
  const w = syncWords(sync);
  return w ? <V2Status tone={w.tone}>{w.words}</V2Status> : null;
}

export function GroupsV2({ groups, arrange, view, syncing, onSync, onClone, onToggleActive, onDelete }: {
  groups: V2GroupCard[];
  arrange: PageArrange;
  view: 'grid' | 'list';
  syncing: Set<string>;
  onSync: (g: V2GroupCard) => void;
  onClone: (g: V2GroupCard) => void;
  onToggleActive: (g: V2GroupCard) => void;
  onDelete: (g: V2GroupCard) => void;
}) {
  const router = useRouter();
  const byId = new Map(groups.map((g) => [g.id, g]));
  const shown = arrange.shown.map((id) => byId.get(id)).filter((g): g is V2GroupCard => !!g);

  const menuFor = (g: V2GroupCard): V2CardMenuItem[] => [
    { label: 'Open', icon: <ArrowTopRightOnSquareIcon className="w-4 h-4" />, onClick: () => router.push(`/groups/${g.id}`) },
    { label: 'Sync', icon: <ArrowPathIcon className="w-4 h-4" />, disabled: syncing.has(g.id) || !g.isActive, onClick: () => onSync(g) },
    { label: 'Clone', icon: <Square2StackIcon className="w-4 h-4" />, onClick: () => onClone(g) },
    { label: g.isActive ? 'Switch off' : 'Switch on', icon: <PowerIcon className="w-4 h-4" />, onClick: () => onToggleActive(g) },
    { label: 'Delete', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => onDelete(g) },
  ];
  const itemProps = (g: V2GroupCard) => ({
    href: `/groups/${g.id}`,
    menuLabel: `${g.name} options`,
    items: menuFor(g),
    sortId: g.id,
    sortData: { label: g.name },
    arranging: arrange.arranging,
  });

  const action = (g: V2GroupCard) => {
    if (arrange.arranging) return <span className="flex items-center gap-1.5 shrink-0"><V2Grip label={`Drag ${g.name}`} /><ArrangeControls arrange={arrange} id={g.id} label={g.name} /></span>;
    const busy = syncing.has(g.id);
    return (
      <V2Button onClick={() => onSync(g)} disabled={busy || !g.isActive} icon={<ArrowPathIcon className={`w-4 h-4${busy ? ' animate-spin' : ''}`} />}>
        {busy ? 'Syncing' : 'Sync'}
      </V2Button>
    );
  };
  const chips = (g: V2GroupCard, max?: number) => {
    const names = g.addonNames;
    if (!names) return null;
    if (names.length === 0) return <span className="text-muted text-[13px]">No addons yet · <b className="text-default">Add an addon</b></span>;
    const list = max ? names.slice(0, max) : names;
    return (
      <div className="flex gap-1.5 flex-wrap">
        {list.map((n, i) => <span key={`${n}-${i}`} className="v2-chip text-default">{n}</span>)}
        {max && names.length > max && <span className="v2-chip text-muted">+{names.length - max}</span>}
      </div>
    );
  };
  const picture = (g: V2GroupCard, size: 'md' | 'lg', ring: boolean) => (
    <GroupPicture name={g.name} avatarUrl={g.avatarUrl} colorIndex={g.colorIndex} size={size} ring={ring} dim={!g.isActive} />
  );

  if (view === 'list') {
    return (
      <SortableContext items={shown.map((g) => g.id)} strategy={verticalListSortingStrategy}>
        <V2List>
          {shown.map((g) => (
            <V2Item key={g.id} view="row" {...itemProps(g)}>
              {picture(g, 'md', false)}
              <div className="w-[190px] min-w-0 shrink-0">
                <b className="text-default block truncate">{g.name}</b>
                <div className="text-[12.5px] mt-0.5"><GroupState g={g} syncing={syncing.has(g.id)} /></div>
              </div>
              <div className="flex-1 min-w-0"><Faces people={g.people} size="xs" /></div>
              <div className="v2-col w-[230px]">{chips(g, 3)}</div>
              {action(g)}
            </V2Item>
          ))}
        </V2List>
      </SortableContext>
    );
  }
  return (
    <SortableContext items={shown.map((g) => g.id)} strategy={rectSortingStrategy}>
      <V2Grid max={3} stretch={{ arrange, id: 'cards', label: 'groups' }}>
        {shown.map((g) => (
          <V2Item key={g.id} view="card" {...itemProps(g)} className="h-full">
            <V2Card action={action(g)} style={groupWash(g.colorIndex)}>
              <div className="flex items-center gap-3.5 min-w-0">
                {picture(g, 'lg', true)}
                <div className="flex-1 min-w-0">
                  <div className="text-lg font-semibold text-default truncate">{g.name}</div>
                  <div className="text-muted text-[13px] truncate">{meta(g)}</div>
                </div>
              </div>
              <GroupState g={g} syncing={syncing.has(g.id)} />
              <Faces people={g.people} size="sm" />
              {chips(g)}
            </V2Card>
          </V2Item>
        ))}
      </V2Grid>
    </SortableContext>
  );
}
