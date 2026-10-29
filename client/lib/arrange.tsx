'use client';

// The account's arrangement of SlickSync (see arrange-core.ts for the shape and
// the rules). Read from this device first so the page draws arranged on the
// first paint, then from the account, which wins; every change is saved back
// to the account so it follows the person to every device.

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy, useSortable, type SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { VaultDragProvider, useVaultDrag } from '@/components/providers/VaultDragContext';
import { useSortableSensors } from '@/components/ui/DragSortable';
import {
  arrangeKeys, moveKey, orderKeys, stepKey, tidyPage, withFolded, withHidden,
  type Arrangement, type CardSizing, type MenuArrangement, type NeedsDismissals, type PageArrangement, type PageDesign, type SectionSize,
} from '@/lib/arrange-core';

const STORE_KEY = 'slicksync-arrange';

type Ctx = {
  arrangement: Arrangement;
  update: (fn: (prev: Arrangement) => Arrangement) => void;
  /** False outside ArrangeProvider (a person's own pages): nothing is saved there. */
  active: boolean;
  /** The account's copy has answered (or failed): the arrangement is final. */
  loaded: boolean;
  /** Arrange opened (on) or closed (off): from on, every change can be undone. */
  session: (on: boolean) => void;
  canUndo: boolean;
  /** Step back one change since Arrange opened. */
  undo: () => void;
  /** Everything back as it was when Arrange opened. */
  cancel: () => void;
};

