'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import Link from 'next/link';
import {
  ChevronDownIcon, UserPlusIcon, ArrowUturnLeftIcon, SparklesIcon, EyeSlashIcon, EyeIcon,
  QuestionMarkCircleIcon, ArrowTopRightOnSquareIcon, ArrowsPointingInIcon,
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

function hexOf(p: Profile) {
  return p.color && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : null;
}

/** A profile's round mark in its Nuvio colour, at any size. */
function ProfileMark({ profile, size, ring }: { profile: Profile; size: number; ring?: string }) {
  const hex = hexOf(profile);
  const tracked = !!profile.ownerId;
  return (
    <span
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold ${tracked ? '' : 'opacity-40 grayscale'}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        ...(hex
          ? { background: `${hex}2e`, color: hex, boxShadow: `inset 0 0 0 ${size > 40 ? 2 : 1.5}px ${hex}66${ring ? `, 0 0 0 2px ${ring}` : ''}` }
          : { background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)', boxShadow: ring ? `0 0 0 2px ${ring}` : undefined }),
      }}
      aria-hidden
    >
      {profileName(profile).trim().charAt(0).toUpperCase()}
    </span>
  );
}

const MENU_ITEM = 'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-default rounded-lg hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors text-left';

const POPOVER_WIDTH = 232;

/** Where a profile's menu goes: just under its circle, or just above when there is no room below. */
interface Placement { left: number; arrowX: number; top?: number; bottom?: number; above: boolean }

function placeUnder(circle: DOMRect, menuHeight: number): Placement {
  const centre = circle.left + circle.width / 2;
  const left = Math.min(Math.max(8, centre - POPOVER_WIDTH / 2), window.innerWidth - POPOVER_WIDTH - 8);
  const arrowX = Math.min(Math.max(16, centre - left), POPOVER_WIDTH - 16);
  const above = window.innerHeight - circle.bottom < menuHeight + 24 && circle.top > menuHeight + 24;
  return above
    ? { left, arrowX, bottom: window.innerHeight - circle.top + 10, above }
    : { left, arrowX, top: circle.bottom + 10, above };
}

