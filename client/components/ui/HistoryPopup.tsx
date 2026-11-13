'use client';

// The anchored box a history opens in - Sync history on a person's page and
// a Vault key's History. Same frame as the other popups beside their pills
// (AIOStreams history, Devices): a title, one line saying what it lists, the
// list, and a closing note. It sits next to whatever opened it, follows it
// when the page scrolls, resizes or shifts under it, and closes on Escape or
// a click outside.
//
// With `around` (the card the opening button sits in), it goes next to that
// card instead of on it: below or above with a gap, a pointer at the button,
// and a shadow that keeps it reading as on top of the page rather than as one
// more card in the list. If neither side has room when it opens, the page
// scrolls just enough to make room below.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placePopup, placeOutside, popupStyle, scrollParent, useFitPopup, useFollowAnchor, type OutsidePlacement, type PopupPlacement } from '@/lib/anchoredPopup';

const SPOT = ['left', 'width', 'top', 'bottom', 'maxHeight', 'side', 'tipX', 'tipY'] as const;
const ACCENT_EDGE = 'color-mix(in srgb, var(--color-primary) 45%, transparent)';
const FLOATING = '0 18px 48px rgba(0,0,0,0.6), 0 4px 14px rgba(0,0,0,0.45)';

export function HistoryPopup({ open, anchor, around, onClose, title, line, note, children }: {
  open: boolean;
  /** Where the thing that opened it is now. */
  anchor: () => DOMRect | null;
  /** The card that thing sits in, to open beside rather than on top of. */
  around?: () => HTMLElement | null;
  onClose: () => void;
  title: string;
  line: string;
  note?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<(PopupPlacement & Partial<OutsidePlacement>) | null>(null);
  // Making room scrolls the page once per opening, never again while the
  // person scrolls it themselves.
  const madeRoom = useRef(false);

  const place = (): (PopupPlacement & Partial<OutsidePlacement>) | null => {
    const r = anchor();
    if (!r) return null;
    const card = around?.() ?? null;
    if (!card) return placePopup(r, 380, panel.current?.scrollHeight);
    const height = panel.current?.scrollHeight;
    let p = placeOutside(card.getBoundingClientRect(), r, 380, height);
    if (p.short && p.short > 0 && height && !madeRoom.current) {
      madeRoom.current = true;
      const c = card.getBoundingClientRect();
      // As far as needed, but never so far that the card's top leaves the screen.
      const by = Math.min(p.short, Math.max(0, c.top - 16));
      if (by > 0) {
        const box = scrollParent(card);
        if (box) box.scrollBy({ top: by, behavior: 'instant' as ScrollBehavior });
        else window.scrollBy({ top: by, behavior: 'instant' as ScrollBehavior });
        const moved = anchor();
        if (moved) p = placeOutside(card.getBoundingClientRect(), moved, 380, height);
      }
    }
    return p;
  };
  // Unchanged spot: keep the old one so React skips the redraw.
  const replace = () => { const p = place(); if (p) setAt((old) => (old && SPOT.every((k) => old[k] === p[k]) ? old : p)); };

  useEffect(() => {
    if (!open) { setAt(null); madeRoom.current = false; return; }
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
  useFollowAnchor(open, () => [anchor(), around?.()?.getBoundingClientRect() ?? null], replace);

  if (!open || !at || typeof document === 'undefined') return null;
  const beside = at.side === 'below' || at.side === 'above';
  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-label={title}
        className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4 space-y-3"
        style={{
          ...popupStyle(at),
          background: 'var(--color-surface)',
          ...(beside ? { borderColor: ACCENT_EDGE, boxShadow: FLOATING } : {}),
        }}
      >
        <div>
          <p className="text-sm font-semibold text-default">{title}</p>
          <p className="text-xs text-muted mt-0.5">{line}</p>
        </div>
        {children}
        {note && <p className="text-[11px] text-subtle">{note}</p>}
      </div>
      {beside && at.tipX != null && at.tipY != null && (
        <div
          aria-hidden
          className="fixed z-[10000] pointer-events-none"
          style={{
            left: at.tipX - 7,
            top: at.tipY - 7,
            width: 14,
            height: 14,
            transform: 'rotate(45deg)',
            background: 'var(--color-surface)',
            borderStyle: 'solid',
            borderColor: ACCENT_EDGE,
            borderWidth: at.side === 'below' ? '1px 0 0 1px' : '0 1px 1px 0',
          }}
        />
      )}
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
