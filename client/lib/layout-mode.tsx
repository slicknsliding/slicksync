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

// Where the account button (picture + account menu) lives. Each layout has two
// places and remembers its own pick; 'a' is the default for both.
//   Top Navi ('nebula'): a = in the top bar, b = floating pill bottom-left
//   Original ('current'): a = top of the sidebar by the logo, b = sidebar foot
export const accountButtonIds = ['a', 'b'] as const;
export type AccountButtonId = (typeof accountButtonIds)[number];
export type AccountPlacement = 'bar' | 'float' | 'sideTop' | 'sideFoot';

export const accountButtonMeta: Record<LayoutModeId, Record<AccountButtonId, { name: string; description: string; placement: AccountPlacement }>> = {
  nebula: {
    a: { name: 'In the top bar', description: 'Your picture at the right end of the bar. Menu drops down.', placement: 'bar' },
    b: { name: 'Floating, bottom left', description: 'A small pill that floats over the page. Menu opens upward.', placement: 'float' },
  },
  current: {
    a: { name: 'Top of the sidebar', description: 'Your picture beside the SlickSync logo. Menu drops down.', placement: 'sideTop' },
    b: { name: 'Foot of the sidebar', description: 'Where it sits today. Menu opens upward.', placement: 'sideFoot' },
  },
};

const ACCOUNT_BUTTON_KEYS: Record<LayoutModeId, string> = {
  nebula: 'slicksync-account-button-nebula',
  current: 'slicksync-account-button-current',
};

type AccountButtonChoices = Record<LayoutModeId, AccountButtonId>;
const defaultAccountButtons: AccountButtonChoices = { nebula: 'a', current: 'a' };

interface LayoutModeContextValue {
  layoutMode: LayoutModeId;
  setLayoutMode: (id: LayoutModeId) => void;
  /** The account button choice of each layout. A TV always gets 'a' - a remote
   *  cannot reach a floating pill, or the foot of a sidebar. */
  accountButtons: AccountButtonChoices;
  /** Stores the choice for one layout (Settings passes the layout it shows). */
  setAccountButton: (layout: LayoutModeId, id: AccountButtonId) => void;
}

// Default is 'nebula' ("Top Navi") - the earlier Nebula-specific issues
// (sticky nav background, mobile nav collapse, hover styling) that prompted
// reverting to Original as the default have since been fixed. Original
// remains fully available as an opt-in from Settings.
const defaultContextValue: LayoutModeContextValue = {
  layoutMode: 'nebula',
  setLayoutMode: () => {},
  accountButtons: defaultAccountButtons,
  setAccountButton: () => {},
};

const LayoutModeContext = createContext<LayoutModeContextValue>(defaultContextValue);

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const [layoutMode, setLayoutModeState] = useState<LayoutModeId>('nebula');
  const [accountChoices, setAccountChoices] = useState<AccountButtonChoices>(defaultAccountButtons);
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
    // Same moment, same reason: a saved "pill" choice must not flash as the bar.
    const read = (layout: LayoutModeId): AccountButtonId => {
      try {
        const v = localStorage.getItem(ACCOUNT_BUTTON_KEYS[layout]);
        return v === 'b' ? 'b' : 'a';
      } catch { return 'a'; }
    };
    setAccountChoices({ nebula: read('nebula'), current: read('current') });
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

  const setAccountButton = (layout: LayoutModeId, id: AccountButtonId) => {
    if (!layoutModeIds.includes(layout) || !accountButtonIds.includes(id)) return;
    setAccountChoices((prev) => ({ ...prev, [layout]: id }));
    try { localStorage.setItem(ACCOUNT_BUTTON_KEYS[layout], id); } catch { /* storage blocked: lasts this visit */ }
  };

  return (
    <LayoutModeContext.Provider value={{
      layoutMode: isTV ? 'nebula' : layoutMode,
      setLayoutMode,
      accountButtons: isTV ? defaultAccountButtons : accountChoices,
      setAccountButton,
    }}>
      {children}
    </LayoutModeContext.Provider>
  );
}

export function useLayoutMode() {
  return useContext(LayoutModeContext);
}

/** Set by whatever hosts the account button (the top bar, the sidebar) so the
 *  button and its menu know which way to open. Null outside those hosts. */
export const AccountPlacementContext = createContext<AccountPlacement | null>(null);

/** Where the account button sits for the given layout (default: the layout in use). */
export function useAccountPlacement(layout?: LayoutModeId): AccountPlacement {
  const { layoutMode, accountButtons } = useContext(LayoutModeContext);
  const which = layout ?? layoutMode;
  return accountButtonMeta[which][accountButtons[which]].placement;
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
