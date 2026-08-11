const express = require('express')
const QRCode = require('qrcode')

// GET /api/qr?data=<url> - renders a QR code PNG for arbitrary short text,
// almost always a URL. Built for TV Mode's OAuth linking flows (Stremio/
// Nuvio account connect, both admin- and user-facing) - a TV remote fighting
// with copy/paste or a WebView browser's own window.open() behavior is the
// worst part of that flow; scanning the same verification link with a phone
// sidesteps all of it. Deliberately unauthenticated and account-agnostic -
// this only ever encodes a URL that's already shown/clickable elsewhere on
// the same page, never anything sensitive on its own.
module.exports = () => {
  const router = express.Router()

  router.get('/', async (req, res) => {
    try {
      const data = String(req.query.data || '').trim()
      if (!data) return res.status(400).json({ error: 'data is required' })
      // QR codes get unreadable dense well before this - also keeps this
      // from being usable as a generic "encode anything into an image" endpoint.
      if (data.length > 2000) return res.status(400).json({ error: 'data too long' })

      const buffer = await QRCode.toBuffer(data, { width: 240, margin: 1 })
      res.set('Content-Type', 'image/png')
      // The underlying OAuth link is single-use/short-lived - never cache it,
      // a stale cached QR pointing at an expired link is worse than no QR.
      res.set('Cache-Control', 'no-store')
      res.send(buffer)
    } catch (e) {
      console.error('Error generating QR code:', e)
      res.status(500).json({ error: 'Failed to generate QR code' })
    }
  })

  return router
}
