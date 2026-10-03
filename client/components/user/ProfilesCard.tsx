'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ChevronDownIcon, UsersIcon, UserPlusIcon, ArrowUturnLeftIcon, SparklesIcon, EyeSlashIcon, EyeIcon,
} from '@heroicons/react/24/outline';
import { api, type ProfilesView } from '@/lib/api';
import { Button, Card, ConfirmModal, UserAvatar } from '@/components/ui';
import { toast } from '@/components/ui/Toast';

type Profile = ProfilesView['profiles'][number];
type Person = ProfilesView['persons'][number];

interface PendingAction {
  title: string;
  description: string;
  confirmText: string;
  variant?: 'default' | 'warning' | 'danger';
  run: () => Promise<void>;
}

function count(n: number) {
  return n === 1 ? '1 title' : `${n.toLocaleString()} titles`;
}

function titles(t: { movies: number; episodes: number }) {
  return count(t.movies + t.episodes);
}

function profileName(p: Profile) {
  return p.name || `Profile ${p.index}`;
}

/** A Nuvio profile's own colour, as the app shows it. */
function ProfileMark({ profile, muted }: { profile: Profile; muted?: boolean }) {
  const hex = !muted && profile.color && /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : null;
  return (
    <span
      className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold"
      style={hex
        ? { background: `${hex}33`, color: hex, boxShadow: `inset 0 0 0 1px ${hex}55` }
        : { background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}
      aria-hidden
    >
      {profileName(profile).trim().charAt(0).toUpperCase()}
    </span>
  );
}

const SELECT_CHEVRON = "bg-no-repeat bg-[length:1rem] bg-[right_0.5rem_center] bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20fill=%22none%22%20viewBox=%220%200%2024%2024%22%20stroke=%22%2394a3b8%22%3E%3Cpath%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%20stroke-width=%222%22%20d=%22M19%209l-7%207-7-7%22/%3E%3C/svg%3E')]";

/**
 * The people on one Nuvio login and the profiles each of them is made of.
 * Every profile is either its own person, part of someone's history, or not
 * tracked; the actions move it between those, and a merge can be separated
 * again. The rules live in server/utils/nuvioProfiles.js.
 */
export function ProfilesCard({ userId, loginLabel, onPeopleChanged }: {
  /** Any person on the Nuvio login - normally its main profile's person. */
  userId: string;
  /** Shown when the account has more than one Nuvio login, to tell them apart. */
  loginLabel?: string | null;
  /** People were added, merged away or brought back. */
  onPeopleChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ProfilesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await api.getProfiles(userId));
    } catch (e: any) {
      setError(e?.message || "Could not read this account's profiles just now");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // A live call to Nuvio, so only made once the card is opened.
  useEffect(() => {
    if (open && !view && !loading && !error) load();
  }, [open, view, loading, error, load]);

  useEffect(() => {
    setView(null);
    setError(null);
  }, [userId]);

  const persons = view?.persons || [];
  const personById = (id: string | null): Person | undefined => persons.find((p) => p.id === id);
  const nameOf = (id: string | null) => personById(id)?.username || 'someone';

  const perform = async (action: () => Promise<ProfilesView>, message: string, peopleChange = false) => {
    setBusy(true);
    try {
      const next = await action();
      setView(next);
      toast.success(message);
      if (peopleChange) onPeopleChanged?.();
    } catch (e: any) {
      toast.error(e?.message || 'Could not change that');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const mergeInto = (profile: Profile, target: string) => {
    if (!target) return;
    const name = profileName(profile);
    const to = nameOf(target);

    if (profile.ownPersonId) {
      const donor = personById(profile.ownPersonId);
      const donorName = donor?.username || name;
      setPending({
        title: `Merge ${donorName} into ${to}?`,
        description: `Use this when they are the same person. ${donorName}'s history (${titles({ movies: donor?.movies || 0, episodes: donor?.episodes || 0 })}) becomes part of ${to}'s, and anything watched on the ${name} profile from now on goes to ${to}. ${donorName} leaves the Users list - you can separate them again here at any time.`,
        confirmText: 'Merge',
        variant: 'warning',
        run: () => perform(() => api.setProfileOwner(userId, profile.index, target), `${donorName} merged into ${to}`, true),
      });
      return;
    }

    const moving = profile.ownerId && profile.titles.movies + profile.titles.episodes > 0;
    setPending({
      title: `Merge ${name} into ${to}?`,
      description: moving
        ? `The ${titles(profile.titles)} watched on ${name} move from ${nameOf(profile.ownerId)} to ${to}, and anything watched on it from now on goes to ${to}.`
        : `Anything watched on ${name} from now on goes to ${to}.`,
      confirmText: 'Merge',
      run: () => perform(() => api.setProfileOwner(userId, profile.index, target), `${name} merged into ${to}`),
    });
  };

  const stopTracking = (profile: Profile) => {
    const name = profileName(profile);
    setPending({
      title: `Stop tracking ${name}?`,
      description: `Nothing watched on ${name} is recorded from now on - no history, watch time or stats, for anyone. What it has already recorded stays where it is.`,
      confirmText: 'Stop tracking',
      run: () => perform(() => api.setProfileOwner(userId, profile.index, 'skip'), `${name} is no longer tracked`),
    });
  };

  const trackAgain = (profile: Profile) => {
    perform(() => api.setProfileOwner(userId, profile.index, 'default'), `${profileName(profile)} is tracked again`);
  };

  const makeOwnPerson = (profile: Profile) => {
    const name = profileName(profile);
    if (profile.merged) {
      const donor = profile.merged.donorUsername;
      setPending({
        title: `Separate ${donor} again?`,
        description: `${donor} comes back with everything they had before the merge, and anything watched on ${name} since then goes with them.`,
        confirmText: 'Separate',
        run: () => perform(() => api.giveProfileOwnPerson(userId, profile.index), `${donor} is back`, true),
      });
      return;
    }
    const moving = profile.ownerId && profile.titles.movies + profile.titles.episodes > 0;
    setPending({
      title: `Make ${name} its own person?`,
      description: `Use this when someone else watches on ${name}. A new person called ${name} joins the Users list${moving ? `, and the ${titles(profile.titles)} watched on it move to them from ${nameOf(profile.ownerId)}` : ''}.${profile.usesPrimaryAddons ? '' : ' They also get that profile\'s own addons to manage.'}`,
      confirmText: 'Make person',
      run: () => perform(() => api.giveProfileOwnPerson(userId, profile.index), `${name} is its own person now`, true),
    });
  };

  const tidy = () => {
    setPending({
      title: 'Put this history right?',
      description: `An older version recorded every profile on everyone on this Nuvio login. ${view?.misplaced?.titles || 0} titles go to the person whose profile they were watched on; copies that person already has are removed.`,
      confirmText: 'Put it right',
      run: () => perform(() => api.tidyProfiles(userId), 'History put right'),
    });
  };

  // Everything one profile row can do, in the order people reach for them.
  const actionsFor = (profile: Profile, mainPersonId: string | undefined): ReactNode => {
    const name = profileName(profile);
    const own = profile.ownPersonId;
    const tracked = !!profile.ownerId;
    if (own && own === mainPersonId) return null;
    const targets = persons.filter((p) => p.id !== profile.ownerId && p.id !== own);
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {!own && profile.merged && (
          <Button variant="secondary" size="sm" leftIcon={<ArrowUturnLeftIcon className="w-4 h-4" />} onClick={() => makeOwnPerson(profile)} disabled={busy}>
            Separate again
          </Button>
        )}
        {!own && !profile.merged && (
          <Button variant="secondary" size="sm" leftIcon={<UserPlusIcon className="w-4 h-4" />} onClick={() => makeOwnPerson(profile)} disabled={busy}>
            Make it its own person
          </Button>
        )}
        {targets.length > 0 && (
          <select
            className={`text-sm rounded-lg pl-3 pr-8 py-1.5 border appearance-none cursor-pointer focus:outline-none focus:border-primary disabled:opacity-60 ${SELECT_CHEVRON}`}
            style={{ borderColor: 'var(--color-surface-border)', backgroundColor: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
            value=""
            disabled={busy}
            onChange={(e) => mergeInto(profile, e.target.value)}
            aria-label={`Merge ${name} into someone`}
          >
            <option value="" disabled style={{ backgroundColor: 'var(--color-surface)' }}>Merge into…</option>
            {targets.map((p) => (
              <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--color-surface)' }}>{p.username}</option>
            ))}
          </select>
        )}
        {!own && tracked && (
          <Button variant="ghost" size="sm" leftIcon={<EyeSlashIcon className="w-4 h-4" />} onClick={() => stopTracking(profile)} disabled={busy}>
            Stop tracking
          </Button>
        )}
        {!own && !tracked && (
          <Button variant="ghost" size="sm" leftIcon={<EyeIcon className="w-4 h-4" />} onClick={() => trackAgain(profile)} disabled={busy}>
            Track it again
          </Button>
        )}
      </div>
    );
  };

  const profileRow = (profile: Profile, mainPersonId: string | undefined) => {
    const tracked = !!profile.ownerId;
    const n = profile.titles.movies + profile.titles.episodes;
    let tag: string;
    if (!tracked) tag = 'Nothing watched on it is recorded';
    else if (profile.ownPersonId) tag = profile.index === 1 ? 'Main profile' : 'Their own profile';
    else if (profile.merged) tag = `Merged in - was ${profile.merged.donorUsername}`;
    else tag = 'Part of their history';
    const addons = profile.index > 1 && profile.ownPersonId
      ? (profile.usesPrimaryAddons ? " · uses the main profile's addons" : ' · has its own addons')
      : '';
    const actions = actionsFor(profile, mainPersonId);
    return (
      <div key={profile.index} className="flex items-center justify-between gap-3 flex-wrap py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <ProfileMark profile={profile} muted={!tracked} />
          <div className="min-w-0">
            <p className={`text-sm font-medium truncate ${tracked ? 'text-default' : 'text-muted'}`}>{profileName(profile)}</p>
            <p className="text-xs text-subtle">
              {tag}{tracked ? ` · ${count(n)} watched on it` : ''}{addons}
            </p>
          </div>
        </div>
        {actions}
      </div>
    );
  };

  const summary = view
    ? `${view.profiles.length} profile${view.profiles.length === 1 ? '' : 's'} · ${persons.length} ${persons.length === 1 ? 'person' : 'people'}`
    : 'Which profiles belong to whom';
  const mainPersonId = persons[0]?.id;
  const untracked = view ? view.profiles.filter((p) => !p.ownerId) : [];

  return (
    <Card padding="lg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/20 shrink-0">
            <UsersIcon className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-default mb-0.5">
              Nuvio profiles{loginLabel ? <span className="text-muted font-normal"> · {loginLabel}</span> : null}
            </h3>
            <p className="text-sm text-muted">{summary}</p>
          </div>
        </div>
        <ChevronDownIcon className="w-5 h-5 text-muted shrink-0 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {open && (
        <div className="mt-5">
          {loading && !view ? (
            <p className="text-sm text-muted py-2">Reading profiles from Nuvio…</p>
          ) : error && !view ? (
            <div className="flex items-center justify-between gap-3 flex-wrap py-2">
              <p className="text-sm text-muted">{error}</p>
              <Button variant="ghost" size="sm" onClick={load}>Try again</Button>
            </div>
          ) : view ? (
            <>
              <p className="text-sm text-muted mb-4">
                Every profile is either its own person, or part of someone&apos;s history. Make a profile its own person when someone else watches on it, merge it into someone when it is really them, or stop tracking it - a Kids or Guest profile.
              </p>

              {view.misplaced && (
                <div className="mb-4 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap bg-warning-muted">
                  <div className="flex items-start gap-2 min-w-0">
                    <SparklesIcon className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <p className="text-sm text-default">
                      {view.misplaced.titles} title{view.misplaced.titles === 1 ? ' was' : 's were'} recorded on the wrong person by an older version.
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={tidy} disabled={busy}>Put it right</Button>
                </div>
              )}

              <div className="flex flex-col gap-3">
                {persons.map((person) => {
                  const theirs = view.profiles.filter((p) => p.ownerId === person.id);
                  return (
                    <div key={person.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                      <div className="flex items-center justify-between gap-3 flex-wrap pb-2 border-b border-white/5">
                        <div className="flex items-center gap-3 min-w-0">
                          <UserAvatar userId={person.id} name={person.username} email={person.email || undefined} src={person.avatarUrl || undefined} colorIndex={person.colorIndex} size="sm" />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-default truncate">{person.username}</p>
                            <p className="text-xs text-muted">
                              {count(person.movies + person.episodes)} in history{!person.isActive ? ' · turned off' : ''}
                            </p>
                          </div>
                        </div>
                        <Link href={`/users/${person.id}`} className="text-xs text-primary hover:underline">Open</Link>
                      </div>
                      <div className="divide-y divide-white/5">
                        {theirs.length ? theirs.map((p) => profileRow(p, mainPersonId)) : (
                          <p className="text-xs text-subtle py-2.5">No profile records for them right now.</p>
                        )}
                      </div>
                    </div>
                  );
                })}

                {untracked.length > 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-3">
                    <div className="flex items-center gap-2 pb-2 border-b border-white/5">
                      <EyeSlashIcon className="w-4 h-4 text-muted" />
                      <p className="text-sm font-semibold text-muted">Not tracked</p>
                    </div>
                    <div className="divide-y divide-white/5">
                      {untracked.map((p) => profileRow(p, mainPersonId))}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}

      <ConfirmModal
        isOpen={!!pending}
        onClose={() => { if (!busy) setPending(null); }}
        onConfirm={() => { pending?.run(); }}
        title={pending?.title || ''}
        description={pending?.description || ''}
        confirmText={pending?.confirmText}
        variant={pending?.variant || 'default'}
        isLoading={busy}
      />
    </Card>
  );
}
