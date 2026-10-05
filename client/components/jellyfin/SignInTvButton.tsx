'use client';

// "Sign in a TV": a Jellyfin app on a TV (or anywhere) offers Quick Connect
// and shows a short code. Typed here, SlickSync approves it with the chosen
// person's or household profile's sign-in, and the server signs the device in
// as them - no password typed on a remote. An anchored popup, like the rest
// of SlickSync's small menus; closes on a tap outside or Escape, and follows
// its button on scroll and resize rather than closing - on a phone, the
// keyboard opening for the code box is a resize.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TvIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, type HouseholdProfile } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

type Who = { id: string | null; name: string; ready: boolean; hint?: string };

export function SignInTvButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [profiles, setProfiles] = useState<HouseholdProfile[] | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const open = !!anchor;
  const close = () => { setAnchor(null); setCode(''); };

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 320, panel.current?.scrollHeight);
  };

  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (!at) return;
    setAnchor(at);
    if (profiles === null) {
      api.getHousehold(userId).then((h) => setProfiles(h.profiles || [])).catch(() => setProfiles([]));
    }
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

  // The person, then their household profiles. A profile SlickSync has no
  // sign-in for yet can't approve a code - shown, but not pickable.
  const choices: Who[] = [
    { id: null, name, ready: true },
    ...(profiles || [])
      .filter((p) => p.status !== 'own')
      .map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.status === 'tracked' || p.status === 'untracked',
        hint: p.status === 'needs-pin' ? 'Sign in with their PIN on the Users page first' : p.status === 'needs-sign-in' ? 'Sign them in on the Users page first' : undefined,
      })),
  ];
  const chosen = choices.find((c) => c.id === who) || choices[0];

  const submit = async () => {
    const digits = code.replace(/\D/g, '');
    if (digits.length < 4) { toast.error('Type the code the TV shows'); return; }
    setBusy(true);
    try {
      const r = await api.authorizeQuickConnect(userId, digits, chosen.id);
      toast.success(`The TV is signing in as ${r.who}`);
      close();
    } catch (e: any) {
      toast.error(e?.message || "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default text-xs text-subtle hover:text-default hover:bg-surface-hover transition-colors"
      >
        <TvIcon className="w-3.5 h-3.5" />
        Sign in a TV
      </button>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label="Sign in a TV"
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">Sign in a TV</p>
              <p className="text-xs text-muted mt-0.5">On the TV, choose Quick Connect &ndash; it shows a code. Type it here.</p>
            </div>
            {choices.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {choices.map((c) => {
                  const on = c.id === chosen.id;
                  return (
                    <button
                      key={c.id || 'self'}
                      type="button"
                      disabled={!c.ready}
                      title={c.hint}
                      onClick={() => setWho(c.id)}
                      aria-pressed={on}
                      className={`px-2.5 py-1 rounded-lg border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        on ? 'border-primary bg-primary/10 text-default' : 'border-default text-subtle hover:bg-surface-hover hover:text-default'
                      }`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 12))}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              aria-label="Code on the TV"
              className="w-full px-4 py-3 rounded-xl text-2xl tracking-[0.3em] text-center font-mono"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
            />
            <Button variant="primary" size="sm" className="w-full" onClick={submit} isLoading={busy}>
              Sign in as {chosen.name}
            </Button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
