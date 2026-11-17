'use client';

// "AIOStreams" on an AIOStreams person's page: one pill for both things
// SlickSync can tell about their configuration. Health is what AIOStreams
// itself reports (addons failing, empty, slow or redundant, the apps using
// it, a test search); History is every version SlickSync has seen, and
// putting one back. A Health | History switch sits at the top; the box opens
// on Health, or on History when the change alert links here with
// ?aioHistory=1. Same anchored popup as the other pills beside it. On a TV
// the remote stays inside the box and moves between its controls
// (useTVModal).
//
// The v2 design shows the same pill in its AIOStreams tool tile; the Users
// card keeps its History pill (AioHistoryPill).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HeartIcon } from '@heroicons/react/24/outline';
import { ActionPill } from '@/components/user/ActionPill';
import { useTVModal } from '@/components/tv/useTVModal';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { placePopup, popupStyle, useFitPopup, useFollowAnchor, type PopupPlacement } from '@/lib/anchoredPopup';
import { AioHealthBody } from './AioHealthButton';
import { AioHistoryBody, PutBackDialog, useAioHistory, type Version } from './AioHistoryButton';

type View = 'health' | 'history';
const VIEWS: { id: View; label: string }[] = [{ id: 'health', label: 'Health' }, { id: 'history', label: 'History' }];
const NONE_SEEN: Record<View, boolean> = { health: false, history: false };

export function AioStreamsButton({ userId, name }: { userId: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  const [view, setView] = useState<View>('health');
  const [restoring, setRestoring] = useState<Version | null>(null);
  const isTV = useIsTV();

  const open = !!anchor;
  // Each side asks once per opening, when it is first shown - switching back
  // and forth reads nothing again.
  const [seen, setSeen] = useState<Record<View, boolean>>(NONE_SEEN);
  const history = useAioHistory(userId, seen.history);

  const close = () => { setAnchor(null); setSeen(NONE_SEEN); };
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 380, panel.current?.scrollHeight);
  };
  const pick = (v: View) => {
    setView(v);
    setSeen((s) => (s[v] ? s : { ...s, [v]: true }));
  };
  const show = (v: View) => {
    pick(v);
    const at = place();
    if (at) setAnchor(at);
  };
  const toggle = () => {
    if (open) { close(); return; }
    show('health');
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); }, close);
  useFollowAnchor(open, () => [button.current?.getBoundingClientRect() ?? null], () => { const at = place(); if (at) setAnchor(at); });
  useTVModal(isTV && open, panel, close);

  // The change alert links here with ?aioHistory=1.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('aioHistory') !== '1') return;
    const t = setTimeout(() => show('history'), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
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
      <ActionPill ref={button} icon={HeartIcon} open={open} onClick={toggle}>
        AIOStreams
      </ActionPill>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label={`AIOStreams for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <div>
              <p className="text-sm font-semibold text-default">AIOStreams for {name}</p>
              <p className="text-xs text-muted mt-0.5">What AIOStreams says about their setup, and every version of it.</p>
            </div>
            <div role="tablist" aria-label="Show" className="inline-flex gap-1 p-[3px] rounded-xl border border-default">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={view === v.id}
                  data-tv-initial={view === v.id ? '' : undefined}
                  onClick={() => pick(v.id)}
                  className={`px-3.5 py-1 rounded-[9px] border text-xs transition-colors ${view === v.id ? 'border-primary bg-primary/10 text-default font-semibold' : 'border-transparent text-subtle hover:text-default'}`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {/* Health stays mounted while History shows, so a test search
                and the chosen range are still there on the way back. */}
            <div hidden={view !== 'health'}>
              <AioHealthBody userId={userId} active={seen.health} />
            </div>
            {view === 'history' && (
              // The confirmation is a dialog of its own; the popup would sit on top of it.
              <AioHistoryBody {...history} onPutBack={(v) => { setRestoring(v); close(); }} />
            )}
          </div>
        </>,
        document.body,
      )}
      <PutBackDialog userId={userId} name={name} version={restoring} onClose={() => setRestoring(null)} onDone={history.setState} />
    </>
  );
}
