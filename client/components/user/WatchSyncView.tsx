'use client';

// AIOSync (server/utils/watchCopy): watched titles and resume
// points from any sign-in or profile - this person's or anyone else's - to
// another. COPY FROM and COPY TO are two big boxes in their own colours with
// the direction arrow between them; tapping a box opens a picker anchored to
// it. The preview is every title as poster cards with what each side has;
// the four numbers are filters. Nothing is removed, nothing goes backwards,
// and a copy can be undone from here for 7 days.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeftIcon, ArrowRightIcon, ArrowDownIcon, ArrowsRightLeftIcon, ArrowsUpDownIcon,
  ArrowUturnLeftIcon, ShieldCheckIcon, MagnifyingGlassIcon, ChevronDownIcon, CheckIcon,
} from '@heroicons/react/24/outline';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { Button } from '@/components/ui';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { KeepInStepCard } from '@/components/user/KeepInStepCard';
import { toast } from '@/components/ui/Toast';
import { cachedImageUrl } from '@/lib/posterUrl';
import { useCoarsePointer } from '@/lib/hooks/useCoarsePointer';
import {
  api, type WatchCopySide, type WatchCopyPerson, type WatchCopyPreview, type WatchCopyItem, type WatchCopyOutcome, type WatchCopyRun, type WatchCopyHas,
} from '@/lib/api';

const FROM_C = '#2dd4bf';
const TO_C = 'var(--color-primary)';
const AMBER = '#f5a524';
const PAGE = 120;
// The Will copy group opens on a peek of its first titles; the rest are one tap away.
const COPY_PEEK = 18;

// The poster grid, grouped by what will happen, in this order. The two that
// need nothing from you start folded.
const GROUPS: { key: WatchCopyOutcome; title: string; color: string; sub: string; folded?: boolean }[] = [
  { key: 'copy', title: 'Will copy', color: 'var(--color-success)', sub: '' },
  { key: 'match', title: 'Pick the match', color: 'var(--color-primary)', sub: 'We couldn’t tell which title these are. Pick one to include it.' },
  { key: 'further', title: 'Kept as it is', color: AMBER, sub: 'Further along there already, so these are left alone' },
  { key: 'there', title: 'Already there', color: 'var(--color-text-muted)', sub: 'Nothing to do for these', folded: true },
  { key: 'missing', title: 'Not on that server', color: 'var(--color-text-muted)', sub: '', folded: true },
];

const PROVIDER_LOOK: Record<string, { letter: string; bg: string }> = {
  stremio: { letter: 'S', bg: 'linear-gradient(135deg,#8a5cf6,#5b3fd6)' },
  nuvio: { letter: 'N', bg: 'linear-gradient(135deg,#38599e,#ff9800)' },
  jellyfin: { letter: 'J', bg: 'linear-gradient(135deg,#aa5cc3,#00a4dc)' },
  aiostreams: { letter: 'A', bg: 'linear-gradient(135deg,#9f92ff,#5b4fd6)' },
  aiometadata: { letter: 'A', bg: 'linear-gradient(135deg,#14b8a6,#0e7490)' },
};

const PROVIDER_PILL: Record<string, { bg: string; fg: string }> = {
  stremio: { bg: 'rgba(123,91,245,0.18)', fg: 'rgb(196,181,253)' },
  nuvio: { bg: 'rgba(56,89,158,.3)', fg: 'rgb(186,208,240)' },
  jellyfin: { bg: 'rgba(0,164,220,.18)', fg: 'rgb(160,215,240)' },
  aiostreams: { bg: 'rgba(159,146,255,0.16)', fg: 'rgb(212,208,255)' },
  aiometadata: { bg: 'rgba(45,212,191,0.14)', fg: 'rgb(153,246,228)' },
};

const SINCE = [
  { days: 0, label: 'all time' },
  { days: 7, label: 'the last week' },
  { days: 30, label: 'the last month' },
  { days: 90, label: 'the last 3 months' },
  { days: 365, label: 'the last year' },
];

function Logo({ kind, size = 40 }: { kind: string; size?: number }) {
  const look = PROVIDER_LOOK[kind] || PROVIDER_LOOK.jellyfin;
  return (
    <span
      className="flex items-center justify-center shrink-0 text-white font-bold"
      style={{ width: size, height: size, borderRadius: size * 0.3, background: look.bg, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {look.letter}
    </span>
  );
}

type Profile = WatchCopySide['profiles'][number];
type Choice = { side: string; sideInfo: WatchCopySide; profileName: string | null; profile: Profile | null };

function choiceFor(sides: WatchCopySide[], side: string): Choice | null {
  for (const s of sides) {
    if (s.side === side && !s.profiles.length) return { side, sideInfo: s, profileName: null, profile: null };
    const p = s.profiles.find((x) => x.side === side);
    if (p) return { side, sideInfo: s, profileName: p.name, profile: p };
  }
  return null;
}

const choiceLabel = (c: Choice | null) => (c ? `${c.sideInfo.person ? `${c.sideInfo.person.username}’s ` : ''}${c.sideInfo.name}${c.profileName ? ` · ${c.profileName}` : ''}` : '');

// A profile's picture: Nuvio's avatar or the household member's own on the
// server; the sign-in's own user is the person (their picture as everywhere
// else); otherwise the profile's colour with its initial.
function ProfilePic({ profile, person, kind, size }: { profile: Profile | null; person: WatchCopyPerson | null; kind: string; size: number }) {
  if (profile?.avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={profile.avatar} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size, background: profile.color || undefined }} />;
  }
  if ((!profile || profile.isPerson) && person) {
    return (
      <span className="shrink-0 inline-flex overflow-hidden rounded-full" style={{ width: size, height: size }}>
        <UserAvatar userId={person.id} name={person.username} email={person.email || undefined} src={person.avatarUrl || undefined} useGravatar={person.useGravatar} colorIndex={person.colorIndex} size="xs" className="!w-full !h-full" />
      </span>
    );
  }
  const name = profile?.name || '?';
  return (
    <span className="rounded-full flex items-center justify-center font-bold text-white shrink-0" style={{ width: size, height: size, fontSize: size * 0.45, background: profile?.color || PROVIDER_LOOK[kind]?.bg }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

// Closes a popover on a tap outside it or Escape.
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, ref, close]);
}

