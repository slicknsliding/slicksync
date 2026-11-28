'use client';

import { useEffect } from 'react';
import { useIsTV } from '@/lib/hooks/useIsTV';

const WAIT_MS = 350;       // before the first one shows
const WARM_MS = 500;       // after one hides, the next shows at once for this long
const HOLD_MS = 450;       // press-and-hold on a touch screen
const LINGER_MS = 1600;    // how long it stays after the finger lifts
const GAP = 9;

/**
 * The app's own tooltip, for everything that carries a `title`: it appears
 * quickly under the thing it names, with a pointer touching it, and once one
 * is showing, moving to a neighbour switches at once. On a touch screen a
 * press-and-hold shows it (the browser's own label never appears there), and
 * that press does not also press the button. Keyboard focus shows it too.
 *
 * Nothing in the pages changes for this: the first time something with a
 * `title` is pointed at, its text is taken into `data-tip` so the browser's
 * own label does not also appear, and kept as its name for screen readers
 * when it has no other. One box is drawn for the whole app. Not on a TV.
 */
export function Tooltips() {
  const isTV = useIsTV();
  useEffect(() => {
    if (isTV) return;
    let box: HTMLDivElement | null = null;
    let on: HTMLElement | null = null;
    let timer = 0, cool = 0, linger = 0;
    let warm = false;
    let swallow = false;

    // The nearest thing that has a label, taking a `title` over on the way.
    const owner = (t: EventTarget | null): HTMLElement | null => {
      const el = t instanceof Element ? t.closest<HTMLElement>('[title], [data-tip]') : null;
      if (!el || el.closest('svg') || el instanceof HTMLIFrameElement) return null;
      const title = el.getAttribute('title');
      if (title !== null) {
        el.removeAttribute('title');
        if (title.trim()) {
          el.setAttribute('data-tip', title);
          // An icon-only button had its title as its only name.
          if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.textContent || '').trim()) el.setAttribute('aria-label', title);
        } else el.removeAttribute('data-tip');
      }
      return el.getAttribute('data-tip') ? el : null;
    };

    const hide = () => {
      window.clearTimeout(timer); window.clearTimeout(linger);
      if (!box) return;
      box.remove(); box = null; on = null;
      window.clearTimeout(cool);
      cool = window.setTimeout(() => { warm = false; }, WARM_MS);
    };

    const show = (el: HTMLElement) => {
      const text = el.getAttribute('data-tip');
      if (!text || !el.isConnected) return;
      if (!box) { box = document.createElement('div'); box.className = 'ss-tip'; box.setAttribute('role', 'tooltip'); document.body.appendChild(box); }
      box.textContent = text;
      on = el; warm = true;
      const r = el.getBoundingClientRect();
      const w = box.offsetWidth, h = box.offsetHeight;
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const below = r.bottom + GAP + h <= vh - 4 || r.top - GAP - h < 4;
      const cx = r.left + r.width / 2;
      const left = Math.max(6, Math.min(vw - w - 6, cx - w / 2));
      box.style.left = `${Math.round(left)}px`;
      box.style.top = `${Math.round(below ? r.bottom + GAP : r.top - GAP - h)}px`;
      box.toggleAttribute('data-above', !below);
      // The pointer stays on the thing itself even when the box had to shift.
      box.style.setProperty('--tip-x', `${Math.round(Math.max(10, Math.min(w - 10, cx - left)))}px`);
    };

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = owner(e.target);
      if (el === on) return;
      window.clearTimeout(timer);
      if (!el) { if (on) hide(); return; }
      window.clearTimeout(cool);
      if (warm) show(el); else timer = window.setTimeout(() => show(el), WAIT_MS);
    };
    const out = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (on && to && on.contains(to)) return;
      window.clearTimeout(timer);
      if (on) hide();
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') { hide(); return; }
      hide();
      const el = owner(e.target);
      if (!el) return;
      // Small things only (icon buttons, short labels): a card has its own
      // press-and-hold menu, and that must stay the only thing a hold does there.
      const r = el.getBoundingClientRect();
      if (r.height > 64 || r.width > 240) return;
      timer = window.setTimeout(() => { show(el); swallow = true; }, HOLD_MS);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      window.clearTimeout(timer);
      if (on) linger = window.setTimeout(hide, LINGER_MS);
      // The click that follows a hold belongs to the label, not the button.
      if (swallow) window.setTimeout(() => { swallow = false; }, 400);
    };
    const click = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault(); e.stopPropagation();
    };
    const moved = () => { window.clearTimeout(timer); if (on) hide(); };
    const focus = (e: FocusEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (!t || !t.matches(':focus-visible')) return;
      const el = owner(t);
      if (el) show(el);
    };
    const blur = () => { if (on) hide(); };
    const menu = (e: Event) => { if (swallow || on) e.preventDefault(); };

    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', moved, true);
    document.addEventListener('click', click, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('keydown', moved, true);
    document.addEventListener('contextmenu', menu, true);
    window.addEventListener('scroll', moved, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer); window.clearTimeout(cool); window.clearTimeout(linger);
      box?.remove();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', moved, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('keydown', moved, true);
      document.removeEventListener('contextmenu', menu, true);
      window.removeEventListener('scroll', moved, { capture: true });
    };
  }, [isTV]);
  return null;
}
