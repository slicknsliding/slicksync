'use client';

// The account's arrangement of SlickSync (see arrange-core.ts for the shape and
// the rules). Read from this device first so the page draws arranged on the
// first paint, then from the account, which wins; every change is saved back
// to the account so it follows the person to every device.

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import {
  arrangeKeys, moveKey, orderKeys, stepKey, tidyPage, withFolded, withHidden,
  type Arrangement, type MenuArrangement, type PageArrangement, type PageDesign,
} from '@/lib/arrange-core';

const STORE_KEY = 'slicksync-arrange';

type Ctx = {
  arrangement: Arrangement;
  update: (fn: (prev: Arrangement) => Arrangement) => void;
  /** False outside ArrangeProvider (a person's own pages): nothing is saved there. */
  active: boolean;
  /** The account's copy has answered (or failed): the arrangement is final. */
  loaded: boolean;
};

const ArrangeContext = createContext<Ctx>({ arrangement: {}, update: () => {}, active: false, loaded: true });

function readLocal(key: string = STORE_KEY): Arrangement {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

type Store = {
  /** This device's copy, under its own key. */
  localKey: string;
  load: () => Promise<{ arrange: Arrangement | null } | null | undefined>;
  save: (a: Arrangement | null) => Promise<unknown>;
};

const ACCOUNT_STORE: Store = {
  localKey: STORE_KEY,
  load: () => api.getArrangement(),
  save: (a) => api.saveArrangement(a),
};

/**
 * The account's arrangement on the admin pages; a person's own pages pass
 * their own `store` (PersonArrangeProvider) so it saves to them instead.
 */
export function ArrangeProvider({ children, store = ACCOUNT_STORE }: { children: ReactNode; store?: Store }) {
  const [arrangement, setArrangement] = useState<Arrangement>({});
  const [loaded, setLoaded] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // This device's copy before the first paint (localStorage doesn't exist
  // during the server render, so it can't be the initial state).
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArrangement(readLocal(store.localKey));
  }, [store.localKey]);

  useEffect(() => {
    let cancelled = false;
    store.load()
      .then((r) => {
        // A change made before the answer came back wins over it.
        if (cancelled || dirty.current) return;
        const next = r?.arrange && typeof r.arrange === 'object' ? r.arrange : {};
        setArrangement(next);
        try { localStorage.setItem(store.localKey, JSON.stringify(next)); } catch { /* storage blocked */ }
      })
      .catch(() => { /* signed out or offline: this device's copy stands */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [store]);

  const update = useCallback((fn: (prev: Arrangement) => Arrangement) => {
    dirty.current = true;
    setArrangement((prev) => {
      const next = fn(prev);
      try { localStorage.setItem(store.localKey, JSON.stringify(next)); } catch { /* storage blocked */ }
      // One save after a burst of clicks, not one per click.
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        store.save(Object.keys(next).length ? next : null).catch(() => {});
      }, 600);
      return next;
    });
  }, [store]);

  // Density (Themes → Layout): one attribute on <html> that the stylesheet
  // tightens cards, rows and gaps from.
  const density = arrangement.density;
  useEffect(() => {
    const root = document.documentElement;
    if (density === 'compact') root.dataset.density = 'compact';
    else delete root.dataset.density;
    return () => { delete root.dataset.density; };
  }, [density]);

  const value = useMemo(() => ({ arrangement, update, active: true, loaded }), [arrangement, update, loaded]);
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
export function usePageArrangement(pageId: string, keys: string[], opts: { defaultFolded?: string[] } = {}) {
  const { arrangement, update } = useArrangement();
  const page = arrangement.pages?.[pageId];
  const [arranging, setArranging] = useState(false);
  const keysKey = keys.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { shown, hidden } = useMemo(() => arrangeKeys(keys, page), [keysKey, page]);
  // Folded: what was folded, plus the page's own folded-by-default sections
  // unless they were opened.
  const defaultFoldedKey = (opts.defaultFolded || []).join(',');
  const folded = useMemo(() => {
    const set = new Set(page?.folded || []);
    const opened = new Set(page?.unfolded || []);
    for (const k of opts.defaultFolded || []) if (!opened.has(k)) set.add(k);
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, defaultFoldedKey]);

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

/** Classic or v2 (Themes → Page design), for this account. */
export function usePageDesign() {
  const { arrangement, update } = useArrangement();
  const design: PageDesign = arrangement.design === 'v2' ? 'v2' : 'classic';
  const setDesign = useCallback((d: PageDesign) => {
    update((prev) => {
      const out: Arrangement = { ...prev, design: d };
      if (d === 'classic') delete out.design;
      return out;
    });
  }, [update]);
  return { design, setDesign };
}

/** Comfortable or Compact (Themes → Layout), for this account. */
export function useDensity() {
  const { arrangement, update } = useArrangement();
  const density = arrangement.density === 'compact' ? 'compact' : 'comfortable';
  const setDensity = useCallback((d: 'comfortable' | 'compact') => {
    update((prev) => {
      const out: Arrangement = { ...prev, density: d };
      if (d === 'comfortable') delete out.density;
      return out;
    });
  }, [update]);
  return { density, setDensity };
}

/** Where SlickSync opens for this account (Themes → Layout). '/' is the Dashboard. */
export function useStartPage() {
  const { arrangement, update } = useArrangement();
  const startPage = arrangement.startPage || '/';
  const setStartPage = useCallback((href: string) => {
    update((prev) => {
      const out: Arrangement = { ...prev, startPage: href };
      if (href === '/') delete out.startPage;
      return out;
    });
  }, [update]);
  return { startPage, setStartPage };
}

/**
 * A page's filter. With "Keep each page's filter" on (Themes → Layout) the
 * choice is saved and comes back next visit; otherwise it's this visit only.
 */
export function useSavedFilter<T extends string>(pageId: string, fallback: T, allowed?: readonly T[]) {
  const { arrangement, update, active } = useArrangement();
  const keep = active && !!arrangement.keepFilters;
  const saved = keep ? arrangement.filters?.[pageId] : undefined;
  const [own, setOwn] = useState<T>(fallback);
  const [touched, setTouched] = useState(false);
  const usable = saved !== undefined && (!allowed || (allowed as readonly string[]).includes(saved));
  const value = (!touched && usable ? saved : own) as T;
  const set = useCallback((v: T) => {
    setOwn(v);
    setTouched(true);
    if (keep) update((prev) => ({ ...prev, filters: { ...(prev.filters || {}), [pageId]: v } }));
  }, [keep, update, pageId]);
  return [value, set] as const;
}

/** Pinned items on a page: they always sit first. */
export function usePinned(pageId: string) {
  const { arrangement, update } = useArrangement();
  const pinned = useMemo(() => arrangement.pinned?.[pageId] || [], [arrangement.pinned, pageId]);
  const toggle = useCallback((id: string) => {
    update((prev) => {
      const list = prev.pinned?.[pageId] || [];
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      const all = { ...(prev.pinned || {}) };
      if (next.length) all[pageId] = next;
      else delete all[pageId];
      const out: Arrangement = { ...prev, pinned: all };
      if (Object.keys(all).length === 0) delete out.pinned;
      return out;
    });
  }, [update, pageId]);
  const reset = useCallback(() => {
    update((prev) => {
      if (!prev.pinned?.[pageId]) return prev;
      const all = { ...prev.pinned };
      delete all[pageId];
      const out: Arrangement = { ...prev, pinned: all };
      if (Object.keys(all).length === 0) delete out.pinned;
      return out;
    });
  }, [update, pageId]);
  return { pinned, isPinned: (id: string) => pinned.includes(id), toggle, reset };
}

/** Keep each page's filter (Themes → Layout). */
export function useKeepFilters() {
  const { arrangement, update } = useArrangement();
  const keep = !!arrangement.keepFilters;
  const setKeep = useCallback((on: boolean) => {
    update((prev) => {
      const out: Arrangement = { ...prev, keepFilters: on };
      if (!on) { delete out.keepFilters; delete out.filters; }
      return out;
    });
  }, [update]);
  return { keep, setKeep };
}

/**
 * Opens SlickSync on the account's start page: once per browser tab, and only
 * when the tab opened on the Dashboard and is still there - clicking
 * Dashboard later still goes there. Waits for the account's copy on a device
 * that hasn't got one yet.
 */
export function StartPageRedirect() {
  const pathname = usePathname();
  const router = useRouter();
  const { arrangement, loaded } = useArrangement();
  const eligible = useRef<boolean | null>(null);
  if (eligible.current === null) {
    let first = false;
    try {
      first = !sessionStorage.getItem('slicksync-started');
      sessionStorage.setItem('slicksync-started', '1');
    } catch { first = false; }
    eligible.current = first && pathname === '/';
  }
  useEffect(() => {
    if (!eligible.current) return;
    if (pathname !== '/') { eligible.current = false; return; }
    const start = arrangement.startPage || readLocal().startPage;
    if (start && start !== '/' && start.startsWith('/')) {
      eligible.current = false;
      router.replace(start);
    } else if (loaded) {
      eligible.current = false;
    }
  }, [pathname, arrangement.startPage, loaded, router]);
  return null;
}

/**
 * A person's own pages: their arrangement is theirs, saved to them (not the
 * account), and follows them to every device they sign in on.
 */
export function PersonArrangeProvider({ userId, authKey, children }: { userId: string | null; authKey: string | null; children: ReactNode }) {
  const store = useMemo<Store | null>(() => {
    if (!userId || !authKey) return null;
    return {
      localKey: `${STORE_KEY}::person::${userId}`,
      load: () => import('@/lib/user-api').then((m) => m.userHomeArrange.get(userId, authKey)),
      save: (a) => import('@/lib/user-api').then((m) => m.userHomeArrange.save(userId, authKey, a)),
    };
  }, [userId, authKey]);
  if (!store) return <>{children}</>;
  return <ArrangeProvider key={store.localKey} store={store}>{children}</ArrangeProvider>;
}