function SidePicker({ sides, others, person, current, other, title, onPick }: {
  sides: WatchCopySide[]; others: WatchCopySide[]; person: WatchCopyPerson | null; current: string; other: string; title: string; onPick: (side: string) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const shownOthers = others.filter((o) => !q || (o.person?.username || '').toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
  const row = (side: string, label: string, kind: string, profile?: Profile) => {
    const disabled = side === other;
    const active = side === current;
    return (
      <button
        key={side}
        type="button"
        disabled={disabled}
        onClick={() => onPick(side)}
        className="w-full flex items-center gap-2.5 text-left px-2 py-1.5 rounded-xl border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-hover"
        style={{ borderColor: active ? 'var(--color-primary)' : 'transparent', background: active ? 'color-mix(in srgb, var(--color-primary) 12%, transparent)' : undefined }}
      >
        {profile ? <ProfilePic profile={profile} person={person} kind={kind} size={26} /> : <Logo kind={kind} size={26} />}
        <span className="flex-1 text-sm text-default truncate">{label}</span>
        {disabled && <span className="text-xs text-subtle">{title === 'Copy to…' ? 'copying from' : 'copying to'}</span>}
        {active && <CheckIcon className="w-4 h-4 text-primary" />}
      </button>
    );
  };
  return (
    <div className="absolute z-30 left-0 right-0 sm:right-auto sm:w-[22rem] mt-2 rounded-2xl border border-default p-3 shadow-2xl max-h-[70vh] overflow-y-auto" style={{ background: 'var(--color-surface)' }}>
      <div className="font-semibold text-sm mb-1">{title}</div>
      {person && <div className="text-xs text-subtle mt-2 mb-1">{person.username}</div>}
      {sides.map((s) => (
        <div key={s.provider}>
          {s.profiles.length > 0 && (
            <div className="text-xs text-subtle mt-2.5 mb-1">
              {s.name}{s.provider === 'nuvio' ? ' — each profile has its own history' : s.kind !== 'jellyfin' ? ' — household' : ''}
            </div>
          )}
          {s.profiles.length
            ? s.profiles.map((p) => row(p.side, p.name, s.kind, p))
            : row(s.side, `${s.name}${s.detail ? ` · ${s.detail}` : ''}`, s.kind)}
        </div>
      ))}
      {others.length > 0 && (
        <>
          <div className="text-xs text-subtle mt-3 mb-1">Other people</div>
          {others.length > 5 && (
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people" className="w-full mb-1.5 px-2.5 py-1.5 rounded-lg border border-default bg-transparent text-sm text-default placeholder:text-muted outline-none" />
          )}
          {shownOthers.map((o) => {
            const disabled = o.side === other;
            const active = o.side === current;
            const pill = PROVIDER_PILL[o.kind] || PROVIDER_PILL.jellyfin;
            return (
              <button
                key={o.side}
                type="button"
                disabled={disabled}
                onClick={() => onPick(o.side)}
                className="w-full flex items-center gap-2.5 text-left px-2 py-1.5 rounded-xl border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-hover"
                style={{ borderColor: active ? 'var(--color-primary)' : 'transparent', background: active ? 'color-mix(in srgb, var(--color-primary) 12%, transparent)' : undefined }}
              >
                <ProfilePic profile={null} person={o.person || null} kind={o.kind} size={26} />
                <span className="flex-1 min-w-0 text-sm text-default truncate">{o.person?.username}</span>
                {o.detail && <span className="text-xs text-subtle whitespace-nowrap">{o.detail}</span>}
                <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: pill.bg, color: pill.fg }}>{o.name}</span>
                {active && <CheckIcon className="w-4 h-4 text-primary" />}
              </button>
            );
          })}
          {shownOthers.length === 0 && <div className="text-xs text-muted px-2 py-1.5">Nobody by that name.</div>}
          <div className="text-xs text-subtle mt-2">Copying between people only adds - the source&apos;s own history is never changed.</div>
        </>
      )}
    </div>
  );
}

