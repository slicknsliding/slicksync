'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// Layout mode is independent of Theme (lib/theme.tsx) - Theme picks colors,
// layout mode picks structure (sidebar vs top nav, card arrangement, etc).
// Currently scoped to Dashboard + Activity; other pages always render their
// one existing layout regardless of this setting.
export const layoutModeIds = ['current', 'nebula'] as const;
export type LayoutModeId = (typeof layoutModeIds)[number];

export const layoutModeMeta: Record<LayoutModeId, { name: string; description: string }> = {
  current: {
    name: 'Current',
    description: 'Sidebar navigation with card-based dashboard',
  },
  nebula: {
    name: 'Nebula',
    description: 'Glass panels over a nebula-cloud background, top nav instead of a sidebar',
  },
};

interface LayoutModeContextValue {
  layoutMode: LayoutModeId;
  setLayoutMode: (id: LayoutModeId) => void;
}

// Defaulting to 'nebula' (rather than 'current', the safer/proven choice)
// while it's actively being built out and dogfooded - makes it the thing
// you actually see day to day so bugs surface and get fixed quickly,
// instead of sitting unused behind an opt-in toggle. Worth revisiting once
// it's had real mileage.
const defaultContextValue: LayoutModeContextValue = {
  layoutMode: 'nebula',
  setLayoutMode: () => {},
};

const LayoutModeContext = createContext<LayoutModeContextValue>(defaultContextValue);

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const [layoutMode, setLayoutModeState] = useState<LayoutModeId>('nebula');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('slicksync-layout-mode') as LayoutModeId | null;
    const initial = saved && layoutModeIds.includes(saved) ? saved : 'nebula';
    setLayoutModeState(initial);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem('slicksync-layout-mode', layoutMode);
  }, [layoutMode, mounted]);

  const setLayoutMode = (id: LayoutModeId) => {
    if (layoutModeIds.includes(id)) {
      setLayoutModeState(id);
    }
  };

  return (
    <LayoutModeContext.Provider value={{ layoutMode, setLayoutMode }}>
      {children}
    </LayoutModeContext.Provider>
  );
}

export function useLayoutMode() {
  return useContext(LayoutModeContext);
}

// Pages that actually have a Nebula-styled render path. Everything else
// keeps the sidebar/current chrome even when Nebula mode is selected -
// there's no Nebula version of those pages (yet), so there's nothing to
// switch to. '/activity' has the topbar chrome + its Watch tab's stat cards
// done; its Tasks/Invites/Proxy tabs still render Current's own styling for
// their content (deliberately, for now - see the comment above the return
// statement in activity/page.tsx) but are fully functional either way, so
// it's safe to list here.
const NEBULA_ELIGIBLE_PATHS = ['/', '/activity'];

export function isNebulaEligiblePath(pathname: string): boolean {
  return NEBULA_ELIGIBLE_PATHS.includes(pathname);
}
