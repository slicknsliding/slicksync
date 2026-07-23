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
  const { ref, focused } = useFocusable<object, HTMLDivElement>({ onEnterPress, onFocus, focusKey });

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
