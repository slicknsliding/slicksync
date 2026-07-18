// One-time cleanup: clears a stray stremioAuthKey written onto a Nuvio user
// row.
//
// Background: getPublicUser() (server/routes/publicLibrary.js) resolved a
// Stremio OAuth login by email alone, with no providerType filter. For an
// account where the same email has both a Stremio and a Nuvio user row
// (@@unique([email, providerType]) exists specifically to support this),
// findFirst could non-deterministically return the Nuvio row instead of the
// Stremio one. When that happened, the code found no matching stremioAuthKey
// on the (wrong) row and fell through to its "update stale key" path,
// writing the Stremio session's auth key onto the Nuvio user - data that
// doesn't belong there and was never a valid Stremio credential for that
// account. Fixed in commit 092ff99.
//
// This finds every providerType: 'nuvio' user that has a non-null
// stremioAuthKey set (which should never legitimately happen - a Nuvio user
// is never expected to have one) and clears it.
//
// Safe to run more than once. Dry-run by default; pass --apply to clear.
//
// Usage:
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/fix-cross-provider-auth-key.js
//   docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/fix-cross-provider-auth-key.js --apply

const { PrismaClient } = require('@prisma/client')

async function main() {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  try {
    const affected = await prisma.user.findMany({
      where: { providerType: 'nuvio', stremioAuthKey: { not: null } },
      select: { id: true, username: true, email: true, providerType: true },
    })

    console.log(`Nuvio users with a stray stremioAuthKey: ${affected.length}\n`)
    for (const u of affected) {
      console.log(`  ${u.username}  (${u.email})  id=${u.id}`)
    }

    if (affected.length === 0) {
      console.log('Nothing to do.')
      return
    }

    if (apply) {
      const r = await prisma.user.updateMany({
        where: { id: { in: affected.map((u) => u.id) } },
        data: { stremioAuthKey: null },
      })
      console.log(`\nCleared stremioAuthKey on ${r.count} user(s).`)
    } else {
      console.log('\nDry run only - re-run with --apply to clear these.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
