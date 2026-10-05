'use client';

// The household on one AIOStreams or AIOMetadata sign-in, as profiles - the
// Jellyfin counterpart of the Nuvio profiles card (components/user/
// ProfilesCard), and it looks and works the same way: collapsed until opened,
// one tile per profile, and picking one opens what can be done with it right
// underneath. The rules live in server/utils/jellyfinProfiles.js.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import Link from 'next/link';
import {
  ChevronDownIcon, UserPlusIcon, EyeSlashIcon, EyeIcon, KeyIcon,
  QuestionMarkCircleIcon, ArrowTopRightOnSquareIcon, ArrowsPointingInIcon, PlusIcon, LockClosedIcon,
} from '@heroicons/react/24/outline';
import { api, type HouseholdProfile } from '@/lib/api';
import { Badge, Button, Card, ConfirmModal, Modal } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { MENU_ITEM, POPOVER_WIDTH, placeUnder, type Placement } from '@/components/user/ProfilesCard';

interface PendingAction {
  title: string;
  description: string;
  confirmText: string;
  variant?: 'default' | 'warning' | 'danger';
  run: () => Promise<void>;
}

const STATUS_TEXT: Record<HouseholdProfile['status'], string> = {
  tracked: 'Tracked with this person',
  own: 'Separated - its own person',
  untracked: 'Not tracked',
  'needs-pin': 'Needs its PIN to be tracked',
  'needs-sign-in': 'Needs the password to be tracked',
};

