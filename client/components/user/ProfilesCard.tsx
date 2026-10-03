'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  UserPlusIcon, ArrowUturnLeftIcon, SparklesIcon, EyeSlashIcon, EyeIcon, ArrowsPointingInIcon,
  QuestionMarkCircleIcon, ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { api, type ProfilesView } from '@/lib/api';
import { Button, Card, ConfirmModal, UserAvatar, ContextMenu, useContextMenu } from '@/components/ui';
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

function hexOf(p: Profile) {
  return p.color && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : null;
}

const MENU_ITEM = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors text-left';

/**
 * The profiles on one Nuvio login, shown the way the app's own profile picker
 * shows them. Each tile says who that profile's viewing belongs to; tapping
 * it offers what can be done with it. Only shown for a login with more than
 * one profile. The rules live in server/utils/nuvioProfiles.js.
 */
export function ProfilesCard({ userId, loginLabel, onPeopleChanged }: {
  /** Any person on the Nuvio login - normally its main profile's person. */
  userId: string;
  /** Shown when the account has more than one Nuvio login, to tell them apart. */
  loginLabel?: string | null;
  /** People were added, merged away or brought back. */
  onPeopleChanged?: () => void;
}) {
  const [view, setView] = useState<ProfilesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [menuFor, setMenuFor] = useState<Profile | null>(null);
  const menu = useContextMenu();

  const load = useCallback(async () => {
    try {
      setView(await api.getProfiles(userId));
    } catch {
      // A profile list Nuvio cannot give right now just leaves this out.
      setView(null);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

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
    const name = profileName(profile);
    const to = nameOf(target);
    if (profile.ownPersonId) {
      const donor = personById(profile.ownPersonId);
      const donorName = donor?.username || name;
      setPending({
        title: `Merge ${donorName} into ${to}?`,
        description: `Use this when they are the same person. ${donorName}'s history (${titles({ movies: donor?.movies || 0, episodes: donor?.episodes || 0 })}) becomes part of ${to}'s, and anything watched on the ${name} profile from now on goes to ${to}. ${donorName} leaves the Users list - you can separate them again at any time.`,
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

  const openMenu = (profile: Profile, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuFor(profile);
    // Under the tile, or above it when the tile sits near the bottom.
    const roomBelow = window.innerHeight - rect.bottom;
    const y = roomBelow > 240 ? rect.bottom + 6 : Math.max(8, rect.top - 230);
    menu.handleContextMenu(e, rect.left + rect.width / 2 - 100, y);
  };

  const closeMenu = () => { menu.close(); setMenuFor(null); };
  const act = (fn: () => void) => { closeMenu(); fn(); };

  // Nothing to choose between on a login with a single profile.
  if (!view || view.profiles.length < 2) return null;

  const mainPersonId = persons[0]?.id;
  const m = menuFor;
  const mOwn = m?.ownPersonId ? personById(m.ownPersonId) : undefined;
  const mIsMain = !!mOwn && mOwn.id === mainPersonId;
  const mTargets = m ? persons.filter((p) => p.id !== m.ownerId && p.id !== m.ownPersonId) : [];

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-default">
            Nuvio profiles{loginLabel ? <span className="text-muted font-normal"> · {loginLabel}</span> : null}
          </h3>
          <p className="text-xs text-muted mt-0.5">Tap a profile to choose who it belongs to</p>
        </div>
        <Link href="/guides/nuvio-profile-addons" className="text-muted hover:text-default transition-colors" title="How profiles work" aria-label="How profiles work">
          <QuestionMarkCircleIcon className="w-5 h-5" />
        </Link>
      </div>

      {view.misplaced && (
        <div className="mt-4 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap bg-warning-muted">
          <div className="flex items-center gap-2 min-w-0">
            <SparklesIcon className="w-4 h-4 text-warning shrink-0" />
            <p className="text-sm text-default">
              {view.misplaced.titles} title{view.misplaced.titles === 1 ? ' is' : 's are'} on the wrong person from an older version.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={tidy} disabled={busy}>Put it right</Button>
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {view.profiles.map((profile) => {
          const hex = hexOf(profile);
          const tracked = !!profile.ownerId;
          const owner = personById(profile.ownerId);
          const n = profile.titles.movies + profile.titles.episodes;
          let caption = count(n);
          if (profile.merged) caption = `Merged · ${caption}`;
          else if (profile.ownPersonId && profile.index !== 1) caption = `Own person · ${caption}`;
          return (
            <button
              key={profile.index}
              type="button"
              onClick={(e) => openMenu(profile, e)}
              disabled={busy}
              className="group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
            >
              <span className="relative">
                <span
                  className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl font-semibold transition-transform group-hover:scale-105 ${tracked ? '' : 'opacity-40 grayscale'}`}
                  style={hex
                    ? { background: `${hex}2e`, color: hex, boxShadow: `inset 0 0 0 2px ${hex}66` }
                    : { background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}
                >
                  {profileName(profile).trim().charAt(0).toUpperCase()}
                </span>
                {profile.index === 1 && (
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-primary text-white">
                    Main
                  </span>
                )}
                {!tracked && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <EyeSlashIcon className="w-6 h-6 text-muted" />
                  </span>
                )}
              </span>
              <span className={`text-sm font-medium max-w-full truncate ${tracked ? 'text-default' : 'text-muted'}`}>{profileName(profile)}</span>
              {tracked && owner ? (
                <span className="inline-flex items-center gap-1.5 max-w-full rounded-full pl-0.5 pr-2 py-0.5 bg-surface-hover">
                  <UserAvatar userId={owner.id} name={owner.username} email={owner.email || undefined} src={owner.avatarUrl || undefined} colorIndex={owner.colorIndex} size="xs" />
                  <span className="text-[11px] text-default truncate">{owner.username}</span>
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-surface-hover text-[11px] text-muted">Not tracked</span>
              )}
              {tracked && <span className="text-[11px] text-subtle">{caption}</span>}
            </button>
          );
        })}
      </div>

      <ContextMenu isOpen={menu.isOpen && !!m} position={menu.position} onClose={closeMenu}>
        {m && (
          <div className="w-[200px]">
            <p className="px-3 pt-1 pb-2 text-xs text-muted truncate">{profileName(m)}</p>
            {mIsMain && (
              <p className="px-3 pb-2 text-xs text-subtle">The main profile always stays its own person.</p>
            )}
            {!mOwn && m.merged && (
              <button className={MENU_ITEM} onClick={() => act(() => makeOwnPerson(m))}>
                <ArrowUturnLeftIcon className="w-4 h-4" /> Separate {m.merged.donorUsername} again
              </button>
            )}
            {!mOwn && !m.merged && (
              <button className={MENU_ITEM} onClick={() => act(() => makeOwnPerson(m))}>
                <UserPlusIcon className="w-4 h-4" /> Make it its own person
              </button>
            )}
            {!mIsMain && mTargets.map((p) => (
              <button key={p.id} className={MENU_ITEM} onClick={() => act(() => mergeInto(m, p.id))}>
                <ArrowsPointingInIcon className="w-4 h-4" /> <span className="truncate">Merge into {p.username}</span>
              </button>
            ))}
            {!mOwn && m.ownerId && (
              <button className={MENU_ITEM} onClick={() => act(() => stopTracking(m))}>
                <EyeSlashIcon className="w-4 h-4" /> Stop tracking
              </button>
            )}
            {!mOwn && !m.ownerId && (
              <button className={MENU_ITEM} onClick={() => act(() => perform(() => api.setProfileOwner(userId, m.index, 'default'), `${profileName(m)} is tracked again`))}>
                <EyeIcon className="w-4 h-4" /> Track it again
              </button>
            )}
            {(mOwn || m.ownerId) && (
              <Link href={`/users/${mOwn?.id || m.ownerId}`} className={MENU_ITEM} onClick={closeMenu}>
                <ArrowTopRightOnSquareIcon className="w-4 h-4" /> Open {mOwn?.username || nameOf(m.ownerId)}
              </Link>
            )}
          </div>
        )}
      </ContextMenu>

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