function Slot({ role, choice, count, sides, others, person, other, onPick, compact }: {
  role: 'from' | 'to'; choice: Choice | null; count: number | null; sides: WatchCopySide[]; others: WatchCopySide[]; person: WatchCopyPerson | null; other: string; onPick: (side: string) => void; compact: boolean;
}) {
  const owner = choice?.sideInfo.person || person;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  const color = role === 'from' ? FROM_C : TO_C;
  return (
    <div ref={ref} className="relative min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-bold tracking-[0.08em]" style={{ color }}>
        {role === 'from' ? 'COPY FROM' : 'COPY TO'}
      </div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`w-full text-left flex items-center gap-3 rounded-[18px] ${choice ? 'slot-on' : 'slot-off'}`}
        style={choice
          ? { padding: compact ? 12 : 16, '--slot': color } as React.CSSProperties
          : { padding: compact ? 12 : 16, minHeight: compact ? 72 : 88, justifyContent: 'center', '--slot': color } as React.CSSProperties}
      >
        {choice ? <Logo kind={choice.sideInfo.kind} size={compact ? 40 : 48} /> : null}
        {!choice && <span className="font-semibold text-default flex items-center gap-1.5" style={{ fontSize: compact ? 15 : 16 }}>Pick a sign-in<ChevronDownIcon className="w-4 h-4 opacity-70" /></span>}
        {choice && <span className="flex-1 min-w-0">
          <span className="block font-semibold text-default" style={{ fontSize: compact ? 15 : 16 }}>{choice?.sideInfo.name || 'Pick a sign-in'}</span>
          <span className="block text-xs text-muted truncate">
            {[choice?.sideInfo.detail, count != null ? `${count.toLocaleString()} titles` : null].filter(Boolean).join(' · ')}
          </span>
          {choice && (choice.profileName || person) && (
            <span className="inline-flex max-w-full items-center gap-1.5 mt-2 pl-0.5 pr-2 py-0.5 rounded-full border border-default bg-surface-hover">
              <ProfilePic profile={choice.profile} person={owner} kind={choice.sideInfo.kind} size={20} />
              <span className="text-xs text-default truncate">{choice.profileName ? `Profile: ${choice.profileName}` : owner?.username}</span>
              {choice.profileName && <ChevronDownIcon className="w-3 h-3 opacity-60" />}
            </span>
          )}
        </span>}
        {choice && <span className="text-xs text-muted shrink-0 flex items-center gap-1">Change<ChevronDownIcon className="w-3 h-3" /></span>}
      </button>
      {open && <SidePicker sides={sides} others={others} person={person} current={choice?.side || ''} other={other} title={role === 'from' ? 'Copy from…' : 'Copy to…'} onPick={(s) => { onPick(s); setOpen(false); }} />}
    </div>
  );
}

function OtherChip({ side, onUse }: { side: WatchCopySide; onUse: (role: 'from' | 'to') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border border-dashed border-default">
        <Logo kind={side.kind} size={24} />
        <span className="text-xs text-default">{side.name}</span>
      </button>
      {open && (
        <div className="absolute z-30 left-0 mt-2 rounded-xl border border-default p-1.5 shadow-2xl flex flex-col min-w-[9rem]" style={{ background: 'var(--color-surface)' }}>
          <button type="button" className="text-left text-sm px-3 py-1.5 rounded-lg hover:bg-surface-hover" style={{ color: FROM_C }} onClick={() => { onUse('from'); setOpen(false); }}>Use as From</button>
          <button type="button" className="text-left text-sm px-3 py-1.5 rounded-lg hover:bg-surface-hover text-primary" onClick={() => { onUse('to'); setOpen(false); }}>Use as To</button>
        </div>
      )}
    </div>
  );
}

function OptionChip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // The chosen look is a class, never inline - see .sync-chip-on in globals.css.
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap border text-default disabled:opacity-40 ${on ? 'sync-chip-on' : 'sync-chip-off'}`}
    >
      {on && <CheckIcon className="w-3.5 h-3.5" />}
      {children}
    </button>
  );
}

function MatchPicker({ userId, item, onPick, onClose }: { userId: string; item: WatchCopyItem; onPick: (id: string) => void; onClose: () => void }) {
  const [list, setList] = useState<{ id: string; name: string; year: string | null; poster: string | null }[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onClose);
  useEffect(() => {
    api.getWatchCopyCandidates(userId, item.name || '', item.type).then((r) => setList(r.candidates)).catch(() => setList([]));
  }, [userId, item.name, item.type]);
  return (
    <div ref={ref} className="absolute z-30 left-0 top-[60%] w-72 rounded-2xl border border-default p-3 shadow-2xl" style={{ background: 'var(--color-surface)' }}>
      <div className="font-semibold text-sm mb-1">Which one did they watch?</div>
      {list === null && <div className="text-xs text-muted py-2">Looking…</div>}
      {list?.length === 0 && <div className="text-xs text-muted py-2">Nothing by that name — it stays out of the copy.</div>}
      {list?.map((c) => (
        <button key={c.id} type="button" onClick={() => onPick(c.id)} className="w-full flex items-center gap-2.5 text-left p-2 mt-1.5 rounded-xl border border-default bg-surface-hover hover:border-primary">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {c.poster ? <img src={c.poster} alt="" className="w-[30px] h-[45px] rounded-md object-cover" /> : <span className="w-[30px] h-[45px] rounded-md bg-surface" />}
          <span className="min-w-0"><span className="block text-sm font-semibold text-default truncate">{c.name}</span><span className="block text-xs text-muted">{c.year || ''}</span></span>
        </button>
      ))}
      <div className="text-xs text-subtle mt-2">The source only had a name for this one.</div>
    </div>
  );
}

// A side's picture showing what it has of one title: a tick when watched, a
// ring filled to the resume point when part-way, faded when not yet, dashed
// when there's no match to tell.
function StateAvatar({ has, pic, size, unknown }: { has: WatchCopyHas; pic: (size: number) => React.ReactNode; size: number; unknown?: boolean }) {
  const state = unknown ? 'unknown' : has.state || (has.none ? 'none' : 'watched');
  const badge = Math.max(12, Math.round(size * 0.55));
  if (state === 'partial') {
    return (
      <span key={has.pct ?? 50} title={has.text} className="shrink-0 rounded-full inline-flex items-center justify-center" style={{ width: size + 6, height: size + 6, background: `conic-gradient(${FROM_C} ${has.pct ?? 50}%, rgba(255,255,255,.18) 0)` }}>
        <span className="rounded-full inline-flex" style={{ boxShadow: '0 0 0 2px var(--color-background, #0b0d14)' }}>{pic(size)}</span>
      </span>
    );
  }
  return (
    <span
      title={unknown ? 'No match yet' : has.text}
      className={`relative shrink-0 inline-flex rounded-full ${state === 'unknown' ? 'state-unknown' : ''}`}
      style={state === 'none' ? { opacity: 0.38, filter: 'grayscale(1)' } : state === 'unknown' ? { opacity: 0.5 } : undefined}
    >
      {pic(size)}
      {state === 'watched' && (
        <span className="absolute -right-1 -bottom-1 rounded-full flex items-center justify-center" style={{ width: badge, height: badge, background: '#22c55e', color: '#04140a', boxShadow: '0 0 0 2px var(--color-background, #0b0d14)' }}>
          <CheckIcon style={{ width: badge * 0.65, height: badge * 0.65, strokeWidth: 3.5 }} />
        </span>
      )}
    </span>
  );
}

// Plain poster art, as on Discover - never the rating-printed RPDB kind.
function plainPoster(item: WatchCopyItem): string | undefined {
  if (item.poster) return cachedImageUrl(item.poster, 342);
  if (item.id && /^tt\d+$/.test(item.id)) return cachedImageUrl(`https://images.metahub.space/poster/medium/${item.id}/img`, 342);
  return undefined;
}

