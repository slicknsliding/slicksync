'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon } from '@heroicons/react/24/outline';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { fxBuzz } from '@/lib/effects';

/**
 * Back to top: a round button that slides in at the bottom corner once a page
 * is scrolled well down, and takes it back to the top. Hidden completely
 * until then (not just moved off the edge), so nothing sits in the corner of
 * a page that hasn't been scrolled.
 */
export function BackToTop() {
  const isTV = useIsTV();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (isTV) return;
    let frame = 0;
    const check = () => { frame = 0; setShow(window.scrollY > window.innerHeight * 1.5); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(check); };
    window.addEventListener('scroll', onScroll, { passive: true });
    check();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [isTV]);
  if (isTV) return null;
  return (
    <button
      type="button"
      // `fixed` by name as well: on touch screens a rule that enlarges icon buttons'
      // tap areas makes them position:relative unless they carry that class.
      className={`to-top fixed${show ? ' show' : ''}`}
      aria-label="Back to top"
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <ArrowUpIcon className="w-5 h-5" />
    </button>
  );
}

// How far the mark has to come down before letting go refreshes.
const LINE = 70;

/**
 * Pull down to refresh, for touch screens (the installed app has no reload
 * button): pulled from the very top of a page, the SlickSync mark comes down
 * with the finger, turning; let go past the line and the page reloads. It
 * leaves alone anything that scrolls by itself, open windows and menus,
 * sideways swipes and drags.
 */
export function PullRefresh() {
  const isTV = useIsTV();
  const mark = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isTV || typeof window === 'undefined' || !('ontouchstart' in window)) return;
    const el = mark.current;
    if (!el) return;
    const root = document.documentElement;
    // The browser's own pull-to-refresh (Chrome on Android) would run as well.
    root.setAttribute('data-pull', '');
    let y0 = 0, x0 = 0, on = false, pull = 0, busy = false;
    const badge = el.firstElementChild as HTMLElement;
    const place = (p: number, moving: boolean) => {
      el.style.transition = moving ? 'none' : '';
      el.style.transform = `translate(-50%, ${Math.min(p - 56, 22)}px)`;
      badge.style.rotate = `${p * 3}deg`;
      el.classList.toggle('armed', p >= LINE);
    };
    const start = (e: TouchEvent) => {
      on = false;
      if (busy || e.touches.length !== 1 || window.scrollY > 0) return;
      const t = e.target as Element | null;
      if (!t?.closest || t.closest('[role="dialog"], [role="menu"], .popup-panel, input, textarea, select, [aria-roledescription="sortable"], [data-no-pull]')) return;
      // Something under the finger that is itself scrolled down: that scrolls first.
      for (let a: Element | null = t; a && a !== document.body; a = a.parentElement) {
        if (a.scrollTop > 0) return;
      }
      if (document.querySelector('[aria-roledescription="sortable"][aria-pressed="true"]')) return;
      on = true; pull = 0;
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    };
    const move = (e: TouchEvent) => {
      if (!on) return;
      const dy = e.touches[0].clientY - y0;
      const dx = e.touches[0].clientX - x0;
      if (dy <= 0 || (pull === 0 && Math.abs(dx) > Math.abs(dy)) || window.scrollY > 0) { on = pull > 0 && dy > 0; if (!on) place(0, false); return; }
      const was = pull;
      pull = dy * 0.5;
      // Effects → Vibrate: a tiny buzz the moment the pull is far enough.
      if (was < LINE && pull >= LINE) fxBuzz();
      place(pull, true);
    };
    const end = () => {
      if (!on) return;
      on = false;
      if (pull < LINE) { pull = 0; place(0, false); return; }
      busy = true;
      el.style.transition = '';
      el.style.transform = 'translate(-50%, 14px)';
      el.classList.add('spin');
      window.setTimeout(() => window.location.reload(), 350);
    };
    // Heard on the way down (capture): parts of some pages keep their touches
    // to themselves, and the pull has to work wherever the finger lands.
    const opts = { passive: true, capture: true } as const;
    window.addEventListener('touchstart', start, opts);
    window.addEventListener('touchmove', move, opts);
    window.addEventListener('touchend', end, opts);
    // A pull the phone itself interrupted is put back, never acted on.
    const cancel = () => { if (!on) return; on = false; pull = 0; place(0, false); };
    window.addEventListener('touchcancel', cancel, opts);
    return () => {
      root.removeAttribute('data-pull');
      window.removeEventListener('touchstart', start, opts);
      window.removeEventListener('touchmove', move, opts);
      window.removeEventListener('touchend', end, opts);
      window.removeEventListener('touchcancel', cancel, opts);
    };
  }, [isTV]);
  if (isTV) return null;
  return (
    <div ref={mark} className="pull-mark" aria-hidden="true">
      <span className="pull-badge">
        <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
          <g fill="none" stroke="#ffffff" strokeWidth={18} strokeLinecap="round">
            <rect x="30" y="65" width="90" height="50" rx="25" transform="rotate(-35 75 90)" />
            <rect x="80" y="85" width="90" height="50" rx="25" transform="rotate(-35 125 110)" />
          </g>
        </svg>
      </span>
    </div>
  );
}
