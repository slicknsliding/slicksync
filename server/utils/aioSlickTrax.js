// SlickTrax inside a person's AIOStreams configuration: added for them, and
// watched so the household hears when their AIOStreams watch history stops
// reaching SlickSync.
//
// Install: turning on "AIOStreams watch history" for someone added with
// their configuration password adds the SlickTrax link to that
// configuration as a custom addon, instead of handing over a link to paste.
// The same sequence as every other write to a configuration
// (aiostreamsConfig.js): read it, report any outside change since the last
// look, write, re-baseline - so this write is never reported as an outside
// change itself. AIOStreams refuses a configuration with more addons than
// its MAX_ADDONS, and checks it can reach the link before saving; both are
// passed on in plain words.
//
// Watch (every 30 minutes, with the configuration change check). Each is
// one alert when it starts, by bell and push, and nothing more until it is
// fixed and happens again:
// - missing: SlickTrax is no longer in the configuration, or switched off.
// - trackers: a household user with a history of their own has a tracker
//   list that leaves SlickTrax out (persona.trackers holds preset
//   instanceIds; no list means "every tracker", which includes it).
// - libraries: SlickSync's catalogs didn't make AIOStreams' library cap -
//   read back from the libraries AIOStreams actually serves the person, not
//   worked out from the configuration: catalog order decides what survives.
// - quiet: nothing has arrived from AIOStreams for a week, after it had been
//   arriving the week before.

const crypto = require('crypto')
const { readConfig, writeConfig, rebaseline, noteOutsideChanges } = require('./aiostreamsConfig')
const { slickTraxPreset } = require('./aioProfileVariants')

const QUIET_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const COLLECTIONS_NAME = 'SlickSync catalogs'

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function accessFor(person, decrypt) {
  return {
    serverUrl: person.jellyfinServerUrl,
    account: person.aioConfigId,
    password: decrypt(person.aioConfigPassword, { appAccountId: person.accountId || 'default' }),
  }
}

function manifestUrlFor(base, token) {
  return `${String(base).replace(/\/+$/, '')}/trax/${token}/aio/manifest.json`
}

/** AIOStreams' own refusal, in words the household can act on. */
function explainRefusal(e, base) {
  const message = String(e?.message || '')
  const max = /maximum allowed is (\d+)/i.exec(message)
  if (max) {
    return fail(`This AIOStreams configuration is full - AIOStreams allows ${max[1]} addons on it. Remove one there (or ask whoever runs that AIOStreams to raise MAX_ADDONS), then turn this on again.`, 409)
  }
  if (/manifest/i.test(message)) {
    return fail(`AIOStreams couldn't reach SlickSync at ${base}. Set "Public address of this instance" under Settings -> Integrations to an address AIOStreams can reach, then turn this on again.`, 409)
  }
  return fail(message || 'AIOStreams refused the change', e?.status && e.status < 500 ? 409 : 502)
}

/**
 * Put SlickTrax in the person's AIOStreams configuration. Returns
 * { added: true } or { already: true }; throws a plain message otherwise.
 */
async function installSlickTrax(prisma, decrypt, person, base) {
  if (person.providerType !== 'jellyfin' || person.jellyfinServerKind !== 'aiostreams') throw fail('Only for someone on AIOStreams')
  if (!person.aioConfigId || !person.aioConfigPassword) {
    throw fail(`SlickSync needs ${person.username}'s AIOStreams configuration password to add it for them - reconnect them with it, or add the link by hand.`, 409)
  }
  if (!person.traxToken || !person.watchStateEnabled) throw fail('Turn on AIOStreams watch history first', 409)
  if (!base) throw fail('Fill in "Public address of this instance" under Settings -> Integrations first - AIOStreams has to be able to reach SlickSync.', 409)

  const access = accessFor(person, decrypt)
  const config = await readConfig(access)
  const existing = slickTraxPreset(config, person.traxToken)
  if (existing && existing.enabled !== false) return { already: true }

  if (existing) {
    existing.enabled = true
  } else {
    const presets = Array.isArray(config.presets) ? config.presets : []
    const taken = new Set(presets.map((p) => p?.instanceId))
    let instanceId
    do { instanceId = crypto.randomBytes(3).toString('hex') } while (taken.has(instanceId))
    config.presets = [...presets, {
      type: 'custom',
      instanceId,
      enabled: true,
      options: { name: 'SlickTrax', manifestUrl: manifestUrlFor(base, person.traxToken) },
    }]
  }

  try {
    await noteOutsideChanges(prisma, person, await readConfig(access))
  } catch (e) {
    console.warn('[AioSlickTrax] could not compare with the last look:', e?.message)
  }
  try {
    await writeConfig(access, config)
  } catch (e) {
    throw explainRefusal(e, base)
  }
  try {
    await rebaseline(prisma, person, await readConfig(access))
  } catch (e) {
    console.warn('[AioSlickTrax] could not re-read the configuration after saving:', e?.message)
  }
  return { added: true }
}

