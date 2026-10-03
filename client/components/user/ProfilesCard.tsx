'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDownIcon, UsersIcon, UserPlusIcon, ArrowUturnLeftIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { api, type ProfilesView } from '@/lib/api';
import { Button, Card, ConfirmModal } from '@/components/ui';
import { toast } from '@/components/ui/Toast';

type Profile = ProfilesView['profiles'][number];

interface PendingAction {
  title: string;
  description: string;
  confirmText: string;
  variant?: 'default' | 'warning' | 'danger';
  run: () => Promise<void>;
}

function titles(t: { movies: number; episodes: number }) {
  const n = t.movies + t.episodes;
  return n === 1 ? '1 title' : `${n} titles`;
}

function profileName(p: Profile) {
  return p.name || `Profile ${p.index}`;
}

/** A Nuvio profile's own colour, as the app shows it. */
function ProfileMark({ profile }: { profile: Profile }) {
  const hex = profile.color && /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : null;
  return (
    <span
      className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-sm font-semibold"
      style={hex
        ? { background: `${hex}33`, color: hex, boxShadow: `inset 0 0 0 1px ${hex}55` }
        : { background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}
      aria-hidden
    >
      {profileName(profile).trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Whose viewing each profile on a Nuvio account is. A profile counts for a
 * person on the same account or for nobody; it can have a person of its own,
 * be merged into someone else's history, and be separated again. The rules
 * live in server/utils/nuvioProfiles.js.
 */
export function ProfilesCard({ userId, onPersonRemoved }: { userId: string; onPersonRemoved?: (nextUserId: string) => void }) {
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
  const nameOf = (id: string | null) => persons.find((p) => p.id === id)?.username || 'someone';

  const perform = async (action: () => Promise<ProfilesView>, message: string, after?: (next: ProfilesView) => void) => {
    setBusy(true);
    try {
      const next = await action();
      setView(next);
      toast.success(message);
      after?.(next);
    } catch (e: any) {
      toast.error(e?.message || 'Could not change that');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const changeOwner = (profile: Profile, target: string) => {
    const current = profile.ownerId ?? 'skip';
    if (target === current) return;
    const name = profileName(profile);

    if (profile.ownPersonId) {
      const donor = nameOf(profile.ownPersonId);
      const survivor = nameOf(target);
      setPending({
        title: `Merge ${donor} into ${survivor}?`,
        description: `${donor}'s history (${titles({ movies: persons.find((p) => p.id === profile.ownPersonId)?.movies || 0, episodes: persons.find((p) => p.id === profile.ownPersonId)?.episodes || 0 })}) moves to ${survivor}, and the ${name} profile counts for ${survivor} from now on. ${donor} leaves the Users list - you can separate them again from here at any time.`,
        confirmText: 'Merge',
        variant: 'warning',
        run: () => perform(
          () => api.setProfileOwner(userId, profile.index, target),
          `${donor} merged into ${survivor}`,
          (next) => { if (next.removedUserId === userId) onPersonRemoved?.(target); },
        ),
      });
      return;
    }

    if (target === 'skip') {
      setPending({
        title: `Stop counting ${name}?`,
        description: `Nothing new from ${name} is recorded for anyone - not in history, watch time or stats. What it has already recorded stays where it is.`,
        confirmText: 'Stop counting',
        run: () => perform(() => api.setProfileOwner(userId, profile.index, 'skip'), `${name} is no longer counted`),
      });
      return;
    }

    const to = nameOf(target);
    const hasHistory = profile.ownerId && profile.titles.movies + profile.titles.episodes > 0;
    setPending({
      title: profile.ownerId ? `Move ${name} to ${to}?` : `Count ${name} for ${to}?`,
      description: hasHistory
        ? `${name}'s history (${titles(profile.titles)}) moves from ${nameOf(profile.ownerId)} to ${to}, and its viewing counts for ${to} from now on.`
        : `${name}'s viewing counts for ${to} from now on.`,
      confirmText: profile.ownerId ? 'Move' : 'Count it',
      run: () => perform(() => api.setProfileOwner(userId, profile.index, target), `${name} now counts for ${to}`),
    });
  };

  const giveOwnPerson = (profile: Profile) => {
    const name = profileName(profile);
    if (profile.merged) {
      const donor = profile.merged.donorUsername;
      setPending({
        title: `Separate ${donor} again?`,
        description: `${donor} comes back with everything they had before the merge, and anything watched on ${name} since then goes with them.`,
        confirmText: 'Separate',
        run: () => perform(() => api.giveProfileOwnPerson(userId, profile.index), `${donor} is back`),
      });
      return;
    }
    const moving = profile.ownerId && profile.titles.movies + profile.titles.episodes > 0;
    setPending({
      title: `Give ${name} its own person?`,
      description: `A new person called ${name} joins the Users list${moving ? `, and ${name}'s history (${titles(profile.titles)}) moves to them from ${nameOf(profile.ownerId)}` : ''}.${profile.usesPrimaryAddons ? '' : ' They also manage that profile\'s own addons.'}`,
      confirmText: 'Add person',
      run: () => perform(() => api.giveProfileOwnPerson(userId, profile.index), `${name} has its own person now`),
    });
  };

  const tidy = () => {
    setPending({
      title: 'Put this history right?',
      description: `An older version recorded every profile on everyone on this Nuvio account. ${view?.misplaced?.titles || 0} titles go to the person whose profile they were watched on; copies the right person already has are removed.`,
      confirmText: 'Put it right',
      run: () => perform(() => api.tidyProfiles(userId), 'History put right'),
    });
  };

  const summary = view
    ? `${view.profiles.length} profile${view.profiles.length === 1 ? '' : 's'} · ${persons.length} ${persons.length === 1 ? 'person' : 'people'}`
    : 'Whose viewing each profile on this Nuvio account is';

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
            <h3 className="text-lg font-semibold text-default mb-0.5">Profiles</h3>
            <p className="text-sm text-muted">{open ? 'Whose viewing each profile on this Nuvio account is' : summary}</p>
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

              <div className="flex flex-col gap-2">
                {view.profiles.map((profile) => {
                  const name = profileName(profile);
                  const value = profile.ownerId ?? 'skip';
                  const ownName = profile.ownPersonId ? nameOf(profile.ownPersonId) : null;
                  let detail: string;
                  if (profile.ownPersonId) {
                    detail = `Its own person${ownName && ownName !== name ? ` (${ownName})` : ''} · ${titles(profile.titles)}`;
                    if (profile.index > 1) detail += profile.usesPrimaryAddons ? " · uses the main profile's addons" : ' · has its own addons';
                  } else if (profile.skipped || !profile.ownerId) {
                    detail = 'Not counted · nothing new is recorded';
                  } else if (profile.merged) {
                    detail = `${profile.merged.donorUsername} was merged into ${nameOf(profile.ownerId)} · ${titles(profile.titles)}`;
                  } else {
                    detail = `Counts for ${nameOf(profile.ownerId)} · ${titles(profile.titles)}`;
                  }

                  return (
                    <div key={profile.index} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-3 min-w-0">
                          <ProfileMark profile={profile} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-default truncate">{name}</p>
                              {profile.index === 1 && (
                                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-hover text-muted">Main</span>
                              )}
                            </div>
                            <p className={`text-xs ${profile.skipped || !profile.ownerId ? 'text-warning' : 'text-subtle'}`}>{detail}</p>
                          </div>
                        </div>

                        <label className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted">Counts for</span>
                          <select
                            className="text-sm rounded-lg pl-3 pr-8 py-1.5 border appearance-none cursor-pointer focus:outline-none focus:border-primary disabled:opacity-60 bg-no-repeat bg-[length:1rem] bg-[right_0.5rem_center] bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20fill=%22none%22%20viewBox=%220%200%2024%2024%22%20stroke=%22%2394a3b8%22%3E%3Cpath%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%20stroke-width=%222%22%20d=%22M19%209l-7%207-7-7%22/%3E%3C/svg%3E')]"
                            style={{ borderColor: 'var(--color-surface-border)', backgroundColor: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                            value={value}
                            disabled={busy || (!!profile.ownPersonId && profile.index === 1)}
                            onChange={(e) => changeOwner(profile, e.target.value)}
                            aria-label={`Who ${name} counts for`}
                          >
                            {persons.map((p) => (
                              <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--color-surface)' }}>
                                {p.username}
                              </option>
                            ))}
                            <option value="skip" disabled={!!profile.ownPersonId} style={{ backgroundColor: 'var(--color-surface)' }}>
                              Nobody - don&apos;t count it
                            </option>
                          </select>
                        </label>
                      </div>

                      {(!profile.ownPersonId || profile.ownPersonId !== userId) && (
                        <div className="mt-2 pl-12 flex items-center gap-3 flex-wrap">
                          {!profile.ownPersonId && profile.merged && (
                            <Button variant="ghost" size="sm" leftIcon={<ArrowUturnLeftIcon className="w-4 h-4" />} onClick={() => giveOwnPerson(profile)} disabled={busy}>
                              Separate {profile.merged.donorUsername} again
                            </Button>
                          )}
                          {!profile.ownPersonId && !profile.merged && (
                            <Button variant="ghost" size="sm" leftIcon={<UserPlusIcon className="w-4 h-4" />} onClick={() => giveOwnPerson(profile)} disabled={busy}>
                              Give it its own person
                            </Button>
                          )}
                          {profile.ownPersonId && profile.ownPersonId !== userId && (
                            <Link href={`/users/${profile.ownPersonId}`} className="text-xs text-primary hover:underline">
                              Open {ownName}
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted">
                Moving a profile takes the history it already recorded with it. A profile with its own person is merged into whoever you pick, and can be separated again here.
              </p>
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
