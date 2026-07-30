import { API_BASE } from './api';

// Resolves which poster URL to actually render for a title: RPDB's
// rating-embedded art (when configured, via our own /api/poster proxy - see
// server/routes/posters.js for why it's a redirect rather than a raw RPDB
// URL) if the item has a real IMDb id, otherwise the item's own already-
// stored poster (Cinemeta/TMDb/etc., whatever it already was).
//
// RPDB only knows title posters, not backdrops/thumbnails/person photos -
// don't use this for anything that isn't a poster-shaped title card.
export function posterUrl(item: { id?: string | null; poster?: string | null }, rpdbEnabled: boolean): string | null {
  if (rpdbEnabled && item.id && /^tt\d+$/.test(item.id)) {
    return `${API_BASE}/poster/${item.id}`;
  }
  return item.poster || null;
}
