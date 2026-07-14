// GET/POST the account's AIOMetadata manifest URL - lets it be changed from
// the UI rather than requiring a redeploy/env var change.
const { Router } = require('express')

module.exports = ({ prisma, getAccountId }) => {
  const router = Router()

  router.get('/manifest-url', async (req, res) => {
    try {
      const accountId = getAccountId(req)
      const account = await prisma.appAccount.findUnique({
        where: { id: accountId },
        select: { aiometadataManifestUrl: true },
      })
      res.json({ manifestUrl: account?.aiometadataManifestUrl || null })
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch AIOMetadata manifest URL', error: error.message })
    }
  })

  router.post('/manifest-url', async (req, res) => {
    try {
      const accountId = getAccountId(req)
      const { manifestUrl } = req.body || {}

      if (manifestUrl !== null && typeof manifestUrl !== 'string') {
        return res.status(400).json({ message: 'manifestUrl must be a string or null' })
      }
      if (manifestUrl && !/^https?:\/\/.+\/manifest\.json\/?$/.test(manifestUrl)) {
        return res.status(400).json({ message: 'manifestUrl must end in /manifest.json' })
      }

      await prisma.appAccount.update({
        where: { id: accountId },
        data: { aiometadataManifestUrl: manifestUrl || null },
      })

      res.json({ success: true, manifestUrl: manifestUrl || null })
    } catch (error) {
      res.status(500).json({ message: 'Failed to update AIOMetadata manifest URL', error: error.message })
    }
  })

  return router
}
