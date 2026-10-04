'use client';

// "Age limit": the highest age rating this person's account on a real
// Jellyfin server may play, set on the server so every Jellyfin app keeps to
// it (server/utils/jellyfinParental.js). The choices are the server's own
// rating list. Needs an administrator's sign-in on that server. Same anchored
// popup as Devices and Sign in a TV beside it.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { api, type JellyfinAgeLimit } from '@/lib/api';

export function AgeLimitButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const [state, setState] = useState<JellyfinAgeLimit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Read once up front so the pill can say the current limit.
  useEffect(() => {
    api.getJellyfinAgeLimit(userId).then(setState).catch((e: any) => setError(e?.message || 'Could not read the age limit'));
  }, [userId]);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    const width = Math.min(320, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
    return { top: r.bottom + 8, left, width };
  };
  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };

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

  if (state && !state.available) return null;

  const save = async (value: number | null, blockUnrated?: boolean) => {
    setSaving(true);
    try {
      const next = await api.setJellyfinAgeLimit(userId, value, blockUnrated);
      setState(next);
      toast.success(value === null ? `${name} has no age limit` : `${name} is limited to ${next.levels?.find((l) => l.value === value)?.label || 'that rating'}`);
    } catch (e: any) {
      toast.error(e?.message || 'Could not set the age limit');
    } finally {
      setSaving(false);
    }
  };

  const currentLabel = state?.current == null ? null : state.levels?.find((l) => l.value === state.current)?.label?.split(' · ')[0];

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default text-xs text-subtle hover:text-default hover:bg-surface-hover transition-colors"
      >
        <ShieldCheckIcon className="w-3.5 h-3.5" />
        {currentLabel ? `Up to ${currentLabel}` : 'Age limit'}
      </button>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            role="dialog"
            aria-label={`Age limit for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width, background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">Age limit for {name}</p>
              <p className="text-xs text-muted mt-0.5">The highest rating their Jellyfin account can play, in every Jellyfin app.</p>
            </div>
            {error ? (
              <p className="text-xs text-error">{error}</p>
            ) : !state ? (
              <div className="h-24 rounded-xl bg-surface-hover animate-pulse" />
            ) : state.needsAdmin ? (
              <p className="text-xs text-default">Jellyfin lets only administrators set this. Add someone here who signs in to that server as an administrator, and it can be set.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto">
                  {[{ value: null as number | null, label: 'No limit' }, ...(state.levels || [])].map((l) => {
                    const on = (state.current ?? null) === l.value;
                    return (
                      <button
                        key={String(l.value)}
                        type="button"
                        disabled={saving}
                        onClick={() => save(l.value)}
                        aria-pressed={on}
                        className={`px-2.5 py-1 rounded-lg border text-xs transition-colors disabled:opacity-50 ${on ? 'border-primary bg-primary/10 text-default' : 'border-default text-subtle hover:bg-surface-hover hover:text-default'}`}
                      >
                        {l.label}
                      </button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 text-xs text-default">
                  <input
                    type="checkbox"
                    checked={!!state.blockUnrated}
                    disabled={saving}
                    onChange={(e) => save(state.current ?? null, e.target.checked)}
                  />
                  Hide films and shows that have no rating
                </label>
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
