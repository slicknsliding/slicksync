'use client';

import { createContext, useContext, useEffect, useLayoutEffect, useState, ReactNode } from 'react';
import { useIsTV } from './hooks/useIsTV';

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
    name: 'Top Navi',
    description: 'Glass panels over a nebula-cloud background, top nav instead of a sidebar',
  },
};

// Where the account button (picture + account menu) lives, for Top Navi only:
// Original always keeps it at the foot of the sidebar. 'b' (floating pill,
// bottom left) is the default; 'a' puts it at the right end of the top bar.
export const accountButtonIds = ['a', 'b'] as const;
export type AccountButtonId = (typeof accountButtonIds)[number];
export type AccountPlacement = 'bar' | 'float';

export const accountButtonMeta: Record<AccountButtonId, { name: string; description: string; placement: AccountPlacement }> = {
  a: { name: 'In the top bar', description: 'Your picture at the right end of the bar. Menu drops down.', placement: 'bar' },
  b: { name: 'Floating, bottom left', description: 'A small pill that floats over the page. Menu opens upward.', placement: 'float' },
};

const ACCOUNT_BUTTON_KEY = 'slicksync-account-button-nebula';

interface LayoutModeContextValue {
  layoutMode: LayoutModeId;
  setLayoutMode: (id: LayoutModeId) => void;
  /** Top Navi's account button choice. A TV always gets 'a' - a remote cannot
   *  reach a floating pill. */
  accountButton: AccountButtonId;
  setAccountButton: (id: AccountButtonId) => void;
}

// Default is 'nebula' ("Top Navi") - the earlier Nebula-specific issues
// (sticky nav background, mobile nav collapse, hover styling) that prompted
// reverting to Original as the default have since been fixed. Original
// remains fully available as an opt-in from Settings.
const defaultContextValue: LayoutModeContextValue = {
  layoutMode: 'nebula',
  setLayoutMode: () => {},
  accountButton: 'b',
  setAccountButton: () => {},
};

const LayoutModeContext = createContext<LayoutModeContextValue>(defaultContextValue);

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const [layoutMode, setLayoutModeState] = useState<LayoutModeId>('nebula');
  const [accountChoice, setAccountChoice] = useState<AccountButtonId>('b');
  const [mounted, setMounted] = useState(false);
  // TV mode has no D-pad wiring built for Original's sidebar/card chrome at
  // all - every TVPageProvider/TVFocusable/TVLink pass this session
  // specifically targeted Nebula's render paths. A fresh TV app install has
  // no saved localStorage preference (Capacitor's WebView storage is
  // isolated per-device), so it would otherwise fall through to whatever
  // the default above is - if that's ever 'current', the TV app loses all
  // D-pad navigation on first launch. Forcing Nebula here decouples "what
  // regular users see by default" from "what TV mode requires to function
  // at all" - TV mode ignores both the default and any saved preference.
  const isTV = useIsTV();

  // Read before the first paint after hydration (a layout effect, not a
  // plain one): with a plain effect someone on Original saw Top Navi drawn
  // first and then the whole page rebuilt in the other layout.
  useLayoutEffect(() => {
    const saved = localStorage.getItem('slicksync-layout-mode') as LayoutModeId | null;
    const initial = saved && layoutModeIds.includes(saved) ? saved : 'nebula';
    setLayoutModeState(initial);
    // Same moment, same reason: a saved "bar" choice must not flash as the pill.
    try {
      setAccountChoice(localStorage.getItem(ACCOUNT_BUTTON_KEY) === 'a' ? 'a' : 'b');
    } catch { /* storage blocked: the default */ }
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

  const setAccountButton = (id: AccountButtonId) => {
    if (!accountButtonIds.includes(id)) return;
    setAccountChoice(id);
    try { localStorage.setItem(ACCOUNT_BUTTON_KEY, id); } catch { /* storage blocked: lasts this visit */ }
  };

  return (
    <LayoutModeContext.Provider value={{
      layoutMode: isTV ? 'nebula' : layoutMode,
      setLayoutMode,
      accountButton: isTV ? 'a' : accountChoice,
      setAccountButton,
    }}>
      {children}
    </LayoutModeContext.Provider>
  );
}

export function useLayoutMode() {
  return useContext(LayoutModeContext);
}

/** Set by the top bar, which hosts the account button, so the button and its
 *  menu know which way to open. Null elsewhere (the sidebar foot). */
export const AccountPlacementContext = createContext<AccountPlacement | null>(null);

/** Where the account button sits in the top bar layout. */
export function useAccountPlacement(): AccountPlacement {
  const { accountButton } = useContext(LayoutModeContext);
  return accountButtonMeta[accountButton].placement;
}

// Pages that actually have a Nebula-styled render path. Everything else
// keeps the sidebar/current chrome even when Nebula mode is selected -
// there's no Nebula version of those pages (yet), so there's nothing to
// switch to. This is every top-level admin page - full Nebula coverage.
const NEBULA_ELIGIBLE_PATHS = [
  '/', '/activity', '/users', '/groups', '/addons',
  '/discover', '/catalogs', '/metrics', '/vault', '/invitations', '/tasks', '/settings', '/themes', '/changelog',
  '/guides',
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
// '/guides/' covers the per-topic pages. Both the Guides index and the topic
// pages already render NebulaPageHeading - they were falling back to the
// sidebar purely because this list wasn't updated when Guides was added, so
// opening a guide from the command palette snapped you into the other layout
// mid-session, which reads as the layout setting resetting itself.
// '/invitations/' is an invitation's own page - it was missed the same way.
const NEBULA_ELIGIBLE_PREFIXES = ['/users/', '/groups/', '/addons/', '/catalogs/', '/guides/', '/invitations/', '/tasks/'];

export function isNebulaEligiblePath(pathname: string): boolean {
  return NEBULA_ELIGIBLE_PATHS.includes(pathname)
    || NEBULA_ELIGIBLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
