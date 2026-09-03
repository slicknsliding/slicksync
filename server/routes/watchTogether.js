// Watch-ahead protection - "watching together" pacts (see utils/watchTogether.js).
const express = require('express')

module.exports = function watchTogetherRouter({ prisma, getAccountId }) {
  const router = express.Router()
  const wt = require('../utils/watchTogether')

  router.get('/', async (req, res) => {
    try {
      res.json(await wt.listPacts(prisma, getAccountId(req)))
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Failed to list' })
    }
  })

  router.post('/', async (req, res) => {
    try {
      const { showId, showName, userIds } = req.body || {}
      await wt.upsertPact(prisma, getAccountId(req), { showId, showName, userIds })
      res.json({ success: true })
    } catch (e) {
      res.status(400).json({ error: e?.message || 'Failed to save' })
    }
  })

  router.delete('/:showId', async (req, res) => {
    try {
      await wt.deletePact(prisma, getAccountId(req), req.params.showId)
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Failed to delete' })
    }
  })

  return router
}
