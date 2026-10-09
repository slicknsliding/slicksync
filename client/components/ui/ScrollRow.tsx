'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDragScroll } from '@/lib/hooks/useDragScroll';

/**
 * A row that scrolls sideways with no scroll bar: drag it with the mouse,
 * swipe it on touch, and its edges fade wherever there's more to see.
 * Takes the same classes the row's own div had (flex, gap, padding).
 */
export function ScrollRow({ className = '', children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const { ref: rowRef, handlers } = useDragScroll();
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, [rowRef]);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      resize.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [rowRef, measure]);

  // Children coming and going change how far the row scrolls without
  // resizing it.
  useEffect(measure);

  return (
    <div
      {...rest}
      ref={rowRef}
      {...handlers}
      // A link or poster dragged out of the row would start the browser's
      // own drag-and-drop instead of scrolling it.
      onDragStart={(e) => e.preventDefault()}
      data-fade-left={edges.left || undefined}
      data-fade-right={edges.right || undefined}
      className={`scroll-row ${className}`}
    >
      {children}
    </div>
  );
}
