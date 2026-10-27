'use client';

// The account's arrangement of SlickSync (see arrange-core.ts for the shape and
// the rules). Read from this device first so the page draws arranged on the
// first paint, then from the account, which wins; every change is saved back
// to the account so it follows the person to every device.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import {
  arrangeKeys, moveKey, orderKeys, stepKey, tidyPage, withFolded, withHidden,
  type Arrangement, type MenuArrangement, type PageArrangement,
} from '@/lib/arrange-core';

const STORE_KEY = 'slicksync-arrange';

type Ctx = {
  arrangement: Arrangement;
  update: (fn: (prev: Arrangement) => Arrangement) => void;
};

const ArrangeContext = createContext<Ctx>({ arrangement: {}, update: () => {} });

function readLocal(): Arrangement {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function ArrangeProvider({ children }: { children: ReactNode }) {
  const [arrangement, setArrangement] = useState<Arrangement>({});
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // This device's copy before the first paint (localStorage doesn't exist
  // during the server render, so it can't be the initial state).
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArrangement(readLocal());
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getArrangement()
      .then((r) => {
        // A change made before the answer came back wins over it.
        if (cancelled || dirty.current) return;
        const next = r?.arrange && typeof r.arrange === 'object' ? r.arrange : {};
        setArrangement(next);
        try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      })
      .catch(() => { /* signed out or offline: this device's copy stands */ });
    return () => { cancelled = true; };
  }, []);

  const update = useCallback((fn: (prev: Arrangement) => Arrangement) => {
    dirty.current = true;
    setArrangement((prev) => {
      const next = fn(prev);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      // One save after a burst of clicks, not one per click.
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        api.saveArrangement(Object.keys(next).length ? next : null).catch(() => {});
      }, 600);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ arrangement, update }), [arrangement, update]);
  return <ArrangeContext.Provider value={value}>{children}</ArrangeContext.Provider>;
}

export function useArrangement() {
  return useContext(ArrangeContext);
}

/**
 * One page's arrangement and the actions on it. `keys` is the page's own
 * default order; `arranging` is whether the page is in Arrange mode (the
 * page's own state, not saved).
 */
export function usePageArrangement(pageId: string, keys: string[]) {
  const { arrangement, update } = useArrangement();
  const page = arrangement.pages?.[pageId];
  const [arranging, setArranging] = useState(false);
  const keysKey = keys.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { shown, hidden } = useMemo(() => arrangeKeys(keys, page), [keysKey, page]);
  const folded = useMemo(() => new Set(page?.folded || []), [page]);

  const setPage = useCallback((fn: (p: PageArrangement | undefined) => PageArrangement) => {
    update((prev) => {
      const pages = { ...(prev.pages || {}) };
      const tidy = tidyPage(fn(pages[pageId]));
      if (tidy) pages[pageId] = tidy;
      else delete pages[pageId];
      const out: Arrangement = { ...prev, pages };
      if (Object.keys(pages).length === 0) delete out.pages;
      return out;
    });
  }, [update, pageId]);

  return {
    shown,
    hidden,
    isFolded: (key: string) => folded.has(key),
    arranging,
    setArranging,
    canMove: (key: string, dir: -1 | 1) => {
      const i = shown.indexOf(key);
      return i >= 0 && i + dir >= 0 && i + dir < shown.length;
    },
    move: (key: string, dir: -1 | 1) => setPage((p) => ({ ...p, order: stepKey(keys, p, key, dir) })),
    moveTo: (key: string, over: string) => setPage((p) => ({ ...p, order: moveKey(orderKeys(keys, p?.order), key, over) })),
    hide: (key: string) => setPage((p) => withHidden(p, key, true)),
    show: (key: string) => setPage((p) => withHidden(p, key, false)),
    fold: (key: string, on: boolean) => setPage((p) => withFolded(p, key, on)),
    reset: () => setPage(() => ({})),
    isDefault: !page,
  };
}

export type PageArrange = ReturnType<typeof usePageArrangement>;

export function useMenuArrangement() {
  const { arrangement, update } = useArrangement();
  const menu: MenuArrangement = arrangement.menu || {};
  const setMenu = useCallback((fn: (m: MenuArrangement) => MenuArrangement) => {
    update((prev) => {
      const next = fn(prev.menu || {});
      const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
      const out = { ...prev };
      if (Object.keys(clean).length) out.menu = clean as MenuArrangement;
      else delete out.menu;
      return out;
    });
  }, [update]);
  return { menu, setMenu };
}
