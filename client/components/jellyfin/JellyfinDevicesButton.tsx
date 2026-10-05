'use client';

// "Devices": what is signed in as this person on their Jellyfin server, with
// Sign out next to each - an old TV, one at a friend's. Real Jellyfin servers
// only (AIOStreams and AIOMetadata keep no such list), and it needs an
// administrator's sign-in on that server (server/utils/jellyfinDevices.js).
// The same anchored popup as SignInTvButton beside it.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DevicePhoneMobileIcon } from '@heroicons/react/24/outline';
import { ActionPill } from '@/components/user/ActionPill';
import { toast } from '@/components/ui/Toast';
import { api, type JellyfinDevice } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

function ago(iso: string | null) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 2) return 'active now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function JellyfinDevicesButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [state, setState] = useState<{ needsAdmin: boolean; devices: JellyfinDevice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const open = !!anchor;
  const close = () => setAnchor(null);

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 340, panel.current?.scrollHeight);
  };

  const load = () => {
    setError(null);
    api.getJellyfinDevices(userId).then(setState).catch((e: any) => setError(e?.message || 'Could not read the devices'));
  };

  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (!at) return;
    setAnchor(at);
    load();
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onMove = () => { const at = place(); if (at) setAnchor(at); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const signOut = async (d: JellyfinDevice) => {
    setBusy(d.id);
    try {
      await api.signOutJellyfinDevice(userId, d.id);
      toast.success(`${d.name} is signed out`);
      setState((s) => (s ? { ...s, devices: s.devices.filter((x) => x.id !== d.id) } : s));
    } catch (e: any) {
      toast.error(e?.message || 'Could not sign that device out');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <ActionPill ref={button} icon={DevicePhoneMobileIcon} open={open} onClick={toggle}>
        Devices
      </ActionPill>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label={`Devices signed in as ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">Signed in as {name}</p>
              <p className="text-xs text-muted mt-0.5">Everything signed in to their Jellyfin server as them. Sign out an old or unknown one.</p>
            </div>
            {error ? (
              <p className="text-xs text-error">{error}</p>
            ) : !state ? (
              <div className="space-y-2">
                {[0, 1].map((i) => <div key={i} className="h-11 rounded-xl bg-surface-hover animate-pulse" />)}
              </div>
            ) : state.needsAdmin ? (
              <p className="text-xs text-default">
                Jellyfin shows this list to administrators only. Add someone here who signs in to that server as an administrator, and it appears.
              </p>
            ) : state.devices.length === 0 ? (
              <p className="text-xs text-muted">Nothing is signed in as {name}.</p>
            ) : (
              <ul className="space-y-1.5 max-h-80 overflow-y-auto">
                {state.devices.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-subtle">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-default truncate">{d.slicksync ? 'SlickSync' : d.name}</p>
                      <p className="text-[11px] text-muted truncate">
                        {d.slicksync ? 'How SlickSync reads their viewing' : [d.app, ago(d.lastActive)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    {!d.slicksync && (
                      <button
                        type="button"
                        onClick={() => signOut(d)}
                        disabled={busy === d.id}
                        className="shrink-0 px-2.5 py-1 rounded-lg text-xs text-error hover:bg-error/10 disabled:opacity-40 transition-colors"
                      >
                        {busy === d.id ? 'Signing out…' : 'Sign out'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
