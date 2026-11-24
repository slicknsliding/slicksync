/*
 * THE REAL NAME OF A USENET STREAM WHOSE FILE NAME IS SCRAMBLED.
 *
 * AIOStreams' live list names a usenet stream by the file inside the
 * download. Many releases scramble that name ("eGLM3dX5fu0v….mkv"), so the
 * list carries no title at all - while AIOStreams' own library holds the
 * release under its real name ("Other.Mommy.2026.2160p.MA.WEB-DL…"), keyed
 * by the hash that is in the stream's key ("usenet:<hash>:<file>:<path>").
 *
 * So a scrambled name is swapped for the library's before anything reads it:
 * the title lookup, Now Playing and "started watching" then work exactly as
 * they do for a stream that arrived with its name. A name is asked for once
 * per download and remembered; a miss is asked again after a few minutes.
 */
const { isOpaqueStreamName } = require('./proxyTitle')

const MISS_RETRY_MS = 5 * 60 * 1000
const MAX_REMEMBERED = 500
const names = new Map() // hash -> { name: string|null, at: ms }

function usenetHash(targetKey) {
  const m = /^usenet:([^:]+):/.exec(String(targetKey || ''))
  return m ? m[1] : null
}

/**
 * streams: the polled rows ({ transport, targetKey, filename }); changed in
 * place. lookup(hash) resolves to the library's name for it, or null.
 */
async function nameScrambledUsenetStreams(streams, lookup, now = Date.now()) {
  for (const s of streams || []) {
    if (!s || !isOpaqueStreamName(s.filename)) continue
    const hash = usenetHash(s.targetKey)
    if (!hash) continue
    let known = names.get(hash)
    if (!known || (!known.name && now - known.at > MISS_RETRY_MS)) {
      let name = null
      try { name = await lookup(hash) } catch { name = null }
      name = typeof name === 'string' && name.trim() && !isOpaqueStreamName(name) ? name.trim() : null
      known = { name, at: now }
      if (names.size >= MAX_REMEMBERED) names.delete(names.keys().next().value)
      names.set(hash, known)
    }
    if (known.name) s.filename = known.name
  }
  return streams
}

module.exports = { nameScrambledUsenetStreams, usenetHash, forgetNamesForTests: () => names.clear() }
