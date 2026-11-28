// Effects → Card to page: opening a person from Users, their card grows into
// the top of their page, and goes back into the card when you come back.
//
// Nothing on the pages drives this. The click that opens a person is seen
// from the outside (components/layout/ScrollToTopOnNavigate), the top of the
// person's page carries `data-fx-person-head`, and the two outlines are joined
// by moving and scaling whichever one is arriving. Only a transform changes:
// nothing fades, and the page underneath is never dimmed.

import { fxOn } from '@/lib/effects';

const FRESH_MS = 4000;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

type Outline = { left: number; top: number; width: number; height: number; at: number };

let card: Outline | null = null;
let head: Outline | null = null;
let poll = 0;

const outlineOf = (el: Element): Outline => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, at: performance.now() };
};

// Start `el` at `from`'s outline and let it settle where it really is.
function arrive(el: HTMLElement, from: Outline, ms: number): void {
  if (typeof el.animate !== 'function') return;
  const to = el.getBoundingClientRect();
  if (to.width < 1 || to.height < 1) return;
  const start = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  el.animate(
    [{ transformOrigin: '0 0', transform: start }, { transformOrigin: '0 0', transform: 'none' }],
    { duration: ms, easing: EASE },
  );
}

/** A person's card was clicked: remember its outline and watch for their page's top to appear. */
export function noteCardClick(cardEl: HTMLElement): void {
  if (!fxOn('cardpage')) return;
  card = outlineOf(cardEl);
  cancelAnimationFrame(poll);
  const started = card.at;
  const look = () => {
    if (!card || card.at !== started || performance.now() - started > FRESH_MS) return;
    const el = document.querySelector<HTMLElement>('[data-fx-person-head]');
    // The list is still on screen until the new page draws.
    if (!el || el.getClientRects().length === 0) { poll = requestAnimationFrame(look); return; }
    const from = card;
    card = null;
    arrive(el, from, 300);
  };
  poll = requestAnimationFrame(look);
}

/** Going back: remember where the top of the person's page stood (call before the page changes). */
export function noteLeavingPerson(): void {
  const el = document.querySelector<HTMLElement>('[data-fx-person-head]');
  head = el && fxOn('cardpage') ? outlineOf(el) : null;
}

/** Back on the list with their card found again: it shrinks back from where the page's top stood. */
export function settleIntoCard(cardEl: HTMLElement): void {
  const from = head;
  head = null;
  if (!from || performance.now() - from.at > FRESH_MS || !fxOn('cardpage')) return;
  arrive(cardEl, from, 260);
}
