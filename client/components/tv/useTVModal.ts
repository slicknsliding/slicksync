'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useIsTV } from '@/lib/hooks/useIsTV';

// TV only: keeps the remote inside an open window (Modal) whose controls are
// ordinary buttons and fields, not remote stops of their own.
//
// The page's remote navigation listens on window, after everything else, and
// would otherwise keep moving focus around the page behind the window - and
// it cancels Enter's default action, so OK never pressed a button inside it.
// While a window is open this listener (on document, so the window's own key
// handlers still run first) keeps arrows and OK from reaching it, moves focus
// between the window's controls by where they sit, and lets OK press the
// focused control the normal way. Escape closes the window as it always did;
// the remote's Back does the same through closeTopTVModal. When it closes,
// the remote goes back to the stop that opened it.
//
// A window that already has remote stops inside (the title window) is left to
// those - it is detected each key press, so content that loads later counts.

/** Set by Modal on a TV: its content is moved through as ordinary controls. */
export const TVModalContext = createContext(false);

/** Whether a control should be a remote stop of its own: on a TV, and not
 *  inside a window, where the window moves between ordinary controls itself
 *  (a remote stop inside would hand the window back to the page's remote). */
export function useTVStops(): boolean {
  const isTV = useIsTV();
  const inModal = useContext(TVModalContext);
  return isTV && !inModal;
}

type Entry = { close: () => void };
const stack: Entry[] = [];

/** The remote's Back: closes the top open window, if there is one. */
export function closeTopTVModal(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SAFE_WORDS = /^(cancel|keep|no\b|not now|close|back|stay)/i;
const RISKY_WORDS = /\b(delete|remove|disconnect|reset|revoke|erase|wipe|sign out|log out|leave|forget|unlink|clear)\b/i;

function controls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) =>
    el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
}

function label(el: HTMLElement) {
  return (el.textContent || el.getAttribute('aria-label') || '').trim();
}

/** Where the remote starts: what the window asks for, the safe choice when it
 *  asks something risky, else its first control other than the corner X. */
function firstStop(panel: HTMLElement): HTMLElement | null {
  const all = controls(panel);
  const asked = all.find((el) => el.hasAttribute('data-tv-initial'));
  if (asked) return asked;
  const buttons = all.filter((el) => el.tagName === 'BUTTON');
  if (buttons.some((el) => RISKY_WORDS.test(label(el)))) {
    const safe = buttons.find((el) => SAFE_WORDS.test(label(el)) && !el.classList.contains('modal-close-btn'));
    if (safe) return safe;
  }
  return all.find((el) => !el.classList.contains('modal-close-btn')) || all[0] || null;
}

/** The nearest control in that direction, by where they sit on screen. */
function nextStop(panel: HTMLElement, from: HTMLElement, dir: 'up' | 'down' | 'left' | 'right'): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of controls(panel)) {
    if (el === from || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    // Must actually lie that way: past the current control's edge (with a
    // little overlap allowed for rows that are not perfectly lined up).
    let main: number, side: number;
    if (dir === 'down') { if (b.top < a.bottom - 4) continue; main = b.top - a.bottom; side = Math.abs(bx - ax); }
    else if (dir === 'up') { if (b.bottom > a.top + 4) continue; main = a.top - b.bottom; side = Math.abs(bx - ax); }
    else if (dir === 'right') { if (b.left < a.right - 4) continue; main = b.left - a.right; side = Math.abs(by - ay); }
    else { if (b.right > a.left + 4) continue; main = a.left - b.right; side = Math.abs(by - ay); }
    // Same row/column first: sideways distance counts more than distance on.
    const score = Math.max(0, main) + side * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/** Fields keep the arrows they use for themselves (moving the cursor in text,
 *  a slider), until the cursor is already at that end. */
function fieldKeepsArrow(el: HTMLElement, dir: string): boolean {
  if (el instanceof HTMLTextAreaElement) {
    if (dir === 'up') return el.selectionStart !== 0;
    if (dir === 'down') return el.selectionEnd !== el.value.length;
    return true;
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === 'range') return dir === 'left' || dir === 'right';
    if (dir !== 'left' && dir !== 'right') return false;
    try {
      if (el.selectionStart === null) return false;
      return dir === 'left' ? el.selectionStart !== 0 : el.selectionEnd !== el.value.length;
    } catch { return false; }
  }
  return false;
}

const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Up: 'up', Down: 'down', Left: 'left', Right: 'right',
};

