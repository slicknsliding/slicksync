// Loaded before Next's standalone server (scripts/start.sh, --preload).
//
// Next hands the backend at most proxyClientMaxBodySize of a request body
// (client/next.config.ts, 55 MB - just above the largest upload the backend
// takes). A body declared bigger than that is not refused: Next stops reading
// it and the request hangs until the proxy's 60-second timeout, then comes back
// as a bare 500 - so anyone, signed in or not, could hold the frontend for a
// minute per request. This answers such a request at once with 413, by its
// declared size alone, without reading any of it. Everything at or under the
// cap goes through untouched; the backend's own limits still apply to it.

const http = require('http')

const CAP_BYTES = 55 * 1024 * 1024

function capped(listener) {
  return function bodyCap(req, res) {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > CAP_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end('{"message":"request entity too large"}')
      return
    }
    return listener.call(this, req, res)
  }
}

const createServer = http.createServer
http.createServer = function (...args) {
  const i = args.findIndex((a) => typeof a === 'function')
  if (i >= 0) args[i] = capped(args[i])
  return createServer.apply(this, args)
}

module.exports = { capped, CAP_BYTES }