// ---------------------------------------------------------------------------
// Watching it

/** What is wrong right now: [{ kind, title, body }]. Reads only. */
async function findProblems(prisma, person, config, { libraries = null, now = Date.now() } = {}) {
  const problems = []
  const name = person.username || 'Someone'
  const preset = slickTraxPreset(config, person.traxToken)
  if (!preset || preset.enabled === false) {
    problems.push({
      kind: 'missing',
      title: `${name}'s AIOStreams watch history stopped`,
      body: `SlickTrax is ${preset ? 'switched off' : 'no longer'} in their AIOStreams configuration, so what they watch in AIOStreams' apps isn't reaching SlickSync. Press "Add it to AIOStreams again" under AIOStreams watch history on their page.`,
    })
    return problems
  }

  // A household user with their own history and their own tracker list.
  const personas = Array.isArray(config?.jellyfin?.personas) ? config.jellyfin.personas : []
  const left = personas.filter((p) => p && p.history !== 'shared' && Array.isArray(p.trackers) && !p.trackers.includes(preset.instanceId))
  const primary = config?.jellyfin?.primary
  const primaryLeft = Array.isArray(primary?.trackers) && !primary.trackers.includes(preset.instanceId)
  if (left.length || primaryLeft) {
    const who = [...(primaryLeft ? [primary?.name || name] : []), ...left.map((p) => p.name)].join(', ')
    problems.push({
      kind: 'trackers',
      title: `Part of ${name}'s AIOStreams household isn't reaching SlickSync`,
      body: `${who}: their tracker list in AIOStreams leaves SlickTrax out, so what they watch isn't recorded here. Add SlickTrax back to their trackers in AIOStreams.`,
    })
  }

  // Libraries, as AIOStreams serves them: at the cap and without SlickSync's.
  if (libraries && libraries.max > 0 && libraries.names.length >= libraries.max && libraries.hasCatalogs
      && !libraries.names.some((n) => String(n || '').toLowerCase().includes(COLLECTIONS_NAME.toLowerCase()))) {
    problems.push({
      kind: 'libraries',
      title: `SlickSync's collections don't fit in ${name}'s AIOStreams libraries`,
      body: `AIOStreams shows at most ${libraries.max} libraries and "${COLLECTIONS_NAME}" isn't among them. Move it higher in their AIOStreams catalog order, or hide a catalog above it.`,
    })
  }

  // Nothing arriving for a week, after it had been arriving.
  const ids = [person.id, ...linkedUserIds(person)]
  const since = new Date(now - QUIET_DAYS * DAY_MS)
  const before = new Date(now - 2 * QUIET_DAYS * DAY_MS)
  const [recent, earlier] = await Promise.all([
    prisma.watchStateEvent.count({ where: { userId: { in: ids }, createdAt: { gte: since } } }),
    prisma.watchStateEvent.count({ where: { userId: { in: ids }, createdAt: { gte: before, lt: since } } }),
  ])
  if (recent === 0 && earlier > 0) {
    problems.push({
      kind: 'quiet',
      title: `Nothing from ${name}'s AIOStreams for a week`,
      body: `SlickTrax is in their configuration, but no viewing has arrived from AIOStreams for ${QUIET_DAYS} days after arriving the week before. If they've been watching in AIOStreams' apps, check the SlickTrax addon there still loads.`,
    })
  }
  return problems
}

