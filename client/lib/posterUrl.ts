import { API_BASE } from './api';

// Resolves which poster URL to actually render for a title: RPDB's
// rating-embedded art (when configured, via our own /api/poster proxy - see
// server/routes/posters.js for why it's a redirect rather than a raw RPDB
// URL) if the item has a real IMDb id, otherwise the item's own already-
// stored poster (Cinemeta/TMDb/etc., whatever it already was).
//
// RPDB only knows title posters, not backdrops/thumbnails/person photos -
// don't use this for anything that isn't a poster-shaped title card.
//
// Returns `undefined`, not `null`, when there's no poster - React's <img
// src> prop type is `string | undefined`; a previous version returned
// `string | null` here and broke the production build (TS2322) at every
// call site passing this straight into src={...}.
export function posterUrl(item: { id?: string | null; poster?: string | null }, rpdbEnabled: boolean): string | undefined {
  if (isRpdbPoster(item, rpdbEnabled)) {
    return `${API_BASE}/poster/${item.id}`;
  }
  return cachedImageUrl(item.poster, 342);
}

/** posterUrl's srcSet companion - undefined for RPDB art (that route serves
 * one baked image) and for anything the cache proxy passes through. */
export function posterSrcSet(item: { id?: string | null; poster?: string | null }, rpdbEnabled: boolean): string | undefined {
  if (isRpdbPoster(item, rpdbEnabled)) return undefined;
  return cachedImageSrcSet(item.poster, 342);
}

/** Routes an external image URL through the server's resize/cache proxy
 * (server/routes/imageCache.js): fetched from the source once, resized to
 * the width actually displayed, then served from the operator's own disk
 * forever - faster grids, far less data on phones/TV. Width must be one of
 * the server's fixed menu; 342 covers poster cards up to ~170 CSS px at 2x
 * DPR, 780 is for the detail modal's large backdrop art.
 *
 * Passes through unchanged: empty values, relative/already-local URLs
 * (including /api/poster RPDB links, which handle themselves), and GIFs -
 * the server would freeze an animated cover to its first frame, and
 * Community Covers explicitly supports animated GIF art. */
export function cachedImageUrl(url: string | null | undefined, width: 154 | 342 | 500 | 780 = 342): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return url;
  if (API_BASE && url.startsWith(API_BASE)) return url;
  if (/\.gif(\?|$)/i.test(url)) return url;
  return `${API_BASE}/img?src=${encodeURIComponent(url)}&w=${width}`;
}

/**
 * The srcSet companion to cachedImageUrl: offers the browser the same image
 * at two widths so it can pick by the device's pixel ratio instead of always
 * downloading the larger file. A phone rendering a card at ~90 CSS px takes
 * the 154 (a quarter of the bytes of the 342, and less decode work per
 * scroll - decode time is a real part of scroll jank on phones), while a
 * desktop at 2x DPR still gets the 342.
 *
 * Returns undefined for anything cachedImageUrl passes through unchanged
 * (local URLs, GIFs, empty values), so callers can spread it safely - an
 * <img> with srcSet={undefined} is just a normal <img>.
 */
export function cachedImageSrcSet(url: string | null | undefined, width: 154 | 342 | 500 | 780 = 342): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return undefined;
  if (API_BASE && url.startsWith(API_BASE)) return undefined;
  if (/\.gif(\?|$)/i.test(url)) return undefined;
  const smaller: Record<number, 154 | 342 | 500 | 780> = { 342: 154, 500: 342, 780: 500, 154: 154 };
  const small = smaller[width];
  if (small === width) return undefined;
  return `${API_BASE}/img?src=${encodeURIComponent(url)}&w=${small} ${small}w, ${API_BASE}/img?src=${encodeURIComponent(url)}&w=${width} ${width}w`;
}

// True exactly when posterUrl() above would actually resolve to RPDB's art -
// same condition, kept in sync in one place. Callers that also render their
// own RatingBadges row need this: RPDB's poster already has an IMDb/Rotten
// Tomatoes/Metacritic bar baked into the image itself (that's the point of
// its "Posters with Default Ratings" tier), so drawing our own ratings row
// on top of an RPDB poster doubles up - two near-identical, slightly
// disagreeing rating bars stacked at the bottom of the same card. Only skip
// our own row when RPDB is actually supplying this specific poster; an item
// without a valid IMDb id still falls back to its own plain poster (no
// baked-in ratings), where our row is the only rating info there is.
export function isRpdbPoster(item: { id?: string | null }, rpdbEnabled: boolean): boolean {
  return !!(rpdbEnabled && item.id && /^tt\d+$/.test(item.id));
}
