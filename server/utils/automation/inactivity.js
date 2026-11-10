// Fires the "user.inactive" automation trigger: someone hasn't been seen
// watching anything (utils/lastSeen.js - the "Last seen" on their card) for
// at least the rule's number of days. Checked hourly from scheduler.js.
//
// Once per quiet stretch: the person's last-seen moment is remembered per
// rule (account settings, `automationInactivityFired`), and the same stretch
// never fires the same rule twice. It is kept there rather than looked up in
// the run log because the log is pruned, and a pruned entry made the rule
// fire all over again on the next hourly pass. When they
// watch something again, their last seen moves on, and a later quiet stretch
// can fire again.
//
// Skipped: people already switched off, and people given an access end date
// in the future - someone set that on purpose, so an inactivity rule doesn't
// second-guess it.

const DAY_MS = 24 * 60 * 60 * 1000

function parseJson(raw, fallback) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch { return fallback }
}

const SYNC_KEY = 'automationInactivityFired'

async function readFired(prisma, accountId) {
  try {
    const acc = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    let cfg = acc?.sync
    if (typeof cfg === 'string') cfg = JSON.parse(cfg)
    const state = cfg && cfg[SYNC_KEY]
    return state && typeof state === 'object' ? state : {}
  } catch { return {} }
}

// Merge what this pass fired into a fresh read of the stored state, and drop
// entries for rules that no longer exist.
async function saveFired(prisma, accountId, newlyFired, liveRuleIds) {
  const { updateAccountSyncKey } = require('../accountSyncKey')
  await updateAccountSyncKey(prisma, accountId, SYNC_KEY, (cur) => {
    const next = {}
    const base = cur && typeof cur === 'object' ? cur : {}
    for (const ruleId of liveRuleIds) {
      const merged = { ...(base[ruleId] || {}), ...(newlyFired[ruleId] || {}) }
      if (Object.keys(merged).length) next[ruleId] = merged
    }
    return next
  })
}

async function runInactivityCheck(prisma, { now = Date.now(), emit } = {}) {
  const fire = emit || require('./engine').emitAutomationEvent
  const rules = await prisma.automationRule.findMany({ where: { triggerType: 'user.inactive', enabled: true } })
  if (rules.length === 0) return 0
  const { lastSeenByUser } = require('../lastSeen')
  const byAccount = new Map()
  for (const rule of rules) {
    if (!byAccount.has(rule.accountId)) byAccount.set(rule.accountId, [])
    byAccount.get(rule.accountId).push(rule)
  }

  let fired = 0
  for (const [accountId, accountRules] of byAccount) {
    try {
      const users = await prisma.user.findMany({
        where: { accountId, isActive: true },
        select: { id: true, username: true, email: true, providerType: true, expiresAt: true, createdAt: true },
      })
      const seen = await lastSeenByUser(prisma, accountId, users)
      const firedState = await readFired(prisma, accountId)
      const newlyFired = {}
      for (const rule of accountRules) {
        const days = Number(parseJson(rule.triggerConfig, {}).days)
        if (!(days >= 1)) continue
        for (const user of users) {
          if (user.expiresAt && new Date(user.expiresAt).getTime() > now) continue
          // Never seen watching: quiet since they were added.
          const last = seen.get(user.id) || (user.createdAt ? new Date(user.createdAt) : null)
          if (!last) continue
          const daysInactive = Math.floor((now - last.getTime()) / DAY_MS)
          if (daysInactive < days) continue
          const marker = last.toISOString()
          if (firedState[rule.id] && firedState[rule.id][user.id] === marker) continue
          const result = await fire(prisma, accountId, 'user.inactive', {
            username: user.username,
            userId: user.id,
            email: user.email,
            providerType: user.providerType || 'stremio',
            daysInactive,
            lastSeen: marker,
            neverSeen: !seen.has(user.id),
          }, { ruleId: rule.id })
          if (result?.fired) {
            fired++
            ;(newlyFired[rule.id] = newlyFired[rule.id] || {})[user.id] = marker
          }
        }
      }
      if (Object.keys(newlyFired).length) {
        const allRules = await prisma.automationRule.findMany({ where: { accountId, triggerType: 'user.inactive' }, select: { id: true } })
        await saveFired(prisma, accountId, newlyFired, allRules.map((r) => r.id))
      }
    } catch (e) {
      console.warn(`[AutomationInactivity] ${accountId}:`, e?.message || e)
    }
  }
  return fired
}

module.exports = { runInactivityCheck }
