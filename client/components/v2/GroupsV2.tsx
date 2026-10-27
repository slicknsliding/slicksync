'use client';

// Groups in the v2 page design: a card per group with who is in it (pictures
// side by side), the addons it gives, when it last synced, and Sync. In
// Arrange mode each group can be moved or hidden on this page.

import Link from 'next/link';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui';
import { avatarColorFill } from '@/components/ui/Avatar';
import { ArrangeControls } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { formatLastSync } from '@/lib/relativeTime';
import { V2Button, V2Card, V2Grid, V2List, V2Status } from './V2Bits';

export type V2GroupCard = {
  id: string;
  name: string;
  colorIndex?: number;
  isActive: boolean;
  lastSyncedAt?: string | null;
  people: { id: string; name: string; email?: string; avatarUrl?: string | null; useGravatar?: boolean; colorIndex?: number }[];
  addonCount: number;
  /** Addon names, once loaded. */
  addonNames?: string[];
};

function Faces({ people, size }: { people: V2GroupCard['people']; size: 'xs' | 'sm' }) {
  if (people.length === 0) return <span className="text-muted text-[13px]">Nobody yet</span>;
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

export function GroupsV2({ groups, arrange, view, syncing, onSync }: {
  groups: V2GroupCard[];
  arrange: PageArrange;
  view: 'grid' | 'list';
  syncing: Set<string>;
  onSync: (g: V2GroupCard) => void;
}) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const shown = arrange.shown.map((id) => byId.get(id)).filter((g): g is V2GroupCard => !!g);

  const action = (g: V2GroupCard) => {
    if (arrange.arranging) return <ArrangeControls arrange={arrange} id={g.id} label={g.name} />;
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
    if (names.length === 0) return <span className="text-muted text-[13px]">No addons yet</span>;
    const list = max ? names.slice(0, max) : names;
    return (
      <div className="flex gap-1.5 flex-wrap">
        {list.map((n, i) => <span key={`${n}-${i}`} className="v2-chip text-default">{n}</span>)}
        {max && names.length > max && <span className="v2-chip text-muted">+{names.length - max}</span>}
      </div>
    );
  };
  const bar = (g: V2GroupCard, h: string) => (
    <span className={`w-3 ${h} rounded-[5px] shrink-0`} style={{ background: avatarColorFill(g.colorIndex ?? 0), opacity: g.isActive ? 1 : 0.45 }} />
  );

  if (view === 'list') {
    return (
      <V2List>
        {shown.map((g) => (
          <Link key={g.id} href={`/groups/${g.id}`} className="v2-row">
            {bar(g, 'h-9')}
            <div className="w-[190px] min-w-0 shrink-0">
              <b className="text-default block truncate">{g.name}</b>
              <div className="text-muted text-[12.5px] truncate">{g.isActive ? (g.lastSyncedAt ? `synced ${formatLastSync(g.lastSyncedAt)}` : 'not synced yet') : 'Switched off'}</div>
            </div>
            <div className="flex-1 min-w-0"><Faces people={g.people} size="xs" /></div>
            <div className="v2-col w-[230px]">{chips(g, 3)}</div>
            {action(g)}
          </Link>
        ))}
      </V2List>
    );
  }
  return (
    <V2Grid max={3}>
      {shown.map((g) => (
        <Link key={g.id} href={`/groups/${g.id}`} className="v2-link">
          <V2Card action={action(g)}>
            <div className="flex items-center gap-3 min-w-0">
              {bar(g, 'h-10')}
              <div className="flex-1 min-w-0">
                <div className="text-lg font-semibold text-default truncate">{g.name}</div>
                <div className="text-muted text-[13px] truncate">{meta(g)}</div>
              </div>
            </div>
            {!g.isActive && <V2Status tone="off">Switched off</V2Status>}
            <Faces people={g.people} size="sm" />
            {chips(g)}
          </V2Card>
        </Link>
      ))}
    </V2Grid>
  );
}
