// Where an anchored popup (Daily limit, Age limit, Devices, Sign in a TV...)
// goes, next to the pill that opened it. Below the pill when the popup fits
// there, otherwise above it; when it fits on neither side (a phone, a pill
// mid-screen) it slides as close to the pill as it can while staying fully on
// screen, and only scrolls inside when it is taller than the screen itself.
// Always opening below put a popup opened low on a phone almost entirely off
// it. The popup's real height is measured once it is drawn (useFitPopup).

import { useEffect, useLayoutEffect } from 'react';

export interface PopupPlacement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const GAP = 8;
const MARGIN = 16;
// Before the popup has been measured: room below that fits any of them.
const COMFORTABLE = 320;

export function placePopup(pill: DOMRect, preferredWidth: number, height?: number): PopupPlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(preferredWidth, vw - MARGIN * 2);
  const left = Math.max(MARGIN, Math.min(pill.left, vw - width - MARGIN));
  const screen = vh - MARGIN * 2;
  const below = vh - pill.bottom - GAP - MARGIN;
  const above = pill.top - GAP - MARGIN;
  const need = height ?? COMFORTABLE;
  // Clamped to the screen, so a pill scrolled half out of view still gets a popup in it.
  if (below >= need) return { left, width, top: Math.max(MARGIN, pill.bottom + GAP), maxHeight: below };
  if (above >= need) return { left, width, bottom: Math.max(MARGIN, vh - pill.top + GAP), maxHeight: Math.min(above, screen) };
  // Fits on neither side: as near the pill as it can be, all of it on screen.
  const h = Math.min(need, screen);
  const top = Math.max(MARGIN, Math.min(pill.bottom + GAP, vh - MARGIN - h));
  return { left, width, top, maxHeight: screen };
}

/** The popup panel's position, size and scrolling, for its style prop. */
export function popupStyle(p: PopupPlacement): React.CSSProperties {
  return { left: p.left, width: p.width, top: p.top, bottom: p.bottom, maxHeight: p.maxHeight, overflowY: 'auto' };
}

/**
 * Place the popup again once it is drawn, and whenever its content changes
 * height (loading, a result appearing) - `replace` re-runs the component's own
 * placement, which reads the panel's height.
 */
export function useFitPopup(panel: React.RefObject<HTMLElement | null>, open: boolean, replace: () => void) {
  useLayoutEffect(() => {
    if (open) replace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    let last = el.scrollHeight;
    const check = () => {
      const now = panel.current?.scrollHeight ?? last;
      if (Math.abs(now - last) > 2) { last = now; replace(); }
    };
    // Content appearing (a result, a progress box) and content resizing
    // (loading finishing) both change the height; the panel itself may be
    // capped, so its own size alone doesn't show it.
    const added = typeof MutationObserver !== 'undefined' ? new MutationObserver(check) : null;
    added?.observe(el, { childList: true, subtree: true, characterData: true });
    const resized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    if (resized) {
      resized.observe(el);
      for (const child of Array.from(el.children)) resized.observe(child);
    }
    return () => { added?.disconnect(); resized?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