const ArrangeContext = createContext<Ctx>({ arrangement: {}, update: () => {}, active: false, loaded: true, session: () => {}, canUndo: false, undo: () => {}, cancel: () => {} });

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

  // Undo / Cancel: the arrangement when Arrange opened, and before each change since.
  const current = useRef(arrangement);
  useLayoutEffect(() => { current.current = arrangement; }, [arrangement]);
  const openedAs = useRef<Arrangement | null>(null);
  const [history, setHistory] = useState<Arrangement[]>([]);
  const historyRef = useRef(history);
  useLayoutEffect(() => { historyRef.current = history; }, [history]);

  const write = useCallback((fn: (prev: Arrangement) => Arrangement) => {
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

  const update = useCallback((fn: (prev: Arrangement) => Arrangement) => {
    if (openedAs.current) {
      const before = current.current;
      setHistory((h) => [...h.slice(-49), before]);
    }
    write(fn);
  }, [write]);

  const session = useCallback((on: boolean) => {
    openedAs.current = on ? current.current : null;
    setHistory([]);
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    const back = h[h.length - 1];
    historyRef.current = h.slice(0, -1);
    setHistory(historyRef.current);
    write(() => back);
  }, [write]);
  const cancel = useCallback(() => {
    const back = openedAs.current;
    if (back) write(() => back);
    openedAs.current = null;
    setHistory([]);
  }, [write]);

  // Density (Themes → Layout): one attribute on <html> that the stylesheet
  // tightens cards, rows and gaps from.
  const density = arrangement.density;
  useEffect(() => {
    const root = document.documentElement;
    // Compact is the default: only an explicit Comfortable clears the attribute.
    if (density === 'comfortable') delete root.dataset.density;
    else root.dataset.density = 'compact';
    return () => { delete root.dataset.density; };
  }, [density]);

  const canUndo = history.length > 0;
  const value = useMemo(() => ({ arrangement, update, active: true, loaded, session, canUndo, undo, cancel }), [arrangement, update, loaded, session, canUndo, undo, cancel]);
  return <ArrangeContext.Provider value={value}>{children}</ArrangeContext.Provider>;
}

export function useArrangement() {
  return useContext(ArrangeContext);
}

/*
 * Drag to reorder (Arrange mode). One small API, used by every page:
 *
 *   const scope = useSortableScope({ keys, onMove: (key, over) => ..., enabled: arranging });
 *   ...
 *   <SortableItem scope={scope} itemKey={key}>
 *     {(d) => (
 *       <div ref={d.ref} style={d.style} className={d.className}>
 *         ...<ArrangeGrip drag={d} label="Move X" />   // or anything with {...d.grip}
 *       </div>
 *     )}
 *   </SortableItem>
 *
 * `keys` is the list in the order it is drawn; `onMove(key, over)` is called
 * once on a drop, with the dragged key and the key it was dropped on (moveKey
 * in arrange-core.ts turns that into a new order). Use layout 'grid' for items
 * that sit side by side. Nothing needs a DndContext of its own: it shares the
 * admin layout's (PersonArrangeProvider supplies one on a person's pages).
 * `scope.ready` is false where dragging doesn't exist (TV, outside a layout),
 * and then SortableItem just renders its child with no handle. Pages built on
 * usePageArrangement need none of this: ArrangeSection, ArrangePanel and
 * ArrangeControls already do it with arrange.sort.
 */
export type SortScope = {
  ready: boolean;
  enabled: boolean;
  prefix: string;
  keys: string[];
  layout: SortLayout;
};

/**
 * 'list': a stack, the others shift to open a gap. 'grid': sections of
 * different sizes (nothing shifts; the one it would land on is outlined).
 * 'tiles': side by side items of one size, which shift to open a gap.
 */
export type SortLayout = 'list' | 'grid' | 'tiles';

export type SortableState = {
  /** Put on the element that moves. */
  ref: Ref<HTMLElement> | undefined;
  style: CSSProperties | undefined;
  className: string;
  isDragging: boolean;
  /** Spread on the handle (a button). Null where dragging doesn't exist. */
  grip: (Record<string, unknown> & { ref: Ref<HTMLElement> }) | null;
  scope: SortScope | null;
  itemKey: string;
};

const INERT: SortableState = { ref: undefined, style: undefined, className: '', isDragging: false, grip: null, scope: null, itemKey: '' };

// Outside the admin layout there is no drag registry: dragging is simply off.
function useDragRegistry() {
  try {
    return useVaultDrag();
  } catch {
    return null;
  }
}

export function useSortableScope({ keys, onMove, enabled = true, layout = 'list' }: {
  keys: string[];
  onMove: (key: string, over: string) => void;
  enabled?: boolean;
  layout?: SortLayout;
}): SortScope {
  const uid = useId();
  const registry = useDragRegistry();
  const isTV = useIsTV();
  const prefix = `srt${uid}:`;
  const onMoveRef = useRef(onMove);
  useEffect(() => { onMoveRef.current = onMove; });
  const register = registry?.registerDragEndHandler;
  useEffect(() => {
    if (!register) return;
    return register((e) => {
      const a = String(e.active.id);
      const o = e.over ? String(e.over.id) : '';
      if (!a.startsWith(prefix) || !o.startsWith(prefix) || a === o) return;
      onMoveRef.current(a.slice(prefix.length), o.slice(prefix.length));
    });
  }, [register, prefix]);
  const ready = !!registry && !isTV;
  const keysKey = keys.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ ready, enabled: ready && enabled, prefix, keys, layout }), [ready, enabled, prefix, keysKey, layout]);
}

const GripContext = createContext<{ prefix: string; itemKey: string; state: SortableState } | null>(null);

/** The handle of the SortableItem this is inside, when it is the one for `itemKey` in `scope`. */
export function useGrip(scope: SortScope, itemKey: string): SortableState | null {
  const ctx = useContext(GripContext);
  return ctx && ctx.prefix === scope.prefix && ctx.itemKey === itemKey && ctx.state.grip ? ctx.state : null;
}

// Nothing moves while dragging; the item being hovered is outlined instead.
const noShift: SortingStrategy = () => null;

