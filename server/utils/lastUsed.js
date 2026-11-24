// "Last used" for the Superadmin panel: the last DAY an account was used, never
// a time. The auth gate calls markUsed() on every request it has already
// looked the account up for, so every way in counts the same: password,
// passkey, single sign-on, Stremio, Nuvio and Jellyfin sign-ins, and simply
// opening SlickSync while signed in.
//
// The day the account signed up doesn't count. Signing up signs you straight
// in, so counting it would make every account look used; "Never used" means
// nobody came back after creating it, which is what the panel needs to see.
const { getAccountDayKey, DEFAULT_TIMEZONE } = require('./dateUtils')

const dayKey = (date = new Date()) => getAccountDayKey(date, DEFAULT_TIMEZONE)

// Accounts already written today, so a burst of requests writes once.
const writtenToday = new Map()

/**
 * Records today as the account's last-used day, at most once a day.
 * `account` is the row the caller already read: { id, createdAt, lastActiveDay }.
 * Best-effort: never throws, never delays the request.
 */
function markUsed(prisma, account, now = new Date()) {
  try {
    if (!account?.id || !account.createdAt) return false
    const today = dayKey(now)
    if (account.lastActiveDay === today || writtenToday.get(account.id) === today) return false
    if (dayKey(new Date(account.createdAt)) === today) return false
    writtenToday.set(account.id, today)
    if (writtenToday.size > 50000) writtenToday.clear()
    prisma.appAccount.update({ where: { id: account.id }, data: { lastActiveDay: today } }).catch(() => {
      writtenToday.delete(account.id)
    })
    return true
  } catch {
    return false
  }
}

/**
 * Fills lastActiveDay from the old password-only lastLoginAt for accounts
 * that have no day yet, with the same sign-up-day rule. Safe to run on every
 * boot: it only touches rows still missing a day.
 */
async function backfillLastUsed(prisma) {
  const rows = await prisma.appAccount.findMany({
    where: { lastActiveDay: null, lastLoginAt: { not: null } },
    select: { id: true, createdAt: true, lastLoginAt: true },
  })
  let filled = 0
  for (const r of rows) {
    const day = dayKey(r.lastLoginAt)
    if (day === dayKey(r.createdAt)) continue
    await prisma.appAccount.update({ where: { id: r.id }, data: { lastActiveDay: day } }).catch(() => {})
    filled++
  }
  return filled
}

function resetForTests() { writtenToday.clear() }

module.exports = { markUsed, backfillLastUsed, dayKey, resetForTests }