function focusStop(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
}

/** `closeOnEscape`: for a popup that has no Escape of its own (the poster
 *  menu) - Escape, like Back, closes it. */
export function useTVModal(active: boolean, panelRef: React.RefObject<HTMLElement | null>, onClose: () => void, closeOnEscape = false) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const entry: Entry = { close: () => closeRef.current() };
    stack.push(entry);
    let returnKey = '';
    try { returnKey = getCurrentFocusKey(); } catch {}
    let touched = false;
    const ownsKeys = () => {
      const panel = panelRef.current;
      // Only the top window, and only when it has no remote stops of its own.
      return !!panel && stack[stack.length - 1] === entry && !panel.querySelector('[data-tv-stop]') ? panel : null;
    };

    // The window's controls appear with it, or a moment later (opening
    // motion, data loading) - try a few times until someone presses a key.
    const timers = [30, 150, 320, 700].map((d) => setTimeout(() => {
      const panel = ownsKeys();
      if (!panel || touched) return;
      // The thick focus ring (globals.css).
      panel.setAttribute('data-tv-modal', '');
      if (panel.contains(document.activeElement) && document.activeElement !== panel && !(document.activeElement as HTMLElement).classList.contains('modal-close-btn')) return;
      const first = firstStop(panel);
      if (first) focusStop(first);
    }, d));

    const onKey = (e: KeyboardEvent) => {
      const panel = ownsKeys();
      if (!panel) return;
      if (closeOnEscape && e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      const dir = ARROWS[e.key];
      const enter = e.key === 'Enter';
      if (!dir && !enter) return;
      const target = e.target as HTMLElement | null;
      // A small question opened on top of the window (AnchoredConfirm) keeps
      // its own remote stops.
      const other = target?.closest?.('[role="dialog"]');
      if (other && !other.contains(panel) && !panel.contains(other)) return;
      touched = true;
      // Never on to the page's remote navigation behind the window.
      e.stopPropagation();
      const inside = !!target && panel.contains(target) && target !== panel;
      if (!inside) {
        e.preventDefault();
        const first = firstStop(panel);
        if (first) focusStop(first);
        return;
      }
      if (enter) {
        // OK on a tick box or a choice ticks it, like Space would.
        if (!e.defaultPrevented && target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
          e.preventDefault();
          target.click();
        }
        return;
      }
      if (e.defaultPrevented || fieldKeepsArrow(target, dir)) return;
      e.preventDefault();
      const next = nextStop(panel, target, dir);
      if (next) focusStop(next);
    };
    // A popup whose wrapper stops key events on their way up (LimitsButton,
    // CatchUpButton keep their keys from the card underneath) never lets them
    // reach the listener above. Seen on the way down instead, and moved on
    // here once the press is over if the listener above never got it. The
    // page's remote never sees such a press either.
    const reached = new WeakSet<KeyboardEvent>();
    const mark = (e: KeyboardEvent) => { reached.add(e); };
    const onKeyDown = (e: KeyboardEvent) => { mark(e); onKey(e); };
    const onCapture = (e: KeyboardEvent) => {
      if (!ARROWS[e.key] && e.key !== 'Enter' && !(e.key === 'Escape')) return;
      setTimeout(() => {
        if (reached.has(e) || !ownsKeys()) return;
        const target = e.target as HTMLElement | null;
        if (!target || !panelRef.current?.contains(target)) return;
        // Escape never got to the popup's own close either.
        if (e.key === 'Escape') { if (!e.defaultPrevented) closeRef.current(); return; }
        const dir = ARROWS[e.key];
        if (!dir || e.defaultPrevented || fieldKeepsArrow(target, dir)) return;
        touched = true;
        const next = nextStop(panelRef.current, target, dir);
        if (next) focusStop(next);
      }, 0);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onCapture, true);

    return () => {
      timers.forEach(clearTimeout);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onCapture, true);
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      // Back to the stop that opened it, once the window has let go of focus.
      setTimeout(() => {
        if (stack.length) return;
        const el = document.activeElement as HTMLElement | null;
        if (el && el !== document.body && !el.closest('[data-tv-stop]')) el.blur?.();
        if (returnKey) { try { setFocus(returnKey); } catch {} }
      }, 0);
    };
  }, [active, panelRef, closeOnEscape]);
}