function Mark({ profile, size }: { profile: HouseholdProfile; size: number }) {
  const dim = profile.status === 'untracked' || profile.status === 'needs-pin' || profile.status === 'needs-sign-in';
  return (
    <span
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold ${dim ? 'opacity-40 grayscale' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: 'linear-gradient(135deg, rgba(170, 92, 195, 0.25) 0%, rgba(0, 164, 220, 0.22) 100%)',
        color: 'rgb(167, 214, 240)',
        boxShadow: 'inset 0 0 0 1.5px rgba(0, 164, 220, 0.35)',
      }}
      aria-hidden
    >
      {profile.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function HouseholdCard({ userId, personName, kindLabel, onPeopleChanged, embedded = false, onProfilesChanged }: {
  /** The person whose sign-in the household was found on. */
  userId: string;
  personName: string;
  /** AIOStreams or AIOMetadata. */
  kindLabel: string;
  onPeopleChanged?: () => void;
  /** Inside HouseholdsCard: no card or collapse of its own, just this person's section. */
  embedded?: boolean;
  /** Told whenever this household's profiles change, so HouseholdsCard's summary keeps up. */
  onProfilesChanged?: (profiles: HouseholdProfile[]) => void;
}) {
  // What this browser last saw, so the card is there with the page instead of
  // popping in after it; the load below refreshes it in place.
  const [profiles, setProfiles] = useState<HouseholdProfile[] | null>(
    () => api.peekGet<{ profiles: HouseholdProfile[] }>(`/jellyfin/users/${encodeURIComponent(userId)}/household`)?.profiles ?? null
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [signingIn, setSigningIn] = useState<HouseholdProfile | null>(null);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  // Adding household users and changing PINs (server/utils/aioHousehold.js):
  // only for someone added with their AIOStreams configuration password.
  const [canManage, setCanManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newHistory, setNewHistory] = useState<'own' | 'shared'>('own');
  const [pinFor, setPinFor] = useState<HouseholdProfile | null>(null);
  const [changedPin, setChangedPin] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => { setSelected(null); setPlacement(null); }, []);

  const load = useCallback(async () => {
    try {
      const h = await api.getHousehold(userId);
      setProfiles(h.profiles);
      setCanManage(!!h.canManage);
    } catch {
      setProfiles(null);
    }
  }, [userId]);
  useEffect(() => { if (profiles) onProfilesChanged?.(profiles); }, [profiles, onProfilesChanged]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (selected === null) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement)?.closest?.('[data-household-tile]')) return;
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

  const openMenu = (id: string, tile: HTMLElement) => {
    if (selected === id) { closeMenu(); return; }
    const circle = (tile.querySelector('[data-household-circle]') as HTMLElement | null)?.getBoundingClientRect() || tile.getBoundingClientRect();
    setSelected(id);
    setPlacement(placeUnder(circle, 200));
  };

  const perform = async (action: () => Promise<{ profiles: HouseholdProfile[] }>, message: string, peopleChange = false) => {
    closeMenu();
    setBusy(true);
    try {
      const next = await action();
      setProfiles(next.profiles);
      toast.success(message);
      if (peopleChange) onPeopleChanged?.();
    } catch (e: any) {
      toast.error(e?.message || 'Could not change that');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const separate = (p: HouseholdProfile) => setPending({
    title: `Separate ${p.name}?`,
    description: `${p.name} becomes its own person on the Users list, with everything watched on the ${p.name} profile so far, and is read with its own sign-in from now on. You can merge it back any time.`,
    confirmText: 'Separate',
    run: () => perform(() => api.separateHouseholdProfile(p.id), `${p.name} is separated`, true),
  });

  const mergeBack = (p: HouseholdProfile) => setPending({
    title: `Merge ${p.person?.username || p.name} back into ${personName}?`,
    description: `Everything ${p.person?.username || p.name} recorded becomes part of ${personName}'s history again, labelled as the ${p.name} profile, and they leave the Users list. You can separate it again at any time.`,
    confirmText: 'Merge back',
    variant: 'warning',
    run: () => perform(() => api.mergeHouseholdProfileBack(p.id), `${p.name} merged back into ${personName}`, true),
  });

  const stopTracking = (p: HouseholdProfile) => setPending({
    title: `Stop tracking ${p.name}?`,
    description: `Nothing watched on ${p.name} is recorded from now on - no history, watch time or stats. What it has already recorded stays where it is.`,
    confirmText: 'Stop tracking',
    run: () => perform(() => api.trackHouseholdProfile(p.id, false), `${p.name} is no longer tracked`),
  });

  const submitSignIn = async () => {
    if (!signingIn) return;
    setBusy(true);
    try {
      const next = await api.signInHouseholdProfile(signingIn.id, { password, pin: pin.trim() || undefined });
      setProfiles(next.profiles);
      toast.success(`${signingIn.name} is tracked`);
      setSigningIn(null);
      setPassword('');
      setPin('');
    } catch (e: any) {
      toast.error(e?.message || 'Could not sign that profile in');
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = async () => {
    setBusy(true);
    try {
      const next = await api.addHouseholdUser(userId, { name: newName.trim(), pin: newPin.trim() || null, history: newHistory });
      setProfiles(next.profiles);
      toast.success(next.tracked ? `${newName.trim()} added and tracked` : `${newName.trim()} added - sign them in to track them`);
      setAdding(false);
      setNewName('');
      setNewPin('');
      setNewHistory('own');
    } catch (e: any) {
      toast.error(e?.message || 'Could not add them');
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (value: string | null) => {
    if (!pinFor) return;
    setBusy(true);
    try {
      const next = await api.setHouseholdPin(pinFor.id, value);
      setProfiles(next.profiles);
      toast.success(value ? `${pinFor.name}'s PIN changed` : `${pinFor.name} has no PIN now`);
      if (!next.tracked) toast.error(`Sign ${pinFor.name} in again to keep tracking them`);
      setPinFor(null);
      setChangedPin('');
    } catch (e: any) {
      toast.error(e?.message || 'Could not change the PIN');
    } finally {
      setBusy(false);
    }
  };

  if (!profiles || (profiles.length === 0 && !canManage)) return null;

  const sel = profiles.find((p) => p.id === selected) || null;
  const tracked = profiles.filter((p) => p.status === 'tracked').length;
  const isOpen = embedded || open;

  const body = (
    <>
      {embedded ? (
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <h4 className="text-sm font-semibold text-default truncate">{personName}</h4>
          <Badge variant={kindLabel === 'AIOMetadata' ? 'aiometadata' : 'aiostreams'} size="sm">{kindLabel}</Badge>
          <span className="text-xs text-muted">{profiles.length} {profiles.length === 1 ? 'profile' : 'profiles'} · {tracked} tracked with {personName}</span>
        </div>
      ) : (
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => { setOpen((o) => !o); closeMenu(); }} aria-expanded={open} className="flex-1 min-w-0 flex items-center justify-between gap-4 text-left">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-default">
              {kindLabel} household <span className="text-muted font-normal">· {personName}</span>
            </h3>
            <p className="text-xs text-muted mt-0.5">
              {open
                ? `Everyone else on ${personName}'s ${kindLabel} sign-in counts as ${personName} until you separate them`
                : `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'} · ${tracked} tracked with ${personName}`}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!open && (
              <span className="flex items-center gap-1.5">
                {profiles.slice(0, 6).map((p) => <Mark key={p.id} profile={p} size={26} />)}
              </span>
            )}
            <ChevronDownIcon className="w-5 h-5 text-muted transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
          </div>
        </button>
        {open && (
          <Link href="/guides/add-jellyfin-account" className="text-muted hover:text-default transition-colors shrink-0" title="How households work" aria-label="How households work">
            <QuestionMarkCircleIcon className="w-5 h-5" />
          </Link>
        )}
      </div>
      )}

      {isOpen && (
        <div className={`${embedded ? 'mt-3' : 'mt-5'} grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2`}>
          {profiles.map((p) => {
            const isSelected = p.id === selected;
            const caption = p.status === 'own' ? (p.person?.username || 'Its own person')
              : p.status === 'tracked' ? `With ${personName}`
              : p.status === 'untracked' ? 'Not tracked'
              : p.status === 'needs-pin' ? 'Needs its PIN' : 'Needs the password';
            return (
              <button
                key={p.id}
                type="button"
                data-household-tile
                onClick={(e) => openMenu(p.id, e.currentTarget)}
                aria-haspopup="menu"
                aria-expanded={isSelected}
                className={`group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  isSelected ? 'bg-surface-hover ring-1 ring-primary/50' : 'hover:bg-surface-hover'
                }`}
              >
                <span data-household-circle className="relative transition-transform group-hover:scale-105">
                  <Mark profile={p} size={64} />
                  {p.status === 'untracked' && (
                    <span className="absolute inset-0 flex items-center justify-center"><EyeSlashIcon className="w-6 h-6 text-muted" /></span>
                  )}
                  {(p.status === 'needs-pin' || p.status === 'needs-sign-in') && (
                    <span className="absolute inset-0 flex items-center justify-center"><KeyIcon className="w-6 h-6 text-muted" /></span>
                  )}
                </span>
                <span className="text-sm font-medium max-w-full truncate text-default">{p.name}</span>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-surface-hover text-[11px] text-muted max-w-full truncate">{caption}</span>
              </button>
            );
          })}
          {canManage && (
            <button
              type="button"
              onClick={() => { closeMenu(); setAdding(true); }}
              className="group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="w-16 h-16 rounded-full flex items-center justify-center border-2 border-dashed border-default text-muted group-hover:text-default transition-colors">
                <PlusIcon className="w-6 h-6" />
              </span>
              <span className="text-sm font-medium text-default">Add</span>
              <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-surface-hover text-[11px] text-muted">Household user</span>
            </button>
          )}
        </div>
      )}

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
          <span
            aria-hidden
            className="absolute w-3 h-3 rotate-45 bg-surface border-default"
            style={{
              left: placement.arrowX - 6,
              ...(placement.above ? { bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 } : { top: -6, borderLeftWidth: 1, borderTopWidth: 1 }),
            }}
          />
          <div className="px-3 pt-2 pb-2 mb-1 border-b border-default">
            <p className="text-sm font-semibold text-default truncate">{sel.name}</p>
            <p className="text-xs text-muted mt-0.5">{STATUS_TEXT[sel.status]}</p>
          </div>
          {sel.status === 'tracked' && (
            <button autoFocus className={MENU_ITEM} onClick={() => { closeMenu(); separate(sel); }}>
              <UserPlusIcon className="w-4 h-4 text-muted" /> Separate
            </button>
          )}
          {sel.status === 'own' && (
            <button autoFocus className={MENU_ITEM} onClick={() => { closeMenu(); mergeBack(sel); }}>
              <ArrowsPointingInIcon className="w-4 h-4 text-muted" /> <span className="truncate">Merge back into {personName}</span>
            </button>
          )}
          {sel.status === 'tracked' && (
            <button className={MENU_ITEM} onClick={() => { closeMenu(); stopTracking(sel); }}>
              <EyeSlashIcon className="w-4 h-4 text-muted" /> Stop tracking
            </button>
          )}
          {sel.status === 'untracked' && (
            <button autoFocus className={MENU_ITEM} onClick={() => perform(() => api.trackHouseholdProfile(sel.id, true), `${sel.name} is tracked again`)}>
              <EyeIcon className="w-4 h-4 text-muted" /> Track it again
            </button>
          )}
          {(sel.status === 'needs-pin' || sel.status === 'needs-sign-in') && (
            <button autoFocus className={MENU_ITEM} onClick={() => { closeMenu(); setSigningIn(sel); }}>
              <KeyIcon className="w-4 h-4 text-muted" /> Sign in
            </button>
          )}
          {canManage && (
            <button className={MENU_ITEM} onClick={() => { closeMenu(); setPinFor(sel); }}>
              <LockClosedIcon className="w-4 h-4 text-muted" /> Change PIN
            </button>
          )}
          {sel.status === 'own' && sel.person && (
            <Link href={`/users/${sel.person.id}`} className={MENU_ITEM} onClick={closeMenu}>
              <ArrowTopRightOnSquareIcon className="w-4 h-4 text-muted" /> Open {sel.person.username}
            </Link>
          )}
        </motion.div>,
        document.body,
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

      <Modal isOpen={adding} onClose={() => { if (!busy) setAdding(false); }} title={`Add someone to ${personName}'s AIOStreams`}>
        <form onSubmit={(e) => { e.preventDefault(); submitAdd(); }} className="space-y-4">
          <p className="text-sm text-muted">They show up in every AIOStreams and Jellyfin app signed in to this configuration, and are tracked here with {personName} straight away.</p>
          <div>
            <label htmlFor="household-new-name" className="block text-sm font-medium mb-2 text-default">Name</label>
            <input id="household-new-name" value={newName} maxLength={32} onChange={(e) => setNewName(e.target.value)}
              className="w-full px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }} />
          </div>
          <div>
            <label htmlFor="household-new-pin" className="block text-sm font-medium mb-2 text-default">PIN <span className="text-muted font-normal">(optional, 4 to 12 digits)</span></label>
            <input id="household-new-pin" type="password" inputMode="numeric" autoComplete="new-password" value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              className="w-full px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-default">History</p>
            {([['own', 'Their own', 'Their own Continue Watching and watched marks, and their own trackers.'], ['shared', `Shared with ${personName}`, `One history with ${personName}, using ${personName}'s trackers.`]] as const).map(([value, label, hint]) => (
              <label key={value} className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" name="household-history" className="mt-1" aria-label={label} checked={newHistory === value} onChange={() => setNewHistory(value)} />
                <span><span className="text-default">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
              </label>
            ))}
          </div>
          <div className="flex gap-3 justify-end">
            <Button variant="secondary" type="button" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" isLoading={busy} disabled={!newName.trim()}>Add</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!pinFor} onClose={() => { if (!busy) setPinFor(null); }} title={pinFor ? `${pinFor.name}'s PIN` : ''}>
        <form onSubmit={(e) => { e.preventDefault(); submitPin(changedPin.trim()); }} className="space-y-4">
          <p className="text-sm text-muted">The new PIN works in every app straight away. SlickSync signs {pinFor?.name} in once with it to keep tracking them.</p>
          <div>
            <label htmlFor="household-change-pin" className="block text-sm font-medium mb-2 text-default">New PIN <span className="text-muted font-normal">(4 to 12 digits)</span></label>
            <input id="household-change-pin" type="password" inputMode="numeric" autoComplete="new-password" value={changedPin} onChange={(e) => setChangedPin(e.target.value.replace(/\D/g, ''))}
              className="w-full px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }} />
          </div>
          <div className="flex gap-3 justify-between flex-wrap">
            <Button variant="ghost" type="button" onClick={() => submitPin(null)} disabled={busy}>Remove the PIN</Button>
            <div className="flex gap-3">
              <Button variant="secondary" type="button" onClick={() => setPinFor(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" type="submit" isLoading={busy} disabled={changedPin.trim().length < 4}>Change PIN</Button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!signingIn} onClose={() => { if (!busy) setSigningIn(null); }} title={signingIn ? `Sign in ${signingIn.name}` : ''}>
        <form onSubmit={(e) => { e.preventDefault(); submitSignIn(); }} className="space-y-4">
          <p className="text-sm text-muted">
            {signingIn?.status === 'needs-pin'
              ? `${signingIn?.name} has a PIN. Enter the configuration password and their PIN once, and SlickSync keeps a sign-in for them - neither is stored.`
              : `Enter the configuration password once, and SlickSync keeps a sign-in for ${signingIn?.name} - the password is not stored.`}
          </p>
          <div>
            <label htmlFor="household-password" className="block text-sm font-medium mb-2 text-default">Configuration password</label>
            <input id="household-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }} />
          </div>
          {signingIn?.status === 'needs-pin' && (
            <div>
              <label htmlFor="household-pin" className="block text-sm font-medium mb-2 text-default">{signingIn.name}&apos;s PIN</label>
              <input id="household-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)}
                className="w-full px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }} />
            </div>
          )}
          <div className="flex gap-3 justify-end">
            <Button variant="secondary" type="button" onClick={() => setSigningIn(null)} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" isLoading={busy}>Sign in</Button>
          </div>
        </form>
      </Modal>
    </>
  );

  return embedded ? <div>{body}</div> : <Card padding="lg">{body}</Card>;
}

/**
 * Everyone's AIOStreams and AIOMetadata household profiles in one card, the
 * way "Nuvio profiles" is one card: collapsed by default, each person's
 * household its own section inside. Shows only when someone has a household.
 */
export function HouseholdsCard({ owners, onPeopleChanged }: {
  owners: { id: string; name: string; kindLabel: string }[];
  onPeopleChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [manageable, setManageable] = useState<Record<string, boolean>>({});
  const [byOwner, setByOwner] = useState<Record<string, HouseholdProfile[]>>(() => Object.fromEntries(
    owners.map((o) => [o.id, api.peekGet<{ profiles: HouseholdProfile[] }>(`/jellyfin/users/${encodeURIComponent(o.id)}/household`)?.profiles ?? []])
  ));
  const ownerKey = owners.map((o) => o.id).join(',');
  useEffect(() => {
    let live = true;
    Promise.all(owners.map((o) => api.getHousehold(o.id).then((h) => [o.id, h.profiles || [], !!h.canManage] as const).catch(() => [o.id, [] as HouseholdProfile[], false] as const)))
      .then((rows) => {
        if (!live) return;
        setByOwner(Object.fromEntries(rows.map(([id, profiles]) => [id, profiles])));
        setManageable(Object.fromEntries(rows.map(([id, , can]) => [id, can])));
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);
  const update = useCallback((id: string, profiles: HouseholdProfile[]) => {
    setByOwner((prev) => (prev[id] === profiles ? prev : { ...prev, [id]: profiles }));
  }, []);

  const withHousehold = owners.filter((o) => (byOwner[o.id] || []).length > 0 || manageable[o.id]);
  if (withHousehold.length === 0) return null;
  const all = withHousehold.flatMap((o) => byOwner[o.id]);

  return (
    <Card padding="lg">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex-1 min-w-0 flex items-center justify-between gap-4 text-left">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-default">AIOStreams &amp; AIOMetadata profiles</h3>
            <p className="text-xs text-muted mt-0.5 truncate">
              {open
                ? 'Everyone else on an AIOStreams or AIOMetadata sign-in counts as that person until you separate them'
                : `${all.length} ${all.length === 1 ? 'profile' : 'profiles'} · ${withHousehold.length === 1 ? withHousehold[0].name : `${withHousehold.length} people`}`}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!open && (
              <span className="flex items-center gap-1.5">
                {all.slice(0, 6).map((p) => <Mark key={p.id} profile={p} size={26} />)}
              </span>
            )}
            <ChevronDownIcon className="w-5 h-5 text-muted transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
          </div>
        </button>
        {open && (
          <Link href="/guides/add-jellyfin-account" className="text-muted hover:text-default transition-colors shrink-0" title="How households work" aria-label="How households work">
            <QuestionMarkCircleIcon className="w-5 h-5" />
          </Link>
        )}
      </div>
      {open && (
        <div className="mt-5 space-y-6">
          {withHousehold.map((o) => (
            <HouseholdCard
              key={o.id}
              embedded
              userId={o.id}
              personName={o.name}
              kindLabel={o.kindLabel}
              onPeopleChanged={onPeopleChanged}
              onProfilesChanged={(p) => update(o.id, p)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
