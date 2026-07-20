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
    name: 'Original',
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

// Back to defaulting to 'current' (Original) - Nebula is still actively
// being remastered page by page (only Dashboard and part of Activity are
// done so far), so it's not ready to be what people land on by default.
// Nebula stays fully available as an opt-in toggle in the meantime.
const defaultContextValue: LayoutModeContextValue = {
  layoutMode: 'current',
  setLayoutMode: () => {},
};

const LayoutModeContext = createContext<LayoutModeContextValue>(defaultContextValue);

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const [layoutMode, setLayoutModeState] = useState<LayoutModeId>('current');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('slicksync-layout-mode') as LayoutModeId | null;
    const initial = saved && layoutModeIds.includes(saved) ? saved : 'current';
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