function SortableInner({ scope, itemKey, children }: { scope: SortScope; itemKey: string; children: (s: SortableState) => ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: scope.prefix + itemKey, disabled: !scope.enabled });
  const state: SortableState = {
    ref: setNodeRef,
    style: scope.enabled
      ? { transform: CSS.Translate.toString(transform), transition: isDragging ? 'none' : transition, zIndex: isDragging ? 70 : undefined, position: isDragging ? 'relative' : undefined }
      : undefined,
    className: isDragging ? 'arrange-lifted' : (isOver && scope.layout === 'grid' ? 'arrange-drop' : ''),
    isDragging,
    grip: scope.enabled ? { ref: setActivatorNodeRef, ...attributes, ...listeners } : null,
    scope,
    itemKey,
  };
  return <GripContext.Provider value={{ prefix: scope.prefix, itemKey, state }}>{children(state)}</GripContext.Provider>;
}

export function SortableItem({ scope, itemKey, children }: { scope: SortScope; itemKey: string; children: (s: SortableState) => ReactNode }) {
  if (!scope.ready) return <>{children({ ...INERT, itemKey })}</>;
  return (
    <SortableContext items={scope.keys.map((k) => scope.prefix + k)} strategy={scope.layout === 'tiles' ? rectSortingStrategy : scope.layout === 'grid' ? noShift : verticalListSortingStrategy}>
      <SortableInner scope={scope} itemKey={itemKey}>{children}</SortableInner>
    </SortableContext>
  );
}

/**
 * One page's arrangement and the actions on it. `keys` is the page's own
 * default order; `arranging` is whether the page is in Arrange mode (the
 * page's own state, not saved).
 */
