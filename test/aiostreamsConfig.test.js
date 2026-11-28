const test = require('node:test')
const assert = require('node:assert/strict')
const { configAccountFrom, instanceBase, summarize, describeChanges } = require('../server/utils/aiostreamsConfig')

const UUID = '0f2b9c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b'

test('account: named in a picker address, or by the user name on the plain one', () => {
  assert.equal(configAccountFrom('https://aio.example.com/jellyfin/u/family', 'Sam'), 'family')
  assert.equal(configAccountFrom(`https://aio.example.com/jellyfin/${UUID}/c29tZWtleQ`, 'Sam'), UUID)
  assert.equal(configAccountFrom('https://aio.example.com/jellyfin', `${UUID}/Sam`), UUID)
  assert.equal(configAccountFrom('https://aio.example.com/jellyfin', UUID), UUID)
  assert.equal(configAccountFrom('https://aio.example.com/jellyfin', ''), null)
})

test('instance: the address before /jellyfin', () => {
  assert.equal(instanceBase('https://aio.example.com/jellyfin/u/family'), 'https://aio.example.com')
  assert.equal(instanceBase('https://example.com/aio/jellyfin'), 'https://example.com/aio')
})

test('changes: addons, services, keys and household users, in words; secrets never kept', () => {
  const before = summarize({
    presets: [{ instanceId: 'a', type: 'torrentio', enabled: true, options: { name: 'Torrentio' } }],
    services: [{ id: 'realdebrid', credentials: { apiKey: 'old-secret-value-123' } }],
    jellyfin: { personas: [{ id: 'kid', name: 'Kid' }] },
    encryptedPassword: 'x',
  })
  assert.equal(JSON.stringify(before).includes('old-secret-value-123'), false)
  const after = summarize({
    presets: [
      { instanceId: 'a', type: 'torrentio', enabled: false, options: { name: 'Torrentio' } },
      { instanceId: 'b', type: 'comet', enabled: true, options: { name: 'Comet' } },
    ],
    services: [{ id: 'realdebrid', credentials: { apiKey: 'new-secret-value-456' } }],
    jellyfin: { personas: [{ id: 'kid', name: 'Kid' }, { id: 'sam', name: 'Sam' }] },
    encryptedPassword: 'y',
  })
  assert.deepEqual(describeChanges(before, after), [
    'added Comet', 'turned off Torrentio', 'changed the Real-Debrid key', 'added household user Sam',
  ])
})

test('changes: what changes on its own does not count, anything else is "other settings"', () => {
  const a = summarize({ presets: [], formatter: { id: 'torrentio' }, ip: '1.2.3.4', healthResults: { x: true } })
  const b = summarize({ presets: [], formatter: { id: 'torrentio' }, ip: '5.6.7.8', healthResults: { x: false } })
  assert.equal(a.hash, b.hash)
  const c = summarize({ presets: [], formatter: { id: 'gdrive' } })
  assert.deepEqual(describeChanges(a, c), ['changed other settings'])
})

test('a change to the catalog order is named as one, not "other settings"', () => {
  const { summarize, describeChanges } = require('../server/utils/aiostreamsConfig')
  const base = { presets: [], catalogModifications: [{ id: 'a.top', type: 'movie' }, { id: 'b.slicksync-collections', type: 'movie' }] }
  const moved = { ...base, catalogModifications: [base.catalogModifications[1], base.catalogModifications[0]] }
  assert.deepEqual(describeChanges(summarize(base), summarize(moved)), ['changed the catalog order'])
  // A look kept before the order was summarised has nothing to compare against.
  const old = { ...summarize(base) }
  delete old.catalogOrder
  assert.deepEqual(describeChanges(old, summarize(moved)), ['changed other settings'])
})

test('account: a personal address names a person, so only a typed configuration UUID counts', () => {
  const personal = 'https://aio.example.com/jellyfin/p/k3j9x0q7ab'
  assert.equal(configAccountFrom(personal, 'Sam'), null)
  assert.equal(configAccountFrom(`${personal}/`, 'Sam'), null)
  assert.equal(configAccountFrom(personal, ''), null)
  assert.equal(configAccountFrom(personal, UUID), UUID)
  assert.equal(configAccountFrom(personal, `${UUID}/Sam`), UUID)
  assert.equal(configAccountFrom(personal, 'family/Sam'), null)
  assert.equal(configAccountFrom('https://example.com/aio/jellyfin/p/k3j9x0q7ab', 'Sam'), null)
  assert.equal(instanceBase(personal), 'https://aio.example.com')
})

test('changes: keeping a household user separate, stopping, and a new address are named', () => {
  const persona = (extra) => summarize({ jellyfin: { personas: [{ id: 'mia', name: 'Mia', ...extra }, { id: 'leo', name: 'Leo' }] } })
  const plain = persona({})
  const apart = persona({ hidden: true, address: 'k3j9x0q7ab' })
  const renewed = persona({ hidden: true, address: 'zz11yy22xx' })
  assert.equal(JSON.stringify(apart).includes('k3j9x0q7ab'), false, 'the address itself is not kept')
  assert.deepEqual(describeChanges(plain, apart), ['kept household user Mia separate'])
  assert.deepEqual(describeChanges(apart, plain), ['stopped keeping household user Mia separate'])
  assert.deepEqual(describeChanges(apart, renewed), ['gave household user Mia a new sign-in address'])
  const old = { ...plain }
  delete old.apart
  assert.deepEqual(describeChanges(old, apart), ['changed other settings'])
})

test('a pass that is still running is not started a second time on top of itself', async () => {
  const { onePassAtATime } = require('../server/utils/aiostreamsConfig')
  let runs = 0
  let release
  const slow = () => { runs++; return new Promise((resolve) => { release = resolve }) }
  const first = onePassAtATime(slow)
  assert.equal(await onePassAtATime(slow), false)
  assert.equal(runs, 1)
  release()
  assert.equal(await first, true)
  // The turn is given back, also when a pass throws.
  await assert.rejects(onePassAtATime(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await onePassAtATime(async () => {}), true)
})
