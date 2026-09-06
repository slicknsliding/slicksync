const express = require('express');
const fs = require('fs');
const core = require('../utils/imageCacheCore');

// GET /api/img?src=<encoded absolute http(s) URL, or /uploads/avatars/<file>>&w=<width>
//
// The poster resize/cache proxy. The pipeline itself - what gets kept as-is,
// what gets resized in a worker, how the disk cache is keyed and pruned -
// lives in utils/imageCacheCore.js so the background pre-warmer can use the
// same one; this file is the HTTP shape around it.
//
// Deliberately a sibling of /api/poster (posters.js), not a replacement:
// that route's whole job is keeping the RPDB API key out of rendered <img>
// URLs via a redirect, and its images already embed rating bars sized by
// RPDB itself. This route handles everything else - plain http(s) poster
// URLs already stored in item data, and this instance's own avatars.
module.exports = () => {
  const router = express.Router();

  const serve = (res, hit) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', hit.contentType);
    return fs.createReadStream(hit.path).pipe(res);
  };

  router.get('/', async (req, res) => {
    const src = String(req.query.src || '');
    if (!src) return res.status(400).json({ error: 'src required' });
    // Snap to the nearest allowed width rather than 400ing - callers pass a
    // constant from the client helper anyway, this just keeps the contract
    // forgiving.
    const w = core.snapWidth(req.query.w);

    // A profile picture from this instance's own uploads: the most-repeated
    // image in the app (every history row, member list, watcher cluster),
    // and often an animated GIF. Through here it becomes one static,
    // resized frame; only the full-size profile view keeps the animation.
    let localFile = null;
    const local = await core.resolveLocalAvatar(src);
    if (local?.status) return res.status(local.status).json({ error: local.status === 404 ? 'not found' : 'invalid source' });
    if (local?.localFile) localFile = local.localFile;

    // Format is negotiated, not guessed: every browser that can decode WebP
    // says so in Accept, and anything that does not keeps getting JPEG. Vary
    // tells any cache in between that this response depends on Accept.
    const encoder = await core.getEncoder();
    const wantsWebp = encoder.webp && /image\/webp/i.test(String(req.get('accept') || ''));
    res.setHeader('Vary', 'Accept');

    const fallback = () => { try { res.redirect(302, src); } catch {} };

    // Cache hit, in either format. The other format is served immediately
    // and the requested one produced behind the response - the day WebP
    // was switched on turned every cached poster into a miss (561ms cold
    // against 3ms warm) and a format change should be invisible.
    const hit = await core.findCached(src, w, wantsWebp);
    if (hit) {
      if (!hit.exact) core.produce(src, { w, wantsWebp, localFile }).catch(() => {});
      return serve(res, hit);
    }

    if (!localFile) {
      try {
        await core.assertSafeUrl(src);
      } catch {
        // Not a fetchable/safe URL - don't even redirect to it.
        return res.status(400).json({ error: 'invalid source url' });
      }
      // Remote animated/vector formats pass straight through untouched.
      if (core.isPassthroughUrl(src)) return fallback();
    }

    try {
      const out = await core.produce(src, { w, wantsWebp, localFile });
      return serve(res, out);
    } catch {
      return fallback();
    }
  });

  return router;
};
