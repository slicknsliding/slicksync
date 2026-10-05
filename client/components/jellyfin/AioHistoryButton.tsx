'use client';

// "AIOStreams history": every version of this person's AIOStreams
// configuration SlickSync has seen, what changed between them, and putting
// an earlier one back (server/utils/aioConfigHistory.js). The change alert
// links here with ?aioHistory=1, which opens it. Same anchored popup as the
// other pills beside it.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUturnLeftIcon } from '@heroicons/react/24/outline';
import { ActionPill } from '@/components/user/ActionPill';
import { toast } from '@/components/ui/Toast';
import { Button, Modal } from '@/components/ui';
import { api, type AioHistory } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

const REASON: Record<string, string> = {
  seen: 'Seen',
  slicksync: 'Changed by SlickSync',
  restore: 'Put back',
};

export function AioHistoryButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [state, setState] = useState<AioHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<AioHistory['versions'][number] | null>(null);
  const [keep, setKeep] = useState({ services: true, users: true, apiKeys: true });
  const [busy, setBusy] = useState(false);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 380, panel.current?.scrollHeight);
  };
  const toggle = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); });

  // The change alert links here with ?aioHistory=1.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('aioHistory') !== '1') return;
    const t = setTimeout(() => { const at = place(); if (at) setAnchor(at); }, 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getAioHistory(userId).then(setState).catch((e: any) => setError(e?.message || 'Could not read the history'));
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
  }, [open, userId]);

  const doRestore = async () => {
    if (!restoring) return;
    setBusy(true);
    try {
      setState(await api.restoreAioVersion(userId, restoring.id, keep));
      toast.success(`${name}'s AIOStreams configuration is back to how it was`);
      setRestoring(null);
    } catch (e: any) {
      toast.error(e?.message || 'Could not put that version back');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionPill ref={button} icon={ArrowUturnLeftIcon} open={open} onClick={toggle}>
        AIOStreams history
      </ActionPill>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label={`AIOStreams history for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">AIOStreams history for {name}</p>
              <p className="text-xs text-muted mt-0.5">Every version of their configuration SlickSync has seen, newest first.</p>
            </div>
            {error ? (
              <p className="text-xs text-error">{error}</p>
            ) : !state ? (
              <div className="h-24 rounded-xl bg-surface-hover animate-pulse" />
            ) : !state.available ? (
              <p className="text-xs text-default">Only for someone added with their AIOStreams configuration password.</p>
            ) : state.versions.length === 0 ? (
              <p className="text-xs text-subtle">Nothing kept yet - the configuration is read every 30 minutes.</p>
            ) : (
              <div className="space-y-2">
                {state.versions.map((v) => (
                  <div key={v.id} className="rounded-xl px-3 py-2 text-xs space-y-1" style={{ background: 'var(--color-surface-hover)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-default">
                        {new Date(v.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {REASON[v.reason] || v.reason}{v.current ? ' · now' : ''}
                      </span>
                      {!v.current && (
                        <button
                          type="button"
                          // The confirmation is a dialog of its own; the popup would sit on top of it.
                          onClick={() => { setRestoring(v); close(); }}
                          className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded-md border border-default text-[11px] text-default hover:bg-surface"
                        >
                          Put back
                        </button>
                      )}
                    </div>
                    <p className="text-subtle">{v.addons} addons · {v.services} services · {v.users} household users</p>
                    {v.changes.length > 0 && <p className="text-muted">Since the one before: {v.changes.join(', ')}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}

      <Modal
        isOpen={!!restoring}
        onClose={() => { if (!busy) setRestoring(null); }}
        title={restoring ? `Put ${name}'s configuration back to ${new Date(restoring.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}?` : ''}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">Its addons, filters and settings come back. Keep what is there now for:</p>
          <div className="space-y-2">
            {([['services', 'Debrid services and their keys'], ['users', 'Household users and PINs'], ['apiKeys', 'API keys']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm text-default">
                <input type="checkbox" checked={keep[k]} onChange={(e) => setKeep((cur) => ({ ...cur, [k]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
          <div className="flex gap-3 justify-end">
            <Button variant="secondary" type="button" onClick={() => setRestoring(null)} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="button" onClick={doRestore} isLoading={busy}>Put it back</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