function Poster({ item, selected, matched, onToggle, onMatch, fromPic, toPic }: {
  item: WatchCopyItem; selected: boolean; matched: boolean; onToggle: () => void; onMatch: () => void;
  fromPic: (size: number) => React.ReactNode; toPic: (size: number) => React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  const src = !broken ? plainPoster(item) : undefined;
  const pickable = item.outcome === 'copy' || matched;
  const faded = pickable ? !selected : true;
  const size = 20;
  const detail = matched ? 'Matched' : item.outcome === 'copy' ? item.detail : item.outcome === 'further' ? `They’re at: ${item.to.text}` : null;
  return (
    <div className="min-w-0">
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface-hover transition-opacity" style={{ opacity: faded ? 0.6 : 1 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {src ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="absolute inset-0 w-full h-full object-cover" /> : <span className="absolute inset-0 flex items-end p-2 text-white font-extrabold uppercase text-sm leading-tight" style={{ background: 'linear-gradient(160deg,#2b2b2b,#555)' }}>{item.name}</span>}
        {pickable && (
          <div className="absolute top-1.5 right-1.5"><SelectionCheckbox checked={selected} onChange={onToggle} /></div>
        )}
      </div>
      <div className="font-semibold text-default text-[13px] mt-1.5 truncate">{item.name || item.id}</div>
      {item.outcome === 'match' && !matched ? (
        <button type="button" onClick={onMatch} className="mt-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full" style={{ background: 'color-mix(in srgb, var(--color-primary) 22%, transparent)', color: 'color-mix(in srgb, var(--color-primary) 45%, #ffffff)' }}>
          Pick the match
        </button>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <StateAvatar has={item.from} pic={fromPic} size={size} />
          <span className="text-xs text-subtle">→</span>
          <StateAvatar has={matched ? { text: 'Not watched', none: true, state: 'none' } : item.to} pic={toPic} size={size} unknown={item.outcome === 'missing'} />
        </div>
      )}
      {detail && <div className="mt-1 text-[11px] text-muted truncate" title={detail}>{detail}</div>}
    </div>
  );
}

// One group of titles that share an outcome; the heading says it once.
function Group({ color, title, count, sub, action, folded, onUnfold, children }: {
  color: string; title: string; count: number; sub: React.ReactNode; action?: React.ReactNode; folded?: boolean; onUnfold?: () => void; children?: React.ReactNode;
}) {
  const head = (
    <>
      <span className="w-1 self-stretch rounded shrink-0" style={{ background: color }} />
      <span className="flex-1 min-w-0 text-left">
        <span className="block font-bold text-default text-[17px]">
          {title}<span className="ml-2 align-[2px] text-[13px] font-semibold text-muted px-2 py-px rounded-full bg-surface-hover">{count.toLocaleString()}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs sm:text-[13px] text-muted">{sub}</span>
      </span>
    </>
  );
  if (folded) {
    return (
      <button type="button" onClick={onUnfold} className="mt-6 w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-surface hover:bg-surface-hover">
        {head}
        <span className="text-[13px] font-semibold px-3 py-1.5 rounded-[10px] shrink-0" style={{ color: 'color-mix(in srgb, var(--color-primary) 45%, #ffffff)', background: 'color-mix(in srgb, var(--color-primary) 14%, transparent)' }}>Show ›</span>
      </button>
    );
  }
  return (
    <div className="mt-6 first:mt-1">
      <div className="flex items-center gap-3">{head}{action}</div>
      {children}
    </div>
  );
}

// AIOSync for one person. Reached two ways: from their own page
// (home 'person', back goes to them) and from Tasks (home 'tasks', with the
// For switcher passed in as forSlot).
export function WatchSyncView({ userId, home = 'person', forSlot }: { userId: string; home?: 'person' | 'tasks'; forSlot?: React.ReactNode }) {
  const router = useRouter();
  const search = useSearchParams();

  // Opens at the top. The app keeps its top bar between pages, so a link
  // followed from further down a page (Tasks, a person's page) otherwise
  // landed partway down this one.
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [userId]);
  const { layoutMode } = useLayoutMode();
  const compact = useCoarsePointer();

  const [person, setPerson] = useState<string>('');
  const [sides, setSides] = useState<WatchCopySide[] | null>(null);
  const [personInfo, setPersonInfo] = useState<WatchCopyPerson | null>(null);
  const [others, setOthers] = useState<WatchCopySide[]>([]);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const copyRef = useRef<HTMLDivElement>(null);
  const closeCopy = useCallback(() => setConfirmCopy(false), []);
  useDismiss(confirmCopy, copyRef, closeCopy);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [watched, setWatched] = useState(true);
  const [resume, setResume] = useState(true);
  const [library, setLibrary] = useState(false);
  const [sinceDays, setSinceDays] = useState(0);
  const [preview, setPreview] = useState<WatchCopyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | WatchCopyOutcome>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [copyOpen, setCopyOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [matching, setMatching] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<WatchCopyRun | null>(null);
  const [copying, setCopying] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const undoRef = useRef<HTMLDivElement>(null);
  const closeUndo = useCallback(() => setConfirmUndo(false), []);
  useDismiss(confirmUndo, undoRef, closeUndo);

  useEffect(() => {
    if (!userId) return;
    api.getUser(userId).then((u: { username?: string }) => setPerson(u?.username || '')).catch(() => {});
    api.getWatchCopySides(userId, true).then((r) => {
      setSides(r.sides);
      setOthers(r.others || []);
      setPersonInfo(r.person || null);
      setLastRun(r.lastRun);
      const all = r.sides.flatMap((s) => (s.profiles.length ? s.profiles.map((p) => p.side) : [s.side]));
      const wantFrom = search.get('from');
      const wantTo = search.get('to');
      const known = new Set([...all, ...(r.others || []).map((o) => o.side)]);
      // Nothing is picked for you: From and To start empty unless the
      // address names them (a link from Keep in step or a person's page).
      if (wantFrom && wantTo && wantFrom !== wantTo && known.has(wantFrom) && known.has(wantTo)) {
        setFrom(wantFrom);
        setTo(wantTo);
      }
    }).catch((e) => setError(e?.message || 'Could not read their sign-ins'));
  }, [userId, search]);

  const fromChoice = sides ? choiceFor([...sides, ...others], from) : null;
  const toChoice = sides ? choiceFor([...sides, ...others], to) : null;
  const libraryAvailable = !!fromChoice && !!toChoice && fromChoice.sideInfo.provider !== 'jellyfin' && toChoice.sideInfo.provider !== 'jellyfin';

  const load = useCallback(async () => {
    if (!userId || !from || !to || from === to) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.previewWatchCopy(userId, { from, to, watched, resume, library: library && libraryAvailable, sinceDays });
      setPreview(r);
      setSelected(new Set(r.items.filter((i) => i.outcome === 'copy').map((i) => i.key)));
      setMatches({});
      setShown(PAGE);
      setCopyOpen(false);
      setUnfolded(new Set());
    } catch (e) {
      setPreview(null);
      setError((e as Error)?.message || 'Could not read their watch history');
    } finally {
      setLoading(false);
    }
  }, [userId, from, to, watched, resume, library, libraryAvailable, sinceDays]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (!preview) return [];
    const q = query.trim().toLowerCase();
    return preview.items.filter((i) =>
      (filter === 'all' || i.outcome === filter) &&
      (typeFilter === 'all' || i.type === typeFilter) &&
      (!q || (i.name || '').toLowerCase().includes(q)));
  }, [preview, filter, typeFilter, query]);

  const toCopy = [...selected].filter((k) => preview?.items.some((i) => i.key === k && (i.outcome === 'copy' || matches[k])));

  const copyLabel = `Copy ${toCopy.length.toLocaleString()} title${toCopy.length === 1 ? '' : 's'}`;
  const swap = () => { setFrom(to); setTo(from); };
  const pickFrom = (s: string) => { if (s === to) setTo(from); setFrom(s); };
  const pickTo = (s: string) => { if (s === from) setFrom(to); setTo(s); };

  const runCopy = async () => {
    if (!toCopy.length || !preview) return;
    setCopying(true);
    try {
      const keys = toCopy.filter((k) => !matches[k]);
      const picked = Object.fromEntries(Object.entries(matches).filter(([k]) => selected.has(k)));
      let job = await api.runWatchCopy(userId, { from, to, watched, resume, library: library && libraryAvailable, sinceDays, keys, matches: picked, fromName: choiceLabel(fromChoice), toName: choiceLabel(toChoice) });
      while (job.state === 'running') {
        await new Promise((r) => setTimeout(r, 1500));
        job = (await api.getWatchCopyStatus(userId)).job || job;
      }
      if (job.state === 'failed') throw new Error(job.error || 'The copy failed');
      const copiedTitle = `Copied ${job.done.toLocaleString()} title${job.done === 1 ? '' : 's'}`;
      if (job.failed) toast.warning(copiedTitle, { line: `To ${choiceLabel(toChoice)}. ${job.failed.toLocaleString()} couldn’t be copied.` });
      else toast.success(copiedTitle, { line: `To ${choiceLabel(toChoice)}.` });
      setLastRun((await api.getWatchCopyStatus(userId)).lastRun);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not copy their watch history');
    } finally {
      setCopying(false);
    }
  };

  const runUndo = async () => {
    if (!lastRun) return;
    setUndoing(true);
    try {
      const r = await api.undoWatchCopy(userId, lastRun.id);
      if (r.kept) toast.success('Undone', { line: `${r.kept} title${r.kept === 1 ? '' : 's'} they watched since stayed as they are.` });
      else toast.success('Undone');
      setConfirmUndo(false);
      setLastRun((await api.getWatchCopyStatus(userId)).lastRun);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not undo that copy');
    } finally {
      setUndoing(false);
    }
  };

  const fromPic = (size: number) => fromChoice ? <ProfilePic profile={fromChoice.profile} person={fromChoice.sideInfo.person || personInfo} kind={fromChoice.sideInfo.kind} size={size} /> : null;
  const toPic = (size: number) => toChoice ? <ProfilePic profile={toChoice.profile} person={toChoice.sideInfo.person || personInfo} kind={toChoice.sideInfo.kind} size={size} /> : null;
  const enoughSides = !!sides && sides.reduce((n, s) => n + Math.max(1, s.profiles.length), 0) + others.length >= 2;
  const otherSignIns = (sides || []).filter((s) => s.provider !== fromChoice?.sideInfo.provider && s.provider !== toChoice?.sideInfo.provider);
  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push(home === 'tasks' ? '/tasks' : `/users/${encodeURIComponent(userId)}`)}>
      {home === 'tasks' ? 'Tasks' : (person || 'Back')}
    </Button>
  );
  const subtitle = 'Watched titles and resume points between any sign-ins and profiles - copy once, or keep them in step. Nothing is removed.';
  const daysLeft = lastRun ? Math.max(0, Math.ceil((new Date(lastRun.undoUntil).getTime() - Date.now()) / 86400000)) : 0;
  const totals = preview?.totals;
  const tiles: { key: WatchCopyOutcome; n: number; label: string; color: string }[] = totals ? [
    { key: 'copy', n: totals.copy, label: 'will copy', color: 'var(--color-success)' },
    { key: 'there', n: totals.there, label: 'already there', color: 'var(--color-text-muted)' },
    { key: 'further', n: totals.further, label: 'further along there', color: AMBER },
    { key: 'match', n: totals.match, label: 'need a match', color: 'var(--color-primary)' },
  ] : [];

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={home === 'tasks'
            ? [{ label: 'Tasks', href: '/tasks' }, { label: 'AIOSync' }]
            : [{ label: 'Users', href: '/users' }, { label: person || 'Person', href: `/users/${encodeURIComponent(userId)}` }, { label: 'AIOSync' }]} className="text-xl font-semibold" />}
          subtitle={subtitle}
          actions={backButton}
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-4 md:p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && <NebulaPageHeading title="AIOSync" subtitle={subtitle} leading={backButton} />}
          {forSlot}
          <PageSection>
            {lastRun && (
              <div className="mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3.5 rounded-2xl border" style={{ borderColor: `color-mix(in srgb, ${AMBER} 60%, transparent)`, background: `color-mix(in srgb, ${AMBER} 11%, var(--color-surface))` }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <ArrowUturnLeftIcon className="w-4 h-4 shrink-0" style={{ color: AMBER }} />
                  <div className="min-w-0">
                    <div className="font-semibold text-default text-sm">Copied {(lastRun.copied || 0).toLocaleString()} title{lastRun.copied === 1 ? '' : 's'}{lastRun.toName ? ` to ${lastRun.toName}` : ''}</div>
                    <div className="text-xs text-muted">{lastRun.fromName ? `From ${lastRun.fromName}, ` : ''}{new Date(lastRun.createdAt).toLocaleString()} · undo available for {daysLeft} more day{daysLeft === 1 ? '' : 's'}</div>
                  </div>
                </div>
                <div ref={undoRef} className="relative shrink-0">
                  <button type="button" onClick={() => setConfirmUndo((o) => !o)} className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl font-bold text-sm" style={{ color: '#1a1200', background: AMBER, boxShadow: `0 8px 22px -10px ${AMBER}` }}>
                    <ArrowUturnLeftIcon className="w-4 h-4" />Undo this copy
                  </button>
                  {confirmUndo && (
                    <div className="absolute z-30 left-0 right-0 sm:left-auto sm:w-80 mt-2 rounded-2xl border border-default p-4 shadow-2xl" style={{ background: 'var(--color-surface)' }}>
                      <div className="font-semibold text-sm">Undo this copy?</div>
                      <p className="text-sm text-muted mt-1.5">{lastRun.toName || 'The destination'} goes back to how it was before: the watched marks and resume points this copy added come off. Anything they watched since stays.</p>
                      <div className="flex justify-end gap-2 mt-3">
                        <Button variant="secondary" size="sm" onClick={() => setConfirmUndo(false)}>Keep it</Button>
                        <button type="button" disabled={undoing} onClick={runUndo} className="px-3 py-1.5 rounded-lg text-sm font-bold disabled:opacity-60" style={{ color: '#1a1200', background: AMBER }}>{undoing ? 'Undoing…' : 'Undo copy'}</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {!userId && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 md:gap-4 items-start max-w-[70rem]">
                  {(['from', 'to'] as const).map((role) => (
                    <div key={role} className={`min-w-0 ${role === 'to' ? 'md:order-3' : ''}`}>
                      <div className="mb-1.5 text-[11px] font-bold tracking-[0.08em]" style={{ color: role === 'from' ? FROM_C : TO_C }}>{role === 'from' ? 'COPY FROM' : 'COPY TO'}</div>
                      <div className="flex items-center justify-center rounded-[18px] text-sm text-muted opacity-60" style={{ minHeight: compact ? 72 : 88, border: `2px dashed ${role === 'from' ? FROM_C : TO_C}` }}>Choose a person first</div>
                    </div>
                  ))}
                  <div className="flex md:flex-col items-center justify-center md:pt-6 md:order-2">
                    <span className="w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center text-subtle bg-surface-hover">
                      <ArrowRightIcon className="hidden md:block w-5 h-5" /><ArrowDownIcon className="md:hidden w-5 h-5" />
                    </span>
                  </div>
                </div>
                <div className="mt-6 rounded-2xl border border-dashed border-default px-5 py-9 text-center">
                  <div className="font-semibold text-default text-[17px]">Choose who to sync</div>
                  <div className="mt-1.5 text-sm text-muted">Pick a person above, then where to copy from and to. The titles that would copy show up here.</div>
                </div>
              </>
            )}
            {userId && sides === null && !error && <div className="text-sm text-muted">Reading their sign-ins…</div>}
            {sides && !enoughSides && (
              <div className="text-sm text-muted">There’s nothing to copy between yet - add a second sign-in or profile, or another person.</div>
            )}

            {sides && enoughSides && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 md:gap-4 items-start max-w-[70rem]">
                  <Slot role="from" choice={fromChoice} count={preview?.counts.from ?? null} sides={sides} others={others} person={personInfo} other={to} onPick={pickFrom} compact={compact} />
                  <div className="flex md:flex-col items-center justify-center gap-3 md:gap-2 md:pt-6">
                    <span className="w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center text-white" style={{ background: `linear-gradient(135deg, ${FROM_C}, var(--color-primary))`, boxShadow: '0 8px 22px -10px var(--color-primary)' }}>
                      <ArrowRightIcon className="hidden md:block w-5 h-5" /><ArrowDownIcon className="md:hidden w-5 h-5" />
                    </span>
                    <button type="button" onClick={swap} className="text-xs text-muted flex items-center gap-1 hover:text-default">
                      <ArrowsRightLeftIcon className="hidden md:block w-3.5 h-3.5" /><ArrowsUpDownIcon className="md:hidden w-3.5 h-3.5" />Swap
                    </button>
                  </div>
                  <Slot role="to" choice={toChoice} count={preview?.counts.to ?? null} sides={sides} others={others} person={personInfo} other={from} onPick={pickTo} compact={compact} />
                </div>
                {otherSignIns.length > 0 && (fromChoice || toChoice) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-subtle">Their other sign-ins:</span>
                    {otherSignIns.map((s) => (
                      <OtherChip key={s.provider} side={s} onUse={(role) => (role === 'from' ? pickFrom : pickTo)(s.profiles[0]?.side || s.side)} />
                    ))}
                  </div>
                )}

                {(!fromChoice || !toChoice) && (
                  <div className="mt-6 rounded-2xl border border-dashed border-default px-5 py-9 text-center">
                    <div className="font-semibold text-default text-[17px]">Pick where to copy from and to</div>
                    <div className="mt-1.5 text-sm text-muted">Choose two of their sign-ins or profiles, or someone else’s, and the titles that would copy show up here.</div>
                  </div>
                )}
                {fromChoice && toChoice && (<>
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-subtle mr-0.5">What to copy</span>
                  <OptionChip on={watched} onClick={() => setWatched((v) => !v)}>Watched</OptionChip>
                  <OptionChip on={resume} onClick={() => setResume((v) => !v)}>Resume points</OptionChip>
                  {libraryAvailable && <OptionChip on={library} onClick={() => setLibrary((v) => !v)}>Library</OptionChip>}
                  <label className="relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border border-default text-default whitespace-nowrap cursor-pointer">
                    Since: {SINCE.find((s) => s.days === sinceDays)?.label}
                    <ChevronDownIcon className="w-3 h-3 opacity-60" />
                    <select aria-label="Since" value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))} className="absolute inset-0 opacity-0 cursor-pointer">
                      {SINCE.map((s) => <option key={s.days} value={s.days}>{s.label}</option>)}
                    </select>
                  </label>
                </div>

                {error && <div className="mt-5 text-sm" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</div>}
                {loading && <div className="mt-5 text-sm text-muted">Reading both sides — a long history takes a little while…</div>}

                {preview && !loading && (
                  <>
                    <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-2.5">
                      {tiles.map((t) => {
                        const on = filter === t.key;
                        return (
                          <button key={t.key} type="button" onClick={() => setFilter(on ? 'all' : t.key)} className={`text-left px-3.5 py-3 rounded-[14px] border sync-tile ${on ? 'is-on' : ''}`}
                            style={{ '--tile': t.color } as React.CSSProperties}>
                            <div className="text-[22px] font-bold" style={{ color: t.color }}>{t.n.toLocaleString()}</div>
                            <div className="text-xs text-muted">{t.label}</div>
                          </button>
                        );
                      })}
                    </div>
                    {preview.limits.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        {preview.limits.map((l) => <span key={l}>{l}</span>)}
                      </div>
                    )}

                    <div className="mt-4 flex flex-col md:flex-row gap-2 md:items-center">
                      <div className="flex-1 md:min-w-[14rem] flex items-center gap-2 px-3 py-2 rounded-xl border border-default" style={{ background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)' }}>
                        <MagnifyingGlassIcon className="w-4 h-4 text-muted" />
                        <input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} placeholder="Search titles" className="flex-1 bg-transparent outline-none text-sm text-default placeholder:text-muted" />
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {([['all', `All ${totals!.found.toLocaleString()}`], ['copy', `Will copy ${totals!.copy.toLocaleString()}`], ['further', `Kept ${totals!.further.toLocaleString()}`], ['match', `Need a match ${totals!.match.toLocaleString()}`]] as const).map(([k, label]) => (
                          <OptionChip key={k} on={filter === k} onClick={() => setFilter(k)}>{label}</OptionChip>
                        ))}
                        <OptionChip on={typeFilter === 'movie'} onClick={() => setTypeFilter(typeFilter === 'movie' ? 'all' : 'movie')}>Movies</OptionChip>
                        <OptionChip on={typeFilter === 'series'} onClick={() => setTypeFilter(typeFilter === 'series' ? 'all' : 'series')}>Shows</OptionChip>
                      </div>
                    </div>

                    {GROUPS.map((g) => {
                      const list = visible.filter((v) => v.outcome === g.key);
                      if (!list.length) return null;
                      const folded = g.folded && !unfolded.has(g.key);
                      const limit = g.key === 'copy' && !copyOpen ? COPY_PEEK : shown;
                      const keys = list.map((v) => v.key);
                      const allOn = keys.every((k) => selected.has(k));
                      return (
                        <Group
                          key={g.key}
                          color={g.color}
                          title={g.title}
                          count={list.length}
                          sub={g.key === 'copy'
                            ? <>Marked watched, or picked up where they left off, on {toPic(16)} {choiceLabel(toChoice)}</>
                            : g.key === 'missing' ? `${choiceLabel(toChoice)} doesn’t have these, so they’re left out` : g.sub}
                          action={g.key === 'copy' ? (
                            <button type="button" onClick={() => setSelected((sel) => { const n = new Set(sel); keys.forEach((k) => (allOn ? n.delete(k) : n.add(k))); return n; })} className="text-[13px] font-semibold px-3 py-1.5 rounded-[10px] shrink-0 whitespace-nowrap" style={{ color: 'color-mix(in srgb, var(--color-primary) 45%, #ffffff)', background: 'color-mix(in srgb, var(--color-primary) 14%, transparent)' }}>
                              {allOn ? 'Untick all' : 'Tick all'}
                            </button>
                          ) : undefined}
                          folded={folded}
                          onUnfold={() => setUnfolded((u) => new Set(u).add(g.key))}
                        >
                          <div className="mt-3 grid gap-x-3.5 gap-y-[18px] grid-cols-3 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
                            {list.slice(0, limit).map((item) => (
                              <div key={item.key} className="relative">
                                <Poster
                                  item={item}
                                  selected={selected.has(item.key)}
                                  matched={!!matches[item.key]}
                                  fromPic={fromPic}
                                  toPic={toPic}
                                  onToggle={() => setSelected((sel) => { const n = new Set(sel); if (n.has(item.key)) n.delete(item.key); else n.add(item.key); return n; })}
                                  onMatch={() => setMatching(item.key)}
                                />
                                {matching === item.key && (
                                  <MatchPicker userId={userId} item={item} onClose={() => setMatching(null)} onPick={(id) => {
                                    setMatches((m) => ({ ...m, [item.key]: id }));
                                    setSelected((sel) => new Set(sel).add(item.key));
                                    setMatching(null);
                                  }} />
                                )}
                              </div>
                            ))}
                          </div>
                          {list.length > limit && (
                            <button type="button" onClick={() => (g.key === 'copy' && !copyOpen ? setCopyOpen(true) : setShown((n) => n + PAGE))} className="mt-3.5 w-full py-2.5 rounded-[10px] bg-surface hover:bg-surface-hover text-[13px] font-semibold text-muted">
                              {g.key === 'copy' && !copyOpen ? `Show all ${list.length.toLocaleString()}` : `Show more (${(list.length - limit).toLocaleString()} left)`}
                            </button>
                          )}
                        </Group>
                      );
                    })}
                    {visible.length === 0 && <div className="mt-4 text-sm text-muted">Nothing here.</div>}

                    {/* In the top-bar layout the account button floats in the bottom-left corner; the bar starts after it. */}
                    <div className={`sticky bottom-3 z-20 mt-4 flex items-center justify-between gap-3 pr-3.5 py-3 rounded-2xl border border-default ${layoutMode === 'nebula' ? 'pl-[4.25rem] md:pl-20' : 'pl-3.5'}`} style={{ background: 'var(--color-surface)', boxShadow: '0 -8px 30px -16px rgba(0,0,0,.7)' }}>
                      <div className="flex items-center gap-2 min-w-0 text-xs" style={{ color: AMBER }}>
                        <ShieldCheckIcon className="hidden sm:block w-4 h-4 shrink-0" />
                        <span className="hidden sm:inline">SlickSync saves what {choiceLabel(toChoice)} has first, so you can <b>undo this copy for 7 days</b></span>
                        <span className="sm:hidden leading-tight">Undo for 7 days</span>
                      </div>
                      {/* Copy asks first, naming where it goes - one tap once wrote into
                          a real profile by accident. */}
                      <div ref={copyRef} className="sm:relative shrink-0">
                        <button type="button" disabled={!toCopy.length || copying} onClick={() => setConfirmCopy((o) => !o)} aria-expanded={confirmCopy} className={`px-4 sm:px-5 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-50 ${confirmCopy ? 'copy-btn-open' : ''}`} style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))', boxShadow: '0 8px 22px -10px var(--color-primary)' }}>
                          {copying ? 'Copying…' : copyLabel}
                        </button>
                        {confirmCopy && (
                          <div className="absolute z-30 left-0 right-0 bottom-full mb-3 sm:left-auto sm:w-[22rem] rounded-2xl border border-default p-4 shadow-2xl" style={{ background: 'var(--color-surface)' }}>
                            <div className="font-semibold text-sm text-default">{copyLabel} into {choiceLabel(toChoice)}?</div>
                            <div className="mt-2.5 flex flex-wrap items-center gap-2 p-2.5 rounded-xl text-xs font-semibold bg-surface-hover">
                              <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: FROM_C }}><ProfilePic profile={fromChoice.profile} person={fromChoice.sideInfo.person || personInfo} kind={fromChoice.sideInfo.kind} size={22} /><span className="truncate">{fromChoice.profileName || choiceLabel(fromChoice)}</span></span>
                              <span className="text-muted">→</span>
                              <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: TO_C }}><ProfilePic profile={toChoice.profile} person={toChoice.sideInfo.person || personInfo} kind={toChoice.sideInfo.kind} size={22} /><span className="truncate">{toChoice.profileName || choiceLabel(toChoice)}</span></span>
                            </div>
                            <p className="text-sm text-muted mt-2">Watched marks and resume points are added there. Nothing is removed, and you can undo it from this page for 7 days.</p>
                            <div className="flex justify-end gap-2 mt-3">
                              <Button variant="secondary" size="sm" onClick={() => setConfirmCopy(false)}>Cancel</Button>
                              <button type="button" onClick={() => { setConfirmCopy(false); void runCopy(); }} className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }}>{copyLabel}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
                </>)}
              </>
            )}
            {userId && sides && <div className="mt-6"><KeepInStepCard userId={userId} /></div>}
          </PageSection>
        </div>
      </div>
    </>
  );
}
