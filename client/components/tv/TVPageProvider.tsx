'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { FocusContext, useFocusable, init } from '@noriginmedia/norigin-spatial-navigation';

// init() wires up the library's own global keydown listener (arrow keys +
// Enter) - called once per app lifetime, guarded here since a page using
// TVPageProvider can mount/unmount as you navigate. Only ever imported by
// components already gated behind useIsTV(), so this never runs (and the
// library never attaches a listener) on PC/mobile.
let initialized = false;

// Root focus scope for a TV-mode page - establishes the FocusContext every
// TVFocusable descendant on the page navigates within. One of these per
// page, wrapping everything that should be D-pad-reachable on it.
//
// Arrow keys move focus FROM something - nothing is focused by default, so
// without an explicit initial focusSelf() call the very first key press
// does nothing at all (confirmed live: pressing Down on a freshly loaded
// Discover page produced no focus ring anywhere). focusSelf() on a
// trackChildren group delegates focus to its first focusable descendant,
// but the grid it needs to land on loads asynchronously - a single call
// right on mount can fire before any poster has rendered. Retries on a
// short backoff instead of a single fixed delay, so this keeps working
// however long the page's own data takes, without every TV page needing
// its own bespoke "focus once loaded" wiring.
const RETRY_DELAYS_MS = [50, 200, 500, 1000, 2000];

// Confirmed live on an actual TV: everything rendered oversized, only 5
// posters fit per row instead of a proper dense grid. The WebView was
// reporting a much narrower CSS viewport than the TV's real resolution
// (default `width=device-width` isn't reliable on every Android TV WebView),
// so the responsive breakpoints fell to a small-screen layout and got
// stretched across the whole panel. Locking the viewport to a fixed TV-scale
// width once in TV mode fixes this the same way for every screen size
// without needing to detect the panel's actual resolution - 1920 clears
// Tailwind's 2xl breakpoint (1536px), which is what the grid needs to show
// its full 8-column density instead of falling back to a sparser one.
function useTVViewport(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      document.head.appendChild(meta);
    }
    const previous = meta.getAttribute('content');
    meta.setAttribute('content', 'width=1920, initial-scale=1');
    return () => {
      if (previous !== null) meta!.setAttribute('content', previous);
    };
  }, [active]);
}

// NebulaTopbar (TV's only real nav - see its own comments) is `position:
// sticky; top: 0`. TVFocusable's scrollIntoView({block: 'nearest'}) only
// checks raw DOM geometry against the viewport - it has no idea the sticky
// bar visually covers space at the top, so it happily stops scrolling the
// instant a focused element's top edge crosses y=0, landing it directly
// UNDERNEATH the bar. Confirmed live: the catalog/type-toggle row on
// Discover was reachable by focus (Norigin moved the key there fine) but
// invisible, covered by the sticky nav - read as "can't scroll all the way
// back up." scroll-padding-top makes every scrollIntoView in the document
// leave that much headroom, so a focused element always lands fully below
// the bar. NebulaTopbar now renders a compact TV-only size (~130px, down
// from ~300px at full desktop size - see its own isTV comments), so this
// only needs to cover that, with margin.
const TV_SCROLL_PADDING_TOP = '160px';
function useTVScrollPadding(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingTop;
    root.style.scrollPaddingTop = TV_SCROLL_PADDING_TOP;
    return () => {
      root.style.scrollPaddingTop = previous;
    };
  }, [active]);
}

export function TVPageProvider({ children }: { children: ReactNode }) {
  useTVViewport(true);
  useTVScrollPadding(true);

  useEffect(() => {
    if (initialized) return;
    initialized = true;
    init({ debug: false, visualDebug: false, distanceCalculationMethod: 'center' });
  }, []);

  const { ref, focusKey, focusSelf, hasFocusedChild } = useFocusable<object, HTMLDivElement>({ focusable: false, trackChildren: true });

  // hasFocusedChild is reactive (triggers a re-render), but the retry
  // timers below are scheduled once on mount and read this via a ref so
  // each attempt sees the LIVE value, not whatever it was at schedule time.
  const hasFocusedChildRef = useRef(false);
  useEffect(() => {
    hasFocusedChildRef.current = hasFocusedChild;
  }, [hasFocusedChild]);

  useEffect(() => {
    const timers = RETRY_DELAYS_MS.map((delay) => setTimeout(() => {
      // Stop once something already has focus - either an earlier retry
      // succeeded, or the user already moved focus themselves.
      if (!hasFocusedChildRef.current) focusSelf();
    }, delay));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref}>{children}</div>
    </FocusContext.Provider>
  );
}
