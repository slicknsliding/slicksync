'use client';

import { ReactNode, CSSProperties } from 'react';
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { initSpatialNav } from './spatialInit';

interface TVFocusableProps {
  onEnterPress?: () => void;
  onFocus?: () => void;
  className?: string;
  style?: CSSProperties;
  focusKey?: string;
  /** Return false to stop the remote's own move (to send it somewhere else). */
  onArrowPress?: (direction: string) => boolean;
  /** A span instead of a div, for a stop inside a line of text (a <p>). */
  inline?: boolean;
  children: ReactNode;
}

// D-pad-focusable wrapper for anything that has an onClick today - poster
// tiles, the detail modal's action buttons, catalog tabs. Visible focus
// ring via inline style (not a Tailwind ring-* utility) so it correctly
// picks up the active theme's own accent color instead of a hardcoded one.
// Enter/OK on the remote fires onEnterPress, same handler the onClick
// would've called on PC/mobile - no separate TV-only logic to keep in sync.
export function TVFocusable({ onEnterPress, onFocus, onArrowPress, className = '', style, focusKey, inline = false, children }: TVFocusableProps) {
  // Norigin moves the focus KEY, not the viewport - nothing scrolls on its
  // own. A poster a few rows down gains focus exactly like one on-screen,
  // just invisibly, which reads as "the remote stopped working" (confirmed:
  // this is why Down out of the catalog/genre row looked like a dead end -
  // focus was almost certainly landing in the grid below the fold every
  // time, just never scrolled into view). block/inline: 'nearest' so an
  // already-visible element doesn't get yanked to an edge unnecessarily.
  initSpatialNav();
  const { ref, focused } = useFocusable<object, HTMLElement>({
    onEnterPress,
    onFocus: () => {
      // 'smooth' looked buttery for a single press, but D-pad repeat-fires
      // much faster than that animation can finish - each new keypress
      // interrupts the last one mid-scroll, which is the "choppy/glitchy"
      // motion confirmed live on an actual TV. 'auto' (instant) is also
      // just how TV UIs normally behave - Netflix/YouTube TV snap, they
      // don't ease - so this isn't a downgrade, it's the correct behavior.
      ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      onFocus?.();
    },
    focusKey,
    onArrowPress: onArrowPress ? (direction) => onArrowPress(direction) : undefined,
  });

  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLSpanElement>}
      data-tv-stop=""
      className={`outline-none transition-transform duration-150 ${inline ? 'inline-block' : ''} ${focused ? 'scale-105' : ''} ${className}`}
      style={{
        ...style,
        boxShadow: focused ? '0 0 0 4px var(--color-primary)' : 'none',
        borderRadius: focused ? '12px' : style?.borderRadius,
      }}
    >
      {children}
    </Tag>
  );
}
