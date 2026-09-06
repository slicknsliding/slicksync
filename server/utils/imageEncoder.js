/**
 * Image decoding and encoding, shared by the request path (utils/imageCacheCore.js)
 * and the worker threads (utils/imageWorker.js).
 *
 * Jimp, not sharp, on purpose: pure JS, no native binary to fail to resolve
 * under bun-on-alpine - see utils/posterMosaic.js for the original reasoning.
 * WebP comes from a WASM plugin for the same reason. Both are slow per
 * image (a 300x450 JPEG costs ~70ms to decode and ~100ms to re-encode on a
 * small ARM box), which is exactly why the callers try hard never to run
 * them: a source that is already small enough passes through untouched
 * (sourceDimensions below reads the size from the file header without
 * decoding), and what does need resizing runs off the request thread.
 */
const { Jimp } = require('jimp')

let encoderPromise = null
function getEncoder() {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      try {
        const [core, jimpMod, webpMod] = await Promise.all([
          import('@jimp/core'),
          import('jimp'),
          import('@jimp/wasm-webp'),
        ])
        const webp = webpMod.default || webpMod.webp
        const J = core.createJimp({
          formats: [...jimpMod.defaultFormats, webp],
          plugins: jimpMod.defaultPlugins,
        })
        return { read: (b) => J.read(b), webp: true }
      } catch (e) {
        console.warn('[ImageCache] WebP unavailable, serving JPEG:', e?.message)
        return { read: (b) => Jimp.read(b), webp: false }
      }
    })()
  }
  return encoderPromise
}

// Header sniffing - the format of a file from its first bytes, so a source
// that needs no work is never decoded just to find that out.
function sniffFormat(buf) {
  if (!buf || buf.length < 12) return 'unknown'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'unknown'
}

// JPEG: walk the marker segments to the first SOFn frame header.
function jpegDimensions(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue }
    const marker = buf[i + 1]
    if (marker === 0xff) { i += 1; continue }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return null
}

// WebP: three container flavours, each keeps its canvas size somewhere else.
function webpDimensions(buf) {
  if (buf.length < 30) return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  }
  return null
}

function sourceDimensions(buf) {
  const fmt = sniffFormat(buf)
  try {
    if (fmt === 'jpeg') return jpegDimensions(buf)
    if (fmt === 'webp') return webpDimensions(buf)
  } catch { /* a malformed header just means "decode it properly" */ }
  return null
}

/**
 * Decode, downscale to `w` if the source is wider, encode as `format`.
 * Only ever downscales - upscaling a small original just burns bytes on
 * blur. 78 for WebP against 80 for JPEG: the two scales are not the same
 * curve, and 78 is where WebP stops being visibly better than the JPEG it
 * replaces while still being materially smaller.
 */
async function encode(buf, { w, format }) {
  const enc = await getEncoder()
  const img = await enc.read(buf)
  if (img.width > w) img.resize({ w })
  if (format === 'webp' && enc.webp) {
    try {
      return { buf: await img.getBuffer('image/webp', { quality: 78 }), format: 'webp' }
    } catch (e) {
      // The codec is a WASM module fetched at first use; if that fails
      // here (a worker, or a runtime whose fetch cannot read files) the
      // answer is a JPEG, labelled as one - never JPEG bytes under a
      // .webp name.
      console.warn('[ImageCache] WebP encode failed, falling back to JPEG:', e?.message)
    }
  }
  return { buf: await img.getBuffer('image/jpeg', { quality: 80 }), format: 'jpeg' }
}

module.exports = { getEncoder, sniffFormat, jpegDimensions, webpDimensions, sourceDimensions, encode }
