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
// switch to. This is every top-level admin page - full Nebula coverage.
const NEBULA_ELIGIBLE_PATHS = [
  '/', '/activity', '/users', '/groups', '/addons',
  '/discover', '/metrics', '/vault', '/invitations', '/tasks', '/settings', '/changelog',
];

// Dynamic detail routes (/users/[id], /groups/[id]) - prefix match since
// pathname includes the real id, not the literal "[id]" segment. Clicking
// into a user/group from their list page used to drop straight back into
// the sidebar/Current chrome even with Nebula selected, which read as the
// layout mode silently resetting itself. Both detail pages now render
// NebulaTopbar/NebulaPageHeading chrome the same as everywhere else, with
// their existing interior content unchanged for now (same "chrome swap
// first, content styling later" approach Activity's Tasks/Invites/Proxy
// tabs used) - not the reset it looked like, just previously scoped out.
const NEBULA_ELIGIBLE_PREFIXES = ['/users/', '/groups/', '/addons/'];

export function isNebulaEligiblePath(pathname: string): boolean {
  return NEBULA_ELIGIBLE_PATHS.includes(pathname)
    || NEBULA_ELIGIBLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
