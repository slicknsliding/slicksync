'use client';

// Effects (Themes → Layout → Effects): the small motions that answer a press,
// a removal, a cleared list, a pop-up, a finished sync and a switch. Each has
// its own switch, saved to the account in the arrangement; everything is on by
// default. They are all off on a TV, and whenever motion
// is Reduced (the account's choice, or the device's when the account follows
// it).
//
// The stylesheet reads <html data-fx-off="..."> (the ones switched off); the
// helpers here read the same attribute, so a component never needs the
// arrangement to know whether to move.

import { useEffect, useLayoutEffect, type RefObject } from 'react';

export const EFFECTS = [
  { id: 'press', title: 'Pressing things', line: 'Cards that open and buttons dip while you press them', on: true },
  { id: 'remove', title: 'Removing and putting back', line: 'Cards shrink away, the rest glide over, and a ring shows what came back', on: true },
  { id: 'clear', title: 'Clearing lists', line: 'Notifications sweep away and a tick confirms it', on: true },
  { id: 'popups', title: 'Pop-ups', line: 'Pop-ups that open from a pill grow out of its pointer', on: true },
  { id: 'sync', title: 'Sync result', line: 'One ring on the dot when a sync lands, one nudge when it can’t', on: true },
  { id: 'switches', title: 'Sliding switches', line: 'The highlight slides to your choice', on: true },
  { id: 'loading', title: 'Opening a page', line: 'The new page glides up into place, and a thin line shows across the top when it is slow. Nothing fades or dims', on: true },
  { id: 'vibrate', title: 'Vibrate on Android phones', line: 'A tiny buzz on press-and-hold and on deleting. iPhones don’t allow it', on: true },
  { id: 'splash', title: 'Opening the app', line: 'The SlickSync mark comes together, then moves into its place on the page. Once each time the app starts', on: true },
  { id: 'numbers', title: 'Counting numbers', line: 'Big figures roll up when a page opens and roll over when they change', on: true },
  { id: 'nowplaying', title: 'Now Playing', line: 'Banners slide in and out as people start and stop, and the progress bar moves smoothly', on: true },
] as const;

export type EffectId = typeof EFFECTS[number]['id'];
export type EffectChoices = Partial<Record<EffectId, boolean>>;

const DEFAULTS = Object.fromEntries(EFFECTS.map((e) => [e.id, e.on])) as Record<EffectId, boolean>;

/** A saved choice, or the default. */
export function effectChoice(saved: EffectChoices | undefined, id: EffectId): boolean {
  const v = saved?.[id];
  return typeof v === 'boolean' ? v : DEFAULTS[id];
}

/** The saved choices with one changed; only what differs from the default is kept. */
export function withEffect(saved: EffectChoices | undefined, id: EffectId, on: boolean): EffectChoices | undefined {
  const out: EffectChoices = { ...(saved || {}) };
  if (on === DEFAULTS[id]) delete out[id]; else out[id] = on;
  return Object.keys(out).length ? out : undefined;
}

function deviceReduces(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Writes the choices onto <html> for the stylesheet and for fxOn. Returns the undo. */
export function applyEffects(saved: EffectChoices | undefined, motion: 'reduced' | 'full' | undefined): () => void {
  const root = document.documentElement;
  const write = () => {
    const still = motion === 'reduced' || (motion !== 'full' && deviceReduces());
    const off = EFFECTS.filter((e) => still || !effectChoice(saved, e.id)).map((e) => e.id);
    if (off.length) root.setAttribute('data-fx-off', off.join(' ')); else root.removeAttribute('data-fx-off');
  };
  write();
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  media?.addEventListener?.('change', write);
  return () => { media?.removeEventListener?.('change', write); root.removeAttribute('data-fx-off'); };
}

/** Is this effect on, here and now? Never on a TV. */
export function fxOn(id: EffectId): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  if (root.hasAttribute('data-tv')) return false;
  const off = root.getAttribute('data-fx-off');
  if (off === null) return DEFAULTS[id] && !(root.dataset.motion !== 'full' && (root.dataset.motion === 'reduced' || deviceReduces()));
  return !off.split(' ').includes(id);
}

/** A tiny buzz, where the phone allows it and the switch is on. */
export function fxBuzz(ms = 10): void {
  if (!fxOn('vibrate')) return;
  try { navigator.vibrate?.(ms); } catch { /* not allowed here */ }
}

