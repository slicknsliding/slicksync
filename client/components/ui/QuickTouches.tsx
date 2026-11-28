'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { fxOn } from '@/lib/effects';

/**
 * Offline strip: when the connection drops, a thin strip says so and that
 * what is on the page is from before; when it is back, the strip says so for
 * a moment and the page reloads itself. Without it pages just stop updating
 * and buttons fail, which looks like SlickSync is broken.
 */
export function OfflineStrip() {
  const [state, setState] = useState<'' | 'off' | 'back' | 'kept'>('');
  useEffect(() => {
    let timer = 0;
    let wasOff = false;
    // Someone in the middle of something: typing, or with a window or menu
    // open. A reload would throw that away, so the page is left as it is and
    // picks up fresh data on its own next refresh.
    const busy = () => {
      const a = document.activeElement;
      if (a instanceof HTMLElement && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return true;
      return !!document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]');
    };
    const off = () => { window.clearTimeout(timer); wasOff = true; setState('off'); };
    const on = () => {
      // Only after a drop this page saw; a stray "online" does nothing.
      if (!wasOff) return;
      wasOff = false;
      window.clearTimeout(timer);
      if (busy()) {
        setState('kept');
        timer = window.setTimeout(() => setState(''), 4000);
        return;
      }
      setState('back');
      timer = window.setTimeout(() => { if (navigator.onLine && !busy()) window.location.reload(); else setState(''); }, 1300);
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.clearTimeout(timer); window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);
  if (!state) return null;
  return (
    <div className={`offline-strip${state === 'off' ? '' : ' back'}`} role="status" aria-live="polite">
      {state === 'off'
        ? <span><b>You’re offline.</b> Showing what was here before.</span>
        : state === 'kept'
          ? <span><b>Back online.</b></span>
          : <span><b>Back online.</b> Refreshing…</span>}
    </div>
  );
}

/** Where `g` then a letter goes. */
export const JUMPS: { key: string; label: string; href: string }[] = [
  { key: 'd', label: 'Dashboard', href: '/' },
  { key: 'c', label: 'Activity', href: '/activity' },
  { key: 'u', label: 'Users', href: '/users' },
  { key: 'a', label: 'Addons', href: '/addons' },
  { key: 's', label: 'Settings', href: '/settings' },
];

const SHORTCUTS: [string, string[]][] = [
  ['Search and jump', ['Ctrl', 'K']],
  ['This list', ['?']],
  ['Search this page', ['/']],
  ['Close a window or menu', ['Esc']],
  ...JUMPS.map((j): [string, string[]] => [`Go to ${j.label}`, ['g', j.key]]),
];

/** Fired to open the shortcut sheet from elsewhere (the account menu). */
export const SHORTCUTS_EVENT = 'slicksync:shortcuts';

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * Keyboard, on a computer: `?` lists every shortcut, `g` then a letter goes
 * to a page, `/` puts the cursor in the page's search box. Nothing fires
 * while typing in a field, with a modifier key held, or over an open window.
 */
export function KeyboardNav() {
  const isTV = useIsTV();
  const router = useRouter();
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);

  // A new page: nothing is half-typed any more. (Set during render, React's
  // way of resetting state when something it depends on changes.)
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) { setSeenPath(pathname); setArmed(false); setSheet(false); }

  useEffect(() => {
    if (isTV) return;
    let timer = 0;
    const disarm = () => { armedAt.current = 0; setArmed(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === 'Escape') { setSheet(false); disarm(); return; }
      // Over an open window or menu the keys belong to it.
      if (document.querySelector('[role="dialog"]:not([data-shortcuts]), [role="menu"]')) return;
      if (e.key === '?') { e.preventDefault(); setSheet((v) => !v); disarm(); return; }
      if (e.key === '/') {
        const box = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="search"], input[placeholder*="earch"]')).find((i) => i.offsetParent !== null && !i.disabled);
        if (box) { e.preventDefault(); box.focus(); box.select(); }
        return;
      }
      if (e.key === 'g' && !e.shiftKey) {
        armedAt.current = Date.now();
        setArmed(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(disarm, 1500);
        return;
      }
      if (armedAt.current && Date.now() - armedAt.current < 1500) {
        const to = JUMPS.find((j) => j.key === e.key.toLowerCase());
        window.clearTimeout(timer);
        disarm();
        if (to) { e.preventDefault(); router.push(to.href); }
      }
    };
    const open = () => setSheet(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(SHORTCUTS_EVENT, open);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKey); window.removeEventListener(SHORTCUTS_EVENT, open); };
  }, [isTV, router]);

  if (isTV || typeof document === 'undefined' || (!sheet && !armed)) return null;
  return createPortal(
    <>
      {armed && !sheet && (
        <div className="popup-panel jump-chip" role="status">
          <b>g</b>, then {JUMPS.map((j, i) => <span key={j.key}>{i ? ' · ' : ''}<kbd>{j.key}</kbd> {j.label}</span>)}
        </div>
      )}
      {sheet && (
        <div className="shortcut-wrap" onClick={() => setSheet(false)}>
          <div className="popup-panel shortcut-sheet" role="dialog" aria-label="Keyboard shortcuts" data-shortcuts="" data-mh-off="" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-[17px] font-bold text-default mb-2.5">Keyboard shortcuts</p>
            <div className="shortcut-keys">
              {SHORTCUTS.map(([what, keys]) => (
                <div key={what}><span>{what}</span><span>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}

// How fast a long name slides, in pixels a second: the same on every screen.
const SLIDE_SPEED = 45;

/**
 * Long names that slide: resting the mouse on a name cut off with "…" slides
 * it sideways to show the rest, then back. Works on anything that is cut off
 * on one line; short names never move. Part of Effects (off with Reduced
 * motion and on a TV).
 */
export function LongNames() {
  useEffect(() => {
    let over: HTMLElement | null = null;
    let run: Animation | null = null;
    let timer = 0;
    const stop = () => {
      window.clearTimeout(timer);
      run?.cancel();
      run = null;
      if (over) { over.style.textOverflow = ''; over = null; }
    };
    const onOver = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>('.truncate, [data-slide-name]') : null;
      if (t === over) return;
      stop();
      if (!t || !t.animate || !fxOn('press')) return;
      const extra = t.scrollWidth - t.clientWidth;
      if (extra < 6 || getComputedStyle(t).whiteSpace !== 'nowrap') return;
      over = t;
      // A moment's rest first, so brushing past a row moves nothing.
      timer = window.setTimeout(() => {
        if (over !== t) return;
        const move = (extra + 10) / SLIDE_SPEED * 1000;
        const total = move * 2 + 2200;
        t.style.textOverflow = 'clip';
        run = t.animate(
          [{ textIndent: '0px', offset: 0 }, { textIndent: '0px', offset: 500 / total }, { textIndent: `-${extra + 10}px`, offset: (500 + move) / total }, { textIndent: `-${extra + 10}px`, offset: (1700 + move) / total }, { textIndent: '0px', offset: 1 }],
          { duration: total, iterations: Infinity, easing: 'linear' },
        );
      }, 350);
    };
    const onOut = (e: MouseEvent) => {
      if (over && !(e.relatedTarget instanceof Node && over.contains(e.relatedTarget))) stop();
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', stop, { passive: true, capture: true });
    return () => { stop(); document.removeEventListener('mouseover', onOver); document.removeEventListener('mouseout', onOut); window.removeEventListener('scroll', stop, { capture: true } as EventListenerOptions); };
  }, []);
  return null;
}

/** Fired once when the Welcome tour is finished (not when it is dismissed). */
export const ALL_SET_EVENT = 'slicksync:all-set';

/**
 * The finished-setup moment: when the Welcome tour is completed, the
 * SlickSync mark does its link-click once and one line says it is done.
 */
export function AllSetMoment() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let timer = 0;
    const on = () => { setShow(true); window.clearTimeout(timer); timer = window.setTimeout(() => setShow(false), 2600); };
    window.addEventListener(ALL_SET_EVENT, on);
    return () => { window.clearTimeout(timer); window.removeEventListener(ALL_SET_EVENT, on); };
  }, []);
  if (!show || typeof document === 'undefined') return null;
  return createPortal(
    <div className="all-set" role="status" onClick={() => setShow(false)}>
      <div className="popup-panel all-set-card">
        <span className="all-set-badge">
          <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
            <g fill="none" stroke="#ffffff" strokeWidth={18} strokeLinecap="round">
              <g className="all-set-l1"><rect x="30" y="65" width="90" height="50" rx="25" transform="rotate(-35 75 90)" /></g>
              <g className="all-set-l2"><rect x="80" y="85" width="90" height="50" rx="25" transform="rotate(-35 125 110)" /></g>
            </g>
          </svg>
        </span>
        <div className="all-set-line">
          <p className="font-display text-[17px] font-bold text-default">You’re all set</p>
          <p className="text-[13px] text-muted">Your household is linked.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
