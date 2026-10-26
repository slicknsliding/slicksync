// The title to show for a proxy stream.
//
// A proxy stream only has a filename to go on, and release names carry the
// title in whatever language the release was made for - "Toy Story - Il
// mondo dei giocattoli (1995)" is Toy Story. Once the poster lookup has
// matched the stream to a real title, that title's own name is what a person
// expects to read, with the year the stream carried kept alongside it. Rows
// that never matched keep the parsed name; there is nothing better to show.
function proxyDisplayTitle(row) {
  if (!row) return null
  const raw = row.displayName || row.filename || null
  if (!row.metadataName) return raw
  const year = (row.displayName || '').match(/\((\d{4})\)\s*$/)
  return year ? `${row.metadataName} (${year[1]})` : row.metadataName
}

// What a card says while a stream's title isn't known yet.
const TITLE_PENDING_NAME = 'Title not known yet'

const MEDIA_EXTENSION = /\.(mkv|mp4|avi|ts|m4v|webm)$/i

// A stream's name can be an opaque file or cache id (a usenet or debrid hash)
// rather than a title. Opaque means: no whitespace, 20+ characters of
// letters, digits, "_" and "-", at least one digit - after a trailing media
// extension is stripped. Release names ("Powder.1995.1080p.AMZN.WEB-DL") carry
// dots, and titles carry spaces or parentheses, so neither is caught. A pure
// hex or base64-ish run is opaque too, even without a digit-bearing look.
function isOpaqueStreamName(name) {
  const n = String(name || '').trim().replace(MEDIA_EXTENSION, '')
  if (!n) return true
  if (/\s/.test(n) || !/^[A-Za-z0-9_-]+$/.test(n)) return false
  if (n.length < 20) return false
  return /\d/.test(n) || /^[0-9a-f]+$/i.test(n)
}

module.exports = { proxyDisplayTitle, isOpaqueStreamName, TITLE_PENDING_NAME }
