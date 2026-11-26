'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { usePeek } from '@/lib/arrange';
import { cachedImageUrl } from '@/lib/posterUrl';

export type PeekPerson = { id: string; name: string; app: string; lastSeen: string; watched: string; canSync: boolean };
export type PeekPlaying = { title: string; art: string | null; progress: number | null; line: string | null };

const WIDTH = 264;
const OPEN_MS = 500;
const CLOSE_MS = 180;

/**
 * Peek at a person (Users page, a computer with a mouse): rest the pointer on
 * someone's card for a moment and a small card opens beside it - what they
 * are watching now, when they were last seen, how much they have watched,
 * and Sync and Open. It reads the person from the card under the pointer
 * (data-peek-id), so it works on both page designs without the cards knowing
 * about it. Settings → Themes → Layout → Pages and cards switches it off.
 */
export function PersonPeek({ people, playing, onSync }: {
  people: Map<string, PeekPerson>;
  playing: Map<string, PeekPlaying>;
  onSync: (id: string) => void;
}) {
  const isTV = useIsTV();
  const { on } = usePeek();
  const router = useRouter();
  const [open, setOpen] = useState<{ id: string; left: number; top: number; fromRight: boolean } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isTV || !on || typeof window === 'undefined' || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    let timer = 0;
    let over: Element | null = null;
    const cardOf = (t: EventTarget | null): { card: Element; id: string } | null => {
      const card = t instanceof Element ? t.closest('.user-card, [data-v2-item]') : null;
      if (!card) return null;
      const id = card.getAttribute('data-peek-id') || card.querySelector('[data-peek-id]')?.getAttribute('data-peek-id');
      return id ? { card, id } : null;
    };
    const close = () => { window.clearTimeout(timer); over = null; setOpen(null); };
    const show = (card: Element, id: string) => {
      // Not over a menu, a window, or something being dragged.
      if (!card.isConnected || document.querySelector('[role="dialog"], [role="menu"], [data-fx-drag], .popup-panel:not([data-peek])')) return;
      const r = card.getBoundingClientRect();
      const fromRight = r.right + 10 + WIDTH > window.innerWidth - 8;
      setOpen({ id, left: fromRight ? Math.max(8, r.left - 10 - WIDTH) : r.right + 10, top: Math.max(8, Math.min(r.top - 8, window.innerHeight - 330)), fromRight });
    };
    const onOver = (e: MouseEvent) => {
      // Back on its own card, or onto the peek itself: it stays.
      if (panel.current?.contains(e.target as Node)) { window.clearTimeout(timer); return; }
      const hit = cardOf(e.target);
      if (!hit) return;
      if (hit.card === over) { if (panel.current) window.clearTimeout(timer); return; }
      window.clearTimeout(timer);
      setOpen(null);
      over = hit.card;
      timer = window.setTimeout(() => show(hit.card, hit.id), OPEN_MS);
    };
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && (panel.current?.contains(to) || (over && over.contains(to)))) return;
      if (!over && !panel.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(close, CLOSE_MS);
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', close, { passive: true, capture: true });
    document.addEventListener('mousedown', closeUnlessInside);
    document.addEventListener('keydown', close);
    document.addEventListener('contextmenu', close);
    function closeUnlessInside(e: MouseEvent) { if (!panel.current?.contains(e.target as Node)) close(); }
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', close, { capture: true } as EventListenerOptions);
      document.removeEventListener('mousedown', closeUnlessInside);
      document.removeEventListener('keydown', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [isTV, on]);

  const p = open ? people.get(open.id) : undefined;
  if (!open || !p || typeof document === 'undefined') return null;
  const now = playing.get(p.id);
  return createPortal(
    <div
      ref={panel}
      data-peek=""
      data-mh-off=""
      className="popup-panel person-peek"
      style={{ left: open.left, top: open.top, width: WIDTH, transformOrigin: `${open.fromRight ? '100%' : '0'} 24px` }}
    >
      <p className="text-[15px] font-semibold text-default truncate">{p.name}</p>
      <p className="text-[12.5px] text-muted">{p.app}</p>
      {now ? (
        <>
          {now.art && (
            <div className="person-peek-art">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cachedImageUrl(now.art, 342) || now.art} alt="" decoding="async" />
              {now.progress != null && <i style={{ width: `${now.progress}%` }} />}
            </div>
          )}
          <p className="person-peek-line"><b><span className="person-peek-eq"><i /><i /><i /></span>{now.title || 'Watching now'}</b></p>
          {now.line && <p className="person-peek-line"><span>{now.line}</span></p>}
        </>
      ) : (
        <p className="person-peek-line mt-2.5"><span>Not watching right now</span></p>
      )}
      <p className="person-peek-line"><span>Last seen</span><b>{p.lastSeen === 'Never' ? 'Never' : p.lastSeen}</b></p>
      <p className="person-peek-line"><span>Watched</span><b>{p.watched}</b></p>
      <div className="flex gap-2 mt-2.5">
        {p.canSync && <button type="button" className="v2-btn v2-btn-main" onClick={() => { onSync(p.id); setOpen(null); }}>Sync</button>}
        <button type="button" className="v2-btn" onClick={() => { setOpen(null); router.push(`/users/${p.id}`); }}>Open</button>
      </div>
    </div>,
    document.body,
  );
}
