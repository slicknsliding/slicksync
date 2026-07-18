/**
 * Deep-link URL builders for Stremio and Nuvio, shared between Continue
 * Watching (always a specific episode) and Discover (a movie, or a series
 * with no specific episode chosen yet - just browsing/searching a catalog).
 *
 * Stremio's format is documented directly by Stremio's own SDK
 * (stremio.github.io/stremio-addon-sdk/deep-links.html):
 * - Movies: videoId is always the same as the id (movie is a "one-video type")
 * - Series, no specific episode: videoId is left empty - opens the show's
 *   own episode list/overview instead of jumping into playback
 * - Series, specific episode: videoId is "{imdbId}:{season}:{episode}"
 *
 * Nuvio's format was confirmed by reading NuvioMedia/NuvioDesktop's own
 * source (AppUrlBridge.kt, buildMetaDeepLinkUrl) rather than guessed at - it
 * has no season/episode concept at all (confirmed further by App.kt's own
 * deep-link handler, which only ever passes type+id to navigation), so it's
 * the same link regardless of episode.
 */

function buildStremioLinks(imdbId, type, season, episode) {
  let videoId = ''
  if (type === 'movie') {
    videoId = imdbId
  } else if (season != null && episode != null) {
    videoId = `${imdbId}:${season}:${episode}`
  }
  return {
    appUrl: `stremio:///detail/${type}/${imdbId}/${videoId}`,
    webUrl: `https://web.stremio.com/#/detail/${type}/${imdbId}/${videoId}`
  }
}

function buildNuvioAppUrl(type, imdbId) {
  return `nuvio://meta?type=${encodeURIComponent(type)}&id=${encodeURIComponent(imdbId)}`
}

module.exports = { buildStremioLinks, buildNuvioAppUrl }
