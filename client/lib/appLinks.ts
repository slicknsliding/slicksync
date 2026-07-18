/**
 * Client-side mirror of server/utils/appLinks.js - same deep-link formats,
 * used here for content that hasn't been watched yet (Discover, and the
 * detail modal in general) where there's no per-user provider to pick from
 * server-side, so both options are just offered directly to whoever's
 * looking at the modal.
 *
 * Stremio's format is documented by Stremio's own SDK
 * (stremio.github.io/stremio-addon-sdk/deep-links.html). Nuvio's format was
 * confirmed by reading NuvioMedia/NuvioDesktop's own source (AppUrlBridge.kt)
 * rather than guessed at.
 */

export function buildStremioAppUrl(imdbId: string, type: 'movie' | 'series'): string {
  const videoId = type === 'movie' ? imdbId : '';
  return `stremio:///detail/${type}/${imdbId}/${videoId}`;
}

export function buildNuvioAppUrl(imdbId: string, type: 'movie' | 'series'): string {
  return `nuvio://meta?type=${encodeURIComponent(type)}&id=${encodeURIComponent(imdbId)}`;
}
