'use client';

// Users in the v2 page design: people grouped by their group, each with one
// status in plain words (their real sync state, or what needs attention) and
// the one button that does the obvious thing (Sync, or Fix sign-in when their
// sign-in stopped working). A ⋯ on every card holds the rest. Groups can be
// moved, folded and hidden, and people hidden, pinned or dragged (into another
// group's section to move them there), through the page's Arrange mode.

import { useRouter } from 'next/navigation';
import {
  ArrowDownTrayIcon, ArrowPathIcon, ArrowPathRoundedSquareIcon, ArrowTopRightOnSquareIcon, EyeIcon, MapPinIcon, PowerIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import { MapPinIcon as MapPinSolid } from '@heroicons/react/24/solid';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { UserAvatar } from '@/components/ui';
import { GroupPicture } from './GroupPicture';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { pinFirst } from '@/lib/arrange-core';
import { V2AppPill, V2Button, V2Card, V2DragHint, V2Grid, V2Grip, V2Item, V2List, V2Status, type V2CardMenuItem, type V2Tone } from './V2Bits';
import { syncWords, useV2Sync, type V2Sync } from './V2Sync';

export type V2Person = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
  useGravatar?: boolean;
  colorIndex?: number;
  appLabel: string;
  appColor: string;
  groups: string[];
  status: 'active' | 'expired' | 'pending';
  connectionError?: string | null;
  lastSeen: string;
  watchTime: number;
  addonCount: number;
  /** Whether SlickSync keeps an addon list for them (a Jellyfin server has none to sync). */
  hasAddons?: boolean;
};

export type V2Group = { key: string; name: string; colorIndex?: number; avatarUrl?: string | null; addons?: number };

function watched(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** The one status a person shows, and the line under it. */
function statusOf(p: V2Person, watching: string | undefined, sync: V2Sync): { tone: V2Tone; words: string; line: string; lineTitle?: string } {
  const seen = p.lastSeen === 'Never' ? 'Never seen watching' : `Last seen ${p.lastSeen}`;
  if (p.connectionError) return { tone: 'warn', words: 'Needs a fix', line: `${p.appLabel} sign-in stopped working`, lineTitle: p.connectionError };
  if (p.status === 'expired') return { tone: 'off', words: 'Switched off', line: seen };
  const sw = p.hasAddons === false ? null : syncWords(sync);
  // Only a sync that is off or running is worth saying beside "Watching now".
  const trouble = sw && sync.kind !== 'synced' && sync.kind !== 'checking' ? sw.words : '';
  if (watching !== undefined) return { tone: 'live', words: 'Watching now', line: [watching ? `Watching ${watching}` : 'Watching now', trouble].filter(Boolean).join(' · ') };
  if (!sw) return { tone: 'ok', words: 'Connected', line: seen };
  return { ...sw, line: seen };
}

type Props = {
  people: V2Person[];
  groups: V2Group[];
  /** Section order, folding and hiding for the groups. */
  arrange: PageArrange;
  /** Hiding for single people. */
  peopleArrange: PageArrange;
  view: 'grid' | 'list';
  /** Who is watching right now, and what (empty string when the title isn't known). */
  watching: Map<string, string>;
  syncing: Set<string>;
  onSync: (p: V2Person) => void;
  onFix: (p: V2Person) => void;
  onReloadAddons: (p: V2Person) => void;
  onImportAddons: (p: V2Person) => void;
  onToggleActive: (p: V2Person) => void;
  onDelete: (p: V2Person) => void;
  /** Pinned people sit first in their group. */
  pins: { isPinned: (id: string) => boolean; toggle: (id: string) => void; pinned: string[] };
};

export const NO_GROUP_KEY = 'g:none';

/** The amber pill that says the sign-in is the problem; a tap starts the fix. */
function SignInPill({ p, onFix }: { p: V2Person; onFix: (p: V2Person) => void }) {
  return (
    <button
      type="button"
      className="v2-chip"
      title={p.connectionError || 'Sign-in problem'}
      aria-label={`Sign-in problem for ${p.name}: ${p.connectionError || 'sign-in stopped working'}`}
      style={{
        color: 'var(--color-warning, #f59e0b)',
        borderColor: 'color-mix(in srgb, var(--color-warning, #f59e0b) 45%, transparent)',
        background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 14%, transparent)',
        cursor: 'pointer',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFix(p); }}
    >
      Sign-in problem
    </button>
  );
}

