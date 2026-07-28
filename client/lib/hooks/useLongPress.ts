import { useCallback, useRef } from 'react';

interface UseLongPressOptions {
  /** Fires once the hold clears `delay` without moving past `moveThreshold`.
   *  Receives the triggering touchstart event (for handing to useContextMenu's
   *  handleContextMenu, which calls preventDefault/stopPropagation on it) plus
   *  the touch's screen coordinates for positioning a menu at the press point. */
  onLongPress: (e: React.TouchEvent, x: number, y: number) => void;
  delay?: number;
  moveThreshold?: number;
}

/**
 * Touch-and-hold via a plain JS timer, not the DOM `contextmenu` event.
 * iOS Safari doesn't reliably synthesize `contextmenu` from a touch
 * long-press the way desktop browsers do from a real right-click, so a
 * card wired with only `onContextMenu` has a long-press that does nothing
 * on iPhone even though the exact same code works on desktop. Continue
 * Watching and the Dashboard "Coming up" row already solved this with an
 * inline touchstart/setTimeout pattern; this is that same pattern
 * extracted so a third caller (Discover's PosterCard) didn't need to
 * duplicate it again.
 *
 * Cancels if the touch moves past `moveThreshold` before `delay` elapses,
 * so a scroll gesture starting on the card doesn't get hijacked into
 * opening a menu.
 */
export function useLongPress({ onLongPress, delay = 500, moveThreshold = 10 }: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startPosRef.current = { x: t.clientX, y: t.clientY };
    timerRef.current = setTimeout(() => {
      onLongPress(e, t.clientX, t.clientY);
      timerRef.current = null;
    }, delay);
  }, [onLongPress, delay]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!startPosRef.current || !timerRef.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - startPosRef.current.x);
    const dy = Math.abs(t.clientY - startPosRef.current.y);
    if (dx > moveThreshold || dy > moveThreshold) clear();
  }, [clear, moveThreshold]);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd: clear,
    onTouchCancel: clear,
  };
}
