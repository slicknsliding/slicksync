'use client';

// A Nuvio login can be several people in SlickSync (its profiles). For a
// member signed in with Nuvio who has more than one, their avatar on Home is a
// button that opens a popup beside it: one whole tile per profile, tap one to
// move to it with no sign-out. Nothing opens by itself - not on sign-in, not on
// load. A profile whose login SlickSync no longer holds is greyed out with
// "Needs reconnecting" and cannot be chosen. Stremio, Jellyfin and AIOStreams
// people have no profiles, so for them this is just their avatar.

import { useEffect, useRef, useState } from 'react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/24/solid';
import { Avatar } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import { useUserAuth } from '@/lib/hooks/useUserAuth';
import { userNuvioProfiles, type NuvioProfileTile } from '@/lib/user-api';

const EMPTY: NuvioProfileTile[] = [];

export function ProfileAvatar({ className }: { className?: string }) {
  const { userId, authKey, provider, userInfo } = useUserAuth();
  // Kept with the person they were read for: after a switch the list is read again, and the popup is shut.
  const [listed, setListed] = useState<{ forUser: string; profiles: NuvioProfileTile[] } | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const profiles = provider === 'nuvio' && listed && listed.forUser === userId ? listed.profiles : EMPTY;
  const open = openFor !== null && openFor === userId;
  const setOpen = (next: boolean | ((cur: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    setOpenFor(value ? userId : null);
  };
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Only a Nuvio sign-in has profiles; looked up once so the avatar knows
  // whether it is a button.
  useEffect(() => {
    if (provider !== 'nuvio' || !userId || !authKey) return;
    let stale = false;
    userNuvioProfiles.list(userId, authKey)
      .then((r) => { if (!stale) setListed({ forUser: userId, profiles: r.profiles }); })
      .catch(() => {});
    return () => { stale = true; };
  }, [provider, userId, authKey]);

  const avatar = (
    <Avatar
      name={userInfo?.username || 'User'}
      email={userInfo?.email}
      src={userInfo?.avatarUrl || undefined}
      useGravatar={userInfo?.useGravatar}
      colorIndex={userInfo?.colorIndex || 0}
      size="xl"
      showRing
      className={className}
    />
  );

  if (profiles.length < 2) return avatar;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Switch profile"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative shrink-0 rounded-full"
      >
        {avatar}
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 w-6 h-6 rounded-full flex items-center justify-center border-2"
          style={{ background: 'var(--color-primary)', borderColor: 'var(--color-bg)' }}
        >
          <ChevronUpDownIcon className="w-3.5 h-3.5 text-white" />
        </span>
      </button>
      {open && <ProfilePopup anchorRef={buttonRef} profiles={profiles} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProfilePopup({ anchorRef, profiles, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  profiles: NuvioProfileTile[];
  onClose: () => void;
}) {
  const { userId, authKey, userInfo, switchNuvioProfile } = useUserAuth();
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (tile: NuvioProfileTile) => {
    if (!userId || !authKey || busy || tile.current || tile.needsReconnect) return;
    setBusy(tile.id);
    try {
      const r = await userNuvioProfiles.switchTo(userId, authKey, tile.id);
      await switchNuvioProfile(r.userId, r.sessionToken, r.user);
      toast.success(`Switched to ${tile.name}`);
      onClose();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not switch profiles');
      setBusy(null);
    }
  };

  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={onClose} title="Switch profile" width={320}>
      {userInfo?.email && (
        <p className="text-xs -mt-1 mb-2 truncate" style={{ color: 'var(--color-text-muted)' }}>{userInfo.email}</p>
      )}
      <ul className="space-y-2">
        {profiles.map((tile) => {
          const unavailable = tile.needsReconnect;
          return (
            <li key={tile.id}>
              <button
                type="button"
                onClick={() => choose(tile)}
                disabled={tile.current || unavailable || !!busy}
                aria-current={tile.current || undefined}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-left transition-colors ${tile.current ? 'border-[var(--color-primary)]' : 'border-default'} ${unavailable ? 'opacity-55' : tile.current ? '' : 'hover:bg-surface-hover'}`}
                style={{ background: 'var(--color-surface-elevated)', filter: unavailable ? 'grayscale(1)' : undefined, cursor: unavailable ? 'not-allowed' : undefined }}
              >
                <Avatar name={tile.name} src={tile.avatarUrl || undefined} colorIndex={tile.colorIndex} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{tile.name}</span>
                  <span className="block text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {tile.current ? 'Current' : unavailable ? 'Needs reconnecting' : busy === tile.id ? 'Switching...' : `Profile ${tile.profileNumber}`}
                  </span>
                </span>
                {tile.current && <CheckIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />}
              </button>
            </li>
          );
        })}
      </ul>
    </AnchoredPopup>
  );
}
