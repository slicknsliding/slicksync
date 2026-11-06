// Field hygiene for Vault entries, shared by the routes and by the paths that
// recreate entries from a file (recovery kit import, Trash restore).

// A dashboard link is rendered as a clickable link, so only http(s) is
// allowed - a javascript: or data: URL stored here would run when clicked.
// Returns the cleaned URL, '' for "none", or null when it is not acceptable.
function cleanDashboardUrl(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length > 2048) return null
  try {
    const u = new URL(trimmed)
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : null
  } catch { return null }
}

// For restore/import paths: keep a good link, drop a bad one.
function sanitizeRestoredEntry(data) {
  if (!data || typeof data !== 'object') return data
  if ('dashboardUrl' in data) {
    const url = cleanDashboardUrl(data.dashboardUrl)
    data.dashboardUrl = url || null
  }
  return data
}

module.exports = { cleanDashboardUrl, sanitizeRestoredEntry }
