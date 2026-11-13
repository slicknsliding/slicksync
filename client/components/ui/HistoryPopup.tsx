'use client';

// The anchored box a history opens in - Sync history on a person's page and
// a Vault key's History. Same frame as the other popups beside their pills
// (AIOStreams history, Devices): a title, one line saying what it lists, the
// list, and a closing note. It sits next to whatever opened it, follows it
// on scroll and resize, and closes on Escape or a click outside.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

export function HistoryPopup({ open, anchor, onClose, title, line, note, children }: {
  open: boolean;
  /** Where the thing that opened it is now. */
  anchor: () => DOMRect | null;
  onClose: () => void;
  title: string;
  line: string;
  note?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<PopupPlacement | null>(null);
  const place = () => {
    const r = anchor();
    return r ? placePopup(r, 380, panel.current?.scrollHeight) : null;
  };
  const replace = () => { const p = place(); if (p) setAt(p); };

  useEffect(() => {
    if (!open) { setAt(null); return; }
    replace();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', replace, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', replace);
      window.removeEventListener('scroll', replace, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useFitPopup(panel, open && !!at, replace, onClose);

  if (!open || !at || typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-label={title}
        className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
        style={{ ...popupStyle(at), background: 'var(--color-surface)' }}
      >
        <div>
          <p className="text-sm font-semibold text-default">{title}</p>
          <p className="text-xs text-muted mt-0.5">{line}</p>
        </div>
        {children}
        {note && <p className="text-[11px] text-subtle">{note}</p>}
      </div>
    </>,
    document.body,
  );
}

/** One line in a history: the moment and what happened, then smaller detail lines. */
export function HistoryRow({ head, children }: { head: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-xl px-3 py-2 text-xs space-y-1" style={{ background: 'var(--color-surface-hover)' }}>
      <div className="text-default">{head}</div>
      {children}
    </div>
  );
}
