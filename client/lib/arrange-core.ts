// How someone has arranged SlickSync, and the pure rules that apply it.
// Everything here falls back to the default: an arrangement only records what
// was changed, so a section added in a later version simply appears in its
// default place, and Reset is "forget what was changed".

export type PageArrangement = {
  /** Keys in the order they were put in. Keys not listed keep their default place. */
  order?: string[];
  hidden?: string[];
  folded?: string[];
  /** Sections a page folds by default that were opened. */
  unfolded?: string[];
  /** How much of the page's width a section takes, by key. A key not listed keeps the page's default. */
  widths?: Record<string, SectionSize>;
  /** How big the cards in a row or grid are, stretched to size while arranging (by key). Not listed: the page's own size. */
  cards?: Record<string, CardSizing>;
};

export type SectionSize = 'full' | 'half' | 'third';
/** A stretched card size: `w` the card width (px) from 600px wide up, `p` cards per row on a phone. */
export type CardSizing = { w?: number; p?: number };

export type MenuArrangement = {
  order?: string[];
  /** Hidden pages move into a More menu. */
  hidden?: string[];
  /** false: hidden pages leave the menu completely (still open from search). */
  more?: false;
  rows?: 1 | 2;
  logo?: 'large' | 'small' | 'hidden';
  align?: 'center' | 'left';
};

export type Density = 'comfortable' | 'compact';

export type PageDesign = 'classic' | 'v2';

export type Arrangement = {
  /** Page design (Themes → Page design): Classic, or v2's grouped cards. */
  design?: PageDesign;
  pages?: Record<string, PageArrangement>;
  menu?: MenuArrangement;
  density?: Density;
  /** Now Playing: who is watching sits on the picture ('on'); under it otherwise. */
  nowPlayingWho?: 'on';
  /** Continue Watching: time left / Up next under the card ('under'); on the picture otherwise. */
  cwTime?: 'under';
  /** Where SlickSync opens: a page's address, e.g. '/activity'. */
  startPage?: string;
  /** Grid or list, per page. */
  views?: Record<string, 'grid' | 'list'>;
  /** Keep each page's filter between visits (off by default). */
  keepFilters?: boolean;
  /** A page's kept filter, per page. */
  filters?: Record<string, string>;
  /** Pinned items, per page: always first. */
  pinned?: Record<string, string[]>;
  /** What the Dashboard's Needs you no longer shows (see useNeedsDismiss). */
  needs?: NeedsDismissals;
};

export type NeedsDismissals = {
  /** Kinds of tile turned off: 'signin', 'request', 'vault'. */
  muted?: string[];
  /**
   * Single tiles put away, by tile key. `sig` is the tile's state when it was
   * put away (a new error changes it, and the tile comes back); `until` is
   * when a snooze ends (milliseconds), none for "dismiss".
   */
  dismissed?: Record<string, { sig: string; until?: number; label?: string }>;
};

/**
 * Puts `keys` (the default order) into the arranged order. Keys the
 * arrangement mentions take the slots those keys hold by default, in the
 * arranged order; keys it doesn't mention stay exactly where they are. So a
 * new section lands in its default spot rather than at the end.
 */
export function orderKeys(keys: string[], order: string[] | undefined): string[] {
  if (!order || order.length === 0) return keys;
  const known = new Set(keys);
  const arranged = order.filter((k, i) => known.has(k) && order.indexOf(k) === i);
  const moved = new Set(arranged);
  const out = keys.slice();
  let next = 0;
  for (let i = 0; i < out.length; i++) {
    if (moved.has(out[i])) out[i] = arranged[next++];
  }
  return out;
}

/** The arranged order split into what shows and what is hidden. */
export function arrangeKeys(keys: string[], page: PageArrangement | undefined) {
  const ordered = orderKeys(keys, page?.order);
  const hidden = new Set(page?.hidden || []);
  return {
    shown: ordered.filter((k) => !hidden.has(k)),
    hidden: ordered.filter((k) => hidden.has(k)),
  };
}

/** Pinned keys first (in pin order), then the rest as they were. */
export function pinFirst<T>(items: T[], keyOf: (item: T) => string, pinned: string[] | undefined): T[] {
  if (!pinned || pinned.length === 0) return items;
  const rank = new Map(pinned.map((k, i) => [k, i]));
  const pins = items.filter((it) => rank.has(keyOf(it))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...pins, ...items.filter((it) => !rank.has(keyOf(it)))];
}

/** Moves `key` one step up or down among the shown keys; returns the new full order. */
export function stepKey(keys: string[], page: PageArrangement | undefined, key: string, dir: -1 | 1, skip?: Set<string>): string[] {
  const ordered = orderKeys(keys, page?.order);
  const hidden = new Set(page?.hidden || []);
  // `skip`: keys that aren't drawn right now (an empty section outside Arrange mode).
  const shown = ordered.filter((k) => !hidden.has(k) && !skip?.has(k));
  const i = shown.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= shown.length) return ordered;
  return moveKey(ordered, key, shown[j]);
}

/** Moves `key` to where `over` is (drag and drop); returns the new full order. */
export function moveKey(ordered: string[], key: string, over: string): string[] {
  const from = ordered.indexOf(key);
  const to = ordered.indexOf(over);
  if (from < 0 || to < 0 || from === to) return ordered;
  const out = ordered.slice();
  out.splice(from, 1);
  out.splice(to, 0, key);
  return out;
}

function toggle(list: string[] | undefined, key: string, on: boolean) {
  const set = new Set(list || []);
  if (on) set.add(key);
  else set.delete(key);
  return [...set];
}

export function withHidden(page: PageArrangement | undefined, key: string, hidden: boolean): PageArrangement {
  return { ...page, hidden: toggle(page?.hidden, key, hidden) };
}

export function withFolded(page: PageArrangement | undefined, key: string, folded: boolean): PageArrangement {
  return { ...page, folded: toggle(page?.folded, key, folded), unfolded: toggle(page?.unfolded, key, !folded) };
}

/** Drops empty pieces so a page back at its default stores nothing. */
export function tidyPage(page: PageArrangement): PageArrangement | undefined {
  const out: PageArrangement = {};
  if (page.order?.length) out.order = page.order;
  if (page.hidden?.length) out.hidden = page.hidden;
  if (page.folded?.length) out.folded = page.folded;
  if (page.unfolded?.length) out.unfolded = page.unfolded;
  if (page.widths && Object.keys(page.widths).length) out.widths = page.widths;
  if (page.cards && Object.keys(page.cards).length) out.cards = page.cards;
  return Object.keys(out).length ? out : undefined;
}
