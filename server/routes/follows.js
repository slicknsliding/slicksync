const express = require('express')

// Follow / mute for the two alert feeds (see utils/followWatch.js): people
// whose new work should ping you, and shows whose renewal or cancellation
// should. Muting is a first-class action here, not an afterthought - the
// point of the feed is that it stays wanted.

module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router()

  // Everything followed, both kinds, muted included so the UI can show it.
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default'
      const items = await prisma.followedSubject.findMany({
        where: { accountId },
        orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
      })
      res.json(items)
    } catch (e) {
      res.status(500).json({ error: 'Failed to read follows' })
    }
  })

  // Follow a person or a show. Idempotent: following something already
  // followed un-mutes it rather than erroring, since that is what pressing
  // Follow again plainly means.
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default'
      const { kind, subjectId, name, poster } = req.body || {}
      if (!['person', 'show'].includes(kind)) return res.status(400).json({ error: 'kind must be person or show' })
      if (!subjectId || !name) return res.status(400).json({ error: 'subjectId and name are required' })
      const row = await prisma.followedSubject.upsert({
        where: { accountId_kind_subjectId: { accountId, kind, subjectId: String(subjectId) } },
        create: { accountId, kind, subjectId: String(subjectId), name: String(name), poster: poster || null },
        update: { muted: false, name: String(name), poster: poster || null },
      })
      res.json(row)
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Failed to follow' })
    }
  })

  // Mute / un-mute. The row survives either way, so re-following doesn't
  // replay news already announced.
  router.put('/:id/mute', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default'
      const muted = req.body?.muted !== false
      const { count } = await prisma.followedSubject.updateMany({
        where: { id: req.params.id, accountId },
        data: { muted },
      })
      if (count === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true, muted })
    } catch (e) {
      res.status(500).json({ error: 'Failed to update' })
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default'
      const { count } = await prisma.followedSubject.deleteMany({ where: { id: req.params.id, accountId } })
      if (count === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: 'Failed to unfollow' })
    }
  })

  // Run the sweep now rather than waiting for the twice-daily one.
  router.post('/check-now', async (req, res) => {
    try {
      const { runFollowSweep } = require('../utils/followWatch')
      const { resolveTmdbKeyForAccount } = require('../utils/listImport')
      await runFollowSweep(prisma, { resolveTmdbKeyForAccount })
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Check failed' })
    }
  })

  return router
}