const canAnimate = (el: Element | null | undefined): el is HTMLElement => !!el && typeof (el as HTMLElement).animate === 'function';

function finished(a: Animation): Promise<void> {
  return new Promise((resolve) => { a.onfinish = () => resolve(); a.oncancel = () => resolve(); });
}

/**
 * A row leaving a list for good: 'away' slides it off to the side (it went
 * back where it came from), 'gone' tints it red (deleted). Either way it then
 * closes up so the rows under it rise instead of jumping. Resolves when the
 * row can be taken out; straight away when the effect is off.
 */
export async function fxLeaveRow(el: HTMLElement | null | undefined, how: 'away' | 'gone'): Promise<void> {
  if (!canAnimate(el) || !fxOn('remove')) return;
  const height = el.offsetHeight;
  const next = el.nextElementSibling as HTMLElement | null;
  const gap = next ? parseFloat(getComputedStyle(next).marginTop) || 0 : (el.previousElementSibling ? parseFloat(getComputedStyle(el).marginTop) || 0 : 0);
  const red = 'color-mix(in srgb, var(--color-error, #ef4444) 16%, transparent)';
  el.style.pointerEvents = 'none';
  await finished(el.animate(
    how === 'away' ? [{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }] : [{ background: red, opacity: 1 }, { background: red, opacity: 0.35 }],
    { duration: 150, easing: 'ease-in', fill: 'forwards' },
  ));
  el.style.overflow = 'hidden';
  await finished(el.animate(
    [{ height: `${height}px`, opacity: how === 'away' ? 0 : 0.35 }, { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: `${-gap}px`, opacity: 0 }],
    { duration: 190, easing: 'ease-in', fill: 'forwards' },
  ));
}

/**
 * A pop-up that opens from a pill grows out of its pointer and, when it
 * closes, a copy of it fades away a little faster. `origin` is where the
 * pointer touches the panel, as a CSS transform-origin.
 */
export function usePopEffect(ref: RefObject<HTMLElement | null>, shown: boolean, origin?: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !canAnimate(el) || !fxOn('popups')) return;
    if (origin) el.style.transformOrigin = origin;
    const opening = el.animate(
      [{ opacity: 0, transform: 'scale(0.94) translateY(-4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 130, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)' },
    );
    const born = performance.now();
    return () => {
      opening.cancel();
      // Too young to have been seen (a remount): nothing to fade.
      if (performance.now() - born < 180 || !fxOn('popups')) return;
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('role');
      ghost.removeAttribute('aria-label');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.style.pointerEvents = 'none';
      document.body.appendChild(ghost);
      const done = () => ghost.remove();
      const closing = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 90, easing: 'ease-in', fill: 'forwards' });
      closing.onfinish = done;
      closing.oncancel = done;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening; the origin is read as it opens
  }, [shown]);
}

type Spot = { left: number; top: number; width: number; height: number };
// Longer lists are left alone: measuring every row on each change would cost more than the glide is worth.
const MAX_LIST = 150;

/**
 * A grid or list of v2 cards: when one or a few leave, they shrink away and
 * the rest glide over to close the gap; when one arrives among others (an
 * Undo, a new one), the rest make room and a ring marks it for a moment.
 * Anything bigger - a filter, a sort, a drag, the first load - is left alone.
 */