export function usePageArrangement(pageId: string, keys: string[], opts: {
  defaultFolded?: string[];
  /**
   * Keys that are in `keys` but have nothing to show right now (Now Playing
   * with nobody watching). They are left out of `shown` until the page is
   * being arranged, so they can still be moved, folded and hidden; the page
   * draws them as a dashed placeholder (ArrangeSection's `emptyNote`).
   */
  empty?: string[];
  /** 'grid' when the sections sit side by side (the Dashboard), for drag. */
  layout?: SortLayout;
  /**
   * The page draws its sections in an <ArrangeGrid> (6 columns from a laptop
   * up), so each section gets a Width (Full / Half / Third) while arranging.
   * `defaultWidth` is a section's width before anyone changes it (the
   * Dashboard's half-width panels); everything else is Full.
   */
  widths?: boolean;
  defaultWidth?: Record<string, SectionSize>;
} = {}) {
  const { arrangement, update, session, canUndo, undo, cancel } = useArrangement();
  const page = arrangement.pages?.[pageId];
  const [arranging, setArranging] = useState(false);
  const keysKey = keys.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { shown: allShown, hidden } = useMemo(() => arrangeKeys(keys, page), [keysKey, page]);
  const emptyKey = (opts.empty || []).join('\u0000');
  const emptySet = useMemo(() => new Set(opts.empty || []), [emptyKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(
    () => (arranging || emptySet.size === 0 ? allShown : allShown.filter((k) => !emptySet.has(k))),
    [arranging, emptySet, allShown],
  );
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

  // Opening Arrange starts the provider's Undo history; closing it ends it.
  const startArranging = useCallback((on: boolean) => {
    session(on);
    setArranging(on);
  }, [session]);
  useEffect(() => {
    if (!arranging) return;
    return () => session(false);
  }, [arranging, session]);

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

  const moveTo = (key: string, over: string) => setPage((p) => ({ ...p, order: moveKey(orderKeys(keys, p?.order), key, over) }));
  const sort = useSortableScope({ keys: shown, onMove: moveTo, enabled: arranging, layout: opts.layout ?? (opts.widths ? 'grid' : 'list') });
  const hiddenItems = useMemo(() => new Set(page?.hidden || []), [page]);

  const widthOf = (key: string): SectionSize => page?.widths?.[key] ?? opts.defaultWidth?.[key] ?? 'full';
  const SPAN: Record<SectionSize, string> = { full: 'lg:col-span-6', half: 'lg:col-span-3', third: 'lg:col-span-2' };

  return {
    shown,
    hidden,
    /** Width (Full / Half / Third) and card size (S / M / L), saved with the page; Reset clears them. */
    hasWidths: !!opts.widths,
    widthOf,
    setWidth: (key: string, w: SectionSize) => setPage((p) => {
      const widths = { ...(p?.widths || {}) };
      // Back at the section's own default: nothing to store.
      if (w === (opts.defaultWidth?.[key] ?? 'full')) delete widths[key]; else widths[key] = w;
      return { ...p, widths };
    }),
    /** The class that gives a section's wrapper its width inside an <ArrangeGrid>. */
    spanClass: (key: string) => SPAN[widthOf(key)],
    /** Which side of the page title something sits on (left unless moved). */
    sideOf: (key: string): 'left' | 'right' => page?.sides?.[key] ?? 'left',
    setSide: (key: string, side: 'left' | 'right') => setPage((p) => {
      const sides = { ...(p?.sides || {}) };
      if (side === 'left') delete sides[key]; else sides[key] = side;
      return { ...p, sides };
    }),
    /** The stretched size of a row or grid of cards (StretchHandle sets it). */
    cardSizing: (key: string): CardSizing => cardSizingOf(page, key),
    setCardSizing: (key: string, next: CardSizing) => setPage((p) => {
      const cards = { ...(p?.cards || {}) };
      const merged: CardSizing = { ...cardSizingOf(p, key), ...next };
      if (!merged.w) delete merged.w;
      if (!merged.p) delete merged.p;
      if (merged.w || merged.p) cards[key] = merged; else delete cards[key];
      return { ...p, cards };
    }),
    /** Put on a row or grid of cards (spread): it sizes itself from them (see "Stretch to size" in globals.css). */
    cardAttrs: (key: string) => cardAttrsOf(cardSizingOf(page, key)),
    /** Drag to reorder: what ArrangeSection, ArrangePanel and ArrangeControls use. */
    sort,
    /** True for a key the page has but has nothing to show (see opts.empty). */
    isEmpty: (key: string) => emptySet.has(key),
    isFolded: (key: string) => folded.has(key),
    arranging,
    setArranging: startArranging,
    /** Step back one change made since Arrange opened. */
    canUndo,
    undo,
    /** Put the page back as it was when Arrange opened, and stop arranging. */
    cancel: () => {
      cancel();
      setArranging(false);
    },
    canMove: (key: string, dir: -1 | 1) => {
      const i = shown.indexOf(key);
      return i >= 0 && i + dir >= 0 && i + dir < shown.length;
    },
    move: (key: string, dir: -1 | 1) => setPage((p) => ({ ...p, order: stepKey(keys, p, key, dir, arranging ? undefined : emptySet) })),
    moveTo,
    /** Small things inside a section (one number of a strip) hide by their own key, kept with the page's hidden keys. */
    isItemHidden: (key: string) => hiddenItems.has(key),
    setItemHidden: (key: string, on: boolean) => setPage((p) => withHidden(p, key, on)),
    hide: (key: string) => setPage((p) => withHidden(p, key, true)),
    show: (key: string) => setPage((p) => withHidden(p, key, false)),
    fold: (key: string, on: boolean) => setPage((p) => withFolded(p, key, on)),
    reset: () => setPage(() => ({})),
    isDefault: !page,
  };
}

export type PageArrange = ReturnType<typeof usePageArrangement>;

// Only an object is a size: anything else (an older S / M / L) reads as the page's own.
function cardSizingOf(page: PageArrangement | undefined, key: string): CardSizing {
  const c = page?.cards?.[key] as unknown;
  return c && typeof c === 'object' ? c as CardSizing : {};
}

/** The attributes and CSS variables a stretched grid or row needs. Small cards tighten, big ones get room. */
export function cardAttrsOf(c: CardSizing): { style?: CSSProperties; 'data-cw'?: ''; 'data-cp'?: ''; 'data-cards'?: 'S' | 'L'; 'data-cards-phone'?: 'S' } {
  const out: ReturnType<typeof cardAttrsOf> = {};
  const style: Record<string, string> = {};
  if (c.w) {
    style['--cw'] = `${c.w}px`;
    out['data-cw'] = '';
    if (c.w < 250) out['data-cards'] = 'S';
    else if (c.w >= 420) out['data-cards'] = 'L';
  }
  if (c.p) {
    style['--cp'] = String(c.p);
    out['data-cp'] = '';
    if (c.p >= 2) out['data-cards-phone'] = 'S';
  }
  if (c.w || c.p) out.style = style as CSSProperties;
  return out;
}

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

/** Compact (the default) or Comfortable (Themes → Layout), for this account. */
export function useDensity() {
  const { arrangement, update } = useArrangement();
  // Nothing saved means Compact; choosing Comfortable is what gets stored.
  const density = arrangement.density === 'comfortable' ? 'comfortable' : 'compact';
  const setDensity = useCallback((d: 'comfortable' | 'compact') => {
    update((prev) => {
      const out: Arrangement = { ...prev, density: d };
      if (d === 'compact') delete out.density;
      return out;
    });
  }, [update]);
  return { density, setDensity };
}

/** Now Playing: who is watching under the picture (the default) or on it. */
export function useNowPlayingWho() {
  const { arrangement, update } = useArrangement();
  const where: 'under' | 'on' = arrangement.nowPlayingWho === 'on' ? 'on' : 'under';
  const setWhere = useCallback((w: 'under' | 'on') => {
    update((prev) => {
      const out: Arrangement = { ...prev, nowPlayingWho: 'on' };
      if (w === 'under') delete out.nowPlayingWho;
      return out;
    });
  }, [update]);
  return { where, setWhere };
}

/** The fold arrows beside section names (Themes -> Layout): hidden (the default) or shown. */
export function useFoldArrows() {
  const { arrangement, update } = useArrangement();
  const shown: 'show' | 'hide' = arrangement.foldArrows === 'show' ? 'show' : 'hide';
  const setShown = useCallback((v: 'show' | 'hide') => {
    update((prev) => {
      const out: Arrangement = { ...prev, foldArrows: 'show' };
      if (v === 'hide') delete out.foldArrows;
      return out;
    });
  }, [update]);
  return { shown, setShown };
}

/** Tapping a section's name folds it (Themes -> Layout): off (the default) or on. */
export function useNameFolds() {
  const { arrangement, update } = useArrangement();
  const on = arrangement.nameFolds === 'on';
  const setOn = useCallback((v: boolean) => {
    update((prev) => {
      const out: Arrangement = { ...prev, nameFolds: 'on' };
      if (!v) delete out.nameFolds;
      return out;
    });
  }, [update]);
  return { on, setOn };
}

/** Now Playing: the progress bar and times on the picture (the default) or under the card. */
export function useNowPlayingProgress() {
  const { arrangement, update } = useArrangement();
  const where: 'on' | 'under' = arrangement.nowPlayingProgress === 'under' ? 'under' : 'on';
  const setWhere = useCallback((w: 'on' | 'under') => {
    update((prev) => {
      const out: Arrangement = { ...prev, nowPlayingProgress: 'under' };
      if (w === 'on') delete out.nowPlayingProgress;
      return out;
    });
  }, [update]);
  return { where, setWhere };
}

/** Continue Watching: time left and Up next on the picture (the default) or under the card, with the episode name. */
export function useCwTime() {
  const { arrangement, update } = useArrangement();
  const where: 'on' | 'under' = arrangement.cwTime === 'under' ? 'under' : 'on';
  const setWhere = useCallback((w: 'on' | 'under') => {
    update((prev) => {
      const out: Arrangement = { ...prev, cwTime: 'under' };
      if (w === 'on') delete out.cwTime;
      return out;
    });
  }, [update]);
  return { where, setWhere };
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

/**
 * The Dashboard's Needs you: tiles put away one at a time ("Dismiss this
 * one", "Snooze for a week") or a whole kind at once ("Don't show this kind
 * again"). Saved with the account's arrangement. A put-away tile comes back
 * when its state changes (`sig`: a new error, say), and a snooze ends by
 * itself. Kinds: 'signin', 'request', 'vault'.
 */
export const NEEDS_WEEK = 7 * 24 * 60 * 60 * 1000;
export const NEEDS_KIND_NAMES: Record<string, string> = { signin: 'Sign-in problems', request: 'Requests to join', vault: 'Vault reminders' };
export function useNeedsDismiss() {
  const { arrangement, update } = useArrangement();
  const needs = arrangement.needs;
  const muted = useMemo(() => new Set(needs?.muted || []), [needs]);
  const dismissed = needs?.dismissed;
  const write = useCallback((fn: (n: NeedsDismissals) => NeedsDismissals) => {
    update((prev) => {
      const n = fn(prev.needs || {});
      const clean: NeedsDismissals = {};
      if (n.muted?.length) clean.muted = n.muted;
      if (n.dismissed && Object.keys(n.dismissed).length) clean.dismissed = n.dismissed;
      const out: Arrangement = { ...prev, needs: clean };
      if (!clean.muted && !clean.dismissed) delete out.needs;
      return out;
    });
  }, [update]);
  /** True while this tile should stay out of the list. */
  const isPutAway = useCallback((key: string, kind: string, sig: string, at: number = Date.now()) => {
    if (muted.has(kind)) return true;
    const d = dismissed?.[key];
    if (!d || d.sig !== sig) return false;
    return d.until === undefined || d.until > at;
  }, [muted, dismissed]);
  /** `label` is what Settings → Notifications lists it as. */
  const dismiss = useCallback((key: string, sig: string, snoozeMs?: number, label?: string) => {
    write((n) => {
      const now = Date.now();
      // Ended snoozes don't pile up in the saved copy.
      const kept = Object.fromEntries(Object.entries(n.dismissed || {}).filter(([, d]) => d.until === undefined || d.until > now));
      kept[key] = { sig, ...(snoozeMs ? { until: now + snoozeMs } : {}), ...(label ? { label } : {}) };
      return { ...n, dismissed: kept };
    });
  }, [write]);
  const mute = useCallback((kind: string, on: boolean) => {
    write((n) => ({ ...n, muted: on ? [...new Set([...(n.muted || []), kind])] : (n.muted || []).filter((k) => k !== kind) }));
  }, [write]);
  const restore = useCallback((key: string) => {
    write((n) => {
      const next = { ...(n.dismissed || {}) };
      delete next[key];
      return { ...n, dismissed: next };
    });
  }, [write]);
  return { muted, dismissed: dismissed || {}, isPutAway, dismiss, mute, restore };
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
  return (
    <ArrangeProvider key={store.localKey} store={store}>
      <PersonDnd>{children}</PersonDnd>
    </ArrangeProvider>
  );
}

// A person's pages have no drag layer of their own (the admin layout has one);
// this gives them the same one so Arrange mode can drag there too.
function PersonDnd({ children }: { children: ReactNode }) {
  return (
    <VaultDragProvider>
      <PersonDndInner>{children}</PersonDndInner>
    </VaultDragProvider>
  );
}

function PersonDndInner({ children }: { children: ReactNode }) {
  const sensors = useSortableSensors();
  const { dragEndHandlersRef } = useVaultDrag();
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => dragEndHandlersRef.current.forEach((h) => h(e))}>
      {children}
    </DndContext>
  );
}
