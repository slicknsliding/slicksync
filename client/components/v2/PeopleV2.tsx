'use client';

// Users in the v2 page design: people grouped by their group, each with one
// status in plain words and the one button that does the obvious thing (Sync,
// or Fix sign-in when their sign-in stopped working). Groups can be moved,
// folded and hidden, and people hidden, through the page's Arrange mode.

import Link from 'next/link';
import { ArrowPathIcon, EyeIcon } from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui';
import { avatarColorFill } from '@/components/ui/Avatar';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { V2AppPill, V2Button, V2Card, V2Grid, V2List, V2Status, type V2Tone } from './V2Bits';

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
};

export type V2Group = { key: string; name: string; colorIndex?: number; addons?: number };

function watched(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** The one status a person shows, and the line under it. */
function statusOf(p: V2Person, watching: string | undefined): { tone: V2Tone; words: string; line: string } {
  if (p.connectionError) return { tone: 'warn', words: 'Needs a fix', line: 'Sign-in stopped working' };
  if (p.status === 'expired') return { tone: 'off', words: 'Switched off', line: p.lastSeen === 'Never' ? 'Never seen watching' : `Last seen ${p.lastSeen}` };
  if (watching !== undefined) return { tone: 'live', words: 'Watching now', line: watching ? `Watching ${watching}` : 'Watching now' };
  return { tone: 'ok', words: 'All synced', line: p.lastSeen === 'Never' ? 'Never seen watching' : `Last seen ${p.lastSeen}` };
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
};

export const NO_GROUP_KEY = 'g:none';

export function PeopleV2({ people, groups, arrange, peopleArrange, view, watching, syncing, onSync, onFix }: Props) {
  const hiddenPeople = new Set(peopleArrange.hidden);
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const groupKeyOf = (p: V2Person) => {
    const g = groups.find((x) => x.name === p.groups[0]);
    return g ? g.key : NO_GROUP_KEY;
  };

  const action = (p: V2Person) => {
    if (p.connectionError) return <V2Button primary onClick={() => onFix(p)}>Fix sign-in</V2Button>;
    const busy = syncing.has(p.id);
    return (
      <V2Button onClick={() => onSync(p)} disabled={busy} icon={<ArrowPathIcon className={`w-4 h-4${busy ? ' animate-spin' : ''}`} />}>
        {busy ? 'Syncing' : 'Sync'}
      </V2Button>
    );
  };
  const hideBtn = (p: V2Person) => (
    <button type="button" className="arrange-icon" aria-label={`Hide ${p.name}`} title="Hide on this page"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); peopleArrange.hide(p.id); }}>
      <EyeIcon className="w-4 h-4" />
    </button>
  );

  const tile = (p: V2Person) => {
    const st = statusOf(p, watching.get(p.id));
    return (
      <Link key={p.id} href={`/users/${p.id}`} className={`v2-link${arrange.arranging ? ' v2-arranging' : ''}`}>
        <V2Card action={arrange.arranging ? hideBtn(p) : action(p)}>
          <div className="flex items-center gap-3.5 min-w-0">
            <UserAvatar userId={p.id} name={p.name} email={p.email} colorIndex={p.colorIndex} src={p.avatarUrl || undefined} useGravatar={p.useGravatar} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="text-[17px] font-semibold text-default truncate">{p.name}</div>
              <div className="mt-1"><V2AppPill label={p.appLabel} color={p.appColor} /></div>
            </div>
          </div>
          <div>
            <V2Status tone={st.tone}>{st.words}</V2Status>
            <div className="text-muted text-[13px] mt-1 truncate">{st.line}</div>
          </div>
          <div className="flex gap-4 text-[13px]">
            <span><b className="text-[15px] text-default">{watched(p.watchTime)}</b><span className="text-muted"> watched</span></span>
            <span><b className="text-[15px] text-default">{p.addonCount}</b><span className="text-muted"> addons</span></span>
          </div>
        </V2Card>
      </Link>
    );
  };

  const row = (p: V2Person) => {
    const st = statusOf(p, watching.get(p.id));
    return (
      <Link key={p.id} href={`/users/${p.id}`} className="v2-row">
        <UserAvatar userId={p.id} name={p.name} email={p.email} colorIndex={p.colorIndex} src={p.avatarUrl || undefined} useGravatar={p.useGravatar} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <b className="text-default truncate">{p.name}</b>
            <V2AppPill label={p.appLabel} color={p.appColor} />
          </div>
          <div className="text-muted text-[12.5px] truncate">{st.line}</div>
        </div>
        <div className="v2-col w-[150px]"><V2Status tone={st.tone}>{st.words}</V2Status></div>
        <div className="v2-col w-[130px] text-muted text-[13px]">{watched(p.watchTime)} watched</div>
        <div className="v2-col w-[80px] text-muted text-[13px]">{p.addonCount} addons</div>
        {arrange.arranging ? hideBtn(p) : action(p)}
      </Link>
    );
  };

  return (
    <div>
      {arrange.shown.map((key) => {
        const members = people.filter((p) => groupKeyOf(p) === key && !hiddenPeople.has(p.id));
        const all = people.filter((p) => groupKeyOf(p) === key);
        if (all.length === 0) return null;
        const g = byKey.get(key);
        const name = g?.name ?? 'No group';
        const color = g ? avatarColorFill(g.colorIndex ?? 0) : 'var(--color-text-subtle)';
        const addons = g?.addons;
        return (
          <ArrangeSection
            key={key}
            arrange={arrange}
            id={key}
            label={name}
            noun="group"
            title={(
              <span className="flex items-center gap-2.5 min-w-0">
                <span className="w-3 h-3 rounded shrink-0" style={{ background: color }} />
                <span className="truncate">{name}</span>
              </span>
            )}
            meta={`${all.length} ${all.length === 1 ? 'person' : 'people'}${addons !== undefined ? ` · ${addons} addons` : ''}`}
          >
            {members.length === 0
              ? <p className="text-sm text-muted py-2">Everyone in this group is hidden on this page.</p>
              : view === 'grid'
                ? <V2Grid>{members.map(tile)}</V2Grid>
                : <V2List>{members.map(row)}</V2List>}
          </ArrangeSection>
        );
      })}
    </div>
  );
}
