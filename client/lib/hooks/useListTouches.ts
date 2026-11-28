'use client';

// Two small touches for the list pages (Users, Groups, Addons).
//
// useWarmOnRest: a mouse resting on a person's or addon's card for a moment
// (or a finger touching it) starts fetching that page's details, so opening it
// is instant. One delegated listener on the list, not one per card. Never on a
// TV, and a mouse only for the hover - a finger skimming a long list is
// handled by touchstart on the one card it lands on.
//
// useArriveOnce: when a list first shows its cards after the page opens, the
// list gets `fx-arrive` for about 600ms (CSS in ideas-lists.css makes the first
// dozen rise in order). Once per visit - never on a filter, a sort, a refresh,
// or when coming back with the browser's Back button.

import { useEffect, type RefObject } from 'react';
import { fxOn } from '@/lib/effects';

const REST_MS = 120;

/** The id of the person or addon whose card this is: the one link to `${base}<id>` at or around the target. */
function idFromCard(target: EventTarget | null, base: string): string | null {
  let node: Element | null = target instanceof Element ? target : null;
  const idOf = (href: string | null) => (href && href.startsWith(base) ? href.slice(base.length).split(/[/?#]/)[0] : '');
  // Climb until a level holds links to exactly one id: that level is one card.
  for (let up = 0; node && up < 8; up++, node = node.parentElement) {
    const own = idOf(node.getAttribute('href'));
    if (own) return own;
    const ids = new Set<string>();
    node.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => { const id = idOf(a.getAttribute('href')); if (id) ids.add(id); });
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) return null;
  }
  return null;
}

export function useWarmOnRest(ref: RefObject<HTMLElement | null>, base: '/users/' | '/addons/', warm: (id: string) => void) {
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    if (document.documentElement.hasAttribute('data-tv')) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = (target: EventTarget | null) => { const id = idFromCard(target, base); if (id) warm(id); };
    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(timer);
      const t = e.target;
      timer = setTimeout(() => go(t), REST_MS);
    };
    const out = () => clearTimeout(timer);
    const touch = (e: TouchEvent) => go(e.target);
    box.addEventListener('pointerover', over);
    box.addEventListener('pointerout', out);
    box.addEventListener('touchstart', touch, { passive: true });
    return () => {
      clearTimeout(timer);
      box.removeEventListener('pointerover', over);
      box.removeEventListener('pointerout', out);
      box.removeEventListener('touchstart', touch);
    };
  }, [ref, base, warm]);
}

// Back and Forward fire popstate just before the page mounts; remember when.
let lastPopAt = -Infinity;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => { lastPopAt = performance.now(); });
}

export function useArriveOnce(ref: RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(() => {
    const box = ref.current;
    if (!box || !ready) return;
    // Already played (or skipped) for this visit.
    if (box.dataset.arrived) return;
    box.dataset.arrived = '1';
    if (!fxOn('arrive')) return;
    if (performance.now() - lastPopAt < 3000) return;
    box.classList.add('fx-arrive');
    // Not undone on cleanup: the timer alone takes the class off again.
    setTimeout(() => box.classList.remove('fx-arrive'), 650);
  }, [ref, ready]);
}
