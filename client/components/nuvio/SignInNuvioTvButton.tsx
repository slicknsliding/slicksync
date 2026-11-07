'use client';

// "Sign in a Nuvio TV": a Nuvio TV or computer that isn't signed in shows a
// 6-character code. Typed here, SlickSync looks it up with this person's
// Nuvio sign-in so the right device can be confirmed, then approves it - the
// device lands in their Nuvio account and asks which profile. Same anchored
// popup as the Jellyfin "Sign in a TV" (components/jellyfin/SignInTvButton).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TvIcon } from '@heroicons/react/24/outline';
import { ActionPill } from '@/components/user/ActionPill';
import { Button } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

type Found = { deviceName: string | null; deviceType: string | null };

const cleanCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
const typeLabel = (t: string | null) => {
  const v = (t || '').toLowerCase();
  if (v === 'tv') return 'TV';
  if (!v || v === 'device') return '';
  return v.charAt(0).toUpperCase() + v.slice(1);
};

export function SignInNuvioTvButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);

  const open = !!anchor;
  const close = () => { setAnchor(null); setCode(''); setFound(null); };

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 320, panel.current?.scrollHeight);
  };

  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); }, close);

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

  const lookUp = async () => {
    if (code.length !== 6) { toast.error('Type the 6-character code the TV shows'); return; }
    setBusy(true);
    try {
      const r = await api.lookupNuvioDeviceLogin(userId, code);
      setFound({ deviceName: r.deviceName, deviceType: r.deviceType });
    } catch (e: any) {
      toast.error(e?.message || "That code didn't work");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      const r = await api.approveNuvioDeviceLogin(userId, code);
      toast.success(`${r.deviceName || 'The device'} is signing in to ${name}'s Nuvio account`);
      close();
    } catch (e: any) {
      toast.error(e?.message || "That didn't work");
      setFound(null);
    } finally {
      setBusy(false);
    }
  };

  const kind = typeLabel(found?.deviceType ?? null);

  return (
    <>
      <ActionPill ref={button} icon={TvIcon} open={open} onClick={toggle}>
        Sign in a Nuvio TV
      </ActionPill>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label="Sign in a Nuvio TV"
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">Sign in a Nuvio TV or computer</p>
              <p className="text-xs text-muted mt-0.5">
                Type the code it shows. It signs in to {name}&apos;s Nuvio account, then asks which profile. Codes last 5 minutes.
              </p>
            </div>
            <input
              autoFocus
              value={code}
              onChange={(e) => { setCode(cleanCode(e.target.value)); setFound(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (found ? approve() : lookUp()); }}
              autoCapitalize="characters"
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder="K7MQ2X"
              aria-label="Code on the TV"
              className="w-full px-4 py-3 rounded-xl text-2xl tracking-[0.3em] text-center font-mono uppercase"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
            />
            {found ? (
              <div className="rounded-xl border border-default p-3 space-y-2.5" style={{ background: 'var(--color-surface-hover)' }}>
                <p className="text-sm text-default">
                  <span className="font-semibold">{found.deviceName || 'A Nuvio device'}</span>
                  {kind && <span className="text-xs text-muted"> &middot; {kind}</span>}
                </p>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={approve} isLoading={busy}>Approve</Button>
                  <Button variant="secondary" size="sm" onClick={() => setFound(null)} disabled={busy}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="primary" size="sm" className="w-full" onClick={lookUp} isLoading={busy}>
                Find the device
              </Button>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
