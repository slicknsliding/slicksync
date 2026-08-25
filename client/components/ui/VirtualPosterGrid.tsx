'use client';

import { ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

// Windowed rendering for the app's large, uniform poster grids (Discover's
// main browse grid first). The grid LOOKS unchanged - same Tailwind
// grid-cols classes, same gap, same cards - but only the rows near the
// viewport actually exist in the DOM. Rows are recycled as you scroll, so
// a session that has accumulated thousands of items via infinite scroll
// costs the same to render, sort, and unmount as one showing a hundred.
// This is the no-tradeoff replacement for the (reverted) hard item cap:
// nothing is ever dropped from the data, it just isn't all mounted at once.
//
// Deliberately NOT used for small bounded rows ("For You", person credits,
// cast strips) - windowing a list that fits in two screens adds machinery
// for nothing.
//
// TV mode must pass disabled: norigin's spatial navigation walks real DOM
// nodes to decide where D-pad focus moves next, and unmounted cards would
// be unreachable (or worse, focus would land on a recycled neighbor).
// TV grids are also naturally shallow (no touch, users page rather than
// fling-scroll), so the plain grid stays fine there.
interface VirtualPosterGridProps<T> {
  items: T[];
  /** Stable per-item key - poster grids key by item id today, keep that. */
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** The exact Tailwind classes the plain grid used - column count is READ
   *  from the rendered result (computed grid-template-columns), never
   *  duplicated here as a number, so a breakpoint change in the class
   *  string stays the single source of truth. */
  gridClassName: string;
  /** Rough row height guess used only before a row is first measured -
   *  poster cards are ~2/3 aspect plus a 2-line caption. Real heights come
   *  from measureElement per row afterward. */
  estimateRowHeight?: number;
  disabled?: boolean;
}

export function VirtualPosterGrid<T>({
  items,
  getKey,
  renderItem,
  gridClassName,
  estimateRowHeight = 260,
  disabled = false,
}: VirtualPosterGridProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // A permanently-mounted, invisible, zero-height grid with the SAME class
  // string - its computed grid-template-columns tells us how many columns
  // the current viewport width resolves to. Watching this (not window
  // resize events) means container-width changes from things like the
  // sidebar collapsing are caught too, not just window resizes.
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(3);

  useLayoutEffect(() => {
    if (disabled) return;
    const probe = probeRef.current;
    if (!probe) return;
    const readColumns = () => {
      const template = getComputedStyle(probe).gridTemplateColumns;
      const count = template === 'none' ? 0 : template.split(' ').length;
      if (count > 0) setColumns(count);
    };
    readColumns();
    const ro = new ResizeObserver(readColumns);
    ro.observe(probe);
    return () => ro.disconnect();
  }, [disabled]);

  const rowCount = Math.ceil(items.length / columns);

  // scrollMargin anchors the virtualizer's coordinate space to where this
  // grid starts within the page, since the page itself is the scroller.
  // Held in state (not read off the ref mid-render, which the lint config's
  // compiler rules reject) and re-measured when anything above the grid
  // changes height - body ResizeObserver catches filters collapsing,
  // headers wrapping, etc., not just window resizes.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (disabled) return;
    const el = listRef.current;
    if (!el) return;
    const measure = () => setScrollMargin(el.offsetTop);
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [disabled]);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => estimateRowHeight,
    overscan: 4,
    scrollMargin,
  });

  if (disabled) {
    return (
      <div className={gridClassName}>
        {items.map((item) => (
          <div key={getKey(item)}>{renderItem(item)}</div>
        ))}
      </div>
    );
  }

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div ref={listRef}>
      <div ref={probeRef} aria-hidden className={gridClassName} style={{ visibility: 'hidden', height: 0, overflow: 'hidden' }}>
        <div />
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualRows.map((virtualRow) => {
          const start = virtualRow.index * columns;
          const rowItems = items.slice(start, start + columns);
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className={gridClassName}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                // The class string's own row-gap only applies WITHIN a grid;
                // each virtual row is its own grid, so the vertical gap
                // between rows has to be reproduced as padding here.
                // 0.75rem matches the gap-3 the poster grids all use.
                paddingBottom: '0.75rem',
              }}
            >
              {rowItems.map((item) => (
                <div key={getKey(item)}>{renderItem(item)}</div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
