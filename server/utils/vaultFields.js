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

// The fields a save can set that the database is strict about, checked
// before it sees them: a wrong type used to come back as a server error
// (500) instead of saying what was wrong. Returns the problem as a sentence,
// or null when everything given is fine. Fields left out are not checked.
function vaultFieldProblem(body = {}) {
  const { testType, notifyDaysBefore, isActive, secretLabel, expiresAt } = body
  if (testType !== undefined && testType !== null) {
    const { CHECKERS } = require('./vaultCheckers')
    if (typeof testType !== 'string' || (testType !== 'manual' && !Object.prototype.hasOwnProperty.call(CHECKERS, testType))) return 'testType is not a check SlickSync knows'
  }
  if (notifyDaysBefore !== undefined && notifyDaysBefore !== null) {
    if (!Number.isInteger(notifyDaysBefore) || notifyDaysBefore < 0 || notifyDaysBefore > 365) return 'notifyDaysBefore must be a whole number of days from 0 to 365'
  }
  if (isActive !== undefined && typeof isActive !== 'boolean') return 'isActive must be true or false'
  if (secretLabel !== undefined && secretLabel !== null && (typeof secretLabel !== 'string' || secretLabel.length > 100)) return 'secretLabel must be short text'
  if (expiresAt) {
    const t = (typeof expiresAt === 'string' || typeof expiresAt === 'number') ? new Date(expiresAt).getTime() : NaN
    if (isNaN(t)) return 'expiresAt must be a valid date'
    const year = new Date(t).getUTCFullYear()
    if (year < 2000 || year > 2200) return 'expiresAt must be a real date'
  }
  return null
}

// Billing: how often `cost` is paid. "once" and "free" have no renewal date.
const COST_CYCLES = ['monthly', 'yearly', 'once', 'free']
const normalizeCostCycle = (value) => (COST_CYCLES.includes(value) ? value : 'monthly')

// What a saved entry must look like, judged on the values it will have AFTER
// the save ({ category, costCycle, expiresAt, autoRenew, cost, ... }). Returns
// only the fields that have to be forced; the caller applies them on top of
// what it was about to write. Pure, so create, update and tests share it.
function billingRulePatch(after = {}) {
  const patch = {}
  if (after.category === 'note') {
    // A note is text to keep, not a service: nothing to check, pay or renew.
    return {
      testType: 'manual', testConfig: null, cost: null, costCycle: 'monthly',
      expiresAt: null, autoRenew: false, backupEntryId: null, dashboardUrl: null,
    }
  }
  const cycle = normalizeCostCycle(after.costCycle)
  if (cycle === 'once' || cycle === 'free') {
    patch.expiresAt = null
    patch.autoRenew = false
    if (cycle === 'free') patch.cost = null
  }
  // Only a monthly or yearly entry can renew itself (once/free cleared it above).
  return patch
}

module.exports = { cleanDashboardUrl, sanitizeRestoredEntry, vaultFieldProblem, COST_CYCLES, normalizeCostCycle, billingRulePatch }