export function PeopleV2({ people, groups, arrange, peopleArrange, view, watching, syncing, onSync, onFix, onReloadAddons, onImportAddons, onToggleActive, onDelete, pins }: Props) {
  const router = useRouter();
  const hiddenPeople = new Set(peopleArrange.hidden);
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const groupKeyOf = (p: V2Person) => {
    const g = groups.find((x) => x.name === p.groups[0]);
    return g ? g.key : NO_GROUP_KEY;
  };
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const dragHint = (activeId: string, overId: string | null) => {
    const a = peopleById.get(activeId);
    const o = overId ? peopleById.get(overId) : undefined;
    if (!a || !o) return null;
    const to = groupKeyOf(o);
    if (to === groupKeyOf(a)) return null;
    return `Moves ${a.name} to ${byKey.get(to)?.name ?? 'No group'}`;
  };

  const menuFor = (p: V2Person): V2CardMenuItem[] => [
    { label: 'Open', icon: <ArrowTopRightOnSquareIcon className="w-4 h-4" />, onClick: () => router.push(`/users/${p.id}`) },
    ...(p.hasAddons === false ? [] : [
      { label: 'Sync', icon: <ArrowPathIcon className="w-4 h-4" />, disabled: syncing.has(p.id), onClick: () => onSync(p) },
      { label: 'Reload addons', icon: <ArrowPathRoundedSquareIcon className="w-4 h-4" />, onClick: () => onReloadAddons(p) },
      { label: 'Import addons', icon: <ArrowDownTrayIcon className="w-4 h-4" />, onClick: () => onImportAddons(p) },
    ]),
    { label: p.status === 'expired' ? 'Switch on' : 'Switch off', icon: <PowerIcon className="w-4 h-4" />, onClick: () => onToggleActive(p) },
    { label: 'Delete', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => onDelete(p) },
  ];

  const pinBtn = (id: string, name: string) => {
    const on = pins.isPinned(id);
    return (
      <button type="button" className={`arrange-icon${on ? ' arrange-icon-on' : ''}`} aria-pressed={on} aria-label={on ? `Unpin ${name}` : `Pin ${name}`} title={on ? 'Unpin' : 'Pin to the front'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pins.toggle(id); }}>
        <MapPinIcon className="w-4 h-4" />
      </button>
    );
  };
  const hideBtn = (p: V2Person) => (
    <span className="flex gap-1.5">
      <V2Grip label={`Drag ${p.name}`} />
      {pinBtn(p.id, p.name)}
      <button type="button" className="arrange-icon" aria-label={`Hide ${p.name}`} title="Hide on this page"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); peopleArrange.hide(p.id); }}>
        <EyeIcon className="w-4 h-4" />
      </button>
    </span>
  );
  const pinMark = (p: V2Person) => pins.isPinned(p.id) ? <MapPinSolid className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} aria-label="Pinned" /> : null;

  const action = (p: V2Person) => {
    if (arrange.arranging) return hideBtn(p);
    if (p.connectionError) return <V2Button primary onClick={() => onFix(p)}>Fix sign-in</V2Button>;
    const busy = syncing.has(p.id);
    return (
      <V2Button onClick={() => onSync(p)} disabled={busy} icon={<ArrowPathIcon className={`w-4 h-4${busy ? ' animate-spin' : ''}`} />}>
        {busy ? 'Syncing' : 'Sync'}
      </V2Button>
    );
  };

  const itemProps = (p: V2Person) => ({
    href: `/users/${p.id}`,
    menuLabel: `${p.name} options`,
    items: menuFor(p),
    sortId: p.id,
    sortData: { label: p.name },
    arranging: arrange.arranging,
    className: arrange.arranging ? 'v2-arranging' : '',
  });

  return (
    <div>
      <V2DragHint hint={dragHint} />
      {arrange.shown.map((key) => {
        const members = pinFirst(people.filter((p) => groupKeyOf(p) === key && !hiddenPeople.has(p.id)), (p) => p.id, pins.pinned);
        const all = people.filter((p) => groupKeyOf(p) === key);
        if (all.length === 0) return null;
        const g = byKey.get(key);
        const name = g?.name ?? 'No group';
        const addons = g?.addons;
        return (
          <ArrangeSection
            key={key}
            arrange={arrange}
            id={key}
            label={name}
            noun="group"
            cards
            title={(
              <span className="flex items-center gap-2.5 min-w-0">
                {g ? <GroupPicture name={name} avatarUrl={g.avatarUrl} colorIndex={g.colorIndex} size="sm" ring={false} /> : <span className="w-8 h-8 rounded-[30%] shrink-0 border border-dashed border-default" />}
                <span className="truncate">{name}</span>
              </span>
            )}
            meta={`${all.length} ${all.length === 1 ? 'person' : 'people'}${addons !== undefined ? ` · ${addons} addons` : ''}`}
          >
            {members.length === 0
              ? <p className="text-sm text-muted py-2">Everyone in this group is hidden on this page.</p>
              : view === 'grid'
                ? (
                  <SortableContext items={members.map((p) => p.id)} strategy={rectSortingStrategy}>
                    <V2Grid stretch={{ arrange: arrange, id: key }}>
                      {members.map((p) => (
                        <PersonTile key={p.id} p={p} watching={watching.get(p.id)} syncing={syncing.has(p.id)} itemProps={itemProps(p)} action={action(p)} pinMark={pinMark(p)} onFix={onFix} />
                      ))}
                    </V2Grid>
                  </SortableContext>
                )
                : (
                  <SortableContext items={members.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                    <V2List>
                      {members.map((p) => (
                        <PersonRow key={p.id} p={p} watching={watching.get(p.id)} syncing={syncing.has(p.id)} itemProps={itemProps(p)} action={action(p)} pinMark={pinMark(p)} onFix={onFix} />
                      ))}
                    </V2List>
                  </SortableContext>
                )}
          </ArrangeSection>
        );
      })}
    </div>
  );
}

