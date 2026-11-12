// Fails a release whose version numbers disagree.
//
//   node scripts/release-check.js v1.105.0
//
// A tag vX.Y.Z must match package.json's version and the newest entry in
// client/public/changelog.json, which is what the app's "what's new" and
// update notice read. A mismatch used to ship anyway: the app then told
// people an update was waiting when they were already on it, or showed the
// previous release's notes. Tags that are not vX.Y.Z (beta-v...) are skipped.

const fs = require('fs')
const path = require('path')

function checkRelease(tag, root = path.join(__dirname, '..')) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || '').trim())
  if (!m) return { skipped: true, problems: [] }
  const version = m[1]
  const problems = []
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.version !== version) problems.push(`package.json says ${pkg.version}, the tag says ${version}`)
  const changelog = JSON.parse(fs.readFileSync(path.join(root, 'client', 'public', 'changelog.json'), 'utf8'))
  const top = Array.isArray(changelog) ? changelog[0]?.version : undefined
  if (top !== version) problems.push(`the newest changelog.json entry is ${top ?? 'missing'}, the tag says ${version}`)
  return { skipped: false, problems }
}

module.exports = { checkRelease }

if (require.main === module) {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME
  const { skipped, problems } = checkRelease(tag)
  if (skipped) { console.log(`Not a release tag (${tag || 'none'}), nothing to check.`); process.exit(0) }
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`)
    process.exit(1)
  }
  console.log(`✔ ${tag}: package.json and changelog.json agree.`)
}
