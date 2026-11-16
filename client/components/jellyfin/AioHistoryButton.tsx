'use client';

// "AIOStreams history": every version of this person's AIOStreams
// configuration SlickSync has seen, what changed between them, and putting
// an earlier one back (server/utils/aioConfigHistory.js). The change alert
// links here with ?aioHistory=1, which opens it. Same anchored popup as the
// other pills beside it.
//
// Two ways in: AioHistoryButton on the person's page, and AioHistoryPill -
// "History" on their Users card, in the same spot and the same box as Sync
// history on everyone else's card.

import { LoadErrorInline } from '@/components/ui/LoadState';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUturnLeftIcon, ClockIcon } from '@heroicons/react/24/outline';
import { ActionPill } from '@/components/user/ActionPill';
import { HistoryPopup } from '@/components/ui/HistoryPopup';
import { toast } from '@/components/ui/Toast';
import { Button, Modal } from '@/components/ui';
import { api, type AioHistory } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, useFollowAnchor, type PopupPlacement } from '@/lib/anchoredPopup';

const REASON: Record<string, string> = {
  seen: 'Seen',
  slicksync: 'Changed by SlickSync',
  restore: 'Put back',
  pause: 'Streaming paused by SlickSync',
  unpause: 'Streaming back on',
};

const TITLE = (name: string) => `AIOStreams history for ${name}`;
const LINE = 'Every version of their configuration SlickSync has seen, newest first.';

type Version = AioHistory['versions'][number];

/** Reads the history each time it opens, and again on Try again. */
function useAioHistory(userId: string, open: boolean) {
  const [state, setState] = useState<AioHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getAioHistory(userId).then(setState).catch((e: any) => setError(e?.message || 'Could not read the history'));
  }, [open, userId, attempt]);
  return { state, setState, error, retry: () => setAttempt((n) => n + 1) };
}

function AioHistoryBody({ state, error, retry, onPutBack }: {
  state: AioHistory | null;
  error: string | null;
  retry: () => void;
  onPutBack: (v: Version) => void;
}) {
  if (error) return <LoadErrorInline error={error} onRetry={retry} />;
  if (!state) return <div className="h-24 rounded-xl skeleton-fill" />;
  if (!state.available) return <p className="text-xs text-default">Only for someone added with their AIOStreams configuration password.</p>;
  if (state.versions.length === 0) return <p className="text-xs text-subtle">Nothing kept yet - the configuration is read every 30 minutes.</p>;
  return (
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
                onClick={() => onPutBack(v)}
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
  );
}

/** "Put it back?" - choosing what to keep as it is now, then putting the version back. */
function PutBackDialog({ userId, name, version, onClose, onDone }: {
  userId: string;
  name: string;
  version: Version | null;
  onClose: () => void;
  onDone: (state: AioHistory) => void;
}) {
  const [keep, setKeep] = useState({ services: true, users: true, apiKeys: true });
  const [busy, setBusy] = useState(false);
  const doRestore = async () => {
    if (!version) return;
    setBusy(true);
    try {
      onDone(await api.restoreAioVersion(userId, version.id, keep));
      toast.success(`${name}'s AIOStreams configuration is back to how it was`);
      onClose();
    } catch (e: any) {
      toast.error(e?.message || 'Could not put that version back');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen={!!version}
      onClose={() => { if (!busy) onClose(); }}
      title={version ? `Put ${name}'s configuration back to ${new Date(version.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}?` : ''}
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
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="button" onClick={doRestore} isLoading={busy}>Put it back</Button>
        </div>
      </div>
    </Modal>
  );
}

export function AioHistoryButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [restoring, setRestoring] = useState<Version | null>(null);

  const open = !!anchor;
  const history = useAioHistory(userId, open);
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
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); }, close);
  useFollowAnchor(open, () => [button.current?.getBoundingClientRect() ?? null], () => { const at = place(); if (at) setAnchor(at); });

  // The change alert links here with ?aioHistory=1.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('aioHistory') !== '1') return;
    const t = setTimeout(() => { const at = place(); if (at) setAnchor(at); }, 300);
    return () => clearTimeout(t);
  }, []);

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
            aria-label={TITLE(name)}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">{TITLE(name)}</p>
              <p className="text-xs text-muted mt-0.5">{LINE}</p>
            </div>
            {/* The confirmation is a dialog of its own; the popup would sit on top of it. */}
            <AioHistoryBody {...history} onPutBack={(v) => { setRestoring(v); close(); }} />
          </div>
        </>,
        document.body,
      )}
      <PutBackDialog userId={userId} name={name} version={restoring} onClose={() => setRestoring(null)} onDone={history.setState} />
    </>
  );
}

/**
 * "History" on an AIOStreams person's Users card: the same pill and box as
 * Sync history on the other cards, between Limits and Caught up.
 */
export function AioHistoryPill({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<Version | null>(null);
  const history = useAioHistory(userId, open);
  const hasVersions = !!history.state?.available && history.state.versions.length > 0;
  return (
    // The card itself opens the person on a click; nothing done here - in
    // the pill, its popup or the Put back dialog - reaches it (React passes
    // a portal's events up through the component that rendered it).
    <span
      className="inline-flex max-w-full min-w-0"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ActionPill ref={button} icon={ClockIcon} size="sm" open={open} onClick={() => setOpen((v) => !v)}>
        History
      </ActionPill>
      <HistoryPopup
        open={open}
        anchor={() => button.current?.getBoundingClientRect() ?? null}
        pointer="start"
        onClose={() => setOpen(false)}
        title={TITLE(name)}
        line={LINE}
        note={hasVersions ? 'Read every 30 minutes.' : undefined}
      >
        <AioHistoryBody {...history} onPutBack={(v) => { setRestoring(v); setOpen(false); }} />
      </HistoryPopup>
      <PutBackDialog userId={userId} name={name} version={restoring} onClose={() => setRestoring(null)} onDone={history.setState} />
    </span>
  );
}