type CardParts = {
  p: V2Person;
  watching: string | undefined;
  syncing: boolean;
  itemProps: Omit<React.ComponentProps<typeof V2Item>, 'view' | 'children'>;
  action: React.ReactNode;
  pinMark: React.ReactNode;
  onFix: (p: V2Person) => void;
};

function usePersonStatus(p: V2Person, watching: string | undefined, syncing: boolean) {
  const sync = useV2Sync({ userId: p.id, syncing, enabled: p.hasAddons !== false && p.status !== 'expired' && !p.connectionError });
  return statusOf(p, watching, sync);
}

function PersonTile({ p, watching, syncing, itemProps, action, pinMark, onFix }: CardParts) {
  const st = usePersonStatus(p, watching, syncing);
  return (
    <V2Item view="card" {...itemProps} className={`h-full ${itemProps.className ?? ''}`}>
      <V2Card action={action}>
        <div className="flex items-center gap-3.5 min-w-0">
          <UserAvatar userId={p.id} name={p.name} email={p.email} colorIndex={p.colorIndex} src={p.avatarUrl || undefined} useGravatar={p.useGravatar} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0"><span className="text-[17px] font-semibold text-default truncate">{p.name}</span>{pinMark}</div>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <V2AppPill label={p.appLabel} color={p.appColor} />
              {p.connectionError && <SignInPill p={p} onFix={onFix} />}
            </div>
          </div>
        </div>
        <div>
          <V2Status tone={st.tone}>{st.words}</V2Status>
          <div className="text-muted text-[13px] mt-1 break-words" title={st.lineTitle}>{st.line}</div>
        </div>
        <div className="flex gap-4 text-[13px]">
          <span><b className="text-[15px] text-default">{watched(p.watchTime)}</b><span className="text-muted"> watched</span></span>
          <span><b className="text-[15px] text-default">{p.addonCount}</b><span className="text-muted"> addons</span></span>
        </div>
      </V2Card>
    </V2Item>
  );
}

function PersonRow({ p, watching, syncing, itemProps, action, pinMark, onFix }: CardParts) {
  const st = usePersonStatus(p, watching, syncing);
  return (
    <V2Item view="row" {...itemProps}>
      <UserAvatar userId={p.id} name={p.name} email={p.email} colorIndex={p.colorIndex} src={p.avatarUrl || undefined} useGravatar={p.useGravatar} size="md" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <b className="text-default truncate">{p.name}</b>
          {pinMark}
          <V2AppPill label={p.appLabel} color={p.appColor} />
          {p.connectionError && <SignInPill p={p} onFix={onFix} />}
        </div>
        <div className="text-muted text-[12.5px] truncate" title={st.lineTitle}>{st.line}</div>
      </div>
      <div className="v2-col w-[190px]"><V2Status tone={st.tone}>{st.words}</V2Status></div>
      <div className="v2-col w-[130px] text-muted text-[13px]">{watched(p.watchTime)} watched</div>
      <div className="v2-col w-[80px] text-muted text-[13px]">{p.addonCount} addons</div>
      {action}
    </V2Item>
  );
}
