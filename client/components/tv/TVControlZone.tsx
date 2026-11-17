'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { initSpatialNav } from './spatialInit';
import { ARROWS, controls, fieldKeepsArrow, focusStop, tvModalOpen } from './useTVModal';

// TV only: a whole area of ordinary buttons, switches, pickers and fields (the
// Settings tabs) as ONE remote stop. Wrapping each control in a TVFocusable
// would miss whatever is added later; this finds the controls as they are, on
// every press.
//
// The page's remote reaches the area like any other stop (Right from a tab).
// Once there, a listener on document moves focus between the area's own
// controls by where they sit - a row at a time up and down, along the row left
// and right - and stops the press there: the page's remote listens on window
// and would move as well, and it cancels Enter's default action, so OK would
// never press anything (learned on the bell rows). OK does what a click does.
// Left off the start of a row, or Back, returns to the stop the area belongs
// to (its tab). Up off the top row goes on to the page's remote, to whatever
// sits above. An open window (Modal) keeps the keys to itself.

type Dir = 'up' | 'down' | 'left' | 'right';
type Box = { x: number; y: number; w: number; h: number };
type Stop = { el: HTMLElement; b: Box };
/** Where the remote last was in a tab: the control, and its middle on the page. */
type Spot = { el: HTMLElement; x: number; y: number };

const box = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
const cx = (b: Box) => b.x + b.w / 2;
const overlapsV = (a: Box, b: Box) => b.y < a.y + a.h && b.y + b.h > a.y;

/** The next control that way. Up and Down go a row at a time, to the control
 *  in that row most in line with this one, so nothing is skipped; Left and
 *  Right stay in the row. */
function pick(from: Box, list: Stop[], dir: Dir): Stop | null {
  const c = list.filter(({ b }) => (
    dir === 'down' ? b.y >= from.y + from.h - 4
      : dir === 'up' ? b.y + b.h <= from.y + 4
        : dir === 'right' ? cx(b) > cx(from) + 1 && overlapsV(from, b)
          : cx(b) < cx(from) - 1 && overlapsV(from, b)));
  if (!c.length) return null;
  if (dir === 'up' || dir === 'down') {
    const gap = (b: Box) => (dir === 'down' ? b.y - (from.y + from.h) : from.y - (b.y + b.h));
    const near = c.reduce((m, o) => (gap(o.b) < gap(m.b) ? o : m)).b;
    const row = c.filter(({ b }) => (dir === 'down' ? b.y < near.y + near.h / 2 : b.y + b.h > near.y + near.h / 2));
    const side = (b: Box) => Math.max(0, b.x - (from.x + from.w), from.x - (b.x + b.w));
    // Of those in line, the one most squarely above/below (a switch under a
    // small button goes to the button, not the wide field touching its edge);
    // a row of equals, from something wider, starts at its left.
    const share = (b: Box) => Math.max(0, Math.min(b.x + b.w, from.x + from.w) - Math.max(b.x, from.x)) / Math.max(1, Math.min(b.w, from.w));
    return row.sort((p, q) => side(p.b) - side(q.b) || share(q.b) - share(p.b) || p.b.x - q.b.x)[0];
  }
  const gap = (b: Box) => Math.abs(cx(b) - cx(from));
  const mid = (b: Box) => b.y + b.h / 2;
  return c.sort((p, q) => gap(p.b) - gap(q.b) || Math.abs(mid(p.b) - mid(from)) - Math.abs(mid(q.b) - mid(from)))[0];
}

function stops(zone: HTMLElement, except?: HTMLElement): Stop[] {
  return controls(zone)
    .filter((el) => !except || (el !== except && !except.contains(el) && !el.contains(except)))
    .map((el) => ({ el, b: box(el) }));
}

/** A control that went away (a button that became another, a list that
 *  closed): the nearest one at or above where it was, so the remote stays put. */
function nearest(list: HTMLElement[], spot: Spot): HTMLElement | null {
  const at = list.map((el) => { const b = box(el); return { el, x: cx(b) + scrollX, y: b.y + b.h / 2 + scrollY }; });
  const above = at.filter((o) => o.y <= spot.y + 4);
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const o of above.length ? above : at) {
    const d = Math.hypot(o.x - spot.x, o.y - spot.y);
    if (d < bestD) { bestD = d; best = o.el; }
  }
  return best;
}

/** Each zone's way back to its tab, by focus key - for the remote's Back. */
const zones = new Map<string, () => void>();

/** The remote's Back while in a zone: back to the stop it belongs to. */
export function leaveTVZone(): boolean {
  let key = '';
  try { key = getCurrentFocusKey(); } catch {}
  const leave = zones.get(key);
  if (!leave) return false;
  leave();
  return true;
}

interface ZoneProps {
  /** The zone's own remote stop. */
  focusKey: string;
  /** Where Left off a row's start, and Back, go: the stop this area belongs to. */
  backKey: string;
  /** What the last-used control is remembered under (the tab shown). */
  memoryKey: string;
  children: ReactNode;
}

