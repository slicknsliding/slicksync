'use client';

// Effects → Opening a page: the new page glides up into place (it never
// fades or dims), and a thin line runs across the top of the screen when a
// page takes longer than about half a second to open, so it reads as loading
// rather than stuck. Off unless it is switched on.

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fxOn } from '@/lib/effects';

const WAIT_MS = 500;
const GIVE_UP_MS = 12000;

export function LoadingLine() {
  const pathname = usePathname();
  const [on, setOn] = useState(false);
  const [seen, setSeen] = useState(pathname);
  const timers = useRef<number[]>([]);
  // The new page is here: the line goes.
  if (seen !== pathname) {
    setSeen(pathname);
    setOn(false);
  }
  const first = useRef(true);
  useEffect(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    if (first.current) { first.current = false; return; }
    if (!fxOn('loading')) return;
    // Movement only: the page is fully there from its first frame.
    document.querySelector<HTMLElement>('[data-page-content]')?.animate?.(
      [{ transform: 'translateY(10px)' }, { transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(0.16, 0.8, 0.24, 1)' },
    );
  }, [pathname]);
  useEffect(() => {
    const start = () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
      if (!fxOn('loading')) return;
      timers.current.push(window.setTimeout(() => setOn(true), WAIT_MS));
      // A change that never lands on another page (same page, cancelled).
      timers.current.push(window.setTimeout(() => setOn(false), GIVE_UP_MS));
    };
    window.addEventListener('slicksync:nav-start', start);
    return () => {
      window.removeEventListener('slicksync:nav-start', start);
      timers.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);
  return on ? <div className="fx-loadline" role="progressbar" aria-label="Loading the page" /> : null;
}
