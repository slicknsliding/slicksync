const express = require('express');
const { fetchCatalog } = require('../utils/discover');

// Discover - browse/search Cinemeta's real catalogs and preview results
// through the same MediaDetailModal used elsewhere. Stateless proxy to
// Cinemeta, no account-scoped data of its own, so no accountScopingMiddleware
// or prisma dependency needed here.
module.exports = () => {
  const router = express.Router();

  // GET /api/discover/browse?type=movie|series&catalog=top|year|imdbRating&genre=X&skip=N
  router.get('/browse', async (req, res) => {
    try {
      const { type = 'movie', catalog = 'top', genre, skip } = req.query
      if (type !== 'movie' && type !== 'series') {
        return res.status(400).json({ error: 'type must be movie or series' })
      }
      const items = await fetchCatalog(type, {
        catalog,
        genre: genre || undefined,
        skip: skip ? Number(skip) : undefined
      })
      res.json(items)
    } catch (error) {
      console.error('Error fetching discover catalog:', error)
      res.status(500).json({ error: 'Failed to fetch catalog' })
    }
  })

  // GET /api/discover/search?type=movie|series&query=X
  // Search only works against the "top" catalog - that's the only one
  // Cinemeta's own manifest advertises search support for.
  router.get('/search', async (req, res) => {
    try {
      const { type = 'movie', query } = req.query
      if (type !== 'movie' && type !== 'series') {
        return res.status(400).json({ error: 'type must be movie or series' })
      }
      if (!query || !query.trim()) {
        return res.json([])
      }
      const items = await fetchCatalog(type, { catalog: 'top', search: query.trim() })
      res.json(items)
    } catch (error) {
      console.error('Error searching discover catalog:', error)
      res.status(500).json({ error: 'Failed to search catalog' })
    }
  })

  return router;
};
