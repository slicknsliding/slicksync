'use client';

// A new page starts at the very top. Next.js only scrolls the new page's own
// content into view, which leaves the top bar (logo and menu) above the fold
// whenever you came from further down a page. A change of query only (a
// filter, a tab) keeps your place.
//
// Back and Forward put you back where you were. The browser's own attempt at
// that fails here: lists load after the page appears, so at the moment it
// tries, the page is still too short to scroll to the old spot. So the place
// is remembered per address (this tab only) and gone back to once the page
// has grown long enough, and the card that was opened is marked for a moment.

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { noteCardClick, noteLeavingPerson, settleIntoCard } from '@/lib/cardGrow';

const KEY = 'slicksync-scroll:';
const WAIT_MS = 4000;

type Place = { y: number; mark?: string };

const here = () => window.location.pathname + window.location.search;
const read = (at: string): Place | null => {
  try { const v = sessionStorage.getItem(KEY + at); return v ? JSON.parse(v) as Place : null; } catch { return null; }
};
const write = (at: string, place: Place) => {
  try { sessionStorage.setItem(KEY + at, JSON.stringify(place)); } catch { /* private window: no memory of it */ }
};

// What was clicked, in a form that can be found again on the same page later:
// a person's card by their id, anything else by where its link goes.
function markOf(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target : null;
  if (!el) return undefined;
  const card = el.closest('[data-peek-id]') || el.closest('.user-card, .v2-card, .v2-row')?.querySelector('[data-peek-id]');
  const id = card?.getAttribute('data-peek-id');
  if (id) return `id:${id}`;
  const href = el.closest('a[href]')?.getAttribute('href');
  return href && href.startsWith('/') ? `href:${href}` : undefined;
}

function findMark(mark: string): HTMLElement | null {
  const value = mark.slice(mark.indexOf(':') + 1).replace(/["\\]/g, '\\$&');
  if (mark.startsWith('id:')) {
    const el = document.querySelector<HTMLElement>(`[data-peek-id="${value}"]`);
    // The newer design carries the id on a hidden marker inside the card.
    return el?.hidden ? el.closest<HTMLElement>('.v2-card, .v2-row') || el.parentElement : el;
  }
  const link = document.querySelector<HTMLElement>(`a[href="${value}"]`);
  return link?.closest<HTMLElement>('.v2-card, [data-card]') || link;
}

export function ScrollToTopOnNavigate() {
  const pathname = usePathname();
  const first = useRef(true);
  const fromHistory = useRef(false);

  useEffect(() => {
    try { window.history.scrollRestoration = 'manual'; } catch { /* old browser: its own attempt stays */ }
    // Leaving a person's page this way: where its top stood, for the trip back into their card.
    const onPop = () => { fromHistory.current = true; noteLeavingPerson(); };
    // Where the page is, remembered as it settles and at the click that leaves it.
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      const at = here();
      timer = window.setTimeout(() => { if (here() === at) write(at, { ...(read(at) || {}), y: Math.round(window.scrollY) }); }, 140);
    };
    const onClick = (e: MouseEvent) => {
      const mark = markOf(e.target);
      if (!mark) return;
      write(here(), { y: Math.round(window.scrollY), mark });
      // A person's card: it grows into the top of their page (lib/cardGrow).
      if (mark.startsWith('id:')) { const el = findMark(mark); if (el) noteCardClick(el); }
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onClick, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!fromHistory.current) {
      // A link to a spot on the page (#section) goes there instead.
      if (window.location.hash) return;
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    fromHistory.current = false;
    const place = read(here());
    if (!place) return;
    // Wait for the page to be long enough, then go. Any scroll of the
    // reader's own in the meantime wins.
    const started = performance.now();
    let frame = 0;
    let given = false;
    const giveUp = () => { given = true; };
    window.addEventListener('wheel', giveUp, { passive: true, once: true });
    window.addEventListener('touchmove', giveUp, { passive: true, once: true });
    window.addEventListener('keydown', giveUp, { once: true });
    const done = () => {
      window.removeEventListener('wheel', giveUp);
      window.removeEventListener('touchmove', giveUp);
      window.removeEventListener('keydown', giveUp);
    };
    const tryIt = () => {
      if (given) { done(); return; }
      const room = document.documentElement.scrollHeight - window.innerHeight;
      const late = performance.now() - started > WAIT_MS;
      // Long enough to scroll to, and the card that was opened drawn again.
      const el = place.mark ? findMark(place.mark) : null;
      if ((room + 1 < place.y || (place.mark && !el)) && !late) { frame = requestAnimationFrame(tryIt); return; }
      done();
      if (place.y > 0) window.scrollTo({ top: Math.min(place.y, Math.max(0, room)), left: 0, behavior: 'instant' as ScrollBehavior });
      if (el) {
        settleIntoCard(el);
        el.classList.add('back-mark');
        window.setTimeout(() => el.classList.remove('back-mark'), 1400);
      }
    };
    frame = requestAnimationFrame(tryIt);
    return () => { cancelAnimationFrame(frame); done(); };
  }, [pathname]);

  return null;
}
