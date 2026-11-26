'use client';

import { useEffect, useRef } from 'react';

// The mark coming together, then the name: how long before it may leave.
const SHOW_MS = 650;
// How long to wait for the page's own logo to be there to travel to.
const WAIT_MS = 1500;
const EASE = 'cubic-bezier(0.3, 0.8, 0.3, 1)';

/**
 * The opening splash. Drawn by the server and shown by the stylesheet (only
 * when the script above asked for it), so it is there from the first paint;
 * this part ends it: the mark travels into its place in the page's bar while
 * the page glides up. With no logo on the page, it lifts away.
 */
export function SplashScreen() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const splash = box.current;
    if (!splash || !root.hasAttribute('data-splash')) return;
    let frame = 0;
    let over = false;
    const end = () => { over = true; root.removeAttribute('data-splash'); };
    const painted = performance.getEntriesByName?.('first-contentful-paint')[0]?.startTime ?? 0;
    const ready = painted + SHOW_MS;
    const giveUp = Math.max(performance.now(), ready) + WAIT_MS;

    const leave = (target: HTMLElement | null) => {
      const badge = splash.querySelector<HTMLElement>('.ss-splash-badge');
      const mid = splash.querySelector<HTMLElement>('.ss-splash-mid');
      if (!badge || !mid || !badge.animate) { end(); return; }
      splash.classList.add('clear');
      if (!target) {
        const up = mid.animate([{ transform: 'none' }, { transform: 'translateY(-70vh)' }], { duration: 280, easing: 'ease-in', fill: 'forwards' });
        up.onfinish = end; up.oncancel = end;
        return;
      }
      const a = badge.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      const scale = b.width / a.width;
      // The corner the mark lands with, in its own size before the shrink.
      const corner = (parseFloat(getComputedStyle(target).borderTopLeftRadius) || 16) / scale;
      target.style.visibility = 'hidden';
      document.querySelector<HTMLElement>('[data-page-content]')?.animate?.(
        [{ transform: 'translateY(12px)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(0.16, 0.8, 0.24, 1)' });
      const fly = badge.animate(
        [{ transform: 'none' }, { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${scale})`, borderRadius: `${corner}px` }],
        { duration: 320, easing: EASE, fill: 'forwards' });
      const done = () => { target.style.visibility = ''; end(); };
      fly.onfinish = done; fly.oncancel = done;
    };

    const look = () => {
      if (over) return;
      const now = performance.now();
      if (now < ready) { frame = requestAnimationFrame(look); return; }
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-fx-logo]')).find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null;
      if (!target && now < giveUp) { frame = requestAnimationFrame(look); return; }
      leave(target);
    };
    frame = requestAnimationFrame(look);
    return () => { cancelAnimationFrame(frame); };
  }, []);

  return (
    <div ref={box} className="ss-splash bg-page" aria-hidden="true">
      <div className="ss-splash-mid">
        <span className="ss-splash-badge">
          <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
            <g fill="none" stroke="#ffffff" strokeWidth={18} strokeLinecap="round">
              <g className="ss-splash-l1"><rect x="30" y="65" width="90" height="50" rx="25" transform="rotate(-35 75 90)" /></g>
              <g className="ss-splash-l2"><rect x="80" y="85" width="90" height="50" rx="25" transform="rotate(-35 125 110)" /></g>
            </g>
          </svg>
        </span>
        <span className="ss-splash-word font-display">SlickSync</span>
      </div>
    </div>
  );
}