export function useListEffect(ref: RefObject<HTMLElement | null>, every = false, kind: 'list' | 'playing' = 'list') {
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof MutationObserver === 'undefined') return;
    // `every`: a Classic list, where each child is an item and a removed one
    // has already faded out by itself.
    const isItem = (c: Node): c is HTMLElement => c instanceof HTMLElement && (every || c.hasAttribute('data-v2-item'));
    const items = () => (box.children.length > MAX_LIST ? [] : Array.from(box.children).filter(isItem));
    let spots = new Map<Element, Spot>();
    const snap = () => {
      const b = box.getBoundingClientRect();
      spots = new Map(items().map((el) => { const r = el.getBoundingClientRect(); return [el, { left: r.left - b.left, top: r.top - b.top, width: r.width, height: r.height }]; }));
    };
    snap();

    const onChange = (records: MutationRecord[]) => {
      const before = spots;
      const added = new Set<HTMLElement>();
      const removed = new Set<HTMLElement>();
      for (const rec of records) {
        if (rec.target !== box) continue;
        rec.addedNodes.forEach((n) => { if (isItem(n)) added.add(n); });
        rec.removedNodes.forEach((n) => { if (isItem(n)) removed.add(n); });
      }
      snap();
      if (!added.size && !removed.size) return;
      // A card taken out and put back is a move (a sort, a drop), not a removal.
      const moved = [...removed].some((n) => n.isConnected) || [...added].some((n) => before.has(n));
      // `playing`: the Now Playing banners, where the first one to arrive drops in as well.
      const playing = kind === 'playing';
      const small = (added.size === 1 && !removed.size && (before.size > 0 || playing)) || (removed.size <= 3 && !added.size);
      if (moved || !small || !fxOn(playing ? 'nowplaying' : 'remove')) return;

      const b = box.getBoundingClientRect();
      for (const gone of removed) {
        const was = before.get(gone);
        if (!was || every) continue;
        // The card is out of the page already: it shrinks away from a holder
        // that stands where it stood and dresses it as the grid did.
        const holder = document.createElement('div');
        holder.className = box.className;
        for (const a of Array.from(box.attributes)) if (a.name.startsWith('data-')) holder.setAttribute(a.name, a.value);
        holder.setAttribute('aria-hidden', 'true');
        holder.setAttribute('inert', '');
        holder.style.cssText = `position:fixed;left:${b.left + was.left}px;top:${b.top + was.top}px;width:${was.width}px;height:${was.height}px;display:block;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none;z-index:40;`;
        gone.style.transform = '';
        holder.appendChild(gone);
        document.body.appendChild(holder);
        const done = () => holder.remove();
        const leaving = holder.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.92)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
        leaving.onfinish = done;
        leaving.oncancel = done;
      }
      for (const [el, now] of spots) {
        const was = before.get(el);
        if (!was || !canAnimate(el)) continue;
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', delay: removed.size && !every ? 110 : 0, fill: 'backwards' });
      }
      for (const el of added) {
        if (!canAnimate(el)) continue;
        if (playing) {
          el.animate([{ opacity: 0, transform: 'translateY(-18px) scale(0.94)' }, { opacity: 1, offset: 0.3 }, { opacity: 1, transform: 'none' }], { duration: 340, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)' });
          continue;
        }
        el.animate([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
        el.setAttribute('data-fx-back', '');
        window.setTimeout(() => el.removeAttribute('data-fx-back'), 1500);
      }
    };

    const watch = new MutationObserver(onChange);
    watch.observe(box, { childList: true });
    // A resize or a card changing height moves cards without adding or removing any.
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(snap) : null;
    resize?.observe(box);
    return () => { watch.disconnect(); resize?.disconnect(); };
  }, [ref, every, kind]);
}

/**
 * The several-way switches (.menu-seg): the highlight slides to the choice
 * just picked. It is drawn only while it slides - before and after, the
 * chosen button carries its own highlight - so nothing can be left out of
 * place by a resize or a value changed from elsewhere.
 */
export function watchSwitches(): () => void {
  const timers = new WeakMap<HTMLElement, number>();
  const onClick = (e: MouseEvent) => {
    const seg = (e.target as HTMLElement | null)?.closest?.('.menu-seg') as HTMLElement | null;
    if (!seg || !fxOn('switches')) return;
    const from = seg.querySelector<HTMLElement>(':scope > button.on');
    if (!from) return;
    const start = { x: from.offsetLeft, w: from.offsetWidth };
    // After the page has redrawn with the new choice.
    requestAnimationFrame(() => {
      const to = seg.querySelector<HTMLElement>(':scope > button.on');
      if (!to || !seg.isConnected || (to.offsetLeft === start.x && to.offsetWidth === start.w)) return;
      seg.style.setProperty('--seg-x', `${start.x}px`);
      seg.style.setProperty('--seg-w', `${start.w}px`);
      seg.removeAttribute('data-fx-slide');
      seg.setAttribute('data-fx-thumb', '');
      void seg.offsetWidth;
      seg.setAttribute('data-fx-slide', '');
      seg.style.setProperty('--seg-x', `${to.offsetLeft}px`);
      seg.style.setProperty('--seg-w', `${to.offsetWidth}px`);
      window.clearTimeout(timers.get(seg));
      timers.set(seg, window.setTimeout(() => { seg.removeAttribute('data-fx-thumb'); seg.removeAttribute('data-fx-slide'); }, 200));
        });
  };
  // Capture: read where the highlight is before the page moves it.
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
