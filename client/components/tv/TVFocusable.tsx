'use client';

import { ReactNode, CSSProperties } from 'react';
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';

interface TVFocusableProps {
  onEnterPress?: () => void;
  onFocus?: () => void;
  className?: string;
  style?: CSSProperties;
  focusKey?: string;
  children: ReactNode;
}

// D-pad-focusable wrapper for anything that has an onClick today - poster
// tiles, the detail modal's action buttons, catalog tabs. Visible focus
// ring via inline style (not a Tailwind ring-* utility) so it correctly
// picks up the active theme's own accent color instead of a hardcoded one.
// Enter/OK on the remote fires onEnterPress, same handler the onClick
// would've called on PC/mobile - no separate TV-only logic to keep in sync.
export function TVFocusable({ onEnterPress, onFocus, className = '', style, focusKey, children }: TVFocusableProps) {
  // Norigin moves the focus KEY, not the viewport - nothing scrolls on its
  // own. A poster a few rows down gains focus exactly like one on-screen,
  // just invisibly, which reads as "the remote stopped working" (confirmed:
  // this is why Down out of the catalog/genre row looked like a dead end -
  // focus was almost certainly landing in the grid below the fold every
  // time, just never scrolled into view). block/inline: 'nearest' so an
  // already-visible element doesn't get yanked to an edge unnecessarily.
  const { ref, focused } = useFocusable<object, HTMLDivElement>({
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
  });

  return (
    <div
      ref={ref}
      className={`outline-none transition-transform duration-150 ${focused ? 'scale-105' : ''} ${className}`}
      style={{
        ...style,
        boxShadow: focused ? '0 0 0 4px var(--color-primary)' : 'none',
        borderRadius: focused ? '12px' : style?.borderRadius,
      }}
    >
      {children}
    </div>
  );
}
