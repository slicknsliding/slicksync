const express = require('express');

// RatingPosterDB (RPDB) poster proxy. RPDB's whole design is a hotlinked
// image URL with the API key embedded in the path - there's no way around
// the browser needing to load the image directly from api.ratingposterdb.com
// eventually, but routing through our own redirect keeps the raw key out of
// every rendered <img> tag across the app (Discover, Lists, Activity,
// Airing Calendar) - a page-source/view-source look shows our own URL, not
// the key. A 302 redirect, not a byte-for-byte proxy, so the image itself
// never actually flows through this server (no bandwidth/latency cost here).
//
// Free tier (Tier 0) only supports the "poster-default" style, which is all
// this ever requests - confirmed via ratingposterdb.com's own tier page
// ("Posters with Default Ratings" is the Tier 0 feature; the customizable
// Badges/alternate styles are Tier 2+). ?fallback=true makes RPDB serve
// Cinemeta/TMDb's own art when it has nothing custom for a title, so a
// title RPDB doesn't cover still gets SOME poster rather than a broken image.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();

  // Shared resolver, so a configured backup RPDB key actually takes over here
  // too - posters are the single most visible thing a dead RPDB key breaks.
  async function resolveRpdbKey(req) {
    const { resolveKeyFromSettings } = require('../utils/listImport');
    return resolveKeyFromSettings(prisma, getAccountId, req, 'rpdbApiKey', 'RPDB_API_KEY');
  }

  // GET /api/poster/:imdbId - redirects to the RPDB poster for this IMDb id,
  // or 404s if RPDB isn't configured (callers should already know this via
  // usePersonalFeatures().rpdbEnabled before ever building this URL, so a
  // 404 here is a defensive fallback, not the expected happy path).
  router.get('/:imdbId', async (req, res) => {
    const imdbId = String(req.params.imdbId || '');
    if (!/^tt\d+$/.test(imdbId)) return res.status(400).json({ error: 'Invalid IMDb id' });

    const key = await resolveRpdbKey(req);
    if (!key) return res.status(404).json({ error: 'RPDB not configured' });

    res.redirect(302, `https://api.ratingposterdb.com/${encodeURIComponent(key)}/imdb/poster-default/${imdbId}.jpg?fallback=true`);
  });

  return router;
};
