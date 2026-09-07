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

module.exports = { proxyDisplayTitle }
