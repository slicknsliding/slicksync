// Where an anchored popup (Daily limit, Age limit, Devices, Sign in a TV...)
// goes, next to the pill that opened it. Below the pill when the popup fits
// there, otherwise above it; when it fits on neither side (a phone, a pill
// mid-screen) it slides as close to the pill as it can while staying fully on
// screen, and only scrolls inside when it is taller than the screen itself.
// Always opening below put a popup opened low on a phone almost entirely off
// it. The popup's real height is measured once it is drawn (useFitPopup).

import { useEffect, useLayoutEffect } from 'react';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useTVModal } from '@/components/tv/useTVModal';

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

export interface OutsidePlacement extends PopupPlacement {
  /** Which side of the card it went on; 'over' only when neither side has room even after scrolling. */
  side: 'below' | 'above' | 'over';
  /** Where the pointer sits: on the panel's edge facing the card, in line with the button. */
  tipX?: number;
  tipY?: number;
  /** How far the page would have to scroll down for it to fit below the card. */
  short?: number;
}

// Outside a card: a little further off than a pill's popup, so the pointer fits in the gap.
const OUTSIDE_GAP = 10;
// Below this the roomier side is too cramped to read; it goes over the card instead.
const MIN_OUTSIDE = 160;

/**
 * For a popup opened from a button INSIDE a card (a Vault card's clock or its
 * ⋯ menu): next to the card, never on it. Below the card when it fits there,
 * otherwise above, with a pointer at the button. When it fits on neither side,
 * `short` says how far the page should scroll for it to fit below; until then
 * it takes the roomier side and scrolls inside, and only on a screen too small
 * for even that does it fall back onto the card like a pill's popup.
 */
export function placeOutside(card: DOMRect, button: DOMRect, preferredWidth: number, height?: number): OutsidePlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(preferredWidth, vw - MARGIN * 2);
  const mid = button.left + button.width / 2;
  const left = Math.max(MARGIN, Math.min(mid - width / 2, vw - width - MARGIN));
  const tipX = Math.max(left + 18, Math.min(mid, left + width - 18));
  const need = height ?? COMFORTABLE;
  const below = vh - card.bottom - OUTSIDE_GAP - MARGIN;
  const above = card.top - OUTSIDE_GAP - MARGIN;
  const asBelow = (maxHeight: number, short?: number): OutsidePlacement => ({ left, width, top: card.bottom + OUTSIDE_GAP, maxHeight, side: 'below', tipX, tipY: card.bottom + OUTSIDE_GAP, short });
  const asAbove = (maxHeight: number, short?: number): OutsidePlacement => ({ left, width, bottom: vh - card.top + OUTSIDE_GAP, maxHeight, side: 'above', tipX, tipY: card.top - OUTSIDE_GAP, short });
  if (below >= need) return asBelow(below);
  if (above >= need) return asAbove(above);
  const short = need - below;
  if (Math.max(below, above) >= MIN_OUTSIDE) return below >= above ? asBelow(below, short) : asAbove(above, short);
  return { ...placePopup(button, preferredWidth, height), side: 'over', short };
}

/** The nearest ancestor that scrolls up and down, or the page itself. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if ((y === 'auto' || y === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** The popup panel's position, size and scrolling, for its style prop. */
export function popupStyle(p: PopupPlacement): React.CSSProperties {
  return { left: p.left, width: p.width, top: p.top, bottom: p.bottom, maxHeight: p.maxHeight, overflowY: 'auto' };
}

/**
 * Place the popup again once it is drawn, and whenever its content changes
 * height (loading, a result appearing) - `replace` re-runs the component's own
 * placement, which reads the panel's height. With `close`, a TV remote stays
 * inside the popup while it is open and Back closes it (useTVModal).
 */
function noop() {}

export function useFitPopup(panel: React.RefObject<HTMLElement | null>, open: boolean, replace: () => void, close?: () => void) {
  const isTV = useIsTV();
  useTVModal(isTV && open && !!close, panel, close || noop);
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

/**
 * Place an open popup again when what it hangs off moves without the page
 * scrolling or resizing: the top bar growing back as the page reaches the top
 * pushes everything under it down over a few hundred milliseconds, and the
 * popup stayed where it was (on its card). Checks once a frame while open and
 * places again only after a move.
 */
export function useFollowAnchor(open: boolean, where: () => (DOMRect | null)[], replace: () => void) {
  useEffect(() => {
    if (!open || typeof requestAnimationFrame === 'undefined') return;
    let last = '';
    let frame = requestAnimationFrame(function tick() {
      const now = where().map((r) => (r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.bottom)}` : '-')).join('|');
      if (last && now !== last) replace();
      last = now;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
