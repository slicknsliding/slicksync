'use client';

// A small panel that opens right beside the thing that was tapped (the
// avatar, a card's ... button, a device tile) rather than over the whole page.
// Used by the person's own pages: the picture picker, the Nuvio profile
// switcher, a device's Rename/Remove, a Continue Watching card's menu.
//
// Every one closes the same ways: its X in the top right corner, Escape, and a
// press anywhere outside it. The trigger itself is left out of "outside" so a
// second tap on it is the trigger's own toggle, not a close followed by a
// reopen. It follows its trigger while the page scrolls or resizes, stays
// whole on screen (left/right edges, flips above when there is no room below,
// scrolls inside when taller than the screen) and puts focus back on the
// trigger when it goes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';

export function AnchoredPopup({ anchorRef, onClose, title, width = 340, align = 'start', label, children }: {
  /** The thing it opens from. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A heading beside the X. Left out, the X stands alone in the corner. */
  title?: React.ReactNode;
  width?: number;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end';
  /** What a screen reader calls it, when there is no title text. */
  label?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  // The latest close, so the listeners below are set up once.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  const fit = useCallback(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;
    const pad = 12;
    const gap = 8;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.scrollHeight;
    const wanted = align === 'end' ? a.right - w : a.left;
    const left = Math.max(pad, Math.min(wanted, vw - w - pad));
    const room = { below: vh - a.bottom - gap - pad, above: a.top - gap - pad };
    // Below by default; above only when that is the roomier side and it does not fit below.
    const above = h > room.below && room.above > room.below;
    const maxHeight = Math.max(160, above ? room.above : room.below);
    const top = above ? Math.max(pad, a.top - gap - Math.min(h, maxHeight)) : a.bottom + gap;
    setPlace((prev) => (prev && prev.left === left && prev.top === top && prev.maxHeight === maxHeight ? prev : { left, top, maxHeight }));
  }, [anchorRef, align]);

  useLayoutEffect(() => { fit(); });

  useEffect(() => {
    let frame = 0;
    const refit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    // Scrolling the panel's own content moves nothing; the page scrolling does.
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) refit(); };
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    // The press that opened it may still be going: listen from the next tick.
    const t = setTimeout(() => document.addEventListener('pointerdown', down), 0);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', refit);
    const resize = typeof ResizeObserver !== 'undefined' && panelRef.current ? new ResizeObserver(refit) : null;
    if (panelRef.current) resize?.observe(panelRef.current);
    // Content loading in above the trigger moves it without a scroll or a resize of the window.
    resize?.observe(document.body);
    if (anchorRef.current) resize?.observe(anchorRef.current);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', refit);
      resize?.disconnect();
    };
  }, [fit, anchorRef]);

  // Focus goes in, and back to the trigger afterwards.
  useEffect(() => {
    const anchor = anchorRef.current;
    panelRef.current?.focus({ preventScroll: true });
    return () => { anchor?.focus?.({ preventScroll: true }); };
  }, [anchorRef]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label || (typeof title === 'string' ? title : undefined)}
      tabIndex={-1}
      data-anchored-popup
      className="popup-panel fixed z-[10000] rounded-2xl outline-none overflow-y-auto"
      style={{
        left: place?.left ?? -9999,
        top: place?.top ?? -9999,
        width: Math.min(width, (typeof window !== 'undefined' ? window.innerWidth : width) - 24),
        maxHeight: place?.maxHeight,
        visibility: place ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-center justify-between gap-2 pl-4 pr-2 pt-2.5 pb-1 min-h-[44px]">
        <div className="min-w-0 text-sm font-semibold text-default truncate">{title}</div>
        <button
          type="button"
          onClick={() => closeRef.current()}
          aria-label="Close"
          className="shrink-0 w-9 h-9 -mr-0.5 rounded-full flex items-center justify-center text-muted hover:text-default hover:bg-surface-hover transition-colors"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>
      <div className="px-4 pb-4">{children}</div>
    </div>,
    document.body,
  );
}
