'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { fxBuzz } from '@/lib/effects';

export type SwipeAction = { label: string; tone?: 'main' | 'plain'; onClick: () => void };

const WIDTH_EACH = 76;

/**
 * Swipe a card for actions (touch screens): drag a card to the left and its
 * actions slide out from behind it; tap one, or drag it back. A tap and a
 * press-and-hold on the card do what they always did. With a mouse this is
 * not here at all - the card is drawn as it was.
 *
 * The card itself is moved (with `translate`, which leaves whatever else
 * moves it alone), so it needs no changes of its own. The actions stay
 * hidden until a swipe starts: many cards are see-through.
 */
export function SwipeActions({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const isTV = useIsTV();
  const wrap = useRef<HTMLDivElement>(null);
  // Known from the first draw. Finding it out a moment later swapped the card
  // into a wrapper, which rebuilt every card (pictures and all) once per page.
  // Cards are drawn in the browser after their data arrives, so there is no
  // server copy for this to disagree with.
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    if (!mq) return;
    const set = () => setTouch(mq.matches);
    mq.addEventListener?.('change', set);
    return () => mq.removeEventListener?.('change', set);
  }, []);
  const on = touch && !isTV && actions.length > 0;

  useEffect(() => {
    const box = wrap.current;
    if (!on || !box) return;
    const card = box.lastElementChild as HTMLElement | null;
    if (!card) return;
    const max = actions.length * WIDTH_EACH;
    let x0 = 0, y0 = 0, base = 0, x = 0, mode: '' | 'swipe' | 'scroll' = '';
    const place = (px: number, moving: boolean) => {
      x = px;
      card.style.transition = moving ? 'none' : 'translate 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)';
      card.style.translate = px ? `${px}px 0` : '';
      box.classList.toggle('live', px !== 0 || moving);
    };
    const close = () => { base = 0; place(0, false); };
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; mode = '';
    };
    const move = (e: TouchEvent) => {
      if (mode === 'scroll' || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (!mode) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // Sideways, and clearly so; anything else is the page scrolling. A drag by the grip is not a swipe.
        if (Math.abs(dx) < Math.abs(dy) * 1.4 || (e.target as Element | null)?.closest?.('[aria-roledescription="sortable"]')) { mode = 'scroll'; return; }
        mode = 'swipe';
      }
      if (e.cancelable) e.preventDefault();
      place(Math.max(-max, Math.min(0, base + dx)), true);
    };
    const end = () => {
      if (mode !== 'swipe') return;
      const opened = base === 0 && x < -max / 2;
      base = x < -max / 2 ? -max : 0;
      // Effects → Vibrate: a tiny buzz as the card clicks open.
      if (opened) fxBuzz();
      place(base, false);
      mode = '';
    };
    // While open, a tap on the card closes it instead of opening the person.
    const click = (e: MouseEvent) => {
      if (base === 0 || (e.target as Element | null)?.closest?.('.swipe-acts')) return;
      e.preventDefault(); e.stopPropagation();
      close();
    };
    const away = (e: Event) => { if (base !== 0 && !box.contains(e.target as Node)) close(); };
    card.addEventListener('touchstart', start, { passive: true });
    card.addEventListener('touchmove', move, { passive: false });
    card.addEventListener('touchend', end, { passive: true });
    card.addEventListener('touchcancel', end, { passive: true });
    box.addEventListener('click', click, true);
    document.addEventListener('touchstart', away, { passive: true });
    const acts = box.querySelector('.swipe-acts');
    const picked = () => close();
    acts?.addEventListener('click', picked);
    return () => {
      card.removeEventListener('touchstart', start);
      card.removeEventListener('touchmove', move);
      card.removeEventListener('touchend', end);
      card.removeEventListener('touchcancel', end);
      box.removeEventListener('click', click, true);
      document.removeEventListener('touchstart', away);
      acts?.removeEventListener('click', picked);
      card.style.translate = ''; card.style.transition = '';
      box.classList.remove('live');
    };
  }, [on, actions.length]);

  if (!on) return <>{children}</>;
  return (
    <div ref={wrap} className="swipe-wrap">
      <div className="swipe-acts" style={{ width: actions.length * WIDTH_EACH }}>
        {actions.map((a) => (
          <button key={a.label} type="button" className={a.tone === 'main' ? 'main' : ''} onClick={(e) => { e.preventDefault(); e.stopPropagation(); a.onClick(); }}>{a.label}</button>
        ))}
      </div>
      {children}
    </div>
  );
}