function linkedUserIds(person) {
  try {
    const map = JSON.parse(person.watchStateViewers || '{}') || {}
    return Object.values(map).filter((v) => typeof v === 'string' && v && v !== 'skip')
  } catch {
    return []
  }
}

/** The libraries AIOStreams serves this person, read with their own sign-in. */
async function readLibraries(person, decrypt) {
  try {
    const { jfRequest } = require('../providers/jellyfinAuth')
    const { instanceBase } = require('./aiostreamsConfig')
    const token = decrypt(person.jellyfinToken, { appAccountId: person.accountId || 'default' })
    const [views, status] = await Promise.all([
      jfRequest(person.jellyfinServerUrl, `/UserViews?userId=${encodeURIComponent(person.jellyfinUserId)}`, { token }),
      fetch(`${instanceBase(person.jellyfinServerUrl)}/api/v1/status`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null),
    ])
    const items = Array.isArray(views?.Items) ? views.Items : []
    return { names: items.map((v) => v.Name), max: Number(status?.data?.settings?.jellyfin?.maxLibraries) || 0 }
  } catch {
    return null
  }
}

async function readIssues(prisma, accountId) {
  const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
  let cfg = account?.sync
  const asString = typeof cfg === 'string'
  if (asString) { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
  cfg = cfg && typeof cfg === 'object' ? cfg : {}
  return { cfg, asString }
}

/**
 * Compare what is wrong now with what was wrong last time; alert on what is
 * new, forget what is fixed. Issues live in sync.aioSlickTraxIssues[personId].
 */
async function settle(prisma, accountId, person, problems, { alert, now = Date.now() } = {}) {
  const { cfg, asString } = await readIssues(prisma, accountId)
  const all = { ...(cfg.aioSlickTraxIssues || {}) }
  const before = all[person.id] || {}
  const next = {}
  const sent = []
  for (const p of problems) {
    next[p.kind] = before[p.kind] || new Date(now).toISOString()
    if (!before[p.kind]) {
      await alert(prisma, accountId, { title: p.title, body: p.body, url: `/users/${person.id}`, dedupeKey: `slicktrax:${person.id}:${p.kind}:${next[p.kind]}` })
      sent.push(p.kind)
    }
  }
  const changed = JSON.stringify(before) !== JSON.stringify(next)
  if (changed) {
    if (Object.keys(next).length) all[person.id] = next
    else delete all[person.id]
    const nextCfg = { ...cfg, aioSlickTraxIssues: all }
    await prisma.appAccount.update({ where: { id: accountId }, data: { sync: asString ? JSON.stringify(nextCfg) : nextCfg } })
  }
  return sent
}

/** The 30-minute look, for everyone with AIOStreams watch history on and the configuration password. */
async function checkSlickTrax(prisma, decrypt, { alert } = {}) {
  const send = alert || require('./aiostreamsConfig').alert
  const people = await prisma.user.findMany({
    where: { providerType: 'jellyfin', jellyfinServerKind: 'aiostreams', watchStateEnabled: true, traxToken: { not: null }, aioConfigPassword: { not: null }, isActive: true },
    select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, jellyfinUserId: true, jellyfinToken: true, aioConfigId: true, aioConfigPassword: true, traxToken: true, watchStateViewers: true },
  })
  for (const person of people) {
    const accountId = person.accountId || 'default'
    try {
      const config = await readConfig(accessFor(person, decrypt))
      const lists = await prisma.customList.count({ where: { accountId } }).catch(() => 0)
      const libraries = lists > 0 ? await readLibraries(person, decrypt) : null
      const problems = await findProblems(prisma, person, config, { libraries: libraries && { ...libraries, hasCatalogs: true } })
      await settle(prisma, accountId, person, problems, { alert: send })
    } catch (e) {
      // A password change or an outage is the configuration check's to report.
      console.warn(`[AioSlickTrax] ${person.username}:`, e?.message)
    }
  }
}

module.exports = { installSlickTrax, findProblems, settle, checkSlickTrax, readLibraries, explainRefusal, manifestUrlFor, COLLECTIONS_NAME }