/**
 * The profiles on one Nuvio login, shown the way the app's own profile picker
 * shows them. Each tile says who that profile's viewing belongs to; picking
 * one opens what can be done with it right underneath. Only shown for a login
 * with more than one profile. The rules live in server/utils/nuvioProfiles.js.
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
  const [selected, setSelected] = useState<number | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => { setSelected(null); setPlacement(null); }, []);

  // The menu closes on a click elsewhere, Escape, a scroll or a resize - the
  // same as every other menu in the app.
  useEffect(() => {
    if (selected === null) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement)?.closest?.('[data-profile-tile]')) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
    };
  }, [selected, closeMenu]);

  const openMenu = (index: number, tile: HTMLElement) => {
    if (selected === index) { closeMenu(); return; }
    const circle = (tile.querySelector('[data-profile-circle]') as HTMLElement | null)?.getBoundingClientRect() || tile.getBoundingClientRect();
    setSelected(index);
    setPlacement(placeUnder(circle, 230));
  };
  const [open, setOpen] = useState(false);
  // Starts closed every time the page opens.
  const toggle = () => {
    setOpen((o) => !o);
    closeMenu();
  };

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
    closeMenu();
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
        title: `Merge ${donorName} back into ${to}?`,
        description: `${donorName}'s history (${titles({ movies: donor?.movies || 0, episodes: donor?.episodes || 0 })}) becomes part of ${to}'s again, and anything watched on the ${name} profile goes to ${to}. ${donorName} leaves the Users list - you can separate the profile again at any time.`,
        confirmText: 'Merge back',
        variant: 'warning',
        run: () => perform(() => api.setProfileOwner(userId, profile.index, target), `${name} merged back into ${to}`, true),
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
        title: `Separate ${name}?`,
        description: `${name} becomes its own person again - ${donor}, with everything they had before it was merged - and anything watched on it since then goes with them. You can merge it back any time.`,
        confirmText: 'Separate',
        run: () => perform(() => api.giveProfileOwnPerson(userId, profile.index), `${name} is separated`, true),
      });
      return;
    }
    const moving = profile.ownerId && profile.titles.movies + profile.titles.episodes > 0;
    setPending({
      title: `Separate ${name}?`,
      description: `${name} gets its own history: it joins the Users list as its own person${moving ? `, and the ${titles(profile.titles)} watched on it move there from ${nameOf(profile.ownerId)}` : ''}.${profile.usesPrimaryAddons ? '' : ' It also gets that profile\'s own addons to manage.'} You can merge it back any time.`,
      confirmText: 'Separate',
      run: () => perform(() => api.giveProfileOwnPerson(userId, profile.index), `${name} is separated`, true),
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

  // Nothing to choose between on a login with a single profile.
  if (!view || view.profiles.length < 2) return null;

  const mainPersonId = persons[0]?.id;
  const sel = view.profiles.find((p) => p.index === selected) || null;
  const selOwn = sel?.ownPersonId ? personById(sel.ownPersonId) : undefined;
  const selIsMain = !!selOwn && selOwn.id === mainPersonId;
  const selTargets = sel ? persons.filter((p) => p.id !== sel.ownerId && p.id !== sel.ownPersonId) : [];

  let selStatus = '';
  if (sel) {
    const n = sel.titles.movies + sel.titles.episodes;
    if (!sel.ownerId) selStatus = 'Not tracked';
    else if (selIsMain) selStatus = `${selOwn?.username}'s main profile · ${count(n)}`;
    else if (selOwn) selStatus = `Separated - its own person · ${count(n)}`;
    else selStatus = `Merged into ${nameOf(sel.ownerId)} · ${count(n)}`;
  }

  return (
    <Card padding="lg">
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex-1 min-w-0 flex items-center justify-between gap-4 text-left">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-default">
              Nuvio profiles{loginLabel ? <span className="text-muted font-normal"> · {loginLabel}</span> : null}
            </h3>
            <p className="text-xs text-muted mt-0.5">
              {open ? 'Every profile is merged into its person. Pick one to separate it, or merge it back' : `${view.profiles.length} profiles · ${persons.length} ${persons.length === 1 ? 'person' : 'people'}`}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!open && (
              <span className="flex items-center gap-1.5">
                {view.profiles.slice(0, 6).map((p) => <ProfileMark key={p.index} profile={p} size={26} />)}
              </span>
            )}
            <ChevronDownIcon className="w-5 h-5 text-muted transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
          </div>
        </button>
        {open && (
          <Link href="/guides/nuvio-profile-addons" className="text-muted hover:text-default transition-colors shrink-0" title="How profiles work" aria-label="How profiles work">
            <QuestionMarkCircleIcon className="w-5 h-5" />
          </Link>
        )}
      </div>

      {open && (
        <>
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
              const tracked = !!profile.ownerId;
              const owner = personById(profile.ownerId);
              const isSelected = profile.index === selected;
              const n = profile.titles.movies + profile.titles.episodes;
              let caption = count(n);
              if (profile.index !== 1) caption = profile.ownPersonId ? `Separated · ${caption}` : `Merged · ${caption}`;
              return (
                <button
                  key={profile.index}
                  type="button"
                  data-profile-tile
                  onClick={(e) => openMenu(profile.index, e.currentTarget)}
                  aria-haspopup="menu"
                  aria-expanded={isSelected}
                  className={`group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    isSelected ? 'bg-surface-hover ring-1 ring-primary/50' : 'hover:bg-surface-hover'
                  }`}
                >
                  <span data-profile-circle className="relative transition-transform group-hover:scale-105">
                    <ProfileMark profile={profile} size={64} />
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

          {sel && placement && typeof document !== 'undefined' && createPortal(
            <motion.div
              ref={popoverRef}
              role="menu"
              initial={{ opacity: 0, y: placement.above ? 4 : -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.12 }}
              className="fixed z-[9999] rounded-2xl border border-default bg-surface shadow-2xl backdrop-blur-xl p-1.5"
              style={{ left: placement.left, top: placement.top, bottom: placement.bottom, width: POPOVER_WIDTH, transformOrigin: `${placement.arrowX}px ${placement.above ? '100%' : '0%'}` }}
            >
              {/* The pointer to the circle it belongs to. */}
              <span
                aria-hidden
                className="absolute w-3 h-3 rotate-45 bg-surface border-default"
                style={{
                  left: placement.arrowX - 6,
                  ...(placement.above
                    ? { bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 }
                    : { top: -6, borderLeftWidth: 1, borderTopWidth: 1 }),
                }}
              />
              <div className="px-3 pt-2 pb-2 mb-1 border-b border-default">
                <p className="text-sm font-semibold text-default truncate">{profileName(sel)}</p>
                <p className="text-xs text-muted mt-0.5">{selStatus}</p>
              </div>
              {selIsMain && (
                <p className="px-3 py-2 text-xs text-subtle">The main profile always stays its own person.</p>
              )}
              {!selOwn && sel.merged && (
                <button autoFocus className={MENU_ITEM} onClick={() => { closeMenu(); makeOwnPerson(sel); }}>
                  <ArrowUturnLeftIcon className="w-4 h-4 text-muted" /> Separate
                </button>
              )}
              {!selOwn && !sel.merged && (
                <button autoFocus className={MENU_ITEM} onClick={() => { closeMenu(); makeOwnPerson(sel); }}>
                  <UserPlusIcon className="w-4 h-4 text-muted" /> Separate
                </button>
              )}
              {!selIsMain && selTargets.map((p) => (
                <button key={p.id} className={MENU_ITEM} onClick={() => { closeMenu(); mergeInto(sel, p.id); }}>
                  <ArrowsPointingInIcon className="w-4 h-4 text-muted" /> <span className="truncate">{sel.ownPersonId && p.id === mainPersonId ? `Merge back into ${p.username}` : `Merge into ${p.username}`}</span>
                </button>
              ))}
              {!selOwn && sel.ownerId && (
                <button className={MENU_ITEM} onClick={() => { closeMenu(); stopTracking(sel); }}>
                  <EyeSlashIcon className="w-4 h-4 text-muted" /> Stop tracking
                </button>
              )}
              {!selOwn && !sel.ownerId && (
                <button className={MENU_ITEM} onClick={() => perform(() => api.setProfileOwner(userId, sel.index, 'default'), `${profileName(sel)} is tracked again`)}>
                  <EyeIcon className="w-4 h-4 text-muted" /> Track it again
                </button>
              )}
              {(selOwn || sel.ownerId) && (
                <Link href={`/users/${selOwn?.id || sel.ownerId}`} className={MENU_ITEM} onClick={closeMenu}>
                  <ArrowTopRightOnSquareIcon className="w-4 h-4 text-muted" /> Open {selOwn?.username || nameOf(sel.ownerId)}
                </Link>
              )}
            </motion.div>,
            document.body,
          )}
        </>
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