function Zone({ focusKey, backKey, memoryKey, children }: ZoneProps) {
  initSpatialNav();
  const state = useRef({ backKey, memoryKey, last: new Map<string, Spot>(), pointerAt: 0 });
  useEffect(() => {
    state.current.backKey = backKey;
    state.current.memoryKey = memoryKey;
  }, [backKey, memoryKey]);

  const { ref } = useFocusable<object, HTMLDivElement>({
    focusKey,
    onFocus: () => land(),
    // Leaving for any other stop drops the area's own focus, so only one ring shows.
    onBlur: () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && ref.current?.contains(a)) a.blur();
    },
  });

  /** Into the area: the control already focused (clicked, or back from a
   *  window), else the one last used in this tab, else the first at the top. */
  function land() {
    const zone = ref.current;
    if (!zone) return;
    const list = controls(zone);
    const a = document.activeElement as HTMLElement | null;
    if (a && list.includes(a)) { focusStop(a); return; }
    const spot = state.current.last.get(state.current.memoryKey);
    let el: HTMLElement | null = null;
    if (spot) el = list.includes(spot.el) ? spot.el : nearest(list, spot);
    else {
      const z = box(zone);
      el = pick({ x: z.x, y: z.y - 10, w: z.w, h: 0 }, list.map((c) => ({ el: c, b: box(c) })), 'down')?.el ?? null;
    }
    if (el) focusStop(el);
  }

  function leave() {
    const a = document.activeElement as HTMLElement | null;
    if (a && ref.current?.contains(a)) a.blur();
    try { setFocus(state.current.backKey); } catch {}
  }

  const leaveRef = useRef(leave);
  const landRef = useRef(land);
  useEffect(() => { leaveRef.current = leave; landRef.current = land; });

  useEffect(() => {
    const zone = ref.current;
    if (!zone) return;
    const s = state.current;
    const current = () => { try { return getCurrentFocusKey() === focusKey; } catch { return false; } };
    zones.set(focusKey, () => leaveRef.current());

    const onPointerDown = () => { s.pointerAt = Date.now(); };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (el === zone) return;
      const b = box(el);
      s.last.set(s.memoryKey, { el, x: cx(b) + scrollX, y: b.y + b.h / 2 + scrollY });
      // Clicked with a pointer while the remote was elsewhere: it carries on from here.
      if (Date.now() - s.pointerAt < 1000 && !current() && !tvModalOpen()) { try { setFocus(focusKey); } catch {} }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      // The control went away under the remote: land on the nearest one.
      setTimeout(() => {
        const a = document.activeElement;
        if ((a && a !== document.body) || !current() || tvModalOpen() || Date.now() - s.pointerAt < 1000) return;
        landRef.current();
      }, 0);
    };

    const onKey = (e: KeyboardEvent) => {
      if (!current() || tvModalOpen()) return;
      const dir = ARROWS[e.key];
      const enter = e.key === 'Enter';
      const back = e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack';
      if (!dir && !enter && !back) return;
      const target = e.target as HTMLElement | null;
      if (!target || target === zone || !zone.contains(target)) {
        // Nothing has focus (it went away): the press lands back in the area.
        if (target && target !== document.body && target !== document.documentElement && target !== zone) return;
        e.stopPropagation();
        e.preventDefault();
        if (back) leaveRef.current();
        else landRef.current();
        return;
      }
      if (back) {
        // A control that uses Escape itself (closing its own list) keeps it.
        if (e.defaultPrevented) return;
        e.stopPropagation();
        e.preventDefault();
        leaveRef.current();
        return;
      }
      if (enter) {
        // Never on to the page's remote, which would cancel the press.
        e.stopPropagation();
        if (e.defaultPrevented) return;
        // OK on a tick box or a choice ticks it, like Space would.
        if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
          e.preventDefault();
          target.click();
          return;
        }
        // A dropdown or color picker opens its own list.
        if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === 'color')) {
          const field = target as HTMLElement & { showPicker?: () => void };
          try {
            if (field.showPicker) { field.showPicker(); e.preventDefault(); }
          } catch {}
        }
        return;
      }
      if (e.defaultPrevented || fieldKeepsArrow(target, dir)) { e.stopPropagation(); return; }
      const next = pick(box(target), stops(zone, target), dir);
      if (next) {
        e.stopPropagation();
        e.preventDefault();
        focusStop(next.el);
        return;
      }
      // Up off the top row: on to the page's remote, to whatever is above.
      if (dir === 'up') return;
      e.stopPropagation();
      e.preventDefault();
      if (dir === 'left') leaveRef.current();
    };

    zone.addEventListener('pointerdown', onPointerDown, true);
    zone.addEventListener('focusin', onFocusIn);
    zone.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKey);
    return () => {
      zones.delete(focusKey);
      zone.removeEventListener('pointerdown', onPointerDown, true);
      zone.removeEventListener('focusin', onFocusIn);
      zone.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKey);
    };
  }, [focusKey, ref]);

  return <div ref={ref} data-tv-zone="">{children}</div>;
}

/** On a TV, the area is one remote stop moving between its own controls (see
 *  above); anywhere else it is just its children. */
export function TVControlZone({ enabled, ...props }: ZoneProps & { enabled: boolean }) {
  return enabled ? <Zone {...props} /> : <>{props.children}</>;
}
