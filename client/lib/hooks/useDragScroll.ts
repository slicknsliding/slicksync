import { useCallback, useRef } from 'react';

/**
 * Mouse grab-and-drag horizontal scrolling for an overflow-x row, so a
 * desktop user can drag the row sideways instead of hunting for a scrollbar
 * (touch/trackpad already scroll natively via overflow-x-auto; this adds the
 * mouse affordance the cast/credits rows were missing). Only engages after a
 * few px of movement so a plain click on a child still fires normally, and
 * only for the left mouse button.
 *
 * Usage: const drag = useDragScroll(); <div ref={drag.ref} {...drag.handlers}>
 */
export function useDragScroll() {
  const ref = useRef<HTMLDivElement | null>(null);
  const downRef = useRef(false);
  const startXRef = useRef(0);
  const startScrollRef = useRef(0);
  const capturedRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !ref.current) return;
    downRef.current = true;
    capturedRef.current = false;
    startXRef.current = e.clientX;
    startScrollRef.current = ref.current.scrollLeft;
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !downRef.current || !ref.current) return;
    if (!e.buttons) { downRef.current = false; return; }
    const dx = e.clientX - startXRef.current;
    if (Math.abs(dx) > 5 && !capturedRef.current) {
      try { ref.current.setPointerCapture(e.pointerId); } catch {}
      capturedRef.current = true;
    }
    if (capturedRef.current) ref.current.scrollLeft = startScrollRef.current - dx;
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    downRef.current = false;
    if (capturedRef.current && ref.current) {
      try { ref.current.releasePointerCapture(e.pointerId); } catch {}
      capturedRef.current = false;
    }
  }, []);

  return {
    ref,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp },
    /** True while an actual drag is in progress - a child click handler can
     *  check this to suppress the click that would otherwise fire on release. */
    isDragging: () => capturedRef.current,
  };
}
